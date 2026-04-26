// Klosr Native — overlay app.js (v0.3.0)
//
// Cluely-style floating capsule UI with full Dashboard / Menu.
// Window has WS_EX_NOACTIVATE applied in main.rs so it NEVER steals
// focus from the user's underlying app. inject_text uses Unicode
// SendInput so the typed-out text lands in any Windows app — including
// Electron-based apps (WhatsApp Desktop, Slack Desktop, Discord).

const INTEL_URL = "https://backend-kappa-nine-57.vercel.app/api/intel";
const IID_KEY = "klosr_pwa_install_id";
const USER_KEY = "klosr_pwa_user";
const SETTINGS_KEY = "klosr_settings_v1";
const STATS_KEY = "klosr_stats_v1";
const KLOSR_VERSION = "0.3.0";

let _user = null;
const watch = {
  active: false, paused: false, timer: null, inFlight: false,
  lastHash: null, lastAnalyzeAt: 0, frameCount: 0,
  drafts: [], currentDraft: null,
  sampleMs: 4000, minGapMs: 12000, nativeHashThreshold: 1000000,
  watchStartedAt: 0, watchedSecondsToday: 0,
};

// ─── Settings (persisted) ──────────────────────────────────────────
const defaultSettings = {
  autostart: false,
  notifications: true,
  pulse: true,
  sensitivity: 50,
};
let _settings = { ...defaultSettings };
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) _settings = { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings)); } catch {}
}

// ─── Stats (persisted, day-keyed) ──────────────────────────────────
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const k = todayKey();
    return all[k] || { drafts: 0, sent: 0, watchSec: 0 };
  } catch {
    return { drafts: 0, sent: 0, watchSec: 0 };
  }
}
function bumpStat(field, delta) {
  try {
    const k = todayKey();
    const all = JSON.parse(localStorage.getItem(STATS_KEY) || "{}");
    all[k] = all[k] || { drafts: 0, sent: 0, watchSec: 0 };
    all[k][field] = (all[k][field] || 0) + (delta || 1);
    localStorage.setItem(STATS_KEY, JSON.stringify(all));
  } catch {}
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function callIntel(action, params) {
  const res = await fetch(INTEL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, params: params || {} }),
  });
  return res.json();
}

const isKlosrNative = () => !!(window.klosrNative && window.__TAURI__);

function setStatus(text, watching) {
  const t = document.getElementById("cap-status-text");
  const c = document.getElementById("cap-status");
  if (t) t.textContent = text;
  if (c) c.classList.toggle("watching", !!watching);
}

function showToast(msg, isError) {
  const cap = document.getElementById("capsule");
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " err" : "");
  t.textContent = msg;
  cap.style.position = "relative";
  cap.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

async function resizeWindow(mode) {
  if (!window.__TAURI__) return;
  try {
    const w = window.__TAURI__.window?.getCurrentWindow?.();
    const LogicalSize = window.__TAURI__.window?.LogicalSize;
    if (!w || !LogicalSize) return;
    if (mode === "compact")         await w.setSize(new LogicalSize(540, 92));
    else if (mode === "expanded")   await w.setSize(new LogicalSize(540, 460));
    else if (mode === "dashboard")  await w.setSize(new LogicalSize(560, 620));
    else if (mode === "onboarding") await w.setSize(new LogicalSize(420, 320));
  } catch (e) {/* not critical */}
}

