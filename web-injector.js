// Klosr Web Injector — runs on WhatsApp Web + Gmail
//
// Purpose: when the user (usually via the Klosr PWA Watch feature)
// has a drafted reply queued on the server (action: queue-pending-reply),
// this content script picks it up and auto-fills the composer of the
// web app the user is currently on.
//
// Flow:
//   1. User is running PWA Watch. Reply arrives on WhatsApp Web.
//   2. Klosr Vision drafts the response (Opus 4.7 multimodal).
//   3. In PWA, user clicks "📤 Inject into WhatsApp" on the draft card.
//   4. PWA queues the draft server-side (Upstash, 5-min TTL).
//   5. This script (already running on WhatsApp Web) polls every 10s.
//   6. When it sees a queued draft, pops a floating banner offering to
//      auto-fill + focus the Send button. One keystroke to ship.
//
// Privacy: this script only activates when:
//   - User has a klosr_install_id saved in chrome.storage (onboarded)
//   - Pending reply exists for THIS install on the server
//   - It's a one-shot — server deletes the pending reply after consume.

(function () {
  "use strict";

  // Identify which app we're on
  const host = location.hostname || "";
  let TARGET_APP = "";
  if (host.includes("web.whatsapp.com")) TARGET_APP = "whatsapp";
  else if (host.includes("mail.google.com")) TARGET_APP = "gmail";
  else if (host.includes("app.slack.com")) TARGET_APP = "slack";
  else if (host.includes("teams.microsoft.com") || host.includes("teams.live.com")) TARGET_APP = "teams";
  else return;   // Safety — script won't run on unlisted hosts

  const INTEL_URL = "https://backend-kappa-nine-57.vercel.app/api/intel";
  const POLL_INTERVAL_MS = 10000;        // 10s — responsive without being chatty
  const POLL_FAST_MS = 3000;              // 3s after user sends a "Inject" request (rare)

  // ─── Storage helpers ──────────────────────────────────────────
  const _get = (k) => new Promise((r) => {
    try {
      if (!chrome?.storage?.local) return r(undefined);
      chrome.storage.local.get(k, (d) => r(d ? d[k] : undefined));
    } catch { r(undefined); }
  });

  let _installId = null;
  let _lastConsumedDraftId = null;
  let _pollTimer = null;
  let _currentBanner = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function appLabel(app) {
    return ({ whatsapp: "WhatsApp Web", gmail: "Gmail", slack: "Slack", teams: "Microsoft Teams" })[app] || app;
  }

  // ─── Poll for pending replies ─────────────────────────────────
  async function pollPending() {
    if (!_installId) {
      _installId = (await _get("klosr_install_id")) || null;
      if (!_installId) return;   // User hasn't onboarded — quit silently
    }
    try {
      const res = await fetch(INTEL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fetch-pending-reply",
          params: { installId: _installId, consume: false },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok || !data.pending) return;

      const pending = data.pending;

      // Dedupe — don't re-show the same draft if user dismissed it
      if (_lastConsumedDraftId && pending.draftId === _lastConsumedDraftId) return;

      // Target-app filter: if the draft is targeted at a different app,
      // skip. "auto" matches everything.
      if (pending.targetApp && pending.targetApp !== "auto" && pending.targetApp !== TARGET_APP) return;

      // Banner not already shown?
      if (_currentBanner) return;

      // If the user is NOT on this tab right now (tab hidden), fire a
      // Chrome notification so they know to switch over. Notifications
      // can't be fired from content scripts directly — delegate to
      // background.js which owns the notifications API.
      if (document.visibilityState === "hidden") {
        try {
          chrome.runtime.sendMessage({
            action: "klosr_pending_reply_ready",
            payload: {
              name: appLabel(TARGET_APP),
              snippet: (pending.draft || "").slice(0, 180),
              targetUrl: location.href,
              draftId: pending.draftId,
            },
          }, () => {/* ignore response */});
        } catch {/* silent */}
      }

      showInjectBanner(pending);
    } catch (e) {
      console.warn("[Klosr Web Injector] poll failed:", e);
    }
  }

  function showInjectBanner(pending) {
    const banner = document.createElement("div");
    banner.id = "klosr-web-inject-banner";
    banner.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      max-width: 400px;
      padding: 14px 16px;
      background: linear-gradient(160deg, #18181B, #27272A);
      border: 1px solid rgba(255, 214, 10, 0.60);
      border-radius: 14px;
      color: #F4F4F5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 214, 10, 0.10) inset;
      animation: klosr-inject-slide 0.25s ease;
    `;

    // Inject keyframes once
    if (!document.getElementById("klosr-web-inject-styles")) {
      const s = document.createElement("style");
      s.id = "klosr-web-inject-styles";
      s.textContent = `
        @keyframes klosr-inject-slide {
          from { transform: translateY(-8px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes klosr-send-pulse-web {
          0%, 100% { box-shadow: 0 0 0 3px rgba(255, 214, 10, 0.55), 0 0 16px rgba(255, 214, 10, 0.50); }
          50%      { box-shadow: 0 0 0 4px rgba(255, 214, 10, 0.90), 0 0 26px rgba(255, 214, 10, 0.80); }
        }
        .klosr-send-pulse-web {
          animation: klosr-send-pulse-web 1.2s ease-in-out infinite;
          border-radius: 50%;
        }
      `;
      document.head.appendChild(s);
    }

    const appLabelTxt = appLabel(TARGET_APP);
    banner.innerHTML = `
      <div style="display: flex; align-items: flex-start; gap: 10px;">
        <div style="font-size: 22px; line-height: 1;">📤</div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: 12.5px; font-weight: 800; color: #FFD60A; margin-bottom: 4px;">
            Klosr has a draft ready for ${esc(appLabelTxt)}
          </div>
          <div style="font-size: 11.5px; line-height: 1.45; color: rgba(244,244,245,0.80); max-height: 60px; overflow: hidden;">
            ${esc((pending.draft || "").slice(0, 160))}${pending.draft.length > 160 ? "…" : ""}
          </div>
          <div style="display: flex; gap: 6px; margin-top: 10px;">
            <button id="klosr-inj-yes" style="padding: 7px 12px; font-size: 11.5px; font-weight: 700; background: rgba(255,214,10,0.18); border: 1px solid rgba(255,214,10,0.55); color: #FFD60A; border-radius: 7px; cursor: pointer; font-family: inherit;">Auto-fill</button>
            <button id="klosr-inj-copy" style="padding: 7px 10px; font-size: 11.5px; font-weight: 600; background: transparent; border: 1px solid rgba(255,255,255,0.15); color: rgba(244,244,245,0.75); border-radius: 7px; cursor: pointer; font-family: inherit;">Copy</button>
            <button id="klosr-inj-no" style="padding: 7px 10px; font-size: 11.5px; font-weight: 600; background: transparent; border: 1px solid rgba(255,255,255,0.10); color: rgba(244,244,245,0.55); border-radius: 7px; cursor: pointer; font-family: inherit;">✕</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(banner);
    _currentBanner = banner;

    const cleanup = () => {
      if (banner.parentElement) banner.remove();
      if (_currentBanner === banner) _currentBanner = null;
      // Consume server-side so we don't re-show the same draft
      markConsumed(pending.draftId);
    };

    document.getElementById("klosr-inj-no").addEventListener("click", cleanup);
    document.getElementById("klosr-inj-copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(pending.draft).catch(() => {});
      document.getElementById("klosr-inj-copy").textContent = "✓ Copied";
      setTimeout(cleanup, 1500);
    });

    document.getElementById("klosr-inj-yes").addEventListener("click", async () => {
      const yesBtn = document.getElementById("klosr-inj-yes");
      yesBtn.disabled = true;
      yesBtn.textContent = "Filling…";
      const ok = await autofillTargetComposer(pending.draft);
      if (ok) {
        yesBtn.textContent = "✓ Ready — hit Enter";
        setTimeout(cleanup, 3500);
      } else {
        yesBtn.disabled = false;
        yesBtn.textContent = "Retry";
        // Fallback: copy to clipboard so user can paste manually
        await navigator.clipboard.writeText(pending.draft).catch(() => {});
      }
    });
  }

  async function markConsumed(draftId) {
    _lastConsumedDraftId = draftId;
    // Tell server to consume (delete) so no other tab picks it up
    try {
      await fetch(INTEL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fetch-pending-reply",
          params: { installId: _installId, consume: true },
        }),
      });
    } catch {/* silent */}
  }

  // ─── Target-app composer autofill ──────────────────────────────
  async function autofillTargetComposer(text) {
    if (TARGET_APP === "whatsapp") return autofillWhatsApp(text);
    if (TARGET_APP === "gmail") return autofillGmail(text);
    if (TARGET_APP === "slack") return autofillSlack(text);
    if (TARGET_APP === "teams") return autofillTeams(text);
    return false;
  }

  // WhatsApp Web composer — contenteditable div in the footer of the
  // open conversation. Selectors drift; use multiple fallbacks.
  async function autofillWhatsApp(text) {
    try {
      const composer = await waitForSelector(
        // Footer composer — most reliable selector across WhatsApp versions
        'footer div[contenteditable="true"][role="textbox"], '
        + 'footer div[contenteditable="true"][data-tab], '
        + 'div[contenteditable="true"][data-tab="10"], '
        + 'div[contenteditable="true"][aria-label*="message" i]',
        4000
      );
      if (!composer) {
        console.warn("[Klosr] WhatsApp composer not found — is a conversation open?");
        return false;
      }

      composer.focus();
      composer.innerHTML = "";
      let filled = false;
      try { filled = document.execCommand("insertText", false, text); } catch {}
      if (!filled) {
        // Fallback: inject + dispatch input events so React updates
        const p = document.createElement("p");
        p.textContent = text;
        composer.appendChild(p);
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      }

      await new Promise(r => setTimeout(r, 250));
      // Find + highlight the Send button
      const sendBtn = document.querySelector(
        'button[aria-label*="Send" i], '
        + 'button[aria-label*="Enviar" i], '
        + 'span[data-icon="send"], '
        + 'span[data-testid="send"]'
      );
      if (sendBtn) {
        const focusable = sendBtn.closest("button") || sendBtn;
        try { focusable.focus(); } catch {}
        focusable.classList.add("klosr-send-pulse-web");
        setTimeout(() => focusable.classList.remove("klosr-send-pulse-web"), 4500);
      }
      return true;
    } catch (err) {
      console.warn("[Klosr] WhatsApp autofill failed:", err);
      return false;
    }
  }

  // Gmail — two cases:
  //   A) Inside a compose window (new email or reply pane open)
  //   B) Inside a reply-in-thread (conversation view with reply toggled)
  // Both use a div[g_editable="true"] or .Am.Al.editable.
  async function autofillGmail(text) {
    try {
      const composer = await waitForSelector(
        'div[g_editable="true"][contenteditable="true"], '
        + '.Am.Al.editable[contenteditable="true"], '
        + 'div[role="textbox"][contenteditable="true"][g_editable="true"]',
        4000
      );
      if (!composer) {
        console.warn("[Klosr] Gmail composer not found — open a reply or compose first");
        return false;
      }

      composer.focus();
      composer.innerHTML = "";

      // Gmail composer handles plain text cleanly via execCommand
      let filled = false;
      try { filled = document.execCommand("insertText", false, text); } catch {}
      if (!filled) {
        // Fallback: split on newlines → <div>s (Gmail's native format)
        const lines = text.split("\n");
        composer.innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join("");
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }

      await new Promise(r => setTimeout(r, 300));
      // Find + highlight the Send button.
      // Gmail's send button:  div[role="button"] with data-tooltip starting "Send"
      const sendBtn = document.querySelector(
        'div[role="button"][data-tooltip^="Send" i], '
        + 'div[role="button"][aria-label^="Send" i], '
        + 'div[role="button"][data-tooltip^="Enviar" i]'
      );
      if (sendBtn) {
        try { sendBtn.focus(); } catch {}
        sendBtn.classList.add("klosr-send-pulse-web");
        setTimeout(() => sendBtn.classList.remove("klosr-send-pulse-web"), 4500);
      }
      return true;
    } catch (err) {
      console.warn("[Klosr] Gmail autofill failed:", err);
      return false;
    }
  }

  // Slack Web — uses Quill editor with contenteditable. Composer class:
  //   .ql-editor[contenteditable="true"] — stable across Slack versions.
  // Send button: button[data-qa="texty_send_button"] OR aria-label.
  async function autofillSlack(text) {
    try {
      const composer = await waitForSelector(
        '.ql-editor[contenteditable="true"][data-qa="message_input"], '
        + '.ql-editor[contenteditable="true"]',
        4000
      );
      if (!composer) {
        console.warn("[Klosr] Slack composer not found — open a channel or DM first");
        return false;
      }

      composer.focus();
      composer.innerHTML = "";

      let filled = false;
      try { filled = document.execCommand("insertText", false, text); } catch {}
      if (!filled) {
        // Fallback: direct HTML injection (Slack uses <p> for each line in Quill)
        const lines = text.split("\n");
        composer.innerHTML = lines.map(l => `<p>${esc(l)}</p>`).join("");
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
      }

      await new Promise(r => setTimeout(r, 250));
      const sendBtn = document.querySelector(
        'button[data-qa="texty_send_button"], '
        + 'button[aria-label*="Send" i][data-qa^="texty"], '
        + 'button[data-qa="message_send_button"]'
      );
      if (sendBtn) {
        try { sendBtn.focus(); } catch {}
        sendBtn.classList.add("klosr-send-pulse-web");
        setTimeout(() => sendBtn.classList.remove("klosr-send-pulse-web"), 4500);
      }
      return true;
    } catch (err) {
      console.warn("[Klosr] Slack autofill failed:", err);
      return false;
    }
  }

  // Teams Web — message composer is contenteditable div with role=textbox.
  // Teams has variable selectors across versions; we fall back progressively.
  async function autofillTeams(text) {
    try {
      const composer = await waitForSelector(
        'div[contenteditable="true"][role="textbox"][aria-label*="message" i], '
        + 'div[contenteditable="true"][role="textbox"][data-tid*="message" i], '
        + '.cke_editable[contenteditable="true"], '
        + 'div[contenteditable="true"][role="textbox"]',
        4000
      );
      if (!composer) {
        console.warn("[Klosr] Teams composer not found — open a chat first");
        return false;
      }

      composer.focus();
      composer.innerHTML = "";

      let filled = false;
      try { filled = document.execCommand("insertText", false, text); } catch {}
      if (!filled) {
        const lines = text.split("\n");
        composer.innerHTML = lines.map(l => `<p>${esc(l)}</p>`).join("");
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }

      await new Promise(r => setTimeout(r, 300));
      const sendBtn = document.querySelector(
        'button[data-tid="newMessageCommands-send"], '
        + 'button[aria-label="Send" i], '
        + 'button[title*="Send" i][data-tid*="send" i]'
      );
      if (sendBtn) {
        try { sendBtn.focus(); } catch {}
        sendBtn.classList.add("klosr-send-pulse-web");
        setTimeout(() => sendBtn.classList.remove("klosr-send-pulse-web"), 4500);
      }
      return true;
    } catch (err) {
      console.warn("[Klosr] Teams autofill failed:", err);
      return false;
    }
  }

  function waitForSelector(selector, timeoutMs) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) { resolve(existing); return; }
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); clearTimeout(timer); resolve(el); }
      });
      obs.observe(document.body, { subtree: true, childList: true });
      const timer = setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs || 5000);
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────
  function boot() {
    // Initial poll after a short delay (let the page settle)
    setTimeout(pollPending, 2000);
    _pollTimer = setInterval(pollPending, POLL_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
