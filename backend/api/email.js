// POST /api/email
// Drafts a personalised cold / follow-up email based on the prospect profile,
// the latest brief, and the founder's full context (voice, ICP, playbook,
// proof library, call notes, NinjaPear enrichment). Returns JSON:
// { subject, body, emailGuesses[] }

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { complete } from "../lib/claude.js";
import {
  buildFounderContext,
  buildProfileBlock,
  emailSystemPrompt,
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

    // The sender object carries the founder's full context (company profile
    // merged, voice examples, learnings, playbook, proof library, call notes).
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

    const systemPrompt = emailSystemPrompt({ language, mode });

    let userMessage = [
      founderCtx ? `FOUNDER CONTEXT:\n${founderCtx}` : "",
      `PROSPECT PROFILE:\n${profileBlock}`,
      brief ? `RELEVANT BRIEF (just generated, use for grounding):\n${brief.slice(0, 3500)}` : "",
      `\nDraft the email now. Return ONLY the JSON object.`,
    ].filter(Boolean).join("\n\n");

    // Safety cap on assembled message — Anthropic rate limit defence.
    const MAX = 38000;
    if (userMessage.length > MAX) {
      userMessage = userMessage.slice(0, MAX - 120) +
        "\n\n[...context truncated to respect token budget. Draft email from what's above.]";
    }

    const { text } = await complete({
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 1600,
    });

    // The prompt tells Claude to return JSON. Strip any accidental code fence.
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Salvage: try to find the first {...} block.
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
      }
    }

    if (!parsed || typeof parsed.subject !== "string" || typeof parsed.body !== "string") {
      res.status(502).json({ error: "bad_email_format", raw: cleaned.slice(0, 500) });
      return;
    }

    res.status(200).json({
      subject: parsed.subject.trim(),
      body: parsed.body.trim(),
      emailGuesses: Array.isArray(parsed.emailGuesses)
        ? parsed.emailGuesses.map(e => String(e).trim().toLowerCase()).filter(Boolean)
        : [],
    });
  } catch (err) {
    console.error("[email] error:", err);
    res.status(500).json({ error: "email_failed", message: String(err.message || err) });
  }
}
