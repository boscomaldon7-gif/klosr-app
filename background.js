// Klosr — Background Service Worker
//
// Three responsibilities:
//   1. Extension icon click on LinkedIn profile → toggle sidebar
//   2. Extension icon click on Meet/Zoom/Teams call tab → bootstrap Live
//      Assist (tabCapture requires the extension to be explicitly invoked;
//      clicking the toolbar icon is the ONLY way to grant that invocation
//      from a content-script-auto-injected tab).
//   3. Content-script request for a tabCapture streamId — tried first, but
//      will fail with "not invoked" if user hasn't clicked the icon yet.
//      Content script handles that case by prompting the user to click the
//      icon, then awaits the liveStreamIdReady message we fire below.

function isCallPlatform(url) {
  if (!url) return false;
  return url.includes("meet.google.com") ||
         url.includes("zoom.us") ||
         url.includes("teams.microsoft.com") ||
         url.includes("teams.live.com");
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;

  // LinkedIn profile → open/close the sidebar (legacy behavior)
  if (tab.url && tab.url.includes("linkedin.com/in/")) {
    chrome.tabs.sendMessage(tab.id, { action: "toggle_sidebar" });
    return;
  }

  // Meet / Zoom / Teams — the user wants Live Assist. Clicking the icon
  // grants activeTab permission for this tab, which is the ONLY way Chrome
  // MV3 lets us call tabCapture. We do it immediately while the user
  // gesture is still fresh.
  if (isCallPlatform(tab.url)) {
    try {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tab.id },
        (streamId) => {
          if (chrome.runtime.lastError || !streamId) {
            chrome.tabs.sendMessage(tab.id, {
              action: "liveStreamIdError",
              error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no_stream_id",
            });
          } else {
            // Success — send the streamId to the content-script overlay.
            // The overlay should be in "waiting for icon click" state and
            // auto-start the Deepgram flow on receipt.
            chrome.tabs.sendMessage(tab.id, { action: "liveStreamIdReady", streamId });
          }
        }
      );
    } catch (e) {
      chrome.tabs.sendMessage(tab.id, { action: "liveStreamIdError", error: e.message || "exception" });
    }
    return;
  }

  // Any other page — show a brief badge to signal "not a Klosr page"
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#7C3AED" });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, 3000);
});

// Legacy path: content script's direct request for tabCapture streamId.
// Kept for backwards-compat and for the case where the user has already
// invoked the extension on this tab in this session (activeTab is still
// granted from that earlier click). In the common first-run case this
// fails with "Extension has not been invoked..." and the content script
// falls back to the icon-click flow above.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "getTabCaptureStreamId") {
    if (!sender.tab || !sender.tab.id) {
      sendResponse({ error: "no_tab" });
      return true;
    }
    try {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: sender.tab.id },
        (streamId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else if (!streamId) {
            sendResponse({ error: "no_stream_id" });
          } else {
            sendResponse({ streamId });
          }
        }
      );
    } catch (e) {
      sendResponse({ error: e.message || "exception" });
    }
    return true;   // async
  }

  // ─── Cross-app pending-reply notification ─────────────────────
  // web-injector.js (running on WhatsApp Web / Gmail / Slack / Teams)
  // detected a pending reply queued by the PWA. If the user has that
  // tab in the background, notify them so they know to switch over.
  if (msg && msg.action === "klosr_pending_reply_ready" && msg.payload) {
    const p = msg.payload || {};
    const nid = "klosr-pending-reply-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    try {
      chrome.notifications.create(nid, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "📤 Klosr: draft ready for " + (p.name || "your app"),
        message: (p.snippet || "Switch to the tab and click Auto-fill").slice(0, 220),
        contextMessage: "Klosr · reply drafted with Opus 4.7",
        priority: 2,
        requireInteraction: true,
      }, () => {
        try {
          chrome.storage.local.get("klosr_notif_map", (data) => {
            const map = (data && data.klosr_notif_map) || {};
            map[nid] = {
              threadHref: p.targetUrl || "",
              ts: Date.now(),
              tabId: sender.tab ? sender.tab.id : null,
              kind: "pending_reply",
            };
            chrome.storage.local.set({ klosr_notif_map: map });
          });
        } catch {/* silent */}
      });
    } catch (e) { console.warn("[Klosr] pending-reply notif failed:", e && e.message); }
    if (sendResponse) sendResponse({ ok: true });
    return false;
  }

  // ─── Hot-reply notification from messaging-watcher.js ──────────
  // The content script on linkedin.com/messaging* detects a new unread
  // reply from someone in the user's pipeline and asks us to fire a
  // Chrome notification. We do it from the service worker because
  // content scripts can't create chrome.notifications directly.
  if (msg && msg.action === "klosr_hot_reply" && msg.payload) {
    const p = msg.payload || {};
    const nid = "klosr-hot-reply-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    try {
      chrome.notifications.create(nid, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "🔥 " + (p.name || "Prospect") + " replied",
        message: (p.snippet || "New message from a pipeline contact").slice(0, 220),
        contextMessage: p.dealStage ? "Stage: " + String(p.dealStage).toUpperCase() + " — Klosr" : "Klosr",
        priority: 2,
        requireInteraction: true,   // stays until user acts — critical for hot replies
      }, () => {
        // Stash metadata so the click handler knows where to focus.
        try {
          chrome.storage.local.get("klosr_notif_map", (data) => {
            const map = (data && data.klosr_notif_map) || {};
            map[nid] = {
              threadHref: p.threadHref || "",
              profileUrl: p.profileUrl || "",
              name: p.name || "",
              ts: Date.now(),
              tabId: sender.tab ? sender.tab.id : null,
            };
            // Trim old entries (>24h)
            const cutoff = Date.now() - 24 * 3600 * 1000;
            for (const k of Object.keys(map)) {
              if (!map[k] || (map[k].ts || 0) < cutoff) delete map[k];
            }
            chrome.storage.local.set({ klosr_notif_map: map });
          });
        } catch {/* silent */}
      });
    } catch (e) {
      console.warn("[Klosr] notification create failed:", e && e.message);
    }
    if (sendResponse) sendResponse({ ok: true });
    return false;
  }
});

// Notification click handler — when user clicks a hot-reply notification,
// focus the LinkedIn messaging tab (if open) or open a new one pointing
// at the specific conversation thread.
try {
  chrome.notifications.onClicked.addListener((nid) => {
    try {
      chrome.storage.local.get("klosr_notif_map", (data) => {
        const map = (data && data.klosr_notif_map) || {};
        const meta = map[nid];
        if (!meta) return;

        const targetUrl = meta.threadHref
          ? (meta.threadHref.startsWith("http") ? meta.threadHref : "https://www.linkedin.com" + meta.threadHref)
          : "https://www.linkedin.com/messaging/";

        if (meta.tabId) {
          chrome.tabs.get(meta.tabId, (tab) => {
            if (!chrome.runtime.lastError && tab) {
              chrome.tabs.update(tab.id, { active: true, url: targetUrl });
              chrome.windows.update(tab.windowId, { focused: true });
            } else {
              chrome.tabs.create({ url: targetUrl, active: true });
            }
          });
        } else {
          chrome.tabs.create({ url: targetUrl, active: true });
        }
        chrome.notifications.clear(nid);
      });
    } catch (e) {
      console.warn("[Klosr] notification click handler:", e && e.message);
    }
  });
} catch {/* notifications API not available in this context */}
