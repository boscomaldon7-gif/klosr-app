// Klosr — In-Call Overlay with Live AI Assist
// Runs on Google Meet, Zoom web, and Microsoft Teams. Two modes:
//
//   STATIC MODE (legacy): user picks a prospect from their pipeline;
//   overlay shows objection cues, proof points, "ask Klosr" sidebar.
//
//   LIVE ASSIST MODE (new — Path B): one button flips the overlay into
//   a real-time AI co-pilot:
//     - Tab audio captured via chrome.tabCapture
//     - Streamed to Deepgram via WebSocket (ephemeral token from /api/intel)
//     - Every 10-15s the transcript + prospect context goes to Claude Haiku
//       for structured coaching (current topic, objection detected,
//       commitment captured, next suggestion)
//     - On "End Assist", full transcript goes to Claude Sonnet for a
//       post-call summary + auto-drafted follow-up email.

(function () {
  "use strict";

  // ---- Config -----------------------------------------------------------
  const INTEL_URL = "https://backend-kappa-nine-57.vercel.app/api/intel";
  const HANDLE_REPLY_URL = "https://backend-kappa-nine-57.vercel.app/api/handle-reply";

  // Live-assist cadence — tight 1s tick with content-change gate. We only
  // actually hit Claude when the transcript has meaningfully grown OR the
  // last coach output is >8s stale. This keeps the panel feeling live
  // during active speech without burning credits during silent pauses.
  const COACH_TICK_MS = 1000;          // how often we CHECK for new work
  const COACH_MIN_NEW_WORDS = 5;       // minimum new words before re-coaching
  const COACH_STALE_REFRESH_MS = 8000; // max time before coach re-evaluates even without new speech
  const COACH_MIN_GAP_MS = 900;        // hard floor between Claude calls (rate-limit guardrail)
  const TRANSCRIPT_TRIM_WORDS = 500;   // keep last ~500 words in scrolling buffer

  // Small DOM helper
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const escapeHtml = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // ---- Storage helpers --------------------------------------------------
  const _get = (k) => new Promise((r) => {
    try {
      if (!chrome?.storage?.local) return r(undefined);
      chrome.storage.local.get(k, (d) => r(d ? d[k] : undefined));
    } catch { r(undefined); }
  });

  async function loadCompanyProfile() { return (await _get("prepcall_company")) || null; }

  // Pipeline hook: after a live-assist call ends, push commitments +
  // objections + dealStage onto the prospect's deal record in
  // chrome.storage (shared with the sidebar / pipeline view).
  async function mergeCallOutcomeToDeal({ profileUrl, durationSec, commitments, objections, buyingSignals, dealStage }) {
    if (!profileUrl) return;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get("prepcall_history", (data) => {
          const history = Array.isArray(data && data.prepcall_history) ? data.prepcall_history : [];
          const deal = history.find(p => p.profileUrl === profileUrl);
          if (!deal) { resolve(); return; }

          const now = Date.now();
          // Merge commitments → deal.commitments with dueBy unknown (user can set later)
          if (!Array.isArray(deal.commitments)) deal.commitments = [];
          for (const c of (commitments || [])) {
            const text = (c && c.text) ? String(c.text) : "";
            if (!text) continue;
            // Dedupe against existing
            const dup = deal.commitments.find(x => x && x.text === text);
            if (!dup) deal.commitments.push({ text, ts: c.ts || now, dueBy: null, doneAt: null });
          }
          if (deal.commitments.length > 40) deal.commitments = deal.commitments.slice(-40);

          if (!Array.isArray(deal.objections)) deal.objections = [];
          for (const o of (objections || [])) {
            const text = (o && o.text) ? String(o.text) : "";
            if (!text) continue;
            const dup = deal.objections.find(x => x && x.text === text);
            if (!dup) deal.objections.push({ text, rebuttal: o.rebuttal || "", ts: o.ts || now, resolved: false });
          }
          if (deal.objections.length > 30) deal.objections = deal.objections.slice(-30);

          if (!Array.isArray(deal.buyingSignals)) deal.buyingSignals = [];
          for (const b of (buyingSignals || [])) {
            const text = (b && b.text) ? String(b.text) : "";
            if (!text) continue;
            const dup = deal.buyingSignals.find(x => x && x.text === text);
            if (!dup) deal.buyingSignals.push({ text, strength: b.strength || "medium", ts: b.ts || now });
          }
          if (deal.buyingSignals.length > 20) deal.buyingSignals = deal.buyingSignals.slice(-20);

          if (!Array.isArray(deal.activities)) deal.activities = [];
          deal.activities.push({ type: "call", ts: now, metadata: { durationSec, platform } });
          if (deal.activities.length > 80) deal.activities = deal.activities.slice(-80);

          deal.callsHad = (deal.callsHad || 0) + 1;
          deal.totalCallSeconds = (deal.totalCallSeconds || 0) + (Number(durationSec) || 0);
          deal.lastActivityAt = now;
          deal.savedAt = now;
          // Only advance the stage forward from what the coach inferred.
          if (dealStage) {
            deal.dealStage = dealStage;
            deal.stage = dealStage;
          }

          chrome.storage.local.set({ prepcall_history: history }, () => resolve());
        });
      } catch { resolve(); }
    });
  }

  // Telemetry beacon — mirrors content.js logKlosrEvent. Reads the install
  // UUID from chrome.storage (set by content.js on first boot) and attaches
  // founder identity if onboarding has been completed.
  async function logKlosrOverlayEvent(event, metadata) {
    try {
      const installId = await _get("klosr_install_id");
      if (!installId || !event) return;
      const cp = await loadCompanyProfile();
      const userMeta = (cp && (cp.yourName || cp.companyName || cp.email)) ? {
        email: cp.email || "",
        yourName: cp.yourName || "",
        yourRole: cp.yourRole || "",
        companyName: cp.companyName || "",
        icp: (cp.icp || "").slice(0, 200),
      } : null;
      fetch("https://backend-kappa-nine-57.vercel.app/api/intel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "log-event",
          params: { installId, event, metadata: metadata || {}, userMeta },
        }),
      }).catch(() => {});
    } catch {/* silent */}
  }
  async function loadPipeline()       { return (await _get("prepcall_history")) || []; }
  async function loadPlaybook()       { return (await _get("klosr_objection_playbook")) || []; }
  async function loadProofLibrary()   { return (await _get("klosr_proof_library")) || []; }
  async function loadVoiceExamples()  { return (await _get("klosr_voice_diffs")) || []; }
  async function loadICP()            { return (await _get("klosr_icp_learnings")) || null; }
  async function loadCallNotesAll()   { return (await _get("klosr_call_notes")) || []; }

  // ---- Detection -------------------------------------------------------
  function detectPlatform() {
    const h = location.hostname;
    if (h.includes("meet.google.com")) return "meet";
    if (h.includes("zoom.us")) return "zoom";
    if (h.includes("teams.microsoft.com") || h.includes("teams.live.com")) return "teams";
    return null;
  }

  // ---- State -----------------------------------------------------------
  let platform = null;
  let overlay = null;
  let currentProspect = null;
  let _minimized = false;

  // Live Assist state
  const live = {
    active: false,
    mediaStream: null,
    mediaRecorder: null,
    ws: null,
    startTime: 0,
    transcript: [],                 // [{ text, speaker, isFinal, ts }]
    coachTimer: null,
    coachLastRun: 0,
    coachInFlight: false,
    coachLatest: null,
    coachLastWordCount: 0,
    commitments: [],
    objections: [],
    buyingSignals: [],              // [{ text, strength, ts }]
    competitorsHeard: new Set(),    // unique competitor names detected
    customersHeard: new Set(),      // unique customer names detected
    priorDealStage: "",             // feed to next coach call so Claude can track progression
    lastInterim: "",
    // Diarization state
    speakerWordCounts: {},          // { "0": 42, "1": 87 } — for talk ratio
    userSpeakerIdx: null,           // which speaker index is "You" (null = unknown → default to speaker 1 by SDR convention: prospect usually opens)
    firstSpeakerSeen: null,         // first speaker index encountered — used for auto-labelling
  };

  function transcriptWordCount() {
    return live.transcript.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
  }

  // Label a speaker index for UI + Claude. We default to:
  //   - first speaker heard → "Prospect" (they typically say "hello" first
  //     when the founder joins their room)
  //   - second speaker → "You"
  // User can flip with a one-click toggle in the overlay.
  function labelForSpeaker(speakerIdx) {
    if (speakerIdx === undefined || speakerIdx === null) return "Speaker";
    if (live.userSpeakerIdx === null) {
      // Auto-default before user confirms: first speaker = prospect.
      if (live.firstSpeakerSeen === speakerIdx) return "Prospect";
      return "You";
    }
    return speakerIdx === live.userSpeakerIdx ? "You" : "Prospect";
  }

  function talkRatio() {
    const counts = live.speakerWordCounts || {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return { you: 0, prospect: 0, total: 0 };
    let youWords = 0, prospectWords = 0;
    for (const [idx, count] of Object.entries(counts)) {
      const speakerIdx = Number(idx);
      const label = labelForSpeaker(speakerIdx);
      if (label === "You") youWords += count;
      else prospectWords += count;
    }
    return {
      you: youWords / total,
      prospect: prospectWords / total,
      total,
    };
  }

  // Shallow equality for coach responses so we skip redundant re-renders
  // when Claude returns the same insight two ticks in a row. Keeps the UI
  // stable and prevents "flicker" while still feeling live.
  function coachEqual(a, b) {
    if (!a || !b) return false;
    return a.currentTopic === b.currentTopic
        && a.nextSuggestion === b.nextSuggestion
        && a.objectionText === b.objectionText
        && a.objectionRebuttal === b.objectionRebuttal
        && a.commitmentCaptured === b.commitmentCaptured
        && a.dealStage === b.dealStage
        && a.buyingSignal === b.buyingSignal
        && a.competitorMentioned === b.competitorMentioned
        && a.customerMentioned === b.customerMentioned
        && a.pacingAdvice === b.pacingAdvice
        && JSON.stringify(a.theyllAskNext || []) === JSON.stringify(b.theyllAskNext || [])
        && (a.proofToCite && a.proofToCite.title) === (b.proofToCite && b.proofToCite.title)
        && a.insight === b.insight;
  }

  // ---- Overlay mount --------------------------------------------------
  function mountOverlay() {
    if (overlay) return;
    overlay = el("div", "klosr-overlay");
    overlay.innerHTML = `
      <div class="klosr-overlay-drag" id="klosr-drag">
        <div class="klosr-overlay-badge">K</div>
        <div class="klosr-overlay-title">Klosr <span id="klosr-overlay-prospect"></span></div>
        <div class="klosr-live-status" id="klosr-live-status" hidden>
          <span class="klosr-rec-dot"></span>
          <span id="klosr-rec-timer">0:00</span>
        </div>
        <div class="klosr-overlay-ctrls">
          <button class="klosr-overlay-btn klosr-live-toggle" id="klosr-live-toggle" title="Start Live AI Assist">▶ Live</button>
          <button class="klosr-overlay-btn" id="klosr-min" title="Minimise">—</button>
          <button class="klosr-overlay-btn" id="klosr-close" title="Close">×</button>
        </div>
      </div>
      <div class="klosr-overlay-body" id="klosr-body"></div>
    `;
    document.body.appendChild(overlay);
    enableDrag(overlay, overlay.querySelector("#klosr-drag"));

    overlay.querySelector("#klosr-min").addEventListener("click", () => {
      _minimized = !_minimized;
      overlay.classList.toggle("klosr-min", _minimized);
    });
    overlay.querySelector("#klosr-close").addEventListener("click", () => {
      if (live.active) stopLiveAssist();
      overlay.remove();
      overlay = null;
    });
    overlay.querySelector("#klosr-live-toggle").addEventListener("click", () => {
      if (live.active) stopLiveAssist();
      else startLiveAssist();
    });

    renderBody();
  }

  function enableDrag(panel, handle) {
    let startX = 0, startY = 0, startL = 0, startT = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".klosr-overlay-btn")) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startL = rect.left; startT = rect.top;
      panel.style.transition = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const l = Math.max(8, Math.min(window.innerWidth - 340, startL + (e.clientX - startX)));
      const t = Math.max(8, Math.min(window.innerHeight - 80, startT + (e.clientY - startY)));
      panel.style.left = l + "px";
      panel.style.top = t + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    document.addEventListener("mouseup", () => {
      if (dragging) { dragging = false; panel.style.transition = ""; }
    });
  }

  function setProspectLabel() {
    const el2 = document.getElementById("klosr-overlay-prospect");
    if (!el2) return;
    el2.textContent = currentProspect ? `· ${currentProspect.name}` : "";
  }

  async function renderBody() {
    const body = document.getElementById("klosr-body");
    if (!body) return;
    setProspectLabel();
    if (live.active) { renderLiveAssist(); return; }
    if (!currentProspect) { await renderProspectPicker(); return; }
    renderCues();
  }

  // ---- Prospect picker (static mode) ----------------------------------
  async function renderProspectPicker() {
    const body = document.getElementById("klosr-body");
    const company = await loadCompanyProfile();
    const history = await loadPipeline();

    if (!company || !company.yourName) {
      body.innerHTML = `
        <div class="klosr-empty">
          <div class="klosr-empty-title">Set up Klosr first</div>
          <div class="klosr-empty-sub">Open Klosr on your LinkedIn profile and finish onboarding, then come back to the call.</div>
        </div>
      `;
      return;
    }
    if (!history || history.length === 0) {
      body.innerHTML = `
        <div class="klosr-empty">
          <div class="klosr-empty-title">No prospects yet</div>
          <div class="klosr-empty-sub">Prep a profile on LinkedIn first, then pick them here before the call.</div>
        </div>
      `;
      return;
    }

    const rows = history.slice(0, 20).map(p => `
      <button class="klosr-picker-row" data-url="${escapeHtml(p.profileUrl || "")}">
        <div class="klosr-picker-avatar">${escapeHtml((p.name || "?").trim().charAt(0).toUpperCase())}</div>
        <div class="klosr-picker-info">
          <div class="klosr-picker-name">${escapeHtml(p.name || "")}</div>
          ${p.headline ? `<div class="klosr-picker-headline">${escapeHtml(p.headline).slice(0, 80)}</div>` : ""}
        </div>
      </button>
    `).join("");

    body.innerHTML = `
      <div class="klosr-picker">
        <div class="klosr-picker-title">Who's on this call?</div>
        <div class="klosr-picker-sub">Pick from your pipeline to load cues — or hit ▶ Live above to start AI assist without a prospect.</div>
        <div class="klosr-picker-list">${rows}</div>
      </div>
    `;
    body.querySelectorAll(".klosr-picker-row").forEach(btn => {
      btn.addEventListener("click", () => {
        const url = btn.dataset.url;
        const match = history.find(p => (p.profileUrl || "") === url);
        if (match) { currentProspect = match; renderBody(); }
      });
    });
  }

  // ---- Static cues (legacy mode) --------------------------------------
  async function renderCues() {
    const body = document.getElementById("klosr-body");
    body.innerHTML = `<div class="klosr-loading">Loading your cue cards…</div>`;

    const [playbook, proof, icpObj, notesAll] = await Promise.all([
      loadPlaybook(), loadProofLibrary(), loadICP(), loadCallNotesAll(),
    ]);

    const pbEntries = (Array.isArray(playbook) ? playbook : []).slice(-8).reverse();
    const proofEntries = Array.isArray(proof) ? proof : [];
    const icpSummary = (icpObj && icpObj.icpSummary) || "";
    const prospectCompany = (currentProspect.currentCompany || currentProspect.company || "").toLowerCase();
    const similarNotes = (Array.isArray(notesAll) ? notesAll : []).filter(n => {
      if (!n) return false;
      if ((n.profileUrl || "") === currentProspect.profileUrl) return true;
      const c = (n.company || "").toLowerCase();
      return c && prospectCompany && c === prospectCompany;
    }).slice(0, 3);

    const pbHtml = pbEntries.length === 0
      ? `<div class="klosr-cue-empty">No objections logged yet.</div>`
      : pbEntries.map(x => `
        <div class="klosr-cue-row">
          <div class="klosr-cue-trig">"${escapeHtml((x.trigger || "").slice(0, 160))}"</div>
          <div class="klosr-cue-resp">${escapeHtml((x.rebuttal || "").slice(0, 320))}</div>
        </div>
      `).join("");
    const proofHtml = proofEntries.length === 0
      ? `<div class="klosr-cue-empty">No proof points yet.</div>`
      : proofEntries.slice(0, 6).map(p => `
        <div class="klosr-cue-row klosr-cue-proof">
          ${p.title ? `<div class="klosr-cue-title">${escapeHtml(p.title)}</div>` : ""}
          ${p.metric ? `<div class="klosr-cue-metric">${escapeHtml(p.metric)}</div>` : ""}
          <div class="klosr-cue-body">${escapeHtml((p.body || "").slice(0, 240))}</div>
        </div>
      `).join("");
    const notesHtml = similarNotes.length === 0 ? ""
      : `<div class="klosr-cue-section-title">From similar calls</div>` + similarNotes.map(n => `
        <div class="klosr-cue-row klosr-cue-note">
          ${n.name ? `<div class="klosr-cue-title">${escapeHtml(n.name)}${n.company ? " · " + escapeHtml(n.company) : ""}</div>` : ""}
          ${n.keyInsights ? `<div class="klosr-cue-body">${escapeHtml(n.keyInsights.slice(0, 240))}</div>` : ""}
        </div>
      `).join("");

    body.innerHTML = `
      <div class="klosr-cues">
        <div class="klosr-cue-tabs">
          <button class="klosr-tab klosr-tab-active" data-tab="objections">Objections</button>
          <button class="klosr-tab" data-tab="proof">Proof</button>
          <button class="klosr-tab" data-tab="ask">Ask Klosr</button>
        </div>
        <div class="klosr-tab-panel" data-panel="objections">
          ${icpSummary ? `<div class="klosr-icp-chip">Your real ICP: ${escapeHtml(icpSummary.slice(0, 220))}</div>` : ""}
          ${pbHtml}
          ${notesHtml}
        </div>
        <div class="klosr-tab-panel" data-panel="proof" hidden>${proofHtml}</div>
        <div class="klosr-tab-panel" data-panel="ask" hidden>
          <div class="klosr-ask-wrap">
            <input type="text" class="klosr-ask-input" id="klosr-ask-input" placeholder="Type what they just said — get a one-line response" />
            <button class="klosr-ask-btn" id="klosr-ask-btn">Ask</button>
          </div>
          <div class="klosr-ask-result" id="klosr-ask-result"></div>
        </div>
      </div>
      <div class="klosr-foot">
        <button class="klosr-foot-btn" id="klosr-switch">Switch prospect</button>
      </div>
    `;
    body.querySelectorAll(".klosr-tab").forEach(t => {
      t.addEventListener("click", () => {
        body.querySelectorAll(".klosr-tab").forEach(x => x.classList.remove("klosr-tab-active"));
        t.classList.add("klosr-tab-active");
        const which = t.dataset.tab;
        body.querySelectorAll(".klosr-tab-panel").forEach(p => { p.hidden = p.dataset.panel !== which; });
      });
    });
    const sw = document.getElementById("klosr-switch");
    if (sw) sw.addEventListener("click", () => { currentProspect = null; renderBody(); });

    const askBtn = document.getElementById("klosr-ask-btn");
    const askInput = document.getElementById("klosr-ask-input");
    const askRes = document.getElementById("klosr-ask-result");
    const runAsk = async () => {
      const text = (askInput.value || "").trim();
      if (!text) return;
      askRes.innerHTML = `<div class="klosr-loading">Thinking…</div>`;
      askBtn.disabled = true;
      try {
        const [cp, voice, icp2, playbook2, proof2] = await Promise.all([
          loadCompanyProfile(), loadVoiceExamples(), loadICP(), loadPlaybook(), loadProofLibrary(),
        ]);
        const richSender = {
          name: (cp && cp.yourName) || "", role: (cp && cp.yourRole) || "",
          company: (cp && cp.companyName) || "", context: (cp && cp.whatYouSell) || "",
          valueProp: (cp && cp.valueProp) || "", icp: (cp && cp.icp) || "",
          tone: (cp && cp.tone) || "", proofPoints: (cp && cp.proofPoints) || "",
          background: (cp && cp.background) || "", calendlyUrl: (cp && cp.calendlyUrl) || "",
          claudeMemoryRaw: (cp && cp.claudeMemoryRaw) || "", voiceExamples: voice || [],
          icpLearnings: (icp2 && icp2.icpSummary) || "", objectionPlaybook: playbook2 || [],
          proofLibrary: proof2 || [], relevantCallNotes: [],
        };
        const res = await fetch(HANDLE_REPLY_URL, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: currentProspect, replyText: text, originalOutreach: "",
            channel: "linkedin_dm", language: "en", sender: richSender,
          }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const body2 = (data.suggestedReply && data.suggestedReply.body) || "";
        askRes.innerHTML = `
          ${data.summary ? `<div class="klosr-ask-summary">${escapeHtml(data.summary)}</div>` : ""}
          <div class="klosr-ask-body">${escapeHtml(body2)}</div>
          ${data.nextStep ? `<div class="klosr-ask-next">NEXT: ${escapeHtml(data.nextStep)}</div>` : ""}
        `;
      } catch (e) {
        askRes.innerHTML = `<div class="klosr-ask-error">Couldn't answer. Try again.</div>`;
      } finally { askBtn.disabled = false; }
    };
    if (askBtn) askBtn.addEventListener("click", runAsk);
    if (askInput) askInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runAsk(); } });
  }

  // ═══════════════════════════════════════════════════════════════════
  // LIVE ASSIST
  // ═══════════════════════════════════════════════════════════════════

  // Detects Chrome's activeTab-not-granted error surface. tabCapture
  // requires the user to have explicitly invoked the extension on this
  // tab (clicked the toolbar icon). Content-script-auto-injected tabs
  // don't count as invocation, so the first time a user clicks ▶ Live on
  // a Meet/Zoom/Teams tab we hit this error and need to ask them to click
  // the toolbar icon.
  function isNotInvokedError(msg) {
    return /not been invoked|not invoked|activeTab/i.test(String(msg || ""));
  }

  async function startLiveAssist() {
    logKlosrOverlayEvent("live_assist_started", { platform });
    const body = document.getElementById("klosr-body");
    if (body) body.innerHTML = `<div class="klosr-loading">Starting Live Assist — grabbing tab audio…</div>`;

    // Try the direct sender.tab bridge first. This works when the user
    // has already invoked Klosr on this tab earlier in the session (the
    // activeTab grant from that earlier click is still live). On the
    // common first-run case Chrome returns "Extension has not been
    // invoked..." — we catch that and prompt the user to click the icon,
    // which triggers background.js to fire the streamId back via a
    // `liveStreamIdReady` message we listen for below.
    let streamIdRes;
    try {
      streamIdRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "getTabCaptureStreamId" }, (r) => resolve(r));
      });
    } catch (e) {
      streamIdRes = { error: (e && e.message) || "exception" };
    }

    if (streamIdRes && streamIdRes.streamId) {
      await proceedWithStreamId(streamIdRes.streamId);
      return;
    }

    const errMsg = (streamIdRes && streamIdRes.error) || "unknown";
    if (isNotInvokedError(errMsg)) {
      // Not a real failure — just show the "click the icon" modal and arm
      // the message listener to resume when background.js sends the streamId.
      showIconClickInstruction();
      return;
    }

    // Real failure (Chrome internals page, tab muted, audio device lost…)
    console.error("[Klosr live] streamId request failed:", errMsg);
    if (body) {
      body.innerHTML = `
        <div class="klosr-empty">
          <div class="klosr-empty-title">Couldn't start Live Assist</div>
          <div class="klosr-empty-sub">${escapeHtml(errMsg)}. Make sure you're in the call (not the lobby) and that Klosr has permission to capture tab audio.</div>
          <button class="klosr-foot-btn" id="klosr-live-retry" style="margin-top:12px">Try again</button>
        </div>
      `;
      const retry = document.getElementById("klosr-live-retry");
      if (retry) retry.addEventListener("click", () => startLiveAssist());
    }
    live.active = false;
  }

  // Shows the "click the Klosr toolbar icon" instruction panel. Arms
  // `live.pendingIconClick` so the chrome.runtime.onMessage listener below
  // knows to auto-resume the Live Assist flow when background.js fires
  // liveStreamIdReady.
  function showIconClickInstruction() {
    live.pendingIconClick = true;
    logKlosrOverlayEvent("live_assist_needs_icon_click", { platform });
    const body = document.getElementById("klosr-body");
    if (!body) return;
    body.innerHTML = `
      <div class="klosr-icon-prompt">
        <div class="klosr-icon-prompt-arrow">↗</div>
        <div class="klosr-icon-prompt-title">One click to enable Live Assist</div>
        <div class="klosr-icon-prompt-sub">
          Chrome requires you to click the <strong>Klosr icon</strong> in your
          toolbar before we can capture this call's audio. One-time per tab.
        </div>
        <div class="klosr-icon-prompt-steps">
          <div class="klosr-icon-step"><span class="klosr-icon-step-num">1</span> Click the <strong>🧩 puzzle icon</strong> near your address bar (top-right)</div>
          <div class="klosr-icon-step"><span class="klosr-icon-step-num">2</span> Click <strong>Klosr</strong> (or pin it for next time)</div>
          <div class="klosr-icon-step"><span class="klosr-icon-step-num">3</span> Live Assist will auto-start in ~1 second</div>
        </div>
        <div class="klosr-icon-prompt-waiting">
          <div class="klosr-icon-prompt-spinner"></div>
          <span>Waiting for you to click the Klosr icon…</span>
        </div>
        <button class="klosr-foot-btn" id="klosr-icon-prompt-cancel">Cancel</button>
      </div>
    `;
    const cancelBtn = document.getElementById("klosr-icon-prompt-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", () => {
      live.pendingIconClick = false;
      renderBody();
    });
  }

  // Everything that happens once we have a valid tabCapture streamId,
  // regardless of which path produced it (direct sender.tab request, or
  // icon-click → background.js bridge). Turns streamId into a MediaStream,
  // routes audio back to speakers, opens Deepgram WebSocket, starts
  // MediaRecorder + coach loop.
  async function proceedWithStreamId(streamId) {
    if (live.active) return;   // already running — ignore duplicate streamId
    live.pendingIconClick = false;
    const body = document.getElementById("klosr-body");
    if (body) body.innerHTML = `<div class="klosr-loading">Tab audio acquired — connecting to Deepgram…</div>`;

    try {
      // 1. Turn the streamId into a real MediaStream (tab audio only).
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      });
      live.mediaStream = stream;

      // 2. Critical: chrome.tabCapture by default REPLACES the tab's output
      //    audio — the user would stop hearing the meeting. Route the stream
      //    back to the speakers via a Web Audio source so they still hear
      //    the call while we're also recording it.
      const ac = new AudioContext();
      const src = ac.createMediaStreamSource(stream);
      src.connect(ac.destination);
      live._audioContext = ac;

      // 3. Get an ephemeral Deepgram token from the backend.
      const tokRes = await fetch(INTEL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "realtime-token", params: { ttlSeconds: 3600 } }),
      }).then(r => r.json()).catch(() => ({}));
      if (!tokRes || !tokRes.token) {
        throw new Error("deepgram_token_failed: " + (tokRes?.reason || "unknown"));
      }

      // 4. Open Deepgram WebSocket. Using Opus (from MediaRecorder) for
      //    bandwidth efficiency; Deepgram natively decodes it.
      //    - interim_results=true → partial text shown as they speak
      //    - diarize=true → speaker labels (0, 1, ...) per word
      //    - vad_events=true → voice activity events (speaker turn changes)
      //    - punctuate=true + smart_format=true → readable transcript
      //    - utterance_end_ms=1000 → finals fire after 1s silence (responsive)
      const dgUrl = "wss://api.deepgram.com/v1/listen"
        + "?model=nova-3&smart_format=true&interim_results=true"
        + "&punctuate=true&language=multi"
        + "&diarize=true&utterance_end_ms=1000&vad_events=true";
      const ws = new WebSocket(dgUrl, ["token", tokRes.token]);
      ws.binaryType = "arraybuffer";
      live.ws = ws;

      ws.addEventListener("open", () => {
        // 5. Start MediaRecorder → chunks every 250ms → WS binary frames.
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
        live.mediaRecorder = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0 && ws.readyState === 1) {
            e.data.arrayBuffer().then(buf => ws.send(buf));
          }
        };
        recorder.start(250);
        live.active = true;
        live.startTime = Date.now();
        startRecTimer();
        startCoachLoop();
        renderLiveAssist();
        const btn = document.getElementById("klosr-live-toggle");
        if (btn) { btn.textContent = "■ End"; btn.classList.add("klosr-live-active"); }
        const status = document.getElementById("klosr-live-status");
        if (status) status.hidden = false;
      });

      ws.addEventListener("message", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (!data.channel || !data.channel.alternatives) return;
          const alt = data.channel.alternatives[0] || {};
          const text = (alt.transcript || "").trim();
          if (!text) return;

          // With diarize=true Deepgram gives us per-word speaker labels.
          // We group consecutive same-speaker words into utterance segments
          // so the transcript reads like a real dialogue.
          const words = Array.isArray(alt.words) ? alt.words : [];

          if (data.is_final) {
            if (words.length > 0) {
              // Remember the first speaker we ever saw (used for auto-
              // labelling "Prospect" by default — typically they open).
              if (live.firstSpeakerSeen === null && words[0].speaker !== undefined) {
                live.firstSpeakerSeen = words[0].speaker;
              }
              // Group consecutive words by speaker into utterances.
              let runSpeaker = words[0].speaker;
              let runWords = [];
              const flushRun = () => {
                if (runWords.length === 0) return;
                const txt = runWords.map(w => w.word).join(" ").trim();
                if (!txt) { runWords = []; return; }
                live.transcript.push({ text: txt, speaker: runSpeaker, isFinal: true, ts: Date.now() });
                // Track word counts per speaker for live talk ratio.
                const sKey = String(runSpeaker);
                live.speakerWordCounts[sKey] = (live.speakerWordCounts[sKey] || 0) + runWords.length;
                runWords = [];
              };
              for (const w of words) {
                if (w.speaker !== runSpeaker) {
                  flushRun();
                  runSpeaker = w.speaker;
                }
                runWords.push(w);
              }
              flushRun();
            } else {
              // No word-level info — fall back to a single untagged utterance.
              live.transcript.push({ text, speaker: null, isFinal: true, ts: Date.now() });
            }
            // Trim if over budget.
            const totalWords = transcriptWordCount();
            if (totalWords > TRANSCRIPT_TRIM_WORDS) {
              while (live.transcript.length > 3 && transcriptWordCount() > TRANSCRIPT_TRIM_WORDS) {
                live.transcript.shift();
              }
            }
            live.lastInterim = "";
          } else {
            live.lastInterim = text;
          }
          updateTranscriptPanel();
          updateTalkRatioBar();
        } catch {/* ignore malformed */}
      });

      ws.addEventListener("error", (e) => console.warn("[Klosr live] WS error", e));
      ws.addEventListener("close", () => {
        if (live.active) {
          console.log("[Klosr live] WS closed mid-session, attempting soft stop");
          stopLiveAssist({ reason: "ws_closed" });
        }
      });
    } catch (e) {
      console.error("[Klosr live] proceedWithStreamId failed:", e && e.message);
      if (body) {
        body.innerHTML = `
          <div class="klosr-empty">
            <div class="klosr-empty-title">Couldn't start Live Assist</div>
            <div class="klosr-empty-sub">${escapeHtml(e && e.message || "Unknown error")}. Make sure you're in the call (not the lobby).</div>
            <button class="klosr-foot-btn" id="klosr-live-retry" style="margin-top:12px">Try again</button>
          </div>
        `;
        const retry = document.getElementById("klosr-live-retry");
        if (retry) retry.addEventListener("click", () => startLiveAssist());
      }
      live.active = false;
    }
  }

  // Error path from background.js's icon-click bridge — surfaced when the
  // background worker's tabCapture.getMediaStreamId fails (lobby, muted
  // tab, Chrome internals page, etc.).
  function handleStreamIdError(errorMsg) {
    live.pendingIconClick = false;
    const body = document.getElementById("klosr-body");
    if (!body) return;
    body.innerHTML = `
      <div class="klosr-empty">
        <div class="klosr-empty-title">Couldn't capture tab audio</div>
        <div class="klosr-empty-sub">${escapeHtml(errorMsg)}. Try clicking the Klosr icon again, or make sure you're actually in the call (not the lobby or pre-join screen).</div>
        <button class="klosr-foot-btn" id="klosr-live-retry" style="margin-top:12px">Try again</button>
      </div>
    `;
    const retry = document.getElementById("klosr-live-retry");
    if (retry) retry.addEventListener("click", () => startLiveAssist());
  }

  // Listen for background.js icon-click bridge messages.
  //   liveStreamIdReady — user clicked Klosr toolbar icon → background got
  //     streamId via activeTab grant → forwarding streamId here.
  //   liveStreamIdError — icon click happened but tabCapture failed
  //     (lobby, muted, chrome://, etc).
  // Registered once at module load; idempotent because the listener is
  // inside the IIFE and the IIFE only runs once per tab navigation.
  try {
    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || !msg.action) return;
        if (msg.action === "liveStreamIdReady" && msg.streamId) {
          if (live.active) return;
          // Mount the overlay if it isn't yet (edge: user clicked the
          // toolbar icon before the in-call detector fired).
          if (!overlay) mountOverlay();
          proceedWithStreamId(msg.streamId).catch(() => {});
        } else if (msg.action === "liveStreamIdError") {
          if (live.active) return;
          if (!overlay) mountOverlay();
          handleStreamIdError(msg.error || "unknown");
        }
      });
    }
  } catch {/* no runtime context */}

  function stopLiveAssist(opts = {}) {
    try { live.mediaRecorder && live.mediaRecorder.stop(); } catch {}
    try { live.ws && live.ws.close(); } catch {}
    try { live.mediaStream && live.mediaStream.getTracks().forEach(t => t.stop()); } catch {}
    try { live._audioContext && live._audioContext.close(); } catch {}
    if (live.coachTimer) { clearInterval(live.coachTimer); live.coachTimer = null; }
    if (live._recTimer) { clearInterval(live._recTimer); live._recTimer = null; }

    const wasActive = live.active;
    const fullTranscript = live.transcript.map(t => t.text).join(" ").trim();
    const duration = live.startTime ? Math.round((Date.now() - live.startTime) / 1000) : 0;

    live.active = false;
    live.mediaStream = null;
    live.mediaRecorder = null;
    live.ws = null;
    live._audioContext = null;
    live.coachLastWordCount = 0;
    live.coachLastRun = 0;
    live.speakerWordCounts = {};
    live.userSpeakerIdx = null;
    live.firstSpeakerSeen = null;
    live.buyingSignals = [];
    live.competitorsHeard = new Set();
    live.customersHeard = new Set();
    live.priorDealStage = "";

    const btn = document.getElementById("klosr-live-toggle");
    if (btn) { btn.textContent = "▶ Live"; btn.classList.remove("klosr-live-active"); }
    const status = document.getElementById("klosr-live-status");
    if (status) status.hidden = true;

    if (wasActive) {
      logKlosrOverlayEvent("live_assist_ended", {
        durationSec: duration,
        transcriptLen: fullTranscript.length,
        platform,
      });

      // Pipeline hook: push the live-call outcome onto the deal. We do this
      // BEFORE renderCallSummary fires because the post-call summary also
      // writes activity, and we want the stage + commitments merged first.
      if (currentProspect && currentProspect.profileUrl) {
        mergeCallOutcomeToDeal({
          profileUrl: currentProspect.profileUrl,
          durationSec: duration,
          commitments: live.commitments.slice(),
          objections: live.objections.slice(),
          buyingSignals: live.buyingSignals.slice(),
          dealStage: live.priorDealStage || "",
        }).catch(() => {});
      }
    }

    if (wasActive && fullTranscript.length > 80 && !opts.reason) {
      renderCallSummary(fullTranscript, duration);
    } else {
      renderBody();
    }
  }

  function startRecTimer() {
    live._recTimer = setInterval(() => {
      const t = document.getElementById("klosr-rec-timer");
      if (t && live.startTime) {
        const s = Math.floor((Date.now() - live.startTime) / 1000);
        const mm = Math.floor(s / 60);
        const ss = String(s % 60).padStart(2, "0");
        t.textContent = `${mm}:${ss}`;
      }
    }, 1000);
  }

  function startCoachLoop() {
    // Tick every second. Inside runCoach we decide whether to actually
    // call Claude based on transcript delta + time since last run.
    live.coachTimer = setInterval(() => runCoach(), COACH_TICK_MS);
  }

  async function runCoach() {
    // Guardrail 1: never overlap calls.
    if (live.coachInFlight) return;

    // Guardrail 2: global rate-limit floor.
    const now = Date.now();
    if (live.coachLastRun && (now - live.coachLastRun) < COACH_MIN_GAP_MS) return;

    // Guardrail 3: need at least SOMETHING to analyse.
    const transcript = live.transcript.map(t => t.text).join(" ");
    if (transcript.trim().length < 40) return;

    // Gate: only fire if the transcript has meaningfully grown since our
    // last coach fire OR the last run is "stale" (>8s old and there's at
    // least some new content to re-consider). This keeps cost linear with
    // actual speech, not wall-clock time — silence costs zero.
    const currentWords = transcriptWordCount();
    const wordsDelta = currentWords - (live.coachLastWordCount || 0);
    const timeSinceLast = live.coachLastRun ? (now - live.coachLastRun) : Infinity;

    const hasNewSpeech = wordsDelta >= COACH_MIN_NEW_WORDS;
    const isStale = timeSinceLast >= COACH_STALE_REFRESH_MS && wordsDelta > 0;
    if (!hasNewSpeech && !isStale) return;

    live.coachLastRun = now;
    live.coachLastWordCount = currentWords;
    live.coachInFlight = true;
    // Pulse the "listening" indicator so the user sees we're working.
    setCoachThinking(true);

    try {
      const [cp, playbook, proof] = await Promise.all([
        loadCompanyProfile(), loadPlaybook(), loadProofLibrary(),
      ]);

      // Build speaker-tagged transcript so Claude can tell who said what.
      // Format: "You: ...\nProspect: ...\nYou: ..." — tight, one line per
      // utterance, last ~2500 chars only.
      const taggedLines = live.transcript.map(t => {
        const label = labelForSpeaker(t.speaker);
        return `${label}: ${t.text}`;
      });
      const taggedTranscript = taggedLines.join("\n").slice(-2500);

      const ratio = talkRatio();

      const res = await fetch(INTEL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "call-coach",
          params: {
            transcript: taggedTranscript,
            talkRatio: ratio.total > 20 ? { you: ratio.you, prospect: ratio.prospect } : null,
            priorDealStage: live.priorDealStage,
            prospect: currentProspect ? {
              name: currentProspect.name || "",
              title: currentProspect.headline || currentProspect.currentRole || "",
              company: currentProspect.currentCompany || currentProspect.company || "",
              headline: currentProspect.headline || "",
            } : { name: "(no prospect selected)" },
            founder: {
              whatYouSell: (cp && cp.whatYouSell) || "",
              icp: (cp && cp.icp) || "",
              valueProp: (cp && cp.valueProp) || "",
              objectionPlaybook: playbook || [],
              proofLibrary: proof || [],
              // Competitors + customers are optional — backend gracefully
              // handles missing arrays. Could load from Klosr intel cache
              // (future: wire apollo-company-competitors result here).
              competitors: [],
              customers: [],
            },
          },
        }),
      });
      const data = await res.json().catch(() => ({}));

      const changed = !coachEqual(data, live.coachLatest);
      live.coachLatest = data;
      if (data.dealStage) live.priorDealStage = data.dealStage;

      // Persist notable signals with dedupe against latest entry.
      if (data.objectionDetected && data.objectionText) {
        const last = live.objections[live.objections.length - 1];
        if (!last || last.text !== data.objectionText) {
          live.objections.push({
            text: data.objectionText,
            rebuttal: data.objectionRebuttal || "",
            ts: Date.now(),
          });
        }
      }
      if (data.commitmentCaptured) {
        const last = live.commitments[live.commitments.length - 1];
        if (!last || last.text !== data.commitmentCaptured) {
          live.commitments.push({ text: data.commitmentCaptured, ts: Date.now() });
        }
      }
      if (data.buyingSignal) {
        const last = live.buyingSignals[live.buyingSignals.length - 1];
        if (!last || last.text !== data.buyingSignal) {
          live.buyingSignals.push({
            text: data.buyingSignal,
            strength: data.buyingSignalStrength || "medium",
            ts: Date.now(),
          });
        }
      }
      if (data.competitorMentioned) live.competitorsHeard.add(data.competitorMentioned);
      if (data.customerMentioned) live.customersHeard.add(data.customerMentioned);

      if (changed) updateCoachPanel();
    } catch (e) {
      console.warn("[Klosr live] coach failed:", e && e.message);
    } finally {
      live.coachInFlight = false;
      setCoachThinking(false);
    }
  }

  // Toggles a subtle "thinking" pulse in the coach panel header so the
  // user can tell something's actively listening/analysing vs stalled.
  function setCoachThinking(on) {
    const coach = document.getElementById("klosr-coach");
    if (!coach) return;
    coach.classList.toggle("klosr-coach-thinking", !!on);
  }

  function renderLiveAssist() {
    const body = document.getElementById("klosr-body");
    if (!body) return;
    body.innerHTML = `
      <div class="klosr-live">
        <div class="klosr-live-disclaimer">⚠ Recording active — inform the other party if your jurisdiction requires it (EU, CA, etc).</div>

        <!-- Deal stage badge + talk ratio bar (header-level call health) -->
        <div class="klosr-live-health">
          <span class="klosr-dealstage" id="klosr-dealstage" hidden>—</span>
          <div class="klosr-talkratio" id="klosr-talkratio" hidden>
            <div class="klosr-talkratio-bar">
              <span class="klosr-talkratio-you" id="klosr-tr-you" style="width:0%"></span>
              <span class="klosr-talkratio-them" id="klosr-tr-them" style="width:0%"></span>
            </div>
            <div class="klosr-talkratio-nums" id="klosr-tr-nums">You 0% / Them 0%</div>
            <button class="klosr-talkratio-swap" id="klosr-tr-swap" title="Toggle which speaker is you">⇄</button>
          </div>
        </div>

        <!-- Pacing advice — only visible when coach flags a call-health issue -->
        <div class="klosr-pacing" id="klosr-pacing" hidden></div>

        <!-- Main coach card: current topic + say next + insight -->
        <div class="klosr-live-coach" id="klosr-coach">
          <div class="klosr-coach-empty">Listening… coaching kicks in after ~10s of speech.</div>
        </div>

        <!-- Buying signal (green urgent panel) — pops up when detected -->
        <div class="klosr-live-buying" id="klosr-buying" hidden></div>

        <!-- Proof-to-cite card — surfaces a specific case study tied to this moment -->
        <div class="klosr-live-proof" id="klosr-proof" hidden></div>

        <!-- Competitor alert — red, prominent when competitor is mentioned -->
        <div class="klosr-live-competitor" id="klosr-competitor" hidden></div>

        <!-- Objection alert — existing, unchanged placement -->
        <div class="klosr-live-alerts" id="klosr-alerts"></div>

        <!-- Predicted questions — what they'll likely ask next -->
        <div class="klosr-live-ask-next" id="klosr-ask-next" hidden>
          <div class="klosr-ask-next-title">They'll probably ask</div>
          <ul class="klosr-ask-next-list" id="klosr-ask-next-list"></ul>
        </div>

        <!-- Commitments tracker — accumulates across the call -->
        <div class="klosr-live-commits" id="klosr-commits" hidden>
          <div class="klosr-commit-title">Commitments captured</div>
          <ul class="klosr-commit-list" id="klosr-commit-list"></ul>
        </div>

        <!-- Transcript (collapsible) -->
        <details class="klosr-live-transcript-wrap" open>
          <summary>Live transcript</summary>
          <div class="klosr-live-transcript" id="klosr-transcript-body">
            <div class="klosr-transcript-empty">Waiting for speech…</div>
          </div>
        </details>

        <div class="klosr-live-foot">
          <button class="klosr-foot-btn klosr-live-stop-btn" id="klosr-live-stop">■ End call & summarise</button>
        </div>
      </div>
    `;
    const stopBtn = document.getElementById("klosr-live-stop");
    if (stopBtn) stopBtn.addEventListener("click", () => stopLiveAssist());

    // Speaker-swap button flips which speaker is labelled as "You" vs
    // "Prospect". Useful when Klosr's default heuristic (first speaker =
    // prospect) is wrong — usually when you joined the call before them.
    const swapBtn = document.getElementById("klosr-tr-swap");
    if (swapBtn) swapBtn.addEventListener("click", () => {
      const counts = live.speakerWordCounts || {};
      const keys = Object.keys(counts).map(Number);
      if (keys.length < 2) return;   // need both speakers heard first
      if (live.userSpeakerIdx === null) {
        // Initial override — flip from default (first speaker = prospect).
        live.userSpeakerIdx = live.firstSpeakerSeen;   // first-seen → you
      } else {
        // Toggle: swap to the other known speaker.
        live.userSpeakerIdx = keys.find(k => k !== live.userSpeakerIdx);
      }
      // Relabel the transcript IN PLACE — no re-fetch needed, labels are
      // computed on render.
      updateTranscriptPanel();
      updateTalkRatioBar();
      updateCoachPanel();   // "SAY NEXT" doesn't change but dealstage recomputes on next tick
    });

    updateTranscriptPanel();
    updateCoachPanel();
    updateTalkRatioBar();
  }

  function updateTranscriptPanel() {
    const pane = document.getElementById("klosr-transcript-body");
    if (!pane) return;
    const finals = live.transcript.slice(-18).map(t => {
      const label = labelForSpeaker(t.speaker);
      const cls = label === "You" ? "klosr-t-you" : label === "Prospect" ? "klosr-t-prospect" : "";
      return `<div class="klosr-t-final ${cls}"><span class="klosr-t-label">${escapeHtml(label)}:</span> ${escapeHtml(t.text)}</div>`;
    }).join("");
    const interim = live.lastInterim
      ? `<div class="klosr-t-interim">${escapeHtml(live.lastInterim)}</div>`
      : "";
    if (!finals && !interim) {
      pane.innerHTML = `<div class="klosr-transcript-empty">Waiting for speech…</div>`;
      return;
    }
    pane.innerHTML = finals + interim;
    pane.scrollTop = pane.scrollHeight;
  }

  function updateTalkRatioBar() {
    const wrap = document.getElementById("klosr-talkratio");
    const youEl = document.getElementById("klosr-tr-you");
    const themEl = document.getElementById("klosr-tr-them");
    const numsEl = document.getElementById("klosr-tr-nums");
    if (!wrap) return;
    const r = talkRatio();
    if (r.total < 20) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const youPct = Math.round(r.you * 100);
    const themPct = Math.round(r.prospect * 100);
    if (youEl) youEl.style.width = youPct + "%";
    if (themEl) themEl.style.width = themPct + "%";
    if (numsEl) numsEl.textContent = `You ${youPct}% · Them ${themPct}%`;
    // Color the whole bar red when founder is talking too much (>70%).
    wrap.classList.toggle("klosr-tr-you-dominating", youPct >= 70);
  }

  // Deal-stage badge colors based on progression.
  function dealStageColor(s) {
    const x = String(s || "").toLowerCase();
    if (x === "closing")     return "klosr-stage-closing";
    if (x === "negotiation") return "klosr-stage-negotiation";
    if (x === "objection")   return "klosr-stage-objection";
    if (x === "discovery")   return "klosr-stage-discovery";
    if (x === "stalled")     return "klosr-stage-stalled";
    if (x === "offtrack")    return "klosr-stage-offtrack";
    return "";
  }

  function updateCoachPanel() {
    const coach = document.getElementById("klosr-coach");
    const alerts = document.getElementById("klosr-alerts");
    const commits = document.getElementById("klosr-commits");
    const commitList = document.getElementById("klosr-commit-list");
    const stage = document.getElementById("klosr-dealstage");
    const pacing = document.getElementById("klosr-pacing");
    const buying = document.getElementById("klosr-buying");
    const proof = document.getElementById("klosr-proof");
    const comp = document.getElementById("klosr-competitor");
    const askNext = document.getElementById("klosr-ask-next");
    const askNextList = document.getElementById("klosr-ask-next-list");
    if (!coach) return;
    const c = live.coachLatest;

    if (!c) {
      coach.innerHTML = `<div class="klosr-coach-empty">Listening… coaching kicks in after ~10s of speech.</div>`;
      return;
    }

    // Deal stage badge
    if (stage) {
      if (c.dealStage) {
        stage.hidden = false;
        stage.className = `klosr-dealstage ${dealStageColor(c.dealStage)}`;
        stage.textContent = c.dealStage.toUpperCase();
      } else {
        stage.hidden = true;
      }
    }

    // Pacing advice (only when present — banner-style)
    if (pacing) {
      if (c.pacingAdvice) {
        pacing.hidden = false;
        pacing.innerHTML = `⚡ ${escapeHtml(c.pacingAdvice)}`;
      } else {
        pacing.hidden = true;
      }
    }

    // Main coach card
    const topic = c.currentTopic ? `<div class="klosr-coach-topic">${escapeHtml(c.currentTopic)}</div>` : "";
    const nextS = c.nextSuggestion
      ? `<div class="klosr-coach-next">
           <div class="klosr-coach-next-label">SAY NEXT</div>
           <div class="klosr-coach-next-text">${escapeHtml(c.nextSuggestion)}</div>
         </div>`
      : "";
    const insight = c.insight
      ? `<div class="klosr-coach-insight">💡 ${escapeHtml(c.insight)}</div>`
      : "";
    coach.innerHTML = (topic + nextS + insight) || `<div class="klosr-coach-empty">Nothing new — keep going.</div>`;

    // Buying signal panel (green, urgent)
    if (buying) {
      if (c.buyingSignal) {
        const strength = (c.buyingSignalStrength || "medium").toLowerCase();
        buying.hidden = false;
        buying.className = `klosr-live-buying klosr-buying-${strength}`;
        buying.innerHTML = `
          <div class="klosr-buying-head">🟢 Buying signal · ${escapeHtml(strength)}</div>
          <div class="klosr-buying-text">${escapeHtml(c.buyingSignal)}</div>
        `;
      } else {
        buying.hidden = true;
      }
    }

    // Proof-to-cite card — tied proof from library
    if (proof) {
      if (c.proofToCite && (c.proofToCite.title || c.proofToCite.body)) {
        const p = c.proofToCite;
        proof.hidden = false;
        proof.innerHTML = `
          <div class="klosr-proof-head">📎 Cite this proof now</div>
          ${p.reason ? `<div class="klosr-proof-reason">${escapeHtml(p.reason)}</div>` : ""}
          <div class="klosr-proof-card">
            ${p.title ? `<div class="klosr-proof-title">${escapeHtml(p.title)}</div>` : ""}
            ${p.metric ? `<div class="klosr-proof-metric">${escapeHtml(p.metric)}</div>` : ""}
            ${p.body ? `<div class="klosr-proof-body">${escapeHtml(p.body)}</div>` : ""}
          </div>
        `;
      } else {
        proof.hidden = true;
      }
    }

    // Competitor alert — red, prominent
    if (comp) {
      if (c.competitorMentioned) {
        comp.hidden = false;
        comp.innerHTML = `
          <div class="klosr-competitor-head">⚔ Competitor mentioned: ${escapeHtml(c.competitorMentioned)}</div>
          ${c.competitorAngle ? `<div class="klosr-competitor-angle">${escapeHtml(c.competitorAngle)}</div>` : ""}
        `;
      } else {
        comp.hidden = true;
      }
    }

    // Objection alert (unchanged)
    if (c.objectionDetected && c.objectionText) {
      alerts.innerHTML = `
        <div class="klosr-alert klosr-alert-objection">
          <div class="klosr-alert-head">⚠ Objection</div>
          <div class="klosr-alert-quote">"${escapeHtml(c.objectionText)}"</div>
          ${c.objectionRebuttal ? `<div class="klosr-alert-reply">${escapeHtml(c.objectionRebuttal)}</div>` : ""}
        </div>
      `;
    } else {
      alerts.innerHTML = "";
    }

    // "They'll ask next" predictive list
    if (askNext && askNextList) {
      if (Array.isArray(c.theyllAskNext) && c.theyllAskNext.length > 0) {
        askNext.hidden = false;
        askNextList.innerHTML = c.theyllAskNext.slice(0, 3).map(q => `<li>${escapeHtml(q)}</li>`).join("");
      } else {
        askNext.hidden = true;
      }
    }

    // Commitments tracker (unchanged)
    if (live.commitments.length > 0) {
      commits.hidden = false;
      commitList.innerHTML = live.commitments.slice(-5).map(c => `<li>${escapeHtml(c.text)}</li>`).join("");
    } else {
      commits.hidden = true;
    }
  }

  // ---- Post-call summary ---------------------------------------------
  async function renderCallSummary(transcript, durationSeconds) {
    const body = document.getElementById("klosr-body");
    if (!body) return;
    body.innerHTML = `
      <div class="klosr-live">
        <div class="klosr-summary-head">Post-call summary</div>
        <div class="klosr-loading">Synthesising ${Math.round(durationSeconds / 60)}min call…</div>
      </div>
    `;

    try {
      const cp = await loadCompanyProfile();
      // Reconstruct speaker-tagged transcript from live.transcript for summary.
      const taggedLines = live.transcript.map(t => `${labelForSpeaker(t.speaker)}: ${t.text}`);
      const fullTagged = taggedLines.join("\n") || transcript;

      const res = await fetch(INTEL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "call-summary",
          params: {
            transcript: fullTagged,
            durationSeconds,
            prospect: currentProspect ? {
              name: currentProspect.name || "",
              title: currentProspect.headline || currentProspect.currentRole || "",
              company: currentProspect.currentCompany || currentProspect.company || "",
            } : {},
            founder: {
              whatYouSell: (cp && cp.whatYouSell) || "",
              icp: (cp && cp.icp) || "",
            },
            // Pre-computed live-assist signals: pass so Claude can weave
            // them into the summary/follow-up (saves re-analysis).
            capturedSignals: {
              commitments: live.commitments.map(c => c.text),
              objections: live.objections.map(o => ({ text: o.text, rebuttal: o.rebuttal })),
              buyingSignals: live.buyingSignals.map(b => ({ text: b.text, strength: b.strength })),
              competitorsHeard: Array.from(live.competitorsHeard),
              customersHeard: Array.from(live.customersHeard),
              finalDealStage: live.priorDealStage,
              talkRatio: talkRatio(),
            },
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data || !data.headline) {
        body.innerHTML = `<div class="klosr-empty"><div class="klosr-empty-title">Couldn't summarise</div><div class="klosr-empty-sub">The transcript was too thin or Claude timed out. Transcript preserved below.</div></div>`;
        return;
      }

      const keyBullets = (data.keyPoints || []).map(k => `<li>${escapeHtml(k)}</li>`).join("");
      const objBullets = (data.objectionsRaised || []).map(o => `<li>${escapeHtml(o)}</li>`).join("");
      const commitBullets = (data.commitments || []).map(c => `<li>${escapeHtml(c)}</li>`).join("");
      const email = data.followupEmail || {};

      body.innerHTML = `
        <div class="klosr-live klosr-summary">
          <div class="klosr-summary-head">${escapeHtml(data.headline || "")}</div>

          ${keyBullets ? `<div class="klosr-summary-section"><div class="klosr-summary-title">Key points</div><ul>${keyBullets}</ul></div>` : ""}
          ${objBullets ? `<div class="klosr-summary-section"><div class="klosr-summary-title">Objections raised</div><ul>${objBullets}</ul></div>` : ""}
          ${commitBullets ? `<div class="klosr-summary-section"><div class="klosr-summary-title">Commitments</div><ul>${commitBullets}</ul></div>` : ""}
          ${data.nextStep ? `<div class="klosr-summary-next"><strong>Next step:</strong> ${escapeHtml(data.nextStep)}</div>` : ""}

          ${email.subject || email.body ? `
            <div class="klosr-summary-section klosr-summary-email">
              <div class="klosr-summary-title">Follow-up email draft</div>
              ${email.subject ? `<div class="klosr-email-sub"><strong>Subject:</strong> ${escapeHtml(email.subject)}</div>` : ""}
              ${email.body ? `<div class="klosr-email-body">${escapeHtml(email.body).replace(/\n/g, "<br>")}</div>` : ""}
              <div class="klosr-summary-actions">
                <button class="klosr-foot-btn" id="klosr-copy-email">Copy email</button>
                <button class="klosr-foot-btn" id="klosr-open-gmail">Open in Gmail</button>
              </div>
            </div>
          ` : ""}

          <div class="klosr-live-foot">
            <button class="klosr-foot-btn" id="klosr-summary-done">Close summary</button>
          </div>
        </div>
      `;

      const copyBtn = document.getElementById("klosr-copy-email");
      if (copyBtn) copyBtn.addEventListener("click", () => {
        const full = `Subject: ${email.subject || ""}\n\n${email.body || ""}`;
        navigator.clipboard.writeText(full).then(() => {
          copyBtn.textContent = "Copied";
          setTimeout(() => { copyBtn.textContent = "Copy email"; }, 1500);
        });
      });
      const gmailBtn = document.getElementById("klosr-open-gmail");
      if (gmailBtn) gmailBtn.addEventListener("click", () => {
        const url = "https://mail.google.com/mail/?view=cm&fs=1"
          + "&su=" + encodeURIComponent(email.subject || "")
          + "&body=" + encodeURIComponent(email.body || "");
        window.open(url, "_blank", "noopener,noreferrer");
      });
      const doneBtn = document.getElementById("klosr-summary-done");
      if (doneBtn) doneBtn.addEventListener("click", () => {
        live.transcript = []; live.objections = []; live.commitments = [];
        live.coachLatest = null; live.coachLastRun = 0;
        renderBody();
      });
    } catch (e) {
      body.innerHTML = `<div class="klosr-empty"><div class="klosr-empty-title">Summary failed</div><div class="klosr-empty-sub">${escapeHtml(e && e.message || "")}</div></div>`;
    }
  }

  // ---- Boot ------------------------------------------------------------
  function boot() {
    platform = detectPlatform();
    if (!platform) return;

    let tries = 0;
    const tick = setInterval(() => {
      tries += 1;
      const inCall = !!document.querySelector(
        '[data-self-name], [aria-label*="Leave call" i], [aria-label*="End call" i], ' +
        '[aria-label*="Mute" i], [aria-label*="microphone" i]'
      );
      if (inCall || tries >= 20) {
        clearInterval(tick);
        mountOverlay();
      }
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
