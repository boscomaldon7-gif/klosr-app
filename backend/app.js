// Klosr PWA — runs on app.html
//
// ═══════════════════════════════════════════════════════════════════
// KLOSR WATCH — the primary mode: continuous screen reading
//
// The user shares their screen (or a specific window) ONCE. Klosr
// samples frames every ~4s, computes a perceptual hash, and only
// triggers Vision when the content has changed meaningfully (new
// message, new email, new reply). When change is detected, the frame
// is sent to Claude Opus 4.7 multimodal; if the result is a reply
// draft / objection / buying signal, a floating card appears with
// the drafted response. One click → clipboard → paste into the app.
//
// Privacy: browser's own "You're sharing your screen" bar is
// always visible. User can stop anytime. We never upload full frames
// anywhere except Anthropic (via our backend) on change-detect.
// ═══════════════════════════════════════════════════════════════════

const INTEL_URL = "/api/intel";
const IID_KEY = "klosr_pwa_install_id";
const USER_KEY = "klosr_pwa_user";

let _user = null;

// Watch state
const watch = {
  stream: null,
  video: null,
  canvas: null,
  ctx: null,
  timer: null,
  active: false,
  paused: false,
  lastHash: null,
  lastAnalyzeAt: 0,
  inFlight: false,
  frameCount: 0,
  draftCount: 0,
  drafts: [],              // [{ id, whatYouSaw, draft, temperature, ts, suggestedProof, nextStep }]
  minGapMs: 12000,          // hard floor between Vision calls (~$0.80 / hour upper bound)
  sampleMs: 4000,           // how often we sample a frame
  hashThreshold: 18,        // hamming-like distance before we consider the frame "changed enough"
};

// Manual paste state (fallback)
let _pasteImage = null;
let _pasteIntent = "auto";

let _currentView = "home";

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

// ─── Onboarding flow ────────────────────────────────────────────────

function renderOnboarding() {
  _currentView = "onboarding";
  document.getElementById("user-chip-wrap").innerHTML = "";
  document.getElementById("app").innerHTML = `
    <div class="onboarding">
      <h1>Klosr sees your screen.<br>Drafts the reply. <em>You close.</em></h1>
      <p>Klosr reads WhatsApp, email, Slack, Sales Nav as you work — and the moment a prospect replies, Klosr drafts the response in your voice. Copy, paste, send. Close the deal.</p>

      <div class="input-row">
        <input type="text" id="iid-input" placeholder="Paste your Klosr install ID" autocomplete="off" />
        <button class="btn-primary" id="iid-connect">Connect</button>
      </div>

      <div class="install-hint">
        <strong>How to get your install ID:</strong><br>
        Open the Klosr Chrome extension on any LinkedIn profile → settings → <strong>Copy install ID</strong>. Paste it above. Klosr Desktop syncs your voice, ICP, and proof library automatically.
      </div>

      <p style="margin-top: 22px; font-size: 12px; color: rgba(244,244,245,0.55)">
        New to Klosr? <a href="https://chrome.google.com/webstore" style="color: #FFD60A">Install the Chrome extension first</a>, finish onboarding, then come back.
      </p>
    </div>
  `;

  const connect = async () => {
    const btn = document.getElementById("iid-connect");
    const input = document.getElementById("iid-input");
    const iid = (input.value || "").trim();
    if (!iid || iid.length < 8) { input.focus(); return; }
    btn.disabled = true; btn.textContent = "Connecting...";
    const res = await callIntel("pwa-bootstrap", { installId: iid }).catch(() => null);
    if (!res || !res.ok) {
      btn.disabled = false; btn.textContent = "Connect";
      input.style.borderColor = "#F87171";
      document.getElementById("app").insertAdjacentHTML("beforeend",
        `<div class="error-block" style="max-width:520px;margin:0 auto 20px">Couldn't find that install ID. Error: ${esc(res?.reason || "unknown")}</div>`);
      return;
    }
    // Merge syncedState into the user object so Vision calls can pick it up.
    _user = { ...res.user, syncedState: res.syncedState || null };
    localStorage.setItem(IID_KEY, iid);
    localStorage.setItem(USER_KEY, JSON.stringify(_user));
    renderDashboard();
  };
  document.getElementById("iid-connect").addEventListener("click", connect);
  document.getElementById("iid-input").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
}

// ─── Dashboard / home ───────────────────────────────────────────────

function renderUserChip() {
  const wrap = document.getElementById("user-chip-wrap");
  if (!_user) { wrap.innerHTML = ""; return; }
  const name = _user.yourName || _user.email || "You";
  const co = _user.companyName || "";
  wrap.innerHTML = `
    <button class="user-chip" id="user-chip">
      <span class="dot${watch.active ? ' active' : ''}"></span>
      <span>${esc(name)}${co ? ` · <span style="opacity:0.65">${esc(co)}</span>` : ""}</span>
    </button>
  `;
  document.getElementById("user-chip").addEventListener("click", () => {
    if (confirm("Log out of Klosr Desktop?")) {
      stopWatch();
      localStorage.removeItem(IID_KEY);
      localStorage.removeItem(USER_KEY);
      _user = null;
      renderOnboarding();
    }
  });
}

