// POST /api/import-from-memory
// Takes a blob of raw text (Claude memory export, Notion notes, About me,
// founder bio, anything) and structures it into the company-profile fields.
// Also returns the raw blob back so the client can store it for future
// grounding beyond the 9 structured fields.

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { complete } from "../lib/claude.js";

const IMPORT_SYSTEM = `You parse a founder's pasted memory / notes / bio and extract structured company-profile fields.

Return JSON with these fields (all strings, use "" if not found):
{
  "yourName":    "",
  "yourRole":    "",
  "companyName": "",
  "whatYouSell": "1-2 sentence pitch",
  "icp":         "Who they sell to",
  "valueProp":   "Key differentiator",
  "objections":  "Common objections they hear (bullet-ish comma list)",
  "proofPoints": "Metrics, logos, case studies",
  "background":  "Personal credibility / trajectory",
  "tone":        "How they communicate"
}

Rules:
- Extract, don't invent. Empty is better than hallucinated.
- Preserve the founder's exact wording for whatYouSell and valueProp when possible.
- If the memory mentions specific customer logos or metrics, put those in proofPoints verbatim.
- No em dashes in output.

Return ONLY the JSON object, no preamble, no code fence.`;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const { memoryText } = body || {};

    if (!memoryText || typeof memoryText !== "string" || memoryText.trim().length < 20) {
      res.status(400).json({ error: "memory_too_short" });
      return;
    }

    const trimmed = memoryText.slice(0, 18000);

    const { text } = await complete({
      system: IMPORT_SYSTEM,
      messages: [{ role: "user", content: trimmed }],
      maxTokens: 1400,
    });

    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }

    if (!parsed || typeof parsed !== "object") {
      res.status(502).json({ error: "bad_import_format", raw: cleaned.slice(0, 500) });
      return;
    }

    const pickStr = (v) => (typeof v === "string" ? v.trim() : "");
    res.status(200).json({
      yourName:    pickStr(parsed.yourName),
      yourRole:    pickStr(parsed.yourRole),
      companyName: pickStr(parsed.companyName),
      whatYouSell: pickStr(parsed.whatYouSell),
      icp:         pickStr(parsed.icp),
      valueProp:   pickStr(parsed.valueProp),
      objections:  pickStr(parsed.objections),
      proofPoints: pickStr(parsed.proofPoints),
      background:  pickStr(parsed.background),
      tone:        pickStr(parsed.tone),
      // Always echo the raw blob back — the client stores it so every brief
      // / email / chat call can inject the full context beyond the 9 fields.
      claudeMemoryRaw: trimmed,
    });
  } catch (err) {
    console.error("[import-from-memory] error:", err);
    res.status(500).json({ error: "import_failed", message: String(err.message || err) });
  }
}
