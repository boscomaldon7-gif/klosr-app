// POST /api/chat
// Follow-up questions about the current prospect. Used for the chat thread
// below a generated brief and for every "quick-chip" prompt (Objections,
// ICP fit, Why now, opener, connection note, cold DM, etc).

import { applyCors, requirePost, readJsonBody } from "../lib/cors.js";
import { complete } from "../lib/claude.js";
import { searchPerson, formatSerpResults } from "../lib/serpapi.js";
import {
  buildFounderContext,
  buildProfileBlock,
  chatSystemPrompt,
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
      messages = [],
      language = "en",
      claudeMemoryRaw = "",
      objectionPlaybook = [],
      proofLibrary = [],
      relevantCallNotes = [],
      ninjaPearData = null,
    } = body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "missing_messages" });
      return;
    }

    // Build a richer system prompt that carries the founder context +
    // The chat needs DEEP prospect context — user asks specific questions
    // about experience / background / career moves. We give it the "full"
    // profile block (up to 12 roles × 900-char descriptions) and pair it
    // with a LEAN founder context (no voice examples, shorter playbook/proof)
    // so the total stays under the 30k-tokens/min Anthropic rate limit.
    const founderCtx = buildFounderContext({
      companyProfile: null,
      claudeMemoryRaw,
      voiceExamples: [],
      icpLearnings: "",
      objectionPlaybook,
      proofLibrary,
      relevantCallNotes,
      ninjaPearData,
      budget: "lean",
    });

    const profileBlock = profile
      ? buildProfileBlock(profile, ninjaPearData, { detail: "full" })
      : "";

    // Live web search only on the FIRST turn of the thread — no point
    // re-searching on every follow-up, the prospect's week-old news is
    // still week-old news. Cap at 6 results to keep the prompt tight.
    let webBlock = "";
    const isFirstTurn = Array.isArray(messages) && messages.length <= 1;
    if (isFirstTurn && profile && profile.name) {
      try {
        const personResults = await searchPerson({
          name: profile.name,
          company: profile.currentCompany || "",
          headline: profile.headline || "",
          maxResults: 6,
        });
        webBlock = formatSerpResults(personResults, "LIVE WEB RESULTS — PROSPECT");
      } catch (e) {}
    }

    let systemSections = [
      chatSystemPrompt({ language }),
      founderCtx ? `\n\n---\nFOUNDER CONTEXT:\n${founderCtx}` : "",
      profileBlock ? `\n\n---\nPROSPECT PROFILE:\n${profileBlock}` : "",
      webBlock ? `\n\n---\n${webBlock}` : "",
      brief ? `\n\n---\nLATEST GENERATED BRIEF (reference, but the user sees it too):\n${brief.slice(0, 3500)}` : "",
      `\n\n---\nMODE: ${mode}`,
    ].join("");

    // Safety cap on the system prompt — chat threads are the most likely
    // place to accumulate token bloat (every turn replays full history).
    const MAX_SYSTEM = 38000;
    if (systemSections.length > MAX_SYSTEM) {
      systemSections = systemSections.slice(0, MAX_SYSTEM - 120) +
        "\n\n[...context truncated to respect token budget.]";
    }

    // Sanitize incoming messages: only keep user/assistant roles with string content.
    const cleanMessages = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20);

    if (cleanMessages.length === 0) {
      res.status(400).json({ error: "no_valid_messages" });
      return;
    }

    const { text: reply } = await complete({
      system: systemSections,
      messages: cleanMessages,
      maxTokens: 1400,
      // SerpApi supplies live data via webBlock above; no Claude-native tool.
    });

    if (!reply || !reply.trim()) {
      res.status(502).json({ error: "empty_reply" });
      return;
    }

    res.status(200).json({ reply });
  } catch (err) {
    console.error("[chat] error:", err);
    res.status(500).json({ error: "chat_failed", message: String(err.message || err) });
  }
}
