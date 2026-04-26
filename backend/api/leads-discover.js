// POST /api/leads-discover
// Find leads matching the user's ICP by Google-searching LinkedIn via
// SerpApi. This is Klosr's primary lead-discovery engine: ICP in, a list
// of LinkedIn profiles out.
//
// Why SerpApi and not Proxycurl? Proxycurl's person-search endpoint shut
// down in 2025. Its successor (NinjaPear) currently only offers person
// *enrichment*, not search. The most reliable "find me people matching
// this ICP" primitive left is the SDR-standard Google dork:
// `site:linkedin.com/in/ "VP Revenue" SaaS`. Every result is a public
// LinkedIn profile, and Google's title format
// ("Name - Title - Company | LinkedIn") gives us structured data for free.
//
// Flow:
//   1. Claude Haiku translates the user's prose ICP into 1-2 targeted
//      `site:linkedin.com/in/` Google queries with Boolean role titles.
//   2. We run them via SerpApi (already paid, same key as brief research).
//   3. We parse each organic result title into { name, title, company }
//      using LinkedIn's standard Google meta format.
//   4. Results are normalised into a canonical lead shape the client
//      knows how to render.
//
// Env: SERPAPI_API_KEY, ANTHROPIC_API_KEY.

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { getClient } from "../lib/claude.js";
import { runSerp } from "../lib/serpapi.js";

// Ask Claude Haiku to translate the prose ICP into 1-2 Google queries that
// surface LinkedIn profiles matching the ICP. Haiku is fast + cheap and
// this is pure structured-translation — no tool use needed.
async function icpToGoogleQueries({ icp, icpEmpirical, icpTopPatterns }) {
  const client = getClient();
  const icpBlob = [
    icp ? `Declared ICP: ${icp}` : "",
    icpEmpirical ? `Empirical ICP (learned from wins/losses): ${icpEmpirical}` : "",
    (Array.isArray(icpTopPatterns) && icpTopPatterns.length)
      ? `Patterns: ${icpTopPatterns.slice(0, 5).map(p => String(p)).join(" | ")}`
      : "",
  ].filter(Boolean).join("\n");

  const system = `You translate a founder's ICP into Google search queries that surface matching LinkedIn profiles.

Output format: JSON object with a single key "queries" — an array of 1 to 2 Google search strings.

Each query MUST start with \`site:linkedin.com/in/\` (this forces Google to return individual LinkedIn profiles, not company pages or posts).

Each query MUST contain a Boolean OR expression of 2-4 job titles in quotes, e.g. "VP Revenue" OR "Head of Revenue" OR "Chief Revenue Officer" OR "CRO".

Each query SHOULD contain 1-2 keywords narrowing by industry, stage, or geography — as plain words or quoted phrases. Examples: SaaS, B2B, "Series B", fintech, "United States", London.

Do NOT include: intitle:, inurl:, exclusion operators, date operators, or the word "LinkedIn" (redundant with the site: filter).

Guidance:
- Prefer 2 narrower queries over 1 broad one — Google returns ~10 results per query anyway, and 2 different angles catches more ICP-fit people.
- Role titles should be the ones the ICP person would literally use on LinkedIn, not vague ("Growth Leader" is bad; "VP Growth" OR "Head of Growth" is good).
- For "Series B" / "post-seed" stages, translate to keywords — Series B is a known string on many profiles.
- If the ICP mentions a country, include it in ONE query (not both) as a plain keyword.

Return ONLY the JSON — no prose, no code fence. Example output:
{"queries":["site:linkedin.com/in/ \\"VP Revenue\\" OR \\"Head of Revenue\\" OR \\"CRO\\" SaaS \\"United States\\"","site:linkedin.com/in/ \\"Chief Revenue Officer\\" OR \\"VP Sales\\" B2B \\"Series B\\""]}`;

  const { content } = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 400,
    system,
    messages: [{ role: "user", content: icpBlob || "No ICP provided. Default: B2B SaaS founders and revenue leaders." }],
  });

  const text = (Array.isArray(content) ? content : [])
    .filter(b => b && b.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .join("\n")
    .trim();

  let parsed = null;
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  try { parsed = JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed || !Array.isArray(parsed.queries)) return [];

  // Normalise each query: force the `site:linkedin.com/in/` prefix if Haiku
  // omitted it. Without that filter, Google returns company pages + articles,
  // not individual profiles — so this is non-negotiable.
  const SITE_PREFIX = "site:linkedin.com/in/";
  return parsed.queries
    .map(q => String(q || "").trim())
    .filter(q => q.length > 0)
    .map(q => {
      const lower = q.toLowerCase();
      if (lower.includes("site:linkedin.com/in")) return q;
      // Strip any bare `linkedin.com` mentions and prepend the site: filter.
      const cleaned = q.replace(/linkedin\.com\S*/gi, "").trim();
      return `${SITE_PREFIX} ${cleaned}`.trim();
    })
    .slice(0, 2);
}

