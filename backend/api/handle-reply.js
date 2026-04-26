// POST /api/handle-reply
// Takes an inbound reply from a prospect + the full founder context and
// returns a classification + drafted response + suggested next step.
//
// Classifications: interested | objection | booking | deferral | not_fit | off_topic
// The drafted reply mirrors the founder's voice and pulls from their
// objection playbook / proof library / call notes when relevant.

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { complete } from "../lib/claude.js";
import {
  buildFounderContext,
  buildProfileBlock,
  handleReplySystemPrompt,
} from "../lib/prompts.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const {
      profile = null,
      replyText = "",
      originalOutreach = "",   // optional — the message the prospect is replying to
      channel = "email",        // "email" | "linkedin_dm"
      language = "en",
      sender = {},
      ninjaPearData = null,
    } = body || {};

    if (!replyText || typeof replyText !== "string" || replyText.trim().length < 2) {
      res.status(400).json({ error: "missing_reply_text" });
      return;
    }

    // Reply handling is a focused task — classify + draft a short response.
    // We ask for the LEAN context variant so we stay well under the 30k
    // input-tokens-per-minute Anthropic rate limit even for power users
    // with large proof libraries and playbooks.
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
      budget: "lean",
    });

    // Build a compact profile block — reply handling doesn't need the full
    // experience dump, just who the prospect is + current role.
    const fullProfile = profile ? buildProfileBlock(profile, ninjaPearData) : "";
    const profileBlock = fullProfile ? fullProfile.slice(0, 2500) : "";

    const systemPrompt = handleReplySystemPrompt({ language });

    const userMessage = [
      founderCtx ? `FOUNDER CONTEXT:\n${founderCtx}` : "",
      profileBlock ? `PROSPECT PROFILE (compact):\n${profileBlock}` : "",
      originalOutreach ? `ORIGINAL OUTREACH (what they're replying to):\n${originalOutreach.slice(0, 1200)}` : "",
      `CHANNEL: ${channel}`,
      `THEIR REPLY:\n${replyText.slice(0, 2500)}`,
      "",
      "Classify + draft the founder's next move. Return ONLY the JSON object.",
    ].filter(Boolean).join("\n\n");

    const { text } = await complete({
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 1400,
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

    if (!parsed || typeof parsed !== "object") {
      res.status(502).json({ error: "bad_reply_format", raw: cleaned.slice(0, 500) });
      return;
    }

    const validClass = new Set(["interested", "objection", "booking", "deferral", "not_fit", "off_topic"]);
    const classification = validClass.has(parsed.classification) ? parsed.classification : "off_topic";
    const validTemp = new Set(["hot", "warm", "cold", "dead"]);
    // Temperature fallback: infer from classification if model didn't supply one.
    const defaultTemp =
      classification === "booking" || classification === "interested" ? "hot"
      : classification === "objection" ? "warm"
      : classification === "deferral" ? "cold"
      : classification === "not_fit" ? "dead"
      : "cold";
    const temperature = validTemp.has(parsed.temperature) ? parsed.temperature : defaultTemp;

    const validUrgency = new Set(["respond_now", "respond_today", "respond_this_week", "no_rush"]);
    const defaultUrgency =
      temperature === "hot" ? "respond_now"
      : temperature === "warm" ? "respond_today"
      : temperature === "cold" ? "respond_this_week"
      : "no_rush";
    const urgency = validUrgency.has(parsed.urgency) ? parsed.urgency : defaultUrgency;

    const suggestedProof = (parsed.suggestedProof && typeof parsed.suggestedProof === "object") ? {
      title: typeof parsed.suggestedProof.title === "string" ? parsed.suggestedProof.title.trim() : "",
      metric: typeof parsed.suggestedProof.metric === "string" ? parsed.suggestedProof.metric.trim() : "",
      body: typeof parsed.suggestedProof.body === "string" ? parsed.suggestedProof.body.trim() : "",
    } : { title: "", metric: "", body: "" };

    res.status(200).json({
      classification,
      confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium",
      temperature,
      temperatureReason: typeof parsed.temperatureReason === "string" ? parsed.temperatureReason.trim() : "",
      urgency,
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      suggestedReply: {
        subject: (parsed.suggestedReply && typeof parsed.suggestedReply.subject === "string")
          ? parsed.suggestedReply.subject.trim() : "",
        body: (parsed.suggestedReply && typeof parsed.suggestedReply.body === "string")
          ? parsed.suggestedReply.body.trim() : "",
      },
      suggestedProof,
      nextStep: typeof parsed.nextStep === "string" ? parsed.nextStep.trim() : "",
    });
  } catch (err) {
    console.error("[handle-reply] error:", err);
    res.status(500).json({ error: "handle_reply_failed", message: String(err.message || err) });
  }
}
