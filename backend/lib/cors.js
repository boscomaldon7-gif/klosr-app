// CORS + method guard shared by every endpoint. Chrome extensions call these
// routes from LinkedIn/Meet/Zoom pages, so we allow all origins but restrict
// to POST (the actual traffic) + OPTIONS (preflight).

export function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

export function requirePost(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return false;
  }
  return true;
}

// Extract a JSON body regardless of whether Vercel has already parsed it.
// Vercel usually auto-parses JSON for us, but locally / when Content-Type
// is off, body may still arrive as a raw string. This handles both.
export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Edge case: node stream
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}