// Parse a LinkedIn Google search result title into { name, title, company }.
// LinkedIn's canonical Google meta title is:
//   "FirstName LastName - Title - Company | LinkedIn"
// or the older "FirstName LastName – Title at Company | LinkedIn"
// or "FirstName LastName - Title | LinkedIn" (no company).
// We strip the trailing " | LinkedIn", then split on " - " or " – ".
function parseLinkedInTitle(googleTitle) {
  if (!googleTitle || typeof googleTitle !== "string") return null;
  // Strip trailing " | LinkedIn" / " - LinkedIn".
  let t = googleTitle.replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, "").trim();
  if (!t) return null;

  // Split on common LinkedIn separators: " - ", " – " (en dash), " — " (em dash).
  const parts = t.split(/\s+[-–—]\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const name = parts[0];
  // Heuristic filter: names are 2-5 words, each starting with a capital, no
  // weird chars. Reject results where the first segment is clearly not a name
  // (e.g. "Top 10 VP Revenue profiles").
  if (!/^[A-Z][\p{L}'.\-]+(?:\s+[A-Z][\p{L}'.\-]*){0,4}$/u.test(name)) return null;

  let role = parts[1] || "";
  let company = parts[2] || "";

  // Handle "Title at Company" pattern when only one dash separator.
  if (parts.length === 2 && / at /i.test(parts[1])) {
    const [r, c] = parts[1].split(/\s+at\s+/i);
    role = (r || "").trim();
    company = (c || "").trim();
  }

  return {
    name,
    title: role.slice(0, 140),
    company: company.slice(0, 120),
  };
}

// Normalise a SerpApi LinkedIn result into our canonical lead shape.
function serpToLead(r) {
  if (!r || typeof r !== "object") return null;
  const link = String(r.link || "").trim();
  if (!link || !/linkedin\.com\/in\//i.test(link)) return null;

  const parsed = parseLinkedInTitle(r.title);
  if (!parsed || !parsed.name) return null;

  const signalText = parsed.title || parsed.company
    ? `ICP match: ${[parsed.title, parsed.company].filter(Boolean).join(" at ")}`
    : `ICP match — matches your ideal customer profile`;

  return {
    name: parsed.name,
    profileUrl: link,
    company: parsed.company || "",
    title: parsed.title || "",
    signalText: signalText.slice(0, 220),
    signalType: "icp_match",
    signalDate: "",
    signalLink: link,
    score: null,
    source: "proxycurl", // Legacy token — client's 🎯 ICP badge keys on this.
  };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const { founderContext = {}, limit = 15 } = body || {};

    if (!process.env.SERPAPI_API_KEY) {
      res.status(200).json({ leads: [], reason: "serpapi_not_configured" });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(200).json({ leads: [], reason: "anthropic_not_configured" });
      return;
    }

    const icp = (founderContext.icpEmpirical || founderContext.icp || "").trim();
    if (!icp) {
      res.status(200).json({ leads: [], reason: "no_icp_configured" });
      return;
    }

    // 1. Translate ICP → 1-2 site:linkedin.com/in/ Google queries via Haiku.
    let queries = [];
    try {
      queries = await icpToGoogleQueries({
        icp: founderContext.icp,
        icpEmpirical: founderContext.icpEmpirical,
        icpTopPatterns: founderContext.icpTopPatterns,
      });
    } catch (e) {
      console.warn("[leads-discover] ICP translation failed:", e && e.message);
    }
    if (!queries.length) {
      res.status(200).json({ leads: [], reason: "icp_translation_failed" });
      return;
    }

    // 2. Run each query through SerpApi, merge + dedupe by profile URL.
    //    We request 10 per query (Google's default) — 2 queries × 10 = ~20
    //    raw results, easily enough to hit a 15-lead cap after filtering
    //    garbage results (company pages, search pages, non-name titles).
    const seen = new Set();
    const leads = [];
    for (const q of queries) {
      const results = await runSerp(q, { num: 10, hl: "en", gl: "us" });
      for (const r of results) {
        const lead = serpToLead(r);
        if (!lead) continue;
        // Dedupe by LinkedIn profile URL (normalise trailing slash).
        const key = lead.profileUrl.replace(/\/$/, "").toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        leads.push(lead);
      }
    }

    const max = Math.min(Math.max(Number(limit) || 15, 1), 50);
    const out = leads.slice(0, max);

    res.status(200).json({
      leads: out,
      queries,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[leads-discover] error:", err && err.message ? err.message : err);
    res.status(200).json({ leads: [], reason: "exception" });
  }
}