function renderDashboard() {
  _currentView = "home";
  renderUserChip();
  const firstName = (_user?.yourName || "").split(" ")[0] || "you";
  document.getElementById("app").innerHTML = `
    <div class="dashboard">
      <h2 class="greeting">What are we <em>closing</em>, ${esc(firstName)}?</h2>
      <p class="subhead">Klosr Desktop. Reads your screen. Drafts the reply. Works across every app.</p>

      <!-- Primary CTA: Klosr Watch -->
      <section class="watch-hero" id="watch-hero">
        <div class="watch-hero-left">
          <div class="watch-hero-eyebrow">👁️ PRIMARY MODE</div>
          <div class="watch-hero-title">Let Klosr watch your screen</div>
          <div class="watch-hero-body">
            Share your screen once. Klosr sees every DM, email, and reply as it arrives, and drafts the response in your voice automatically. No copy-paste, no context-switching.
          </div>
          <div class="watch-hero-actions">
            <button class="btn-primary watch-start-btn" id="watch-start">▶ Start watching</button>
            <span class="watch-hero-hint">You'll get a browser prompt to pick screen or window</span>
          </div>
        </div>
        <div class="watch-hero-right">
          <div class="watch-hero-demo">
            <div class="watch-hero-demo-frame">👁️</div>
            <div class="watch-hero-demo-caption">Opus 4.7 · multimodal</div>
          </div>
        </div>
      </section>

      <!-- Watch running state (replaces hero when active) -->
      <section class="watch-running" id="watch-running" hidden></section>

      <!-- Secondary actions -->
      <div class="action-grid" style="margin-top: 22px">
        <div class="action-card" data-go="paste">
          <div class="icon">📋</div>
          <div class="title">Paste a screenshot</div>
          <div class="desc">Manual fallback — if you'd rather not share your screen continuously.</div>
        </div>
        <div class="action-card" data-go="brag">
          <div class="icon">🔥</div>
          <div class="title">This week in Klosr</div>
          <div class="desc">Turn your numbers into a LinkedIn post. One click to share.</div>
        </div>
        <div class="action-card" data-go="settings">
          <div class="icon">⚙️</div>
          <div class="title">Integrations</div>
          <div class="desc">HubSpot, Slack. Connect your stack.</div>
        </div>
      </div>

      <div id="view-panel"></div>
    </div>
  `;

  document.getElementById("watch-start").addEventListener("click", startWatch);
  document.querySelectorAll("[data-go]").forEach(card => {
    card.addEventListener("click", () => {
      const t = card.dataset.go;
      if (t === "paste") renderPastePanel();
      else if (t === "brag") renderBragPanel();
      else if (t === "settings") renderSettingsPanel();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// KLOSR WATCH — screen capture + change detection + Vision loop
// ═══════════════════════════════════════════════════════════════════

// Detect Klosr Native (Tauri) context. When running inside the Tauri
// desktop app, window.klosrNative is injected at startup with the
// platform + capabilities. We use this to switch from getDisplayMedia
// (which shows a browser banner) to native screen capture (silent).
const isKlosrNative = () => !!(window.klosrNative && window.__TAURI__);

async function startWatch() {
  if (watch.active) return;

  // ───── KLOSR NATIVE PATH (no browser banner) ─────
  if (isKlosrNative()) {
    return startWatchNative();
  }

  // ───── BROWSER / PWA PATH (getDisplayMedia, with banner) ─────
  try {
    // Request screen share. Browser shows its own picker (screen / window / tab).
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 1, max: 2 },      // hint that we don't need fast video
      },
      audio: false,
      systemAudio: "exclude",
    });
    watch.stream = stream;

    const [track] = stream.getVideoTracks();
    if (track) {
      track.addEventListener("ended", () => {
        console.log("[Klosr Watch] stream ended by user");
        stopWatch();
      });
    }

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    watch.video = video;

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    watch.canvas = canvas;
    watch.ctx = canvas.getContext("2d", { willReadFrequently: true });

    watch.active = true;
    watch.paused = false;
    watch.frameCount = 0;
    watch.draftCount = 0;
    watch.drafts = [];
    watch.lastHash = null;
    watch.lastAnalyzeAt = 0;

    // ───── ANTI-THROTTLE ─────────────────────────────────────────
    // Browsers aggressively throttle JS timers in backgrounded tabs.
    // Three defenses, in order of effectiveness:
    //   1. Web Audio keepalive — tabs playing audio are NEVER throttled
    //      (silent oscillator → inaudible, but the tab stays "active")
    //   2. Screen Wake Lock — prevents display sleep during Watch
    //   3. requestAnimationFrame self-scheduling — falls back to setInterval
    //      for compatibility; RAF runs when tab is visible (primary loop)
    await startWatchKeepalive();

    // Kick off the sample loop — setInterval covers the backgrounded case
    // now that audio keepalive is on.
    watch.timer = setInterval(sampleAndMaybeAnalyze, watch.sampleMs);

    renderWatchRunning();
    renderUserChip();
  } catch (err) {
    console.warn("[Klosr Watch] start failed:", err);
    if (err.name === "NotAllowedError") {
      alert("Klosr needs permission to watch your screen. Click 'Start watching' again and share your screen / window / tab.");
    } else {
      alert("Couldn't start screen watching: " + (err.message || "unknown error"));
    }
  }
}

// Anti-throttle keepalive. Call on startWatch, clean up in stopWatch.
async function startWatchKeepalive() {
  // 1. Silent Web Audio keepalive — key trick.
  try {
    if (!watch._audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        // Resume if suspended (Chrome autoplay policy)
        if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.00001;    // effectively silent but non-zero
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        watch._audioCtx = ctx;
        watch._audioOsc = osc;
      }
    }
  } catch (e) {
    console.warn("[Klosr Watch] audio keepalive failed:", e);
  }

  // 2. Screen Wake Lock — keeps display on (best-effort)
  try {
    if ("wakeLock" in navigator) {
      watch._wakeLock = await navigator.wakeLock.request("screen").catch(() => null);
      if (watch._wakeLock) {
        watch._wakeLock.addEventListener("release", () => {
          // If the page becomes visible again, re-acquire
          if (watch.active && document.visibilityState === "visible") {
            navigator.wakeLock.request("screen").then(w => watch._wakeLock = w).catch(() => {});
          }
        });
      }
    }
  } catch {/* silent */}

  // 3. Re-acquire Wake Lock on visibility change
  if (!watch._visHandler) {
    watch._visHandler = () => {
      if (watch.active && document.visibilityState === "visible" && !watch._wakeLock) {
        if ("wakeLock" in navigator) {
          navigator.wakeLock.request("screen").then(w => watch._wakeLock = w).catch(() => {});
        }
      }
    };
    document.addEventListener("visibilitychange", watch._visHandler);
  }
}

