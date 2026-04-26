// Klosr Messaging Watcher — runs on linkedin.com/messaging*
//
// Purpose: when a pipeline contact replies to a Klosr-sent DM, surface it
// as a Chrome notification IMMEDIATELY so the founder can respond while
// the interest is hot. Without this, founders discover replies hours/days
// later, by which point the prospect has moved on.
//
// Design:
//   1. Poll the inbox DOM every 10s for unread conversations
//   2. For each unread, extract sender name + profile URL
//   3. Match against the user's pipeline (chrome.storage: prepcall_history)
//   4. For matches we haven't alerted on recently, fire chrome.notifications
//   5. Click the notification → opens the conversation + triggers Klosr's
//      handle-reply flow (future: auto-populate the sidebar)
//
// Why no background service worker polling? MV3 service workers can't
// scrape DOM. This script runs while the user has messaging open, which
// is exactly when they care about seeing replies.

(function () {
  "use strict";

  // Only run on LinkedIn messaging
  const host = location.hostname || "";
  if (!host.includes("linkedin.com")) return;
  if (!location.pathname.startsWith("/messaging")) return;

  // ───── Config ─────────────────────────────────────────────────
  const POLL_INTERVAL_MS = 10000;      // 10s — balances freshness vs. DOM cost
  const ALERT_COOLDOWN_MS = 30 * 60 * 1000;  // 30 min per-conversation dedupe
  const MAX_ALERTS_PER_POLL = 3;       // don't spam the notification tray

  // ───── State ──────────────────────────────────────────────────
  let _lastPollAt = 0;
  let _alertedRecently = {};   // { conversationKey: lastAlertTs }

  // ───── Storage helpers ────────────────────────────────────────
  const _get = (k) => new Promise((r) => {
    try {
      if (!chrome?.storage?.local) return r(undefined);
      chrome.storage.local.get(k, (d) => r(d ? d[k] : undefined));
    } catch { r(undefined); }
  });
  const _set = (obj) => new Promise((r) => {
    try { chrome.storage.local.set(obj, () => r()); } catch { r(); }
  });

  // Normalize a LinkedIn profile URL for stable matching across query
  // strings / trailing slashes / casing.
  const normalizeLiUrl = (u) => String(u || "").toLowerCase().split("?")[0].split("#")[0].replace(/\/+$/, "");

  // ───── Pipeline lookup ────────────────────────────────────────
  async function loadPipelineContacts() {
    const history = (await _get("prepcall_history")) || [];
    const byUrl = new Map();
    const byName = new Map();
    for (const deal of history) {
      if (!deal) continue;
      const url = normalizeLiUrl(deal.profileUrl);
      if (url) byUrl.set(url, deal);
      const name = (deal.name || "").trim().toLowerCase();
      if (name) byName.set(name, deal);
    }
    return { byUrl, byName };
  }

  // ───── DOM scraping ──────────────────────────────────────────
  // LinkedIn messaging structure (as of 2026):
  //   .msg-conversations-container__conversations-list
  //     > ul > li.msg-conversation-listitem
  //         .msg-conversation-listitem__link (href to /messaging/thread/{id})
  //         .msg-conversation-listitem__participant-names span
  //         .msg-conversation-card__message-snippet (preview text)
  //         unread indicator: .msg-conversation-card__unread-count OR
  //           presence of aria-label containing "unread"
  function scanUnreadConversations() {
    const out = [];
    const listItems = document.querySelectorAll(
      "li.msg-conversation-listitem, .msg-conversations-container__conversations-list li"
    );
    for (const li of listItems) {
      // Unread detection — several LinkedIn variants coexist.
      const hasUnreadCount = !!li.querySelector(".msg-conversation-card__unread-count, .notification-badge");
      const hasUnreadAria = !!li.querySelector('[aria-label*="unread" i], [aria-label*="no leído" i], [aria-label*="nicht gelesen" i]');
      const hasUnreadClass = li.classList.contains("msg-conversation-listitem--unread") ||
                             !!li.querySelector(".msg-conversation-listitem--unread");
      if (!hasUnreadCount && !hasUnreadAria && !hasUnreadClass) continue;

      const link = li.querySelector('a[href*="/messaging/thread/"], a.msg-conversation-listitem__link');
      const threadHref = link?.getAttribute("href") || "";
      const threadId = (threadHref.match(/\/messaging\/thread\/([^/?]+)/) || [])[1] || threadHref;

      const nameEl = li.querySelector(
        ".msg-conversation-listitem__participant-names span, .msg-conversation-card__participant-names span, .msg-conversation-listitem__participant-names, h3"
      );
      const name = (nameEl?.textContent || "").trim();

      const snippetEl = li.querySelector(
        ".msg-conversation-card__message-snippet, .msg-conversation-listitem__message-snippet, .msg-conversation-card__message-snippet-body"
      );
      const snippet = (snippetEl?.textContent || "").trim().slice(0, 240);

      if (!name && !threadId) continue;
      out.push({
        threadId: threadId || name,
        name,
        snippet,
        href: threadHref,
      });
    }
    return out;
  }

  // ───── Match + notify ────────────────────────────────────────
  async function pollAndNotify() {
    if (Date.now() - _lastPollAt < POLL_INTERVAL_MS - 500) return;
    _lastPollAt = Date.now();

    const unread = scanUnreadConversations();
    if (unread.length === 0) return;

    const { byName } = await loadPipelineContacts();

    // Hydrate dedupe state from storage (persists across tab reloads)
    if (!_alertedRecently || Object.keys(_alertedRecently).length === 0) {
      _alertedRecently = (await _get("klosr_msg_alerts_seen")) || {};
      // Clean entries older than the cooldown window
      const cutoff = Date.now() - ALERT_COOLDOWN_MS;
      for (const k of Object.keys(_alertedRecently)) {
        if ((_alertedRecently[k] || 0) < cutoff) delete _alertedRecently[k];
      }
    }

    let firedThisPoll = 0;
    for (const conv of unread) {
      if (firedThisPoll >= MAX_ALERTS_PER_POLL) break;
      const key = `thread:${conv.threadId}`;
      const lastAlerted = _alertedRecently[key] || 0;
      if (Date.now() - lastAlerted < ALERT_COOLDOWN_MS) continue;

      // Match by name against pipeline. Exact-name match is sufficient —
      // LinkedIn shows the full name as it appears on their profile.
      const nameKey = conv.name.trim().toLowerCase();
      const deal = byName.get(nameKey);
      if (!deal) continue;   // Not a pipeline contact — ignore

      // Fire the notification via background worker (notification API can
      // only run in extension contexts). Message format: ask background
      // to create a notification with action to focus this tab.
      chrome.runtime.sendMessage({
        action: "klosr_hot_reply",
        payload: {
          name: conv.name,
          snippet: conv.snippet,
          threadHref: conv.href || "",
          dealStage: deal.dealStage || deal.stage || "",
          profileUrl: deal.profileUrl || "",
        },
      }, () => {/* response unused */});

      _alertedRecently[key] = Date.now();
      firedThisPoll++;

      // Optional in-page toast for visibility when user is already on
      // messaging.
      showInPageToast(conv);
    }

    if (firedThisPoll > 0) {
      await _set({ klosr_msg_alerts_seen: _alertedRecently });
    }
  }

  // Small in-page toast — LinkedIn is already full of stuff, but a brief
  // Klosr-branded nudge helps when the user is already on messaging and
  // the Chrome notification would be redundant.
  function showInPageToast(conv) {
    try {
      const existing = document.getElementById("klosr-msg-toast");
      if (existing) existing.remove();
      const toast = document.createElement("div");
      toast.id = "klosr-msg-toast";
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: linear-gradient(160deg, #18181B, #27272A);
        border: 1px solid rgba(255, 214, 10, 0.55);
        border-radius: 12px;
        padding: 12px 14px;
        color: #F4F4F5;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        max-width: 340px;
        z-index: 2147483647;
        box-shadow: 0 16px 32px -12px rgba(0,0,0,0.55);
        animation: klosr-toast-in 0.2s ease;
      `;
      toast.innerHTML = `
        <div style="font-weight:800;color:#FFD60A;margin-bottom:4px;font-size:12px">🔥 KLOSR · HOT REPLY</div>
        <div style="font-weight:700;margin-bottom:2px">${escapeHtml(conv.name)}</div>
        <div style="color:rgba(244,244,245,0.75);font-size:11.5px;line-height:1.4">${escapeHtml(conv.snippet.slice(0, 160))}</div>
      `;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 6000);
    } catch {/* silent */}
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ───── Boot ──────────────────────────────────────────────────
  function boot() {
    // Immediate first scan (skip the 10s wait so user sees hot replies
    // as soon as they open messaging).
    setTimeout(pollAndNotify, 1500);
    setInterval(pollAndNotify, POLL_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