// ─── Onboarding (first run) ────────────────────────────────────────
function showOnboarding() {
  document.getElementById("capsule").style.display = "none";
  document.getElementById("panel").classList.add("hidden");
  document.getElementById("onboarding").classList.remove("hidden");
  resizeWindow("onboarding");

  const input = document.getElementById("onb-iid");
  const btn = document.getElementById("onb-connect");
  setTimeout(() => input?.focus(), 50);

  const connect = async () => {
    const iid = (input.value || "").trim();
    if (!iid || iid.length < 8) { input.focus(); return; }
    btn.disabled = true; btn.textContent = "Connecting...";
    const res = await callIntel("pwa-bootstrap", { installId: iid }).catch(() => null);
    if (!res || !res.ok) {
      btn.disabled = false; btn.textContent = "Connect";
      input.style.borderColor = "#F87171";
      showToast("Couldn't find that install ID", true);
      return;
    }
    _user = { ...res.user, syncedState: res.syncedState || null };
    localStorage.setItem(IID_KEY, iid);
    localStorage.setItem(USER_KEY, JSON.stringify(_user));
    document.getElementById("onboarding").classList.add("hidden");
    document.getElementById("capsule").style.display = "";
    showCapsuleOnly();
  };
  btn.addEventListener("click", connect);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
}

// ─── Capsule-only mode (default) ───────────────────────────────────
function showCapsuleOnly() {
  document.getElementById("panel").classList.add("hidden");
  document.getElementById("onboarding").classList.add("hidden");
  document.getElementById("capsule").style.display = "";
  resizeWindow("compact");
  const toggleBtn = document.getElementById("btn-toggle");
  if (toggleBtn) toggleBtn.textContent = watch.drafts.length > 0 ? `Show (${watch.drafts.length})` : "Show";
  if (!watch.active) setStatus("Click ▶ to start", false);
}

// ─── Render helpers ────────────────────────────────────────────────
function renderDraftPanel(draft) {
  const tempIcon = draft.temperature === "hot" ? "🔥" : draft.temperature === "warm" ? "☀️" : draft.temperature === "cold" ? "❄️" : "📝";
  const tempBadge = ["hot", "warm", "cold"].includes(draft.temperature)
    ? `<span style="margin-left:6px; padding: 2px 8px; border-radius: 999px; background: rgba(251,113,133,0.14); color: #FDA4AF; font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;">${tempIcon} ${esc(draft.temperature)}</span>`
    : "";
  const proofHtml = draft.suggestedProof?.title
    ? `<div style="margin-top: 12px; padding: 8px 10px; background: rgba(96,165,250,0.08); border: 1px solid rgba(96,165,250,0.22); border-radius: 8px;">
         <div style="font-size: 10px; font-weight: 800; color: #BFDBFE; margin-bottom: 3px; letter-spacing: 0.05em; text-transform: uppercase;">📎 Cite this proof</div>
         <div style="font-size: 11.5px; line-height: 1.45; color: rgba(244,244,245,0.85);"><strong>${esc(draft.suggestedProof.title)}</strong> — ${esc(draft.suggestedProof.body || "")}</div>
       </div>`
    : "";
  return `
    ${draft.whatYouSaw ? `<div class="panel-source"><span class="badge">Klosr sees</span><span>${esc(draft.whatYouSaw)}</span>${tempBadge}</div>` : ""}
    ${draft.draft ? `<div class="panel-answer"><div class="panel-answer-quote">${esc(draft.draft).replace(/\n/g, "<br>")}</div></div>` : ""}
    ${proofHtml}
    <div class="panel-actions">
      <span class="label">Inject into</span>
      <button class="cap-btn primary" data-inject="whatsapp">📤 WhatsApp</button>
      <button class="cap-btn primary" data-inject="gmail">📤 Gmail</button>
      <button class="cap-btn primary" data-inject="slack">📤 Slack</button>
      <button class="cap-btn primary" data-inject="teams">📤 Teams</button>
      <button class="cap-btn" data-action="copy">📋 Copy</button>
    </div>
    ${renderAskBar()}
  `;
}

function renderAskBar() {
  return `
    <div class="ask-bar">
      <input type="text" id="ask-input" placeholder="Ask Klosr anything..." autocomplete="off" />
      <span class="kbd">⏎</span>
      <button class="send-btn" id="ask-send">▶</button>
    </div>
    <div class="ask-foot">
      <span class="smart-chip active">⚡ Smart</span>
      <span style="font-size: 10px; color: rgba(244,244,245,0.40);">Klosr drafts in your voice using your proof library + ICP</span>
    </div>
  `;
}