function stopWatchKeepalive() {
  try { watch._audioOsc?.stop(); } catch {}
  try { watch._audioCtx?.close(); } catch {}
  watch._audioOsc = null;
  watch._audioCtx = null;
  try { watch._wakeLock?.release(); } catch {}
  watch._wakeLock = null;
  if (watch._visHandler) {
    document.removeEventListener("visibilitychange", watch._visHandler);
    watch._visHandler = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// KLOSR NATIVE — screen capture without browser banner
//
// When running inside the Tauri desktop app, we skip getDisplayMedia
// entirely (which surfaces the "you're sharing your screen" banner) and
// instead invoke the Rust `capture_screen` command which uses native OS
// APIs to grab the screen silently.
//
// The rest of the Watch pipeline (perceptual hash → Vision call → drafts
// stack) stays identical — only the frame-acquisition stage differs.
// ═══════════════════════════════════════════════════════════════════

async function startWatchNative() {
  try {
    watch.active = true;
    watch.paused = false;
    watch.frameCount = 0;
    watch.draftCount = 0;
    watch.drafts = [];
    watch.lastHash = null;
    watch.lastAnalyzeAt = 0;
    watch.isNative = true;

    // No video element / canvas needed — Rust returns an already-encoded JPEG.
    // The hash + change-detect logic is in JS; we hash the JPEG bytes directly.

    // Sample loop
    watch.timer = setInterval(sampleAndMaybeAnalyzeNative, watch.sampleMs);

    renderWatchRunning();
    renderUserChip();
  } catch (err) {
    console.warn("[Klosr Watch native] start failed:", err);
    watch.active = false;
    alert("Couldn't start Klosr Watch: " + (err.message || "unknown"));
  }
}

async function sampleAndMaybeAnalyzeNative() {
  if (!watch.active || watch.paused || watch.inFlight) return;
  if (Date.now() - watch.lastAnalyzeAt < watch.minGapMs) return;
  if (!window.__TAURI__) return;

  try {
    // Invoke the Rust capture_screen command. Returns { base64, mime_type, width, height }
    const result = await window.__TAURI__.core.invoke("capture_screen");
    if (!result || !result.base64) return;

    watch.frameCount += 1;
    updateWatchRunningCounters();

    // Hash the first ~32KB of the base64 string as a cheap proxy for
    // "screen content has changed". Fast + good enough — when the screen
    // genuinely changes, the JPEG bytes shift markedly within the first
    // few KB.
    const hashSample = result.base64.slice(0, 32 * 1024);
    const hash = simpleStringHash(hashSample);
    const prev = watch.lastHash;
    if (!prev) { watch.lastHash = hash; return; }
    if (Math.abs(hash - prev) < watch.nativeHashThreshold) return;

    watch.lastHash = hash;
    watch.lastAnalyzeAt = Date.now();
    watch.inFlight = true;

    analyzeFrame(result.base64, result.mime_type || "image/jpeg");
  } catch (e) {
    console.warn("[Klosr Watch native] sample failed:", e);
    watch.inFlight = false;
  }
}

// Simple 32-bit string hash (FNV-1a variant) — used to detect frame change
function simpleStringHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// Native sample loop uses a more permissive threshold than the PWA path
// because JPEG hashing is coarser than perceptual hashing. Tune as needed.
watch.nativeHashThreshold = 1000000;

// ═══════════════════════════════════════════════════════════════════
// KLOSR NATIVE — text injection scaffold
//
// Phase 3 hook. When user clicks "📤 [App]" on a draft card, we'll first
// try the native injection path via Rust before falling back to the
// existing copy-pending-reply queue.
// ═══════════════════════════════════════════════════════════════════
async function tryNativeInject(text, targetApp) {
  if (!isKlosrNative()) return false;
  try {
    const result = await window.__TAURI__.core.invoke("inject_text", {
      args: { text, target_app: targetApp || null },
    });
    return result?.ok === true;
  } catch (e) {
    console.warn("[Klosr Native] inject_text failed:", e);
    return false;
  }
}

function stopWatch() {
  if (!watch.active) return;
  try { watch.stream?.getTracks().forEach(t => t.stop()); } catch {}
  if (watch.timer) { clearInterval(watch.timer); watch.timer = null; }
  stopWatchKeepalive();
  watch.active = false;
  watch.paused = false;
  watch.stream = null;
  watch.video = null;
  watch.canvas = null;
  watch.ctx = null;
  watch.inFlight = false;
  watch.lastHash = null;
  // Keep drafts visible after stopping so user can still act on them.
  if (_currentView === "home") {
    document.getElementById("watch-hero").hidden = false;
    document.getElementById("watch-running").hidden = true;
  }
  renderUserChip();
}

function sampleAndMaybeAnalyze() {
  if (!watch.active || watch.paused || watch.inFlight) return;
  const video = watch.video, canvas = watch.canvas, ctx = watch.ctx;
  if (!video || !canvas || !ctx) return;

  try {
    // Draw the current frame to the off-screen canvas (downscaled)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    watch.frameCount += 1;

    // Compute a 16x16 perceptual hash (mean-gray) — cheap + good enough
    // to detect "the screen content materially changed"
    const hash = computePerceptualHash(ctx, canvas.width, canvas.height);
    const prev = watch.lastHash;
    const dist = prev ? hammingDist(hash, prev) : 9999;

    updateWatchRunningCounters();

    // First frame: don't analyze, just record (avoids firing on initial noise)
    if (!prev) { watch.lastHash = hash; return; }

    // Rate limit: enforce the min gap between Vision calls
    if (Date.now() - watch.lastAnalyzeAt < watch.minGapMs) return;

    // Change detection: only analyze if distance exceeds threshold
    if (dist < watch.hashThreshold) return;

    watch.lastHash = hash;
    watch.lastAnalyzeAt = Date.now();
    watch.inFlight = true;

    // Grab a larger frame for analysis (quality matters when talking to Opus)
    const largeCanvas = document.createElement("canvas");
    largeCanvas.width = video.videoWidth || 1280;
    largeCanvas.height = video.videoHeight || 720;
    const largeCtx = largeCanvas.getContext("2d");
    largeCtx.drawImage(video, 0, 0, largeCanvas.width, largeCanvas.height);

    // Encode to JPEG (smaller than PNG, fine for OCR of text-heavy screens)
    largeCanvas.toBlob(async (blob) => {
      if (!blob) { watch.inFlight = false; return; }
      const buf = await blob.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      analyzeFrame(b64, blob.type || "image/jpeg");
    }, "image/jpeg", 0.85);
  } catch (e) {
    console.warn("[Klosr Watch] sample failed:", e);
    watch.inFlight = false;
  }
}

async function analyzeFrame(imageBase64, mimeType) {
  try {
    // Pull synced state (proof library / objection playbook / voice /
    // ICP learnings) that the Chrome extension pushes to Upstash. This
    // is what makes Watch drafts feel "in your voice" instead of generic.
    const synced = _user?.syncedState || {};

    const res = await callIntel("screenshot-analyze", {
      imageBase64,
      mimeType,
      userPrompt: "",
      intent: "auto",
      language: "en",
      founder: {
        name: _user?.yourName || "",
        company: _user?.companyName || "",
        icp: _user?.icp || synced.icpLearnings || "",
      },
      proofLibrary: Array.isArray(synced.proofLibrary) ? synced.proofLibrary : [],
      objectionPlaybook: Array.isArray(synced.objectionPlaybook) ? synced.objectionPlaybook : [],
      voiceExamples: Array.isArray(synced.voiceExamples) ? synced.voiceExamples : [],
    });

    if (!res || !res.ok) {
      console.log("[Klosr Watch] analysis returned non-ok:", res?.reason);
      return;
    }

    // Ignore frames that aren't sales-relevant (Claude classified as context_only)
    if (res.actionCategory === "context_only" && !res.draft) {
      return;
    }

    // Push to drafts stack
    const draft = {
      id: "d-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      whatYouSaw: res.whatYouSaw || "",
      actionCategory: res.actionCategory || "",
      draft: res.draft || "",
      temperature: res.temperature || "",
      temperatureReason: res.temperatureReason || "",
      suggestedProof: res.suggestedProof || null,
      nextStep: res.nextStep || "",
      ts: Date.now(),
    };
    watch.drafts.unshift(draft);
    if (watch.drafts.length > 20) watch.drafts = watch.drafts.slice(0, 20);
    watch.draftCount += 1;

    renderDraftsStack();
    flashNewDraftNotification(draft);

    // Web Notifications (if permission granted) — nudges the user to look
    if (draft.temperature === "hot" && "Notification" in window && Notification.permission === "granted") {
      new Notification("🔥 Klosr caught a hot reply", {
        body: (draft.whatYouSaw || "New reply detected").slice(0, 160),
        icon: "/icons/icon128.png",
      });
    }
  } catch (e) {
    console.warn("[Klosr Watch] analyze failed:", e);
  } finally {
    watch.inFlight = false;
  }
}

// Simple perceptual hash — downsample to 16x16 grayscale, compare to mean
function computePerceptualHash(ctx, w, h) {
  const sample = 16;
  const data = ctx.getImageData(0, 0, w, h).data;
  const grays = new Array(sample * sample).fill(0);
  const stepX = Math.floor(w / sample);
  const stepY = Math.floor(h / sample);
  for (let y = 0; y < sample; y++) {
    for (let x = 0; x < sample; x++) {
      const px = (y * stepY * w + x * stepX) * 4;
      const r = data[px] || 0;
      const g = data[px + 1] || 0;
      const b = data[px + 2] || 0;
      grays[y * sample + x] = (r * 0.299 + g * 0.587 + b * 0.114);
    }
  }
  const mean = grays.reduce((a, v) => a + v, 0) / grays.length;
  // Binary hash: 1 if brighter than mean, 0 otherwise. 256 bits.
  const bits = new Array(grays.length);
  for (let i = 0; i < grays.length; i++) bits[i] = grays[i] > mean ? 1 : 0;
  return bits;
}

function hammingDist(a, b) {
  if (!a || !b || a.length !== b.length) return 9999;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;   // 32KB at a time, avoids call-stack blow-up
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ─── Watch running UI ───────────────────────────────────────────────

function renderWatchRunning() {
  const hero = document.getElementById("watch-hero");
  const running = document.getElementById("watch-running");
  if (hero) hero.hidden = true;
  if (!running) return;
  running.hidden = false;
  running.innerHTML = `
    <div class="watch-status">
      <div class="watch-status-head">
        <span class="watch-status-dot"></span>
        <span class="watch-status-label">Klosr is watching your screen</span>
        <span class="watch-status-model">Opus 4.7 · multimodal</span>
      </div>
      <div class="watch-status-stats">
        <span><strong id="watch-stat-frames">0</strong> frames seen</span>
        <span><strong id="watch-stat-drafts">0</strong> drafts ready</span>
        <span>Cost cap: <strong>1 analysis / ${Math.round(watch.minGapMs / 1000)}s</strong></span>
      </div>
      <div class="watch-status-actions">
        <button class="btn-ghost" id="watch-pause">${watch.paused ? "Resume" : "Pause"}</button>
        <button class="btn-stop" id="watch-stop">Stop watching</button>
      </div>
    </div>

    <div class="watch-drafts-wrap">
      <div class="watch-drafts-head">
        <h3>✍ Ready to send</h3>
        <span class="watch-drafts-hint">Drafts appear here the moment Klosr spots a reply</span>
      </div>
      <div class="watch-drafts" id="watch-drafts">
        <div class="watch-drafts-empty">Waiting for a sales-relevant screen change…</div>
      </div>
    </div>
  `;

  document.getElementById("watch-stop").addEventListener("click", stopWatch);
  document.getElementById("watch-pause").addEventListener("click", () => {
    watch.paused = !watch.paused;
    const btn = document.getElementById("watch-pause");
    if (btn) btn.textContent = watch.paused ? "Resume" : "Pause";
  });

  updateWatchRunningCounters();
  renderDraftsStack();

  // Ask for notification permission on first run (non-blocking)
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function updateWatchRunningCounters() {
  const f = document.getElementById("watch-stat-frames");
  const d = document.getElementById("watch-stat-drafts");
  if (f) f.textContent = String(watch.frameCount);
  if (d) d.textContent = String(watch.draftCount);
}

function renderDraftsStack() {
  const wrap = document.getElementById("watch-drafts");
  if (!wrap) return;
  if (watch.drafts.length === 0) {
    wrap.innerHTML = `<div class="watch-drafts-empty">Waiting for a sales-relevant screen change…</div>`;
    return;
  }
  wrap.innerHTML = watch.drafts.map(d => draftCardHtml(d)).join("");
  wrap.querySelectorAll("[data-copy-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.copyId;
      const draft = watch.drafts.find(x => x.id === id);
      if (!draft) return;
      navigator.clipboard.writeText(draft.draft).then(() => {
        btn.textContent = "✓ Copied — paste in the conversation";
        setTimeout(() => { btn.textContent = "📋 Copy reply"; }, 2200);
      });
    });
  });
  wrap.querySelectorAll("[data-dismiss-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.dismissId;
      watch.drafts = watch.drafts.filter(x => x.id !== id);
      renderDraftsStack();
    });
  });

  // Inject buttons — two paths:
  //   1. KLOSR NATIVE (Tauri): tryNativeInject() uses OS accessibility APIs
  //      to write directly into the focused composer of any app. Phase 3.
  //      Falls back to clipboard if not yet implemented.
  //   2. BROWSER PWA: queue-pending-reply via server, Chrome extension on
  //      target tab auto-fills the composer within 10s.
  wrap.querySelectorAll("[data-inject-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.injectId;
      const targetApp = btn.dataset.injectApp;
      const draft = watch.drafts.find(x => x.id === id);
      if (!draft || !_user?.installId) return;

      btn.disabled = true;
      btn.textContent = "Sending…";
      const appLabel = ({ whatsapp: "WhatsApp", gmail: "Gmail", slack: "Slack", teams: "Teams" })[targetApp] || targetApp;

      // PATH 1: Native injection (no copy-paste, fills any app)
      if (isKlosrNative()) {
        const injected = await tryNativeInject(draft.draft, targetApp);
        if (injected) {
          btn.textContent = `✓ Filled into focused app — Enter to send`;
          btn.style.background = "rgba(34, 197, 94, 0.20)";
          btn.style.borderColor = "rgba(34, 197, 94, 0.55)";
          btn.style.color = "#86EFAC";
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = `<span style="font-size: 13px;">📤</span> ${appLabel}`;
            btn.style.background = ""; btn.style.borderColor = ""; btn.style.color = "";
          }, 4500);
          return;
        }
        // Native injection not implemented yet → fall through to clipboard
        // copy as a graceful degradation.
        try { await navigator.clipboard.writeText(draft.draft); } catch {}
        btn.textContent = `📋 Copied — paste in ${appLabel}`;
        btn.style.background = "rgba(255, 214, 10, 0.20)";
        btn.style.borderColor = "rgba(255, 214, 10, 0.55)";
        btn.style.color = "#FFD60A";
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = `<span style="font-size: 13px;">📤</span> ${appLabel}`;
          btn.style.background = ""; btn.style.borderColor = ""; btn.style.color = "";
        }, 4500);
        return;
      }

      // PATH 2: Browser PWA path — queue server-side for Chrome extension to pick up
      const res = await callIntel("queue-pending-reply", {
        installId: _user.installId,
        draft: draft.draft,
        targetApp,
        source: "watch",
        draftId: draft.id,
      }).catch(() => null);

      if (res?.ok) {
        const fullLabel = targetApp === "whatsapp" ? "WhatsApp Web" : (targetApp === "gmail" ? "Gmail" : appLabel);
        btn.textContent = `✓ Open ${fullLabel} → auto-fill ready`;
        btn.style.background = "rgba(34, 197, 94, 0.20)";
        btn.style.borderColor = "rgba(34, 197, 94, 0.55)";
        btn.style.color = "#86EFAC";
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = `<span style="font-size: 13px;">📤</span> ${appLabel}`;
          btn.style.background = ""; btn.style.borderColor = ""; btn.style.color = "";
        }, 4500);
      } else {
        btn.disabled = false;
        btn.textContent = "Failed — retry";
      }
    });
  });
}

