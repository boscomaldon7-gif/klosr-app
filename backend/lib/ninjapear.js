// Shared NinjaPear client — single source of truth for base URL, auth,
// timeout, and error handling across every /api/* endpoint that hits
// nubela.co's API.
//
// Endpoint inventory covered by callers (as of 2026-04):
//   Company      — /api/v1/company/details, /logo, /funding
//   Customer     — /api/v1/customer/listing
//   Competitor   — /api/v1/competitor/listing
//   Employee     — /api/v1/employee/profile, /similar, /work-email
//   Contact      — /api/v1/contact/disposable-email
//   Meta         — /api/v1/meta/credit-balance
//
// NinjaPear is the successor to Proxycurl (same company, rebranded + new
// API surface in 2025). The legacy /proxycurl/api/v2/* paths are being
// retired — every new endpoint here uses the /api/v1/* shape.

const BASE = "https://nubela.co";
const DEFAULT_TIMEOUT_MS = 15000;

export function getApiKey() {
  return process.env.PROXYCURL_API_KEY
      || process.env.NINJAPEAR_API_KEY
      || "";
}

// One-shot GET against NinjaPear. Returns { ok, status, data, error }.
// `data` is parsed JSON on 200, null otherwise. Never throws — callers
// branch on `ok`.
export async function ninjaGet(path, query = {}, opts = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, status: 0, data: null, error: "not_configured" };
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "boolean") qs.set(k, v ? "true" : "false");
    else qs.set(k, String(v));
  }
  const queryString = qs.toString();
  const url = `${BASE}${path}${queryString ? `?${queryString}` : ""}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, data: null, error: "auth_failed" };
    }
    if (res.status === 402) {
      return { ok: false, status: 402, data: null, error: "credits_exhausted" };
    }
    if (res.status === 404) {
      return { ok: false, status: 404, data: null, error: "not_found" };
    }
    if (res.status === 429) {
      return { ok: false, status: 429, data: null, error: "rate_limited" };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[ninjapear] ${path} non-ok ${res.status}:`, text.slice(0, 200));
      return { ok: false, status: res.status, data: null, error: `upstream_${res.status}` };
    }

    // `/company/logo` returns binary PNG, not JSON — let the caller handle raw.
    if (opts.raw) {
      return { ok: true, status: 200, data: res, error: null };
    }

    const data = await res.json().catch(() => null);
    return { ok: true, status: 200, data, error: null };
  } catch (e) {
    clearTimeout(timer);
    const msg = e && e.name === "AbortError" ? "timeout" : "network_error";
    return { ok: false, status: 0, data: null, error: msg };
  }
}

// Same as ninjaGet but for POST — used when NinjaPear endpoints evolve
// to accept richer bodies. (Currently all endpoints are GET, but keeping
// this in the toolkit so callers don't have to re-invent the auth path.)
export async function ninjaPost(path, body = {}, opts = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, status: 0, data: null, error: "not_configured" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, error: `upstream_${res.status}` };
    }
    const data = await res.json().catch(() => null);
    return { ok: true, status: 200, data, error: null };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null, error: "network_error" };
  }
}

// Strip a website URL down to its registrable domain (apex): foo.com.
// NinjaPear's endpoints take `website` params that can be either a full
// URL or a bare domain. Normalising here so the client can pass whatever
// LinkedIn scraped — "https://stripe.com/", "http://stripe.com", "stripe.com"
// all collapse to "stripe.com".
export function normalizeDomain(website) {
  if (!website || typeof website !== "string") return "";
  let s = website.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split("?")[0].split("#")[0];
  return s;
}
