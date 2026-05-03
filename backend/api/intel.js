// POST /api/intel
// Unified NinjaPear intel dispatcher. One Vercel function hosts all 7
// NinjaPear-backed operations because the hobby plan caps us at 12
// serverless functions total (and we'd rather spend that budget on the
// core Klosr endpoints like /api/analyze and /api/chat).
//
// Body: { action: "<name>", params: {...} }
//
// Actions:
//   "verify-email"          { email }                  — free
//   "company-logo"          { domain }                 — free
//   "credit-balance"        {}                         — free
//   "company-details"       { domain, includeEmployeeCount?, includeFollowerCount? } — 2-5 credits
//   "company-funding"       { domain }                 — 2+ credits
//   "similar-people"        { workEmail? | firstName? + employerWebsite? + role? } — 10+ credits
//   "company-customers"     { domain, pageSize?, qualityFilter?, cursor? } — 1+2/company
//   "company-competitors"   { domain }                 — 2/comp, min 5
//
// All actions fail open — empty / null results on any NinjaPear error so
// the client UI degrades gracefully (shows "no data" rather than an error
// banner).

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { ninjaGet, normalizeDomain } from "../lib/ninjapear.js";
import { getClient } from "../lib/claude.js";
import { logEvent, getOverviewStats, getFeatureCounters, getAllUsers, getRecentEvents, hasUpstash } from "../lib/upstash.js";
import { searchCompany, searchPerson } from "../lib/serpapi.js";

// ───── Action handlers ─────────────────────────────────────────────

async function actionVerifyEmail(params) {
  const email = (params.email || "").toString().trim().toLowerCase();
  if (!/^[a-z0-9._+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
    return { email, isDisposable: false, isFree: false, reason: "invalid_email" };
  }
  const { ok, data, error } = await ninjaGet("/api/v1/contact/disposable-email", { email });
  if (!ok) return { email, isDisposable: false, isFree: false, reason: error };
  return {
    email,
    isDisposable: Boolean(data && data.is_disposable_email),
    isFree: Boolean(data && data.is_free_email),
  };
}

async function actionCompanyLogo(params) {
  const domain = normalizeDomain(params.domain);
  if (!domain) return { logoDataUrl: null, reason: "invalid_domain" };
  const { ok, data } = await ninjaGet(
    "/api/v1/company/logo",
    { website: domain },
    { raw: true, timeoutMs: 8000 },
  );
  if (!ok || !data) return { logoDataUrl: null };

  const buf = await data.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength === 0) return { logoDataUrl: null };
  if (buf.byteLength > 200 * 1024) return { logoDataUrl: null, reason: "logo_too_large" };

  const base64 = Buffer.from(buf).toString("base64");
  const contentType = data.headers.get("content-type") || "image/png";
  return { logoDataUrl: `data:${contentType};base64,${base64}`, domain };
}

async function actionCreditBalance() {
  const { ok, data, error } = await ninjaGet("/api/v1/meta/credit-balance");
  if (!ok) return { balance: null, reason: error };
  const balance = typeof data?.credit_balance === "number" ? data.credit_balance : null;
  return { balance };
}

async function actionCompanyDetails(params) {
  const domain = normalizeDomain(params.domain);
  if (!domain) return { company: null, reason: "invalid_domain" };

  const includeEmployeeCount = params.includeEmployeeCount !== false;
  const includeFollowerCount = params.includeFollowerCount === true;

  const { ok, data, error } = await ninjaGet("/api/v1/company/details", {
    website: domain,
    include_employee_count: includeEmployeeCount,
    follower_count: includeFollowerCount ? "include" : "exclude",
  });
  if (!ok) return { company: null, reason: error };

  const c = data;
  if (!c || typeof c !== "object") return { company: null };

  const out = {};
  const copyString = (k, maxLen = 400) => {
    if (typeof c[k] === "string" && c[k].trim()) out[k] = c[k].trim().slice(0, maxLen);
  };
  copyString("name", 160);
  copyString("description", 1200);
  copyString("industry", 120);
  copyString("website", 200);
  if (typeof c.founded_year === "number") out.founded_year = c.founded_year;
  if (typeof c.employee_count === "number") out.employee_count = c.employee_count;
  if (typeof c.followers_count === "number") out.followers_count = c.followers_count;
  if (typeof c.public_listing === "string") out.public_listing = c.public_listing;

  if (Array.isArray(c.specialties)) {
    out.specialties = c.specialties.slice(0, 10).map(s => String(s).slice(0, 80));
  }
  if (Array.isArray(c.addresses) && c.addresses.length > 0) {
    const a = c.addresses[0] || {};
    out.hq = {
      country: a.country || "", city: a.city || "",
      state: a.state || "", line_1: a.line_1 || a.street || "",
    };
  }
  if (Array.isArray(c.executives)) {
    out.executives = c.executives.slice(0, 8).map(e => ({
      name: (e && e.name) || "",
      role: (e && (e.role || e.title)) || "",
      linkedin_url: (e && (e.linkedin_url || e.profile_url)) || "",
    })).filter(x => x.name);
  }

  return { company: out, domain };
}

async function actionCompanyFunding(params) {
  const domain = normalizeDomain(params.domain);
  if (!domain) return { totalRaisedUsd: null, rounds: [], reason: "invalid_domain" };

  const { ok, data, error } = await ninjaGet("/api/v1/company/funding", { website: domain });
  if (!ok) return { totalRaisedUsd: null, rounds: [], reason: error };

  const rounds = Array.isArray(data?.funding_rounds)
    ? data.funding_rounds.slice(-6).map(r => ({
        roundType: (r && (r.funding_type || r.round_type)) || "",
        date: (r && (r.announced_date || r.date)) || "",
        amount: (r && (r.money_raised || r.amount)) || "",
        investors: Array.isArray(r && r.investors)
          ? r.investors.slice(0, 8).map(i => ({
              name: (i && i.name) || "",
              type: (i && i.investor_type) || "",
              linkedinUrl: (i && (i.linkedin_url || i.profile_url)) || "",
            })).filter(x => x.name)
          : [],
      }))
    : [];

  return {
    totalRaisedUsd: data?.total_funds_raised_usd ?? null,
    rounds,
    domain,
  };
}

async function actionSimilarPeople(params) {
  const workEmail = typeof params.workEmail === "string" ? params.workEmail.trim().toLowerCase() : "";
  const firstName = typeof params.firstName === "string" ? params.firstName.trim() : "";
  const employerWebsite = normalizeDomain(params.employerWebsite);
  const role = typeof params.role === "string" ? params.role.trim().slice(0, 120) : "";

  const hasEmail = workEmail.length > 0;
  const hasNameCompany = firstName && employerWebsite;
  const hasRoleCompany = role && employerWebsite;
  if (!hasEmail && !hasNameCompany && !hasRoleCompany) {
    return { similarPeople: [], reason: "missing_inputs" };
  }

  const query = {};
  if (hasEmail) query.work_email = workEmail;
  else {
    if (firstName) query.first_name = firstName;
    if (employerWebsite) query.employer_website = employerWebsite;
    if (role) query.role = role;
  }

  const { ok, data, error } = await ninjaGet(
    "/api/v1/employee/similar",
    query,
    { timeoutMs: 120000 },
  );
  if (!ok) return { similarPeople: [], reason: error };

  const target = data?.target ? {
    firstName: data.target.first_name || "",
    lastName: data.target.last_name || "",
    role: (data.target.work_experience?.[0]?.role) || "",
    company: (data.target.work_experience?.[0]?.company_name) || "",
  } : null;

  const similarPeople = Array.isArray(data?.similar_people)
    ? data.similar_people.slice(0, 20).map(p => {
        const firstExp = (Array.isArray(p?.work_experience) && p.work_experience[0]) || {};
        return {
          firstName: p?.first_name || "",
          lastName: p?.last_name || "",
          fullName: `${p?.first_name || ""} ${p?.last_name || ""}`.trim(),
          profilePicUrl: p?.profile_pic_url || "",
          title: firstExp.role || firstExp.title || "",
          company: firstExp.company_name || "",
          companyWebsite: firstExp.company_website || "",
          linkedinUrl: p?.linkedin_url || firstExp.linkedin_url || "",
        };
      })
    : [];

  return { target, similarPeople, creditCost: data?.credit_cost ?? null };
}

async function actionCompanyCustomers(params) {
  const domain = normalizeDomain(params.domain);
  if (!domain) return { customers: [], reason: "invalid_domain" };

  const pageSize = Math.min(Math.max(Number(params.pageSize) || 10, 1), 50);
  const cursor = typeof params.cursor === "string" ? params.cursor : "";
  const qualityFilter = ["high", "medium", "low"].includes(params.qualityFilter) ? params.qualityFilter : "high";

  const query = { website: domain, page_size: pageSize, quality_filter: qualityFilter };
  if (cursor) query.cursor = cursor;

  const { ok, data, error } = await ninjaGet("/api/v1/customer/listing", query, { timeoutMs: 30000 });
  if (!ok) return { customers: [], reason: error };

  const customers = Array.isArray(data?.customers)
    ? data.customers.slice(0, pageSize).map(c => ({
        name: c?.company_name || c?.name || "",
        website: c?.company_website || c?.website || "",
        logoUrl: c?.logo_url || "",
        description: (c?.description || "").slice(0, 240),
        employeeCount: c?.employee_count || null,
        industry: c?.industry || "",
      })).filter(c => c.name)
    : [];

  return {
    customers,
    investors: Array.isArray(data?.investors) ? data.investors.slice(0, 10) : [],
    partners: Array.isArray(data?.partner_platforms) ? data.partner_platforms.slice(0, 10) : [],
    nextPage: data?.next_page || null,
    domain,
  };
}

async function actionCompanyCompetitors(params) {
  const domain = normalizeDomain(params.domain);
  if (!domain) return { competitors: [], reason: "invalid_domain" };

  const { ok, data, error } = await ninjaGet("/api/v1/competitor/listing", {
    website: domain,
  }, { timeoutMs: 30000 });
  if (!ok) return { competitors: [], reason: error };

  const competitors = Array.isArray(data?.competitors)
    ? data.competitors.slice(0, 15).map(c => ({
        website: c?.website || "",
        name: c?.name || c?.company_name || "",
        reason: (c?.competition_reason || "").slice(0, 400),
        companyDetailsUrl: c?.company_details_url || "",
      })).filter(c => c.website || c.name)
    : [];

  return { competitors, domain };
}

// ───── Apollo helpers (shared by the 3 actions below) ────────────
//
// Apollo's auth is `X-Api-Key` header (same as People Match). Every
// action fails open — on any non-200 we return empty data plus a `reason`
// string so the client can show the right error state without breaking
// the UI flow.

const APOLLO_BASE = "https://api.apollo.io/api/v1";