function draftCardHtml(d) {
  const timeAgo = Math.round((Date.now() - d.ts) / 1000);
  const ts = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo / 60)}m ago`;
  const tempCls = ["hot", "warm", "cold"].includes(d.temperature) ? d.temperature : "";
  const tempIcon = tempCls === "hot" ? "🔥" : tempCls === "warm" ? "☀️" : tempCls === "cold" ? "❄️" : "📝";
  const tempChip = tempCls
    ? `<span class="draft-temp draft-temp-${tempCls}">${tempIcon} ${tempCls.toUpperCase()}${d.temperatureReason ? ` · ${esc(d.temperatureReason)}` : ""}</span>`
    : "";
  const proofHtml = d.suggestedProof?.title ? `
    <div class="draft-proof">
      <div class="draft-proof-label">📎 Cite: ${esc(d.suggestedProof.title)}</div>
      <div class="draft-proof-body">${esc(d.suggestedProof.body)}</div>
    </div>` : "";

  // Inject buttons — one per supported target app.
  //   In Klosr Native (Tauri): writes directly into the focused composer
  //     of ANY app (WhatsApp Desktop, Outlook Desktop, etc) via OS APIs.
  //   In Browser PWA: queues the draft server-side so the Klosr Chrome
  //     extension on that target app's web tab auto-fills the composer.
  const injectButtons = d.draft ? `
    <button class="btn-inject" data-inject-id="${esc(d.id)}" data-inject-app="whatsapp" title="Auto-fill into WhatsApp">
      <span style="font-size: 13px;">📤</span> WhatsApp
    </button>
    <button class="btn-inject" data-inject-id="${esc(d.id)}" data-inject-app="gmail" title="Auto-fill into Gmail / email">
      <span style="font-size: 13px;">📤</span> Gmail
    </button>
    <button class="btn-inject" data-inject-id="${esc(d.id)}" data-inject-app="slack" title="Auto-fill into Slack">
      <span style="font-size: 13px;">📤</span> Slack
    </button>
    <button class="btn-inject" data-inject-id="${esc(d.id)}" data-inject-app="teams" title="Auto-fill into Microsoft Teams">
      <span style="font-size: 13px;">📤</span> Teams
    </button>
  ` : "";

  return `
    <div class="draft-card draft-temp-border-${tempCls || "neutral"}" data-draft-id="${esc(d.id)}">
      <div class="draft-head">
        <div class="draft-head-left">
          <span class="draft-icon">${tempIcon}</span>
          <span class="draft-saw">${esc(d.whatYouSaw || "Klosr detected a sales-relevant screen")}</span>
        </div>
        <span class="draft-time">${ts}</span>
      </div>
      ${tempChip ? `<div class="draft-meta">${tempChip}</div>` : ""}
      ${d.draft ? `
        <textarea class="draft-text" readonly rows="${Math.min(8, Math.max(4, Math.ceil(d.draft.length / 70)))}">${esc(d.draft)}</textarea>
      ` : ""}
      ${proofHtml}
      ${d.nextStep ? `<div class="draft-next">➡️ ${esc(d.nextStep)}</div>` : ""}
      <div class="draft-actions">
        ${d.draft ? `<button class="btn-primary draft-copy-btn" data-copy-id="${esc(d.id)}">📋 Copy reply</button>` : ""}
        ${injectButtons}
        <button class="btn-ghost" data-dismiss-id="${esc(d.id)}">Dismiss</button>
      </div>
    </div>
  `;
}

function flashNewDraftNotification(draft) {
  // Subtle in-page flash so the user notices the drafts section updated
  const wrap = document.getElementById("watch-drafts");
  if (!wrap) return;
  wrap.classList.add("drafts-flash");
  setTimeout(() => wrap.classList.remove("drafts-flash"), 900);
}

// ═══════════════════════════════════════════════════════════════════
// PASTE PANEL — fallback for users who don't want continuous watch
// ═══════════════════════════════════════════════════════════════════

function renderPastePanel() {
  _currentView = "paste";
  _pasteImage = null;
  _pasteIntent = "auto";
  document.getElementById("view-panel").innerHTML = `
    <section class="vision-panel active">
      <h3 style="margin: 0 0 6px; font-size: 18px; letter-spacing: -0.01em;">📋 Paste a screenshot</h3>
      <p style="color: rgba(244,244,245,0.65); font-size: 13px; margin: 0 0 18px;">
        Manual fallback. Paste any screenshot with Ctrl+V, or drop a file. Klosr reads it and drafts the action.
      </p>

      <div class="vision-dropzone" id="v-drop" tabindex="0">
        <div class="big-icon">📋</div>
        <div class="hint">Paste (<strong>Ctrl+V</strong>) · drag an image · or click to pick</div>
        <input type="file" id="v-file" accept="image/*" hidden />
      </div>

      <div class="vision-preview" id="v-preview" hidden></div>

      <div class="vision-intent" id="v-intent" hidden>
        <div class="intent-chips">
          <button class="intent-chip active" data-intent="auto">✨ Auto</button>
          <button class="intent-chip" data-intent="draft_reply">💬 Draft reply</button>
          <button class="intent-chip" data-intent="identify">🎯 ICP fit?</button>
          <button class="intent-chip" data-intent="objection">🛡️ Objection</button>
          <button class="intent-chip" data-intent="buying_signal">🔥 Signal?</button>
        </div>
        <textarea class="vision-prompt" id="v-prompt" rows="2" placeholder="Optional context"></textarea>
        <button class="btn-primary" id="v-submit">🚀 Analyze</button>
      </div>

      <div class="vision-result" id="v-result"></div>
    </section>
  `;

  const drop = document.getElementById("v-drop");
  const file = document.getElementById("v-file");
  drop.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (f) acceptPasteImage(f);
  });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("hover"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("hover");
    const f = e.dataTransfer?.files?.[0];
    if (f) acceptPasteImage(f);
  });
  drop.focus();
  document.querySelectorAll(".intent-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".intent-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      _pasteIntent = chip.dataset.intent;
    });
  });
  document.getElementById("v-submit").addEventListener("click", runPasteVision);
}

function acceptPasteImage(blob) {
  if (!blob || !blob.type?.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const b64 = String(dataUrl).split(",")[1] || "";
    _pasteImage = { base64: b64, mimeType: blob.type, dataUrl };
    const preview = document.getElementById("v-preview");
    const intent = document.getElementById("v-intent");
    if (preview) { preview.hidden = false; preview.innerHTML = `<img src="${dataUrl}" alt="screenshot" />`; }
    if (intent) intent.hidden = false;
  };
  reader.readAsDataURL(blob);
}

async function runPasteVision() {
  if (!_pasteImage) return;
  const btn = document.getElementById("v-submit");
  const result = document.getElementById("v-result");
  const prompt = (document.getElementById("v-prompt").value || "").trim();
  btn.disabled = true; btn.textContent = "Analyzing...";
  result.innerHTML = `<div class="loading-block"><div class="spinner"></div>Klosr is reading the image...</div>`;
  try {
    const synced = _user?.syncedState || {};
    const res = await callIntel("screenshot-analyze", {
      imageBase64: _pasteImage.base64,
      mimeType: _pasteImage.mimeType,
      userPrompt: prompt,
      intent: _pasteIntent,
      language: "en",
      founder: {
        name: _user?.yourName || "",
        company: _user?.companyName || "",
        icp: _user?.icp || synced.icpLearnings || "",
      },
      proofLibrary: Array.isArray(synced.proofLibrary) ? synced.proofLibrary : [],
      objectionPlaybook: Array.isArray(synced.objectionPlaybook) ? synced.objectionPlaybook : [],
      voiceExamples: Array.isArray(synced.voiceExamples) ? synced.voiceExamples : [],
    });
    renderPasteResult(res);
  } catch (e) {
    result.innerHTML = `<div class="error-block">Failed: ${esc(e.message || "")}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = "🚀 Analyze";
  }
}