// ─── Wiring ────────────────────────────────────────────────────────
function wireInjectButtons() {
  document.querySelectorAll("[data-inject]").forEach(btn => {
    // v0.2.1 — capture target window the moment the user mouses onto the
    // inject button. Klosr's WS_EX_NOACTIVATE means clicking us doesn't
    // change foreground, so this snapshot reliably captures the user's
    // actual target app (WhatsApp/Slack/Outlook/etc.). The native side
    // then SetForegroundWindow's that HWND before typing.
    btn.addEventListener("mouseenter", () => {
      if (!isKlosrNative()) return;
      window.__TAURI__.core.invoke("capture_target_window")
        .then(r => { if (r?.captured) console.debug("[klosr] target:", r.title); })
        .catch(() => {});
    });

    btn.addEventListener("click", async () => {
      const targetApp = btn.dataset.inject;
      const draft = watch.currentDraft;
      if (!draft || !draft.draft) return;
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.textContent = "Typing...";

      // Native inject — Klosr is non-activating, so the typed-out unicode
      // events land in whatever app the user actually has focused (and
      // we explicitly SetForegroundWindow the captured target HWND first
      // for extra reliability).
      if (isKlosrNative()) {
        try {
          // Re-capture right before typing as a safety net in case the
          // mouseenter capture is stale (e.g. user kept Klosr open and
          // switched apps via Alt+Tab).
          await window.__TAURI__.core.invoke("capture_target_window").catch(() => {});

          const res = await window.__TAURI__.core.invoke("inject_text", {
            args: { text: draft.draft, target_app: targetApp },
          });
          if (res?.ok) {
            bumpStat("sent", 1);
            showToast(`✓ Typed into ${targetApp}`);
            btn.innerHTML = "✓ Done";
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1800);
            return;
          } else {
            console.warn("[inject] failed:", res);
          }
        } catch (e) { console.warn("[inject]", e); }
      }
      // Fallback: clipboard copy
      try { await navigator.clipboard.writeText(draft.draft); } catch {}
      showToast(`📋 Copied — paste in ${targetApp}`);
      btn.innerHTML = orig;
      btn.disabled = false;
    });
  });

  const copyBtn = document.querySelector('[data-action="copy"]');
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      if (watch.currentDraft?.draft) {
        await navigator.clipboard.writeText(watch.currentDraft.draft).catch(() => {});
        showToast("✓ Copied");
      }
    });
  }
}

