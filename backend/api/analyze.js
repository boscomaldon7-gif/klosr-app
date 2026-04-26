// POST /api/analyze
// Generates a sales prep brief for a LinkedIn prospect.
// Uses Claude + live SerpApi web search so every brief has fresh signals.
//
// Klosr v4 is deal-closer-focused: no more interview/pitch modes. Sales-only.

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { complete } from "../lib/claude.js";
import { searchPerson, searchCompany, formatSerpResults } from "../lib/serpapi.js";
import {
  buildFounderContext,
  buildProfileBlock,
  salesBriefSystemPrompt,
} from "../lib/prompts.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJsonBody(req);
    const {
      profile,
      mode = "sales",                // kept for legacy client payloads; only "sales" is honored
      language = "en",
      callMode = "COLD",
      companyProfile = null,
      claudeMemoryRaw = "",
      voiceExamples = [],
      icpLearnings = "",
      objectionPlaybook = [],
      proofLibrary = [],
      relevantCallNotes = [],
      ninjaPearData = null,
      // NEW in v4.2: deal context — when the prospect is already in the
      // user's pipeline, we pass past commitments + objections + stage so
      // the brief compounds on what Klosr already knows. This is the moat.
      dealContext = null,
    } = body || {};

    if (!profile || typeof profile !== "object") {
      res.status(400).json({ error: "missing_profile" });
      return;
    }

    const founderCtx = buildFounderContext({
      companyProfile, claudeMemoryRaw, voiceExamples, icpLearnings,
      objectionPlaybook, proofLibrary, relevantCallNotes, ninjaPearData,
    });

    const profileBlock = buildProfileBlock(profile, ninjaPearData);

    // Live web search — person + company in parallel, bounded timeouts.
    const personQuery = { name: profile.name || "", company: profile.currentCompany || "", headline: profile.headline || "" };
    const companyQuery = { company: profile.currentCompany || "", industry: (ninjaPearData && ninjaPearData.company && ninjaPearData.company.industry) || "" };
    const [personResults, companyResults] = await Promise.all([
      searchPerson(personQuery).catch(() => []),
      searchCompany(companyQuery).catch(() => []),
    ]);
    const webBlock = [
      formatSerpResults(personResults, "LIVE WEB RESULTS — PERSON"),
      formatSerpResults(companyResults, "LIVE WEB RESULTS — COMPANY"),
    ].filter(Boolean).join("\n\n");

    // Deal history block — only when this prospect is in-pipeline. Surfaces
    // captured commitments, objections, buying signals, stage transitions
    // so the brief is "what you know + what to do next" instead of restart.
    let dealBlock = "";
    if (dealContext && typeof dealContext === "object") {
      const parts = ["DEAL HISTORY (already-captured context from past interactions):"];
      if (dealContext.stage) parts.push(`- Current stage: ${dealContext.stage}`);
      if (dealContext.callsHad) parts.push(`- ${dealContext.callsHad} calls, ${dealContext.emailsSent || 0} emails sent`);
      if (Array.isArray(dealContext.commitments) && dealContext.commitments.length) {
        parts.push(`- Open commitments: ${dealContext.commitments.slice(0, 5).map(c => `"${String(c.text || "").slice(0, 100)}"`).join(" | ")}`);
      }
      if (Array.isArray(dealContext.objections) && dealContext.objections.length) {
        parts.push(`- Objections already raised: ${dealContext.objections.slice(0, 5).map(o => `"${String(o.text || "").slice(0, 80)}"`).join(" | ")}`);
      }
      if (Array.isArray(dealContext.buyingSignals) && dealContext.buyingSignals.length) {
        parts.push(`- Buying signals captured: ${dealContext.buyingSignals.slice(0, 5).map(b => `"${String(b.text || "").slice(0, 100)}"`).join(" | ")}`);
      }
      if (dealContext.lastActivityNote) parts.push(`- Last note: ${String(dealContext.lastActivityNote).slice(0, 200)}`);
      dealBlock = parts.join("\n");
    }

    // Only sales mode is live in v4; legacy interview/pitch payloads fall
    // through to sales too (the call-mode param still adapts the opener).
    const systemPrompt = salesBriefSystemPrompt({ callMode, language });

    // Founder context rides above the profile so the model treats founder
    // facts as axiomatic and prospect facts as the thing being analysed.
    // Deal history lands between them so the model sees what's ALREADY been
    // said/committed before it generates anything new.
    let userMessage = [
      founderCtx ? `FOUNDER CONTEXT:\n${founderCtx}\n\n----` : "",
      dealBlock ? `${dealBlock}\n\n----` : "",
      `PROSPECT PROFILE:\n${profileBlock}`,
      webBlock ? `----\n\n${webBlock}` : "",
      "",
      dealBlock
        ? "Produce the brief NOW. Reference the deal history above — the user has already said things, captured things, and committed to things. Do NOT reset the conversation. Obey every rule in the system prompt."
        : "Produce the brief now. Obey every rule in the system prompt.",
    ].filter(Boolean).join("\n\n");

    // 38KB ceiling — defence against Anthropic rate-limit breach (30k tokens/min).
    const MAX_USER_BYTES = 38000;
    if (userMessage.length > MAX_USER_BYTES) {
      console.warn(`[analyze] userMessage ${userMessage.length}B > cap, truncating`);
      userMessage = userMessage.slice(0, MAX_USER_BYTES - 120) +
        "\n\n[...context truncated to respect token budget. Produce brief from what you have.]";
    }

    const { text: brief } = await complete({
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 1200,
    });

    if (!brief || !brief.trim()) {
      res.status(502).json({ error: "empty_brief" });
      return;
    }

    res.status(200).json({ brief, mode: "sales", callMode });
  } catch (err) {
    console.error("[analyze] error:", err);
    res.status(500).json({ error: "analyze_failed", message: String(err.message || err) });
  }
}
