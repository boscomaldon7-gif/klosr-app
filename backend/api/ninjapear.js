// POST /api/ninjapear
// External enrichment via Proxycurl (nubela.co). Called for every brief /
// email / chat generation to pull verified person + company data so the
// model can cite grounded facts with source tag "(NinjaPear)".
//
// Auth: Bearer token in the Authorization header. Key is read from
// PROXYCURL_API_KEY (preferred) or NINJAPEAR_API_KEY (legacy name) env var.
//
// Endpoints hit:
//   GET /proxycurl/api/v2/linkedin            — person profile
//   GET /proxycurl/api/v2/linkedin/company    — company profile (if URL resolved)
//
// Fails open: on any error / miss / rate-limit / missing key, returns {} so
// the client treats it as "nothing to add" and the brief generates from
// everything else without a scary error banner.

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";

const PROXYCURL_BASE = "https://nubela.co/proxycurl/api";

function pickKey() {
  return process.env.PROXYCURL_API_KEY
      || process.env.NINJAPEAR_API_KEY
      || "";
}

// Proxycurl is strict about URL format: https://www.linkedin.com/in/<slug>
// with no query params. The client already canonicalises before calling,
// but double-clean server-side in case something upstream ships junk.
function normalizeLinkedInUrl(raw) {
  if (!raw) return "";
  let s = String(raw).trim().split("?")[0].split("#")[0];
  s = s.replace(/^https?:\/\/[a-z]{2,3}\.linkedin\.com\//i, "https://www.linkedin.com/");
  s = s.replace(/^https?:\/\/m\.linkedin\.com\//i, "https://www.linkedin.com/");
  return s.replace(/\/+$/, "");
}

// One-shot fetch with timeout. Proxycurl occasionally takes 3-5s for fresh
// profiles, so 15s is generous without blocking the brief forever.
async function pcFetch(url, apiKey, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

// Compact the person profile payload down to the fields the prompt actually
// uses. Proxycurl returns 100+ fields per profile — injecting the whole
// blob would waste tokens and drown the signal.
function compactPerson(p) {
  if (!p || typeof p !== "object") return null;
  const out = {};
  const copyString = (k, maxLen = 400) => {
    const v = p[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, maxLen);
  };
  copyString("full_name", 120);
  copyString("first_name", 60);
  copyString("last_name", 60);
  copyString("occupation", 200);
  copyString("headline", 240);
  copyString("summary", 1200);
  copyString("country_full_name", 80);
  copyString("city", 80);
  copyString("state", 80);
  if (typeof p.follower_count === "number") out.follower_count = p.follower_count;
  if (typeof p.connections === "number") out.connections = p.connections;

  // Experiences — keep the most recent 4, compacted.
  if (Array.isArray(p.experiences)) {
    out.experiences = p.experiences.slice(0, 4).map(e => ({
      title: e && e.title ? String(e.title).slice(0, 160) : "",
      company: e && e.company ? String(e.company).slice(0, 160) : "",
      description: e && e.description ? String(e.description).slice(0, 400) : "",
      starts_at: e && e.starts_at ? e.starts_at : null,
      ends_at: e && e.ends_at ? e.ends_at : null,
      location: e && e.location ? String(e.location).slice(0, 120) : "",
    }));
  }

  // Education — top 2.
  if (Array.isArray(p.education)) {
    out.education = p.education.slice(0, 2).map(e => ({
      school: e && e.school ? String(e.school).slice(0, 160) : "",
      degree_name: e && e.degree_name ? String(e.degree_name).slice(0, 160) : "",
      field_of_study: e && e.field_of_study ? String(e.field_of_study).slice(0, 160) : "",
      starts_at: e && e.starts_at ? e.starts_at : null,
      ends_at: e && e.ends_at ? e.ends_at : null,
    }));
  }

  // Activities (recent posts/reposts/likes) — top 8, text only.
  if (Array.isArray(p.activities)) {
    out.activities = p.activities.slice(0, 8).map(a => ({
      activity_status: a && a.activity_status ? a.activity_status : "",
      title: a && a.title ? String(a.title).slice(0, 240) : "",
      link: a && a.link ? String(a.link).slice(0, 240) : "",
    }));
  }

  // Articles (anything they've authored).
  if (Array.isArray(p.articles)) {
    out.articles = p.articles.slice(0, 5).map(a => ({
      title: a && a.title ? String(a.title).slice(0, 200) : "",
      link: a && a.link ? String(a.link).slice(0, 240) : "",
      published_date: a && a.published_date ? a.published_date : null,
    }));
  }

  // Skills — just the top-line list, not the endorsement counts.
  if (Array.isArray(p.skills)) {
    out.skills = p.skills.slice(0, 20).map(s => String(s).slice(0, 60));
  }

  // The current company's LinkedIn URL lets us chain a company lookup.
  const currentExp = Array.isArray(p.experiences) && p.experiences[0];
  if (currentExp && currentExp.company_linkedin_profile_url) {
    out._current_company_linkedin_url = currentExp.company_linkedin_profile_url;
  }
  return out;
}

function compactCompany(c) {
  if (!c || typeof c !== "object") return null;
  const out = {};
  const copyString = (k, maxLen = 400) => {
    const v = c[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, maxLen);
  };
  copyString("name", 160);
  copyString("tagline", 260);
  copyString("description", 1200);
  copyString("industry", 120);
  copyString("company_type", 80);
  copyString("company_size_on_linkedin", 60);
  copyString("website", 200);
  if (Array.isArray(c.company_size)) out.company_size = c.company_size;
  if (typeof c.founded_year === "number") out.founded_year = c.founded_year;
  if (typeof c.follower_count === "number") out.follower_count = c.follower_count;

  if (Array.isArray(c.specialities)) {
    out.specialities = c.specialities.slice(0, 10).map(s => String(s).slice(0, 80));
  }
  if (c.hq && typeof c.hq === "object") {
    out.hq = {
      country: c.hq.country || "",
      city: c.hq.city || "",
      state: c.hq.state || "",
      line_1: c.hq.line_1 || "",
    };
  }
  if (Array.isArray(c.funding_data) && c.funding_data.length > 0) {
    out.funding_data = c.funding_data.slice(-3).map(f => ({
      funding_type: f && f.funding_type ? f.funding_type : "",
      money_raised: f && f.money_raised ? f.money_raised : null,
      announced_date: f && f.announced_date ? f.announced_date : null,
      investor_list: Array.isArray(f && f.investor_list)
        ? f.investor_list.slice(0, 5).map(i => ({ name: (i && i.name) || "", linkedin_profile_url: (i && i.linkedin_profile_url) || "" }))
        : [],
    }));
  }
  if (Array.isArray(c.updates) && c.updates.length > 0) {
    out.recent_updates = c.updates.slice(0, 5).map(u => ({
      posted_on: u && u.posted_on ? u.posted_on : null,
      text: u && u.text ? String(u.text).slice(0, 400) : "",
      total_likes: typeof (u && u.total_likes) === "number" ? u.total_likes : null,
    }));
  }
  if (typeof c.linkedin_internal_id === "string") out.linkedin_internal_id = c.linkedin_internal_id;
  return out;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const { linkedinUrl = "" } = body || {};

    const apiKey = pickKey();
    if (!apiKey) {
      res.status(200).json({});
      return;
    }

    const cleanUrl = normalizeLinkedInUrl(linkedinUrl);
    if (!cleanUrl) {
      res.status(200).json({});
      return;
    }

    // 1. Person profile — the primary enrichment.
    const personUrl = `${PROXYCURL_BASE}/v2/linkedin?url=${encodeURIComponent(cleanUrl)}&use_cache=if-present&fallback_to_cache=on-error`;
    const personRes = await pcFetch(personUrl, apiKey);

    if (!personRes || !personRes.ok) {
      if (personRes) {
        const text = await personRes.text().catch(() => "");
        console.warn("[ninjapear/proxycurl] person fetch non-ok", personRes.status, text.slice(0, 200));
      } else {
        console.warn("[ninjapear/proxycurl] person fetch network/timeout");
      }
      res.status(200).json({});
      return;
    }

    const personRaw = await personRes.json().catch(() => null);
    const person = compactPerson(personRaw);

    const out = {
      source: "proxycurl",
      person: person || {},
    };

    // 2. Chained company lookup — best-effort, short timeout, never blocks.
    const companyUrl = person && person._current_company_linkedin_url;
    if (companyUrl) {
      delete person._current_company_linkedin_url; // internal helper, don't ship
      const ccUrl = `${PROXYCURL_BASE}/linkedin/company?url=${encodeURIComponent(companyUrl)}&use_cache=if-present`;
      const ccRes = await pcFetch(ccUrl, apiKey, 10000);
      if (ccRes && ccRes.ok) {
        const ccRaw = await ccRes.json().catch(() => null);
        const company = compactCompany(ccRaw);
        if (company) out.company = company;
      } else if (ccRes) {
        console.warn("[ninjapear/proxycurl] company fetch non-ok", ccRes.status);
      }
    }

    res.status(200).json(out);
  } catch (err) {
    // Fail open — the client treats {} as "no enrichment" and proceeds.
    console.error("[ninjapear/proxycurl] error:", err);
    res.status(200).json({});
  }
}
