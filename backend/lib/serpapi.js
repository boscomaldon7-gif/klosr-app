// SerpApi wrapper — replaces Claude's native web_search tool across every
// endpoint. One Google search per prospect at brief-generation time gives
// the model grounded, dated, cite-able results without the Claude-side
// tool-use roundtrips that cost latency + tokens.
//
// Single source of truth: every caller runs searches through runSerp() so
// we can swap engines / tune defaults in one place.

const SERPAPI_BASE = "https://serpapi.com/search.json";
const DEFAULT_NUM = 10;
const DEFAULT_TIMEOUT_MS = 7000;

function pickKey() {
  return process.env.SERPAPI_API_KEY || "";
}

// Run a single Google search via SerpApi. Returns a compact array of
// { title, snippet, link, date, source } — never throws; returns [] on
// any failure so callers can treat missing search data as "no signal."
export async function runSerp(query, opts = {}) {
  const apiKey = pickKey();
  if (!apiKey || !query) return [];

  const params = new URLSearchParams({
    engine: opts.engine || "google",
    q: query,
    api_key: apiKey,
    num: String(opts.num || DEFAULT_NUM),
    hl: opts.hl || "en",
    gl: opts.gl || "us",
    // Cache on SerpApi's side so a repeat query for the same prospect within
    // a few hours is free (they dedupe on {query, engine, params}).
    no_cache: "false",
  });
  if (opts.tbs) params.set("tbs", opts.tbs);         // e.g. "qdr:m" = past month
  if (opts.location) params.set("location", opts.location);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${SERPAPI_BASE}?${params.toString()}`, {
      method: "GET",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn("[serpapi] non-ok", res.status, "query:", query);
      return [];
    }
    const data = await res.json().catch(() => ({}));
    const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
    const news = Array.isArray(data.news_results) ? data.news_results : [];

    // Merge + normalize to a compact shape the prompt can parse cheaply.
    const out = [];
    for (const r of news) {
      out.push({
        title: String(r.title || "").slice(0, 200),
        snippet: String(r.snippet || r.description || "").slice(0, 360),
        link: String(r.link || "").slice(0, 400),
        date: String(r.date || r.published_date || "").slice(0, 40),
        source: String(r.source || "Web").slice(0, 60),
      });
    }
    for (const r of organic) {
      out.push({
        title: String(r.title || "").slice(0, 200),
        snippet: String(r.snippet || r.description || "").slice(0, 360),
        link: String(r.link || "").slice(0, 400),
        date: String(r.date || r.published_date || "").slice(0, 40),
        source: String(r.displayed_link || "Web").slice(0, 60),
      });
    }
    // Dedupe by link, keep first-seen order (news first = freshest).
    const seen = new Set();
    const deduped = [];
    for (const r of out) {
      if (!r.link || seen.has(r.link)) continue;
      seen.add(r.link);
      deduped.push(r);
    }
    return deduped.slice(0, Math.max(1, opts.num || DEFAULT_NUM));
  } catch (e) {
    clearTimeout(timer);
    return [];
  }
}

// Person-focused search — grabs recent news + mentions for a specific person
// at a specific company. The first query gets recent signals; the second
// catches older career context if the first is thin.
export async function searchPerson({ name, company, headline, maxResults = 8 }) {
  if (!name) return [];
  const key = pickKey();
  if (!key) return [];

  const queries = [];
  if (company) queries.push(`"${name}" "${company}"`);
  queries.push(`"${name}" ${headline || ""}`.trim());

  const out = [];
  const seen = new Set();
  for (const q of queries) {
    // Past month first for freshness, then broader.
    const fresh = await runSerp(q, { num: 6, tbs: "qdr:m" });
    for (const r of fresh) {
      if (!seen.has(r.link)) { seen.add(r.link); out.push(r); }
    }
    if (out.length >= maxResults) break;
  }
  if (out.length < maxResults && company) {
    const broad = await runSerp(`"${name}" "${company}"`, { num: 6 });
    for (const r of broad) {
      if (!seen.has(r.link)) { seen.add(r.link); out.push(r); }
    }
  }
  return out.slice(0, maxResults);
}

// Company-focused search — recent news about the prospect's employer.
export async function searchCompany({ company, industry, maxResults = 6 }) {
  if (!company) return [];
  const key = pickKey();
  if (!key) return [];

  // Past month news first (what moved the business recently), then broader.
  const fresh = await runSerp(`"${company}" ${industry ? industry : "news"}`, { num: 6, tbs: "qdr:m" });
  const out = [];
  const seen = new Set();
  for (const r of fresh) {
    if (!seen.has(r.link)) { seen.add(r.link); out.push(r); }
  }
  if (out.length < maxResults) {
    const broad = await runSerp(`"${company}" funding OR hiring OR launch`, { num: 6 });
    for (const r of broad) {
      if (!seen.has(r.link)) { seen.add(r.link); out.push(r); }
    }
  }
  return out.slice(0, maxResults);
}

// Format SerpApi results into a prompt-friendly block. Hard caps per-result
// size + total block bytes so a chatty SERP doesn't dominate the token
// budget on briefs / chat / sequence calls.
export function formatSerpResults(results, heading = "LIVE WEB RESULTS") {
  if (!Array.isArray(results) || results.length === 0) return "";
  // Top 6 results per block max (down from unlimited). Snippet 200 chars
  // (was 360). Title 120 (was 200). Link 120 (was 400). Keeps a block
  // under ~1.5KB with 6 results; with two blocks (person + company) we
  // stay under 3KB total of web-results context.
  const take = results.slice(0, 6);
  const lines = [`${heading} (cite with (Web search, [source/date])):`];
  take.forEach((r, i) => {
    const title = String(r.title || "(untitled)").slice(0, 120);
    const date = r.date ? ` [${String(r.date).slice(0, 30)}]` : "";
    const source = r.source ? ` · ${String(r.source).slice(0, 40)}` : "";
    const parts = [`  ${i + 1}. ${title}${date}${source}`];
    if (r.snippet) parts.push(`     ${String(r.snippet).slice(0, 200)}`);
    if (r.link) parts.push(`     ${String(r.link).slice(0, 120)}`);
    lines.push(parts.join("\n"));
  });
  // Total-block ceiling — 2.5KB max per heading.
  const out = lines.join("\n");
  return out.length > 2500 ? out.slice(0, 2440) + "\n... [truncated]" : out;
}
