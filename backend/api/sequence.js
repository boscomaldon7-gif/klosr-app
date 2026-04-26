// POST /api/sequence
// Generates a 4-touch outbound cadence (day 1 email, day 4 LinkedIn DM,
// day 7 email follow-up, day 14 break-up or value drop). Returns JSON
// with all 4 touches in one shot so the client can approve or tweak each
// before queueing.

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { complete } from "../lib/claude.js";
import { searchPerson, formatSerpResults } from "../lib/serpapi.js";
import {
  buildFounderContext,
  buildProfileBlock,
  sequenceSystemPrompt,
} from "../lib/prompts.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const {
      profile,
      mode = "sales",
      brief = "",
      language = "en",
      sender = {},
      ninjaPearData = null,
    } = body || {};

    if (!profile || typeof profile !== "object") {
      res.status(400).json({ error: "missing_profile" });
      return;
    }

    const founderCtx = buildFounderContext({
      companyProfile: {
        yourName: sender.name,
        yourRole: sender.role,
        companyName: sender.company,
        whatYouSell: sender.context,
        valueProp: sender.valueProp,
        icp: sender.icp,
        tone: sender.tone,
        proofPoints: sender.proofPoints,
        background: sender.background,
        calendlyUrl: sender.calendlyUrl,
      },
      claudeMemoryRaw: sender.claudeMemoryRaw || "",
      voiceExamples: sender.voiceExamples || [],
      icpLearnings: sender.icpLearnings || "",
      objectionPlaybook: sender.objectionPlaybook || [],
      proofLibrary: sender.proofLibrary || [],
      relevantCallNotes: sender.relevantCallNotes || [],
      ninjaPearData: ninjaPearData,
    });

    const profileBlock = buildProfileBlock(profile, ninjaPearData);

    // Live web signals for the sequence — if the day-7 or day-14 touch can
    // reference a fresh event, it reads as high-effort.
    let webBlock = "";
    try {
      const personResults = await searchPerson({
        name: profile.name || "",
        company: profile.currentCompany || "",
        headline: profile.headline || "",
        maxResults: 6,
      });
      webBlock = formatSerpResults(personResults, "LIVE WEB RESULTS");
    } catch (e) {}

    const systemPrompt = sequenceSystemPrompt({ language, mode });

    let userMessage = [
      founderCtx ? `FOUNDER CONTEXT:\n${founderCtx}` : "",
      `PROSPECT PROFILE:\n${profileBlock}`,
      webBlock ? webBlock : "",
      brief ? `EXISTING BRIEF (use for hooks across touches):\n${brief.slice(0, 3500)}` : "",
      "",
      "Generate all 4 touches now. Return ONLY the JSON object.",
    ].filter(Boolean).join("\n\n");

    // Safety cap.
    const MAX = 38000;
    if (userMessage.length > MAX) {
      userMessage = userMessage.slice(0, MAX - 120) +
        "\n\n[...context truncated. Generate sequence from what's above.]";
    }

    const { text } = await complete({
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 2200,
    });

    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }

    if (!parsed || !Array.isArray(parsed.touches) || parsed.touches.length === 0) {
      res.status(502).json({ error: "bad_sequence_format", raw: cleaned.slice(0, 500) });
      return;
    }

    // Normalize: enforce expected shape so the client doesn't need to guard.
    const touches = parsed.touches
      .filter(t => t && typeof t === "object")
      .slice(0, 6)
      .map(t => ({
        day: Number.isFinite(t.day) ? t.day : 0,
        channel: typeof t.channel === "string" ? t.channel : "email",
        subject: typeof t.subject === "string" ? t.subject.trim() : "",
        body: typeof t.body === "string" ? t.body.trim() : "",
      }))
      .filter(t => t.body);

    if (touches.length === 0) {
      res.status(502).json({ error: "empty_touches" });
      return;
    }

    res.status(200).json({ touches });
  } catch (err) {
    console.error("[sequence] error:", err);
    res.status(500).json({ error: "sequence_failed", message: String(err.message || err) });
  }
}