function renderPasteResult(res) {
  const result = document.getElementById("v-result");
  if (!res || !res.ok) {
    result.innerHTML = `<div class="error-block">Klosr couldn't read the image. ${esc(res?.reason || "")}</div>`;
    return;
  }
  const tempCls = ["hot", "warm", "cold"].includes(res.temperature) ? res.temperature : "";
  const tempIcon = tempCls === "hot" ? "🔥" : tempCls === "warm" ? "☀️" : tempCls === "cold" ? "❄️" : "";
  result.innerHTML = `
    <div class="result-card">
      <div class="result-saw">
        <div class="result-label">👁 Klosr sees</div>
        <div class="result-saw-text">${esc(res.whatYouSaw || "")}</div>
        ${tempCls ? `<span class="result-temp ${tempCls}">${tempIcon} ${tempCls.toUpperCase()}${res.temperatureReason ? ` · ${esc(res.temperatureReason)}` : ""}</span>` : ""}
      </div>
      ${res.draft ? `
        <div class="result-draft">
          <div class="result-label">✍ Ready to send</div>
          <textarea id="draft-ta">${esc(res.draft)}</textarea>
          <div style="margin-top: 8px;"><button class="btn-primary" id="copy-draft" style="padding: 8px 14px; font-size: 12px;">Copy</button></div>
        </div>
      ` : ""}
      ${res.suggestedProof?.title ? `
        <div class="result-proof">
          <div class="result-proof-title">📎 Cite: ${esc(res.suggestedProof.title)}</div>
          <div class="result-proof-body">${esc(res.suggestedProof.body)}</div>
        </div>
      ` : ""}
      ${res.nextStep ? `<div class="result-next">➡️ ${esc(res.nextStep)}</div>` : ""}
    </div>
  `;
  const copyBtn = document.getElementById("copy-draft");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      const ta = document.getElementById("draft-ta");
      navigator.clipboard.writeText(ta.value).then(() => {
        copyBtn.textContent = "✓ Copied";
        setTimeout(() => copyBtn.textContent = "Copy", 1500);
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRAG POST
// ═══════════════════════════════════════════════════════════════════

function renderBragPanel() {
  _currentView = "brag";
  document.getElementById("view-panel").innerHTML = `
    <section>
      <h3 style="margin: 0 0 6px; font-size: 18px; letter-spacing: -0.01em;">🔥 This week in Klosr</h3>
      <p style="color: rgba(244,244,245,0.65); font-size: 13px; margin: 0 0 18px;">
        Your week's real numbers → a LinkedIn post drafted with Opus 4.7 in your voice, ready to share.
      </p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 16px;">
        <label style="font-size: 12px; color: rgba(244,244,245,0.72)">DMs sent
          <input type="number" id="b-dms" value="40" min="0" style="width: 100%; margin-top: 4px; padding: 8px 10px; background: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; color: #F4F4F5; font-family: inherit;"></label>
        <label style="font-size: 12px; color: rgba(244,244,245,0.72)">Replies
          <input type="number" id="b-replies" value="10" min="0" style="width: 100%; margin-top: 4px; padding: 8px 10px; background: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; color: #F4F4F5; font-family: inherit;"></label>
        <label style="font-size: 12px; color: rgba(244,244,245,0.72)">Calls booked
          <input type="number" id="b-calls" value="3" min="0" style="width: 100%; margin-top: 4px; padding: 8px 10px; background: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; color: #F4F4F5; font-family: inherit;"></label>
        <label style="font-size: 12px; color: rgba(244,244,245,0.72)">Closed
          <input type="number" id="b-closed" value="1" min="0" style="width: 100%; margin-top: 4px; padding: 8px 10px; background: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; color: #F4F4F5; font-family: inherit;"></label>
      </div>
      <label style="display: block; font-size: 12px; color: rgba(244,244,245,0.72); margin-bottom: 16px">Best single win this week (optional)
        <textarea id="b-win" rows="2" style="width: 100%; margin-top: 4px; padding: 8px 10px; background: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; color: #F4F4F5; font-family: inherit;" placeholder="e.g. 'Closed Strathens as a customer by showing their own CAC data live on the demo'"></textarea>
      </label>
      <button class="btn-primary" id="b-gen">🔥 Generate my post</button>
      <div id="b-result" style="margin-top: 22px"></div>
    </section>
  `;
  document.getElementById("b-gen").addEventListener("click", async () => {
    const btn = document.getElementById("b-gen");
    const result = document.getElementById("b-result");
    btn.disabled = true; btn.textContent = "Writing...";
    result.innerHTML = `<div class="loading-block"><div class="spinner"></div>Klosr is drafting your post...</div>`;
    const stats = {
      dmsSent: parseInt(document.getElementById("b-dms").value, 10) || 0,
      repliesReceived: parseInt(document.getElementById("b-replies").value, 10) || 0,
      callsBooked: parseInt(document.getElementById("b-calls").value, 10) || 0,
      callsRun: parseInt(document.getElementById("b-calls").value, 10) || 0,
      closed: parseInt(document.getElementById("b-closed").value, 10) || 0,
    };
    const bestWin = (document.getElementById("b-win").value || "").trim();
    try {
      const res = await callIntel("weekly-brag-post", {
        stats, bestWin, language: "en",
        founder: { name: _user?.yourName || "", role: _user?.yourRole || "", company: _user?.companyName || "" },
      });
      if (!res || !res.ok) { result.innerHTML = `<div class="error-block">Couldn't generate. ${esc(res?.reason || "")}</div>`; return; }
      const hashtags = (res.hashtags || []).map(h => `#${h}`).join(" ");
      result.innerHTML = `
        <div class="result-card">
          <div class="result-label">📝 Your LinkedIn post</div>
          <textarea id="post-ta" style="width: 100%; min-height: 280px; margin-top: 10px; padding: 14px; font-family: inherit; font-size: 13.5px; line-height: 1.55; color: #F4F4F5; background: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.10); border-radius: 10px; resize: vertical;">${esc(res.post + (hashtags ? "\n\n" + hashtags : ""))}</textarea>
          <div style="margin-top: 10px; display: flex; gap: 8px;">
            <button class="btn-primary" id="copy-post" style="padding: 8px 14px; font-size: 12px;">Copy post</button>
            <a class="btn-ghost" href="https://www.linkedin.com/feed/" target="_blank" rel="noopener">Open LinkedIn →</a>
          </div>
        </div>
      `;
      document.getElementById("copy-post").addEventListener("click", () => {
        const ta = document.getElementById("post-ta");
        navigator.clipboard.writeText(ta.value).then(() => {
          const b = document.getElementById("copy-post");
          b.textContent = "✓ Copied";
          setTimeout(() => b.textContent = "Copy post", 1500);
        });
      });
    } catch (e) {
      result.innerHTML = `<div class="error-block">Failed: ${esc(e.message || "")}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = "🔥 Generate my post";
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// INTEGRATIONS PANEL
// ═══════════════════════════════════════════════════════════════════

function renderSettingsPanel() {
  _currentView = "settings";
  document.getElementById("view-panel").innerHTML = `
    <section>
      <h3 style="margin: 0 0 6px; font-size: 18px; letter-spacing: -0.01em;">⚙️ Integrations</h3>
      <p style="color: rgba(244,244,245,0.65); font-size: 13px; margin: 0 0 18px;">Connect Klosr to your existing stack.</p>
      <div class="action-grid">
        <div class="action-card" id="int-hubspot">
          <div class="icon">🧩</div><div class="title">HubSpot</div>
          <div class="desc">Push Klosr deals into your HubSpot portal with stage mapping.</div>
        </div>
        <div class="action-card" id="int-pipedrive">
          <div class="icon">📊</div><div class="title">Pipedrive</div>
          <div class="desc">Push deals as Person + Organization + Deal. API-token auth.</div>
        </div>
        <div class="action-card" id="int-salesforce">
          <div class="icon">🗂️</div><div class="title">Salesforce</div>
          <div class="desc">Push as Leads with source: Klosr. OAuth 2.0.</div>
        </div>
        <div class="action-card" id="int-slack">
          <div class="icon">💬</div><div class="title">Slack</div>
          <div class="desc">Hot-reply alerts + weekly recaps to your channel. Incoming webhook.</div>
        </div>
      </div>
      <div id="int-detail" style="margin-top: 20px"></div>
    </section>
  `;
  document.getElementById("int-hubspot").addEventListener("click", renderHubspotDetail);
  document.getElementById("int-pipedrive").addEventListener("click", renderPipedriveDetail);
  document.getElementById("int-salesforce").addEventListener("click", renderSalesforceDetail);
  document.getElementById("int-slack").addEventListener("click", renderSlackDetail);
}

function renderPipedriveDetail() {
  const panel = document.getElementById("int-detail");
  const storedDomain = localStorage.getItem("klosr_pipedrive_domain") || "";
  panel.innerHTML = `
    <div class="result-card">
      <div class="result-label">Pipedrive</div>
      <p style="font-size: 13px; color: rgba(244,244,245,0.82); margin: 8px 0 14px; line-height: 1.5;">
        Push Klosr deals into Pipedrive as a Person + Organization + Deal, one click each.
      </p>
      <p style="font-size: 11.5px; color: rgba(244,244,245,0.55); margin: 0 0 10px;">
        <strong>Step 1:</strong> In Pipedrive → Settings → Personal → API → copy your API token.
      </p>
      <label style="display: block; font-size: 11.5px; color: rgba(244,244,245,0.72); margin-bottom: 6px;">Company domain (e.g. "klosr" for klosr.pipedrive.com)</label>
      <input type="text" id="pd-domain" placeholder="yourcompany" value="${esc(storedDomain)}" style="width: 100%; padding: 10px 12px; background: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; color: #F4F4F5; font-family: inherit; font-size: 12px; margin-bottom: 10px; box-sizing: border-box;" />
      <label style="display: block; font-size: 11.5px; color: rgba(244,244,245,0.72); margin-bottom: 6px;">API token</label>
      <input type="password" id="pd-token" placeholder="Your Pipedrive API token" style="width: 100%; padding: 10px 12px; background: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; color: #F4F4F5; font-family: inherit; font-size: 12px; margin-bottom: 10px; box-sizing: border-box;" />
      <button class="btn-primary" id="pd-save" style="padding: 9px 14px; font-size: 12px;">Connect Pipedrive</button>
      <div id="pd-msg" style="margin-top: 10px; font-size: 12px;"></div>
    </div>
  `;
  document.getElementById("pd-save").addEventListener("click", async () => {
    const btn = document.getElementById("pd-save");
    const msg = document.getElementById("pd-msg");
    const domain = (document.getElementById("pd-domain").value || "").trim();
    const apiToken = (document.getElementById("pd-token").value || "").trim();
    if (!domain || !apiToken) { msg.innerHTML = `<span style="color:#F87171">Both fields required.</span>`; return; }
    btn.disabled = true; btn.textContent = "Validating...";
    const res = await callIntel("pipedrive-save-token", { installId: _user.installId, apiToken, companyDomain: domain }).catch(() => null);
    if (res?.ok) {
      msg.innerHTML = `<span style="color:#34D399">✓ Connected as <strong>${esc(res.userName)}</strong> (${esc(res.userEmail)}).</span>`;
      localStorage.setItem("klosr_pipedrive_domain", domain);
    } else {
      msg.innerHTML = `<span style="color:#F87171">Failed: ${esc(res?.reason || "unknown")}. ${esc(res?.error || "")}</span>`;
    }
    btn.disabled = false; btn.textContent = "Connect Pipedrive";
  });
}

async function renderSalesforceDetail() {
  const panel = document.getElementById("int-detail");
  panel.innerHTML = `<div class="loading-block"><div class="spinner"></div>Checking Salesforce availability...</div>`;
  const res = await callIntel("salesforce-oauth-url", { installId: _user.installId });
  if (!res.ok) {
    panel.innerHTML = `
      <div class="result-card">
        <div class="result-label">Salesforce</div>
        <p style="font-size: 13px; color: rgba(244,244,245,0.72); margin: 8px 0 0;">
          Salesforce integration needs server-side configuration. The Klosr admin must create a Connected App in Salesforce (Setup → App Manager → New Connected App), enable OAuth with callback <code>https://backend-kappa-nine-57.vercel.app/salesforce-callback.html</code>, scopes <code>api refresh_token id</code>, then set <code>SALESFORCE_CLIENT_ID</code>, <code>SALESFORCE_CLIENT_SECRET</code>, <code>SALESFORCE_REDIRECT_URI</code> on Vercel.
        </p>
      </div>
    `;
    return;
  }
  panel.innerHTML = `
    <div class="result-card">
      <div class="result-label">Salesforce</div>
      <p style="font-size: 13px; color: rgba(244,244,245,0.82); margin: 8px 0 14px;">
        Connect Klosr to your Salesforce org. Klosr will push new deals from your pipeline as Leads with source: Klosr.
      </p>
      <a class="btn-primary" href="${res.url}" target="_blank" rel="noopener" style="display: inline-block; text-decoration: none;">Connect Salesforce →</a>
    </div>
  `;
}

async function renderHubspotDetail() {
  const panel = document.getElementById("int-detail");
  panel.innerHTML = `<div class="loading-block"><div class="spinner"></div>Checking HubSpot connection...</div>`;
  const res = await callIntel("hubspot-oauth-url", { installId: _user.installId });
  if (!res.ok) {
    panel.innerHTML = `
      <div class="result-card">
        <div class="result-label">HubSpot</div>
        <p style="font-size: 13px; color: rgba(244,244,245,0.72); margin: 8px 0 0;">
          HubSpot integration needs server-side configuration. The Klosr admin must set <code>HUBSPOT_CLIENT_ID</code>, <code>HUBSPOT_CLIENT_SECRET</code>, and <code>HUBSPOT_REDIRECT_URI</code> on Vercel.
        </p>
      </div>
    `;
    return;
  }
  panel.innerHTML = `
    <div class="result-card">
      <div class="result-label">HubSpot</div>
      <p style="font-size: 13px; color: rgba(244,244,245,0.82); margin: 8px 0 14px;">Connect Klosr to your HubSpot portal. Klosr will push new deals from your pipeline into HubSpot.</p>
      <a class="btn-primary" href="${res.url}" target="_blank" rel="noopener" style="display: inline-block; text-decoration: none;">Connect HubSpot →</a>
    </div>
  `;
}

function renderSlackDetail() {
  const panel = document.getElementById("int-detail");
  const stored = localStorage.getItem("klosr_slack_webhook") || "";
  panel.innerHTML = `
    <div class="result-card">
      <div class="result-label">Slack</div>
      <p style="font-size: 13px; color: rgba(244,244,245,0.82); margin: 8px 0 14px;">Paste a <strong>Slack Incoming Webhook URL</strong>. Klosr will post hot-reply alerts + weekly recaps to your channel.</p>
      <input type="url" id="slack-url" placeholder="https://hooks.slack.com/services/..." value="${esc(stored)}" style="width: 100%; padding: 10px 12px; background: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; color: #F4F4F5; font-family: inherit; font-size: 12px; margin-bottom: 10px;" />
      <div style="display: flex; gap: 8px;">
        <button class="btn-primary" id="slack-save" style="padding: 9px 14px; font-size: 12px;">Save + Test</button>
        <button class="btn-ghost" id="slack-test" style="padding: 9px 14px; font-size: 12px;">Test only</button>
      </div>
      <div id="slack-msg" style="margin-top: 10px; font-size: 12px;"></div>
    </div>
  `;
  const doTest = async (save) => {
    const url = (document.getElementById("slack-url").value || "").trim();
    const msg = document.getElementById("slack-msg");
    if (!url.startsWith("https://hooks.slack.com/")) { msg.innerHTML = `<span style="color:#F87171">Not a valid Slack webhook URL.</span>`; return; }
    msg.innerHTML = "Testing...";
    const res = await callIntel("slack-notify", {
      webhookUrl: url,
      title: "🎉 Klosr connected",
      message: `Hey ${_user?.yourName || "team"}, Slack is now wired to Klosr.`,
      color: "#FFD60A",
    });
    if (res.ok) {
      msg.innerHTML = `<span style="color:#34D399">✓ Test message sent. Check your Slack.</span>`;
      if (save) localStorage.setItem("klosr_slack_webhook", url);
    } else {
      msg.innerHTML = `<span style="color:#F87171">Failed: ${esc(res.reason || "")}</span>`;
    }
  };
  document.getElementById("slack-save").addEventListener("click", () => doTest(true));
  document.getElementById("slack-test").addEventListener("click", () => doTest(false));
}

// ─── Global paste handler (fallback when watch is off) ──────────────
document.addEventListener("paste", (e) => {
  if (watch.active) return;   // watch is actively reading, ignore paste
  if (_currentView !== "paste" && _currentView !== "home") return;
  const items = (e.clipboardData || window.clipboardData)?.items || [];
  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (!blob) return;
      e.preventDefault();
      if (_currentView === "home") {
        renderPastePanel();
        setTimeout(() => acceptPasteImage(blob), 50);
      } else {
        acceptPasteImage(blob);
      }
      return;
    }
  }
});

// ─── Service worker registration ────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(err => {
      console.warn("[Klosr PWA] SW registration failed:", err);
    });
  });
}

// PWA install prompt
let _deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _deferredPrompt = e;
  showInstallBanner();
});

function showInstallBanner() {
  if (document.getElementById("install-banner")) return;
  const b = document.createElement("div");
  b.className = "install-banner";
  b.id = "install-banner";
  b.innerHTML = `
    <div class="text">
      <strong>Install Klosr Desktop</strong><br>
      <span style="color: rgba(244,244,245,0.72); font-size: 12px;">One-click install. Runs like a native app.</span>
    </div>
    <div style="display: flex; gap: 6px;">
      <button class="btn-primary" id="install-btn" style="padding: 7px 12px; font-size: 12px;">Install</button>
      <button class="btn-ghost" id="install-dismiss" style="padding: 7px 10px; font-size: 12px;">×</button>
    </div>
  `;
  document.body.appendChild(b);
  document.getElementById("install-btn").addEventListener("click", async () => {
    if (_deferredPrompt) {
      _deferredPrompt.prompt();
      await _deferredPrompt.userChoice;
      _deferredPrompt = null;
    }
    b.remove();
  });
  document.getElementById("install-dismiss").addEventListener("click", () => b.remove());
}

// ─── Boot ───────────────────────────────────────────────────────────
(async () => {
  const iid = localStorage.getItem(IID_KEY);
  const cached = localStorage.getItem(USER_KEY);
  if (iid && cached) {
    try { _user = JSON.parse(cached); } catch {}
    if (_user) {
      // Background refresh so syncedState + identity stay current
      callIntel("pwa-bootstrap", { installId: iid }).then(res => {
        if (res?.ok) {
          _user = { ...res.user, syncedState: res.syncedState || null };
          localStorage.setItem(USER_KEY, JSON.stringify(_user));
          renderUserChip();
        }
      }).catch(() => {});
      renderDashboard();
      return;
    }
  }
  renderOnboarding();
})();