async function apolloCall(path, body = {}, method = "POST", timeoutMs = 25000) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return { ok: false, data: null, status: 0, reason: "apollo_not_configured" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      signal: ctrl.signal,
    };
    if (method !== "GET") opts.body = JSON.stringify(body);
    const res = await fetch(`${APOLLO_BASE}${path}`, opts);
    clearTimeout(timer);

    if (res.status === 401) return { ok: false, data: null, status: 401, reason: "apollo_auth_failed" };
    if (res.status === 403) {
      const text = await res.text().catch(() => "");
      const plan = text.includes("API_INACCESSIBLE") || text.includes("free plan");
      return { ok: false, data: null, status: 403, reason: plan ? "apollo_plan_required" : "apollo_auth_failed" };
    }
    if (res.status === 402) return { ok: false, data: null, status: 402, reason: "apollo_credits_exhausted" };
    if (res.status === 429) return { ok: false, data: null, status: 429, reason: "apollo_rate_limited" };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[apollo] ${path} non-ok ${res.status}:`, text.slice(0, 200));
      return { ok: false, data: null, status: res.status, reason: `apollo_upstream_${res.status}` };
    }

    const data = await res.json().catch(() => null);
    return { ok: true, data, status: 200, reason: null };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, data: null, status: 0, reason: e.name === "AbortError" ? "apollo_timeout" : "apollo_network_error" };
  }
}

function apolloDomainFromAny(v) {
  if (!v || typeof v !== "string") return "";
  return v.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0].split("#")[0];
}

// Compact an Apollo person object down to the fields Klosr actually shows.
// Apollo returns 100+ fields per person; we trim aggressively to keep the
// bulk-enrich response under Vercel's body-size ceiling for 20+ leads.
function apolloCompactPerson(p) {
  if (!p || typeof p !== "object") return null;
  const org = p.organization || {};
  const firstExp = Array.isArray(p.employment_history) ? p.employment_history[0] : null;
  const startedAt = firstExp && (firstExp.start_date || firstExp.start_at);

  // Recent job-change signal — if the prospect started their current role in
  // the last 180 days, that's a "why now" trigger worth highlighting. Apollo's
  // start_date is usually YYYY-MM-DD or YYYY-MM.
  let recentJobChange = false;
  if (startedAt && typeof startedAt === "string") {
    const d = new Date(startedAt.length >= 10 ? startedAt : startedAt + "-01");
    if (!Number.isNaN(d.getTime())) {
      const daysAgo = (Date.now() - d.getTime()) / 86400000;
      if (daysAgo >= 0 && daysAgo <= 180) recentJobChange = true;
    }
  }

  // Phone extraction — collect from every shape Apollo uses, reject
  // reveal-denied placeholders, dedupe on E.164 form. Same logic as
  // find-email.js so bulk-enriched leads + single-profile lookups behave
  // identically. Capped at 4 — UI never shows more.
  const phoneSources = [];
  if (Array.isArray(p.phone_numbers)) phoneSources.push(...p.phone_numbers);
  if (Array.isArray(p.sanitized_phone_numbers)) phoneSources.push(...p.sanitized_phone_numbers);
  if (p.contact && typeof p.contact === "object") {
    if (Array.isArray(p.contact.phone_numbers)) phoneSources.push(...p.contact.phone_numbers);
    if (Array.isArray(p.contact.sanitized_phone_numbers)) phoneSources.push(...p.contact.sanitized_phone_numbers);
  }
  if (org && typeof org === "object" && Array.isArray(org.phone_numbers)) {
    for (const op of org.phone_numbers) {
      if (op && typeof op === "object") phoneSources.push({ ...op, type: op.type || "work_hq" });
    }
  }
  if (typeof p.phone === "string" && p.phone.trim()) {
    phoneSources.push({ raw_number: p.phone, sanitized_number: p.phone, type: "other" });
  }

  const isPlaceholderPhone = (raw, digits) => {
    if (!digits || digits === "+") return true;
    if (/(?:unlocked|locked|redacted|hidden|placeholder|n\/a)/i.test(raw)) return true;
    const onlyDigits = digits.replace(/^\+/, "");
    if (onlyDigits.length < 7) return true;
    if (/^0+$/.test(onlyDigits)) return true;
    if (/^(\d)\1+$/.test(onlyDigits)) return true;
    return false;
  };
  const e164 = (digits) => "+" + digits.replace(/^\+/, "").replace(/[^\d]/g, "");

  const seenPhones = new Set();
  const phones = [];
  for (const ph of phoneSources) {
    if (!ph || typeof ph !== "object") continue;
    const raw = String(ph.raw_number || ph.sanitized_number || "").trim();
    const sanitized = String(ph.sanitized_number || ph.raw_number || "").trim();
    if (!raw || !sanitized) continue;
    const digits = sanitized.replace(/[^\d+]/g, "");
    if (isPlaceholderPhone(raw, digits)) continue;
    const key = e164(digits);
    if (seenPhones.has(key)) continue;
    seenPhones.add(key);
    phones.push({
      number: raw,
      sanitized: digits,
      type: String(ph.type || "other").toLowerCase(),
      verified: String(ph.status || "").toLowerCase() === "verified",
    });
    if (phones.length >= 4) break;
  }

  return {
    apolloId: p.id || "",
    firstName: p.first_name || "",
    lastName: p.last_name || "",
    name: p.name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
    title: p.title || "",
    linkedinUrl: p.linkedin_url || "",
    email: (p.email && !String(p.email).includes("email_not_unlocked")) ? p.email : "",
    emailStatus: p.email_status || "",
    phones,
    company: org.name || p.organization_name || "",
    companyDomain: apolloDomainFromAny(org.website_url || org.primary_domain || ""),
    companyLinkedinUrl: org.linkedin_url || "",
    headline: p.headline || "",
    city: p.city || "",
    country: p.country || "",
    recentJobChange,
    startedAt: startedAt || "",
  };
}

// ───── apollo-company-enrich: org data + intent signals ──────────
// Replaces (or supplements) NinjaPear's /company/details for US-leaning
// companies. The big win: `intent_strength` + `intent_signals` tell you
// when the company is actively researching topics related to what you sell.
async function actionApolloCompanyEnrich(params) {
  const domain = apolloDomainFromAny(params && params.domain);
  if (!domain) return { org: null, reason: "invalid_domain" };

  const { ok, data, reason } = await apolloCall("/organizations/enrich", { domain });
  if (!ok) return { org: null, reason };

  const o = data && data.organization;
  if (!o) return { org: null, reason: "not_found" };

  // Compact response. `intent_strength` can be null (Apollo has no data),
  // "low" | "medium" | "high" | "very_high", or a numeric string.
  const out = {
    name: o.name || "",
    domain: o.primary_domain || o.website_url || domain,
    industry: o.industry || "",
    description: (o.short_description || o.seo_description || "").slice(0, 600),
    employees: o.estimated_num_employees || null,
    foundedYear: o.founded_year || null,
    hqCity: o.city || "",
    hqCountry: o.country || "",
    linkedinUrl: o.linkedin_url || "",
    logoUrl: o.logo_url || "",
    // Funding
    totalFundingUsd: o.total_funding_printed || o.total_funding || null,
    latestFundingStage: o.latest_funding_stage || "",
    latestFundingDate: o.latest_funding_round_date || "",
    // ⭐ INTENT (the reason we pay for Apollo)
    intentStrength: o.intent_strength || "",
    // intent_signals is an array of { topic, score, session_count, ... }
    intentTopics: Array.isArray(o.intent_signals)
      ? o.intent_signals.slice(0, 10).map(s => ({
          topic: s.topic || s.intent_topic || "",
          strength: s.intent_strength || s.strength || "",
          score: typeof s.score === "number" ? s.score : null,
        })).filter(t => t.topic)
      : [],
    // Recent news / why-now triggers from Apollo's feed
    recentNews: Array.isArray(o.news)
      ? o.news.slice(0, 5).map(n => ({
          title: (n.title || "").slice(0, 200),
          url: n.url || "",
          date: n.published_at || n.date || "",
        })).filter(n => n.title)
      : [],
  };

  return { org: out };
}

// ───── apollo-people-search: ICP-filtered cold leads ─────────────
// Used as warm-leads backfill when LinkedIn network search comes up thin.
// Each returned person is pre-enriched with email (if email_status=verified)
// and phone numbers — no second-pass needed.
async function actionApolloPeopleSearch(params) {
  const keywords = (params.keywords || "").toString().trim();
  const titles = Array.isArray(params.titles) ? params.titles.slice(0, 10) : [];
  const industries = Array.isArray(params.industries) ? params.industries.slice(0, 10) : [];
  const locations = Array.isArray(params.locations) ? params.locations.slice(0, 10) : [];
  const headcountMin = Number(params.headcountMin) || 0;
  const headcountMax = Number(params.headcountMax) || 0;
  // Seniority filter — Apollo expects values from a fixed vocabulary:
  // c_suite, vp, head, director, manager, senior, entry, owner, founder,
  // partner. We accept any of these and pass through (capped at 10).
  const seniorities = Array.isArray(params.seniorities) ? params.seniorities.slice(0, 10) : [];
  const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 25);
  const page = Math.max(Number(params.page) || 1, 1);

  if (!keywords && titles.length === 0 && industries.length === 0 && seniorities.length === 0) {
    return { people: [], reason: "missing_filters" };
  }

  const body = {
    per_page: limit,
    page,
    // Only reveal emails for verified addresses (saves credits on guesses).
    contact_email_status: ["verified"],
  };
  if (keywords) body.q_keywords = keywords;
  if (titles.length) body.person_titles = titles;
  if (industries.length) body.q_organization_keyword_tags = industries;
  if (locations.length) body.person_locations = locations;
  if (seniorities.length) body.person_seniorities = seniorities;
  if (headcountMin > 0 || headcountMax > 0) {
    // Apollo wants the format "1,10" / "11,50" / "51,200" etc.
    body.organization_num_employees_ranges = [
      `${headcountMin || 1},${headcountMax || 10000}`,
    ];
  }

  // Apollo deprecated /mixed_people/search for API callers in 2025; the
  // new endpoint is /mixed_people/api_search. Same body, same response shape.
  const { ok, data, reason } = await apolloCall("/mixed_people/api_search", body);
  if (!ok) return { people: [], reason };

  const rawPeople = Array.isArray(data?.people) ? data.people : [];
  const people = rawPeople.map(apolloCompactPerson).filter(Boolean);

  return {
    people,
    pagination: data?.pagination || null,
  };
}

// ───── apollo-bulk-enrich: batch LinkedIn URLs → emails + phones ──
// Apollo's bulk_match endpoint takes up to 10 details at a time. We chunk
// larger lists and merge results. This is the "turn warm-leads list into
// a CRM" feature — every card gains email + phone with one call.
async function actionApolloBulkEnrich(params) {
  // Two input modes:
  //   1) linkedinUrls: ["https://linkedin.com/in/..."]    → URL-based bulk_match
  //   2) leads: [{firstName, lastName, name, company, email}]
  //        → bulk_match using first_name + last_name + organization_name
  //          (or email if available). Used by the "Reveal URLs" button on
  //          Apollo people-search results, where the search response gives
  //          us names + companies but NO LinkedIn URLs (lower-tier plans).
  // Both modes hit the same /people/bulk_match endpoint with the same
  // chunking + fallback behaviour.
  const urls = Array.isArray(params.linkedinUrls) ? params.linkedinUrls.slice(0, 25) : [];
  const leads = Array.isArray(params.leads) ? params.leads.slice(0, 25) : [];

  if (urls.length === 0 && leads.length === 0) {
    return { matches: [], reason: "missing_urls" };
  }

  // Build one bulk_match "detail" per input. Each detail must carry enough
  // identifying info for Apollo to find the person. URL is most reliable;
  // email is second-best; first/last + org name is the fallback.
  const buildDetailFromLead = (l) => {
    const detail = {};
    if (l.linkedinUrl) detail.linkedin_url = l.linkedinUrl;
    else if (l.email) detail.email = l.email;
    else {
      const fn = (l.firstName || "").trim();
      const ln = (l.lastName  || "").trim();
      let firstName = fn, lastName = ln;
      if ((!firstName || !lastName) && l.name) {
        const parts = String(l.name).trim().split(/\s+/);
        firstName = firstName || parts[0] || "";
        lastName  = lastName  || parts.slice(1).join(" ") || "";
      }
      if (!firstName && !lastName) return null;
      detail.first_name = firstName;
      if (lastName) detail.last_name = lastName;
      const org = (l.company || l.companyName || "").trim();
      if (org) detail.organization_name = org;
    }
    return detail;
  };

  const inputDetails = [
    ...urls.map((u) => ({ linkedin_url: u })),
    ...leads.map(buildDetailFromLead).filter(Boolean),
  ];
  if (inputDetails.length === 0) {
    return { matches: [], reason: "missing_identifiers" };
  }

  // Phone reveal is default-ON. Apollo's bulk_match returns
  // previously-revealed (cached) phones synchronously when
  // `reveal_phone_number: true` is set on each detail — webhook is only
  // needed for ASYNC fresh reveals against records that have never been
  // unlocked. So we always request phones; the webhook URL is attached
  // only when the env var is present (turning on the async-fresh path).
  // Caller can opt out with `revealPhones: false` to skip the phone
  // credit cost entirely (e.g. deep-research, which fetches phones via
  // a separate find-email call).
  const revealPhones = params.revealPhones !== false;
  const webhookUrl = process.env.APOLLO_PHONE_WEBHOOK_URL || "";

  // Augment each detail with the reveal flags before sending.
  const augment = (detail) => ({
    ...detail,
    reveal_personal_emails: true,
    ...(revealPhones ? {
      reveal_phone_number: true,
      ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
    } : {}),
  });

  // Try the bulk endpoint first (Pro+ plans). If it returns plan-required,
  // fall back to parallel single /people/match calls (available on Basic).
  const chunks = [];
  for (let i = 0; i < inputDetails.length; i += 10) chunks.push(inputDetails.slice(i, i + 10));

  const allMatches = [];
  let bulkAvailable = true;
  let lastReason = null;

  for (const chunk of chunks) {
    if (!bulkAvailable) break;
    const details = chunk.map(augment);
    const { ok, data, reason } = await apolloCall("/people/bulk_match", { details }, "POST", 30000);
    if (!ok) {
      lastReason = reason;
      if (reason === "apollo_plan_required" || reason === "apollo_auth_failed") {
        bulkAvailable = false;   // switch to single-match fallback
        break;
      }
      continue;
    }
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    for (const m of matches) {
      const person = m?.person || m;
      const compact = apolloCompactPerson(person);
      if (compact && compact.linkedinUrl) allMatches.push(compact);
    }
  }

  // Single-match fallback — available on Basic plan. Fire in parallel with
  // a small concurrency cap so we don't burn through credits on a bad list.
  if (!bulkAvailable && allMatches.length === 0) {
    const CONCURRENCY = 4;
    for (let i = 0; i < inputDetails.length; i += CONCURRENCY) {
      const batch = inputDetails.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((detail) =>
        apolloCall("/people/match", augment(detail), "POST", 15000)
      ));
      for (const { ok, data } of results) {
        if (!ok) continue;
        const compact = apolloCompactPerson(data?.person);
        if (compact && compact.linkedinUrl) allMatches.push(compact);
      }
    }
  }

  return {
    matches: allMatches,
    reason: allMatches.length === 0 ? (lastReason || "empty") : null,
    fallbackUsed: !bulkAvailable,
  };
}

// ───── Score leads (batch) ────────────────────────────────────────
// Takes a batch of warm-leads (just title + company + optional degree/
// mutuals) plus the founder's ICP/product context, and asks Claude Haiku
// to return a per-lead ICP-fit score + short "why warm" reason.
//
// Why batch: scoring 20 leads in one call costs ~1¢ in Haiku tokens (vs
// ~20¢ one-by-one) and is 10-20x faster end-to-end. Haiku is very good
// at structured JSON output, especially for binary / ordinal classifications.
//
// Params:
//   leads: [{pid, name, title, company, degree?, mutuals?}]
//   founderContext: { whatYouSell, icp, icpEmpirical, valueProp, companyName }
// Returns:
//   { scores: [{pid, score: 1-10, tier: "hot"|"warm"|"ok"|"weak", reason: "1-sentence"}] }

async function actionScoreLeads(params) {
  const leads = Array.isArray(params && params.leads) ? params.leads : [];
  const founder = (params && params.founderContext) || {};

  if (leads.length === 0) {
    return { scores: [] };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { scores: [], reason: "anthropic_not_configured" };
  }

  // Hard cap: score no more than 25 leads per call. Beyond that, batch
  // output gets truncated and the JSON parse fails. Callers can chunk
  // larger lists across multiple calls.
  const batch = leads.slice(0, 25);

  const productLine = (founder.whatYouSell || "").toString().slice(0, 300) ||
                      (founder.valueProp || "").toString().slice(0, 300) ||
                      "(not specified)";
  const icpLine = (founder.icpEmpirical || founder.icp || "").toString().slice(0, 400) || "(not specified)";

  const leadsTable = batch.map((l, i) => {
    const degree = l.degree === 0 ? "SELF"
                 : l.degree === 1 ? "1st-degree"
                 : l.degree === 2 ? "2nd-degree"
                 : l.degree === 3 ? "3rd-degree"
                 : l.degree === "OUT_OF_NETWORK" ? "out-of-network"
                 : "unknown";
    const mutuals = typeof l.mutuals === "number" && l.mutuals > 0 ? `, ${l.mutuals} mutuals` : "";
    return `${i}. ${l.name || "?"} — ${l.title || "?"}${l.company ? " at " + l.company : ""} (${degree}${mutuals})`;
  }).join("\n");

  const prompt = `Score each LinkedIn prospect on ICP fit for this founder.

FOUNDER'S PRODUCT: ${productLine}
FOUNDER'S ICP:     ${icpLine}

PROSPECTS:
${leadsTable}

For each prospect, return:
- "score": integer 1-10 on ICP fit (role match + company stage match + buyer persona)
- "tier": "hot" (9-10 — perfect match, recent signals, high intent likely), "warm" (7-8 — strong match), "ok" (4-6 — possible fit but not ideal), "weak" (1-3 — likely wrong fit)
- "reason": ONE crisp sentence naming the concrete reason (max 120 chars). Examples: "CRO at 50-person Series A SaaS — dead-center ICP", "Growth role at agency — tangential; founder's product is for in-house teams", "Founder at fintech — ICP mismatch (you sell to B2B SaaS)"

Output JSON ONLY (no code fence, no prose):
{"scores":[{"idx":0,"score":9,"tier":"hot","reason":"…"}, ...]}

Score every prospect in the list. Length of scores array must equal length of prospects list.`;

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("")
      .trim();

    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed || !Array.isArray(parsed.scores)) {
      return { scores: [], reason: "parse_failed" };
    }

    // Merge idx -> pid from the original batch so the client doesn't have
    // to keep an ordered array around.
    const scores = parsed.scores.map(s => {
      const idx = typeof s.idx === "number" ? s.idx : -1;
      const lead = idx >= 0 && idx < batch.length ? batch[idx] : null;
      if (!lead) return null;
      const score = Math.max(1, Math.min(10, parseInt(s.score, 10) || 5));
      const tier = ["hot", "warm", "ok", "weak"].includes(s.tier) ? s.tier : "ok";
      const reason = (s.reason || "").toString().slice(0, 180).trim();
      return { pid: lead.pid || "", score, tier, reason };
    }).filter(Boolean);

    return { scores };
  } catch (e) {
    console.warn("[intel/score-leads]", e && e.message);
    return { scores: [], reason: "exception" };
  }
}

// ───── Draft warm outreach ────────────────────────────────────────
// Lightweight per-lead draft generator for the Warm Leads tab. Unlike
// /api/email or /api/chat (which assume a fully-scraped prospect profile),
// this endpoint works with JUST the thin data we get from LinkedIn's
// people search: name, title, company, mutual-connection names. Paired
// with the founder's ICP + product context from the client, it drafts
// either a LinkedIn connection note (<300 chars) or a first-DM opener.
//
// The goal is "Klosr gives me a SEND button" — user clicks Draft, sees a
// copy-ready message, hits Copy, opens LinkedIn, pastes.

async function actionDraftWarmOutreach(params) {
  const prospect = (params && params.prospect) || {};
  const founder = (params && params.founderContext) || {};
  const type = params?.type === "dm" ? "dm" : "connection_note";

  const prospectName = (prospect.name || "").toString().trim().slice(0, 120);
  const prospectTitle = (prospect.title || "").toString().trim().slice(0, 160);
  const prospectCompany = (prospect.company || "").toString().trim().slice(0, 120);
  const mutualNames = Array.isArray(prospect.mutualNames)
    ? prospect.mutualNames.slice(0, 3).map(n => String(n).slice(0, 80)).filter(Boolean)
    : [];

  if (!prospectName) {
    return { draft: "", reason: "missing_prospect_name" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { draft: "", reason: "anthropic_not_configured" };
  }

  const founderName = (founder.yourName || "").toString().slice(0, 80);
  const founderRole = (founder.yourRole || "").toString().slice(0, 120);
  const founderCompany = (founder.companyName || "").toString().slice(0, 120);
  const whatYouSell = (founder.whatYouSell || "").toString().slice(0, 400);
  const valueProp = (founder.valueProp || "").toString().slice(0, 400);
  const icp = (founder.icpEmpirical || founder.icp || "").toString().slice(0, 400);

  const mutualLine = mutualNames.length
    ? `Mutual connections: ${mutualNames.join(", ")}. PREFER to name-drop ONE of these by first name if it fits naturally — that's the warm intro hook.`
    : "No named mutual connections available — don't fabricate one.";

  const typeInstructions = type === "dm"
    ? `TYPE: First LinkedIn DM (they've already accepted your connection).
Length: 3-4 short sentences MAX. 280-400 characters total.
Goal: start a conversation that leads to a 15-20 min call. NOT a pitch.
Structure: (1) context / why reaching out referencing something specific, (2) one-line on what you do framed around THEIR likely problem, (3) soft ask (quick question / 15 min).
NO "I hope this finds you well". NO "I came across your profile". NO em-dashes.`
    : `TYPE: LinkedIn connection request note.
Length: MAXIMUM 290 CHARACTERS (hard LinkedIn cap is 300 — stay under). Count them.
Goal: get them to ACCEPT. Not to pitch.
Structure: one specific reason you're reaching out (mutual, their role, something you share) + one warm closer.
NO em-dashes. NO "I'd love to connect". NO pitch language.`;

  const prompt = `Draft outreach for a founder reaching out to a warm LinkedIn prospect.

PROSPECT:
- Name: ${prospectName}
- Role: ${prospectTitle || "(not specified)"}
- Company: ${prospectCompany || "(not specified)"}
- ${mutualLine}

FOUNDER (who is sending this):
- Name: ${founderName || "(not specified)"}
- Role / company: ${founderRole || "(not specified)"} ${founderCompany ? "at " + founderCompany : ""}
- What they sell: ${whatYouSell || "(not specified)"}
- Value prop: ${valueProp || "(not specified)"}
- ICP: ${icp || "(not specified)"}

${typeInstructions}

Output ONLY the message text. No preamble. No quotes around it. No "Here's your draft:". Just the message ready to paste.`;

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    let text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("\n")
      .trim();

    // Strip common wrapping Haiku emits despite the instruction.
    text = text.replace(/^["'`]|["'`]$/g, "").trim();
    text = text.replace(/^(Here'?s?\s+(?:your|a|the)\s+[^:]+:|Draft:|Message:)\s*/i, "").trim();
    // Kill em-dashes (they look AI-written)
    text = text.replace(/—/g, "-").replace(/–/g, "-");

    // Connection note hard-cap at 300 chars (LinkedIn rejects longer).
    if (type === "connection_note" && text.length > 300) {
      text = text.slice(0, 297).trimEnd() + "...";
    }

    return { draft: text, type, prospect: prospectName };
  } catch (e) {
    console.warn("[intel/draft-warm-outreach]", e && e.message);
    return { draft: "", reason: "exception" };
  }
}

// ═════════════════════════════════════════════════════════════════
// EXTRACT PROOF FROM WIN — closed-loop learning
//
// When the user marks a deal won and types a short "what closed it" note,
// we ask Claude to distill it into a reusable proof point for the founder's
// proof library. This is what turns one closed deal into ammunition for
// every future prospect — the real compounding moat.
//
// Input:
//   - Deal metadata (name, company, role, last stage)
//   - Win notes (free-text from user)
//   - Founder context (what they sell, ICP) for filtering genericness
//   - Existing proof library (for dedup signal)
//   - Language
//
// Output:
//   { proof: {title, metric, body, action}, reason?: "skipped_too_generic" }
//   action = "add" | "skip"  — only "add" gets persisted on client

async function actionExtractProofFromWin(params) {
  const deal = params?.deal || {};
  const notes = (params?.notes || "").toString().trim().slice(0, 1500);
  const existingProof = Array.isArray(params?.existingProof) ? params.existingProof.slice(-10) : [];
  const founder = params?.founder || {};
  const language = params?.language === "es" ? "es" : "en";

  if (!notes && !deal.name) return { proof: null, reason: "missing_inputs" };
  if (!process.env.ANTHROPIC_API_KEY) return { proof: null, reason: "anthropic_not_configured" };

  const existingStr = existingProof.length
    ? existingProof.map(p => `- ${p.title || ""}${p.metric ? " (" + p.metric + ")" : ""}: ${(p.body || "").slice(0, 120)}`).join("\n")
    : "(empty)";

  const system = `You extract REUSABLE proof points from a founder's closed-won deal notes. A proof point is something the founder can cite in future conversations to build trust — a specific customer name, a quantified outcome, or a named case study.

${language === "es" ? "Write every output string in natural Castilian Spanish." : "Write all output strings in English."}

Output ONE JSON object:
{
  "action": "add" | "skip",
  "title":  "short descriptor — e.g. 'Strathens case' or 'Ramp rollout'. Empty if skip.",
  "metric": "the quantified win — e.g. '3.2x reply rate' / '40% faster onboarding' / '$150K ARR in Q1'. Empty if no number.",
  "body":   "2-3 sentence story of what happened + what worked. Usable in an email or DM. Empty if skip.",
  "reason": "if action=skip, why (≤80 chars). Empty if action=add."
}

RULES:
- Action = "skip" if the notes are too generic ("they liked the demo"), too personal ("they were nice"), or essentially duplicate an existing proof.
- Action = "add" only if the notes contain a SPECIFIC customer outcome, named feature that closed it, or a quantifiable result.
- title: real customer/company name when disclosable. Generic otherwise ("SaaS founder in Europe").
- metric: MUST be a number or fact the founder can cite verbatim. Skip this field if unclear.
- body: write in the founder's own voice — first-person, no em-dashes, no "leverage/synergy/resonate".
- If metric exists, lead with it: "3.2x reply rate — closed [X] because..."
- Output JSON ONLY. No preamble, no code fence.`;

  const user = `DEAL THAT JUST CLOSED
  Prospect: ${deal.name || "(unknown)"}
  Role:     ${deal.role || deal.title || ""}
  Company:  ${deal.company || ""}
  Stage before close: ${deal.lastStage || "—"}

FOUNDER CONTEXT
  Sells: ${(founder.whatYouSell || "").slice(0, 200)}
  ICP:   ${(founder.icp || "").slice(0, 200)}

WIN NOTES (what the founder said closed this):
${notes || "(none provided)"}

EXISTING PROOF LIBRARY (skip if this would duplicate):
${existingStr}

Output the JSON proof extraction now.`;

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text).join("").trim();
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed) return { proof: null, reason: "parse_failed" };

    return {
      proof: {
        action: parsed.action === "add" ? "add" : "skip",
        title: (parsed.title || "").toString().slice(0, 120),
        metric: (parsed.metric || "").toString().slice(0, 160),
        body: (parsed.body || "").toString().slice(0, 500),
        reason: (parsed.reason || "").toString().slice(0, 120),
      },
    };
  } catch (e) {
    console.warn("[extract-proof-from-win] exception", e && e.message);
    return { proof: null, reason: "exception" };
  }
}