function wireAskBar() {
  const input = document.getElementById("ask-input");
  const send = document.getElementById("ask-send");
  if (!input || !send) return;
  setTimeout(() => input.focus(), 50);

  const submit = async () => {
    const q = (input.value || "").trim();
    if (!q) return;
    send.disabled = true;
    input.disabled = true;
    input.value = "";

    const c = document.getElementById("panel-content");
    c.innerHTML = `
      <div class="panel-question"><span>${esc(q)}</span></div>
      <div class="panel-answer"><span class="spinner"></span>Klosr is thinking...</div>
    `;
    resizeWindow("expanded");

    try {
      const res = await fetch("https://backend-kappa-nine-57.vercel.app/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: q }],
          mode: "sales",
          language: "en",
          sender: {
            name: _user?.yourName || "",
            company: _user?.companyName || "",
            icp: _user?.icp || "",
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      const answer = (data && (data.reply || data.text || "")) || "I couldn't draft that.";
      watch.currentDraft = { draft: answer, whatYouSaw: q, id: "ask-" + Date.now() };
      c.innerHTML = `
        <div class="panel-question"><span>${esc(q)}</span></div>
        <div class="panel-answer"><div class="panel-answer-quote">${esc(answer).replace(/\n/g, "<br>")}</div></div>
        <div class="panel-actions">
          <span class="label">Inject into</span>
          <button class="cap-btn primary" data-inject="whatsapp">📤 WhatsApp</button>
          <button class="cap-btn primary" data-inject="gmail">📤 Gmail</button>
          <button class="cap-btn primary" data-inject="slack">📤 Slack</button>
          <button class="cap-btn primary" data-inject="teams">📤 Teams</button>
          <button class="cap-btn" data-action="copy">📋 Copy</button>
        </div>
        ${renderAskBar()}
      `;
      wireInjectButtons();
      wireAskBar();
    } catch (e) {
      c.innerHTML = `<div class="panel-answer" style="color:#F87171;">Error: ${esc(e.message || "unknown")}</div>${renderAskBar()}`;
      wireAskBar();
    }
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });
}

// ─── Watch mode (native screen capture, no banner) ─────────────────
function startWatch() {
  if (watch.active) return;
  watch.active = true;
  watch.paused = false;
  watch.frameCount = 0;
  watch.drafts = [];
  watch.lastHash = null;
  watch.lastAnalyzeAt = 0;
  watch.watchStartedAt = Date.now();
  setStatus("Watching · Opus 4.7", true);
  const startBtn = document.getElementById("btn-start");
  startBtn.innerHTML = '<span class="ico">⏸</span><span>Stop</span>';
  startBtn.classList.remove("primary");
  startBtn.classList.add("danger");
  watch.timer = setInterval(sampleAndAnalyze, watch.sampleMs);
  // Watch-time accumulator — tick every 30s and bump persisted stats
  watch._statTimer = setInterval(() => {
    if (!watch.active || watch.paused) return;
    bumpStat("watchSec", 30);
  }, 30000);
}

function stopWatch() {
  if (watch.timer) { clearInterval(watch.timer); watch.timer = null; }
  if (watch._statTimer) { clearInterval(watch._statTimer); watch._statTimer = null; }
  // Final flush of remaining seconds
  if (watch.watchStartedAt) {
    const sec = Math.max(0, Math.floor((Date.now() - watch.watchStartedAt) / 1000) % 30);
    if (sec > 0) bumpStat("watchSec", sec);
  }
  watch.active = false;
  watch.paused = false;
  watch.inFlight = false;
  setStatus(watch.drafts.length > 0 ? `${watch.drafts.length} drafts ready` : "Click ▶ to start", false);
  const startBtn = document.getElementById("btn-start");
  startBtn.innerHTML = '<span class="ico">▶</span><span>Start</span>';
  startBtn.classList.add("primary");
  startBtn.classList.remove("danger");
}

async function sampleAndAnalyze() {
  if (!watch.active || watch.paused || watch.inFlight) return;
  if (Date.now() - watch.lastAnalyzeAt < watch.minGapMs) return;
  if (!isKlosrNative()) return;

  try {
    const result = await window.__TAURI__.core.invoke("capture_screen");
    if (!result?.base64) return;
    watch.frameCount += 1;

    // Cheap byte-hash for change detection
    const hashSample = result.base64.slice(0, 32 * 1024);
    let hash = 0x811c9dc5;
    for (let i = 0; i < hashSample.length; i++) {
      hash ^= hashSample.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    if (!watch.lastHash) { watch.lastHash = hash; return; }
    if (Math.abs(hash - watch.lastHash) < watch.nativeHashThreshold) return;

    watch.lastHash = hash;
    watch.lastAnalyzeAt = Date.now();
    watch.inFlight = true;
    setStatus("Analyzing screen...", true);

    const synced = _user?.syncedState || {};
    const res = await callIntel("screenshot-analyze", {
      imageBase64: result.base64,
      mimeType: result.mime_type || "image/jpeg",
      userPrompt: "",
      intent: "auto",
      language: "en",
      founder: {
        name: _user?.yourName || "",
        company: _user?.companyName || "",
        icp: _user?.icp || synced.icpLearnings || "",
      },
      proofLibrary: synced.proofLibrary || [],
      objectionPlaybook: synced.objectionPlaybook || [],
      voiceExamples: synced.voiceExamples || [],
    });

    setStatus("Watching · Opus 4.7", true);

    if (res?.ok && res.actionCategory !== "context_only" && res.draft) {
      const draft = {
        id: "d-" + Date.now(),
        whatYouSaw: res.whatYouSaw || "",
        draft: res.draft,
        temperature: res.temperature || "",
        suggestedProof: res.suggestedProof || null,
        ts: Date.now(),
      };
      watch.drafts.unshift(draft);
      watch.currentDraft = draft;
      bumpStat("drafts", 1);
      const cap = document.getElementById("capsule");
      if (_settings.pulse) {
        cap.classList.remove("attn"); void cap.offsetWidth; cap.classList.add("attn");
      }
      // OS notification on hot replies
      if (_settings.notifications && draft.temperature === "hot" && window.__TAURI__?.notification) {
        try {
          window.__TAURI__.notification.sendNotification?.({
            title: "Klosr · Hot reply ready",
            body: (draft.draft || "").slice(0, 120),
          });
        } catch {}
      }
      // Auto-expand on hot
      if (draft.temperature === "hot") {
        const panel = document.getElementById("panel");
        const c = document.getElementById("panel-content");
        c.innerHTML = renderDraftPanel(draft);
        panel.classList.remove("hidden");
        document.getElementById("btn-toggle").textContent = "Hide";
        resizeWindow("expanded");
        wireInjectButtons();
        wireAskBar();
      } else {
        // Update toggle count
        document.getElementById("btn-toggle").textContent = `Show (${watch.drafts.length})`;
      }
    }
  } catch (e) {
    console.warn("[Watch]", e);
    setStatus("Watching · Opus 4.7", true);
  } finally {
    watch.inFlight = false;
  }
}

// ─── Top-level UI wiring ───────────────────────────────────────────
function wireCapsule() {
  document.getElementById("btn-start").addEventListener("click", () => {
    if (watch.active) stopWatch(); else startWatch();
  });
  document.getElementById("btn-toggle").addEventListener("click", () => {
    // Hide dashboard if open
    document.getElementById("dashboard").classList.add("hidden");
    const panel = document.getElementById("panel");
    if (panel.classList.contains("hidden")) {
      const c = document.getElementById("panel-content");
      if (watch.currentDraft) {
        c.innerHTML = renderDraftPanel(watch.currentDraft);
      } else {
        c.innerHTML = `
          <div class="panel-source"><span class="badge">Klosr</span><span>Ask anything below — Klosr drafts in your voice.</span></div>
          ${renderAskBar()}
        `;
      }
      panel.classList.remove("hidden");
      document.getElementById("btn-toggle").textContent = "Hide";
      resizeWindow("expanded");
      wireInjectButtons();
      wireAskBar();
    } else {
      panel.classList.add("hidden");
      document.getElementById("btn-toggle").textContent = watch.drafts.length > 0 ? `Show (${watch.drafts.length})` : "Show";
      resizeWindow("compact");
    }
  });
  document.getElementById("btn-dash").addEventListener("click", () => {
    const dash = document.getElementById("dashboard");
    if (dash.classList.contains("hidden")) {
      // Hide draft panel if open
      document.getElementById("panel").classList.add("hidden");
      document.getElementById("btn-toggle").textContent = watch.drafts.length > 0 ? `Show (${watch.drafts.length})` : "Show";
      refreshDashboard();
      dash.classList.remove("hidden");
      resizeWindow("dashboard");
    } else {
      dash.classList.add("hidden");
      resizeWindow("compact");
    }
  });
  document.getElementById("btn-quit").addEventListener("click", async () => {
    if (window.__TAURI__) {
      try { await window.__TAURI__.core.invoke("hide_window"); }
      catch {/* fallback */}
    }
  });
}

// ─── Dashboard / Menu ──────────────────────────────────────────────
function refreshDashboard() {
  const stats = loadStats();
  const today = stats;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("stat-drafts", today.drafts);
  set("stat-sent", today.sent);
  const m = Math.floor((today.watchSec || 0) / 60);
  set("stat-watch", m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m}m`);

  // Account
  const iid = localStorage.getItem(IID_KEY) || "—";
  set("dash-iid", iid.length > 24 ? iid.slice(0, 12) + "…" + iid.slice(-6) : iid);
  set("dash-voice", _user?.voiceProfile?.name || _user?.companyName || "—");
  set("dash-version", KLOSR_VERSION);
  set("foot-status", watch.active ? "Watching" : "Idle");

  // Plan badge
  const plan = _user?.plan || "trial";
  const planLabel = {
    trial: "Trial · 14 days remaining",
    free: "Free plan",
    pro: "Pro plan · €49/mo",
    team: "Team plan · €99/seat",
  }[plan] || `${plan}`;
  set("dash-plan-sub", planLabel);
  const upBtn = document.getElementById("dash-upgrade");
  if (upBtn) upBtn.textContent = (plan === "pro" || plan === "team") ? "Manage" : "Upgrade";

  // Toggles reflect persisted state
  document.getElementById("set-autostart")?.classList.toggle("on", _settings.autostart);
  document.getElementById("set-notify")?.classList.toggle("on", _settings.notifications);
  document.getElementById("set-pulse")?.classList.toggle("on", _settings.pulse);
  const sens = document.getElementById("set-sens");
  if (sens) sens.value = _settings.sensitivity;

  // Integrations status from synced state (best-effort)
  const synced = _user?.syncedState || {};
  const integ = synced.integrations || {};
  ["hubspot", "salesforce", "pipedrive", "slack"].forEach(key => {
    const el = document.querySelector(`.integ-pill .st[data-int="${key}"]`);
    if (!el) return;
    const ok = !!integ[key]?.connected;
    el.textContent = ok ? "Connected" : "Not connected";
    el.classList.toggle("connected", ok);
    el.classList.toggle("notconnected", !ok);
  });
}

function wireDashboard() {
  // Close
  document.getElementById("dash-close")?.addEventListener("click", () => {
    document.getElementById("dashboard").classList.add("hidden");
    resizeWindow("compact");
  });

  // Toggles
  document.querySelectorAll(".toggle[data-setting]").forEach(t => {
    t.addEventListener("click", () => {
      const key = t.dataset.setting;
      _settings[key] = !_settings[key];
      t.classList.toggle("on", _settings[key]);
      saveSettings();
      if (key === "autostart" && _settings.autostart && !watch.active) {
        startWatch();
      }
    });
  });

  // Sensitivity slider
  document.getElementById("set-sens")?.addEventListener("input", (e) => {
    _settings.sensitivity = Number(e.target.value);
    // Higher sensitivity → lower hash threshold (more changes detected)
    // Map 0..100 → threshold 5_000_000 (less sensitive) .. 100_000 (very sensitive)
    watch.nativeHashThreshold = Math.round(5_000_000 - _settings.sensitivity * 49_000);
    saveSettings();
  });

  // Footer / nav buttons
  const openExternal = (url) => {
    if (window.__TAURI__?.shell?.open) {
      window.__TAURI__.shell.open(url).catch(() => {});
    } else {
      try { window.open(url, "_blank"); } catch {}
    }
  };
  document.getElementById("dash-manage-integ")?.addEventListener("click", () => {
    openExternal("https://backend-kappa-nine-57.vercel.app/app.html#integrations");
  });
  document.getElementById("dash-upgrade")?.addEventListener("click", () => {
    openExternal("https://backend-kappa-nine-57.vercel.app/pricing.html");
  });
  document.getElementById("dash-relink")?.addEventListener("click", () => {
    localStorage.removeItem(IID_KEY);
    localStorage.removeItem(USER_KEY);
    showToast("Re-linking…");
    setTimeout(() => location.reload(), 400);
  });
  document.getElementById("dash-signout")?.addEventListener("click", () => {
    if (!confirm("Sign out of Klosr?")) return;
    localStorage.removeItem(IID_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    setTimeout(() => location.reload(), 200);
  });
  document.getElementById("dash-privacy")?.addEventListener("click", () => {
    openExternal("https://backend-kappa-nine-57.vercel.app/privacy.html");
  });
  document.getElementById("dash-clear")?.addEventListener("click", () => {
    if (!confirm("Clear all locally cached data (drafts, stats, settings)?")) return;
    localStorage.removeItem(STATS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    watch.drafts = [];
    watch.currentDraft = null;
    _settings = { ...defaultSettings };
    showToast("Cleared local data");
    refreshDashboard();
  });
  document.getElementById("dash-checkupd")?.addEventListener("click", async () => {
    const btn = document.getElementById("dash-checkupd");
    if (!btn) return;
    btn.disabled = true; btn.textContent = "Checking…";
    try {
      const res = await fetch(`https://backend-kappa-nine-57.vercel.app/api/updater/windows-x86_64/${KLOSR_VERSION}`).catch(() => null);
      if (!res || res.status === 204) { showToast("Up to date"); }
      else if (res.ok) {
        const j = await res.json().catch(() => null);
        showToast(j?.version ? `Update available: ${j.version}` : "Update available");
      } else { showToast("Couldn't check for updates", true); }
    } catch { showToast("Couldn't check for updates", true); }
    btn.textContent = "Check for updates";
    btn.disabled = false;
  });
  document.getElementById("dash-support")?.addEventListener("click", () => {
    openExternal("mailto:hello@klosr.com?subject=Klosr%20Desktop%20" + encodeURIComponent(KLOSR_VERSION));
  });
  document.getElementById("dash-quit")?.addEventListener("click", async () => {
    if (window.__TAURI__) {
      // Try the proper Tauri exit path; fall back to hide if not exposed
      try {
        const proc = window.__TAURI__.process;
        if (proc?.exit) { await proc.exit(0); return; }
      } catch {}
      try { await window.__TAURI__.core.invoke("hide_window"); } catch {}
    }
  });
}

