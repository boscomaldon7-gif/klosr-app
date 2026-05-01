// POST /api/find-email
// Looks up personal + work emails AND phone numbers for a LinkedIn profile
// via Apollo's People Match API. Returns:
//   { personalEmails: string[], phones: [{number, type, verified}], source }
//
// Why Apollo: largest verified B2B contact DB, accepts LinkedIn URLs
// directly, ~85%+ email deliverability, and returns direct phones (mobile,
// work_direct, work_hq) for cold-calling workflows.
//
// Pricing note: Apollo charges separate credits per reveal type:
//   - 1 email credit per `reveal_personal_emails: true` hit
//   - 1 mobile/phone credit per `reveal_phone_number: true` hit
// Phone credits are the premium pool — users have far fewer than email
// credits. Callers can opt out of phone reveal via `revealPhone: false`
// in the request body if they want to save phone credits.

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";

const APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const { linkedinUrl } = body || {};
    // Phone reveal is default-ON. Apollo's /people/match returns
    // previously-revealed (cached) phones synchronously in the response
    // body when `reveal_phone_number: true` is sent — no webhook required,
    // no extra credit cost. The webhook is only needed for ASYNC fresh
    // reveals (paid hot reveals against records that have never been
    // unlocked). When APOLLO_PHONE_WEBHOOK_URL is set, we additionally
    // request an async fresh reveal; without it, Apollo just returns what
    // it already has.
    // Caller can opt out with `revealPhone: false` if they want to skip
    // the phone-credit hit entirely (e.g. deep-research path that fetches
    // phones via a separate find-email call).
    const revealPhone = body.revealPhone !== false;

    if (!linkedinUrl || typeof linkedinUrl !== "string") {
      res.status(400).json({ error: "missing_linkedin_url" });
      return;
    }

    const apiKey = process.env.APOLLO_API_KEY;
    if (!apiKey) {
      res.status(402).json({ error: "apollo_not_configured" });
      return;
    }

    const vendorRes = await fetch(APOLLO_MATCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({
        linkedin_url: linkedinUrl,
        reveal_personal_emails: true,
        // Phone reveal: webhook_url is only attached when the env var is
        // set. Without it, Apollo treats the request as "return cached
        // phones synchronously" — exactly what we want by default. When
        // set, Apollo also kicks off an async fresh reveal that POSTs to
        // the webhook later.
        ...(revealPhone ? {
          reveal_phone_number: true,
          ...(process.env.APOLLO_PHONE_WEBHOOK_URL ? { webhook_url: process.env.APOLLO_PHONE_WEBHOOK_URL } : {}),
        } : {}),
      }),
    });

    if (vendorRes.status === 401) {
      res.status(402).json({ error: "apollo_auth_failed" });
      return;
    }
    if (vendorRes.status === 403) {
      // Apollo returns 403 for both "bad key" and "plan doesn't include
      // this endpoint". The body distinguishes them — "API_INACCESSIBLE"
      // error_code means free plan; anything else we treat as auth failure.
      const text = await vendorRes.text().catch(() => "");
      if (text.includes("API_INACCESSIBLE") || text.includes("free plan")) {
        res.status(402).json({ error: "apollo_plan_required", hint: "Apollo People Match requires a paid plan (Basic+). Upgrade at app.apollo.io/#/settings/billing." });
      } else {
        res.status(402).json({ error: "apollo_auth_failed" });
      }
      return;
    }
    if (vendorRes.status === 402) {
      res.status(402).json({ error: "apollo_credits_exhausted" });
      return;
    }
    if (vendorRes.status === 404) {
      res.status(200).json({ personalEmails: [], source: "apollo", reason: "not_in_db" });
      return;
    }
    if (vendorRes.status === 422) {
      // Usually a malformed LinkedIn URL after canonicalisation — treat as
      // "not in DB" so the client moves on cleanly.
      res.status(200).json({ personalEmails: [], source: "apollo", reason: "invalid_input" });
      return;
    }
    if (vendorRes.status === 429) {
      res.status(429).json({ error: "apollo_rate_limited" });
      return;
    }
    if (!vendorRes.ok) {
      const text = await vendorRes.text().catch(() => "");
      console.warn("[find-email] apollo non-ok", vendorRes.status, text.slice(0, 200));
      res.status(502).json({ error: "apollo_upstream_error", status: vendorRes.status });
      return;
    }

    const data = await vendorRes.json().catch(() => ({}));
    const person = data.person || {};

    // Apollo's placeholder emails when a reveal fails (insufficient credits,
    // opt-out, etc.) — filter them out so the client doesn't display them.
    //   "email_not_unlocked@domain.com"  → reveal denied
    //   "domain.com"                     → literal placeholder
    const isRealEmail = (e) => {
      if (!e || typeof e !== "string") return false;
      const lower = e.toLowerCase();
      if (lower.includes("email_not_unlocked")) return false;
      if (lower.endsWith("@domain.com")) return false;
      return /^[a-z0-9._+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(lower);
    };

    // Apollo returns emails across several fields depending on the person's
    // record — primary email, personal_emails array, work_email, etc. We
    // collect them all and dedupe. The UI shows the list; user picks.
    const candidates = [];
    const push = (v) => {
      if (!v) return;
      if (typeof v === "string") {
        if (isRealEmail(v)) candidates.push(v);
      } else if (Array.isArray(v)) {
        v.forEach(push);
      } else if (v && typeof v === "object" && typeof v.email === "string") {
        push(v.email);   // some Apollo responses wrap emails as {email, type, verified}
      }
    };

    push(person.email);
    push(person.personal_emails);
    push(person.personal_email);
    push(person.work_email);
    push(person.work_emails);
    push(person.emails);
    if (person.contact && typeof person.contact === "object") {
      push(person.contact.email);
      push(person.contact.personal_emails);
    }

    const emails = Array.from(new Set(
      candidates.map(e => String(e).trim().toLowerCase())
    ));

    // Extract phone numbers. Apollo returns an array of phone objects with
    // shape: { raw_number, sanitized_number, type, position, status, dnc_status }
    // Types we care about:
    //   mobile       — personal mobile (gold for cold calling)
    //   work_direct  — direct office line (still very good)
    //   work_hq      — main company switchboard (low-value, usually a receptionist)
    //   home         — personal home (rare, usually privacy-protected)
    //   other        — uncategorised
    // We filter out reveal-failure placeholders and dedupe on sanitized form.
    // Ranking order: mobile > work_direct > other verified > unverified.
    const rankPhoneType = (t) => {
      const x = String(t || "").toLowerCase();
      if (x === "mobile") return 4;
      if (x === "work_direct") return 3;
      if (x === "home") return 2;
      if (x === "other") return 1;
      if (x === "work_hq" || x === "corporate_main") return 0;
      return 1;
    };

    // Collect from every response shape Apollo uses. Different plans /
    // endpoints sprinkle phones across different fields; we union them.
    const phoneSources = [];
    if (Array.isArray(person.phone_numbers)) phoneSources.push(...person.phone_numbers);
    if (Array.isArray(person.sanitized_phone_numbers)) phoneSources.push(...person.sanitized_phone_numbers);
    if (person.contact && typeof person.contact === "object") {
      if (Array.isArray(person.contact.phone_numbers)) phoneSources.push(...person.contact.phone_numbers);
      if (Array.isArray(person.contact.sanitized_phone_numbers)) phoneSources.push(...person.contact.sanitized_phone_numbers);
    }
    if (person.organization && typeof person.organization === "object") {
      if (Array.isArray(person.organization.phone_numbers)) {
        // Tag org-line phones as work_hq if they don't already carry a type.
        for (const op of person.organization.phone_numbers) {
          if (op && typeof op === "object") {
            phoneSources.push({ ...op, type: op.type || "work_hq" });
          }
        }
      }
    }
    // Top-level scalar phone string (older Apollo payloads).
    if (typeof person.phone === "string" && person.phone.trim()) {
      phoneSources.push({ raw_number: person.phone, sanitized_number: person.phone, type: "other" });
    }
    if (typeof data.phone === "string" && data.phone.trim()) {
      phoneSources.push({ raw_number: data.phone, sanitized_number: data.phone, type: "other" });
    }

    // Reject Apollo's reveal-denied placeholders. Keep the list aggressive —
    // a missing phone is much better than a visibly fake one in the UI.
    const isPlaceholderPhone = (raw, digits) => {
      if (!digits || digits === "+") return true;
      if (/(?:unlocked|locked|redacted|hidden|placeholder|n\/a)/i.test(raw)) return true;
      const onlyDigits = digits.replace(/^\+/, "");
      if (onlyDigits.length < 7) return true;            // too short to be real
      if (/^0+$/.test(onlyDigits)) return true;          // all zeros
      if (/^(\d)\1+$/.test(onlyDigits)) return true;     // single-digit repeat (1111…)
      if (/^(?:\+?1)?0{6,}$/.test(digits)) return true;  // legacy zero-pad pattern
      return false;
    };
    // E.164-style normalisation for dedupe — strip all non-digits, then
    // prepend a "+" so "+1 415-555-9876" and "14155559876" collapse to one.
    const e164 = (digits) => "+" + digits.replace(/^\+/, "").replace(/[^\d]/g, "");

    const seenPhones = new Set();
    const phoneList = [];
    for (const p of phoneSources) {
      if (!p || typeof p !== "object") continue;
      const raw = String(p.raw_number || p.sanitized_number || "").trim();
      const sanitized = String(p.sanitized_number || p.raw_number || "").trim();
      if (!raw || !sanitized) continue;
      const digits = sanitized.replace(/[^\d+]/g, "");
      if (isPlaceholderPhone(raw, digits)) continue;
      const key = e164(digits);
      if (seenPhones.has(key)) continue;
      seenPhones.add(key);
      phoneList.push({
        number: raw,
        sanitized: digits,
        type: String(p.type || "other").toLowerCase(),
        verified: String(p.status || "").toLowerCase() === "verified",
        dnc: ["do_not_call", "dnc"].includes(String(p.dnc_status || "").toLowerCase()),
      });
    }

    // Sort: best type first, verified before unverified within a type.
    phoneList.sort((a, b) => {
      const rt = rankPhoneType(b.type) - rankPhoneType(a.type);
      if (rt !== 0) return rt;
      return Number(b.verified) - Number(a.verified);
    });

    res.status(200).json({
      personalEmails: emails,
      emailStatus: person.email_status || "",
      phones: phoneList,
      source: "apollo",
    });
  } catch (err) {
    console.error("[find-email] error:", err);
    res.status(500).json({ error: "find_email_failed", message: String(err.message || err) });
  }
}
