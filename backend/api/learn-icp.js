// POST /api/learn-icp
// Takes the founder's won / lost outcomes (one-sentence answers to "what
// made this close?" / "what killed it?") and distils an empirical ICP that
// describes who actually buys, not who the founder guessed at signup.
// Also returns a single next question to ask after the next outcome so the
// learning loop keeps improving.

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { complete } from "../lib/claude.js";

const LEARN_ICP_SYSTEM = `You're analysing a founder's real won/lost deal outcomes to tell them who their actual ICP is — the pattern of deals that ACTUALLY close — vs who they guessed at signup.

Input: an array of outcomes, each with { stage: "won" | "lost", name, headline, company, notes }. The notes field is a one-sentence answer to "what made it close?" or "what killed it?".

Return JSON:
{
  "icpSummary":    "2-3 sentences describing the real ICP pattern. Concrete: company stage, role, team size, industry if visible. Contrast with the declared ICP if relevant.",
  "topPatterns":   ["3-5 specific patterns the founder can use as filters — e.g. 'Series B fintech with 30-60 engineers', 'VPs who posted about X in last 90 days'"],
  "nextQuestion":  "ONE highest-signal question to ask after the next won/lost outcome — the question that will reveal the most about the pattern."
}

Rules:
- Ground every pattern in at least 2 outcomes. Don't infer from a sample of 1.
- If there are <5 outcomes total, say so in icpSummary and give provisional patterns.
- "topPatterns" are filters the founder could use, not platitudes. "People who care about quality" is not a pattern. "Engineering leaders at Series B fintechs, 30-60 headcount" is.
- "nextQuestion" should be different each time as the sample grows — probe the thing you currently can't distinguish.
- No em dashes. No "synergy/leverage/align".

Return ONLY the JSON object.`;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const { outcomes = [], existingICP = "" } = body || {};

    if (!Array.isArray(outcomes) || outcomes.length === 0) {
      res.status(400).json({ error: "no_outcomes" });
      return;
    }

    // Compress outcomes to the essentials the model needs.
    const compact = outcomes.slice(-60).map(o => ({
      stage: o.stage,
      name: o.name || "",
      headline: (o.headline || "").slice(0, 160),
      company: o.company || "",
      notes: (o.notes || "").slice(0, 280),
    }));

    const userMessage = [
      existingICP ? `DECLARED ICP (what the founder said at signup):\n${existingICP}\n` : "",
      `OUTCOMES (${compact.length} total):\n${JSON.stringify(compact, null, 2)}`,
      "",
      "Analyse the pattern and return the JSON.",
    ].filter(Boolean).join("\n");

    const { text } = await complete({
      system: LEARN_ICP_SYSTEM,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 1200,
    });

    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }

    if (!parsed || typeof parsed !== "object") {
      res.status(502).json({ error: "bad_icp_format", raw: cleaned.slice(0, 500) });
      return;
    }

    res.status(200).json({
      icpSummary:   typeof parsed.icpSummary === "string" ? parsed.icpSummary.trim() : "",
      topPatterns:  Array.isArray(parsed.topPatterns) ? parsed.topPatterns.slice(0, 5).map(p => String(p).trim()).filter(Boolean) : [],
      nextQuestion: typeof parsed.nextQuestion === "string" ? parsed.nextQuestion.trim() : "",
    });
  } catch (err) {
    console.error("[learn-icp] error:", err);
    res.status(500).json({ error: "learn_icp_failed", message: String(err.message || err) });
  }
}
