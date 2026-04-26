// POST /api/autofill-context
// Takes a scraped LinkedIn profile and returns inferred company-context
// fields that LinkedIn doesn't directly expose — ICP, value prop, proof
// points, tone. Used during onboarding to prefill the founder's setup
// form so they don't stare at empty text boxes.

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { complete } from "../lib/claude.js";

const AUTOFILL_SYSTEM = `You infer a founder's sales-prep context from their LinkedIn profile data. You're filling in an onboarding form the founder will review and edit. Your job: fill every field you can ground in REAL profile data. Leave the field empty when the profile genuinely doesn't give you enough signal — an empty field is 10x better than filler.

Return JSON with these fields (each a string, may be empty):
{
  "yourRole":      "Their current professional role / title — pull from the most recent experience or headline. If no experience AND no headline, return empty.",
  "companyName":   "Their current company — pull from the most recent experience. Empty if no experience listed.",
  "whatYouSell":   "1-2 sentences naming SPECIFIC products, services, or categories this company sells. Grounded only. Empty if you can't name specifics.",
  "icp":           "Name a concrete buyer persona: role + company stage/size + industry. Example: 'VP Engineering at Series B fintech, 50-200 employees'. Empty if you can't identify all three from the profile.",
  "valueProp":     "Their actual differentiator in their own words. Quote from About/tagline if possible. Empty if no explicit differentiator is visible.",
  "objections":    "The 2-3 most common objections specifically for THIS company's offer, comma-separated. Empty if you don't know the offer well enough.",
  "proofPoints":   "Actual metrics, logos, case studies, funding rounds, notable employers, degrees visible in the profile. Empty if none visible.",
  "tone":          "How they communicate — formal/casual, technical/business, short/long. Only if profile has enough writing to judge. Empty if not.",
  "background":    "One line of credibility from their ACTUAL history (ex-X, built Y, degree from Z, led team at A). Empty if the profile has no credibility markers."
}

CRITICAL FILLER-BAN LIST — these phrases/patterns MUST NEVER appear in your output. If you're tempted to use any of them, leave the field EMPTY instead:
- "your product" / "your offering" / "your solution" / "what you sell"
- "the pain point your product solves" / "the problem you solve"
- "your ideal customer" / "your target market"
- "feel the pain" / "need what you offer"
- "resonates with" / "aligns with" / "speaks to"
- "people who could benefit from" / "prospects looking for"
- "their organization" / "businesses that"
- ANY phrase that describes the founder's own business in placeholder terms rather than naming specific things

If you have no grounded signal for a field, OUTPUT EMPTY STRING. Do not hedge. Do not describe generically. Do not write "Early-stage B2B founders who..." without a concrete product they'd buy.

Other rules:
- Be specific, not generic. "B2B buyers" is bad. "SMB retail founders, 1-10 employees in the US" is good.
- Match their voice if a long About section exists. Casual About → casual draft.
- No em dashes. No "synergy / leverage / align / resonate / actionable / impactful".
- If an explicit About/tagline exists, reuse their wording.

Return ONLY the JSON object, no preamble, no code fence.`;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const { profile, ninjaPearData } = body || {};

    if (!profile || typeof profile !== "object") {
      res.status(400).json({ error: "missing_profile" });
      return;
    }

    const exp = Array.isArray(profile.experience) ? profile.experience : [];
    const posts = Array.isArray(profile.recentPosts) ? profile.recentPosts : [];
    const profileBlock = [
      `Name: ${profile.name || ""}`,
      `Headline: ${profile.headline || ""}`,
      `Location: ${profile.location || ""}`,
      `About: ${(profile.about || "").slice(0, 1800)}`,
      `Experience: ${exp.slice(0, 6).map(e => `${e.title} at ${e.company} (${e.duration || ""})`).join("; ")}`,
      `Recent Posts: ${posts.slice(0, 5).map(p => String(p).slice(0, 260)).join(" | ")}`,
    ].join("\n");

    // NinjaPear enrichment (Proxycurl) carries hard facts about the founder's
    // company — description, size, HQ, funding, industry. Folded in here so
    // the model can write proof points and value props grounded in reality,
    // not inferred from a headline.
    let enrichmentBlock = "";
    if (ninjaPearData && typeof ninjaPearData === "object" && Object.keys(ninjaPearData).length > 0) {
      const parts = ["\n\nVERIFIED COMPANY + PERSON DATA (use these as ground truth):"];
      if (ninjaPearData.person && typeof ninjaPearData.person === "object") {
        const p = ninjaPearData.person;
        const pParts = [];
        if (p.full_name) pParts.push(`Name: ${p.full_name}`);
        if (p.occupation) pParts.push(`Occupation: ${p.occupation}`);
        if (p.summary) pParts.push(`Summary: ${String(p.summary).slice(0, 600)}`);
        if (Array.isArray(p.experiences) && p.experiences[0]) {
          const e = p.experiences[0];
          if (e.description) pParts.push(`Current role description: ${String(e.description).slice(0, 400)}`);
        }
        if (Array.isArray(p.skills) && p.skills.length) {
          pParts.push(`Top skills: ${p.skills.slice(0, 12).join(", ")}`);
        }
        if (pParts.length) parts.push("PERSON:\n" + pParts.join("\n"));
      }
      if (ninjaPearData.company && typeof ninjaPearData.company === "object") {
        const c = ninjaPearData.company;
        const cParts = [];
        if (c.name) cParts.push(`Name: ${c.name}`);
        if (c.tagline) cParts.push(`Tagline: ${c.tagline}`);
        if (c.description) cParts.push(`Description: ${String(c.description).slice(0, 800)}`);
        if (c.industry) cParts.push(`Industry: ${c.industry}`);
        if (c.company_size_on_linkedin) cParts.push(`Size: ${c.company_size_on_linkedin} employees`);
        if (c.founded_year) cParts.push(`Founded: ${c.founded_year}`);
        if (c.hq && c.hq.city) cParts.push(`HQ: ${[c.hq.city, c.hq.country].filter(Boolean).join(", ")}`);
        if (Array.isArray(c.specialities) && c.specialities.length) {
          cParts.push(`Specialties: ${c.specialities.slice(0, 8).join(", ")}`);
        }
        if (Array.isArray(c.funding_data) && c.funding_data.length) {
          cParts.push(`Funding rounds: ${c.funding_data.map(f => `${f.funding_type || ""}${f.money_raised ? " " + f.money_raised : ""}${f.announced_date ? " (" + String(f.announced_date.year || f.announced_date).slice(0, 4) + ")" : ""}`.trim()).filter(Boolean).join("; ")}`);
        }
        if (cParts.length) parts.push("COMPANY:\n" + cParts.join("\n"));
      }
      enrichmentBlock = parts.join("\n\n");
    }

    const { text } = await complete({
      system: AUTOFILL_SYSTEM,
      messages: [{ role: "user", content: profileBlock + enrichmentBlock }],
      maxTokens: 800,
    });

    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }

    if (!parsed || typeof parsed !== "object") {
      res.status(502).json({ error: "bad_autofill_format", raw: cleaned.slice(0, 500) });
      return;
    }

    // Safety net — scrub any filler phrases that slipped past the prompt.
    // These are the fingerprints of AI template-speak, not real ICPs.
    // A field that contains ANY of these gets blanked (user can re-edit).
    const FILLER_PATTERNS = [
      /your product/i,
      /your offering/i,
      /your solution/i,
      /what you sell/i,
      /pain point your product/i,
      /problem you solve/i,
      /your ideal customer/i,
      /your target market/i,
      /feel the pain/i,
      /need what you offer/i,
      /resonates with/i,
      /aligns with/i,
      /speaks to/i,
      /people who could benefit/i,
      /prospects looking for/i,
      /businesses that would/i,
      /organizations? (?:that|who) (?:need|would|could)/i,
    ];
    const hasFiller = (s) => FILLER_PATTERNS.some(rx => rx.test(s));
    const pickStr = (v) => {
      if (typeof v !== "string") return "";
      const t = v.trim();
      if (!t) return "";
      // Strip value entirely if it looks like filler. Partial strip is worse
      // than empty — empty prompts the user to think; filler looks legit and
      // gets shipped into briefs.
      if (hasFiller(t)) return "";
      return t;
    };

    res.status(200).json({
      yourRole:    pickStr(parsed.yourRole),
      companyName: pickStr(parsed.companyName),
      whatYouSell: pickStr(parsed.whatYouSell),
      icp:         pickStr(parsed.icp),
      valueProp:   pickStr(parsed.valueProp),
      objections:  pickStr(parsed.objections),
      proofPoints: pickStr(parsed.proofPoints),
      tone:        pickStr(parsed.tone),
      background:  pickStr(parsed.background),
    });
  } catch (err) {
    console.error("[autofill-context] error:", err);
    res.status(500).json({ error: "autofill_failed", message: String(err.message || err) });
  }
}