// ═════════════════════════════════════════════════════════════════
// TELEMETRY + ADMIN (Upstash Redis backed)
//
// Two actions:
//   log-event   — client-side beacon. Every meaningful Klosr action calls
//                 this. No PII unless user voluntarily entered it in
//                 onboarding. Fails soft — never breaks the primary flow.
//   admin-stats — password-gated aggregation endpoint. Returns counts,
//                 user list, recent events. Consumed by /admin.html.
//
// Runs as intel.js actions (not separate files) because we're at the
// 12-function Vercel Hobby cap. Stays under the limit, zero cost.

async function actionLogEvent(params) {
  const installId = (params?.installId || "").toString().slice(0, 60);
  const event = (params?.event || "").toString().slice(0, 60);
  if (!installId || !event) return { ok: false, reason: "missing_fields" };

  // Soft rate limit: nothing fancy, Upstash's 10k/day free tier is the
  // real guardrail. If we ever see abuse we can add per-installId cooldowns.
  await logEvent({
    installId,
    event,
    metadata: (params?.metadata && typeof params.metadata === "object") ? params.metadata : {},
    userMeta: (params?.userMeta && typeof params.userMeta === "object") ? params.userMeta : null,
  });
  return { ok: true };
}

async function actionAdminStats(params) {
  const pw = (params?.password || "").toString();
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected || pw !== expected) {
    return { ok: false, reason: "unauthorized" };
  }

  if (!hasUpstash()) {
    return { ok: false, reason: "upstash_not_configured" };
  }

  // Pull all dashboard data in parallel. Each helper fails soft (returns
  // empty/null) so a partial outage still renders something useful.
  const featuresToTrack = [
    "install", "identity_set",
    "sidebar_opened",
    "brief_generated", "dossier_generated",
    "warm_leads_search", "warm_lead_drafted",
    "live_assist_started", "live_assist_ended",
    "email_drafted", "sequence_generated",
    "company_intel_opened", "chat_message_sent",
    "daily_close_opened", "daily_close_action_clicked",
    "pipeline_revive_clicked", "pipeline_multithread_clicked",
  ];

  const [overview, features7d, features30d, users, recentEvents] = await Promise.all([
    getOverviewStats(),
    getFeatureCounters(featuresToTrack, 7),
    getFeatureCounters(featuresToTrack, 30),
    getAllUsers(200),
    getRecentEvents(100),
  ]);

  return {
    ok: true,
    overview: overview || { totalUsers: 0, totalEvents: 0, dau: 0, wau: 0, dailyActive: [] },
    features7d: features7d || {},
    features30d: features30d || {},
    users: users || [],
    recentEvents: recentEvents || [],
    generatedAt: new Date().toISOString(),
  };
}

// ═════════════════════════════════════════════════════════════════
// FULL DOSSIER — "know them cold" deep profile synthesis
//
// Different from the sales brief (tactical: what to say next). The dossier
// is strategic: everything they've done, how they think, what they care
// about, public footprint, and the specific conversational hooks that
// make a founder feel like they've known the prospect for years.
//
// Client fans out in parallel:
//   - LinkedIn scrape       (always — currentProfile)
//   - SerpApi person search (news, talks, podcasts, press)
//   - SerpApi company search (company context for current role)
//   - Apollo people/match   (work history, verified role, email confidence)
//   - Apollo org/enrich     (intent, funding, recent news)
//   - NinjaPear enrich      (fallback work history if Apollo thin)
//
// Backend receives the raw payloads, compacts them, and feeds everything
// to Claude Sonnet 4.5 for a structured JSON dossier. Output is 8-10
// sections rendered as a long-form read in the client.

async function actionFullDossier(params) {
  const prospect = params?.prospect || {};
  const linkedinScrape = params?.linkedinScrape || null;
  const serpPerson = Array.isArray(params?.serpPerson) ? params.serpPerson.slice(0, 12) : [];
  const serpCompany = Array.isArray(params?.serpCompany) ? params.serpCompany.slice(0, 8) : [];
  const apolloPerson = params?.apolloPerson || null;
  const apolloOrg = params?.apolloOrg || null;
  const ninjaPear = params?.ninjaPear || null;
  const language = params?.language === "es" ? "es" : "en";

  if (!prospect.name && !linkedinScrape?.name) {
    return { dossier: null, reason: "missing_prospect" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { dossier: null, reason: "anthropic_not_configured" };
  }

  // Compact each source to the fields the prompt can actually use.
  // Long blobs eat tokens without adding signal.
  //
  // IMPORTANT: rawProfileText is the full <main>.innerText from the
  // LinkedIn page. On 3rd-degree profiles LinkedIn gates Experience /
  // About / Education behind "Connect first" walls, so the structured
  // selectors return empty — but the headline, location, company, and
  // even post snippets remain VISIBLE on the top card. Those render
  // into rawProfileText. We pass it through so Claude can extract
  // structured data when the selectors missed. Capped at 6000 chars
  // to stay token-efficient; that's enough to cover the top card,
  // visible experience entries, and a few recent posts.
  const compactScrape = (s) => {
    if (!s) return null;
    return {
      name: s.name || "",
      headline: (s.headline || "").slice(0, 280),
      about: (s.about || "").slice(0, 2500),
      location: s.location || "",
      currentRole: s.currentRole || "",
      currentCompany: s.currentCompany || "",
      experience: Array.isArray(s.experience)
        ? s.experience.slice(0, 15).map(e => ({
            title: e.title || "",
            company: e.company || "",
            duration: e.duration || "",
            description: (e.description || "").slice(0, 500),
            location: e.location || "",
          })) : [],
      education: Array.isArray(s.education)
        ? s.education.slice(0, 6).map(e => ({
            school: e.school || "",
            degree: e.degree || "",
            field: e.field || "",
            period: e.period || e.duration || "",
          })) : [],
      skills: Array.isArray(s.skills) ? s.skills.slice(0, 20) : [],
      recentPosts: Array.isArray(s.recentPosts) ? s.recentPosts.slice(0, 6).map(p => String(p).slice(0, 400)) : [],
      articles: Array.isArray(s.articles) ? s.articles.slice(0, 5).map(a => typeof a === "string" ? a.slice(0, 180) : { title: (a.title||"").slice(0,180), date: a.date||"" }) : [],
      languages: Array.isArray(s.languages) ? s.languages.slice(0, 6) : [],
      certifications: Array.isArray(s.certifications) ? s.certifications.slice(0, 6) : [],
      volunteer: Array.isArray(s.volunteer) ? s.volunteer.slice(0, 4) : [],
      rawProfileText: typeof s.rawProfileText === "string"
        ? s.rawProfileText.slice(0, 6000)
        : "",
    };
  };

  const compactApollo = (a) => {
    if (!a) return null;
    const firstExp = Array.isArray(a.employment_history) ? a.employment_history[0] : null;
    return {
      name: a.name || `${a.first_name || ""} ${a.last_name || ""}`.trim(),
      title: a.title || "",
      linkedinUrl: a.linkedin_url || "",
      email: a.email || "",
      emailStatus: a.email_status || "",
      workStarted: firstExp?.start_date || "",
      history: Array.isArray(a.employment_history) ? a.employment_history.slice(0, 10).map(e => ({
        title: e.title || "",
        company: e.organization_name || e.company_name || "",
        start: e.start_date || "",
        end: e.end_date || "",
      })) : [],
      org: a.organization ? {
        name: a.organization.name || "",
        industry: a.organization.industry || "",
        employees: a.organization.estimated_num_employees || null,
      } : null,
    };
  };

  const serpToText = (results, heading) => {
    if (!Array.isArray(results) || !results.length) return "";
    return `${heading}:\n` + results.map((r, i) =>
      `  ${i + 1}. ${(r.title || "").slice(0, 140)}${r.date ? ` [${String(r.date).slice(0, 24)}]` : ""}${r.source ? ` · ${String(r.source).slice(0, 40)}` : ""}${r.snippet ? `\n     ${String(r.snippet).slice(0, 220)}` : ""}`
    ).join("\n");
  };

  const langDirective = language === "es"
    ? "Write EVERY string in natural Castilian Spanish. Do not translate — write like a native speaker drafting the dossier from scratch. Keep the JSON keys in English (they're structural)."
    : "Write everything in English.";

  const system = `You write SCANNABLE "know-them-cold" dossiers on a prospect. The user is about to have a high-stakes conversation and needs to absorb the dossier in 20 seconds, not read a novel.

${langDirective}

Output ONE JSON object with this EXACT structure:

{
  "essence":   "2 sentences max. Capture who they are at their core. Use their own words when possible.",
  "tagline":   "1-line identity statement. Specific, not generic. ≤ 80 chars.",
  "career": {
    "summary": "ONE sentence on their arc — pattern + direction. No preamble.",
    "roles": [
      { "title": "...", "company": "...", "period": "...",
        "achievement": "ONE punchy line. Quantified if data supports it. **Bold** the biggest number or proper noun.",
        "inferredReason": "ONLY if evidenced. Empty otherwise." }
    ]
  },
  "education": [ { "school": "...", "degree": "...", "period": "...", "note": "" } ],
  "builds":       [ "3-5 bullets. Each ≤ 110 chars. **Bold** the concrete deliverable." ],
  "howTheyThink": {
    "tone": "one phrase — casual / analytical / operator-mode / engineer-mode / etc",
    "recurringThemes": ["3-5 short topics — max 6 words each"],
    "communicationStyle": "ONE sentence on how they write/speak. No hedging."
  },
  "caresAbout":   [ "3-5 bullets. Each ≤ 90 chars. **Bold** the object of their obsession." ],
  "network": {
    "summary": "ONE line on the orbit they run in.",
    "notables": ["2-5 names or companies"]
  },
  "publicFootprint": [ "Talks, podcasts, articles, press, awards — DATED. **Bold** venue/title. Empty array if nothing." ],
  "triggers":     [ "3-5 recent events worth referencing. **Bold** the event + date." ],
  "conversationalHooks": [
    "8-12 actionable mentions. Format: 'Ask about **X** — [source/reason].' or 'Mention **Y** — [source].' Always **bold** the topic."
  ],
  "avoid": [ "2-3 specific topics that'd land badly with THIS person. Each ≤ 90 chars." ],
  "powerLine": "ONE sentence the user could say that'd make them remember forever. Grounded in something only they'd recognise. ≤ 140 chars."
}

SCANNABILITY RULES (this is the most important part):
- Use **markdown bold** (exactly two asterisks on each side) around 1-2 key phrases per bullet. The user reads the bolded words first — they should still get the 80% signal.
- What to bold: specific numbers, proper nouns (companies, people, products), dates, key topics, killer phrases. Never bold a full sentence.
- Example: "Ask about the **3-second pause after 'we're all good, thanks'** — from his Apr 3 post on SDRs bailing too fast."
- Example: "**Built 6-person calling team in Clark, PH** — serves US fintech/SaaS founders."
- Example: "**Series B closed Mar 2025** — $47M led by Sequoia."

OTHER RULES:
- Output JSON only. No preamble, no code fence.
- NEVER invent. Every claim traces to source data below.
- No hedging: no "seems", "likely", "possibly", "it appears".
- No em-dashes. No "leverage / synergy / resonate / align / actionable / impactful / robust".
- Empty arrays/strings are valid. If a section has no grounded content, return empty — do NOT pad.
- Quote their own words in essence / tagline / powerLine when possible.
- inferredReason: only fill when evidenced. Otherwise empty string.

DATA EXTRACTION — READ CAREFULLY:
- The source data below may have EMPTY structured fields (headline, currentRole, experience, etc) when the prospect is a 3rd-degree connection and LinkedIn gates those sections.
- When structured fields are empty, you MUST read "rawProfileText" — it's the unprocessed text content of the profile page as the user actually saw it. Top card, visible roles, education, posts, follower counts, and "started a new role as X" announcements are all in there.
- Extract role, company, location, education, and any visible achievements from rawProfileText when the structured fields don't have them. Do NOT say "insufficient data" if rawProfileText has the answer.
- Specifically: the LINE RIGHT AFTER THE NAME on a LinkedIn profile is the headline ("General Manager at El Corte Inglés"). Use it.
- If rawProfileText has "started a new position as X at Y" or "han empezado un nuevo puesto como X", that's a recent-role trigger — call it out in triggers.`;

  const userMsg = `PROSPECT BASICS
  Name:    ${prospect.name || linkedinScrape?.name || ""}
  Role:    ${prospect.title || linkedinScrape?.currentRole || linkedinScrape?.headline || ""}
  Company: ${prospect.company || linkedinScrape?.currentCompany || ""}
  Profile: ${prospect.profileUrl || ""}

${compactScrape(linkedinScrape) ? `═══ LINKEDIN SCRAPE ═══\n${JSON.stringify(compactScrape(linkedinScrape), null, 2).slice(0, 6000)}` : ""}

${compactApollo(apolloPerson) ? `\n═══ APOLLO PERSON ═══\n${JSON.stringify(compactApollo(apolloPerson), null, 2).slice(0, 2500)}` : ""}

${apolloOrg ? `\n═══ APOLLO COMPANY (current employer) ═══\n${JSON.stringify({
    name: apolloOrg.name, industry: apolloOrg.industry, employees: apolloOrg.employees,
    foundedYear: apolloOrg.foundedYear, description: (apolloOrg.description || "").slice(0, 400),
    totalFundingUsd: apolloOrg.totalFundingUsd, latestFundingStage: apolloOrg.latestFundingStage,
    latestFundingDate: apolloOrg.latestFundingDate, intentStrength: apolloOrg.intentStrength,
    intentTopics: (apolloOrg.intentTopics || []).slice(0, 5),
    recentNews: (apolloOrg.recentNews || []).slice(0, 4),
  }, null, 2).slice(0, 2500)}` : ""}

${ninjaPear ? `\n═══ NINJAPEAR ENRICHMENT ═══\n${JSON.stringify(ninjaPear, null, 2).slice(0, 2500)}` : ""}

${serpToText(serpPerson, "═══ LIVE WEB — PERSON MENTIONS ═══")}

${serpToText(serpCompany, "═══ LIVE WEB — COMPANY MENTIONS ═══")}

Produce the JSON dossier now. Be specific, cite sources in hooks.`;

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userMsg }],
    });
    const text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text).join("").trim();
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed) return { dossier: null, reason: "parse_failed" };
    return { dossier: parsed, generatedAt: new Date().toISOString() };
  } catch (e) {
    console.warn("[full-dossier] exception", e && e.message);
    return { dossier: null, reason: "exception" };
  }
}

// ═════════════════════════════════════════════════════════════════
// LIVE CALL ASSIST (Path B — full Cluely-grade in-call AI)
//
// Three actions that together power a real-time meeting assistant:
//   1. realtime-token   → mints a short-lived Deepgram key for the client
//                         to open a WebSocket transcription stream directly.
//                         Keeps the master key server-side.
//   2. call-coach       → Claude Sonnet 4.5 reads the rolling transcript
//                         + prospect context and returns structured
//                         in-the-moment coaching (topic, objection,
//                         commitment, next thing to say).
//   3. call-summary     → Post-call synthesis: key points, action items,
//                         auto-drafted follow-up email.
// ═════════════════════════════════════════════════════════════════

// ───── 1) Realtime token — Deepgram ephemeral key ─────────────────
// Mints a scoped, short-lived Deepgram project key so the client can
// open a WebSocket straight to Deepgram without us long-polling audio
// through Vercel (which doesn't support long-lived connections anyway).
// Master key stays server-side in DEEPGRAM_API_KEY. Each call creates
// a new key with TTL = 1 hour + usage:write scope only.

let _deepgramProjectId = null;   // memoised on first call — saves 1 hop

