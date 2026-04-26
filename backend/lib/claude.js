// Shared Claude client + helpers. One place to swap models / tune defaults
// across every endpoint.

import Anthropic from "@anthropic-ai/sdk";

let _client = null;
export function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  _client = new Anthropic({ apiKey });
  return _client;
}

export const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-7";

// Extract the final text from Claude's `content` array. The SDK returns
// content blocks that can be `text`, `tool_use`, `tool_result`, etc. — we
// just want the concatenated assistant text.
export function extractText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Thin wrapper so every endpoint calls Claude the same way. Caller controls
// system prompt, messages, max tokens. Web search is opt-in per call.
//
// NOTE: `temperature` is deprecated on claude-opus-4-7 and newer — the API
// rejects the field with a 400. We don't send it; the model's default is
// used, which is fine for this workload (briefs / emails want consistent
// tone, not creative variance).
export async function complete({
  system,
  messages,
  model = DEFAULT_MODEL,
  maxTokens = 2400,
  tools = undefined,
}) {
  const client = getClient();
  const payload = {
    model,
    max_tokens: maxTokens,
    messages,
  };
  if (system) payload.system = system;
  if (tools) payload.tools = tools;
  const res = await client.messages.create(payload);
  return { text: extractText(res), raw: res };
}

// Web search tool definition — drop into `tools` when you want Claude to
// pull live web results (e.g. prospect's recent LinkedIn posts, funding news).
export const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
};