// ─── Boot ──────────────────────────────────────────────────────────
(async () => {
  loadSettings();
  // Apply sensitivity setting immediately so first sample uses it
  watch.nativeHashThreshold = Math.round(5_000_000 - (_settings.sensitivity || 50) * 49_000);

  wireCapsule();
  wireDashboard();

  const iid = localStorage.getItem(IID_KEY);
  const cached = localStorage.getItem(USER_KEY);
  if (iid && cached) {
    try { _user = JSON.parse(cached); } catch {}
    if (_user) {
      callIntel("pwa-bootstrap", { installId: iid }).then(res => {
        if (res?.ok) {
          _user = { ...res.user, syncedState: res.syncedState || null };
          localStorage.setItem(USER_KEY, JSON.stringify(_user));
        }
      }).catch(() => {});
      showCapsuleOnly();
      // Auto-start Watch if user enabled it
      if (_settings.autostart) {
        setTimeout(() => { if (!watch.active) startWatch(); }, 600);
      }
      return;
    }
  }
  showOnboarding();
})();

// ─── Listen for IPC events from the main window ────────────────
// The main app calls toggle_watch_from_main → emits klosr-toggle-watch.
// The overlay listens here and starts/stops Watch accordingly.
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen("klosr-toggle-watch", () => {
    if (!watch.active) startWatch();
    else stopWatch();
  }).catch(() => {});
}