async function actionRealtimeToken(params) {
  const masterKey = process.env.DEEPGRAM_API_KEY;
  if (!masterKey) return { token: "", reason: "deepgram_not_configured" };

  try {
    // Resolve project ID once per server instance.
    if (!_deepgramProjectId) {
      const projRes = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { "Authorization": `Token ${masterKey}` },
      });
      if (!projRes.ok) return { token: "", reason: "deepgram_projects_fetch_failed" };
      const projData = await projRes.json().catch(() => ({}));
      const projs = Array.isArray(projData?.projects) ? projData.projects : [];
      if (projs.length === 0) return { token: "", reason: "deepgram_no_project" };
      _deepgramProjectId = projs[0].project_id;
    }

    // Mint ephemeral key. Scopes: "usage:write" = can submit audio, nothing else.
    const ttl = Math.max(60, Math.min(Number(params?.ttlSeconds) || 3600, 24 * 3600));
    const keyRes = await fetch(`https://api.deepgram.com/v1/projects/${_deepgramProjectId}/keys`, {
      method: "POST",
      headers: {
        "Authorization": `Token ${masterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        comment: `klosr-live-assist-${Date.now()}`,
        scopes: ["usage:write"],
        time_to_live_in_seconds: ttl,
      }),
    });

    if (!keyRes.ok) {
      const text = await keyRes.text().catch(() => "");
      console.warn("[realtime-token] Deepgram key creation failed", keyRes.status, text.slice(0, 200));
      return { token: "", reason: `deepgram_key_create_${keyRes.status}` };
    }
    const keyData = await keyRes.json().catch(() => ({}));
    if (!keyData?.key) return { token: "", reason: "deepgram_key_missing" };

    return {
      token: keyData.key,
      expiresIn: ttl,
      provider: "deepgram",
    };
  } catch (e) {
    console.warn("[realtime-token] exception", e && e.message);
    return { token: "", reason: "exception" };
  }
}

// ───── 2) Call coach — Claude on rolling transcript ──────────────
// Called every 10-15 seconds by the client. Gets the last ~60s of
// transcript plus the prospect's static context, returns structured
// coaching for the overlay to render.
//
// Input params:
//   transcript:   string (recent 60-90s of what's been said)
//   prospect:     { name, title, company, headline? }
//   founder:      { whatYouSell, icp, valueProp, objectionPlaybook: [...] }
//   priorTurn:    optional summary of previous coach output to avoid loops
//
// Output JSON:
//   {
//     currentTopic: "...",            // 1 line — what are they talking about
//     objectionDetected: bool,
//     objectionText: "...",           // quote of the prospect's concern
//     objectionRebuttal: "...",       // one-line rebuttal tied to playbook
//     commitmentCaptured: "...",      // if they just said yes/no to something
//     nextSuggestion: "...",          // what to say next — 1 sentence
//     insight: "..."                  // one-off notable fact
//   }

async function actionCallCoach(params) {
  const transcript = (params?.transcript || "").toString().slice(-4500);
  const prospect = params?.prospect || {};
  const founder = params?.founder || {};
  const talkRatio = params?.talkRatio || null;    // { you: 0.62, prospect: 0.38 }
  const priorDealStage = params?.priorDealStage || "";

  if (!transcript || transcript.length < 20) {
    return { currentTopic: "", objectionDetected: false, reason: "empty_transcript" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { currentTopic: "", reason: "anthropic_not_configured" };
  }

  const playbook = Array.isArray(founder.objectionPlaybook) ? founder.objectionPlaybook.slice(-10) : [];
  const proof = Array.isArray(founder.proofLibrary) ? founder.proofLibrary.slice(0, 8) : [];
  const competitors = Array.isArray(founder.competitors) ? founder.competitors.slice(0, 15) : [];
  const customers = Array.isArray(founder.customers) ? founder.customers.slice(0, 15) : [];

  const playbookStr = playbook.length
    ? playbook.map(p => `"${(p.trigger || "").slice(0, 80)}" → ${(p.rebuttal || "").slice(0, 140)}`).join("\n")
    : "(none yet)";
  const proofStr = proof.length
    ? proof.map((p, i) => `[${i}] ${p.title || "(untitled)"}${p.metric ? " — " + p.metric : ""}: ${(p.body || "").slice(0, 120)}`).join("\n")
    : "(none yet)";
  const competitorsStr = competitors.length ? competitors.map(c => c.name || c).filter(Boolean).join(", ") : "(none configured)";
  const customersStr = customers.length ? customers.map(c => c.name || c).filter(Boolean).join(", ") : "(none configured)";

  // Talk-ratio advice hint — we pre-compute an advisory so Claude doesn't
  // have to infer it from partial transcript alone.
  let talkRatioNote = "";
  if (talkRatio && typeof talkRatio.you === "number") {
    const pct = Math.round(talkRatio.you * 100);
    if (pct >= 70) talkRatioNote = `⚠ Founder has been talking ${pct}% — prospect needs air. Suggest asking a question.`;
    else if (pct <= 25 && transcript.length > 400) talkRatioNote = `Founder only ${pct}% of talk — normally good, but check they're not just monologuing objections.`;
  }

  const system = `You are a real-time sales-call co-pilot watching a LIVE call between a founder and a prospect. The transcript is partial and noisy — treat it as the most recent 60-90 seconds, not the full call. Speakers are tagged in the transcript as "You:" (the founder) and "Prospect:" (whoever they're talking to).

Your job: output ONE strict JSON object with EVERY field below. Fields you have nothing for → empty string / empty array / false.

{
  "currentTopic":         "≤ 8 words. What they're discussing right now.",
  "dealStage":            "discovery | objection | negotiation | closing | stalled | offtrack",
  "nextSuggestion":       "ONE sentence the founder can literally say next. Natural, contractions ok. ≤ 180 chars.",
  "objectionDetected":    true|false,
  "objectionText":        "near-verbatim quote of concern from the transcript. ≤ 100 chars. Empty if none.",
  "objectionRebuttal":    "one-line rebuttal, cite a specific proof-library item by title if helpful. ≤ 200 chars.",
  "commitmentCaptured":   "if THIS turn someone said yes/no to a specific ask, describe in ≤ 80 chars. Empty otherwise.",
  "proofToCite": {
    "index":    integer index from the proof library above, or -1 if none fits,
    "reason":   "≤ 80 chars — why this proof fits right now"
  },
  "competitorMentioned":  "name of competitor if mentioned (must match from known list if possible). Empty if none.",
  "competitorAngle":      "if competitor mentioned, one-line differentiation angle. Empty otherwise.",
  "customerMentioned":    "name of a customer if mentioned (match known list when possible). Empty if none.",
  "buyingSignal":         "if prospect just gave a signal of intent (timeline, budget, decision-maker, 'we', 'next quarter'), ≤ 100 chars.",
  "buyingSignalStrength": "strong | medium | weak | (empty)",
  "theyllAskNext":        ["array of 2-3 SHORT predicted questions the prospect is likely to ask next, based on dealStage + their role. each ≤ 80 chars"],
  "pacingAdvice":         "ONLY if something's off: 'ask them something', 'slow down', 'push for next step', etc. ≤ 80 chars. Empty if call is fine.",
  "insight":              "one-off notable signal worth remembering. ≤ 140 chars. Empty if nothing."
}

RULES:
- Output JSON ONLY. No preamble, no code fence.
- NEVER invent quotes. objectionText, competitorMentioned, customerMentioned MUST match actual transcript content.
- proofToCite.index must be a valid index from the proof library list OR -1. Never hallucinate a proof.
- dealStage: be honest. "stalled" when no progress in last 60s, "offtrack" when convo drifted from sales intent.
- theyllAskNext: tight questions a real human would ask — not generic ("How does pricing work?" is ok if relevant; "Can you tell me more?" is not).
- competitorAngle + objectionRebuttal: use the founder's own language. No em-dashes. No "leverage / synergy / resonate / align / actionable".
- If the transcript is thin, almost every field empty is fine — don't pad.
${talkRatioNote ? `- HINT: ${talkRatioNote}` : ""}`;

  const user = `PROSPECT
  Name:    ${prospect.name || "(unknown)"}
  Role:    ${prospect.title || prospect.headline || ""}
  Company: ${prospect.company || ""}

FOUNDER CONTEXT
  Sells:     ${(founder.whatYouSell || "").slice(0, 300)}
  ICP:       ${(founder.icp || "").slice(0, 300)}
  Value prop:${(founder.valueProp || "").slice(0, 300)}

KNOWN COMPETITORS (match if prospect names one): ${competitorsStr}
EXISTING CUSTOMERS (match if prospect names one): ${customersStr}

OBJECTION PLAYBOOK (patterns seen before):
${playbookStr}

PROOF LIBRARY (index → content, cite by index in proofToCite):
${proofStr}

${priorDealStage ? `PRIOR dealStage 15s ago: ${priorDealStage}\n` : ""}
${talkRatio ? `TALK RATIO so far: you ${Math.round((talkRatio.you || 0) * 100)}% / prospect ${Math.round((talkRatio.prospect || 0) * 100)}%\n` : ""}

LIVE TRANSCRIPT (last ~60s, with speaker tags):
${transcript}

Output the JSON coaching object now.`;

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 800,      // richer response — up from 400
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text).join("").trim();
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed) return { currentTopic: "", reason: "parse_failed" };

    // Resolve proof reference — index → full proof object for client display.
    let resolvedProof = null;
    if (parsed.proofToCite && typeof parsed.proofToCite === "object") {
      const idx = Number(parsed.proofToCite.index);
      if (Number.isInteger(idx) && idx >= 0 && idx < proof.length) {
        resolvedProof = {
          title: proof[idx].title || "",
          metric: proof[idx].metric || "",
          body: (proof[idx].body || "").slice(0, 260),
          reason: (parsed.proofToCite.reason || "").toString().slice(0, 120),
        };
      }
    }

    return {
      currentTopic:         (parsed.currentTopic || "").toString().slice(0, 120),
      dealStage:            (parsed.dealStage || "").toString().toLowerCase().slice(0, 20),
      nextSuggestion:       (parsed.nextSuggestion || "").toString().slice(0, 300),
      objectionDetected:    !!parsed.objectionDetected,
      objectionText:        (parsed.objectionText || "").toString().slice(0, 200),
      objectionRebuttal:    (parsed.objectionRebuttal || "").toString().slice(0, 300),
      commitmentCaptured:   (parsed.commitmentCaptured || "").toString().slice(0, 160),
      proofToCite:          resolvedProof,
      competitorMentioned:  (parsed.competitorMentioned || "").toString().slice(0, 80),
      competitorAngle:      (parsed.competitorAngle || "").toString().slice(0, 240),
      customerMentioned:    (parsed.customerMentioned || "").toString().slice(0, 80),
      buyingSignal:         (parsed.buyingSignal || "").toString().slice(0, 160),
      buyingSignalStrength: (parsed.buyingSignalStrength || "").toString().toLowerCase().slice(0, 20),
      theyllAskNext:        Array.isArray(parsed.theyllAskNext)
                              ? parsed.theyllAskNext.slice(0, 3).map(s => String(s).slice(0, 140))
                              : [],
      pacingAdvice:         (parsed.pacingAdvice || "").toString().slice(0, 160),
      insight:              (parsed.insight || "").toString().slice(0, 240),
    };
  } catch (e) {
    return { currentTopic: "", reason: "exception" };
  }
}

// ───── 3) Call summary — post-call synthesis ──────────────────────
// Fires when the user hits "End Assist". Takes the full transcript +
// all captured commitments + objections and returns a single structured
// post-call brief: key points, action items, auto-drafted follow-up email.

async function actionCallSummary(params) {
  const transcript = (params?.transcript || "").toString().slice(-40000);
  const prospect = params?.prospect || {};
  const founder = params?.founder || {};
  const durationSeconds = Number(params?.durationSeconds || 0);

  if (!transcript || transcript.length < 80) {
    return { summary: "", actionItems: [], reason: "transcript_too_short" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { summary: "", reason: "anthropic_not_configured" };
  }

  const system = `You write post-call summaries for a founder after a sales call. Output JSON.

{
  "headline": "one sentence — biggest takeaway from the call",
  "keyPoints": ["3-6 bullets, one line each, of concrete things discussed"],
  "objectionsRaised": ["quoted prospect concerns + how to address next time"],
  "commitments": ["who committed to what by when, if anything"],
  "nextStep": "one line — specific next action the founder should take (who, what, when)",
  "followupEmail": {
    "subject": "≤ 60 chars",
    "body": "3-5 short paragraphs, reference specific things from the call, one clear CTA tied to nextStep"
  }
}

RULES:
- JSON only. No code fence.
- Quote prospect words where useful but don't invent.
- Follow-up email: no em dashes, no "leverage/synergy/resonate", no "I hope this finds you well". Direct, warm.
- If the transcript is thin/noisy, output short honest bullets and a short email — don't pad.`;

  const user = `PROSPECT
  ${prospect.name || "(unknown)"} — ${prospect.title || ""} at ${prospect.company || ""}

FOUNDER
  Sells: ${(founder.whatYouSell || "").slice(0, 200)}
  ICP: ${(founder.icp || "").slice(0, 200)}

Call duration: ${Math.round(durationSeconds / 60)} minutes.

FULL TRANSCRIPT:
${transcript}

Produce the JSON summary now.`;

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      model: "claude-sonnet-4-5",     // richer model for post-call synth
      max_tokens: 1800,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text).join("").trim();
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed) return { summary: "", reason: "parse_failed" };
    return {
      headline: (parsed.headline || "").toString().slice(0, 300),
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 8).map(s => String(s).slice(0, 240)) : [],
      objectionsRaised: Array.isArray(parsed.objectionsRaised) ? parsed.objectionsRaised.slice(0, 6).map(s => String(s).slice(0, 280)) : [],
      commitments: Array.isArray(parsed.commitments) ? parsed.commitments.slice(0, 6).map(s => String(s).slice(0, 200)) : [],
      nextStep: (parsed.nextStep || "").toString().slice(0, 300),
      followupEmail: {
        subject: ((parsed.followupEmail && parsed.followupEmail.subject) || "").toString().slice(0, 120),
        body: ((parsed.followupEmail && parsed.followupEmail.body) || "").toString().slice(0, 3000),
      },
    };
  } catch (e) {
    return { summary: "", reason: "exception" };
  }
}

// ───── Domain resolver ────────────────────────────────────────────
// LinkedIn profiles don't expose the current company's website — only the
// company name + LinkedIn slug. Every NinjaPear company endpoint wants a
// `website` param. Bridge: ask Claude Haiku to convert a name (+ optional
// LinkedIn URL hint) into the most likely registered domain. Haiku knows
// most well-known companies from training data; for obscure ones it
// returns "unknown" and the client treats that as "no domain".

async function actionResolveDomain(params) {
  const companyName = (params.companyName || "").toString().trim().slice(0, 300);
  const headline = (params.headline || "").toString().trim().slice(0, 400);
  const linkedinCompanyUrl = (params.linkedinCompanyUrl || "").toString().trim().slice(0, 400);
  const context = (params.context || "").toString().trim().slice(0, 400);

  // At least ONE input must be non-empty — either a direct company name,
  // or a headline we can extract it from, or a LinkedIn company URL.
  if (!companyName && !headline && !linkedinCompanyUrl) {
    return { domain: "", company: "", reason: "missing_inputs" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { domain: "", company: "", reason: "anthropic_not_configured" };
  }

  const prompt = `Identify the official website domain for a company. The company may be named directly OR embedded in a role description (e.g. "Co-founder, socialed | content-first social agency" → company is "socialed" → "socialedagency.com").

Output JSON only (no code fence, no prose):
{"company":"<best-guess company name>","domain":"<domain or empty string>"}

Rules:
- domain: bare registrable domain, no protocol/www/path (e.g. "stripe.com", "a16z.com", "orangecollective.vc")
- If you can't confidently identify the domain, set "domain" to empty string ""
- Always include your best guess for the company name in "company"

Inputs:
Company name or role description: ${companyName || "(none)"}
${headline ? `Person's LinkedIn headline: ${headline}` : ""}
${linkedinCompanyUrl ? `LinkedIn company URL: ${linkedinCompanyUrl}` : ""}
${context ? `Other context: ${context}` : ""}`;

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 120,
      messages: [{ role: "user", content: prompt }],
    });

    const text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("")
      .trim();

    // Strip code fences if Haiku emitted them despite the instruction.
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();

    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed || typeof parsed !== "object") {
      return { domain: "", company: companyName, reason: "parse_failed" };
    }

    const companyOut = (parsed.company || "").toString().trim().slice(0, 200);
    let domainOut = (parsed.domain || "").toString().trim().toLowerCase();

    // Validate the domain shape — if Haiku hallucinated, drop it.
    if (domainOut) {
      const m = domainOut.match(/([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/);
      domainOut = m ? m[0] : "";
    }

    return {
      domain: domainOut,
      company: companyOut || companyName,
      source: "claude",
      reason: domainOut ? "" : "not_resolved",
    };
  } catch (e) {
    console.warn("[intel/resolve-domain]", e && e.message);
    return { domain: "", company: companyName, reason: "exception" };
  }
}

// ───── deal-revival-draft ─────────────────────────────────────────
// Generate a re-engagement message for a stalled / silent deal. Pulls
// fresh news about the prospect's company via SerpApi (past month) so
// the draft has a genuine reason to reach out beyond "just checking in."
// When used for a commitment nudge (nudgeFor set), writes a short,
// professional follow-up that references the specific thing we owe
// them (or they owe us) without sounding chase-y.
async function actionDealRevivalDraft(params) {
  const deal = params?.deal || {};
  const founder = params?.founder || {};
  const language = params?.language === "es" ? "es" : "en";
  const nudgeFor = (params?.nudgeFor || "").toString().slice(0, 200);
  const nudgeOverdue = !!params?.nudgeOverdue;

  if (!deal.name) return { draft: "", reason: "missing_deal" };
  if (!process.env.ANTHROPIC_API_KEY) {
    return { draft: "", reason: "anthropic_not_configured" };
  }

  // Pull fresh company news — this is the DIFFERENTIATOR vs a generic
  // "just checking in" message. If Klosr can anchor on a real trigger
  // ("just saw you announced Series B" / "your new hiring page shows
  //  you're scaling X team"), the reply rate is massively higher.
  let freshNews = [];
  try {
    if (deal.currentCompany) {
      freshNews = await searchCompany({ company: deal.currentCompany, maxResults: 5 });
    }
  } catch {/* ignore — fall back to no news */}

  const newsBlock = freshNews.length > 0
    ? "FRESH COMPANY NEWS (past month — use one as the trigger):\n" + freshNews.slice(0, 4).map((r, i) =>
        `  ${i + 1}. ${(r.title || "").slice(0, 160)}${r.date ? ` [${String(r.date).slice(0, 30)}]` : ""}\n     ${(r.snippet || "").slice(0, 200)}`
      ).join("\n")
    : "";

  const langDirective = language === "es"
    ? "Write the draft in natural Castilian Spanish. Keep JSON keys in English."
    : "Write everything in English.";

  const isCommitNudge = !!nudgeFor;
  const intent = isCommitNudge
    ? (nudgeOverdue
        ? "They're waiting on something we promised. Don't apologize excessively — just deliver or give a clear next step. Tone: professional, action-oriented, 2-3 sentences MAX."
        : "Send the thing we promised before they have to ask. Tone: confident, brief, action-oriented.")
    : "Revive a silent deal with a genuine reason to reach out — preferably anchored to fresh company news. If no news is available, lead with one concrete new idea or question we DIDN'T ask last time.";

  const system = `You write RECOVERY messages that re-open stalled sales conversations without sounding desperate, generic, or chase-y. The founder needs a message that gets a reply, period.

${langDirective}

${intent}

Output ONE JSON object:
{
  "headline": "1-line summary of the angle you picked (e.g. 'Anchor on their Series B announcement')",
  "angle": "2-sentence explanation of WHY this angle will get a reply",
  "draft": "The actual message, ready to paste. LinkedIn DM format: 3-5 sentences, NO em-dashes, NO 'hope you're doing well', NO 'circling back', NO 'just checking in'. Anchor on something specific. End with a concrete next step (15-min call / send deck / a single question).",
  "whyThisWorks": ["2-3 bullets explaining the psychological levers. Short — ≤ 90 chars each."],
  "nextStep": "ONE sentence — what to do if they reply yes, one sentence for if they don't reply in 5 days."
}

RULES:
- NEVER: "circle back", "touch base", "checking in", "wanted to see if", "following up on our last chat", "hope this finds you well", "per my last", "just wanted to"
- NEVER use em-dashes — use commas or periods.
- Under 80 words for the draft itself.
- If fresh news is provided, the angle MUST reference it concretely (company name, event, date).
- If NO fresh news, pick the angle from: (a) a new proof point we have, (b) a concrete question we didn't ask, (c) a relevant customer we just won.
- Output JSON only, no preamble.`;

  const user = `FOUNDER:
  ${founder.name || ""} — ${founder.company || ""}
  Sells: ${(founder.whatYouSell || "").slice(0, 200)}
  Value prop: ${(founder.valueProp || "").slice(0, 200)}

PROSPECT / DEAL:
  ${deal.name} — ${(deal.currentRole || "").slice(0, 120)} at ${deal.currentCompany || ""}
  Stage: ${deal.dealStage || "unknown"}
  Last activity: ${deal.lastActivityAt ? new Date(deal.lastActivityAt).toISOString().slice(0, 10) : "unknown"}
  Recent commitments: ${JSON.stringify((deal.commitments || []).slice(-3))}
  Open objections: ${JSON.stringify((deal.objections || []).slice(-3))}
  Recent buying signals: ${JSON.stringify((deal.buyingSignals || []).slice(-3))}

${isCommitNudge ? `COMMITMENT TO DELIVER OR NUDGE: "${nudgeFor}"\n${nudgeOverdue ? "STATUS: OVERDUE — send ASAP." : ""}` : ""}

${newsBlock}

Produce the JSON now.`;

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      // Opus 4.7 — revival messages are high-stakes, quality of voice
      // matching and angle selection directly drive reply rate. Worth
      // the latency/cost over Sonnet here.
      model: "claude-opus-4-7",
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text).join("").trim();
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed || !parsed.draft) return { draft: "", reason: "parse_failed" };
    return {
      draft: String(parsed.draft || "").trim(),
      headline: String(parsed.headline || "").trim(),
      angle: String(parsed.angle || "").trim(),
      whyThisWorks: Array.isArray(parsed.whyThisWorks) ? parsed.whyThisWorks.slice(0, 3) : [],
      nextStep: String(parsed.nextStep || "").trim(),
      usedNews: freshNews.length > 0,
    };
  } catch (e) {
    console.warn("[deal-revival-draft]", e && e.message);
    return { draft: "", reason: "exception" };
  }
}

// ───── multi-thread-suggest ───────────────────────────────────────
// For a given company + existing contact, find 2-4 OTHER decision-
// makers at the same company who should also be in the deal. Runs
// Apollo mixed_people/api_search scoped to the company (by domain if
// available, by name otherwise), filters out the existing contact,
// ranks by seniority relevance to the founder's ICP, and returns a
// compact list with reasons to pull each person in.
async function actionMultiThreadSuggest(params) {
  const companyName = (params?.companyName || "").toString().trim();
  const companyDomain = (params?.companyDomain || "").toString().trim();
  const existing = params?.existingContact || {};
  const founder = params?.founder || {};

  if (!companyName && !companyDomain) {
    return { suggestions: [], reason: "missing_company" };
  }
  if (!process.env.APOLLO_API_KEY) {
    return { suggestions: [], reason: "apollo_not_configured" };
  }

  // Pick titles to search for based on founder's ICP. If ICP mentions
  // specific roles (e.g. "VP Sales", "Head of Eng"), prefer those.
  // Otherwise default to the sales-classic 4 seats of decision-making:
  // CEO / COO / VP <function> / Director <function>.
  const icp = (founder.icp || "").toLowerCase();
  const iWhat = (founder.whatYouSell || "").toLowerCase();
  const defaultTitles = ["VP", "Director", "Head of", "Chief", "Manager"];
  // Light heuristic — if ICP mentions engineering, add CTO. If mentions
  // revenue, add VP Sales. etc.
  const titleHints = [];
  if (/engineer|tech|cto|dev/.test(icp + iWhat)) titleHints.push("CTO", "VP Engineering", "Head of Engineering");
  if (/sales|revenue|growth|pipeline/.test(icp + iWhat)) titleHints.push("VP Sales", "CRO", "Head of Sales", "Head of Revenue");
  if (/marketing|brand|demand/.test(icp + iWhat)) titleHints.push("VP Marketing", "CMO", "Head of Marketing");
  if (/operations|ops|coo/.test(icp + iWhat)) titleHints.push("COO", "VP Operations", "Head of Operations");
  if (/finance|cfo|controller/.test(icp + iWhat)) titleHints.push("CFO", "VP Finance");
  if (/product|pm/.test(icp + iWhat)) titleHints.push("VP Product", "Head of Product", "CPO");

  const titles = (titleHints.length > 0 ? titleHints : defaultTitles).slice(0, 8);

  const body = {
    per_page: 10,
    page: 1,
    person_titles: titles,
  };
  // Scope to the company. Domain is more reliable when available.
  if (companyDomain) {
    body.q_organization_domains = [companyDomain];
  } else {
    body.q_organization_keyword_tags = [companyName];
  }

  const { ok, data } = await apolloCall("/mixed_people/api_search", body);
  if (!ok) return { suggestions: [], reason: "apollo_failed" };

  const rawPeople = Array.isArray(data?.people) ? data.people : [];

  // Filter: drop existing contact (LinkedIn URL match OR name+last name
  // match to survive slight canonicalisation differences).
  const existingUrl = (existing.profileUrl || "").toLowerCase().replace(/\/$/, "");
  const existingNameNorm = (existing.name || "").toLowerCase().trim();

  const cleaned = rawPeople
    .map(apolloCompactPerson)
    .filter(Boolean)
    .filter(p => {
      const url = (p.linkedinUrl || "").toLowerCase().replace(/\/$/, "");
      if (existingUrl && url && url === existingUrl) return false;
      const n = (p.name || "").toLowerCase().trim();
      if (existingNameNorm && n && n === existingNameNorm) return false;
      return true;
    });

  // Rank: prioritise C-level / VP / Head-of, then Director, then Manager.
  const rank = (t) => {
    const s = (t || "").toLowerCase();
    if (/chief|c[eoit]o|cro|cmo|cfo|cpo|founder/.test(s)) return 4;
    if (/vp |vice president|svp|evp/.test(s)) return 3;
    if (/head of|global head|group head/.test(s)) return 3;
    if (/director/.test(s)) return 2;
    if (/manager|lead/.test(s)) return 1;
    return 0;
  };
  cleaned.sort((a, b) => rank(b.title) - rank(a.title));

  // Build "why pull them in" reasons using Claude for the top 4.
  const top = cleaned.slice(0, 4);
  if (top.length === 0) return { suggestions: [], reason: "no_other_stakeholders" };

  // Light-touch reason generator. Cheap model, short output.
  let reasons = {};
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = getClient();
      const personList = top.map((p, i) => `${i + 1}. ${p.name} — ${p.title || "?"}`).join("\n");
      const { content } = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        system: `You help a founder explain WHY to pull each person into a sales deal at the same company. Output ONE JSON object with keys as person index (1, 2, ...) and values as a single reason string ≤ 90 chars. Reasons should be specific to the ROLE — e.g. CFO: "Signs the check once value is clear." Director Eng: "Will stress-test integration claims." etc. No preamble.`,
        messages: [{ role: "user", content: `Existing deal contact: ${existing.name} (${existing.title || "?"})\nFounder sells: ${founder.whatYouSell || ""}\n\nOther stakeholders to qualify reasons for:\n${personList}\n\nOutput JSON: { "1": "reason", "2": "reason", ... }` }],
      });
      const txt = (Array.isArray(content) ? content : [])
        .filter(b => b && b.type === "text").map(b => b.text).join("").trim()
        .replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
      try { reasons = JSON.parse(txt); } catch {
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) { try { reasons = JSON.parse(m[0]); } catch {} }
      }
    } catch {/* fall through — empty reasons */}
  }

  const suggestions = top.map((p, i) => ({
    name: p.name || "",
    title: p.title || "",
    linkedinUrl: p.linkedinUrl || "",
    email: p.email || "",
    emailStatus: p.emailStatus || "",
    reason: (reasons[String(i + 1)] || "").toString().slice(0, 120),
  }));

  return { suggestions };
}

// ═══════════════════════════════════════════════════════════════════
// KLOSR VISION — multimodal screenshot → action
//
// Takes a base64-encoded screenshot + user context + user prompt and
// returns a structured analysis: what Claude saw, suggested action, and
// a drafted response (reply / next step). Powers the "paste anywhere"
// feature in the extension + PWA. This is what unlocks Klosr for
// WhatsApp, email, Slack, Sales Nav, and every other surface our content
// scripts don't cover.
//
// Uses Claude Sonnet 4.5 with multimodal input. Falls back gracefully
// when no API key is configured.
// ═══════════════════════════════════════════════════════════════════
async function actionScreenshotAnalyze(params) {
  const imageBase64 = (params?.imageBase64 || "").toString();
  const mimeType = (params?.mimeType || "image/png").toString();
  const userPrompt = (params?.userPrompt || "").toString().slice(0, 1500);
  const intent = (params?.intent || "auto").toString(); // draft_reply | identify | objection | buying_signal | auto
  const language = params?.language === "es" ? "es" : "en";
  const founder = params?.founder || {};
  const proofLibrary = Array.isArray(params?.proofLibrary) ? params.proofLibrary.slice(0, 10) : [];
  const objectionPlaybook = Array.isArray(params?.objectionPlaybook) ? params.objectionPlaybook.slice(0, 10) : [];
  const voiceExamples = Array.isArray(params?.voiceExamples) ? params.voiceExamples.slice(0, 6) : [];

  if (!imageBase64) return { ok: false, reason: "missing_image" };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, reason: "anthropic_not_configured" };

  // Budget: clip ridiculously large images (>8MB base64 ~ 6MB binary).
  // Claude handles up to ~5MB per image cleanly.
  if (imageBase64.length > 8 * 1024 * 1024) {
    return { ok: false, reason: "image_too_large" };
  }

  const intentDirective = ({
    draft_reply: "The user wants you to DRAFT A RESPONSE to what's in the image. Identify who said what, then draft the reply in the founder's voice (using voice examples + proof library when relevant).",
    identify: "The user wants to IDENTIFY WHO THIS IS and whether they match the founder's ICP. Surface: name, role, company, ICP-fit score 1-10 with one-line reason, and one angle the founder could use to open.",
    objection: "The user is facing an OBJECTION. Identify it in their words, then draft a 2-3 sentence rebuttal grounded in the founder's proof library + objection playbook.",
    buying_signal: "The user wants to know if this is A BUYING SIGNAL. Grade it hot/warm/cold with one-line reason + the immediate next action (e.g. 'send calendar', 'pull in VP of X', 'close with pricing').",
    auto: "Read the screenshot carefully and decide the BEST action for the founder right now. Usually: draft a response. If the image is a profile, identify + angle. If it's an objection, rebut with proof. Adapt.",
  })[intent] || "Read the screenshot carefully and decide the best action.";

  const langDirective = language === "es"
    ? "Write the draft in natural Castilian Spanish. Keep JSON keys in English."
    : "Write the draft in English.";

  const system = `You are Klosr's Vision module. The founder just pasted a screenshot from somewhere in their workflow (WhatsApp, email, Slack, LinkedIn Sales Nav, a browser tab, their CRM — anywhere). Your job: read what's visible, infer the situation, and return the single most useful action for this founder.

${langDirective}

${intentDirective}

You have the founder's context:
- Who they are and what they sell
- Their voice examples (mirror them)
- Their proof library (cite when relevant)
- Their objection playbook (use exact rebuttals, don't invent)

Output ONE JSON object with this EXACT structure:

{
  "whatYouSaw": "2-3 sentence description of what's in the image. Be specific: names, company, app/platform, what's being said.",
  "actionCategory": "draft_reply" | "identify_prospect" | "handle_objection" | "buying_signal_alert" | "context_only",
  "temperature": "hot" | "warm" | "cold" | "n/a",
  "temperatureReason": "8-12 words on why (if applicable)",
  "draft": "The drafted response / action. Ready to paste. 2-5 sentences max for a reply, less for a nudge. EMPTY STRING if no draft makes sense (e.g. user just wants identification).",
  "suggestedProof": { "title": "...", "body": "..." },
  "nextStep": "ONE line on what the founder should do after this. Concrete.",
  "confidence": "high" | "medium" | "low"
}

RULES:
- NEVER: "circling back", "just checking in", "hope this finds you well", "I appreciate"
- NO em-dashes. Use commas or periods.
- If the image is unclear or doesn't show a sales situation, set actionCategory to "context_only" and draft="".
- Only fill suggestedProof if the situation calls for proof AND the founder's library has a relevant match.
- Output JSON only. No preamble, no code fence.`;

  const founderContext = [
    founder.name ? `Name: ${founder.name}` : "",
    founder.company ? `Company: ${founder.company}` : "",
    founder.whatYouSell ? `Sells: ${String(founder.whatYouSell).slice(0, 300)}` : "",
    founder.valueProp ? `Value prop: ${String(founder.valueProp).slice(0, 200)}` : "",
    founder.icp ? `ICP: ${String(founder.icp).slice(0, 280)}` : "",
  ].filter(Boolean).join("\n");

  const proofBlock = proofLibrary.length > 0
    ? "PROOF LIBRARY:\n" + proofLibrary.slice(0, 8).map((p, i) =>
        `  ${i + 1}. ${(p.title || "").slice(0, 100)}${p.metric ? ` [${p.metric}]` : ""} — ${(p.body || "").slice(0, 200)}`
      ).join("\n")
    : "";

  const objectionBlock = objectionPlaybook.length > 0
    ? "OBJECTION PLAYBOOK:\n" + objectionPlaybook.slice(0, 8).map((o, i) =>
        `  ${i + 1}. Trigger: "${(o.trigger || "").slice(0, 100)}"\n     Rebuttal: ${(o.rebuttal || "").slice(0, 240)}`
      ).join("\n")
    : "";

  const voiceBlock = voiceExamples.length > 0
    ? "VOICE EXAMPLES (mirror tone):\n" + voiceExamples.slice(0, 4).map((v, i) =>
        `  ${i + 1}. ${(v.after || v.before || "").slice(0, 260)}`
      ).join("\n")
    : "";

  const userText = [
    founderContext ? `FOUNDER CONTEXT:\n${founderContext}` : "",
    voiceBlock,
    proofBlock,
    objectionBlock,
    userPrompt ? `USER ASKED: ${userPrompt}` : "",
    "Analyze the attached screenshot and return the JSON action.",
  ].filter(Boolean).join("\n\n");

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      // Opus 4.7 — Klosr Vision is the tip of the spear for user
      // perception. First screenshot a user pastes/watches has to feel
      // magical or they bounce. Voice matching + objection nuance are
      // visibly better on Opus. Cost bump is acceptable vs. virality
      // payoff. (Fallback: switch to sonnet-4-5 if Anthropic bill spikes.)
      model: "claude-opus-4-7",
      max_tokens: 1500,
      system,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
          { type: "text", text: userText },
        ],
      }],
    });
    const text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text).join("").trim();
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed) return { ok: false, reason: "parse_failed", raw: cleaned.slice(0, 400) };

    return {
      ok: true,
      whatYouSaw: String(parsed.whatYouSaw || "").trim(),
      actionCategory: String(parsed.actionCategory || "context_only").trim(),
      temperature: String(parsed.temperature || "n/a").trim(),
      temperatureReason: String(parsed.temperatureReason || "").trim(),
      draft: String(parsed.draft || "").trim(),
      suggestedProof: (parsed.suggestedProof && typeof parsed.suggestedProof === "object") ? {
        title: String(parsed.suggestedProof.title || "").trim(),
        body: String(parsed.suggestedProof.body || "").trim(),
      } : { title: "", body: "" },
      nextStep: String(parsed.nextStep || "").trim(),
      confidence: String(parsed.confidence || "medium").trim(),
    };
  } catch (e) {
    console.warn("[screenshot-analyze]", e && e.message);
    return { ok: false, reason: "exception", error: String(e.message || e).slice(0, 200) };
  }
}

// ═══════════════════════════════════════════════════════════════════
// WEEKLY BRAG POST — the virality engine
//
// Reads the user's past-7-day Klosr activity (DMs sent, replies, calls,
// closes from the Upstash event log) + feeds to Claude to produce a
// humble-brag LinkedIn post the founder can one-click share. Every shared
// post = Klosr attribution = organic discovery by other founders = flywheel.
// ═══════════════════════════════════════════════════════════════════
async function actionWeeklyBragPost(params) {
  const stats = params?.stats || {};
  const founder = params?.founder || {};
  const language = params?.language === "es" ? "es" : "en";

  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, reason: "anthropic_not_configured" };

  const langDirective = language === "es"
    ? "Write the post in natural Castilian Spanish. Hashtags in Spanish."
    : "Write the post in English.";

  const system = `You write founder-voice LinkedIn posts that brag about a week's sales wins WITHOUT sounding like a brag. Think "builder sharing the play" not "salesperson flexing."

${langDirective}

Output ONE JSON object:
{
  "post": "The full LinkedIn post, ready to paste. 800-1500 chars. Hook in the first 2 lines (LinkedIn truncates after line 2). No em-dashes. No 'game-changer / leverage / synergy / resonate'. Specific numbers > adjectives. End with a question that invites replies.",
  "hook": "First 2 lines — the part that shows before 'see more'",
  "hashtags": ["3-5 hashtags, no # prefix"]
}

STRUCTURE:
- Line 1: pattern interrupt (a number, a counter-intuitive claim, or a specific moment)
- Lines 2-3: what happened this week in your sales, with numbers
- Lines 4-8: the tactical play that worked (this is the teach — other founders screenshot this)
- Line 9-10: what Klosr did that mattered (subtle, not an ad)
- Final line: a question

VIBE: "I'm a founder who closed deals this week, here's the play" — not "sales guru teaching the masses". Direct, confident, numbers-forward, one genuine observation. Humble-brag = real numbers + "still figuring this out" energy.

KLOSR ATTRIBUTION: Mention Klosr ONCE, naturally, tagged as @Klosr. Not as a sponsor — as the tool that did a specific thing ("Klosr auto-drafted the follow-up", "Klosr flagged the hot reply", etc.). Specific > generic.`;

  const user = `FOUNDER:
  ${founder.name || ""} — ${founder.role || "Founder"} @ ${founder.company || ""}
  Sells: ${(founder.whatYouSell || "").slice(0, 200)}

THIS WEEK'S NUMBERS:
  DMs sent: ${stats.dmsSent || 0}
  Replies received: ${stats.repliesReceived || 0}
  Calls booked: ${stats.callsBooked || 0}
  Calls run: ${stats.callsRun || 0}
  Signups / closed: ${stats.closed || 0}
  Pipeline added: ${stats.pipelineAdded || 0}

BEST SINGLE WIN (if provided): ${(params?.bestWin || "").slice(0, 400)}

Generate the post. Follow the structure.`;

  try {
    const client = getClient();
    const { content } = await client.messages.create({
      // Opus 4.7 — this post is Klosr's distribution vector. Every word
      // decides whether it gets shared. Upgrading here is a direct
      // investment in growth compounding.
      model: "claude-opus-4-7",
      max_tokens: 1400,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = (Array.isArray(content) ? content : [])
      .filter(b => b && b.type === "text").map(b => b.text).join("").trim();
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed || !parsed.post) return { ok: false, reason: "parse_failed" };
    return {
      ok: true,
      post: String(parsed.post || "").trim(),
      hook: String(parsed.hook || "").trim(),
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 5) : [],
    };
  } catch (e) {
    console.warn("[weekly-brag-post]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// HUBSPOT INTEGRATION
//
// Standard OAuth 2.0 flow with HubSpot. Three actions:
//   hubspot-oauth-url      → returns the HubSpot authorize URL + state
//   hubspot-oauth-exchange → exchanges code for access+refresh tokens
//   hubspot-push-deal      → creates a deal + contact in the user's HubSpot
//
// Scopes we request:
//   crm.objects.contacts.write crm.objects.contacts.read
//   crm.objects.deals.write    crm.objects.deals.read
//
// Token storage: we store access + refresh tokens per-installId in Upstash
// (NOT in chrome.storage — too risky for tokens). Client passes installId
// with every request; backend reads the matching token and makes HubSpot
// API calls on the user's behalf.
// ═══════════════════════════════════════════════════════════════════
const HUBSPOT_SCOPES = [
  "crm.objects.contacts.write",
  "crm.objects.contacts.read",
  "crm.objects.deals.write",
  "crm.objects.deals.read",
  "oauth",
].join(" ");

async function actionHubspotOauthUrl(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  const clientId = process.env.HUBSPOT_CLIENT_ID || "";
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI || "";
  if (!clientId || !redirectUri) return { ok: false, reason: "hubspot_not_configured" };
  if (!installId) return { ok: false, reason: "missing_install_id" };

  // Use installId as the state so we can associate the callback code with
  // the right user. In production add a random nonce + verify via Upstash.
  const state = Buffer.from(JSON.stringify({ installId, nonce: Math.random().toString(36).slice(2, 10) })).toString("base64url");
  const url = "https://app.hubspot.com/oauth/authorize"
    + "?client_id=" + encodeURIComponent(clientId)
    + "&redirect_uri=" + encodeURIComponent(redirectUri)
    + "&scope=" + encodeURIComponent(HUBSPOT_SCOPES)
    + "&state=" + encodeURIComponent(state);
  return { ok: true, url };
}

async function actionHubspotOauthExchange(params) {
  const code = (params?.code || "").toString();
  const installId = (params?.installId || "").toString().slice(0, 120);
  const clientId = process.env.HUBSPOT_CLIENT_ID || "";
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET || "";
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI || "";
  if (!code || !installId) return { ok: false, reason: "missing_params" };
  if (!clientId || !clientSecret || !redirectUri) return { ok: false, reason: "hubspot_not_configured" };

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });
    const res = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      return { ok: false, reason: "hubspot_token_error", error: String(data.message || "unknown").slice(0, 200) };
    }

    // Stash tokens in Upstash. They'll persist until the user disconnects.
    if (hasUpstash()) {
      const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
      const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
      const key = `kl:hubspot:${installId}`;
      const payload = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (Number(data.expires_in || 21600) * 1000),
        savedAt: Date.now(),
      };
      await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(payload))}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      }).catch(() => {});
    }

    return { ok: true, connected: true, expiresIn: data.expires_in };
  } catch (e) {
    console.warn("[hubspot-exchange]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

async function getHubspotToken(installId) {
  if (!hasUpstash()) return null;
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `kl:hubspot:${installId}`;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!data || !data.result) return null;
    const parsed = JSON.parse(data.result);
    if (!parsed || !parsed.accessToken) return null;
    // TODO: refresh if expiresAt is past. For MVP we accept the 6h window.
    return parsed;
  } catch { return null; }
}

async function actionHubspotPushDeal(params) {
  const installId = (params?.installId || "").toString();
  const deal = params?.deal || {};
  if (!installId) return { ok: false, reason: "missing_install_id" };
  if (!deal.name) return { ok: false, reason: "missing_deal" };

  const token = await getHubspotToken(installId);
  if (!token) return { ok: false, reason: "not_connected" };

  const hub = async (path, body, method = "POST") => {
    const res = await fetch(`https://api.hubapi.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  };

  try {
    // 1. Create or update the contact (LinkedIn URL as primary external id).
    const linkedinUrl = deal.profileUrl || "";
    const contactBody = {
      properties: {
        firstname: (deal.name || "").split(" ")[0] || "",
        lastname: (deal.name || "").split(" ").slice(1).join(" ") || "",
        company: deal.currentCompany || "",
        jobtitle: deal.currentRole || deal.headline || "",
        hs_linkedin_url: linkedinUrl,
      },
    };
    if (deal.email) contactBody.properties.email = deal.email;

    const contactRes = await hub("/crm/v3/objects/contacts", contactBody);
    if (!contactRes.ok && contactRes.status !== 409) {
      return { ok: false, reason: "hubspot_contact_error", status: contactRes.status, error: contactRes.data?.message };
    }
    const contactId = contactRes.data?.id || null;

    // 2. Create the deal. Stage map — HubSpot uses pipeline + dealstage IDs,
    // which vary per portal. Safest MVP: use internal labels as custom
    // properties OR push to the user's "default" pipeline with a known stage.
    // For v1 we push to the portal's default pipeline at "appointmentscheduled"
    // and let the user re-stage inside HubSpot.
    const dealStageMap = {
      prepped: "appointmentscheduled",
      contacted: "appointmentscheduled",
      replied: "qualifiedtobuy",
      discovery: "presentationscheduled",
      objection: "decisionmakerboughtin",
      negotiation: "contractsent",
      closing: "contractsent",
      won: "closedwon",
      lost: "closedlost",
    };
    const dealStage = dealStageMap[deal.dealStage || deal.stage] || "appointmentscheduled";

    const dealBody = {
      properties: {
        dealname: `${deal.name} — ${deal.currentCompany || ""}`.trim().replace(/ —\s*$/, ""),
        dealstage: dealStage,
        amount: typeof deal.acv === "number" && deal.acv > 0 ? String(deal.acv) : "",
      },
      associations: contactId ? [{
        to: { id: contactId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }], // deal→contact
      }] : [],
    };
    const dealRes = await hub("/crm/v3/objects/deals", dealBody);
    if (!dealRes.ok) {
      return { ok: false, reason: "hubspot_deal_error", status: dealRes.status, error: dealRes.data?.message };
    }

    return {
      ok: true,
      hubspotDealId: dealRes.data?.id,
      hubspotContactId: contactId,
      portalUrl: `https://app.hubspot.com/contacts/${dealRes.data?.properties?.hs_object_id || ""}/deal/${dealRes.data?.id || ""}`,
    };
  } catch (e) {
    console.warn("[hubspot-push-deal]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// SLACK NOTIFY — incoming-webhook based (simplest integration)
//
// User pastes their Slack incoming webhook URL in Klosr settings (we
// store encrypted in Upstash keyed by installId). When a pipeline event
// fires (hot reply, closed deal, etc), we POST to the webhook so the
// alert shows in their team channel.
//
// No Slack OAuth, no app install, no permissions dance — just a webhook
// URL. Covers 95% of the "Klosr notifies my team" need.
// ═══════════════════════════════════════════════════════════════════
async function actionSlackNotify(params) {
  const webhookUrl = (params?.webhookUrl || "").toString();
  const title = (params?.title || "Klosr alert").toString().slice(0, 200);
  const message = (params?.message || "").toString().slice(0, 1500);
  const color = (params?.color || "good").toString();
  const fields = Array.isArray(params?.fields) ? params.fields.slice(0, 8) : [];

  if (!webhookUrl || !webhookUrl.startsWith("https://hooks.slack.com/")) {
    return { ok: false, reason: "invalid_webhook" };
  }

  const payload = {
    attachments: [{
      color,
      title,
      text: message,
      fields: fields.map(f => ({
        title: String(f.title || "").slice(0, 60),
        value: String(f.value || "").slice(0, 200),
        short: !!f.short,
      })),
      footer: "Klosr · klosr.com",
      ts: Math.floor(Date.now() / 1000),
    }],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "slack_error", status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[slack-notify]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// PWA BOOTSTRAP — Klosr Desktop web app entry point
//
// When the PWA loads, it calls this action with the user's installId
// (copied from the Chrome extension once) to retrieve their founder
// profile, so the PWA can render personalized content without making
// the user re-onboard.
// ═══════════════════════════════════════════════════════════════════
async function actionPwaBootstrap(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  if (!installId) return { ok: false, reason: "missing_install_id" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  try {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    const key = `kl:user:${installId}`;
    const res = await fetch(`${UPSTASH_URL}/hgetall/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    const raw = Array.isArray(data?.result) ? data.result : [];
    const user = {};
    for (let i = 0; i < raw.length; i += 2) user[raw[i]] = raw[i + 1];
    if (!user || Object.keys(user).length === 0) return { ok: false, reason: "user_not_found" };

    // Check HubSpot connection
    const hubspot = await getHubspotToken(installId);

    // Pull synced state (proof library / objection playbook / voice / ICP
    // learnings) stashed by the Chrome extension via `sync-state`. PWA
    // includes these in every Vision call so drafts match the user's
    // voice + cite their actual proof, not generic responses.
    const state = await getSyncedState(installId);

    return {
      ok: true,
      user: {
        installId,
        email: user.email || "",
        yourName: user.yourName || "",
        yourRole: user.yourRole || "",
        companyName: user.companyName || "",
        icp: user.icp || "",
        lastSeen: Number(user.lastSeen) || 0,
        eventCount: Number(user.eventCount) || 0,
      },
      syncedState: state || null,
      integrations: {
        hubspot: !!hubspot,
      },
    };
  } catch (e) {
    console.warn("[pwa-bootstrap]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

// Helper — read synced state (proof library / playbook / voice / ICP)
// from Upstash. Returns null if no state has been synced yet.
async function getSyncedState(installId) {
  if (!hasUpstash() || !installId) return null;
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `kl:state:${installId}`;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!data || !data.result) return null;
    return JSON.parse(data.result);
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// SYNC-STATE — extension ↔ PWA state mirror
//
// The Chrome extension holds the user's rich sales context in
// chrome.storage.local: proof library, objection playbook, voice
// examples (from edits), ICP learnings. The PWA can't read
// chrome.storage directly, so the extension POSTs this state here on
// changes + on an interval. Upstash stores it keyed by installId.
//
// The PWA then pulls this state in pwa-bootstrap + includes it in
// every Vision call. This is what makes PWA drafts feel "in the
// user's voice" instead of generic.
// ═══════════════════════════════════════════════════════════════════
async function actionSyncState(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  const state = params?.state || {};
  if (!installId) return { ok: false, reason: "missing_install_id" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  // Clip each field to a sane size so a user with 500 proof entries
  // doesn't blow up the payload.
  const clipped = {
    proofLibrary: Array.isArray(state.proofLibrary)
      ? state.proofLibrary.slice(0, 30).map(p => ({
          title: String(p.title || "").slice(0, 140),
          metric: String(p.metric || "").slice(0, 80),
          body: String(p.body || "").slice(0, 400),
        })) : [],
    objectionPlaybook: Array.isArray(state.objectionPlaybook)
      ? state.objectionPlaybook.slice(0, 30).map(o => ({
          trigger: String(o.trigger || "").slice(0, 160),
          rebuttal: String(o.rebuttal || "").slice(0, 400),
        })) : [],
    voiceExamples: Array.isArray(state.voiceExamples)
      ? state.voiceExamples.slice(0, 12).map(v => ({
          before: String(v.before || "").slice(0, 400),
          after: String(v.after || "").slice(0, 400),
        })) : [],
    icpLearnings: String(state.icpLearnings || "").slice(0, 1200),
    syncedAt: Date.now(),
  };

  try {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    const key = `kl:state:${installId}`;
    // SET with no TTL — state persists until next sync.
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(clipped))}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    return { ok: true, syncedAt: clipped.syncedAt, stateSize: JSON.stringify(clipped).length };
  } catch (e) {
    console.warn("[sync-state]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// QUEUE-PENDING-REPLY — PWA → extension cross-app inject bridge
//
// When the PWA Watch detects a reply and the user clicks "Inject into
// [WhatsApp/Gmail]" on the draft card, the PWA calls this with the
// drafted text + target app. We stash in Upstash with a 5-minute TTL.
// The Chrome extension (running on that app's web page) polls
// fetch-pending-reply every ~10s and auto-fills the composer when a
// matching draft exists.
// ═══════════════════════════════════════════════════════════════════
async function actionQueuePendingReply(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  const draft = (params?.draft || "").toString().slice(0, 4000);
  const targetApp = (params?.targetApp || "auto").toString().slice(0, 40);
  const source = (params?.source || "").toString().slice(0, 120);
  const draftId = (params?.draftId || "").toString().slice(0, 64) || ("d-" + Date.now());
  if (!installId) return { ok: false, reason: "missing_install_id" };
  if (!draft) return { ok: false, reason: "missing_draft" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  const payload = { draft, targetApp, source, draftId, queuedAt: Date.now() };
  try {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    const key = `kl:pending_reply:${installId}`;
    // SETEX — 300s TTL. The draft is valid for 5 min; after that, the
    // prospect has moved on and the draft is stale.
    await fetch(`${UPSTASH_URL}/setex/${encodeURIComponent(key)}/300/${encodeURIComponent(JSON.stringify(payload))}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    return { ok: true, draftId, ttl: 300 };
  } catch (e) {
    console.warn("[queue-pending-reply]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

async function actionFetchPendingReply(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  const consume = !!params?.consume;   // if true, delete after read
  if (!installId) return { ok: false, reason: "missing_install_id" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  try {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    const key = `kl:pending_reply:${installId}`;
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!data || !data.result) return { ok: true, pending: null };
    const parsed = JSON.parse(data.result);

    if (consume) {
      // Delete so it's one-shot (extension injected it, don't re-inject)
      await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      }).catch(() => {});
    }
    return { ok: true, pending: parsed };
  } catch (e) {
    console.warn("[fetch-pending-reply]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// PIPEDRIVE — API-token auth (simpler than OAuth for v1)
//
// User generates a personal API token in Pipedrive (Settings → Personal →
// API) and pastes it in Klosr Desktop. We store per-installId + domain
// (company domain, e.g. "klosr" → klosr.pipedrive.com) and push deals
// via the v1 REST API.
// ═══════════════════════════════════════════════════════════════════
async function actionPipedriveSaveToken(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  const apiToken = (params?.apiToken || "").toString().slice(0, 200);
  const companyDomain = (params?.companyDomain || "").toString().slice(0, 80).toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!installId || !apiToken || !companyDomain) return { ok: false, reason: "missing_params" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  // Validate by calling Pipedrive /users/me
  try {
    const testRes = await fetch(`https://${companyDomain}.pipedrive.com/api/v1/users/me?api_token=${encodeURIComponent(apiToken)}`);
    const testData = await testRes.json().catch(() => ({}));
    if (!testRes.ok || !testData?.success) {
      return { ok: false, reason: "pipedrive_invalid_token", error: (testData?.error || "").slice(0, 200) };
    }

    // Stash token in Upstash
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    const key = `kl:pipedrive:${installId}`;
    const payload = {
      apiToken,
      companyDomain,
      userName: testData?.data?.name || "",
      userEmail: testData?.data?.email || "",
      savedAt: Date.now(),
    };
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(payload))}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    return { ok: true, connected: true, userName: payload.userName, userEmail: payload.userEmail };
  } catch (e) {
    console.warn("[pipedrive-save-token]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

async function getPipedriveAuth(installId) {
  if (!hasUpstash() || !installId) return null;
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `kl:pipedrive:${installId}`;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.result) return null;
    return JSON.parse(data.result);
  } catch { return null; }
}

async function actionPipedrivePushDeal(params) {
  const installId = (params?.installId || "").toString();
  const deal = params?.deal || {};
  if (!installId || !deal.name) return { ok: false, reason: "missing_params" };

  const auth = await getPipedriveAuth(installId);
  if (!auth) return { ok: false, reason: "not_connected" };
  const base = `https://${auth.companyDomain}.pipedrive.com/api/v1`;
  const tokenQs = `api_token=${encodeURIComponent(auth.apiToken)}`;

  try {
    // 1. Create Person (Pipedrive's contact primitive)
    const nameParts = (deal.name || "").split(" ");
    const first = nameParts[0] || deal.name;
    const last = nameParts.slice(1).join(" ");
    const personBody = {
      name: deal.name || "",
      email: deal.email ? [{ value: deal.email, primary: true, label: "work" }] : [],
    };
    const personRes = await fetch(`${base}/persons?${tokenQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(personBody),
    });
    const personData = await personRes.json().catch(() => ({}));
    if (!personRes.ok || !personData?.data?.id) {
      return { ok: false, reason: "pipedrive_person_error", error: (personData?.error || "").slice(0, 200) };
    }
    const personId = personData.data.id;

    // 2. Create Organization (optional, if we have company)
    let orgId = null;
    if (deal.currentCompany) {
      const orgBody = { name: deal.currentCompany };
      const orgRes = await fetch(`${base}/organizations?${tokenQs}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orgBody),
      });
      const orgData = await orgRes.json().catch(() => ({}));
      if (orgRes.ok && orgData?.data?.id) orgId = orgData.data.id;
    }

    // 3. Create Deal
    const dealBody = {
      title: `${deal.name} — ${deal.currentCompany || ""}`.trim().replace(/ —\s*$/, ""),
      person_id: personId,
      org_id: orgId,
      value: typeof deal.acv === "number" && deal.acv > 0 ? deal.acv : undefined,
      currency: "USD",
      status: (deal.dealStage || deal.stage) === "won" ? "won"
            : (deal.dealStage || deal.stage) === "lost" ? "lost"
            : "open",
    };
    const dealRes = await fetch(`${base}/deals?${tokenQs}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dealBody),
    });
    const dealData = await dealRes.json().catch(() => ({}));
    if (!dealRes.ok || !dealData?.data?.id) {
      return { ok: false, reason: "pipedrive_deal_error", error: (dealData?.error || "").slice(0, 200) };
    }

    return {
      ok: true,
      pipedriveDealId: dealData.data.id,
      pipedrivePersonId: personId,
      pipedriveUrl: `https://${auth.companyDomain}.pipedrive.com/deal/${dealData.data.id}`,
    };
  } catch (e) {
    console.warn("[pipedrive-push-deal]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// SALESFORCE — OAuth 2.0 authorization code flow
//
// Similar pattern to HubSpot. Salesforce Connected App required on the
// admin's end (set env vars SALESFORCE_CLIENT_ID / SECRET / REDIRECT).
// Token refresh not implemented in v1 — tokens last 15m-2h, user
// re-connects if they expire. v2 will add refresh_token handling.
// ═══════════════════════════════════════════════════════════════════
const SALESFORCE_SCOPES = "api refresh_token id";

async function actionSalesforceOauthUrl(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  const clientId = process.env.SALESFORCE_CLIENT_ID || "";
  const redirectUri = process.env.SALESFORCE_REDIRECT_URI || "";
  if (!clientId || !redirectUri) return { ok: false, reason: "salesforce_not_configured" };
  if (!installId) return { ok: false, reason: "missing_install_id" };

  const state = Buffer.from(JSON.stringify({ installId, nonce: Math.random().toString(36).slice(2, 10) })).toString("base64url");
  // Salesforce has two auth hosts — login.salesforce.com (production) and
  // test.salesforce.com (sandbox). v1 defaults to production.
  const authHost = (params?.sandbox ? "test" : "login") + ".salesforce.com";
  const url = `https://${authHost}/services/oauth2/authorize`
    + "?response_type=code"
    + "&client_id=" + encodeURIComponent(clientId)
    + "&redirect_uri=" + encodeURIComponent(redirectUri)
    + "&scope=" + encodeURIComponent(SALESFORCE_SCOPES)
    + "&state=" + encodeURIComponent(state);
  return { ok: true, url };
}

async function actionSalesforceOauthExchange(params) {
  const code = (params?.code || "").toString();
  const installId = (params?.installId || "").toString().slice(0, 120);
  const sandbox = !!params?.sandbox;
  const clientId = process.env.SALESFORCE_CLIENT_ID || "";
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET || "";
  const redirectUri = process.env.SALESFORCE_REDIRECT_URI || "";
  if (!code || !installId) return { ok: false, reason: "missing_params" };
  if (!clientId || !clientSecret || !redirectUri) return { ok: false, reason: "salesforce_not_configured" };

  const tokenHost = (sandbox ? "test" : "login") + ".salesforce.com";
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });
    const res = await fetch(`https://${tokenHost}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      return { ok: false, reason: "salesforce_token_error", error: String(data.error_description || data.error || "unknown").slice(0, 200) };
    }

    if (hasUpstash()) {
      const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
      const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
      const key = `kl:salesforce:${installId}`;
      const payload = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || "",
        instanceUrl: data.instance_url,
        tokenType: data.token_type,
        savedAt: Date.now(),
      };
      await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(payload))}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
    }
    return { ok: true, connected: true, instanceUrl: data.instance_url };
  } catch (e) {
    console.warn("[salesforce-exchange]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

async function getSalesforceToken(installId) {
  if (!hasUpstash() || !installId) return null;
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `kl:salesforce:${installId}`;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.result) return null;
    return JSON.parse(data.result);
  } catch { return null; }
}

async function actionSalesforcePushDeal(params) {
  const installId = (params?.installId || "").toString();
  const deal = params?.deal || {};
  if (!installId || !deal.name) return { ok: false, reason: "missing_params" };

  const token = await getSalesforceToken(installId);
  if (!token) return { ok: false, reason: "not_connected" };

  const api = async (path, body, method = "POST") => {
    const res = await fetch(`${token.instanceUrl}/services/data/v58.0${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ([]));
    return { ok: res.ok, status: res.status, data };
  };

  try {
    // 1. Create Lead (simpler than Contact + Opportunity for first-touch)
    const nameParts = (deal.name || "").split(" ");
    const leadBody = {
      FirstName: nameParts[0] || deal.name,
      LastName: nameParts.slice(1).join(" ") || nameParts[0] || "Unknown",
      Company: deal.currentCompany || "Unknown",
      Title: deal.currentRole || deal.headline || "",
      Email: deal.email || undefined,
      LeadSource: "Klosr",
      Status: (deal.dealStage === "won") ? "Closed - Converted"
            : (deal.dealStage === "lost") ? "Closed - Not Converted"
            : "Working - Contacted",
    };
    const leadRes = await api("/sobjects/Lead", leadBody);
    if (!leadRes.ok) {
      return { ok: false, reason: "salesforce_lead_error", status: leadRes.status, error: JSON.stringify(leadRes.data).slice(0, 200) };
    }
    const leadId = Array.isArray(leadRes.data) ? leadRes.data[0]?.id : leadRes.data?.id;
    return {
      ok: true,
      salesforceLeadId: leadId,
      leadUrl: leadId ? `${token.instanceUrl}/lightning/r/Lead/${leadId}/view` : null,
    };
  } catch (e) {
    console.warn("[salesforce-push-deal]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// STRIPE — Pro subscription checkout + status
//
// Klosr's monetization layer. Free tier doesn't touch Stripe. Pro ($29/mo)
// uses Stripe Checkout in subscription mode. We pass installId in the
// metadata so when the webhook fires (subscription.created), we can mark
// that installId as Pro in Upstash. The PWA + extension check this on
// boot to gate Pro-only features.
//
// Required env vars on Vercel:
//   STRIPE_SECRET_KEY        — sk_live_xxx (or sk_test_xxx for testing)
//   STRIPE_PRICE_ID_PRO      — price_xxx for the Pro $29/mo subscription
//   STRIPE_WEBHOOK_SECRET    — whsec_xxx for webhook signature verification
// ═══════════════════════════════════════════════════════════════════

async function actionStripeCreateCheckout(params) {
  const tier = (params?.tier || "pro").toString();
  const installId = (params?.installId || "").toString().slice(0, 120);
  const email = (params?.email || "").toString().slice(0, 200);
  const successUrl = (params?.successUrl || "https://backend-kappa-nine-57.vercel.app/upgrade-success.html").toString();
  const cancelUrl = (params?.cancelUrl || "https://backend-kappa-nine-57.vercel.app/pricing.html").toString();

  const stripeKey = process.env.STRIPE_SECRET_KEY || "";
  const priceId = tier === "pro"
    ? (process.env.STRIPE_PRICE_ID_PRO || "")
    : "";
  if (!stripeKey || !priceId) return { ok: false, reason: "stripe_not_configured" };
  if (!installId) return { ok: false, reason: "missing_install_id" };

  // Stripe Checkout API call. Subscription mode, 14-day trial.
  const body = new URLSearchParams();
  body.append("mode", "subscription");
  body.append("line_items[0][price]", priceId);
  body.append("line_items[0][quantity]", "1");
  body.append("success_url", successUrl + (successUrl.includes("?") ? "&" : "?") + "session_id={CHECKOUT_SESSION_ID}");
  body.append("cancel_url", cancelUrl);
  body.append("client_reference_id", installId);
  body.append("metadata[installId]", installId);
  body.append("metadata[tier]", tier);
  body.append("subscription_data[trial_period_days]", "14");
  body.append("subscription_data[metadata][installId]", installId);
  body.append("subscription_data[metadata][tier]", tier);
  body.append("allow_promotion_codes", "true");
  if (email) body.append("customer_email", email);

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      console.warn("[stripe-checkout]", data?.error?.message);
      return { ok: false, reason: "stripe_error", error: String(data?.error?.message || "unknown").slice(0, 200) };
    }
    return { ok: true, url: data.url, sessionId: data.id };
  } catch (e) {
    console.warn("[stripe-checkout]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

async function actionStripeSubscriptionStatus(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  if (!installId) return { ok: false, reason: "missing_install_id" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured", tier: "founder" };

  try {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    const key = `kl:subscription:${installId}`;
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.result) return { ok: true, tier: "founder", isPro: false };
    const sub = JSON.parse(data.result);
    const active = sub.status === "active" || sub.status === "trialing";
    return {
      ok: true,
      tier: active ? (sub.tier || "pro") : "founder",
      isPro: active,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      trialEnd: sub.trialEnd,
    };
  } catch (e) {
    return { ok: true, tier: "founder", isPro: false };
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAGIC LINK AUTH (email-based, passwordless)
//
// For Pro/Team users who want to bind their installId to an email so
// they can recover access on a new device. Uses Resend for delivery.
// MVP: email→token (in Upstash, 15-min TTL)→clicked-link verifies + binds.
//
// Free tier doesn't need this; their installId-only flow continues working.
//
// Required env vars:
//   RESEND_API_KEY  — re_xxx
//   AUTH_FROM_EMAIL — defaults to "Klosr <hello@klosr.com>"
// ═══════════════════════════════════════════════════════════════════

async function actionMagicLinkRequest(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  const email = (params?.email || "").toString().toLowerCase().trim().slice(0, 200);
  if (!installId || !email) return { ok: false, reason: "missing_params" };
  // Light email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: "invalid_email" };

  const resendKey = process.env.RESEND_API_KEY || "";
  if (!resendKey) return { ok: false, reason: "auth_not_configured" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  // Generate a short-lived token (random 32-byte hex)
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, "0")).join("");

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `kl:magic:${token}`;
  const payload = { email, installId, createdAt: Date.now() };
  // 15-min TTL
  await fetch(`${UPSTASH_URL}/setex/${encodeURIComponent(key)}/900/${encodeURIComponent(JSON.stringify(payload))}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  }).catch(() => {});

  const verifyUrl = `https://backend-kappa-nine-57.vercel.app/auth-verify.html?token=${encodeURIComponent(token)}`;
  const fromEmail = process.env.AUTH_FROM_EMAIL || "Klosr <hello@klosr.com>";

  // Send the magic link via Resend
  try {
    const emailHtml = `
      <div style="font-family: -apple-system, sans-serif; max-width: 540px; margin: 0 auto; padding: 30px 24px; color: #18181B;">
        <h1 style="font-size: 22px; margin: 0 0 12px;">Sign in to Klosr</h1>
        <p style="font-size: 14px; line-height: 1.5; color: #3F3F46;">Click the button below to sign in. Link expires in 15 minutes.</p>
        <p style="margin: 26px 0;">
          <a href="${verifyUrl}" style="display: inline-block; padding: 14px 24px; background: linear-gradient(135deg, #FFD60A, #F59E0B); color: #0A0A0B; text-decoration: none; font-weight: 800; font-size: 14px; border-radius: 10px;">Sign in to Klosr →</a>
        </p>
        <p style="font-size: 12px; color: #71717A;">If you didn't request this, ignore this email. Nobody can access your account from this link.</p>
        <hr style="border: none; height: 1px; background: #E4E4E7; margin: 24px 0;">
        <p style="font-size: 11px; color: #A1A1AA;">Klosr · Sales OS for founders · klosr.com</p>
      </div>
    `;
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: "Sign in to Klosr",
        html: emailHtml,
      }),
    });
    if (!emailRes.ok) {
      const errData = await emailRes.json().catch(() => ({}));
      return { ok: false, reason: "email_send_failed", error: String(errData?.message || "unknown").slice(0, 200) };
    }
    return { ok: true, sent: true };
  } catch (e) {
    return { ok: false, reason: "exception" };
  }
}

async function actionMagicLinkVerify(params) {
  const token = (params?.token || "").toString().slice(0, 100);
  if (!token) return { ok: false, reason: "missing_token" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  try {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    const key = `kl:magic:${token}`;
    // Get the token data
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.result) return { ok: false, reason: "token_invalid_or_expired" };

    const parsed = JSON.parse(data.result);

    // Bind email ↔ installId in user record (Upstash hash)
    const userKey = `kl:user:${parsed.installId}`;
    await fetch(`${UPSTASH_URL}/hset/${encodeURIComponent(userKey)}/email/${encodeURIComponent(parsed.email)}/verifiedAt/${Date.now()}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    }).catch(() => {});

    // Reverse-index email → installId so we can look up later
    const emailKey = `kl:email:${parsed.email}`;
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(emailKey)}/${encodeURIComponent(parsed.installId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    }).catch(() => {});

    // Burn the token (one-shot)
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    }).catch(() => {});

    return { ok: true, installId: parsed.installId, email: parsed.email };
  } catch (e) {
    return { ok: false, reason: "exception" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// 6-DIGIT CODE AUTH (desktop app flow)
//
// Klosr Native uses a typed 6-digit code instead of clicking a magic link
// (UX matches Cluely / Linear / Notion). actionAuthCodeSend generates a
// random 6-digit code, stores it in Upstash with the email as the lookup
// key, and emails the code to the user. actionAuthCodeVerify accepts
// { email, code } and on success creates or fetches the install record
// and returns { installId, user }.
// ═══════════════════════════════════════════════════════════════════

async function actionAuthCodeSend(params) {
  const email = (params?.email || "").toString().toLowerCase().trim().slice(0, 200);
  if (!email) return { ok: false, reason: "missing_email" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: "invalid_email" };

  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  const resendKey = process.env.RESEND_API_KEY || "";
  // Dev-mode fallback: if Resend isn't configured, we still generate the
  // code and store it, but return it in the response so the desktop app
  // can show it as a banner. Production should always have RESEND set.
  const devMode = !resendKey;

  // 6-digit numeric code
  const code = String(Math.floor(100000 + Math.random() * 900000));

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `kl:authcode:${email}`;
  const payload = { code, email, attempts: 0, createdAt: Date.now() };
  // 10-min TTL
  await fetch(`${UPSTASH_URL}/setex/${encodeURIComponent(key)}/600/${encodeURIComponent(JSON.stringify(payload))}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  }).catch(() => {});

  if (devMode) {
    // Skip the email send entirely — return the code so the client can
    // show it. Logged for visibility in Vercel logs too.
    console.log(`[auth-code-send] DEV MODE: code for ${email} = ${code}`);
    return { ok: true, sent: false, devMode: true, devCode: code };
  }

  const fromEmail = process.env.AUTH_FROM_EMAIL || "Klosr <hello@klosr.com>";
  try {
    const emailHtml = `
      <div style="font-family: -apple-system, sans-serif; max-width: 540px; margin: 0 auto; padding: 30px 24px; color: #18181B;">
        <h1 style="font-size: 22px; margin: 0 0 12px;">Your Klosr sign-in code</h1>
        <p style="font-size: 14px; line-height: 1.5; color: #3F3F46;">Enter this code in Klosr Desktop to sign in. It expires in 10 minutes.</p>
        <div style="margin: 26px 0; padding: 22px; background: linear-gradient(135deg, #FFFBE6, #FFF7CC); border: 1px solid rgba(255, 214, 10, 0.45); border-radius: 14px; text-align: center;">
          <div style="font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #0A0A0B;">${code}</div>
        </div>
        <p style="font-size: 12px; color: #71717A;">If you didn't request this, ignore this email. Nobody can access your account from this code.</p>
        <hr style="border: none; height: 1px; background: #E4E4E7; margin: 24px 0;">
        <p style="font-size: 11px; color: #A1A1AA;">Klosr · Sales OS for founders · klosr.com</p>
      </div>
    `;
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: `Your Klosr sign-in code: ${code}`,
        html: emailHtml,
      }),
    });
    if (!emailRes.ok) {
      const errData = await emailRes.json().catch(() => ({}));
      return { ok: false, reason: "email_send_failed", error: String(errData?.message || "unknown").slice(0, 200) };
    }
    return { ok: true, sent: true };
  } catch (e) {
    return { ok: false, reason: "exception", error: String(e?.message || e).slice(0, 200) };
  }
}

async function actionAuthCodeVerify(params) {
  const email = (params?.email || "").toString().toLowerCase().trim().slice(0, 200);
  const code  = (params?.code  || "").toString().trim().slice(0, 10);
  if (!email || !code) return { ok: false, reason: "missing_params" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  try {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    const key = `kl:authcode:${email}`;
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.result) return { ok: false, reason: "code_invalid_or_expired" };

    const parsed = JSON.parse(data.result);
    if (parsed.attempts >= 5) {
      // Burn the code after too many failures
      await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      }).catch(() => {});
      return { ok: false, reason: "too_many_attempts" };
    }
    if (parsed.code !== code) {
      // Increment attempts and re-store with same TTL
      const updated = { ...parsed, attempts: (parsed.attempts || 0) + 1 };
      await fetch(`${UPSTASH_URL}/setex/${encodeURIComponent(key)}/600/${encodeURIComponent(JSON.stringify(updated))}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      }).catch(() => {});
      return { ok: false, reason: "wrong_code" };
    }

    // Code matches. Find or create install for this email.
    const emailKey = `kl:email:${email}`;
    let installId = "";
    const lookup = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(emailKey)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const lookupData = await lookup.json().catch(() => ({}));
    if (lookupData?.result) {
      installId = String(lookupData.result);
    } else {
      // Mint a new installId — random 24-char alphanumeric
      installId = "kl_" + Array.from(crypto.getRandomValues(new Uint8Array(12)))
        .map(b => b.toString(16).padStart(2, "0")).join("");
      // Bind email → installId
      await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(emailKey)}/${encodeURIComponent(installId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      }).catch(() => {});
    }

    // Ensure user record exists
    const userKey = `kl:user:${installId}`;
    await fetch(`${UPSTASH_URL}/hset/${encodeURIComponent(userKey)}/email/${encodeURIComponent(email)}/verifiedAt/${Date.now()}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    }).catch(() => {});

    // Burn the code (one-shot)
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    }).catch(() => {});

    return {
      ok: true,
      installId,
      email,
      user: { email, installId, plan: "trial", createdAt: Date.now() },
    };
  } catch (e) {
    return { ok: false, reason: "exception", error: String(e?.message || e).slice(0, 200) };
  }
}

// ═══════════════════════════════════════════════════════════════════
// REFERRAL SYSTEM
//
// Each Klosr install gets a referral code (first 8 chars of installId
// hashed). Visiting /r/{code} redirects to /install with attribution.
// Backend tracks: referrer installId → referee installId, plus signup
// counts. Pro upgrades from referrals credit the referrer with a free
// month (TODO: tie into Stripe coupon application).
// ═══════════════════════════════════════════════════════════════════

async function actionReferralTrack(params) {
  const referralCode = (params?.code || "").toString().slice(0, 32);
  const newInstallId = (params?.newInstallId || "").toString().slice(0, 120);
  if (!referralCode || !newInstallId) return { ok: false, reason: "missing_params" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  try {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

    // Look up the referrer by code
    const codeKey = `kl:ref:code:${referralCode}`;
    const codeRes = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(codeKey)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const codeData = await codeRes.json().catch(() => ({}));
    if (!codeData?.result) return { ok: false, reason: "invalid_code" };
    const referrerInstallId = codeData.result;

    // Don't credit self-referrals
    if (referrerInstallId === newInstallId) return { ok: false, reason: "self_referral" };

    // Add to referrer's referee set
    const refereesKey = `kl:ref:referees:${referrerInstallId}`;
    await fetch(`${UPSTASH_URL}/sadd/${encodeURIComponent(refereesKey)}/${encodeURIComponent(newInstallId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    }).catch(() => {});

    // Set referee → referrer reverse map
    const referrerKey = `kl:ref:referrer:${newInstallId}`;
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(referrerKey)}/${encodeURIComponent(referrerInstallId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    }).catch(() => {});

    return { ok: true, referrerInstallId };
  } catch (e) {
    return { ok: false, reason: "exception" };
  }
}

async function actionReferralStats(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  if (!installId) return { ok: false, reason: "missing_install_id" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  try {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

    // Generate user's referral code if not exists
    let codeRes = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(`kl:ref:user:${installId}`)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    let codeData = await codeRes.json().catch(() => ({}));
    let code = codeData?.result;

    if (!code) {
      // Derive from installId (first 8 chars, alphanumeric only)
      code = installId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase();
      // Save both directions
      await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(`kl:ref:user:${installId}`)}/${encodeURIComponent(code)}`, {
        method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(`kl:ref:code:${code}`)}/${encodeURIComponent(installId)}`, {
        method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
    }

    // Count referees
    const refereesRes = await fetch(`${UPSTASH_URL}/scard/${encodeURIComponent(`kl:ref:referees:${installId}`)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const refereesData = await refereesRes.json().catch(() => ({}));
    const refereeCount = Number(refereesData?.result) || 0;

    return {
      ok: true,
      code,
      shareUrl: `https://backend-kappa-nine-57.vercel.app/r/${code}`,
      referees: refereeCount,
    };
  } catch (e) {
    return { ok: false, reason: "exception" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// KLOSR TEAMS — multi-seat workspace
//
// Data model:
//   kl:team:{teamId}           hash  { name, ownerInstallId, plan, createdAt }
//   kl:team:{teamId}:members   set   member installIds
//   kl:team:{teamId}:state     json  shared { proofLibrary, objectionPlaybook,
//                                              voiceExamples, icpLearnings }
//   kl:team:{teamId}:invites   set   pending invite emails / codes
//   kl:user:{installId}:team   string  → teamId (back-reference)
//
// Plan structure:
//   - Solo founders use Pro tier (no team).
//   - Teams (3-10 sellers) start a workspace. Owner pays $99/seat/mo
//     (Stripe scaffold extends to support quantities).
//   - Members onboard with their Install ID + invite code → join the
//     team's shared playbook + proof library.
//   - When a Team member generates a brief / draft / dossier, Klosr
//     uses the TEAM's proof library + voice examples instead of the
//     individual's. This is what makes "founder hands ICP off to first
//     AE" work — the AE writes in the founder's voice automatically.
//
// v0.1 scope (this scaffold):
//   - Create a team
//   - Invite via email (sends via Resend if configured)
//   - Join via 6-char code
//   - Read team stats (member count, seat count, plan)
//   - Push founder state → team shared state (one-way for v0.1; merge
//     conflicts in v0.2)
// ═══════════════════════════════════════════════════════════════════

function _generateTeamCode() {
  // 6-char alphanumeric, capital letters only (less ambiguous)
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function actionTeamCreate(params) {
  const installId = (params?.installId || "").toString().slice(0, 120);
  const teamName = (params?.teamName || "").toString().slice(0, 80);
  if (!installId || !teamName) return { ok: false, reason: "missing_params" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const teamId = "team_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const inviteCode = _generateTeamCode();

  try {
    // Hash for team metadata
    await fetch(`${UPSTASH_URL}/hset/${encodeURIComponent(`kl:team:${teamId}`)}/name/${encodeURIComponent(teamName)}/ownerInstallId/${encodeURIComponent(installId)}/plan/team/createdAt/${Date.now()}/inviteCode/${inviteCode}`, {
      method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    // Owner is first member
    await fetch(`${UPSTASH_URL}/sadd/${encodeURIComponent(`kl:team:${teamId}:members`)}/${encodeURIComponent(installId)}`, {
      method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    // Reverse lookup: installId → teamId
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(`kl:user:${installId}:team`)}/${encodeURIComponent(teamId)}`, {
      method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    // Invite-code → teamId reverse map
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(`kl:invite:${inviteCode}`)}/${encodeURIComponent(teamId)}`, {
      method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });

    return { ok: true, teamId, inviteCode, teamName };
  } catch (e) {
    console.warn("[team-create]", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

async function actionTeamInvite(params) {
  const installId = (params?.installId || "").toString();
  const teamId = (params?.teamId || "").toString();
  const email = (params?.email || "").toString().toLowerCase().trim();
  if (!installId || !teamId || !email) return { ok: false, reason: "missing_params" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  // TODO: verify the caller is the team owner before allowing invite
  // (skipped for v0.1, low security risk since invite codes are still required)

  // Get the team's invite code
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const teamHashRes = await fetch(`${UPSTASH_URL}/hgetall/${encodeURIComponent(`kl:team:${teamId}`)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const teamData = await teamHashRes.json().catch(() => ({}));
  const raw = Array.isArray(teamData?.result) ? teamData.result : [];
  const teamHash = {};
  for (let i = 0; i < raw.length; i += 2) teamHash[raw[i]] = raw[i + 1];
  if (!teamHash.name) return { ok: false, reason: "team_not_found" };
  const inviteCode = teamHash.inviteCode || "";

  // Send invite email via Resend (if configured)
  const resendKey = process.env.RESEND_API_KEY || "";
  const fromEmail = process.env.AUTH_FROM_EMAIL || "Klosr <hello@klosr.com>";
  if (!resendKey) {
    return { ok: true, code: inviteCode, sent: false, reason: "resend_not_configured" };
  }

  try {
    const html = `
      <div style="font-family: -apple-system, sans-serif; max-width: 540px; margin: 0 auto; padding: 30px 24px; color: #18181B;">
        <h1 style="font-size: 22px; margin: 0 0 12px;">You've been invited to ${teamHash.name} on Klosr</h1>
        <p style="font-size: 14px; line-height: 1.5; color: #3F3F46;">Klosr is the AI sales co-pilot built for B2B founders. ${teamHash.name} has set up a Klosr Team workspace and added you as a seller.</p>
        <p style="margin: 26px 0;">
          <a href="https://backend-kappa-nine-57.vercel.app/install" style="display: inline-block; padding: 14px 24px; background: linear-gradient(135deg, #FFD60A, #F59E0B); color: #0A0A0B; text-decoration: none; font-weight: 800; font-size: 14px; border-radius: 10px;">Install Klosr →</a>
        </p>
        <p style="font-size: 13px; color: #3F3F46;">After installing, open Klosr Desktop → Settings → Join Team → enter this code:</p>
        <div style="font-family: ui-monospace, monospace; font-size: 24px; font-weight: 800; text-align: center; padding: 16px; background: #FFD60A; border-radius: 10px; margin: 18px 0; letter-spacing: 0.1em;">${inviteCode}</div>
        <p style="font-size: 12px; color: #71717A;">If you weren't expecting this, ignore this email.</p>
      </div>
    `;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: `You've been invited to ${teamHash.name} on Klosr`,
        html,
      }),
    });
    if (!r.ok) {
      const errData = await r.json().catch(() => ({}));
      return { ok: false, reason: "email_send_failed", error: String(errData?.message || "unknown").slice(0, 200) };
    }
    return { ok: true, code: inviteCode, sent: true };
  } catch (e) {
    return { ok: false, reason: "exception" };
  }
}

async function actionTeamJoin(params) {
  const installId = (params?.installId || "").toString();
  const code = (params?.code || "").toString().toUpperCase();
  if (!installId || !code) return { ok: false, reason: "missing_params" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Look up team by invite code
  const codeRes = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(`kl:invite:${code}`)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const codeData = await codeRes.json().catch(() => ({}));
  if (!codeData?.result) return { ok: false, reason: "invalid_code" };
  const teamId = codeData.result;

  // Add member
  await fetch(`${UPSTASH_URL}/sadd/${encodeURIComponent(`kl:team:${teamId}:members`)}/${encodeURIComponent(installId)}`, {
    method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  // Reverse lookup
  await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(`kl:user:${installId}:team`)}/${encodeURIComponent(teamId)}`, {
    method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });

  return { ok: true, teamId };
}

async function actionTeamLeave(params) {
  const installId = (params?.installId || "").toString();
  if (!installId) return { ok: false, reason: "missing_params" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  const teamRes = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(`kl:user:${installId}:team`)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const teamData = await teamRes.json().catch(() => ({}));
  const teamId = teamData?.result;
  if (!teamId) return { ok: true, wasInTeam: false };

  await fetch(`${UPSTASH_URL}/srem/${encodeURIComponent(`kl:team:${teamId}:members`)}/${encodeURIComponent(installId)}`, {
    method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(`kl:user:${installId}:team`)}`, {
    method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });

  return { ok: true, wasInTeam: true, teamId };
}

async function actionTeamStats(params) {
  const installId = (params?.installId || "").toString();
  if (!installId) return { ok: false, reason: "missing_params" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured", inTeam: false };

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  const teamRes = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(`kl:user:${installId}:team`)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const teamData = await teamRes.json().catch(() => ({}));
  const teamId = teamData?.result;
  if (!teamId) return { ok: true, inTeam: false };

  // Team metadata
  const hashRes = await fetch(`${UPSTASH_URL}/hgetall/${encodeURIComponent(`kl:team:${teamId}`)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const hashData = await hashRes.json().catch(() => ({}));
  const raw = Array.isArray(hashData?.result) ? hashData.result : [];
  const team = {};
  for (let i = 0; i < raw.length; i += 2) team[raw[i]] = raw[i + 1];

  // Member count
  const memberRes = await fetch(`${UPSTASH_URL}/scard/${encodeURIComponent(`kl:team:${teamId}:members`)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const memberData = await memberRes.json().catch(() => ({}));
  const memberCount = Number(memberData?.result) || 0;

  return {
    ok: true,
    inTeam: true,
    teamId,
    teamName: team.name || "",
    inviteCode: team.inviteCode || "",
    plan: team.plan || "team",
    memberCount,
    isOwner: team.ownerInstallId === installId,
  };
}

async function actionTeamSharedState(params) {
  const installId = (params?.installId || "").toString();
  const state = params?.state || null;          // optional — if provided, write
  if (!installId) return { ok: false, reason: "missing_params" };
  if (!hasUpstash()) return { ok: false, reason: "upstash_not_configured" };

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Resolve teamId from the user
  const teamRes = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(`kl:user:${installId}:team`)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const teamData = await teamRes.json().catch(() => ({}));
  const teamId = teamData?.result;
  if (!teamId) return { ok: false, reason: "not_in_team" };

  const stateKey = `kl:team:${teamId}:state`;

  if (state) {
    // Push founder state → team shared state (one-way for v0.1)
    const clipped = {
      proofLibrary: Array.isArray(state.proofLibrary) ? state.proofLibrary.slice(0, 30) : [],
      objectionPlaybook: Array.isArray(state.objectionPlaybook) ? state.objectionPlaybook.slice(0, 30) : [],
      voiceExamples: Array.isArray(state.voiceExamples) ? state.voiceExamples.slice(0, 12) : [],
      icpLearnings: String(state.icpLearnings || "").slice(0, 1200),
      pushedAt: Date.now(),
      pushedBy: installId,
    };
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(stateKey)}/${encodeURIComponent(JSON.stringify(clipped))}`, {
      method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    return { ok: true, written: true };
  } else {
    // Read shared state
    const readRes = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(stateKey)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await readRes.json().catch(() => ({}));
    if (!data?.result) return { ok: true, sharedState: null };
    return { ok: true, sharedState: JSON.parse(data.result) };
  }
}

// ───── Dispatcher ──────────────────────────────────────────────────

const ACTIONS = {
  "verify-email":       actionVerifyEmail,
  "company-logo":       actionCompanyLogo,
  "credit-balance":     actionCreditBalance,
  "company-details":    actionCompanyDetails,
  "company-funding":    actionCompanyFunding,
  "similar-people":     actionSimilarPeople,
  "company-customers":  actionCompanyCustomers,
  "company-competitors": actionCompanyCompetitors,
  "resolve-domain":     actionResolveDomain,
  "draft-warm-outreach": actionDraftWarmOutreach,
  "score-leads":        actionScoreLeads,
  "apollo-company-enrich": actionApolloCompanyEnrich,
  "apollo-people-search":  actionApolloPeopleSearch,
  "apollo-bulk-enrich":    actionApolloBulkEnrich,
  "realtime-token":        actionRealtimeToken,
  "call-coach":            actionCallCoach,
  "call-summary":          actionCallSummary,
  "full-dossier":          actionFullDossier,
  "log-event":             actionLogEvent,
  "admin-stats":           actionAdminStats,
  "extract-proof-from-win": actionExtractProofFromWin,
  "deal-revival-draft":     actionDealRevivalDraft,
  "multi-thread-suggest":   actionMultiThreadSuggest,
  "screenshot-analyze":     actionScreenshotAnalyze,
  "weekly-brag-post":       actionWeeklyBragPost,
  "hubspot-oauth-url":      actionHubspotOauthUrl,
  "hubspot-oauth-exchange": actionHubspotOauthExchange,
  "hubspot-push-deal":      actionHubspotPushDeal,
  "slack-notify":           actionSlackNotify,
  "pwa-bootstrap":          actionPwaBootstrap,
  "sync-state":             actionSyncState,
  "queue-pending-reply":    actionQueuePendingReply,
  "fetch-pending-reply":    actionFetchPendingReply,
  "pipedrive-save-token":   actionPipedriveSaveToken,
  "pipedrive-push-deal":    actionPipedrivePushDeal,
  "salesforce-oauth-url":   actionSalesforceOauthUrl,
  "salesforce-oauth-exchange": actionSalesforceOauthExchange,
  "salesforce-push-deal":   actionSalesforcePushDeal,
  "stripe-create-checkout": actionStripeCreateCheckout,
  "stripe-subscription-status": actionStripeSubscriptionStatus,
  "auth-magic-link-request": actionMagicLinkRequest,
  "auth-magic-link-verify":  actionMagicLinkVerify,
  "auth-code-send":          actionAuthCodeSend,
  "auth-code-verify":        actionAuthCodeVerify,
  "referral-track":          actionReferralTrack,
  "referral-stats":          actionReferralStats,
  "team-create":             actionTeamCreate,
  "team-invite":             actionTeamInvite,
  "team-join":               actionTeamJoin,
  "team-leave":              actionTeamLeave,
  "team-stats":              actionTeamStats,
  "team-shared-state":       actionTeamSharedState,
};

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const action = body?.action;
    const params = (body && body.params && typeof body.params === "object") ? body.params : {};

    if (!action || !ACTIONS[action]) {
      res.status(400).json({ error: "invalid_action", supported: Object.keys(ACTIONS) });
      return;
    }

    const result = await ACTIONS[action](params);
    res.status(200).json(result);
  } catch (err) {
    console.error("[intel] error:", err);
    res.status(200).json({ error: "exception" });
  }
}
