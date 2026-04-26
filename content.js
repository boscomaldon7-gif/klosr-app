// Klosr — Content Script (formerly PrepCall.AI)
// Runs on LinkedIn profile pages
// Scrapes the profile, sends to API (with Claude web search enabled), renders the prep brief.

(function () {
  "use strict";

  const API_URL = "https://backend-kappa-nine-57.vercel.app/api/analyze";
  const CHAT_URL = "https://backend-kappa-nine-57.vercel.app/api/chat";
  const EMAIL_URL = "https://backend-kappa-nine-57.vercel.app/api/email";
  const AUTOFILL_URL = "https://backend-kappa-nine-57.vercel.app/api/autofill-context";
  const FIND_EMAIL_URL = "https://backend-kappa-nine-57.vercel.app/api/find-email";
  const IMPORT_MEMORY_URL = "https://backend-kappa-nine-57.vercel.app/api/import-from-memory";
  const LEARN_ICP_URL = "https://backend-kappa-nine-57.vercel.app/api/learn-icp";
  const NINJAPEAR_URL = "https://backend-kappa-nine-57.vercel.app/api/ninjapear";
  const SEQUENCE_URL = "https://backend-kappa-nine-57.vercel.app/api/sequence";
  const HANDLE_REPLY_URL = "https://backend-kappa-nine-57.vercel.app/api/handle-reply";
  const LEADS_DISCOVER_URL = "https://backend-kappa-nine-57.vercel.app/api/leads-discover";
  // NinjaPear-backed intel dispatcher. Single endpoint, multiple actions —
  // consolidated so we fit under Vercel Hobby's 12-function cap.
  // Call via callIntel(action, params).
  const INTEL_URL = "https://backend-kappa-nine-57.vercel.app/api/intel";
  function callIntel(action, params = {}) {
    return fetch(INTEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, params }),
    }).then(r => r.ok ? r.json() : null).catch(() => null);
  }

  // ───── Telemetry (admin panel) ─────
  // Every meaningful Klosr action fires a beacon to /api/intel action
  // "log-event". No message content is sent — only event names + structural
  // metadata + (if user has completed onboarding) their email/company/ICP
  // so Bosco can see WHO is using what. Fails soft — never blocks the UI.
  let _klosrInstallId = null;
  async function getKlosrInstallId() {
    if (_klosrInstallId) return _klosrInstallId;
    let id = await _storageGet("klosr_install_id");
    if (!id) {
      // UUID v4 — collision-free unique per browser install
      id = (crypto.randomUUID && crypto.randomUUID()) ||
           ("klosr-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
      await _storageSet("klosr_install_id", id);
      // First time this install is seen — log the install event with current UTC date.
      setTimeout(() => logKlosrEvent("install", { ts: Date.now() }), 200);
    }
    _klosrInstallId = id;
    return id;
  }

  async function logKlosrEvent(event, metadata) {
    try {
      const installId = await getKlosrInstallId();
      if (!installId) return;
      // If the user has completed company setup, attach identity so the
      // admin panel shows WHO is using what — not just install UUIDs.
      let userMeta = null;
      const cp = companyProfile;
      if (cp && (cp.yourName || cp.companyName || cp.email)) {
        userMeta = {
          email: cp.email || "",
          yourName: cp.yourName || "",
          yourRole: cp.yourRole || "",
          companyName: cp.companyName || "",
          icp: (cp.icp || "").slice(0, 200),
          language: currentLanguage,
          linkedinUrl: cp.linkedinUrl || "",
        };
      }
      // Fire and forget — never await in callers.
      fetch("https://backend-kappa-nine-57.vercel.app/api/intel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "log-event",
          params: { installId, event, metadata: metadata || {}, userMeta },
        }),
      }).catch(() => {/* silent */});
    } catch {/* silent — telemetry must never break the extension */}
  }

  let sidebarOpen = false;
  let currentProfile = null;
  // ════════════════════════════════════════════════════════════════
  // STATE SYNC — extension → Upstash → PWA
  //
  // The Chrome extension owns the user's rich sales context in
  // chrome.storage.local. The PWA can't read chrome.storage directly,
  // so we push the state to Upstash via `sync-state` whenever relevant
  // data changes (proof added, objection logged, voice edit captured,
  // ICP learning updated). The PWA pulls this state via pwa-bootstrap
  // and uses it for personalized Vision drafts.
  //
  // Dedupe: we only sync when the hash of the state changes, to avoid
  // burning writes. Also triggered every 30 min as a safety net.
  // ════════════════════════════════════════════════════════════════
  let _lastSyncedStateHash = null;
  let _syncStateTimer = null;
  let _syncStateInFlight = false;

  async function syncStateToCloud(force) {
    if (_syncStateInFlight) return;
    try {
      const installId = await getKlosrInstallId();
      if (!installId) return;
      const [proof, playbook, voice, icp] = await Promise.all([
        _get("klosr_proof_library"),
        _get("klosr_objection_playbook"),
        _get("klosr_voice_diffs"),
        _get("klosr_icp_learnings"),
      ]);
      const state = {
        proofLibrary: Array.isArray(proof) ? proof : [],
        objectionPlaybook: Array.isArray(playbook) ? playbook : [],
        voiceExamples: Array.isArray(voice) ? voice : [],
        icpLearnings: (icp && icp.icpSummary) || "",
      };
      // Compute a cheap hash of the state so we skip redundant writes
      const hash = `${state.proofLibrary.length}:${state.objectionPlaybook.length}:${state.voiceExamples.length}:${state.icpLearnings.length}`;
      if (!force && hash === _lastSyncedStateHash) return;

      _syncStateInFlight = true;
      await fetch("https://backend-kappa-nine-57.vercel.app/api/intel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync-state", params: { installId, state } }),
      }).catch(() => {});
      _lastSyncedStateHash = hash;
    } catch (e) {
      console.warn("[Klosr sync] failed:", e && e.message);
    } finally {
      _syncStateInFlight = false;
    }
  }

  // Tiny _get helper if not already defined above. The existing one
  // references chrome.storage.local; we mirror it here in case of
  // load order issues.
  function _get(k) {
    return new Promise((r) => {
      try {
        if (!chrome?.storage?.local) return r(undefined);
        chrome.storage.local.get(k, (d) => r(d ? d[k] : undefined));
      } catch { r(undefined); }
    });
  }

  // Warm-leads action-handler scratch space. Populated each time fetchWarmLeadsInto
  // renders; read by dismiss / mark-contacted / draft-note / draft-dm buttons.
  let _warmLeadIndex = {};         // pid → lead object (for action handlers)
  let _warmFounderContext = null;  // founder context snapshot for draft endpoint
  let _warmAllLeads = [];          // ALL leads (unfiltered) — persists across re-renders
  let _warmDegreeFilter = "all";   // "all" | "1" | "2" | "3" | "contacted"
  let _warmSortMode = "warmth";    // "warmth" | "mutuals" | "score" | "name"
  let _warmSelected = new Set();   // pids of bulk-selected leads
  let _warmQueries = [];           // LinkedIn search keywords used (for Load More)
  let _warmPagesLoaded = 1;        // pages loaded so far (for LinkedIn start=N)
  let _warmRenderLead = null;      // closure captured in fetchWarmLeadsInto
  let _warmVisibleRenderFn = null; // re-render the filtered+sorted view
  let currentBrief = "";              // Latest brief text (for chat context)
  let currentMode = "sales";          // Latest mode used
  let currentLanguage = "en";         // "en" | "es"
  let chatMessages = [];              // [{role: "user"|"assistant", content: "..."}]
  let currentInterviewContext = null; // {role, background, focus, cvText, cvFileName, roleUrl, companyUrl, githubUrl, portfolioUrl}
  let currentPitchContext = null;     // {audienceUrl, audienceWhy} — pitch mode
  let currentSender = null;           // {name, role, company, context} loaded from chrome.storage
  let currentEmail = null;            // Last generated email {subject, body, emailGuesses}
  let currentSalesCallMode = "COLD";  // last sales call-mode chosen (COLD / FOLLOW-UP / PRE-CALL)

  // ==========================================================================
  // LEARNING LAYER — voice learning, ICP learning from won/lost, objection
  // memory, proof library, call notes absorption. All local to chrome.storage.
  // Storage keys:
  //   klosr_voice_diffs          : [{before, after, at}]
  //   klosr_outcomes             : [{profileUrl, name, headline, company, stage, notes, answeredAt}]
  //   klosr_icp_learnings        : { icpSummary, topPatterns[], nextQuestion, updatedAt }
  //   klosr_pitch_context        : { audienceUrl, audienceWhy }
  //   klosr_interview_context    : { role, background, focus, cvText, cvFileName, roleUrl, companyUrl, githubUrl, portfolioUrl }
  //   klosr_objection_playbook   : [{ id, trigger, rebuttal, prospectName, prospectCompany, savedAt }]
  //   klosr_proof_library        : [{ id, title, metric, industry, useCase, body, savedAt }]
  //   klosr_call_notes           : [{ id, profileUrl, name, company, role, headline, rawNotes, keyInsights, industryTags[], savedAt }]
  // ==========================================================================

  function _storageGet(key) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) return resolve(undefined);
        chrome.storage.local.get(key, (data) => resolve(data ? data[key] : undefined));
      } catch { resolve(undefined); }
    });
  }
  function _storageSet(key, val) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) return resolve();
        chrome.storage.local.set({ [key]: val }, resolve);
      } catch { resolve(); }
    });
  }

  // Voice learning — records before/after pairs from the user's edits so the
  // model can match how they actually write.
  async function recordVoiceDiff(before, after) {
    if (!before || !after || before === after) return;
    const diffs = (await _storageGet("klosr_voice_diffs")) || [];
    diffs.push({ before: String(before).slice(0, 3000), after: String(after).slice(0, 3000), at: Date.now() });
    await _storageSet("klosr_voice_diffs", diffs.slice(-20));
  }
  async function getVoiceExamples() {
    const diffs = (await _storageGet("klosr_voice_diffs")) || [];
    return diffs.slice(-8);
  }

  // ICP learning from outcomes — one click = one answer, over 20-30 outcomes
  // the model tells the user who their real ICP is.
  async function recordOutcome(outcome) {
    const list = (await _storageGet("klosr_outcomes")) || [];
    list.push({ ...outcome, answeredAt: Date.now() });
    await _storageSet("klosr_outcomes", list.slice(-100));
    refreshICPLearnings().catch(() => {});
  }
  async function getOutcomes() { return (await _storageGet("klosr_outcomes")) || []; }
  async function getICPLearnings() { return (await _storageGet("klosr_icp_learnings")) || null; }
  async function refreshICPLearnings() {
    const outcomes = await getOutcomes();
    if (outcomes.length < 1) return null;
    try {
      const existingICP = (companyProfile && companyProfile.icp) || "";
      const res = await fetch(LEARN_ICP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcomes, existingICP }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const payload = {
        icpSummary: data.icpSummary || "",
        topPatterns: Array.isArray(data.topPatterns) ? data.topPatterns : [],
        nextQuestion: data.nextQuestion || "",
        updatedAt: Date.now(),
      };
      await _storageSet("klosr_icp_learnings", payload);
      return payload;
    } catch { return null; }
  }

  async function getPitchContext() { return (await _storageGet("klosr_pitch_context")) || null; }
  async function savePitchContext(ctx) {
    await _storageSet("klosr_pitch_context", ctx || null);
    currentPitchContext = ctx || null;
  }
  async function getInterviewContext() { return (await _storageGet("klosr_interview_context")) || null; }
  async function saveInterviewContext(ctx) {
    await _storageSet("klosr_interview_context", ctx || null);
    currentInterviewContext = ctx || null;
  }

  // Objection memory — builds an organic playbook from the user's chats.
  const OBJECTION_TRIGGER_RE = /\b(push ?back|objection|too expensive|too pricey|budget|not a (good )?fit|already (use|using|have)|not sure|why (not|should)|what if they say|handle (the )?price|rebuttal|competitor|competitors|alternatives|cheaper|not interested|wrong time|no time|won'?t work|bad timing|push back on|se resistir|objecci[oó]n|muy caro|no (es )?buen fit|ya (uso|usan|tenemos|usamos))/i;
  function looksLikeObjectionAsk(text) {
    if (!text) return false;
    return OBJECTION_TRIGGER_RE.test(String(text));
  }
  async function getObjectionPlaybook() {
    return (await _storageGet("klosr_objection_playbook")) || [];
  }
  async function recordObjectionExchange(trigger, rebuttal, prospect) {
    if (!trigger || !rebuttal) return;
    const list = await getObjectionPlaybook();
    list.push({
      id: "obj_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      trigger: String(trigger).slice(0, 400),
      rebuttal: String(rebuttal).slice(0, 2000),
      prospectName: (prospect && prospect.name) || "",
      prospectCompany: (prospect && (prospect.currentCompany || prospect.company)) || "",
      savedAt: Date.now(),
    });
    await _storageSet("klosr_objection_playbook", list.slice(-40));
  }

  // Proof point library — structured array, one entry picked per prospect.
  async function getProofLibrary() { return (await _storageGet("klosr_proof_library")) || []; }
  async function saveProofLibrary(lib) {
    const list = Array.isArray(lib) ? lib.slice(0, 50) : [];
    await _storageSet("klosr_proof_library", list);
  }
  async function addProofPoint(item) {
    if (!item || !item.body || item.body.trim().length < 3) return null;
    const list = await getProofLibrary();
    const entry = {
      id: "pp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      title: (item.title || "").trim().slice(0, 120),
      metric: (item.metric || "").trim().slice(0, 120),
      industry: (item.industry || "").trim().slice(0, 120),
      useCase: (item.useCase || "").trim().slice(0, 200),
      body: item.body.trim().slice(0, 2000),
      savedAt: Date.now(),
    };
    list.push(entry);
    await saveProofLibrary(list);
    return entry;
  }
  async function removeProofPoint(id) {
    const list = await getProofLibrary();
    await saveProofLibrary(list.filter(p => p.id !== id));
  }

  // Call notes absorption — keyed by profile + industry tags, re-surfaced
  // for "similar enough" future prospects.
  function _industryTagsFrom(profile) {
    if (!profile) return [];
    const source = [
      profile.headline || "", profile.currentRole || "",
      profile.currentCompany || "", profile.about || "",
    ].join(" ").toLowerCase();
    const tags = [];
    const dict = [
      ["fintech","fintech"],["payments","payments"],["banking","banking"],
      ["saas","saas"],["cloud","cloud"],["infra","infra"],["infrastructure","infra"],
      ["ai","ai"],["ml","ai"],["machine learning","ai"],
      ["devtools","devtools"],["developer tool","devtools"],["devops","devops"],
      ["health","health"],["bio","bio"],["medtech","medtech"],
      ["edu","edu"],["learning","edu"],
      ["crypto","crypto"],["web3","crypto"],["blockchain","crypto"],
      ["retail","retail"],["ecommerce","ecommerce"],["e-commerce","ecommerce"],
      ["marketing","marketing"],["growth","growth"],["sales","sales"],
      ["founder","founder"],["ceo","ceo"],["cto","cto"],["cfo","cfo"],
      ["vp of engineering","engineering-leader"],["head of engineering","engineering-leader"],
      ["vp engineering","engineering-leader"],["engineering manager","engineering-leader"],
      ["product manager","pm"],["vp product","pm"],["head of product","pm"],
      ["hr","hr"],["people ops","hr"],["talent","hr"],["recruiter","hr"],
      ["data","data"],["analytics","data"],
      ["series a","series-a"],["series b","series-b"],["seed","seed"],
    ];
    for (const [needle, tag] of dict) {
      if (source.includes(needle) && !tags.includes(tag)) tags.push(tag);
    }
    return tags.slice(0, 8);
  }
  async function getAllCallNotes() { return (await _storageGet("klosr_call_notes")) || []; }
  async function recordCallNotes(profile, rawNotes, keyInsights) {
    if (!profile || !rawNotes) return null;
    const list = await getAllCallNotes();
    const entry = {
      id: "cn_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      profileUrl: profile.profileUrl || "",
      name: profile.name || "",
      company: profile.currentCompany || profile.company || "",
      role: profile.currentRole || "",
      headline: profile.headline || "",
      rawNotes: String(rawNotes).slice(0, 4000),
      keyInsights: String(keyInsights || "").slice(0, 2000),
      industryTags: _industryTagsFrom(profile),
      savedAt: Date.now(),
    };
    list.push(entry);
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const trimmed = list.filter(n => (now - (n.savedAt || 0)) < thirtyDays).concat(
      list.filter(n => (now - (n.savedAt || 0)) >= thirtyDays).slice(-60)
    );
    await _storageSet("klosr_call_notes", trimmed);
    return entry;
  }
  async function getRelevantCallNotes(profile, max = 3) {
    const list = await getAllCallNotes();
    if (!list.length || !profile) return [];
    const targetTags = new Set(_industryTagsFrom(profile));
    const targetUrl = profile.profileUrl || "";
    const scored = list
      .filter(n => n.profileUrl !== targetUrl)
      .map(n => {
        const nt = Array.isArray(n.industryTags) ? n.industryTags : [];
        let score = 0;
        nt.forEach(t => { if (targetTags.has(t)) score += 1; });
        const ageDays = (Date.now() - (n.savedAt || 0)) / (1000 * 60 * 60 * 24);
        if (ageDays < 30) score += 1.5;
        else if (ageDays < 90) score += 0.5;
        return { n, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map(x => x.n);
    return scored;
  }

  // ============================================================
  // MEMORY — single-pane aggregation of every user-scoped storage
  // key. Lets the user see, export (backup / move to new machine),
  // import (restore), or clear (nuke) everything Klosr has learned.
  // ============================================================
  const MEMORY_KEYS = [
    "prepcall_company",          // Company profile (name, role, ICP, proof, tone...)
    "prepcall_sender",           // Legacy sender info
    "prepcall_history",          // Prospect pipeline
    "prepcall_time_saved",       // Time tracking
    "klosr_voice_diffs",         // Voice learning (edit pairs)
    "klosr_outcomes",            // Won / lost outcomes
    "klosr_icp_learnings",       // Empirical ICP from outcomes
    "klosr_pitch_context",       // Last pitch audience config
    "klosr_interview_context",   // Last interview config + CV text
    "klosr_objection_playbook",  // Accumulated objection rebuttals
    "klosr_proof_library",       // Structured proof points
    "klosr_call_notes",          // Absorbed post-call notes
  ];

  // Snapshot every storage key into a single JSON-safe object, plus metadata.
  async function buildUserMemory() {
    const data = {};
    for (const key of MEMORY_KEYS) {
      const val = await _storageGet(key);
      if (val !== undefined) data[key] = val;
    }
    return {
      klosrMemoryVersion: 1,
      exportedAt: new Date().toISOString(),
      data,
    };
  }

  // Human-readable summary of what's stored. Keeps the UI honest — if a
  // category is empty we say so, we don't inflate counts.
  function summarizeMemory(mem) {
    const d = (mem && mem.data) || {};
    const p = d.prepcall_company || {};
    const history = Array.isArray(d.prepcall_history) ? d.prepcall_history : [];
    const voice = Array.isArray(d.klosr_voice_diffs) ? d.klosr_voice_diffs : [];
    const outcomes = Array.isArray(d.klosr_outcomes) ? d.klosr_outcomes : [];
    const playbook = Array.isArray(d.klosr_objection_playbook) ? d.klosr_objection_playbook : [];
    const proof = Array.isArray(d.klosr_proof_library) ? d.klosr_proof_library : [];
    const notes = Array.isArray(d.klosr_call_notes) ? d.klosr_call_notes : [];
    const icp = (d.klosr_icp_learnings && d.klosr_icp_learnings.icpSummary) || "";
    return {
      identity: p.yourName || p.companyName || "",
      yourRole: p.yourRole || "",
      whatYouSell: p.whatYouSell || "",
      prospects: history.length,
      voiceExamples: voice.length,
      outcomes: outcomes.length,
      objections: playbook.length,
      proofPoints: proof.length,
      callNotes: notes.length,
      icpSummary: icp,
    };
  }

  // Restore a previous snapshot. Shallow-writes each key back, preserving
  // any keys NOT in the import (so users can import a partial memory without
  // nuking other data). Returns the keys that were written.
  async function restoreUserMemory(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("Invalid memory snapshot");
    }
    const incoming = snapshot.data && typeof snapshot.data === "object"
      ? snapshot.data
      : snapshot; // tolerate raw-data pastes too
    const written = [];
    for (const key of MEMORY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) {
        await _storageSet(key, incoming[key]);
        written.push(key);
      }
    }
    // Refresh in-memory mirrors so the running session reflects the import.
    if (written.includes("prepcall_company")) {
      companyProfile = incoming.prepcall_company || null;
    }
    if (written.includes("prepcall_sender")) {
      currentSender = incoming.prepcall_sender || null;
    }
    if (written.includes("klosr_pitch_context")) {
      currentPitchContext = incoming.klosr_pitch_context || null;
    }
    if (written.includes("klosr_interview_context")) {
      currentInterviewContext = incoming.klosr_interview_context || null;
    }
    return written;
  }

  async function clearUserMemory() {
    for (const key of MEMORY_KEYS) {
      await _storageSet(key, undefined);
      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          await new Promise((resolve) => chrome.storage.local.remove(key, resolve));
        }
      } catch (e) {}
    }
    companyProfile = null;
    currentSender = null;
    currentPitchContext = null;
    currentInterviewContext = null;
  }

  // Best-effort CV text extraction. Supports plain text + basic PDF scraping.
  async function extractCvText(file) {
    if (!file) return "";
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".txt") || name.endsWith(".md")) return await file.text();
    if (name.endsWith(".pdf")) {
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let text = "";
        for (let i = 0; i < bytes.length; i++) {
          const c = bytes[i];
          if ((c >= 32 && c <= 126) || c === 10 || c === 13) text += String.fromCharCode(c);
          else text += " ";
        }
        return text
          .replace(/\s+/g, " ")
          .replace(/\/[A-Za-z]+\s?/g, " ")
          .replace(/[<>{}[\]\\]/g, " ")
          .replace(/\b\d{1,3}\s+0\s+obj\b/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 20000);
      } catch { return ""; }
    }
    try { return (await file.text()).slice(0, 20000); } catch { return ""; }
  }

  // Won / Lost — the ICP-learning loop. One click = one outcome + one
  // question for the user. The answer folds back into /api/learn-icp.
  async function handleOutcomeClick(stage, profile) {
    const zone = document.getElementById("briefme-email-outcome");
    if (!zone) return;

    const learnings = await getICPLearnings();
    const fallbackQ = stage === "won"
      ? "In one sentence: what made this one close?"
      : "In one sentence: what killed this one?";
    const question = (learnings && learnings.nextQuestion) || fallbackQ;

    zone.innerHTML = `
      <div class="briefme-email-outcome-q">
        <div class="briefme-outcome-stage-tag briefme-outcome-stage-${stage}">${stage.toUpperCase()}</div>
        <div class="briefme-email-outcome-question">${escapeHtml(question)}</div>
        <textarea
          class="briefme-outcome-note"
          id="briefme-outcome-note"
          placeholder="One sentence. Klosr builds your real ICP from answers like this."
          rows="2"
        ></textarea>
        <div class="briefme-outcome-q-actions">
          <button class="briefme-outcome-q-cancel" id="briefme-outcome-cancel">Cancel</button>
          <button class="briefme-outcome-q-save" id="briefme-outcome-save">Save ${stage}</button>
        </div>
      </div>
    `;

    const cancel = document.getElementById("briefme-outcome-cancel");
    const save = document.getElementById("briefme-outcome-save");
    const note = document.getElementById("briefme-outcome-note");
    note?.focus();

    if (cancel) cancel.addEventListener("click", () => {
      zone.innerHTML = `<div class="briefme-email-outcome-done">Cancelled. You can mark won/lost anytime from this email.</div>`;
    });

    if (save) save.addEventListener("click", async () => {
      const outcome = {
        profileUrl: (profile && profile.profileUrl) || "",
        name: (profile && profile.name) || "",
        headline: (profile && profile.headline) || "",
        company: (profile && (profile.currentCompany || profile.company)) || "",
        stage,
        notes: (note?.value || "").trim().slice(0, 500),
      };
      await recordOutcome(outcome);
      try {
        if (outcome.profileUrl) updateProspectStage(outcome.profileUrl, stage);
      } catch {}
      zone.innerHTML = `
        <div class="briefme-email-outcome-done">
          Logged as <strong>${stage}</strong>. Klosr is updating your real ICP in the background.
        </div>
      `;
    });
  }

  // ============================================================
  // PROSPECT HISTORY + DEAL PIPELINE
  // Every prospect is tracked through stages so the founder can
  // see: "I prepped 23 people → 14 contacted → 6 calls → 2 closing"
  // ============================================================
  const MAX_RECENT_PROSPECTS = 50;

  // Deal stages — linear pipeline. Each stage has a label + color.
  const DEAL_STAGES = ["prepped", "contacted", "replied", "call", "closing", "won", "lost"];
  const STAGE_LABELS_EN = {
    prepped: "Prepped", contacted: "Contacted", replied: "Replied",
    call: "Call Done", closing: "Closing", won: "Won", lost: "Lost",
  };
  const STAGE_LABELS_ES = {
    prepped: "Preparado", contacted: "Contactado", replied: "Respondió",
    call: "Llamada", closing: "Cerrando", won: "Ganado", lost: "Perdido",
  };
  const STAGE_COLORS = {
    prepped: "#6B7280", contacted: "#FFD60A", replied: "#4ADE80",
    call: "#60A5FA", closing: "#F59E0B", won: "#22C55E", lost: "#EF4444",
  };

  function getStageLabel(stage) {
    const labels = currentLanguage === "es" ? STAGE_LABELS_ES : STAGE_LABELS_EN;
    return labels[stage] || stage;
  }

  function saveProspectToHistory(profile, stage) {
    if (!profile || !profile.name || profile.name === "Unknown") return;
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get("prepcall_history", (data) => {
        let history = Array.isArray(data && data.prepcall_history) ? data.prepcall_history : [];

        const url = profile.profileUrl || "";
        const existing = history.find(p => p.profileUrl === url);

        if (existing) {
          // Update existing prospect — bump to top, update stage if advancing
          history = history.filter(p => p.profileUrl !== url);
          existing.savedAt = Date.now();
          existing.name = profile.name || existing.name;
          existing.photoUrl = profile.photoUrl || existing.photoUrl;
          if (stage) {
            const oldIdx = DEAL_STAGES.indexOf(existing.stage || "prepped");
            const newIdx = DEAL_STAGES.indexOf(stage);
            // Only advance forward (or allow won/lost from any stage)
            if (newIdx > oldIdx || stage === "won" || stage === "lost") {
              existing.stage = stage;
            }
          }
          history.unshift(existing);
        } else {
          // New prospect
          history.unshift({
            name: profile.name,
            headline: (profile.headline || "").slice(0, 120),
            location: (profile.location || "").slice(0, 80),
            currentRole: profile.currentRole || "",
            currentCompany: profile.currentCompany || "",
            profileUrl: url,
            photoUrl: profile.photoUrl || "",
            stage: stage || "prepped",
            savedAt: Date.now(),
          });
        }

        if (history.length > MAX_RECENT_PROSPECTS) history = history.slice(0, MAX_RECENT_PROSPECTS);
        chrome.storage.local.set({ prepcall_history: history });

        // Check for milestone celebrations
        checkMilestones(history);
      });
    } catch (e) {
      console.warn("PrepCall.AI: couldn't save prospect history", e);
    }
  }

  // Update ONLY the stage of an existing prospect (by URL)
  function updateProspectStage(profileUrl, newStage) {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get("prepcall_history", (data) => {
        let history = Array.isArray(data && data.prepcall_history) ? data.prepcall_history : [];
        const prospect = history.find(p => p.profileUrl === profileUrl);
        if (prospect) {
          prospect.stage = newStage;
          prospect.savedAt = Date.now();
          chrome.storage.local.set({ prepcall_history: history });
        }
      });
    } catch (e) {}
  }

  function loadProspectHistory() {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) {
          resolve([]);
          return;
        }
        chrome.storage.local.get("prepcall_history", (data) => {
          resolve(Array.isArray(data && data.prepcall_history) ? data.prepcall_history : []);
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  // DEAL PIPELINE — the core deal-closing system
  //
  // Each prepared prospect becomes a "deal" with richer state than the
  // lightweight prepcall_history row: stage, commitments from live calls,
  // objections raised, activity log, pending follow-ups.
  //
  // Stored on the SAME `prepcall_history` row to avoid migration — we
  // just enrich the row with extra fields. Every existing row keeps
  // working; new fields are populated as the user interacts.
  //
  // Deal stage vocabulary (matches the Live Assist coach output):
  //   discovery    → initial exploration, need to qualify
  //   objection    → active resistance, working through concerns
  //   negotiation  → discussing terms, pricing, scope
  //   closing      → asking for the commitment
  //   won          → closed, money in (feeds ICP learning)
  //   lost         → dead for measurable reason (feeds ICP learning)
  //   ghosted      → went silent > 14 days with no lost reason
  //   prepped      → brief generated, no contact yet (initial state)
  //   contacted    → outreach sent, awaiting reply
  //   replied      → they came back — move to discovery or later
  // ════════════════════════════════════════════════════════════════
  const PIPELINE_STAGES_ACTIVE = ["prepped", "contacted", "replied", "discovery", "objection", "negotiation", "closing"];
  const PIPELINE_STAGES_TERMINAL = ["won", "lost", "ghosted"];

  async function getAllDeals() { return await loadProspectHistory(); }

  async function getDeal(profileUrl) {
    const all = await loadProspectHistory();
    return all.find(p => p.profileUrl === profileUrl) || null;
  }

  // Merges partial updates onto an existing deal (or creates if missing).
  // Used by every hook point below — brief generation, email send, call end,
  // reply handled — so every action writes to ONE canonical source.
  async function upsertDeal(profile, patch) {
    if (!profile || !profile.profileUrl) return;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get("prepcall_history", (data) => {
          let history = Array.isArray(data && data.prepcall_history) ? data.prepcall_history : [];
          const url = profile.profileUrl;
          let existing = history.find(p => p.profileUrl === url);
          const now = Date.now();

          if (!existing) {
            existing = {
              name: profile.name || "",
              headline: (profile.headline || "").slice(0, 120),
              location: (profile.location || "").slice(0, 80),
              currentRole: profile.currentRole || "",
              currentCompany: profile.currentCompany || "",
              profileUrl: url,
              photoUrl: profile.photoUrl || "",
              stage: "prepped",
              dealStage: "prepped",
              createdAt: now,
              lastActivityAt: now,
              savedAt: now,
              commitments: [],
              objections: [],
              buyingSignals: [],
              activities: [],
              emailsSent: 0,
              callsHad: 0,
              totalCallSeconds: 0,
              notes: "",
            };
            history.unshift(existing);
          }

          // Merge basic profile fields — keep newest non-empty values.
          const keep = (k) => { if (profile[k]) existing[k] = profile[k]; };
          keep("name"); keep("headline"); keep("photoUrl");
          keep("currentRole"); keep("currentCompany"); keep("location");

          // Apply the patch — shallow merge for primitives, append for arrays.
          if (patch && typeof patch === "object") {
            for (const [k, v] of Object.entries(patch)) {
              if (Array.isArray(v)) {
                existing[k] = Array.isArray(existing[k]) ? existing[k].concat(v) : v.slice();
              } else if (v !== undefined) {
                existing[k] = v;
              }
            }
          }

          existing.lastActivityAt = now;
          existing.savedAt = now;

          // Keep array caps sane so storage doesn't bloat forever.
          if (Array.isArray(existing.commitments) && existing.commitments.length > 40) existing.commitments = existing.commitments.slice(-40);
          if (Array.isArray(existing.objections) && existing.objections.length > 30) existing.objections = existing.objections.slice(-30);
          if (Array.isArray(existing.buyingSignals) && existing.buyingSignals.length > 20) existing.buyingSignals = existing.buyingSignals.slice(-20);
          if (Array.isArray(existing.activities) && existing.activities.length > 80) existing.activities = existing.activities.slice(-80);

          // Move to top if this was an update.
          history = history.filter(p => p.profileUrl !== url);
          history.unshift(existing);
          if (history.length > MAX_RECENT_PROSPECTS) history = history.slice(0, MAX_RECENT_PROSPECTS);

          chrome.storage.local.set({ prepcall_history: history }, () => resolve(existing));
        });
      } catch { resolve(null); }
    });
  }

  // Append an activity entry (for the deal's timeline). Types: brief, email,
  // dm, call, reply, sequence, note.
  async function recordDealActivity(profileUrl, type, metadata) {
    const deal = await getDeal(profileUrl);
    if (!deal) return;
    const patch = {
      activities: [{ type, ts: Date.now(), metadata: metadata || {} }],
    };
    // Bump the relevant counter too.
    if (type === "email") patch.emailsSent = (deal.emailsSent || 0) + 1;
    if (type === "call") {
      patch.callsHad = (deal.callsHad || 0) + 1;
      if (metadata && typeof metadata.durationSec === "number") {
        patch.totalCallSeconds = (deal.totalCallSeconds || 0) + metadata.durationSec;
      }
    }
    await upsertDeal(deal, patch);
  }

  // Explicit stage update — used by auto-hooks AND by user's manual picker.
  async function setDealStage(profileUrl, newStage) {
    const deal = await getDeal(profileUrl);
    if (!deal) return;
    await upsertDeal(deal, { dealStage: newStage, stage: newStage });
  }

  // Mark won / lost — this is the closed-loop moment. Routes to the existing
  // recordOutcome() path so won/lost also feeds ICP learning immediately.
  async function markDealWonOrLost(profileUrl, won, notes, acv) {
    const deal = await getDeal(profileUrl);
    if (!deal) return;
    const lastStage = deal.dealStage || deal.stage;
    await upsertDeal(deal, {
      dealStage: won ? "won" : "lost",
      stage: won ? "won" : "lost",
      closedAt: Date.now(),
      closedNotes: (notes || "").slice(0, 600),
      // ACV = annual contract value. Stored as number of USD. Sums into
      // the pipeline $ KPI on won deals, used for velocity analysis too.
      acv: typeof acv === "number" && acv > 0 ? Math.round(acv) : (deal.acv || null),
    });
    // Feed the existing outcome-learning stream so ICP improves.
    if (typeof recordOutcome === "function") {
      recordOutcome({
        profileUrl,
        name: deal.name,
        headline: deal.headline,
        company: deal.currentCompany,
        stage: won ? "won" : "lost",
        notes: notes || "",
        answeredAt: Date.now(),
      });
    }
    // Kick off ICP refresh in background (don't block UI).
    if (typeof refreshICPLearnings === "function") {
      refreshICPLearnings().catch(() => {});
    }
    logKlosrEvent(won ? "deal_won" : "deal_lost", { stage: lastStage });

    // CLOSED-LOOP LEARNING (won only) — extract a reusable proof point from
    // the win notes so the next prospect gets the ammunition from this one.
    // Non-blocking; runs in the background and toasts when a proof lands.
    if (won && notes && notes.trim().length >= 8) {
      extractWinIntoProofLibrary(deal, notes).catch(() => {});
    }
  }

  // Fire-and-forget: ask Claude to distill the win notes into a proof point,
  // then auto-add to the user's library. Shows a toast on success.
  async function extractWinIntoProofLibrary(deal, notes) {
    try {
      const cp = companyProfile || {};
      const existing = await getProofLibrary();
      const result = await callIntel("extract-proof-from-win", {
        language: currentLanguage,
        deal: {
          name: deal.name || "",
          company: deal.currentCompany || "",
          role: deal.currentRole || deal.headline || "",
          lastStage: deal.dealStage || deal.stage || "",
        },
        notes,
        existingProof: existing.slice(-10),
        founder: {
          whatYouSell: cp.whatYouSell || "",
          icp: cp.icp || "",
        },
      });
      const p = result && result.proof;
      if (!p || p.action !== "add" || !p.body) return;
      await addProofPoint({ title: p.title, metric: p.metric, body: p.body });
      const isEs = currentLanguage === "es";
      showKlosrToast(isEs
        ? `📚 Añadido a biblioteca: "${p.title || p.metric || "caso"}"`
        : `📚 Added to proof library: "${p.title || p.metric || "case study"}"`);
    } catch {/* silent — proof extraction is bonus, never critical */}
  }

  // Minimal toast notification system — top of sidebar, auto-dismisses.
  function showKlosrToast(message) {
    const sidebar = document.getElementById("briefme-sidebar");
    if (!sidebar) return;
    const existing = sidebar.querySelector(".klosr-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "klosr-toast";
    toast.textContent = message;
    sidebar.appendChild(toast);
    setTimeout(() => toast.classList.add("klosr-toast-visible"), 10);
    setTimeout(() => {
      toast.classList.remove("klosr-toast-visible");
      setTimeout(() => toast.remove(), 260);
    }, 4200);
  }

  // Inline due-date editor — update a specific commitment on a specific deal.
  async function setCommitmentDueBy(profileUrl, commitmentIdx, dueByTimestamp) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get("prepcall_history", (data) => {
          const history = Array.isArray(data && data.prepcall_history) ? data.prepcall_history : [];
          const target = history.find(p => p.profileUrl === profileUrl);
          if (target && Array.isArray(target.commitments) && target.commitments[commitmentIdx]) {
            target.commitments[commitmentIdx].dueBy = dueByTimestamp || null;
            chrome.storage.local.set({ prepcall_history: history }, resolve);
          } else resolve();
        });
      } catch { resolve(); }
    });
  }

  // Auto-ghost deals with no activity in 14+ days on early stages. Runs once
  // at the top of showDealPipelineView. Returns how many deals got ghosted
  // so the UI can show "3 deals moved to ghosted — reply to them or re-engage".
  async function checkGhostedDeals() {
    const deals = await loadProspectHistory();
    const cutoff = Date.now() - 14 * 86400000;
    const staleStages = new Set(["prepped", "contacted", "replied"]);
    const toGhost = deals.filter(d => {
      const stage = d.dealStage || d.stage;
      const lastAct = d.lastActivityAt || d.savedAt || 0;
      return staleStages.has(stage) && lastAct < cutoff && !d.closedAt;
    });
    for (const d of toGhost) {
      await setDealStage(d.profileUrl, "ghosted");
    }
    if (toGhost.length > 0) {
      logKlosrEvent("deals_auto_ghosted", { count: toGhost.length });
    }
    return toGhost.length;
  }

  async function getAllPendingCommitments() {
    const deals = await loadProspectHistory();
    const pending = [];
    for (const d of deals) {
      if (!Array.isArray(d.commitments)) continue;
      for (const c of d.commitments) {
        if (c.doneAt) continue;
        pending.push({ ...c, deal: d });
      }
    }
    return pending.sort((a, b) => {
      // Sort by due date ascending (undated last); ties broken by ts desc.
      const ad = a.dueBy ? Number(a.dueBy) : Number.MAX_SAFE_INTEGER;
      const bd = b.dueBy ? Number(b.dueBy) : Number.MAX_SAFE_INTEGER;
      if (ad !== bd) return ad - bd;
      return (b.ts || 0) - (a.ts || 0);
    });
  }

  // Auto-schedule follow-up commitments when a DM is sent/copied. This
  // is the mechanism that turns "I sent the DM, now I'll forget" into
  // "Klosr will ping me on day 4 and day 9 with a ready-to-send follow-up".
  //
  // Two commitments are scheduled:
  //   - Follow-up #1 at dueBy = now + 4 days
  //   - Follow-up #2 at dueBy = now + 9 days
  //
  // Dedupe: if the deal already has a pending "Follow-up #1" commitment,
  // we skip creating new ones (prevents duplicate scheduling when the user
  // copies the DM multiple times or re-sends after a tweak).
  //
  // Also flips the deal stage to "contacted" if it was still "prepped"
  // so the pipeline view accurately reflects that outreach has gone out.
  async function scheduleFollowupsForLead(lead, draftText) {
    if (!lead || !lead.profileUrl) return;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get("prepcall_history", (data) => {
          const history = Array.isArray(data && data.prepcall_history) ? data.prepcall_history : [];
          let deal = history.find(p => p.profileUrl === lead.profileUrl);

          // Auto-create the deal record if it doesn't exist yet (user
          // skipped "Add to pipeline" and went straight to DM).
          const now = Date.now();
          if (!deal) {
            deal = {
              profileUrl: lead.profileUrl,
              name: lead.name || "",
              headline: lead.title || "",
              currentRole: lead.title || "",
              currentCompany: lead.company || "",
              photoUrl: lead.photoUrl || "",
              dealStage: "contacted",
              stage: "contacted",
              commitments: [],
              objections: [],
              buyingSignals: [],
              activities: [],
              savedAt: now,
              lastActivityAt: now,
            };
            history.push(deal);
          }
          if (!Array.isArray(deal.commitments)) deal.commitments = [];

          // Dedupe: skip if a pending "Follow-up" commitment already exists
          // from a prior send in the last 24h. Prevents re-scheduling on
          // accidental re-clicks.
          const recentFollowup = deal.commitments.find(c =>
            c && !c.doneAt
            && typeof c.text === "string"
            && c.text.startsWith("Follow-up #")
            && c.ts && (now - c.ts) < 24 * 3600 * 1000
          );
          if (recentFollowup) {
            resolve(false);
            return;
          }

          const DAY = 24 * 3600 * 1000;
          // End-of-day timestamps so "due day 4" means "by end of day 4"
          // not "exactly 96h from now".
          const eodOffset = (days) => {
            const d = new Date(now + days * DAY);
            d.setHours(23, 59, 59, 999);
            return d.getTime();
          };

          deal.commitments.push({
            text: "Follow-up #1 — check for reply, nudge if silent",
            ts: now,
            dueBy: eodOffset(4),
            doneAt: null,
            autoScheduled: true,
            forDraft: (draftText || "").slice(0, 200),
          });
          deal.commitments.push({
            text: "Follow-up #2 — last touch with fresh angle (Revive)",
            ts: now,
            dueBy: eodOffset(9),
            doneAt: null,
            autoScheduled: true,
          });

          // Stage advance — prepped → contacted. Don't regress a deal
          // that's already past contacted.
          const currentStage = deal.dealStage || deal.stage || "prepped";
          if (currentStage === "prepped") {
            deal.dealStage = "contacted";
            deal.stage = "contacted";
          }

          // Activity log
          if (!Array.isArray(deal.activities)) deal.activities = [];
          deal.activities.push({
            type: "linkedin_msg",
            ts: now,
            metadata: { via: "klosr_dm", autoScheduledFollowups: true },
          });

          deal.lastActivityAt = now;
          deal.savedAt = now;
          deal.emailsSent = (deal.emailsSent || 0); // unchanged for DMs

          chrome.storage.local.set({ prepcall_history: history }, () => {
            logKlosrEvent("followups_auto_scheduled", {
              profileUrl: lead.profileUrl,
              dueBy1: eodOffset(4),
              dueBy2: eodOffset(9),
            });
            resolve(true);
          });
        });
      } catch { resolve(false); }
    });
  }

  async function toggleCommitmentDone(profileUrl, commitmentIndex) {
    const deal = await getDeal(profileUrl);
    if (!deal || !Array.isArray(deal.commitments)) return;
    return new Promise((resolve) => {
      chrome.storage.local.get("prepcall_history", (data) => {
        const history = Array.isArray(data && data.prepcall_history) ? data.prepcall_history : [];
        const target = history.find(p => p.profileUrl === profileUrl);
        if (target && Array.isArray(target.commitments) && target.commitments[commitmentIndex]) {
          const c = target.commitments[commitmentIndex];
          c.doneAt = c.doneAt ? null : Date.now();
          chrome.storage.local.set({ prepcall_history: history }, resolve);
        } else resolve();
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // DEAL TEMPERATURE — hot / warm / cold / frozen scoring
  //
  // Pure function. Takes a deal (prepcall_history record) and returns
  // { score: 0-100, label: "hot"|"warm"|"cold"|"frozen", reason: string }.
  // Used by the Daily Close dashboard, pipeline badges, and the
  // action-derivation logic. Designed to be cheap — no fetches, no async.
  //
  // Weights chosen from what actually predicts close: late stage + fresh
  // activity + buying signals captured + no overdue commitments. A deal
  // with all four is HOT. Missing any one drops it to WARM. Two or more
  // missing = COLD. Stale + wrong stage = FROZEN.
  // ════════════════════════════════════════════════════════════
  function calcDealTemperature(deal) {
    if (!deal) return { score: 0, label: "frozen", reason: "no deal" };
    const now = Date.now();
    const stage = deal.dealStage || deal.stage || "prepped";

    // Terminal stages aren't temperature-ranked.
    if (stage === "won")     return { score: 100, label: "hot",  reason: "won" };
    if (stage === "lost")    return { score: 0,   label: "frozen", reason: "lost" };
    if (stage === "ghosted") return { score: 5,   label: "frozen", reason: "ghosted — 14+ days silent" };

    let score = 0;
    const reasons = [];

    // Stage: how far down the funnel? Late stages carry most of the weight.
    const stageWeight = {
      prepped: 5, contacted: 10, replied: 25,
      discovery: 40, objection: 45,
      negotiation: 70, closing: 85,
    }[stage] || 5;
    score += stageWeight;

    // Recency of activity: fresh = big boost. 0 after 14d.
    const lastActivity = deal.lastActivityAt || deal.savedAt || 0;
    const hoursSince = lastActivity ? (now - lastActivity) / 3600000 : 999;
    if (hoursSince < 24)      { score += 25; reasons.push("active last 24h"); }
    else if (hoursSince < 72) { score += 15; reasons.push("active last 3d"); }
    else if (hoursSince < 168){ score += 5; }
    else if (hoursSince > 336){ score -= 15; reasons.push("silent 14+ days"); }
    else                       { score -= 5; reasons.push("silent 7+ days"); }

    // Buying signals captured in last 14d — strongest leading indicator.
    const recentSignals = (deal.buyingSignals || []).filter(s => s && s.ts && (now - s.ts) < 14 * 86400000);
    const highSignals = recentSignals.filter(s => s.strength === "high").length;
    const medSignals  = recentSignals.filter(s => s.strength === "medium").length;
    if (highSignals > 0) { score += Math.min(highSignals * 12, 25); reasons.push(`${highSignals} strong buying signal${highSignals > 1 ? "s" : ""}`); }
    else if (medSignals > 0) { score += Math.min(medSignals * 5, 15); }

    // Commitment momentum
    const pending = (deal.commitments || []).filter(c => !c.doneAt);
    const overdue = pending.filter(c => c.dueBy && c.dueBy < now);
    if (overdue.length > 0) { score -= overdue.length * 12; reasons.push(`${overdue.length} overdue commitment${overdue.length > 1 ? "s" : ""}`); }
    const doneInRange = (deal.commitments || []).filter(c => c.doneAt && (now - c.doneAt) < 14 * 86400000);
    if (doneInRange.length > 0) { score += Math.min(doneInRange.length * 5, 12); }

    // Unresolved objections = drag. Each unresolved caps the deal at warm.
    const openObj = (deal.objections || []).filter(o => !o.resolved);
    if (openObj.length >= 2) { score -= 10; reasons.push("objections unresolved"); }

    // Calls + meaningful contact = real engagement
    if ((deal.callsHad || 0) >= 2) score += 8;

    // Clamp.
    score = Math.max(0, Math.min(100, Math.round(score)));

    let label;
    if (score >= 70) label = "hot";
    else if (score >= 40) label = "warm";
    else if (score >= 15) label = "cold";
    else label = "frozen";

    // Reason: use top positive factor if hot/warm, top negative if cold/frozen.
    let reason = "";
    if (label === "hot" || label === "warm") {
      if (highSignals > 0) reason = `${highSignals} strong buying signal${highSignals > 1 ? "s" : ""}`;
      else if (hoursSince < 24) reason = "active last 24h";
      else if (stage === "closing" || stage === "negotiation") reason = `at ${stage}`;
      else reason = reasons[0] || "moving";
    } else {
      if (overdue.length > 0) reason = `${overdue.length} overdue commitment${overdue.length > 1 ? "s" : ""}`;
      else if (hoursSince > 336) reason = "silent 14+ days";
      else if (hoursSince > 168) reason = "silent 7+ days";
      else reason = reasons[0] || "no momentum";
    }

    return { score, label, reason };
  }

  // ════════════════════════════════════════════════════════════
  // TODAY'S ACTIONS — the Daily Close action list
  //
  // Derives a ranked list of concrete actions the founder should do TODAY
  // to close more deals. Each action is a self-contained card:
  //   { type, priority, dealUrl, dealName, title, subtitle, ctaLabel, ctaKind }
  //
  // ctaKind is a handler key the view wires to a click-action. Types:
  //   - overdue_commit  → prospect chased for something we promised, OPEN profile
  //   - due_today       → commitment due today, DRAFT followup
  //   - hot_reply       → inbound reply needing response, OPEN handle-reply flow
  //   - stuck_closing   → deal at closing 7+ days, SEND CONTRACT or close
  //   - stuck_negot     → deal at negotiation 14+ days, PUSH or kill
  //   - revive          → silent 14+ days, REVIVE draft
  //   - multithread     → single-threaded late-stage deal, ADD DECISION MAKER
  //   - hot_silent      → hot-temp deal with no touch in 3+ days
  //   - unresolved_obj  → late-stage with ≥2 open objections, HANDLE first
  // ════════════════════════════════════════════════════════════
  function getTodaysActions(deals, commitments) {
    const now = Date.now();
    const actions = [];
    const active = (deals || []).filter(d => !PIPELINE_STAGES_TERMINAL.includes(d.dealStage || d.stage));

    // 1. Overdue commitments — absolute highest priority.
    for (const c of (commitments || [])) {
      if (!c.dueBy || c.dueBy >= now) continue;
      const daysOver = Math.ceil((now - c.dueBy) / 86400000);
      actions.push({
        type: "overdue_commit",
        priority: 10 + Math.min(daysOver, 5),
        dealUrl: c.deal.profileUrl || "",
        dealName: c.deal.name || "",
        title: `Overdue: "${(c.text || "").slice(0, 80)}"`,
        subtitle: `Promised to ${c.deal.name || "them"} · ${daysOver}d late · send NOW`,
        ctaLabel: "Draft nudge",
        ctaKind: "draft_overdue_nudge",
        payload: { commitment: c },
      });
    }

    // 2. Commitments due today or tomorrow — pre-empt the slip.
    for (const c of (commitments || [])) {
      if (!c.dueBy) continue;
      const diff = c.dueBy - now;
      if (diff < 0 || diff > 2 * 86400000) continue;
      const dueLabel = diff < 86400000 ? "today" : "tomorrow";
      actions.push({
        type: "due_today",
        priority: 9,
        dealUrl: c.deal.profileUrl || "",
        dealName: c.deal.name || "",
        title: `Due ${dueLabel}: "${(c.text || "").slice(0, 80)}"`,
        subtitle: `Send it before ${c.deal.name || "they"} ask`,
        ctaLabel: "Draft followup",
        ctaKind: "draft_commitment_followup",
        payload: { commitment: c },
      });
    }

    // 3. Late-stage stuck deals — biggest $ at risk.
    for (const d of active) {
      const stage = d.dealStage || d.stage;
      const daysSince = (now - (d.lastActivityAt || d.savedAt || 0)) / 86400000;
      if (stage === "closing" && daysSince >= 5) {
        actions.push({
          type: "stuck_closing",
          priority: 9,
          dealUrl: d.profileUrl || "",
          dealName: d.name || "",
          title: `${d.name || ""} stuck at Closing — ${Math.round(daysSince)}d`,
          subtitle: "Send the contract. Get it over the line today.",
          ctaLabel: "Open deal",
          ctaKind: "open_deal",
        });
      } else if (stage === "negotiation" && daysSince >= 10) {
        actions.push({
          type: "stuck_negot",
          priority: 8,
          dealUrl: d.profileUrl || "",
          dealName: d.name || "",
          title: `${d.name || ""} stuck at Negotiation — ${Math.round(daysSince)}d`,
          subtitle: "Push with a deadline or pronounce dead.",
          ctaLabel: "Revive",
          ctaKind: "revive_deal",
        });
      } else if (stage === "objection" && daysSince >= 7) {
        actions.push({
          type: "unresolved_obj",
          priority: 7,
          dealUrl: d.profileUrl || "",
          dealName: d.name || "",
          title: `${d.name || ""} hung up on an objection — ${Math.round(daysSince)}d`,
          subtitle: "Address the block head-on with proof.",
          ctaLabel: "Handle objection",
          ctaKind: "handle_objection",
        });
      }
    }

    // 4. Hot deals that went silent 3+ days — re-engage before they cool.
    for (const d of active) {
      const t = calcDealTemperature(d);
      const daysSince = (now - (d.lastActivityAt || d.savedAt || 0)) / 86400000;
      if (t.label === "hot" && daysSince >= 3 && daysSince < 7) {
        actions.push({
          type: "hot_silent",
          priority: 8,
          dealUrl: d.profileUrl || "",
          dealName: d.name || "",
          title: `${d.name || ""} was hot ${Math.round(daysSince)}d ago`,
          subtitle: `${t.reason} — don't let them cool.`,
          ctaLabel: "Re-engage",
          ctaKind: "reengage_hot",
        });
      }
    }

    // 5. Revive frozen / ghosted deals with fresh angle.
    for (const d of active) {
      const daysSince = (now - (d.lastActivityAt || d.savedAt || 0)) / 86400000;
      if (daysSince >= 14) {
        actions.push({
          type: "revive",
          priority: 5,
          dealUrl: d.profileUrl || "",
          dealName: d.name || "",
          title: `Revive: ${d.name || ""} · silent ${Math.round(daysSince)}d`,
          subtitle: "Klosr will pull fresh news about their company and draft an angle.",
          ctaLabel: "Revive with fresh angle",
          ctaKind: "revive_deal",
        });
      }
    }

    // 6. Single-threaded late-stage — huge risk, cheap fix.
    for (const d of active) {
      const stage = d.dealStage || d.stage;
      if (!["discovery", "objection", "negotiation", "closing"].includes(stage)) continue;
      // Proxy for single-threaded: no "second_contact" flag in deal record +
      // late stage. We could count call participants here but that data
      // isn't structured yet — safe proxy: always suggest for late-stage
      // deals that don't already have a multithread_done flag.
      if (d.multithreadDone) continue;
      actions.push({
        type: "multithread",
        priority: 6,
        dealUrl: d.profileUrl || "",
        dealName: d.name || "",
        title: `Pull in a 2nd stakeholder at ${d.currentCompany || d.name || ""}`,
        subtitle: "Single-threaded deals die. Klosr will find the other decision-maker.",
        ctaLabel: "Find decision-maker",
        ctaKind: "multithread_suggest",
      });
    }

    // Deduplicate by (type + dealUrl): avoid double-listing the same deal
    // under multiple buckets. Highest-priority entry wins.
    const seen = new Map();
    for (const a of actions) {
      const key = `${a.type}::${a.dealUrl}`;
      const prev = seen.get(key);
      if (!prev || a.priority > prev.priority) seen.set(key, a);
    }

    return Array.from(seen.values())
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 12);
  }

  // ============================================================
  // MY COMPANY PROFILE — deep personalization stored locally.
  // Injected into EVERY AI call so the tool knows who YOU are,
  // what you sell, who you sell to, and how you talk.
  // ============================================================
  let companyProfile = null; // loaded from chrome.storage on init

  function loadCompanyProfile() {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) { resolve(null); return; }
        chrome.storage.local.get("prepcall_company", (data) => {
          companyProfile = data && data.prepcall_company ? data.prepcall_company : null;
          resolve(companyProfile);
        });
      } catch (e) { resolve(null); }
    });
  }

  function saveCompanyProfile(profile) {
    return new Promise((resolve) => {
      try {
        companyProfile = profile;
        // Fire identity_set so the admin panel can tie events back to the
        // human who runs this install. Fires once per save — cheap.
        setTimeout(() => logKlosrEvent("identity_set", {
          hasName: !!profile.yourName,
          hasCompany: !!profile.companyName,
          hasIcp: !!profile.icp,
          hasEmail: !!profile.email,
          language: currentLanguage,
        }), 100);
        if (!chrome || !chrome.storage || !chrome.storage.local) { resolve(); return; }
        chrome.storage.local.set({ prepcall_company: profile }, resolve);
      } catch (e) { companyProfile = profile; resolve(); }
    });
  }

  // Build a context block from the company profile for injection into AI prompts
  function buildMyContext() {
    const p = companyProfile;
    if (!p || !p.yourName) return "";
    const parts = [];
    parts.push(`ABOUT THE USER (the person using this tool — inject this into every response):`);
    if (p.yourName) parts.push(`- Name: ${p.yourName}`);
    if (p.yourRole) parts.push(`- Role: ${p.yourRole}`);
    if (p.companyName) parts.push(`- Company: ${p.companyName}`);
    if (p.whatYouSell) parts.push(`- What they sell: ${p.whatYouSell}`);
    if (p.icp) parts.push(`- Who they sell to (ICP): ${p.icp}`);
    if (p.valueProp) parts.push(`- Key value prop: ${p.valueProp}`);
    if (p.objections) parts.push(`- Common objections they face: ${p.objections}`);
    if (p.proofPoints) parts.push(`- Proof points / case studies: ${p.proofPoints}`);
    if (p.background) parts.push(`- Personal background / credibility: ${p.background}`);
    if (p.tone) parts.push(`- Communication style: ${p.tone}`);
    parts.push(`\nUSE THIS CONTEXT TO:`);
    parts.push(`- Personalize talking points to reference THEIR product, not generic advice`);
    parts.push(`- Frame questions around THEIR value prop and ICP`);
    parts.push(`- Write emails that mention THEIR company by name and position it naturally`);
    parts.push(`- Anticipate objections the prospect might raise about THEIR specific product`);
    parts.push(`- Use THEIR preferred tone and communication style`);
    return parts.join("\n");
  }

  // Async variant that folds the accumulated-knowledge layers into the
  // context: objection playbook, proof library, and relevant past call notes
  // for the current prospect.
  async function buildMyContextAsync(targetProfile) {
    const base = buildMyContext();
    const extras = [];
    try {
      const [playbook, lib, notes] = await Promise.all([
        getObjectionPlaybook(), getProofLibrary(), getRelevantCallNotes(targetProfile || null),
      ]);
      if (Array.isArray(playbook) && playbook.length > 0) {
        extras.push("\nOBJECTION PLAYBOOK (learned from real conversations — not a form field):");
        playbook.slice(-12).forEach((x, i) => {
          const trig = String(x.trigger || "").slice(0, 200).replace(/\s+/g, " ");
          const reb  = String(x.rebuttal || "").slice(0, 600).replace(/\s+/g, " ");
          extras.push(`  ${i + 1}. [${trig}] → ${reb}`);
        });
        extras.push("Use the same voice and framing when a similar objection comes up.");
      }
      if (Array.isArray(lib) && lib.length > 0) {
        extras.push("\nPROOF POINT LIBRARY (pick the ONE most relevant to this prospect):");
        lib.forEach((p, i) => {
          const tags = [p.industry, p.useCase].filter(Boolean).join(", ");
          extras.push(`  ${i + 1}. ${p.title || "(untitled)"}${p.metric ? " — " + p.metric : ""}${tags ? " [" + tags + "]" : ""}`);
          if (p.body) extras.push(`     ${String(p.body).slice(0, 400)}`);
        });
        extras.push("Pick the most relevant ONE. Do not paste the whole list.");
      }
      if (Array.isArray(notes) && notes.length > 0) {
        extras.push("\nPAST CALL NOTES FROM SIMILAR PROSPECTS (absorbed after real calls):");
        notes.forEach((n, i) => {
          const who = [n.name, n.role, n.company].filter(Boolean).join(" · ");
          if (who) extras.push(`  ${i + 1}. ${who}`);
          if (n.keyInsights) extras.push(`     Insight: ${String(n.keyInsights).slice(0, 400)}`);
          else if (n.rawNotes) extras.push(`     Notes: ${String(n.rawNotes).slice(0, 400)}`);
        });
        extras.push("Use these to anticipate what this prospect is likely to react to.");
      }
    } catch (e) {}
    return base + (extras.length ? "\n" + extras.join("\n") : "");
  }

  // Sender info persistence — saved once, reused across all profiles
  function loadSenderFromStorage() {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) {
          resolve(null);
          return;
        }
        chrome.storage.local.get("prepcall_sender", (data) => {
          currentSender = data && data.prepcall_sender ? data.prepcall_sender : null;
          resolve(currentSender);
        });
      } catch (e) {
        console.warn("PrepCall.AI: chrome.storage unavailable", e);
        resolve(null);
      }
    });
  }

  function saveSenderToStorage(sender) {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) {
          currentSender = sender;
          resolve();
          return;
        }
        chrome.storage.local.set({ prepcall_sender: sender }, () => {
          currentSender = sender;
          resolve();
        });
      } catch (e) {
        console.warn("PrepCall.AI: chrome.storage unavailable", e);
        currentSender = sender;
        resolve();
      }
    });
  }

  // Language strings (UI-facing)
  const i18n = {
    en: {
      prepping_for: "Prepping for",
      whats_the_call: "What's the call?",
      sales_title: "Sales Call",
      sales_desc: "You're selling to them. Real-time intel, pain points, conversation starters.",
      interview_title: "Interview",
      interview_desc: "They're interviewing you. What they value, likely topics, power line.",
      pitch_title: "Pitch",
      pitch_desc: "You're pitching them (investor, partner). Opening line, objections, the ask.",
      reading_profile: "Reading profile...",
      reading_profile_sub: "Gathering experience, posts, and activity",
      searching_web: "Searching the web...",
      searching_web_sub: "Pulling real-time intel on this prospect",
      copy_brief: "Copy Brief",
      copied: "Copied!",
      refresh: "Refresh",
      sales_label: "Sales Call Prep",
      interview_label: "Interview Prep",
      pitch_label: "Pitch Prep",
      chat_placeholder: "Ask a follow-up...",
      chat_thinking: "Thinking...",
      chat_error: "Something went wrong. Try again.",
      quest_title: "Let's tailor your brief",
      quest_subtitle: "A few quick details so the brief is actually about YOUR interview.",
      quest_role_label: "Role you're interviewing for",
      quest_role_placeholder: "e.g. HR Analyst, Product Designer, Founding Engineer",
      quest_background_label: "Your background",
      quest_background_placeholder: "1-2 lines on your experience and strengths (e.g. 3 yrs of recruitment ops + Python, finishing MSc in HR Analytics)",
      quest_focus_label: "Anything specific to focus on? (optional)",
      quest_focus_placeholder: "e.g. I want to stress my data skills; avoid salary talk; they asked me about a past project",
      quest_submit: "Generate Brief",
      quest_back: "Back",
      email_btn: "Email",
      email_loading: "Drafting your email...",
      email_loading_sub: "Personalizing it with the brief",
      email_setup_title: "Tell me about you",
      email_setup_subtitle: "I'll use this to sign your emails. Saved locally — only you see it.",
      email_setup_name_label: "Your full name",
      email_setup_name_placeholder: "e.g. Bosco Maldonado",
      email_setup_role_label: "Your role",
      email_setup_role_placeholder: "e.g. Founder, Sales Lead, Student",
      email_setup_company_label: "Your company / project",
      email_setup_company_placeholder: "e.g. Klosr",
      email_setup_context_label: "Why you're reaching out (optional)",
      email_setup_context_placeholder: "e.g. Looking for a junior role at Deloitte",
      email_setup_submit: "Save & generate email",
      email_setup_back: "Back",
      email_subject_label: "Subject",
      email_body_label: "Body",
      email_guesses_label: "Likely email addresses",
      email_no_guesses: "Couldn't guess email patterns — enter the recipient address manually.",
      email_copy: "Copy",
      email_copied: "Copied!",
      email_copy_full: "Copy full email",
      email_copied_full: "Copied full email!",
      email_back_to_brief: "Back to brief",
      email_edit_sender: "Edit your info",
      email_error: "Couldn't generate the email. Try again.",
      email_open_gmail: "Open in Gmail",
      email_found_label: "Found on LinkedIn",
      email_found_badge: "VERIFIED",
      email_draft_gmail: "Draft in Gmail",
      email_no_recipient: "No email — compose blank",
      email_sending_to: "Sending to",
      quick_placeholder: "Ask anything about",
      quick_questions: "3 Questions",
      quick_opener: "Opening Line",
      quick_talking: "Talking Points",
      quick_email: "Cold Email",
      quick_divider: "or generate full brief",
      quick_copy: "Copy",
      quick_copied: "Copied!",
      quick_another: "Ask another",
      quick_back: "Back",
      quick_loading: "Thinking...",
      quick_section_prep: "QUICK PREP",
      quick_section_outreach: "OUTREACH",
      quick_section_after: "AFTER THE CALL",
      quick_connection: "Connection Note",
      quick_dm: "LinkedIn DM",
      quick_followup: "Follow-up Email",
      quick_icp_fit: "ICP Fit",
      quick_objections: "Objections",
      quick_why_now: "Why Now",
      followup_title: "How did the call go?",
      followup_subtitle: "Quick notes — AI turns them into a perfect follow-up email.",
      followup_outcome_label: "How did it go?",
      followup_outcome_placeholder: "e.g. Great — they're interested, wants a demo next week",
      followup_points_label: "Key points discussed",
      followup_points_placeholder: "e.g. Talked about their data pipeline problems, showed pricing, they liked the integrations",
      followup_next_label: "Next steps agreed",
      followup_next_placeholder: "e.g. Send case study + book demo for Thursday",
      followup_submit: "Generate Follow-up",
      followup_back: "Back",
      connection_chars: "chars",
      recents_title: "RECENT PROSPECTS",
      recents_empty: "Your prepped prospects will appear here",
      next_step: "NEXT STEP",
      next_send_email: "Send cold email",
      next_connect: "Send connection note",
      next_dm: "Send DM",
      next_full_brief: "Full research brief",
      stats_title: "Your Pipeline",
      stats_empty: "Prep your first prospect to start tracking",
      stats_prospects: "Prospects",
      stats_contacted: "Contacted",
      stats_replied: "Replied",
      stats_calls: "Calls",
      stats_closing: "Closing",
      stats_won: "Won",
      stats_rate: "Reply rate",
      stats_show: "Pipeline",
      setup_title: "Tell me about you & your company",
      setup_subtitle: "I'll use this to personalize every email, talking point, and brief. Saved locally — only you see it.",
      setup_name: "Your full name",
      setup_name_ph: "e.g. Bosco Maldonado",
      setup_role: "Your role",
      setup_role_ph: "e.g. Founder & CEO",
      setup_company: "Company name",
      setup_company_ph: "e.g. Klosr",
      setup_sell: "What do you sell? (1-2 sentences)",
      setup_sell_ph: "e.g. Chrome extension that helps B2B founders prep for sales calls in 30 seconds using AI + real-time web research",
      setup_icp: "Who do you sell to? (your ideal customer)",
      setup_icp_ph: "e.g. B2B SaaS founders doing founder-led sales, pre-seed to Series A, 1-15 people",
      setup_value: "Your key differentiator (why you vs alternatives)",
      setup_value_ph: "e.g. Real-time web research on the actual person — not static database entries like Apollo. 30 seconds, not 15 minutes.",
      setup_objections: "Common objections you hear (optional)",
      setup_objections_ph: "e.g. 'I can just Google them', 'We already use Apollo', 'How is this different from ChatGPT?'",
      setup_proof: "Proof points / case studies (optional)",
      setup_proof_ph: "e.g. Used by 50 founders. 43% reply rate vs 5% industry average. Helped close a $200K deal in the first week.",
      setup_background: "Your personal background (what makes YOU credible)",
      setup_background_ph: "e.g. Built 3 SaaS products, sold two. Ex-Goldman. YC S24.",
      setup_tone: "How do you like to communicate?",
      setup_tone_ph: "e.g. Casual but sharp. No corporate jargon. Short sentences. Slightly cheeky.",
      setup_save: "Save",
      setup_gear_tooltip: "My profile",
    },
    es: {
      prepping_for: "Preparando",
      whats_the_call: "¿Qué tipo de llamada?",
      sales_title: "Llamada de Ventas",
      sales_desc: "Les estás vendiendo. Intel en tiempo real, puntos de dolor, iniciadores de conversación.",
      interview_title: "Entrevista",
      interview_desc: "Te están entrevistando. Qué valoran, temas probables, frase poder.",
      pitch_title: "Pitch",
      pitch_desc: "Les estás haciendo pitch (inversor, partner). Frase de apertura, objeciones, la petición.",
      reading_profile: "Leyendo perfil...",
      reading_profile_sub: "Recopilando experiencia, posts y actividad",
      searching_web: "Buscando en la web...",
      searching_web_sub: "Obteniendo intel en tiempo real sobre este prospecto",
      copy_brief: "Copiar Brief",
      copied: "¡Copiado!",
      refresh: "Actualizar",
      sales_label: "Prep de Venta",
      interview_label: "Prep de Entrevista",
      pitch_label: "Prep de Pitch",
      chat_placeholder: "Haz una pregunta de seguimiento...",
      chat_thinking: "Pensando...",
      chat_error: "Algo salió mal. Inténtalo de nuevo.",
      quest_title: "Personalicemos tu brief",
      quest_subtitle: "Unos detalles rápidos para que el brief sea de TU entrevista real.",
      quest_role_label: "Rol al que te entrevistas",
      quest_role_placeholder: "ej. Analista de RRHH, Product Designer, Founding Engineer",
      quest_background_label: "Tu trayectoria",
      quest_background_placeholder: "1-2 líneas sobre tu experiencia y fortalezas (ej. 3 años en ops de selección + Python, terminando MSc en HR Analytics)",
      quest_focus_label: "¿Algo específico en lo que enfocarse? (opcional)",
      quest_focus_placeholder: "ej. Quiero destacar mis skills de datos; evitar temas de sueldo; me preguntaron por un proyecto anterior",
      quest_submit: "Generar Brief",
      quest_back: "Atrás",
      email_btn: "Email",
      email_loading: "Redactando tu email...",
      email_loading_sub: "Personalizándolo con el brief",
      email_setup_title: "Cuéntame sobre ti",
      email_setup_subtitle: "Lo usaré para firmar tus emails. Se guarda localmente — solo tú lo ves.",
      email_setup_name_label: "Tu nombre completo",
      email_setup_name_placeholder: "ej. Bosco Maldonado",
      email_setup_role_label: "Tu rol",
      email_setup_role_placeholder: "ej. Founder, Sales Lead, Estudiante",
      email_setup_company_label: "Tu empresa / proyecto",
      email_setup_company_placeholder: "ej. Klosr",
      email_setup_context_label: "Por qué escribes (opcional)",
      email_setup_context_placeholder: "ej. Busco un puesto junior en Deloitte",
      email_setup_submit: "Guardar y generar email",
      email_setup_back: "Atrás",
      email_subject_label: "Asunto",
      email_body_label: "Cuerpo",
      email_guesses_label: "Emails probables",
      email_no_guesses: "No pude adivinar el email — introdúcelo manualmente.",
      email_copy: "Copiar",
      email_copied: "¡Copiado!",
      email_copy_full: "Copiar email completo",
      email_copied_full: "¡Email completo copiado!",
      email_back_to_brief: "Volver al brief",
      email_edit_sender: "Editar tu info",
      email_error: "No se pudo generar el email. Inténtalo de nuevo.",
      email_open_gmail: "Abrir en Gmail",
      email_found_label: "Encontrado en LinkedIn",
      email_found_badge: "VERIFICADO",
      email_draft_gmail: "Redactar en Gmail",
      email_no_recipient: "Sin email — abrir en blanco",
      email_sending_to: "Enviando a",
      quick_placeholder: "Pregunta lo que quieras sobre",
      quick_questions: "3 Preguntas",
      quick_opener: "Línea de Apertura",
      quick_talking: "Puntos Clave",
      quick_email: "Email Frío",
      quick_divider: "o generar brief completo",
      quick_copy: "Copiar",
      quick_copied: "¡Copiado!",
      quick_another: "Otra pregunta",
      quick_back: "Atrás",
      quick_loading: "Pensando...",
      quick_section_prep: "PREPARACIÓN RÁPIDA",
      quick_section_outreach: "CONTACTO",
      quick_section_after: "DESPUÉS DE LA LLAMADA",
      quick_connection: "Nota de Conexión",
      quick_dm: "DM de LinkedIn",
      quick_followup: "Email de Seguimiento",
      quick_icp_fit: "Fit ICP",
      quick_objections: "Objeciones",
      quick_why_now: "Por Qué Ahora",
      followup_title: "¿Cómo fue la llamada?",
      followup_subtitle: "Notas rápidas — la IA las convierte en un email de seguimiento perfecto.",
      followup_outcome_label: "¿Cómo fue?",
      followup_outcome_placeholder: "ej. Genial — les interesa, quieren demo la próxima semana",
      followup_points_label: "Puntos clave discutidos",
      followup_points_placeholder: "ej. Hablamos de sus problemas de data pipeline, mostré precios, les gustaron las integraciones",
      followup_next_label: "Próximos pasos acordados",
      followup_next_placeholder: "ej. Enviar caso de estudio + agendar demo para el jueves",
      followup_submit: "Generar Seguimiento",
      followup_back: "Atrás",
      connection_chars: "caract.",
      recents_title: "PROSPECTOS RECIENTES",
      recents_empty: "Tus prospectos preparados aparecerán aquí",
      next_step: "SIGUIENTE PASO",
      next_send_email: "Enviar email frío",
      next_connect: "Enviar nota de conexión",
      next_dm: "Enviar DM",
      next_full_brief: "Brief completo",
      stats_title: "Tu Pipeline",
      stats_empty: "Prepara tu primer prospecto para empezar a trackear",
      stats_prospects: "Prospectos",
      stats_contacted: "Contactados",
      stats_replied: "Respondieron",
      stats_calls: "Llamadas",
      stats_closing: "Cerrando",
      stats_won: "Ganados",
      stats_rate: "Tasa de respuesta",
      stats_show: "Pipeline",
      setup_title: "Cuéntame sobre ti y tu empresa",
      setup_subtitle: "Lo usaré para personalizar cada email, punto de conversación y brief. Se guarda localmente — solo tú lo ves.",
      setup_name: "Tu nombre completo",
      setup_name_ph: "ej. Bosco Maldonado",
      setup_role: "Tu rol",
      setup_role_ph: "ej. Founder & CEO",
      setup_company: "Nombre de la empresa",
      setup_company_ph: "ej. Klosr",
      setup_sell: "¿Qué vendes? (1-2 frases)",
      setup_sell_ph: "ej. Extensión de Chrome que ayuda a founders B2B a prepararse para llamadas de ventas en 30 seg con IA + investigación web en tiempo real",
      setup_icp: "¿A quién le vendes? (tu cliente ideal)",
      setup_icp_ph: "ej. Founders B2B SaaS haciendo ventas propias, pre-seed a Serie A, 1-15 personas",
      setup_value: "Tu diferenciador clave (por qué tú vs alternativas)",
      setup_value_ph: "ej. Investigación web en tiempo real sobre la persona real — no entradas estáticas de base de datos como Apollo. 30 segundos, no 15 minutos.",
      setup_objections: "Objeciones comunes que escuchas (opcional)",
      setup_objections_ph: "ej. 'Puedo buscar en Google', 'Ya usamos Apollo', '¿En qué se diferencia de ChatGPT?'",
      setup_proof: "Puntos de prueba / casos de éxito (opcional)",
      setup_proof_ph: "ej. Usado por 50 founders. 43% tasa de respuesta vs 5% del sector. Ayudó a cerrar un deal de $200K la primera semana.",
      setup_background: "Tu trayectoria personal (qué te hace creíble)",
      setup_background_ph: "ej. Construí 3 productos SaaS, vendí dos. Ex-Goldman. YC S24.",
      setup_tone: "¿Cómo te gusta comunicarte?",
      setup_tone_ph: "ej. Casual pero afilado. Sin jerga corporativa. Frases cortas. Un poco cheeky.",
      setup_save: "Guardar",
      setup_gear_tooltip: "Mi perfil",
    },
  };

  function t(key) {
    return (i18n[currentLanguage] && i18n[currentLanguage][key]) || i18n.en[key] || key;
  }

  // Create the floating button
  function createButton() {
    if (document.getElementById("briefme-btn")) return;

    const btn = document.createElement("div");
    btn.id = "briefme-btn";
    btn.innerHTML = `
      <div class="briefme-btn-inner">
        <svg class="briefme-btn-mark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F0CE6C" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 4v16"/>
          <path d="M6 12l7-8"/>
          <path d="M6 12l7 8"/>
        </svg>
        <span>Klosr</span>
      </div>
    `;
    btn.addEventListener("click", handleClick);
    document.body.appendChild(btn);
  }

  // Clean a scraped name — strip LinkedIn's hidden tracking hashes,
  // verified badges, connection degree markers, and other trailing garbage.
  // E.g. "Charlotte Langley 80b49616" → "Charlotte Langley"
  //      "Juan Zorrilla Rosón ✓ · 3er" → "Juan Zorrilla Rosón"
  function cleanScrapedName(raw) {
    if (!raw) return "";
    // Normalize all whitespace (including non-breaking spaces) to ASCII space
    let name = String(raw).replace(/[\s\u00a0\u200b]+/g, " ").trim();

    // Strip verification / status symbols (✓ ✔ ✅ ◉ etc.)
    name = name.replace(/[✓✔✅◉●]/g, " ");

    // Strip "(He/Him)", "(She/Her)", "(They/Them)" etc. (any trailing pronoun parens)
    name = name.replace(/\s*\([^)]{0,30}\)\s*$/g, "");

    // Strip trailing connection degree ("· 2nd", "• 3rd", "· 3er", "1.°" etc.)
    name = name.replace(/\s*[·•]\s*\d+(st|nd|rd|th|er|do|ro|ta|°|º)?\b.*$/i, "");

    // CORE FIX: strip ANY trailing token that contains a digit.
    // Real human names don't have digits in them — anything trailing
    // with digits (LinkedIn tracking hashes, IDs, hex strings like
    // "80b49616") is garbage. Run this LOOP until no more matches,
    // because LinkedIn sometimes injects multiple trailing tokens.
    let prev;
    do {
      prev = name;
      name = name.replace(/\s+\S*\d\S*\s*$/, "").trim();
    } while (name !== prev);

    // Strip trailing "verified" labels (EN + ES)
    name = name.replace(/\s+(verified|verificado|verificada)\s*$/i, "");

    // Collapse any leftover whitespace
    return name.replace(/\s+/g, " ").trim();
  }

  // Extract initials for the avatar fallback. "Charlotte Langley" → "CL"
  function getInitials(name) {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  // Scrape REAL email addresses from the LinkedIn profile DOM.
  // Priority: (1) mailto: links anywhere on the page, (2) emails visible in
  // the main content text (About, headline, posts, Contact info modal).
  // Filters out LinkedIn system emails and common noise.
  function scrapeContactEmails() {
    const found = new Set();
    const emailRe = /[a-zA-Z0-9._+\-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const isImageExt = (e) => /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(e);
    const blacklisted = (e) => {
      const lower = e.toLowerCase();
      return (
        lower.includes("@linkedin.com") ||
        lower.includes("@licdn.com") ||
        lower.includes("noreply@") ||
        lower.includes("no-reply@") ||
        lower.includes("donotreply@") ||
        lower.includes("support@linkedin") ||
        lower.includes("@localhost") ||
        lower.includes(".example") ||
        isImageExt(lower)
      );
    };
    const add = (raw) => {
      if (!raw) return;
      const cleaned = String(raw).toLowerCase().trim().replace(/[,.;]+$/, "");
      if (!cleaned.includes("@")) return;
      if (!emailRe.test(cleaned)) return;
      emailRe.lastIndex = 0; // reset global regex state
      if (blacklisted(cleaned)) return;
      found.add(cleaned);
    };

    // 1. mailto: links — the most reliable source
    try {
      document.querySelectorAll('a[href^="mailto:"], a[href^="MAILTO:"]').forEach((a) => {
        const href = a.getAttribute("href") || "";
        const email = href.replace(/^mailto:/i, "").split("?")[0].trim();
        add(email);
      });
    } catch (e) {}

    // 2. Scan visible main-content text for email patterns
    try {
      const main = document.querySelector("main") || document.body;
      if (main) {
        const text = main.innerText || main.textContent || "";
        const matches = text.match(emailRe) || [];
        matches.forEach(add);
      }
    } catch (e) {}

    // 3. Also check any LinkedIn overlay modal that might already be open
    try {
      document.querySelectorAll(".artdeco-modal, [role='dialog']").forEach((modal) => {
        const text = modal.innerText || modal.textContent || "";
        const matches = text.match(emailRe) || [];
        matches.forEach(add);
      });
    } catch (e) {}

    return Array.from(found);
  }

  // Persistent email auto-catcher. Watches every modal / dialog that enters
  // the DOM — whether the user clicked it themselves, LinkedIn auto-opened
  // it, or Klosr triggered it via the Contact Info scrape path. Any email
  // found gets merged into currentProfile.extractedEmails and the picker
  // UI re-renders automatically. This means Klosr never "misses" an email
  // that's visible on screen.
  let _emailAutoCatcher = null;
  function startEmailAutoCatcher() {
    if (_emailAutoCatcher) return;
    const emailRe = /[a-zA-Z0-9._+\-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const MODAL_SEL = '.artdeco-modal, .artdeco-modal-overlay, [role="dialog"], [aria-modal="true"], [data-test-modal], [data-test-modal-id]';

    const isSystem = (e) => {
      const l = e.toLowerCase();
      return l.includes("@linkedin.com")
        || l.includes("@licdn.com")
        || l.startsWith("noreply@")
        || l.startsWith("no-reply@")
        || l.startsWith("donotreply@");
    };

    const harvestFrom = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.id === "briefme-sidebar" || node.closest?.("#briefme-sidebar")) return;

      const found = new Set();
      // mailto: is the cleanest source when present
      try {
        node.querySelectorAll?.('a[href^="mailto:"], a[href^="MAILTO:"]').forEach(a => {
          const raw = (a.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
          if (raw.includes("@") && !isSystem(raw)) found.add(raw);
        });
      } catch (e) {}
      // Text scan as fallback / additional catch
      try {
        const text = node.innerText || node.textContent || "";
        (text.match(emailRe) || []).forEach(m => {
          const lower = m.toLowerCase().replace(/[,.;]+$/, "").trim();
          if (!isSystem(lower)) found.add(lower);
        });
      } catch (e) {}

      if (found.size === 0) return;
      if (!currentProfile) return;
      const existing = Array.isArray(currentProfile.extractedEmails) ? currentProfile.extractedEmails : [];
      const merged = Array.from(new Set([...existing, ...found])).filter(Boolean);
      if (merged.length === existing.length) return;

      currentProfile.extractedEmails = merged;
      // Flip picker-email state to "found" so the row re-renders cleanly.
      currentProfile.leadmagicState = "found";
      if (document.getElementById("briefme-picker-email")) renderPickerEmail();
      if (currentEmail && document.querySelector(".briefme-email-view")) showEmailView(currentEmail);
      console.log("[Klosr] auto-catcher picked up emails:", merged);
    };

    const scanNode = (node) => {
      if (!node || node.nodeType !== 1) return;
      // Scan the node itself if it's modal-shaped, plus any modal descendants
      try {
        if (node.matches?.(MODAL_SEL)) harvestFrom(node);
        node.querySelectorAll?.(MODAL_SEL).forEach(harvestFrom);
      } catch (e) {}
    };

    // Scan anything already on the page
    try { document.querySelectorAll(MODAL_SEL).forEach(harvestFrom); } catch (e) {}

    _emailAutoCatcher = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes && m.addedNodes.forEach(scanNode);
      }
    });
    _emailAutoCatcher.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // Install a persistent stylesheet that hides LinkedIn overlays whenever
  // <html data-klosr-scraping="1"> is set. Three layers of hiding so no
  // matter which CSS wins specificity, the user never sees a flash:
  //   1. display: none  — removes from layout entirely
  //   2. opacity: 0     — in case LinkedIn overrides display with !important
  //   3. position off-screen — in case both above lose to higher-specificity
  //      rules from LinkedIn (CSS cascade fallback).
  // Plus: the MutationObserver in hideModalsDuringScrape forcibly applies
  // inline styles on any modal node added DURING the scrape window, which
  // beats any stylesheet on the page.
  function ensureOverlayHiderInstalled() {
    if (document.getElementById("klosr-overlay-hider")) return;
    const st = document.createElement("style");
    st.id = "klosr-overlay-hider";
    st.textContent = `
      html[data-klosr-scraping="1"] .artdeco-modal,
      html[data-klosr-scraping="1"] .artdeco-modal-overlay,
      html[data-klosr-scraping="1"] .artdeco-modal__content,
      html[data-klosr-scraping="1"] .artdeco-modal__scrim,
      html[data-klosr-scraping="1"] div[role="dialog"],
      html[data-klosr-scraping="1"] [aria-modal="true"],
      html[data-klosr-scraping="1"] [data-test-modal],
      html[data-klosr-scraping="1"] [data-test-modal-id],
      html[data-klosr-scraping="1"] [data-test-contact-info],
      html[data-klosr-scraping="1"] [class*="contact-info" i],
      html[data-klosr-scraping="1"] [class*="artdeco-modal" i] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
        position: fixed !important;
        left: -99999px !important;
        top: -99999px !important;
        width: 1px !important;
        height: 1px !important;
        overflow: hidden !important;
        z-index: -1 !important;
      }
      html[data-klosr-scraping="1"] body { overflow: auto !important; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  // Live DOM observer that forcibly hides any modal-shaped node added to
  // the page while the scrape flag is set. This is the belt-and-suspenders
  // layer: even if the CSS somehow loses the cascade, inline style set by
  // this observer wins because inline style beats any external stylesheet
  // at the same specificity level.
  function createScrapeHideObserver() {
    const modalSelector = [
      ".artdeco-modal",
      ".artdeco-modal-overlay",
      ".artdeco-modal__content",
      ".artdeco-modal__scrim",
      '[role="dialog"]',
      '[aria-modal="true"]',
      "[data-test-modal]",
      "[data-test-modal-id]",
    ].join(",");

    const HIDE_STYLE = [
      "display: none !important",
      "visibility: hidden !important",
      "opacity: 0 !important",
      "pointer-events: none !important",
      "position: fixed !important",
      "left: -99999px !important",
      "top: -99999px !important",
      "width: 1px !important",
      "height: 1px !important",
      "overflow: hidden !important",
      "z-index: -1 !important",
    ].join("; ");

    const hideNode = (node) => {
      if (!node || node.nodeType !== 1) return;
      try {
        // The Klosr sidebar itself is NOT a modal to hide.
        if (node.id === "briefme-sidebar" || node.closest?.("#briefme-sidebar")) return;
        if (node.matches?.(modalSelector)) {
          node.setAttribute("style", (node.getAttribute("style") || "") + ";" + HIDE_STYLE);
        }
        const inner = node.querySelectorAll?.(modalSelector);
        if (inner && inner.length) {
          inner.forEach((n) => {
            if (n.id === "briefme-sidebar" || n.closest?.("#briefme-sidebar")) return;
            n.setAttribute("style", (n.getAttribute("style") || "") + ";" + HIDE_STYLE);
          });
        }
      } catch (e) {}
    };

    const observer = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes && m.addedNodes.forEach(hideNode);
        // Also re-hide on attribute changes (LinkedIn toggles classes to
        // animate the modal in; hiding might get overridden).
        if (m.type === "attributes" && m.target) hideNode(m.target);
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-hidden", "open"],
    });

    // Also hide anything already on the page right now.
    try {
      document.querySelectorAll(modalSelector).forEach(hideNode);
    } catch (e) {}

    return observer;
  }

  // Programmatically open LinkedIn's "Contact info" overlay, scrape emails
  // out of it, and close it. The overlay is kept fully invisible during the
  // whole round-trip via the persistent hider above. Returns an array
  // (possibly empty).
  async function scrapeContactInfoViaModal() {
    const emailRe = /[a-zA-Z0-9._+\-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const notSystem = (e) => {
      const lower = e.toLowerCase();
      return !lower.includes("@linkedin.com")
        && !lower.includes("@licdn.com")
        && !lower.includes("noreply@")
        && !lower.includes("no-reply@")
        && !lower.includes("donotreply@");
    };

    // Find the Contact info trigger across DOM shapes + languages
    let trigger =
      document.querySelector("a#top-card-text-details-contact-info") ||
      document.querySelector('a[href*="/overlay/contact-info"]') ||
      document.querySelector('a[data-control-name="contact_see_more"]');

    if (!trigger) {
      const anchors = document.querySelectorAll("main a, #top-card-text-details-contact-info, header a");
      for (const a of anchors) {
        const txt = (a.textContent || "").trim().toLowerCase();
        if (!txt) continue;
        if (txt === "contact info"
          || txt === "información de contacto"
          || txt === "informacion de contacto"
          || txt === "kontaktinfo"
          || /contact info|información de contacto|informacion de contacto/i.test(txt)) {
          trigger = a;
          break;
        }
      }
    }

    if (!trigger) return [];

    // Three-layer hide BEFORE the click so the overlay never becomes visible:
    //   (1) stylesheet w/ display:none + off-screen position (already installed)
    //   (2) data-klosr-scraping attribute on <html> to activate the stylesheet
    //   (3) MutationObserver that sets inline !important styles on any modal
    //       node as soon as it enters the DOM (beats external stylesheets)
    ensureOverlayHiderInstalled();
    document.documentElement.setAttribute("data-klosr-scraping", "1");
    const hideObserver = createScrapeHideObserver();

    const found = new Set();
    try {
      trigger.click();

      // Poll up to 2.5s for a modal that actually contains email content
      let modal = null;
      const start = Date.now();
      while (Date.now() - start < 2500) {
        await new Promise(r => setTimeout(r, 100));
        const candidates = document.querySelectorAll(".artdeco-modal, [role='dialog']");
        for (const m of candidates) {
          const txt = m.textContent || "";
          if (txt.length > 40 && (/@/.test(txt) || m.querySelector('a[href^="mailto:"]'))) {
            modal = m;
            break;
          }
        }
        if (modal) break;
      }

      if (modal) {
        // mailto: links first — the cleanest source
        modal.querySelectorAll('a[href^="mailto:"], a[href^="MAILTO:"]').forEach(a => {
          const raw = (a.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0].trim();
          const lower = raw.toLowerCase();
          if (lower.includes("@") && notSystem(lower)) found.add(lower);
        });
        // Text scan as a fallback
        const modalText = modal.textContent || "";
        (modalText.match(emailRe) || []).forEach(m => {
          const lower = m.toLowerCase().replace(/[,.;]+$/, "").trim();
          if (notSystem(lower)) found.add(lower);
        });

        // Close the modal — try dismiss button, then ESC
        const closeBtn = modal.querySelector(
          'button[aria-label*="Dismiss" i], button[aria-label*="Cerrar" i], button[aria-label*="Close" i], .artdeco-modal__dismiss'
        );
        if (closeBtn) {
          closeBtn.click();
        } else {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        }
      }
    } catch (e) {
      console.warn("Klosr contact-info modal scrape failed:", e);
    } finally {
      // Keep the hider active for an extra beat so the close animation
      // (if any) runs while still invisible, then tear down both layers.
      setTimeout(() => {
        document.documentElement.removeAttribute("data-klosr-scraping");
        try { hideObserver.disconnect(); } catch (e) {}
      }, 500);
    }

    return Array.from(found);
  }

  // Try multiple strategies to grab the profile photo URL.
  // LinkedIn rotates class names often, so we blend class selectors, the
  // canonical URL pattern ("profile-displayphoto"), and alt-text matching.
  // Strictly scoped to the top-card region — never falls back to arbitrary
  // licdn images in <main>, because post thumbnails and company logos would
  // sneak in.
  function scrapeProfilePhoto(profileName) {
    const isNotGhost = (src) => src && !src.includes("ghost") && !src.startsWith("data:");

    // 1. Explicit selectors — covers historical + current LinkedIn DOM
    const explicit = [
      "img.pv-top-card-profile-picture__image",
      "img.pv-top-card-profile-picture__image--show",
      "main img[class*='profile-picture']",
      "button[aria-label*='profile photo' i] img",
      "main section img.profile-photo-edit__preview",
      "main img.presence-entity__image",
      "main img.EntityPhoto-circle-9",
      "main img.EntityPhoto-circle-10",
      "main img.evi-image",
    ];
    for (const sel of explicit) {
      const el = document.querySelector(sel);
      if (el && isNotGhost(el.src)) return el.src;
    }

    // Top-card region — fallbacks must live here, never in <main>
    const topCard =
      document.querySelector("section.pv-top-card") ||
      document.querySelector("section[data-member-id]") ||
      document.querySelector("main section:first-of-type");
    if (!topCard) return "";

    const imgs = Array.from(topCard.querySelectorAll("img"));

    // 2. Canonical URL pattern — LinkedIn serves profile avatars from URLs
    // containing "profile-displayphoto" or "displayphoto-shrink". This is
    // the most reliable selector-independent match.
    for (const img of imgs) {
      const src = img.src || "";
      if (!isNotGhost(src) || !src.includes("licdn")) continue;
      if (/profile-displayphoto|displayphoto-shrink/.test(src)) return src;
    }

    // 3. Alt-text match — any token of the profile name appearing in alt
    if (profileName) {
      const nameTokens = profileName.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
      for (const img of imgs) {
        const src = img.src || "";
        if (!isNotGhost(src) || !src.includes("licdn")) continue;
        const alt = (img.alt || "").toLowerCase();
        if (alt && nameTokens.some(tok => alt.includes(tok))) return src;
      }
    }

    // 4. First reasonable square-ish licdn image in the top card — last
    // resort before giving up. Gated by size so we don't catch tiny badges.
    for (const img of imgs) {
      const src = img.src || "";
      if (!isNotGhost(src) || !src.includes("licdn")) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w >= 120 && h >= 120 && Math.abs(w - h) < w * 0.25) return src;
    }

    return "";
  }

  // Derive a human-readable name from a LinkedIn URL handle.
  // E.g. "/in/juan-zorrilla-ros%C3%B3n/" → "Juan Zorrilla Rosón"
  // Only usable for slugs that contain hyphens; a single-word slug
  // ("pauaguilaar") can't be split into real first/last names and is rejected.
  function deriveNameFromUrl(url) {
    if (!url) return "";
    const match = url.match(/\/in\/([^\/?]+)/);
    if (!match) return "";
    try {
      const parts = decodeURIComponent(match[1])
        .split("-")
        .filter(part => part && !/^\d+$/.test(part));
      if (parts.length < 2) return "";
      return parts
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" ")
        .trim();
    } catch (e) {
      return "";
    }
  }

  // Parse the name out of <title> — LinkedIn titles look like:
  // "(N) Firstname Lastname - Role at Company | LinkedIn"
  // "Firstname Lastname | LinkedIn"
  // "Firstname Lastname - Role | LinkedIn"
  function deriveNameFromDocTitle() {
    const raw = (document.title || "").trim();
    if (!raw) return "";
    // Strip LinkedIn suffix and any leading "(N)" notification counter
    let t = raw
      .replace(/\s*\|\s*LinkedIn\s*$/i, "")
      .replace(/^\s*\(\d+\)\s*/, "")
      .trim();
    // Name is everything before the first " - " / " | "
    const nameFragment = t.split(/\s+[-|·•]\s+/)[0].trim();
    return cleanScrapedName(nameFragment);
  }

  // Scrape LinkedIn profile data from the page (async — triggers lazy loads first)
  async function scrapeProfile() {
    // Short settle so LinkedIn's SPA finishes hydrating after nav. 250ms
    // gives Experience / About a fighting chance to render on a cold open;
    // if the first pass still misses fields, the retry path in handleClick()
    // re-scrapes after a second beat.
    await new Promise(r => setTimeout(r, 250));

    // Trigger LinkedIn's lazy-loading of Experience/Activity sections
    await loadProfileSections();

    const data = {};

    // Name — with multiple fallbacks. Cleaned to strip LinkedIn's
    // hidden tracking hashes (e.g. "Charlotte Langley 80b49616") and
    // verified-badge / connection-degree noise.
    const nameEl = document.querySelector("h1.text-heading-xlarge") ||
                   document.querySelector("main h1") ||
                   document.querySelector("h1");
    data.name = nameEl ? cleanScrapedName(nameEl.textContent) : "";

    // Profile photo (for the avatar in the picker). Needs the name so the
    // fallback inside the top card can match against alt text.
    data.photoUrl = scrapeProfilePhoto(data.name);

    // REAL emails found on the profile (mailto: links, Contact info section,
    // emails written in About/headline/posts). May be empty if the user hasn't
    // shared their email publicly — in that case Apollo fills the gap
    // from the email flow. We do NOT auto-open LinkedIn's Contact Info
    // modal on profile load (it was flashing visible despite the hide-CSS,
    // and opening LinkedIn's native UI on every profile view is intrusive).
    data.extractedEmails = scrapeContactEmails();

    // Headline — NOTE: often stale. Treat as lower priority than Experience.
    // For 3rd-degree profiles LinkedIn restructures the top card slightly;
    // the standard class-based selector misses, so we fall back to the
    // structural "first sibling after h1 that contains a plausible headline"
    // search. A plausible headline is 10-240 chars, contains a role or
    // company phrase, and isn't a button/link-group.
    const headlineEl = document.querySelector(".text-body-medium.break-words") ||
                       document.querySelector("[data-generated-suggestion-target]") ||
                       document.querySelector("main h1 + div .text-body-medium");
    data.headline = headlineEl ? headlineEl.textContent.trim() : "";

    // Structural fallback — when class-based selectors fail (common on
    // 3rd-degree profiles or after LinkedIn CSS churn), walk the DOM from
    // the name h1 downward and grab the first non-trivial text sibling.
    if (!data.headline && nameEl) {
      let cursor = nameEl.parentElement;
      let hops = 0;
      while (cursor && hops < 4) {
        const candidates = cursor.querySelectorAll("div, span");
        for (const c of candidates) {
          const txt = (c.textContent || "").replace(/\s+/g, " ").trim();
          // Filter: 10-240 chars, contains a space (multi-word), not a
          // location/button/button-group, not the name itself.
          if (txt.length < 10 || txt.length > 240) continue;
          if (txt === data.name) continue;
          if (/\b(enviar mensaje|message|seguir|follow|más|more|contactos|connections|contact info|información de contacto)\b/i.test(txt)) continue;
          // Heuristic: a headline usually contains a role keyword or "at/en/@".
          if (/\b(at|en|@|ceo|cto|cfo|coo|vp|director|manager|head of|founder|co-founder|partner|lead|engineer|designer|product|sales|marketing|gerente|fundador|socio|jefe|responsable)\b/i.test(txt)) {
            data.headline = txt;
            break;
          }
        }
        if (data.headline) break;
        cursor = cursor.parentElement;
        hops += 1;
      }
    }

    // Location
    const locationEl = document.querySelector(".text-body-small.inline.t-black--light.break-words") ||
                       document.querySelector("main section:first-of-type .text-body-small");
    data.location = locationEl ? locationEl.textContent.trim() : "";

    // About section
    const aboutSection = document.querySelector("#about ~ div .inline-show-more-text") ||
                         document.querySelector('[class*="about"] .inline-show-more-text') ||
                         document.querySelector("section[data-section='summary'] .text-body-medium");
    data.about = aboutSection ? aboutSection.textContent.trim().substring(0, 2000) : "";

    // Experience (structured, with multiple selector fallbacks)
    data.experience = scrapeExperience();

    // Derive current role/company from entries marked "Present" (multi-language)
    const current = data.experience.find(e =>
      e.duration && /present|actual|actualidad|ahora|currently|heute/i.test(e.duration)
    );
    data.currentRole = current ? current.title : (data.experience[0] && data.experience[0].title) || "";
    data.currentCompany = current ? current.company : (data.experience[0] && data.experience[0].company) || "";

    // LinkedIn's main profile page only renders the top 2 experiences
    // inline — the rest live behind a "Show all N experiences" link that
    // navigates to /details/experience/. We fetch that URL in the
    // background, parse every role, and merge into data.experience.
    // Deduped by (title + company) so we don't double-count visible ones.
    try {
      const detailsExp = await scrapeExperiencesFromDetailsPage(window.location.href);
      if (Array.isArray(detailsExp) && detailsExp.length > 0) {
        const seen = new Set(data.experience.map(e =>
          ((e.title || "") + "|" + (e.company || "")).toLowerCase()
        ));
        for (const e of detailsExp) {
          const k = ((e.title || "") + "|" + (e.company || "")).toLowerCase();
          if (k && k !== "|" && !seen.has(k)) {
            seen.add(k);
            data.experience.push(e);
          }
        }
        console.log(`[Klosr] total experience after merge: ${data.experience.length}`);
      }
    } catch (e) {
      console.warn("[Klosr] experience details-page merge skipped:", e && e.message);
    }

    // Recent activity / posts (with multiple selector fallbacks)
    data.recentPosts = scrapeActivity();

    // Followers / connections
    const followersEl = document.querySelector(".t-bold + .t-black--light");
    data.followers = followersEl ? followersEl.textContent.trim() : "";

    // Profile URL
    data.profileUrl = window.location.href.split("?")[0];

    // RAW PROFILE TEXT — fallback source of truth when selectors fail.
    // Claude parses this robustly even when LinkedIn's DOM changes.
    // Multi-level fallback: <main> → <body> → <html>
    const rawSource = document.querySelector("main") || document.body || document.documentElement;
    if (rawSource) {
      let raw = rawSource.innerText || rawSource.textContent || "";
      raw = raw.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
      data.rawProfileText = raw.substring(0, 12000).trim();
    } else {
      data.rawProfileText = "";
    }

    // Final name fallback chain — DOM h1 scrape already ran; if empty, try
    // document.title (very reliable, carries the person's actual name),
    // then URL slug (only works for multi-part hyphenated slugs).
    if (!data.name) {
      data.name = deriveNameFromDocTitle()
        || deriveNameFromUrl(data.profileUrl)
        || "Unknown";
    }

    // Warm the Proxycurl cache in the background so by the time the user
    // clicks Sales/Interview/Pitch it's already sitting on the profile.
    // Never awaited — briefs don't block on this.
    try { warmNinjaPear(data); } catch (e) {}

    return data;
  }

  // Scroll through profile sections to trigger LinkedIn's lazy loading, then
  // aggressively expand every "see more" / "show all experiences" toggle so
  // the full role list is rendered into the DOM by the time scrapeExperience
  // runs. Without this step, partial-render profiles show 2 roles out of 8
  // and the brief is thin.
  async function loadProfileSections() {
    const originalScroll = window.scrollY;
    const targets = ["#about", "#experience", "#education", "#skills", "#activity"];

    for (const sel of targets) {
      let el = document.querySelector(sel);
      if (!el) {
        el = document.querySelector(`div[id*='${sel.slice(1)}']`);
      }
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "auto" });
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Also scroll the Experience section into view AGAIN after finding it
    // via findExperienceSection (handles Spanish/German/etc where the ID
    // anchor differs). Scrolls to the CONTAINING section, not just the
    // anchor div, so LinkedIn's virtualized list renders every li.
    try {
      const expSec = findExperienceSection();
      if (expSec) {
        expSec.scrollIntoView({ block: "start", behavior: "auto" });
        await new Promise(r => setTimeout(r, 250));
        // Tiny scroll nudge to trigger intersection observers that LinkedIn
        // uses to lazy-render each li.
        window.scrollBy({ top: 200, behavior: "auto" });
        await new Promise(r => setTimeout(r, 150));
        window.scrollBy({ top: -200, behavior: "auto" });
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (e) {}

    // Click "see more" inside descriptions AND "Show all N experiences"
    // button that collapses long lists on modern profiles. Covers 6 languages.
    try {
      const expSec = findExperienceSection();
      const scopes = [
        expSec,
        document.querySelector("section[id*='about'], section:has(> div[id*='about'])"),
      ].filter(Boolean);
      for (const scope of scopes) {
        // Inline "see more" on description paragraphs
        const inlineToggles = scope.querySelectorAll(
          'button.inline-show-more-text__button, ' +
          'button[aria-label*="see more" i], ' +
          'button[aria-label*="ver más" i], ' +
          'button[aria-label*="mehr anzeigen" i], ' +
          'button[aria-label*="voir plus" i], ' +
          'button[aria-label*="altro" i]'
        );
        inlineToggles.forEach(b => { try { b.click(); } catch (e) {} });
      }

      // "Show all X experiences" bottom link — opens a modal with every role.
      // We CAN'T follow the modal (it navigates), but we can click anchors
      // that LOAD MORE inline. Specifically: buttons with aria-label matching.
      const showMoreBtns = document.querySelectorAll(
        'button[aria-label*="Show all" i][aria-label*="experienc" i], ' +
        'button[aria-label*="ver todas" i][aria-label*="experienc" i], ' +
        'button[aria-label*="Alle" i][aria-label*="Erfahrung" i]'
      );
      // Only click if it's clearly an inline "load more" not a navigation link
      showMoreBtns.forEach(b => {
        try {
          const isLink = b.tagName === "A" || b.closest("a");
          if (!isLink) b.click();
        } catch (e) {}
      });
    } catch (e) {}

    // Extra pause so expanded content + any newly-loaded roles land in DOM.
    await new Promise(r => setTimeout(r, 350));

    // Return to original scroll position
    window.scrollTo({ top: originalScroll, behavior: "auto" });
    await new Promise(r => setTimeout(r, 150));
  }

  // Find the <section> on the profile whose heading matches "Experience" in
  // any of the languages LinkedIn localises to. Returns the section element
  // or null. Resilient to LinkedIn's a11y-duplicated heading text
  // ("ExperienciaExperiencia" — visible span + visually-hidden span concatenated).
  function findExperienceSection() {
    const EXP_WORDS = [
      "experience",     // EN
      "experiencia",    // ES
      "erfahrung",      // DE
      "berufserfahrung",// DE (formal)
      "expérience",     // FR
      "esperienza",     // IT
      "ervaring",       // NL
      "doświadczenie",  // PL
      "经历",           // ZH
      "経験",           // JA
      "경력",           // KO
    ];

    // Strategy A: anchor div with a known English ID (LinkedIn keeps these
    // stable across locales for deep-linking: /in/<slug>#experience).
    const anchor = document.querySelector("div#experience, section#experience");
    if (anchor) {
      let sec = anchor.closest("section");
      if (!sec) {
        // Anchor is a sibling of the section it anchors to.
        let cur = anchor.nextElementSibling;
        while (cur && cur.tagName !== "SECTION") cur = cur.nextElementSibling;
        if (cur) sec = cur;
      }
      if (sec) return sec;
    }

    // Strategy B: scan every main section, substring-check the heading.
    // We use lowercase .includes() rather than \b-bounded regex because
    // LinkedIn concatenates visually-hidden a11y text with visible text,
    // producing "ExperienciaExperiencia" with no word boundary to match on.
    const sections = document.querySelectorAll("main section, section");
    for (const s of sections) {
      const heading = s.querySelector("h2, h3, h4");
      if (!heading) continue;
      const raw = (heading.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!raw) continue;
      // Bail on stupid-long text — a real Experience heading is <40 chars.
      if (raw.length > 80) continue;
      for (const word of EXP_WORDS) {
        if (raw.includes(word)) return s;
      }
    }
    return null;
  }

  // Scrape experience entries with multiple selector fallbacks
  // Fetch LinkedIn's /details/experience/ page in the background and parse
  // every role from it. The main profile page only renders the top 2 roles
  // inline — the rest sit behind a "Show all N experiences" link that
  // navigates to this URL. By fetching it directly we get the full career
  // without leaving the current page. Uses the user's LinkedIn cookies
  // (same-origin fetch), so no extra auth needed.
  async function scrapeExperiencesFromDetailsPage(profileUrl) {
    if (!profileUrl) return [];
    // Normalize: strip query/hash/trailing slash, ensure /in/<slug> form.
    const base = profileUrl.split("?")[0].split("#")[0].replace(/\/+$/, "");
    if (!/\/in\/[^/]+$/i.test(base)) return [];
    const detailsUrl = `${base}/details/experience/`;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(detailsUrl, {
        credentials: "include",
        signal: ctrl.signal,
        headers: { "Accept": "text/html" },
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn("[Klosr] details-page fetch non-ok:", res.status);
        return [];
      }
      const html = await res.text();
      return parseExperienceDetailsHtml(html);
    } catch (e) {
      console.warn("[Klosr] details-page fetch failed:", e && e.message);
      return [];
    }
  }

  // Parse the HTML of LinkedIn's /details/experience/ page. The page
  // renders every role as an li.artdeco-list__item (or a newer pvs-list
  // variant) with the same title/company/duration/description structure
  // the main scraper knows. We route the parsed DOM through a tiny adapter
  // that mimics scrapeExperience's selectors, then dedupes on client side.
  function parseExperienceDetailsHtml(html) {
    if (!html) return [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(html, "text/html");
    } catch (e) {
      return [];
    }
    if (!doc) return [];

    // Collect every plausible experience-list item. LinkedIn's details page
    // is simpler DOM than the main profile — one section, every role as an
    // li.artdeco-list__item. We also grab pvs-list children as a fallback.
    const candidates = doc.querySelectorAll(
      "main li.artdeco-list__item, main ul.pvs-list > li, main section li"
    );
    if (candidates.length === 0) return [];

    // Reuse the dedupeAria helper logic inline (the shared helper lives in
    // scrapeExperience's closure — can't reach it from here, so reimplement).
    const dedupeAria = (s) => {
      if (!s) return "";
      const t = String(s).replace(/\s+/g, " ").trim();
      if (t.length < 2) return t;
      const mid = Math.floor(t.length / 2);
      if (t.length % 2 === 0 && t.slice(0, mid) === t.slice(mid)) return t.slice(0, mid);
      return t;
    };

    const items = [];
    const seen = new Set();
    // Cap at 20 so a 30-role career doesn't blow the prompt. The backend
    // caps at 12 anyway; having 20 here gives dedupe + merge room.
    const cap = Math.min(candidates.length, 20);

    for (let i = 0; i < cap; i++) {
      const item = candidates[i];

      // Skip nested sub-role entries (grouped under a single company) —
      // they're already counted by their parent li.
      if (item.parentElement && item.parentElement.closest(".pvs-entity__sub-components")) continue;

      const titleEl = item.querySelector(".t-bold span[aria-hidden='true']") ||
                      item.querySelector(".t-bold span") ||
                      item.querySelector("[class*='title'] span") ||
                      item.querySelector(".hoverable-link-text");
      const companyEl = item.querySelector(".t-14.t-normal span[aria-hidden='true']") ||
                        item.querySelector(".t-normal span");
      const durationEl = item.querySelector(".pvs-entity__caption-wrapper") ||
                         item.querySelector(".t-14.t-normal.t-black--light span[aria-hidden='true']") ||
                         item.querySelector(".t-black--light span");

      const title = dedupeAria(titleEl ? titleEl.textContent : "");
      const company = dedupeAria(companyEl ? companyEl.textContent : "");
      const duration = dedupeAria(durationEl ? durationEl.textContent : "");

      // Skip blank rows and section headers.
      if (!title && !company) continue;
      const key = (title + "|" + company).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let description = "";
      const descEl =
        item.querySelector(".pvs-entity__sub-components .inline-show-more-text span[aria-hidden='true']") ||
        item.querySelector(".pvs-entity__sub-components .inline-show-more-text") ||
        item.querySelector(".inline-show-more-text span[aria-hidden='true']") ||
        item.querySelector(".inline-show-more-text") ||
        item.querySelector("[class*='description']");
      if (descEl) {
        description = dedupeAria(descEl.textContent).slice(0, 1200);
      }

      let location = "";
      const capWraps = item.querySelectorAll(".pvs-entity__caption-wrapper");
      if (capWraps.length > 1) {
        location = dedupeAria(capWraps[1].textContent).slice(0, 120);
      }

      items.push({ title, company, duration, description, location });
    }

    if (items.length > 0) {
      console.log(`[Klosr] details-page scraper: parsed ${items.length} roles`);
    }
    return items;
  }

  function scrapeExperience() {
    const items = [];
    const selectorSets = [
      "#experience ~ div li.artdeco-list__item",
      "section[id*='experience'] li.artdeco-list__item",
      "section[data-section='experience'] li",
      "div[id*='experience'] ~ div ul > li",
      // Modern LinkedIn uses artdeco-list inside pvs-list
      "section:has(div#experience) li.artdeco-list__item",
      // Anchor-sibling pattern (anchor div, sibling section)
      "div#experience ~ section li.artdeco-list__item",
    ];

    let expItems = [];
    for (const sel of selectorSets) {
      try {
        expItems = document.querySelectorAll(sel);
        if (expItems.length > 0) break;
      } catch (e) {}
    }

    // Primary fallback: find the experience <section> via heading text,
    // then grab every list item under it. This catches every LinkedIn DOM
    // variant and every locale.
    if (expItems.length === 0) {
      const section = findExperienceSection();
      if (section) {
        const lis = section.querySelectorAll("li.artdeco-list__item, ul.pvs-list > li, ul > li");
        if (lis.length > 0) expItems = lis;
      }
    }

    if (expItems.length > 0) {
      console.log(`[Klosr] scrapeExperience: found ${expItems.length} items`);
    } else {
      console.warn("[Klosr] scrapeExperience: no experience items found on this page");
    }

    // Normalize a text node — strip LinkedIn's visually-hidden a11y duplication
    // (e.g. "FounderFounder" → "Founder", "Experience · Full-timeExperience · Full-time" → "Experience · Full-time").
    const dedupeAria = (s) => {
      if (!s) return "";
      const t = s.replace(/\s+/g, " ").trim();
      // If the string is exactly 2x some prefix, keep one.
      const mid = Math.floor(t.length / 2);
      if (t.length > 1 && t.length % 2 === 0 && t.slice(0, mid) === t.slice(mid)) {
        return t.slice(0, mid);
      }
      return t;
    };

    // Scope the iteration to a reasonable cap so we don't hit a 20-role CV
    // and blow the prompt budget, but higher than 6 so we catch full careers.
    const max = Math.min(expItems.length, 12);
    for (let i = 0; i < max; i++) {
      const item = expItems[i];

      const titleEl = item.querySelector(".t-bold span[aria-hidden='true']") ||
                      item.querySelector(".t-bold span") ||
                      item.querySelector("[class*='title'] span") ||
                      item.querySelector(".hoverable-link-text") ||
                      item.querySelector("div.display-flex.align-items-center span[aria-hidden='true']");
      const companyEl = item.querySelector(".t-14.t-normal span[aria-hidden='true']") ||
                        item.querySelector(".t-normal span") ||
                        item.querySelector("[class*='subtitle'] span");
      const durationEl = item.querySelector(".pvs-entity__caption-wrapper") ||
                         item.querySelector(".t-14.t-normal.t-black--light span[aria-hidden='true']") ||
                         item.querySelector(".t-black--light span");

      const title = dedupeAria(titleEl ? titleEl.textContent : "");
      const company = dedupeAria(companyEl ? companyEl.textContent : "");
      const duration = dedupeAria(durationEl ? durationEl.textContent : "");

      // Description — the bullets/paragraph LinkedIn puts under each role.
      // Try multiple selectors; modern LinkedIn nests descriptions in a
      // sub-components list with inline-show-more-text wrappers.
      let description = "";
      const descEl =
        item.querySelector(".pvs-entity__sub-components .inline-show-more-text span[aria-hidden='true']") ||
        item.querySelector(".pvs-entity__sub-components .inline-show-more-text") ||
        item.querySelector(".inline-show-more-text span[aria-hidden='true']") ||
        item.querySelector(".inline-show-more-text") ||
        item.querySelector(".pvs-list__item--no-padding-in-columns .t-14 span[aria-hidden='true']") ||
        item.querySelector("[class*='description']") ||
        item.querySelector(".pv-shared-text-with-see-more span[aria-hidden='true']");
      if (descEl) {
        description = dedupeAria(descEl.textContent).slice(0, 900);
      }

      // Location — LinkedIn places it as a second caption-wrapper line,
      // or sometimes in another t-black--light span after the duration.
      let location = "";
      const capWraps = item.querySelectorAll(".pvs-entity__caption-wrapper");
      if (capWraps.length > 1) {
        location = dedupeAria(capWraps[1].textContent).slice(0, 120);
      } else {
        const locEls = item.querySelectorAll(".t-14.t-normal.t-black--light span[aria-hidden='true']");
        if (locEls.length > 1) {
          location = dedupeAria(locEls[1].textContent).slice(0, 120);
        }
      }

      if (title || company) {
        items.push({ title, company, duration, description, location });
      }
    }

    // LAST-RESORT text parser: if we found the section but structured
    // extraction produced fewer than 2 items (selectors didn't match the
    // current DOM), parse the section's raw innerText with regex. Not
    // perfect but produces usable role/company/duration triples that beat
    // returning an empty array.
    if (items.length < 2) {
      const section = findExperienceSection();
      if (section) {
        const parsed = parseExperienceFromText(section.innerText || "");
        // Merge — dedupe by (title+company) lower-cased.
        const seen = new Set(items.map(e => (e.title + "|" + e.company).toLowerCase()));
        for (const e of parsed) {
          const k = (e.title + "|" + e.company).toLowerCase();
          if (!seen.has(k) && (e.title || e.company)) {
            seen.add(k);
            items.push(e);
          }
        }
        if (items.length > 0) {
          console.log(`[Klosr] scrapeExperience: text-fallback contributed ${items.length} total items`);
        }
      }
    }

    return items;
  }

  // Parse LinkedIn's Experience section from raw innerText when structured
  // DOM selectors fail. Handles the line pattern LinkedIn renders:
  //   <Title>
  //   <Company> · <Employment type>
  //   <Date range> · <Duration>
  //   <Location> · <Work mode>
  //   <Description paragraph>
  // Each role is separated by a title line (first non-blank line after a
  // blank section). Deterministic but forgiving — ignores section headings
  // and heading-duplicate a11y lines.
  function parseExperienceFromText(text) {
    if (!text) return [];
    const lines = text
      .split("\n")
      .map(l => l.replace(/\s+/g, " ").trim())
      .filter(l => l.length > 0);

    // Skip the section heading (first 1-2 lines) — match any experience-word.
    const EXP_HEADINGS = /^(experience|experiencia|erfahrung|berufserfahrung|expérience|esperienza|ervaring)/i;
    let start = 0;
    while (start < lines.length && start < 3) {
      if (EXP_HEADINGS.test(lines[start])) { start++; continue; }
      break;
    }

    // Date-line detector: LinkedIn always renders "Mon YYYY - Mon YYYY · X yrs Y mos"
    // or localised equivalents. Match month abbreviations OR generic "YYYY - YYYY · ..."
    const DATE_LINE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ene|feb|mar|abr|may|jun|jul|ago|sept|oct|nov|dic|gen|febbr|mar|apr|mag|giu|lug|ago|sett|ott|nov|dic)\.?\s+\d{4}\b/i;
    const DATE_GENERIC = /\b(19|20)\d{2}\b.*·.*\b(yr|yrs|month|mos|mes|mese|año|an|anni|jahr|mois|ans)\w*\b/i;

    const items = [];
    let i = start;
    const safeLines = lines.length;
    // Cap iterations — malformed text shouldn't loop forever.
    let guard = 0;
    while (i < safeLines && guard++ < 200 && items.length < 12) {
      // Scan forward until we hit a date line, then work backwards for title/company.
      let dateIdx = -1;
      for (let j = i; j < Math.min(i + 8, safeLines); j++) {
        if (DATE_LINE.test(lines[j]) || DATE_GENERIC.test(lines[j])) { dateIdx = j; break; }
      }
      if (dateIdx === -1) break;

      // Title is usually 2 lines above the date (title, company·type, date),
      // but sometimes title is just 1 line above (older profiles).
      const titleIdx = dateIdx >= 2 ? dateIdx - 2 : dateIdx - 1;
      const companyIdx = dateIdx - 1;
      if (titleIdx < start || companyIdx < start) break;

      const title = dedupeLineText(lines[titleIdx]);
      let companyRaw = dedupeLineText(lines[companyIdx]);
      // Strip trailing " · Full-time" / "· Jornada completa" etc.
      const company = companyRaw.split("·")[0].trim();
      const duration = dedupeLineText(lines[dateIdx]);

      // Location: usually next line, if it doesn't look like a description.
      let location = "";
      if (dateIdx + 1 < safeLines) {
        const nxt = lines[dateIdx + 1];
        if (nxt.length < 80 && /·/.test(nxt) && !/\./.test(nxt)) {
          location = dedupeLineText(nxt);
        }
      }

      // Description: everything after the date/location line until the
      // next date-line or section break. Combine to one paragraph, capped.
      const descStart = location ? dateIdx + 2 : dateIdx + 1;
      const descLines = [];
      let nextDateIdx = safeLines;
      for (let j = descStart; j < safeLines; j++) {
        if (DATE_LINE.test(lines[j]) || DATE_GENERIC.test(lines[j])) {
          nextDateIdx = j - (j - descStart >= 1 ? 2 : 1); // back up to next title
          break;
        }
        if (descLines.length >= 8) { nextDateIdx = j; break; }
        descLines.push(lines[j]);
      }
      const description = descLines.join(" ").replace(/\s+/g, " ").trim().slice(0, 900);

      if (title || company) {
        items.push({ title, company, duration, description, location });
      }
      i = nextDateIdx;
    }

    return items;
  }

  // Normalize a LinkedIn text line — strip duplicated a11y text.
  function dedupeLineText(s) {
    if (!s) return "";
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length < 2) return t;
    const mid = Math.floor(t.length / 2);
    if (t.length % 2 === 0 && t.slice(0, mid) === t.slice(mid)) return t.slice(0, mid);
    return t;
  }

  // Scrape recent activity / posts with multiple selector fallbacks
  function scrapeActivity() {
    const items = [];
    const selectorSets = [
      "[class*='activity'] .feed-shared-update-v2__description",
      "section[id*='activity'] .feed-shared-update-v2__description",
      "section[data-section='posts'] article",
      "section[id*='activity'] .update-components-text"
    ];

    let activityItems = [];
    for (const sel of selectorSets) {
      activityItems = document.querySelectorAll(sel);
      if (activityItems.length > 0) break;
    }

    activityItems.forEach((item, i) => {
      if (i >= 5) return;
      const text = item.textContent.trim().substring(0, 500);
      if (text.length > 20) items.push(text);
    });

    return items;
  }

  // Create sidebar
  function createSidebar() {
    if (document.getElementById("briefme-sidebar")) return;

    const sidebar = document.createElement("div");
    sidebar.id = "briefme-sidebar";
    sidebar.innerHTML = `
      <div class="briefme-header">
        <div class="briefme-logo">
          <div class="briefme-logo-mark">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0A0A0A" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 4v16"/>
              <path d="M6 12l7-8"/>
              <path d="M6 12l7 8"/>
            </svg>
          </div>
          <span class="briefme-logo-text">Klosr</span>
        </div>
        <div class="briefme-header-actions">
          <div class="briefme-gear" id="briefme-gear" title="${t("setup_gear_tooltip")}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </div>
          <div class="briefme-close" id="briefme-close">&times;</div>
        </div>
      </div>
      <div class="briefme-content" id="briefme-content">
        <div class="briefme-loading" id="briefme-loading">
          <div class="briefme-spinner"></div>
          <p>Searching the web...</p>
          <p class="briefme-loading-sub">Pulling real-time intel on this prospect</p>
        </div>
      </div>
      <div class="briefme-footer">
        <div class="briefme-mode-tabs">
          <button class="briefme-tab active" data-mode="sales">${currentLanguage === "es" ? "Sesión" : "Sales Call"}</button>
          <button class="briefme-tab" data-mode="pipeline">${currentLanguage === "es" ? "Pipeline" : "Pipeline"}</button>
        </div>
      </div>
    `;

    document.body.appendChild(sidebar);

    // Close button
    document.getElementById("briefme-close").addEventListener("click", closeSidebar);

    // Gear icon — opens company profile setup
    document.getElementById("briefme-gear").addEventListener("click", () => {
      showCompanySetup("picker");
    });

    // Tab switching
    sidebar.querySelectorAll(".briefme-tab").forEach(tab => {
      tab.addEventListener("click", (e) => {
        sidebar.querySelectorAll(".briefme-tab").forEach(t => t.classList.remove("active"));
        e.target.classList.add("active");
        const mode = e.target.dataset.mode;
        if (!currentProfile) return;

        // Pipeline tab: open the deal tracker — no profile required.
        if (mode === "pipeline") {
          showDealPipelineView();
          return;
        }

        if (!currentProfile) return;

        // Sales tab: re-use the last call-mode choice so the user isn't
        // re-prompted every time they switch between tabs on the same profile.
        if (mode === "sales") {
          analyzeProfile(currentProfile, "sales", { callMode: currentSalesCallMode });
          return;
        }

        analyzeProfile(currentProfile, mode);
      });
    });
  }

  function closeSidebar() {
    const sidebar = document.getElementById("briefme-sidebar");
    if (sidebar) {
      sidebar.classList.remove("briefme-open");
      sidebarOpen = false;
    }
  }

  function openSidebar() {
    const sidebar = document.getElementById("briefme-sidebar");
    if (sidebar) {
      sidebar.classList.add("briefme-open");
      sidebarOpen = true;
      // Telemetry: fire `sidebar_opened` ONCE per tab/session so admin panel
      // sees presence even for users who just browse profiles without
      // running a brief / dossier / etc. Dedupe via a module-local flag so
      // we don't spam the event log when the user opens/closes the sidebar
      // repeatedly on the same page.
      if (!_sidebarOpenedLogged) {
        _sidebarOpenedLogged = true;
        try {
          logKlosrEvent("sidebar_opened", {
            host: location.hostname || "",
            path: location.pathname ? location.pathname.slice(0, 80) : "",
          });
        } catch {/* silent */}
      }
    }
  }
  // Session-scoped dedupe flag — reset on tab close, which is exactly
  // what we want (one ping per browsing session, not per open/close).
  let _sidebarOpenedLogged = false;

  // Show loading state with juicy labor illusion
  let _briefLaborInterval = null;
  function showLoading() {
    const content = document.getElementById("briefme-content");
    content.innerHTML = `
      <div class="briefme-loading">
        <div class="briefme-spinner"></div>
        <p class="briefme-labor-msg" style="transition: opacity 0.2s">${getJuicyMessage()}</p>
        <p class="briefme-loading-sub">${t("searching_web_sub")}</p>
      </div>
    `;
    if (_briefLaborInterval) clearInterval(_briefLaborInterval);
    _briefLaborInterval = startLaborIllusion(content);
  }

  // Show scraping state — while LinkedIn sections lazy-load and we pull data
  function showScrapingState() {
    const content = document.getElementById("briefme-content");
    content.innerHTML = `
      <div class="briefme-loading">
        <div class="briefme-spinner"></div>
        <p>${t("reading_profile")}</p>
        <p class="briefme-loading-sub">${t("reading_profile_sub")}</p>
      </div>
    `;
  }

  // Graceful display name — falls back to URL handle if scraper fails.
  // Always re-runs cleanScrapedName as a belt-and-suspenders cleanup so
  // even stale profile data from before the cleaner was added gets fixed.
  function getDisplayName(profile) {
    let name = "";
    if (profile && profile.name && profile.name !== "Unknown" && profile.name.trim()) {
      name = profile.name.trim();
    }
    if (!name && profile && profile.profileUrl) {
      name = deriveNameFromUrl(profile.profileUrl);
    }
    if (!name) return "LinkedIn Profile";
    // Final scrub at display time — catches anything that slipped past the scraper
    return cleanScrapedName(name) || name;
  }

  // Mode picker — shown before the expensive search + generation
  function showModePicker() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");

    const content = document.getElementById("briefme-content");
    const displayName = getDisplayName(currentProfile);
    const initials = getInitials(displayName);
    const safeName = escapeHtml(displayName);
    const photoUrl = currentProfile && currentProfile.photoUrl ? currentProfile.photoUrl : "";

    const headlineHtml = currentProfile.headline
      ? `<div class="briefme-profile-headline">${escapeHtml(currentProfile.headline)}</div>`
      : "";
    const locationHtml = currentProfile.location
      ? `<div class="briefme-profile-location">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
             <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
             <circle cx="12" cy="10" r="3"></circle>
           </svg>
           ${escapeHtml(currentProfile.location)}
         </div>`
      : "";

    // Avatar: initials are always rendered as the base layer; the <img> overlays
    // them when it loads successfully. If the image fails or is missing,
    // initials show through.
    const avatarHtml = `
      <div class="briefme-avatar">
        <span class="briefme-avatar-initials">${initials}</span>
        ${photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="${safeName}" referrerpolicy="no-referrer" onerror="this.style.display='none'" />` : ""}
      </div>
    `;

    content.innerHTML = `
      <div class="briefme-picker">
        <div class="briefme-lang-toggle">
          <button class="briefme-lang-btn ${currentLanguage === "en" ? "active" : ""}" data-lang="en">English</button>
          <button class="briefme-lang-btn ${currentLanguage === "es" ? "active" : ""}" data-lang="es">Español</button>
        </div>

        <div class="briefme-profile-card">
          ${avatarHtml}
          <div class="briefme-profile-info">
            <div class="briefme-profile-name">${safeName}</div>
            ${headlineHtml}
            ${locationHtml}
            <div id="briefme-picker-email" class="briefme-picker-email briefme-picker-email-inline">
              <div class="briefme-picker-email-row briefme-picker-email-pending">
                <div class="briefme-leadmagic-spinner"></div>
                <span>${currentLanguage === "es" ? "Buscando email..." : "Checking for email..."}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="briefme-quick-section">
          <form class="briefme-quick-form" id="briefme-quick-form">
            <input
              type="text"
              class="briefme-quick-input"
              id="briefme-quick-input"
              placeholder="${t("quick_placeholder")} ${safeName}..."
              autocomplete="off"
            />
            <button type="submit" class="briefme-quick-send" aria-label="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </form>

          <div class="briefme-workflow-label">${t("quick_section_prep")}</div>
          <div class="briefme-quick-chips">
            <button class="briefme-quick-chip" data-quick="questions">${t("quick_questions")}</button>
            <button class="briefme-quick-chip" data-quick="opener">${t("quick_opener")}</button>
            <button class="briefme-quick-chip" data-quick="talking">${t("quick_talking")}</button>
            <button class="briefme-quick-chip briefme-chip-score" data-quick="icp_fit">${t("quick_icp_fit")}</button>
            <button class="briefme-quick-chip briefme-chip-score" data-quick="objections">${t("quick_objections")}</button>
            <button class="briefme-quick-chip briefme-chip-score briefme-chip-research" data-quick="deep_research">🔬 ${currentLanguage === "es" ? "Intel empresa" : "Company intel"}</button>
            <button class="briefme-quick-chip briefme-chip-score briefme-chip-dossier" data-quick="full_dossier">🧠 ${currentLanguage === "es" ? "Conócele a fondo" : "Know them cold"}</button>
            <button class="briefme-quick-chip briefme-chip-score briefme-chip-vision" data-quick="vision">📸 ${currentLanguage === "es" ? "Pega captura" : "Paste screenshot"}</button>
            <button class="briefme-quick-chip briefme-chip-score briefme-chip-desktop" data-quick="klosr_desktop">🖥️ ${currentLanguage === "es" ? "Klosr Desktop (Watch)" : "Klosr Desktop (Watch)"}</button>
          </div>

          <div class="briefme-workflow-label">${t("quick_section_outreach")}</div>
          <div class="briefme-quick-chips">
            <button class="briefme-quick-chip briefme-chip-outreach briefme-chip-warm" data-quick="warm_leads">🔥 ${currentLanguage === "es" ? "Leads calientes" : "Warm leads"}</button>
            <button class="briefme-quick-chip briefme-chip-outreach" data-quick="why_now">${t("quick_why_now")}</button>
            <button class="briefme-quick-chip briefme-chip-outreach" data-quick="email">${t("quick_email")}</button>
            <button class="briefme-quick-chip briefme-chip-outreach" data-quick="sequence">${currentLanguage === "es" ? "Secuencia 4 toques" : "4-touch sequence"}</button>
            <button class="briefme-quick-chip briefme-chip-outreach" data-quick="connection">${t("quick_connection")}</button>
            <button class="briefme-quick-chip briefme-chip-outreach" data-quick="dm">${t("quick_dm")}</button>
          </div>

          <div class="briefme-workflow-label">${t("quick_section_after")}</div>
          <div class="briefme-quick-chips">
            <button class="briefme-quick-chip briefme-chip-after" data-quick="followup">${t("quick_followup")}</button>
            <button class="briefme-quick-chip briefme-chip-after" data-quick="handle_reply">${currentLanguage === "es" ? "Responder a mensaje" : "Handle a reply"}</button>
          </div>
        </div>

        <div class="briefme-quick-divider">
          <span>${t("quick_divider")}</span>
        </div>

        <div class="briefme-picker-options">
          <button class="briefme-picker-option" data-mode="sales">
            <div class="briefme-picker-option-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFD60A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="1" x2="12" y2="23"></line>
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
              </svg>
            </div>
            <div class="briefme-picker-option-text">
              <div class="briefme-picker-option-title">${t("sales_title")}</div>
              <div class="briefme-picker-option-desc">${t("sales_desc")}</div>
            </div>
            <div class="briefme-picker-option-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
          </button>

          <button class="briefme-picker-option briefme-picker-dailyclose" data-mode="dailyclose">
            <div class="briefme-picker-option-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFD60A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polyline>
              </svg>
            </div>
            <div class="briefme-picker-option-text">
              <div class="briefme-picker-option-title">⚡ ${currentLanguage === "es" ? "Cierra hoy" : "Close today"}</div>
              <div class="briefme-picker-option-desc">${currentLanguage === "es" ? "Tus acciones de hoy, ordenadas por $. Un clic por tarea." : "Today's actions, ranked by $. One click per task."}</div>
            </div>
            <div class="briefme-picker-option-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
          </button>

          <button class="briefme-picker-option briefme-picker-pipeline" data-mode="pipeline">
            <div class="briefme-picker-option-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFD60A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="12" x2="14" y2="12"></line>
                <line x1="3" y1="18" x2="9" y2="18"></line>
              </svg>
            </div>
            <div class="briefme-picker-option-text">
              <div class="briefme-picker-option-title">${currentLanguage === "es" ? "Pipeline" : "Pipeline"}</div>
              <div class="briefme-picker-option-desc">${currentLanguage === "es" ? "Todos tus deals — compromisos, etapas, seguimiento." : "All your deals — commitments, stages, follow-ups."}</div>
            </div>
            <div class="briefme-picker-option-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
          </button>
        </div>

        <div class="briefme-recents-section" id="briefme-recents"></div>
      </div>
    `;

    // Load and render recent prospects
    loadProspectHistory().then(async (history) => {
      const recentsEl = document.getElementById("briefme-recents");
      if (!recentsEl) return;
      // Filter out the current profile
      const currentUrl = currentProfile && currentProfile.profileUrl ? currentProfile.profileUrl : "";
      const others = history.filter(p => p.profileUrl !== currentUrl).slice(0, 5);
      if (others.length === 0) return;

      // Load time-saved stats for the dashboard
      const timeSavedData = await loadTimeSaved();
      const weeklyTimeSaved = timeSavedData.thisWeek || 0;
      const totalTimeSaved = timeSavedData.total || 0;

      // Calculate pipeline stats
      const allProspects = history;
      const totalPrepped = allProspects.length;
      const totalContacted = allProspects.filter(p => ["contacted","replied","call","closing","won"].includes(p.stage)).length;
      const totalReplied = allProspects.filter(p => ["replied","call","closing","won"].includes(p.stage)).length;
      const totalCalls = allProspects.filter(p => ["call","closing","won"].includes(p.stage)).length;
      const totalClosing = allProspects.filter(p => ["closing","won"].includes(p.stage)).length;
      const totalWon = allProspects.filter(p => p.stage === "won").length;
      const replyRate = totalContacted > 0 ? Math.round((totalReplied / totalContacted) * 100) : 0;

      // Pipeline mini-dashboard (only show if they have >0 prospects)
      const statsHtml = totalPrepped > 0 ? `
        <div class="briefme-pipeline-stats">
          <div class="briefme-stat">
            <div class="briefme-stat-num">${totalPrepped}</div>
            <div class="briefme-stat-label">${t("stats_prospects")}</div>
          </div>
          <div class="briefme-stat-arrow">→</div>
          <div class="briefme-stat">
            <div class="briefme-stat-num" style="color:#FFD60A">${totalContacted}</div>
            <div class="briefme-stat-label">${t("stats_contacted")}</div>
          </div>
          <div class="briefme-stat-arrow">→</div>
          <div class="briefme-stat">
            <div class="briefme-stat-num" style="color:#4ADE80">${totalReplied}</div>
            <div class="briefme-stat-label">${t("stats_replied")}</div>
          </div>
          <div class="briefme-stat-arrow">→</div>
          <div class="briefme-stat">
            <div class="briefme-stat-num" style="color:#60A5FA">${totalCalls}</div>
            <div class="briefme-stat-label">${t("stats_calls")}</div>
          </div>
          <div class="briefme-stat-arrow">→</div>
          <div class="briefme-stat">
            <div class="briefme-stat-num" style="color:#22C55E">${totalWon}</div>
            <div class="briefme-stat-label">${t("stats_won")}</div>
          </div>
        </div>
        ${totalContacted > 0 ? `<div class="briefme-reply-rate">${t("stats_rate")}: <strong>${replyRate}%</strong></div>` : ""}
        ${weeklyTimeSaved > 0 ? `<div class="briefme-time-saved">⏱ ${isEs ? "Ahorraste" : "Saved"} <strong>${formatTimeSaved(weeklyTimeSaved)}</strong> ${isEs ? "esta semana" : "this week"}</div>` : ""}
      ` : "";

      recentsEl.innerHTML = `
        ${statsHtml}
        <div class="briefme-workflow-label" style="margin-top:16px">${t("recents_title")}</div>
        ${others.map(p => {
          const pName = escapeHtml(cleanScrapedName(p.name) || p.name);
          const pInitials = getInitials(pName);
          const pHeadline = p.headline ? escapeHtml(p.headline) : "";
          const stage = p.stage || "prepped";
          const stageColor = STAGE_COLORS[stage] || "#6B7280";
          const stageLabel = getStageLabel(stage);
          return `
            <a class="briefme-recent-row" href="${escapeHtml(p.profileUrl)}" target="_blank" rel="noopener noreferrer">
              <div class="briefme-avatar briefme-avatar-xs">
                <span class="briefme-avatar-initials">${pInitials}</span>
                ${p.photoUrl ? `<img src="${escapeHtml(p.photoUrl)}" alt="${pName}" referrerpolicy="no-referrer" onerror="this.style.display='none'" />` : ""}
              </div>
              <div class="briefme-recent-info">
                <div class="briefme-recent-name">${pName}</div>
                ${pHeadline ? `<div class="briefme-recent-headline">${pHeadline}</div>` : ""}
              </div>
              <div class="briefme-stage-pill" style="background:${stageColor}20;color:${stageColor};border-color:${stageColor}40">${stageLabel}</div>
            </a>
          `;
        }).join("")}
      `;
    });

    // Language toggle — switches language and re-renders the picker in-place
    document.querySelectorAll(".briefme-lang-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const lang = e.currentTarget.dataset.lang;
        if (lang === currentLanguage) return;
        currentLanguage = lang;
        showModePicker(); // Re-render with new language
      });
    });

    // Quick-action form — free text input
    document.getElementById("briefme-quick-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("briefme-quick-input");
      const question = input.value.trim();
      if (!question) return;
      sendQuickMessage(question);
    });

    // Quick-action chip prompts (keyed by data-quick attribute)
    const isEs = currentLanguage === "es";
    const quickPrompts = {
      questions: isEs
        ? `Dame 3 preguntas cortas, afiladas y específicas que puedo hacerle a ${safeName} en una conversación. Referencia cosas concretas de su perfil. Cada pregunta en 1-2 líneas max.`
        : `Give me 3 sharp, specific questions I can ask ${safeName} in a conversation. Reference specific things from their profile. Keep each question to 1-2 lines.`,
      opener: isEs
        ? `Dame UNA gran línea de apertura para contactar a ${safeName}. Debe referenciar algo específico de su perfil o actividad reciente. Ponla entre comillas.`
        : `Give me one great opening line for reaching out to ${safeName}. It should reference something specific from their profile or recent activity. Put it in quotes.`,
      talking: isEs
        ? `Dame 4-5 puntos de conversación concisos para una reunión con ${safeName}. Cada uno en 1 línea max, referenciando cosas específicas de su perfil.`
        : `Give me 4-5 concise talking points for a conversation with ${safeName}. Each should be 1 line max, referencing specific things from their profile.`,
      connection: isEs
        ? `Escribe una nota de solicitud de conexión de LinkedIn para ${safeName}. MÁXIMO 300 caracteres. Hazla personal: referencia algo específico de su perfil. Nada de genérico "Me encantaría conectar". El objetivo es que acepte. NADA de rayas (—) ni guiones medios (–), usa comas o puntos. Devuelve SOLO el texto del mensaje, nada más.`
        : `Write a LinkedIn connection request note to ${safeName}. MAXIMUM 300 characters. Make it personal: reference something specific from their profile. No generic "I'd love to connect" garbage. The goal is to get them to accept. NO em-dashes (—) or en-dashes (–), use commas or periods. Output ONLY the message text, nothing else.`,
      dm: isEs
        ? `Escribe un mensaje directo corto de LinkedIn para ${safeName}. 3-4 frases max. Referencia algo específico de su perfil o actividad reciente. El objetivo es iniciar una conversación que lleve a una llamada. Sé humano, no vendedor. NADA de rayas (—) ni guiones medios (–), usa comas o puntos. Devuelve SOLO el texto del mensaje.`
        : `Write a short LinkedIn direct message to ${safeName}. 3-4 sentences max. Reference something specific from their profile or recent activity. The goal is to start a conversation that leads to a call. Be human, not salesy. NO em-dashes (—) or en-dashes (–), use commas or periods. Output ONLY the message text, nothing else.`,
      icp_fit: isEs
        ? `Evalúa qué tan bien ${safeName} encaja como prospecto para mi producto/empresa. Mi cliente ideal (ICP) es: ${(companyProfile && companyProfile.icp) || "(no definido)"}. Mi producto: ${(companyProfile && companyProfile.whatYouSell) || "(no definido)"}.\n\nFormato de respuesta:\n**X/10** — [resumen en una línea de por qué encaja o no]\n\nDespués da exactamente 3 bullets:\n- ✅ o ❌ [razón 1]\n- ✅ o ❌ [razón 2]\n- ✅ o ❌ [razón 3]\n\nSi es 7+, añade una línea: "**Mejor ángulo:** [cómo pitchearle específicamente]"\nSi es 4 o menos, añade: "**Mejor no:** [por qué no vale la pena el tiempo]"`
        : `Rate how well ${safeName} fits as a prospect for my product/company. My ideal customer (ICP) is: ${(companyProfile && companyProfile.icp) || "(not defined)"}. My product: ${(companyProfile && companyProfile.whatYouSell) || "(not defined)"}.\n\nResponse format:\n**X/10** — [one-line summary of why they fit or don't]\n\nThen give exactly 3 bullets:\n- ✅ or ❌ [reason 1]\n- ✅ or ❌ [reason 2]\n- ✅ or ❌ [reason 3]\n\nIf 7+, add a line: "**Best angle:** [how to pitch them specifically]"\nIf 4 or below, add: "**Skip:** [why they're not worth the time]"`,
      objections: isEs
        ? `Estoy a punto de pitchear mi producto a ${safeName}. Mi producto: ${(companyProfile && companyProfile.whatYouSell) || "(no definido)"}. Objeciones comunes que escucho: ${(companyProfile && companyProfile.objections) || "(no definidas)"}.\n\nBasado en su rol, empresa, industria y perfil, ¿cuáles son las 3 objeciones más probables que va a plantear? Para cada una:\n\n**"[objeción en sus palabras]"**\n↳ [rebuttal de 1-2 líneas que puedo usar]\n\nSé específico a ESTA persona, no genérico.`
        : `I'm about to pitch my product to ${safeName}. My product: ${(companyProfile && companyProfile.whatYouSell) || "(not defined)"}. Common objections I hear: ${(companyProfile && companyProfile.objections) || "(not defined)"}.\n\nBased on their role, company, industry, and profile, what are the 3 most likely objections they'll raise? For each:\n\n**"[objection in their words]"**\n↳ [1-2 line rebuttal I can use]\n\nBe specific to THIS person, not generic.`,
      why_now: isEs
        ? `Encuentra UNA razón específica para contactar a ${safeName} AHORA MISMO — no el mes que viene, AHORA. Busca: cambio de trabajo reciente, financiación de su empresa, lanzamiento de producto, están contratando, un post de LinkedIn sobre un problema relevante, cambio en su industria, evento reciente.\n\nFormato: "**Contacta ahora porque:** [razón específica con fecha/fuente si es posible]"\n\nSi genuinamente no hay un trigger urgente, di: "**Sin trigger urgente** — pero puedes abrir con: [ángulo alternativo basado en su rol]"`
        : `Find ONE specific reason to reach out to ${safeName} RIGHT NOW — not next month, NOW. Look for: recent job change, company funding, product launch, they're hiring, a LinkedIn post about a relevant pain point, industry shift, recent event.\n\nFormat: "**Reach out now because:** [specific reason with date/source if possible]"\n\nIf there's genuinely no urgent trigger, say: "**No urgent trigger** — but you can open with: [alternative angle based on their role]"`,
    };

    document.querySelectorAll(".briefme-quick-chip").forEach(chip => {
      chip.addEventListener("click", (e) => {
        const action = e.currentTarget.dataset.quick;

        // Standard quick prompts (no special routing needed)
        if (["icp_fit", "objections", "why_now"].includes(action)) {
          const prompt = quickPrompts[action];
          if (!prompt) return;
          // "Objections" chip always logs the reply into the playbook so
          // the playbook grows from real usage, not a one-time form field.
          const opts = action === "objections"
            ? { objectionTrigger: `Prospect: ${safeName} — likely objections` }
            : undefined;
          sendQuickMessage(prompt, opts);
          return;
        }

        // Route to specialized handlers + auto-advance deal stage
        if (action === "email") {
          if (currentProfile) saveProspectToHistory(currentProfile, "contacted");
          handleEmailClick();
          return;
        }
        if (action === "sequence") {
          if (currentProfile) saveProspectToHistory(currentProfile, "contacted");
          handleSequenceClick();
          return;
        }
        if (action === "handle_reply") {
          showHandleReplyForm();
          return;
        }
        if (action === "warm_leads") {
          showWarmLeadsView();
          return;
        }
        if (action === "deep_research") {
          showDeepResearchView();
          return;
        }
        if (action === "full_dossier") {
          showFullDossierView();
          return;
        }
        if (action === "vision") {
          showVisionView();
          return;
        }
        if (action === "klosr_desktop") {
          showKlosrDesktopInfo();
          return;
        }
        if (action === "followup") {
          if (currentProfile) saveProspectToHistory(currentProfile, "call");
          showFollowUpForm();
          return;
        }

        // Connection notes get the character-count result view
        if (action === "connection") {
          sendQuickMessage(quickPrompts.connection, { charLimit: 300 });
          return;
        }

        const prompt = quickPrompts[action];
        if (prompt) sendQuickMessage(prompt);
      });
    });

    document.querySelectorAll(".briefme-picker-option").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const mode = e.currentTarget.dataset.mode;
        // Sync the footer tab state for later mode-switching
        document.querySelectorAll(".briefme-tab").forEach(tab => tab.classList.remove("active"));
        const matchingTab = document.querySelector(`.briefme-tab[data-mode="${mode}"]`);
        if (matchingTab) matchingTab.classList.add("active");

        // Daily Close mode: the "what do I do today to close deals"
        // dashboard. Highest-priority actions pre-ranked so the founder
        // doesn't waste a minute deciding what's next.
        if (mode === "dailyclose") {
          showDailyCloseView();
          return;
        }

        // Pipeline mode: open the deal tracker instead of generating a brief.
        // This is the deal-closing heart of Klosr — every prospect you've
        // prepped lives here with stage, commitments, and follow-up timing.
        if (mode === "pipeline") {
          showDealPipelineView();
          return;
        }

        // Sales mode: pick call stage (Cold / Follow-up / Pre-call) first so
        // the brief is adapted to the conversation, not generic cold outreach.
        if (mode === "sales") {
          currentInterviewContext = null;
          showSalesCallModePicker();
          return;
        }

        // Fallback: straight to the brief
        currentInterviewContext = null;
        sidebar.classList.remove("briefme-picker-view");
        analyzeProfile(currentProfile, mode);
      });
    });

    // Trigger the Apollo lookup FIRST (sets state to "searching" when
    // appropriate), then render so the spinner / found email / placeholder
    // is visible from the first paint instead of flashing empty.
    maybeLookupPickerEmail();
    renderPickerEmail();
  }

  // Render the email row inside the picker profile card. Reflects whatever
  // currentProfile holds: scraped email, pending Apollo lookup, found, or
  // not-found. If nothing yet, renders empty (invisible).
  function renderPickerEmail() {
    const el = document.getElementById("briefme-picker-email");
    if (!el || !currentProfile) return;

    const isEs = currentLanguage === "es";
    const emails = Array.isArray(currentProfile.extractedEmails) ? currentProfile.extractedEmails : [];
    const state = currentProfile.leadmagicState || "idle";

    console.log("[Klosr] renderPickerEmail", {
      emails: emails.length,
      state,
      checked: !!currentProfile.leadmagicChecked,
      url: currentProfile.profileUrl,
    });

    if (emails.length > 0) {
      const primary = emails[0];
      const badge = emails.length > 1
        ? `<span class="briefme-picker-email-more">+${emails.length - 1}</span>`
        : "";
      el.innerHTML = `
        <div class="briefme-picker-email-row briefme-picker-email-found">
          <svg class="briefme-picker-email-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
            <polyline points="22,6 12,13 2,6"></polyline>
          </svg>
          <span class="briefme-picker-email-addr">${escapeHtml(primary)}</span>
          ${badge}
          <button class="briefme-picker-email-copy" data-addr="${escapeHtml(primary)}">
            ${isEs ? "Copiar" : "Copy"}
          </button>
        </div>
      `;
      const copyBtn = el.querySelector(".briefme-picker-email-copy");
      if (copyBtn) {
        copyBtn.addEventListener("click", (e) => {
          const addr = e.currentTarget.dataset.addr;
          navigator.clipboard.writeText(addr).then(() => {
            const original = e.currentTarget.textContent;
            e.currentTarget.textContent = isEs ? "Copiado" : "Copied";
            setTimeout(() => { e.currentTarget.textContent = original; }, 1600);
          });
        });
      }
      return;
    }

    if (state === "searching") {
      el.innerHTML = `
        <div class="briefme-picker-email-row briefme-picker-email-pending">
          <div class="briefme-leadmagic-spinner"></div>
          <span>${isEs ? "Buscando email verificado..." : "Searching for verified email..."}</span>
        </div>
      `;
      return;
    }

    // Any terminal, non-found state shows a muted row with a "Find in profile"
    // fallback. Includes the newer Apollo-specific states (plan_required,
    // config_error, credits_out) so the picker never gets stuck on the
    // spinner after the backend responds with a 4xx.
    const terminalStates = ["notfound", "error", "plan_required", "config_error", "credits_out"];
    if (terminalStates.includes(state)) {
      let msg;
      if (state === "plan_required") msg = isEs ? "Apollo: plan de pago necesario" : "Apollo: paid plan required";
      else if (state === "config_error") msg = isEs ? "Clave de Apollo no configurada" : "Apollo key not set";
      else if (state === "credits_out") msg = isEs ? "Sin créditos de Apollo" : "Out of Apollo credits";
      else if (state === "error") msg = isEs ? "Búsqueda falló" : "Lookup failed";
      else                         msg = isEs ? "Sin email verificado" : "No verified email";
      const findLabel = isEs ? "Buscar en perfil" : "Find in profile";
      el.innerHTML = `
        <div class="briefme-picker-email-row briefme-picker-email-muted">
          <span class="briefme-picker-email-addr" style="color: rgba(244,244,245,0.54)">${msg}</span>
          <button class="briefme-picker-email-find" id="briefme-picker-email-find">${findLabel}</button>
        </div>
      `;
      const findBtn = document.getElementById("briefme-picker-email-find");
      if (findBtn) {
        findBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          // Visual feedback — swap to spinner while we hit LinkedIn's overlay.
          currentProfile.leadmagicState = "searching";
          renderPickerEmail();
          try {
            const emails = await scrapeContactInfoViaModal();
            const usable = (emails || []).filter(isUsableEmail);
            if (usable.length > 0) {
              const existing = Array.isArray(currentProfile.extractedEmails) ? currentProfile.extractedEmails : [];
              currentProfile.extractedEmails = Array.from(new Set([...existing, ...usable])).filter(Boolean);
              currentProfile.leadmagicState = "found";
            } else {
              currentProfile.leadmagicState = "notfound";
            }
          } catch (err) {
            console.warn("Klosr manual find-email failed:", err);
            currentProfile.leadmagicState = "notfound";
          }
          renderPickerEmail();
        });
      }
      return;
    }

    // Idle fallback. Instead of hiding, surface a "checking" placeholder so
    // the row is always visible and the user (and dev console) knows Klosr is
    // evaluating. If the lookup never fires, this placeholder stays, which
    // is the correct signal that something's wrong.
    el.innerHTML = `
      <div class="briefme-picker-email-row briefme-picker-email-pending">
        <div class="briefme-leadmagic-spinner"></div>
        <span>${isEs ? "Buscando email..." : "Checking for email..."}</span>
      </div>
    `;
  }

  // Fire Apollo lookup once per session per profile. Skips if we already
  // have scraped emails or have already attempted the lookup for this profile.
  // Always leaves currentProfile.leadmagicState in a renderable state so the
  // picker email row never stays invisible.
  function maybeLookupPickerEmail() {
    if (!currentProfile) return;
    const hasScraped = Array.isArray(currentProfile.extractedEmails) && currentProfile.extractedEmails.length > 0;
    if (hasScraped) return;
    if (currentProfile.leadmagicChecked) return;
    currentProfile.leadmagicChecked = true;
    if (!currentProfile.profileUrl) {
      currentProfile.leadmagicState = "notfound";
      return;
    }
    currentProfile.leadmagicState = "searching";
    fetchProxycurlEmails(currentProfile.profileUrl);

    // Fire the free NinjaPear logo fetch alongside the email lookup —
    // non-blocking, populates currentProfile.companyLogoDataUrl which the
    // research view + (future) sidebar header read from.
    const domain = (currentProfile.companyDomain || currentProfile.currentCompanyWebsite || "")
      .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (domain) loadCompanyLogoInBackground(domain);
  }

  // Interview questionnaire — runs before the expensive brief generation so the
  // model can tailor Likely Topics, How to Impress, Power Line, etc. to THIS
  // candidate's actual role + background.
  // Klosr v4 is deal-closer-focused. Interview + pitch modes were removed
  // from the product — they served different buyers (candidates, founders
  // pitching investors) and diluted the sales-closing narrative. The code
  // below is kept as stubs so any legacy callers don't crash; they just
  // route straight to the pipeline view.
  async function showInterviewQuestionnaire() { return showDealPipelineView(); }
  async function showPitchAudienceForm() { return showDealPipelineView(); }
  /* ───── dead code removed in v4.2 — the full forms ─────
  async function _showInterviewQuestionnaire_REMOVED() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");

    const content = document.getElementById("briefme-content");
    const displayName = getDisplayName(currentProfile);

    // Prefill from persisted context + session override.
    const saved = (await getInterviewContext()) || {};
    const prev = currentInterviewContext || saved || {
      role: "", background: "", focus: "",
      cvText: "", cvFileName: "", roleUrl: "", companyUrl: "", githubUrl: "", portfolioUrl: "",
    };

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${t("quest_title")}</div>
          <div class="briefme-quest-subtitle">${t("quest_subtitle")} <strong>${displayName}</strong></div>
        </div>
        <form class="briefme-quest-form" id="briefme-quest-form">
          <div class="briefme-quest-section-label">Must-haves</div>

          <label class="briefme-quest-label" for="briefme-quest-role">${t("quest_role_label")}</label>
          <input
            type="text"
            id="briefme-quest-role"
            class="briefme-quest-input"
            placeholder="${t("quest_role_placeholder")}"
            value="${escapeHtml(prev.role || "")}"
            autocomplete="off"
            required
          />

          <label class="briefme-quest-label" for="briefme-quest-role-url">Job posting URL</label>
          <input
            type="url"
            id="briefme-quest-role-url"
            class="briefme-quest-input"
            placeholder="https://company.com/careers/the-role"
            value="${escapeHtml(prev.roleUrl || "")}"
            autocomplete="off"
          />

          <label class="briefme-quest-label" for="briefme-quest-cv">Your CV</label>
          <div class="briefme-quest-cv-row">
            <input type="file" id="briefme-quest-cv" class="briefme-quest-cv-input" accept=".pdf,.txt,.md" />
            <label for="briefme-quest-cv" class="briefme-quest-cv-label" id="briefme-quest-cv-label">
              ${prev.cvFileName ? `Replace: ${escapeHtml(prev.cvFileName)}` : "Upload PDF or TXT"}
            </label>
            ${prev.cvText ? `<button type="button" class="briefme-quest-cv-clear" id="briefme-quest-cv-clear">Clear</button>` : ""}
          </div>
          <div class="briefme-quest-hint" id="briefme-quest-cv-hint">${prev.cvText ? `CV text on file (${prev.cvText.length.toLocaleString()} chars).` : "Klosr extracts plain text client-side. Image-only PDFs won't parse."}</div>

          <label class="briefme-quest-label" for="briefme-quest-background">${t("quest_background_label")}</label>
          <textarea
            id="briefme-quest-background"
            class="briefme-quest-textarea"
            placeholder="${t("quest_background_placeholder")}"
            rows="3"
          >${escapeHtml(prev.background || "")}</textarea>

          <div class="briefme-quest-section-label">Optional</div>

          <label class="briefme-quest-label" for="briefme-quest-company-url">Company careers / about page</label>
          <input
            type="url"
            id="briefme-quest-company-url"
            class="briefme-quest-input"
            placeholder="https://company.com/about"
            value="${escapeHtml(prev.companyUrl || "")}"
            autocomplete="off"
          />

          <label class="briefme-quest-label" for="briefme-quest-github">GitHub (engineers)</label>
          <input
            type="url"
            id="briefme-quest-github"
            class="briefme-quest-input"
            placeholder="https://github.com/you"
            value="${escapeHtml(prev.githubUrl || "")}"
            autocomplete="off"
          />

          <label class="briefme-quest-label" for="briefme-quest-portfolio">Portfolio (creatives)</label>
          <input
            type="url"
            id="briefme-quest-portfolio"
            class="briefme-quest-input"
            placeholder="https://your.site"
            value="${escapeHtml(prev.portfolioUrl || "")}"
            autocomplete="off"
          />

          <label class="briefme-quest-label" for="briefme-quest-focus">${t("quest_focus_label")}</label>
          <textarea
            id="briefme-quest-focus"
            class="briefme-quest-textarea"
            placeholder="${t("quest_focus_placeholder")}"
            rows="2"
          >${escapeHtml(prev.focus || "")}</textarea>

          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-quest-back">${t("quest_back")}</button>
            <button type="submit" class="briefme-quest-submit">${t("quest_submit")}</button>
          </div>
        </form>
      </div>
    `;

    let pendingCvText = prev.cvText || "";
    let pendingCvFileName = prev.cvFileName || "";

    const cvInput = document.getElementById("briefme-quest-cv");
    const cvLbl = document.getElementById("briefme-quest-cv-label");
    const cvHint = document.getElementById("briefme-quest-cv-hint");
    cvInput?.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      cvLbl.textContent = `Reading: ${file.name}…`;
      const text = await extractCvText(file);
      if (!text) {
        pendingCvText = "";
        pendingCvFileName = "";
        cvHint.textContent = `Could not read ${file.name}. Try a text-based PDF or paste into Background below.`;
        cvLbl.textContent = "Upload PDF or TXT";
        return;
      }
      pendingCvText = text;
      pendingCvFileName = file.name;
      cvLbl.textContent = `Replace: ${file.name}`;
      cvHint.textContent = `Parsed ${text.length.toLocaleString()} chars. Ready.`;
    });

    const cvClear = document.getElementById("briefme-quest-cv-clear");
    cvClear?.addEventListener("click", () => {
      pendingCvText = "";
      pendingCvFileName = "";
      if (cvInput) cvInput.value = "";
      if (cvLbl) cvLbl.textContent = "Upload PDF or TXT";
      if (cvHint) cvHint.textContent = "Klosr extracts plain text client-side. Image-only PDFs won't parse.";
      cvClear.remove();
    });

    document.getElementById("briefme-quest-back").addEventListener("click", () => {
      showModePicker();
    });

    document.getElementById("briefme-quest-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const role = document.getElementById("briefme-quest-role").value.trim();
      const background = document.getElementById("briefme-quest-background").value.trim();
      const focus = document.getElementById("briefme-quest-focus").value.trim();
      const roleUrl = document.getElementById("briefme-quest-role-url").value.trim();
      const companyUrl = document.getElementById("briefme-quest-company-url").value.trim();
      const githubUrl = document.getElementById("briefme-quest-github").value.trim();
      const portfolioUrl = document.getElementById("briefme-quest-portfolio").value.trim();

      const ctx = {
        role, background, focus,
        cvText: pendingCvText,
        cvFileName: pendingCvFileName,
        roleUrl, companyUrl, githubUrl, portfolioUrl,
      };

      currentInterviewContext = ctx;
      await saveInterviewContext(ctx);

      sidebar.classList.remove("briefme-picker-view");
      analyzeProfile(currentProfile, "interview");
    });
  }

  // Pitch audience form — two-field setup that tunes the whole pitch to who
  // it's landing in front of: profile/reference URL + why this audience.
  async function showPitchAudienceForm() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const displayName = getDisplayName(currentProfile);

    const saved = (await getPitchContext()) || { audienceUrl: "", audienceWhy: "" };

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">Who are you pitching to?</div>
          <div class="briefme-quest-subtitle">Target: <strong>${escapeHtml(displayName)}</strong>. Two fields tune the whole pitch.</div>
        </div>
        <form class="briefme-quest-form" id="briefme-pitch-form">
          <label class="briefme-quest-label" for="briefme-pitch-aud-url">Audience profile / reference URL</label>
          <input
            type="url"
            id="briefme-pitch-aud-url"
            class="briefme-quest-input"
            placeholder="https://www.linkedin.com/in/investor or fund portfolio page"
            value="${escapeHtml(saved.audienceUrl || "")}"
            autocomplete="off"
          />
          <div class="briefme-quest-hint">LinkedIn, Crunchbase, or a firm's partner page. Klosr web-searches this to shape the pitch angle.</div>

          <label class="briefme-quest-label" for="briefme-pitch-aud-why">Why this audience</label>
          <textarea
            id="briefme-pitch-aud-why"
            class="briefme-quest-textarea"
            placeholder="e.g. invested in our adjacent category last year, tweeted about our problem, warm intro from a mutual founder"
            rows="3"
          >${escapeHtml(saved.audienceWhy || "")}</textarea>

          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-pitch-back">${t("quest_back")}</button>
            <button type="submit" class="briefme-quest-submit">Generate pitch brief</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById("briefme-pitch-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    });

    document.getElementById("briefme-pitch-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const audienceUrl = document.getElementById("briefme-pitch-aud-url").value.trim();
      const audienceWhy = document.getElementById("briefme-pitch-aud-why").value.trim();
      await savePitchContext({ audienceUrl, audienceWhy });
      sidebar.classList.remove("briefme-picker-view");
      analyzeProfile(currentProfile, "pitch");
    });
  }
  ─────────────────────────────────────────────────────────── */

  // Sales call-mode picker (COLD / FOLLOW-UP / PRE-CALL). Adapts the brief
  // to the conversation stage. Default inferred from pipeline stage.
  async function showSalesCallModePicker() {
    const sidebar = document.getElementById("briefme-sidebar");
    if (sidebar) sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    if (!content) return;

    const isEs = currentLanguage === "es";
    const displayName = getDisplayName(currentProfile);

    const defaultMode = await new Promise((resolve) => {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) { resolve("COLD"); return; }
        chrome.storage.local.get("prepcall_history", (data) => {
          const history = Array.isArray(data && data.prepcall_history) ? data.prepcall_history : [];
          const url = (currentProfile && (currentProfile.profileUrl || currentProfile.url)) || "";
          const name = currentProfile && currentProfile.name;
          const existing = history.find(
            h => (h.url && h.url === url) || (h.name && name && h.name === name)
          );
          const stage = existing && existing.stage;
          if (stage === "call" || stage === "offer") { resolve("PRE-CALL"); return; }
          if (stage === "contacted") { resolve("FOLLOW-UP"); return; }
          resolve("COLD");
        });
      } catch (e) { resolve("COLD"); }
    });

    const copy = isEs ? {
      title: "¿Qué tipo de conversación es esta?",
      subtitle: `Elige la etapa, Klosr adapta el brief. ${defaultMode === "COLD" ? "" : "(Sugerido por tu pipeline.)"}`,
      cold_title: "Frío", cold_desc: "Primer contacto. Sin interacción previa.", cold_badge: "",
      follow_title: "Follow-up", follow_desc: "Ya contactaste, aún no hay respuesta o fue breve.", follow_badge: "Sugerido",
      pre_title: "Pre-llamada", pre_desc: "Reunión agendada, preparando la conversación.", pre_badge: "Sugerido",
      back: "Volver",
    } : {
      title: "What kind of conversation is this?",
      subtitle: `Pick the stage, Klosr adapts the brief. ${defaultMode === "COLD" ? "" : "(Suggested by your pipeline.)"}`,
      cold_title: "Cold", cold_desc: "First contact. No prior interaction.", cold_badge: "",
      follow_title: "Follow-up", follow_desc: "Contacted, no reply yet or brief reply.", follow_badge: "Suggested",
      pre_title: "Pre-call", pre_desc: "Meeting booked, preparing the conversation.", pre_badge: "Suggested",
      back: "Back",
    };

    const suggestedBadge = (mode, label) =>
      mode === defaultMode && defaultMode !== "COLD"
        ? `<span class="briefme-callmode-badge">${escapeHtml(label)}</span>` : "";
    const suggestedPill = (mode) =>
      mode === defaultMode && defaultMode !== "COLD" ? "briefme-callmode-suggested" : "";

    content.innerHTML = `
      <div class="briefme-callmode">
        <div class="briefme-callmode-header">
          <div class="briefme-callmode-title">${escapeHtml(copy.title)}</div>
          <div class="briefme-callmode-sub">${escapeHtml(copy.subtitle)} <strong>${escapeHtml(displayName)}</strong></div>
        </div>
        <div class="briefme-callmode-grid">
          <button class="briefme-callmode-option ${suggestedPill("COLD")}" data-callmode="COLD">
            <div class="briefme-callmode-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 2L11 13"></path><path d="M22 2l-7 20-4-9-9-4 20-7z"></path>
              </svg>
            </div>
            <div class="briefme-callmode-text">
              <div class="briefme-callmode-option-title">${escapeHtml(copy.cold_title)} ${suggestedBadge("COLD", copy.cold_badge)}</div>
              <div class="briefme-callmode-option-desc">${escapeHtml(copy.cold_desc)}</div>
            </div>
          </button>
          <button class="briefme-callmode-option ${suggestedPill("FOLLOW-UP")}" data-callmode="FOLLOW-UP">
            <div class="briefme-callmode-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
                <polyline points="21 3 21 8 16 8"></polyline>
              </svg>
            </div>
            <div class="briefme-callmode-text">
              <div class="briefme-callmode-option-title">${escapeHtml(copy.follow_title)} ${suggestedBadge("FOLLOW-UP", copy.follow_badge)}</div>
              <div class="briefme-callmode-option-desc">${escapeHtml(copy.follow_desc)}</div>
            </div>
          </button>
          <button class="briefme-callmode-option ${suggestedPill("PRE-CALL")}" data-callmode="PRE-CALL">
            <div class="briefme-callmode-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
            </div>
            <div class="briefme-callmode-text">
              <div class="briefme-callmode-option-title">${escapeHtml(copy.pre_title)} ${suggestedBadge("PRE-CALL", copy.pre_badge)}</div>
              <div class="briefme-callmode-option-desc">${escapeHtml(copy.pre_desc)}</div>
            </div>
          </button>
        </div>
        <button class="briefme-callmode-back" id="briefme-callmode-back">← ${escapeHtml(copy.back)}</button>
      </div>
    `;

    content.querySelectorAll(".briefme-callmode-option").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const callMode = e.currentTarget.dataset.callmode;
        if (sidebar) sidebar.classList.remove("briefme-picker-view");
        analyzeProfile(currentProfile, "sales", { callMode });
      });
    });

    const backBtn = document.getElementById("briefme-callmode-back");
    if (backBtn) backBtn.addEventListener("click", () => showModePicker());
  }

  // Proof point library — add / list / remove case studies.
  async function showProofLibraryView(returnTo) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";
    const lib = await getProofLibrary();

    const title = isEs ? "Biblioteca de proof points" : "Proof point library";
    const sub = isEs
      ? "Guarda casos de éxito y métricas. Klosr elige el más relevante para cada prospecto en vez de pegar la misma línea."
      : "Build a small library of case studies and metrics. Klosr picks the most relevant one per prospect instead of using the same line every time.";
    const addLabel = isEs ? "Añadir proof point" : "Add proof point";
    const saveLabel = isEs ? "Guardar" : "Save";
    const backLabel = isEs ? "Volver" : "Back";
    const emptyLabel = isEs
      ? "Aún no hay proof points. Añade 2-3 y Klosr empezará a elegir el más relevante."
      : "No proof points yet. Add 2-3 and Klosr will start picking the most relevant one.";

    const rowsHtml = lib.length === 0
      ? `<div class="briefme-proof-empty">${emptyLabel}</div>`
      : lib.map(p => `
        <div class="briefme-proof-row" data-id="${escapeHtml(p.id)}">
          <div class="briefme-proof-row-main">
            ${p.title ? `<div class="briefme-proof-row-title">${escapeHtml(p.title)}</div>` : ""}
            ${p.metric ? `<div class="briefme-proof-row-metric">${escapeHtml(p.metric)}</div>` : ""}
            <div class="briefme-proof-row-body">${escapeHtml(p.body)}</div>
            <div class="briefme-proof-row-meta">
              ${p.industry ? `<span class="briefme-proof-tag">${escapeHtml(p.industry)}</span>` : ""}
              ${p.useCase ? `<span class="briefme-proof-tag">${escapeHtml(p.useCase)}</span>` : ""}
            </div>
          </div>
          <button class="briefme-proof-row-del" data-del="${escapeHtml(p.id)}" title="${isEs ? "Eliminar" : "Remove"}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6"></path><path d="M14 11v6"></path>
            </svg>
          </button>
        </div>
      `).join("");

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${title}</div>
          <div class="briefme-quest-subtitle">${sub}</div>
        </div>

        <div class="briefme-proof-list" id="briefme-proof-list">${rowsHtml}</div>

        <form class="briefme-quest-form" id="briefme-proof-form">
          <div class="briefme-quest-section-label">${addLabel}</div>

          <label class="briefme-quest-label" for="briefme-proof-title">${isEs ? "Título (p. ej. caso Monzo)" : "Title (e.g. Monzo case study)"}</label>
          <input type="text" id="briefme-proof-title" class="briefme-quest-input" placeholder="${isEs ? "Monzo — tiempo de maker protegido" : "Monzo — maker time protected"}" autocomplete="off" />

          <label class="briefme-quest-label" for="briefme-proof-metric">${isEs ? "Métrica clave" : "Key metric"}</label>
          <input type="text" id="briefme-proof-metric" class="briefme-quest-input" placeholder="${isEs ? "p. ej. +37% tiempo en deep work" : "e.g. +37% deep-work time"}" autocomplete="off" />

          <div class="briefme-proof-grid">
            <div>
              <label class="briefme-quest-label" for="briefme-proof-industry">${isEs ? "Industria" : "Industry"}</label>
              <input type="text" id="briefme-proof-industry" class="briefme-quest-input" placeholder="fintech, saas, devtools..." autocomplete="off" />
            </div>
            <div>
              <label class="briefme-quest-label" for="briefme-proof-usecase">${isEs ? "Caso de uso" : "Use case"}</label>
              <input type="text" id="briefme-proof-usecase" class="briefme-quest-input" placeholder="scaling engineering, series B..." autocomplete="off" />
            </div>
          </div>

          <label class="briefme-quest-label" for="briefme-proof-body">${isEs ? "Detalle (1-3 frases)" : "Detail (1-3 sentences)"}</label>
          <textarea id="briefme-proof-body" class="briefme-quest-textarea" rows="3" placeholder="${isEs ? "Qué hizo el cliente, qué resultado obtuvo, en cuánto tiempo." : "What the customer did, what outcome they got, over what period."}"></textarea>

          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-proof-back">${backLabel}</button>
            <button type="submit" class="briefme-quest-submit">${saveLabel}</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById("briefme-proof-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      if (returnTo === "setup") showCompanySetup("picker");
      else if (currentBrief) renderBrief(currentBrief, currentMode);
      else showModePicker();
    });

    document.getElementById("briefme-proof-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const item = {
        title:    document.getElementById("briefme-proof-title").value.trim(),
        metric:   document.getElementById("briefme-proof-metric").value.trim(),
        industry: document.getElementById("briefme-proof-industry").value.trim(),
        useCase:  document.getElementById("briefme-proof-usecase").value.trim(),
        body:     document.getElementById("briefme-proof-body").value.trim(),
      };
      if (!item.body) return;
      await addProofPoint(item);
      showProofLibraryView(returnTo);
    });

    document.querySelectorAll(".briefme-proof-row-del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const id = e.currentTarget.dataset.del;
        await removeProofPoint(id);
        showProofLibraryView(returnTo);
      });
    });
  }

  // ============================================================
  // MEMORY VIEW — central place to see, export, import, and clear
  // everything Klosr has learned. All operations are local to
  // chrome.storage — nothing leaves the browser unless the user
  // explicitly copies the exported JSON.
  // ============================================================
  async function showMemoryView(returnTo) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";

    const mem = await buildUserMemory();
    const s = summarizeMemory(mem);

    const title = isEs ? "Tu memoria" : "Your memory";
    const sub = isEs
      ? "Todo lo que Klosr ha aprendido sobre ti, guardado local en tu navegador. Exporta para hacer backup o cambiar de ordenador."
      : "Everything Klosr has learned about you, stored locally in your browser. Export to back up or move to a new machine.";

    const row = (label, value) => `
      <div class="briefme-mem-row">
        <div class="briefme-mem-label">${escapeHtml(label)}</div>
        <div class="briefme-mem-value">${escapeHtml(String(value || (isEs ? "—" : "—")))}</div>
      </div>
    `;

    const whoBlock = s.identity ? `
      <div class="briefme-mem-group">
        <div class="briefme-mem-group-title">${isEs ? "Quién eres" : "Who you are"}</div>
        ${row(isEs ? "Nombre" : "Name", s.identity)}
        ${s.yourRole ? row(isEs ? "Rol" : "Role", s.yourRole) : ""}
        ${s.whatYouSell ? row(isEs ? "Qué vendes" : "What you sell", s.whatYouSell.slice(0, 160)) : ""}
      </div>
    ` : `
      <div class="briefme-mem-empty">${isEs ? "Aún no has configurado tu perfil." : "You haven't set up your profile yet."}</div>
    `;

    const learningsBlock = `
      <div class="briefme-mem-group">
        <div class="briefme-mem-group-title">${isEs ? "Aprendizaje" : "Learning"}</div>
        ${row(isEs ? "Prospectos en pipeline" : "Prospects in pipeline", s.prospects)}
        ${row(isEs ? "Ediciones de voz" : "Voice edits", s.voiceExamples)}
        ${row(isEs ? "Resultados (ganado/perdido)" : "Outcomes (won/lost)", s.outcomes)}
        ${row(isEs ? "Objeciones en playbook" : "Objections in playbook", s.objections)}
        ${row(isEs ? "Proof points" : "Proof points", s.proofPoints)}
        ${row(isEs ? "Notas de llamadas" : "Call notes", s.callNotes)}
        ${s.icpSummary ? `
          <div class="briefme-mem-row briefme-mem-row-wide">
            <div class="briefme-mem-label">${isEs ? "ICP empírico" : "Empirical ICP"}</div>
            <div class="briefme-mem-value briefme-mem-value-block">${escapeHtml(s.icpSummary)}</div>
          </div>` : ""}
      </div>
    `;

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${title}</div>
          <div class="briefme-quest-subtitle">${sub}</div>
        </div>

        ${whoBlock}
        ${learningsBlock}

        <div class="briefme-mem-actions">
          <button type="button" class="briefme-mem-btn briefme-mem-btn-primary" id="briefme-mem-export">
            ${isEs ? "Exportar memoria" : "Export memory"}
          </button>
          <button type="button" class="briefme-mem-btn" id="briefme-mem-import-open">
            ${isEs ? "Importar memoria" : "Import memory"}
          </button>
          <button type="button" class="briefme-mem-btn briefme-mem-btn-danger" id="briefme-mem-clear">
            ${isEs ? "Borrar todo" : "Clear everything"}
          </button>
        </div>

        <div class="briefme-mem-import-panel" id="briefme-mem-import-panel" hidden>
          <div class="briefme-quest-label">${isEs ? "Pega JSON exportado aquí" : "Paste exported JSON here"}</div>
          <textarea id="briefme-mem-import-text" class="briefme-quest-textarea" rows="6" placeholder="{ &quot;klosrMemoryVersion&quot;: 1, ... }"></textarea>
          <div class="briefme-mem-import-actions">
            <button type="button" class="briefme-mem-btn" id="briefme-mem-import-cancel">${isEs ? "Cancelar" : "Cancel"}</button>
            <button type="button" class="briefme-mem-btn briefme-mem-btn-primary" id="briefme-mem-import-submit">${isEs ? "Restaurar" : "Restore"}</button>
          </div>
          <div class="briefme-mem-import-status" id="briefme-mem-import-status"></div>
        </div>

        <div class="briefme-mem-json-panel" id="briefme-mem-json-panel" hidden>
          <div class="briefme-quest-label">${isEs ? "Memoria completa (copia esto)" : "Full memory (copy this)"}</div>
          <textarea id="briefme-mem-json" class="briefme-quest-textarea" rows="10" readonly></textarea>
          <div class="briefme-mem-import-actions">
            <button type="button" class="briefme-mem-btn" id="briefme-mem-json-close">${isEs ? "Cerrar" : "Close"}</button>
            <button type="button" class="briefme-mem-btn briefme-mem-btn-primary" id="briefme-mem-json-copy">${isEs ? "Copiar" : "Copy"}</button>
          </div>
        </div>

        <div class="briefme-quest-actions">
          <button type="button" class="briefme-quest-back" id="briefme-mem-back">${isEs ? "Volver" : "Back"}</button>
        </div>
      </div>
    `;

    document.getElementById("briefme-mem-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      if (returnTo === "setup") showCompanySetup("picker");
      else showModePicker();
    });

    // Export → show the JSON inline with a copy button.
    document.getElementById("briefme-mem-export").addEventListener("click", async () => {
      const snapshot = await buildUserMemory();
      const json = JSON.stringify(snapshot, null, 2);
      const panel = document.getElementById("briefme-mem-json-panel");
      const ta = document.getElementById("briefme-mem-json");
      panel.hidden = false;
      ta.value = json;
      ta.select();
    });

    document.getElementById("briefme-mem-json-copy").addEventListener("click", async (e) => {
      const ta = document.getElementById("briefme-mem-json");
      try {
        await navigator.clipboard.writeText(ta.value);
        const btn = e.currentTarget;
        const orig = btn.textContent;
        btn.textContent = isEs ? "¡Copiado!" : "Copied!";
        setTimeout(() => { btn.textContent = orig; }, 1400);
      } catch (err) {
        ta.select();
        document.execCommand("copy");
      }
    });

    document.getElementById("briefme-mem-json-close").addEventListener("click", () => {
      document.getElementById("briefme-mem-json-panel").hidden = true;
    });

    // Import — paste JSON, validate, restore.
    document.getElementById("briefme-mem-import-open").addEventListener("click", () => {
      document.getElementById("briefme-mem-import-panel").hidden = false;
      const ta = document.getElementById("briefme-mem-import-text");
      if (ta) setTimeout(() => ta.focus(), 50);
    });
    document.getElementById("briefme-mem-import-cancel").addEventListener("click", () => {
      document.getElementById("briefme-mem-import-panel").hidden = true;
      document.getElementById("briefme-mem-import-status").textContent = "";
    });
    document.getElementById("briefme-mem-import-submit").addEventListener("click", async () => {
      const statusEl = document.getElementById("briefme-mem-import-status");
      const raw = document.getElementById("briefme-mem-import-text").value.trim();
      if (!raw) return;
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) {
        statusEl.textContent = isEs ? "JSON inválido." : "Invalid JSON.";
        statusEl.className = "briefme-mem-import-status briefme-mem-import-status-error";
        return;
      }
      try {
        const written = await restoreUserMemory(parsed);
        statusEl.textContent = isEs
          ? `Restaurado. ${written.length} sección${written.length === 1 ? "" : "es"} actualizadas.`
          : `Restored. ${written.length} section${written.length === 1 ? "" : "s"} updated.`;
        statusEl.className = "briefme-mem-import-status briefme-mem-import-status-success";
        setTimeout(() => { showMemoryView(returnTo); }, 900);
      } catch (e) {
        statusEl.textContent = isEs ? `Error: ${e.message}` : `Error: ${e.message}`;
        statusEl.className = "briefme-mem-import-status briefme-mem-import-status-error";
      }
    });

    // Clear — destructive, requires a double-tap confirm.
    let _clearArmed = false;
    document.getElementById("briefme-mem-clear").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!_clearArmed) {
        _clearArmed = true;
        btn.textContent = isEs ? "¿Seguro? Clic otra vez" : "Sure? Click again";
        setTimeout(() => {
          _clearArmed = false;
          btn.textContent = isEs ? "Borrar todo" : "Clear everything";
        }, 3500);
        return;
      }
      await clearUserMemory();
      showMemoryView(returnTo);
    });
  }

  // Render the brief
  function renderBrief(brief, mode) {
    // Stop any running labor illusion
    if (_briefLaborInterval) { clearInterval(_briefLaborInterval); _briefLaborInterval = null; }

    // Store globally so chat can reference them
    currentBrief = brief;
    currentMode = mode;
    chatMessages = []; // fresh thread per brief

    const content = document.getElementById("briefme-content");
    const modeLabels = {
      sales: t("sales_label"),
      interview: t("interview_label"),
      pitch: t("pitch_label"),
    };

    const displayName = getDisplayName(currentProfile);
    const safeName = escapeHtml(displayName);
    const initials = getInitials(displayName);
    const photoUrl = currentProfile && currentProfile.photoUrl ? currentProfile.photoUrl : "";

    // Profile card with avatar — matches the picker style for visual continuity
    const avatarHtml = `
      <div class="briefme-avatar">
        <span class="briefme-avatar-initials">${initials}</span>
        ${photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="${safeName}" referrerpolicy="no-referrer" onerror="this.style.display='none'" />` : ""}
      </div>
    `;

    const headlineHtml = currentProfile.headline
      ? `<div class="briefme-profile-headline">${escapeHtml(currentProfile.headline)}</div>`
      : "";
    const locationHtml = currentProfile.location
      ? `<div class="briefme-profile-location">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
             <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
             <circle cx="12" cy="10" r="3"></circle>
           </svg>
           ${escapeHtml(currentProfile.location)}
         </div>`
      : "";

    content.innerHTML = `
      <div class="briefme-brief">
        <div class="briefme-brief-profile-card">
          ${avatarHtml}
          <div class="briefme-profile-info">
            <div class="briefme-profile-name">${safeName}</div>
            ${headlineHtml}
            ${locationHtml}
          </div>
          <div class="briefme-brief-mode-badge">${modeLabels[mode] || "Brief"}</div>
        </div>
        <div class="briefme-brief-body">
          ${formatBrief(brief)}
        </div>
        <div class="briefme-brief-actions">
          <button class="briefme-copy-btn" id="briefme-copy">${t("copy_brief")}</button>
          <button class="briefme-email-btn" id="briefme-email">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
              <polyline points="22,6 12,13 2,6"></polyline>
            </svg>
            ${t("email_btn")}
          </button>
          <button class="briefme-pipeline-btn" id="briefme-open-pipeline" title="${currentLanguage === "es" ? "Abrir en pipeline" : "Open in pipeline"}">📊 ${currentLanguage === "es" ? "Pipeline" : "Pipeline"}</button>
          <button class="briefme-refresh-btn" id="briefme-refresh">${t("refresh")}</button>
        </div>
        <div class="briefme-chat-section">
          <div class="briefme-chat-thread" id="briefme-chat-thread"></div>
          <form class="briefme-chat-form" id="briefme-chat-form">
            <input
              type="text"
              class="briefme-chat-input"
              id="briefme-chat-input"
              placeholder="${t("chat_placeholder")}"
              autocomplete="off"
            />
            <button type="submit" class="briefme-chat-send" aria-label="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0A0A0A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </form>
        </div>
      </div>
    `;

    // Pipeline button — jump straight into the deal view for this prospect.
    const pipelineBtn = document.getElementById("briefme-open-pipeline");
    if (pipelineBtn) {
      pipelineBtn.addEventListener("click", () => {
        showDealPipelineView();
      });
    }

    // Copy button
    document.getElementById("briefme-copy").addEventListener("click", () => {
      navigator.clipboard.writeText(brief).then(() => {
        const btn = document.getElementById("briefme-copy");
        btn.textContent = t("copied");
        setTimeout(() => btn.textContent = t("copy_brief"), 2000);
      });
    });

    // Refresh button
    document.getElementById("briefme-refresh").addEventListener("click", () => {
      const activeTab = document.querySelector(".briefme-tab.active");
      const mode = activeTab ? activeTab.dataset.mode : "sales";
      analyzeProfile(currentProfile, mode);
    });

    // Email button — generate a personalized outreach email
    document.getElementById("briefme-email").addEventListener("click", () => {
      handleEmailClick();
    });

    // Chat form
    const chatForm = document.getElementById("briefme-chat-form");
    chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("briefme-chat-input");
      const question = input.value.trim();
      if (!question) return;
      input.value = "";
      sendChatMessage(question);
    });
  }

  // Append a message bubble to the chat thread
  function appendChatBubble(role, text, id) {
    const thread = document.getElementById("briefme-chat-thread");
    if (!thread) return null;
    const bubble = document.createElement("div");
    bubble.className = `briefme-chat-msg briefme-chat-msg-${role}`;
    if (id) bubble.id = id;
    bubble.innerHTML = role === "assistant" ? formatInline(text) : escapeHtml(text);
    thread.appendChild(bubble);
    // Scroll the scroll container so the newest bubble is in view
    const scroller = document.getElementById("briefme-content");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    return bubble;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Send a chat follow-up to the API and render the reply
  async function sendChatMessage(question) {
    // Optimistic user bubble
    appendChatBubble("user", question);
    chatMessages.push({ role: "user", content: question });

    // Objection memory: tag this question so the assistant reply gets
    // recorded as a rebuttal if it reads like an objection ask.
    const _pendingObjectionTrigger = looksLikeObjectionAsk(question) ? question : null;

    // Placeholder assistant bubble while loading
    const thinkingId = "briefme-chat-thinking-" + Date.now();
    appendChatBubble("assistant", `<span class="briefme-chat-thinking">${t("chat_thinking")}</span>`, thinkingId);

    try {
      // Inject the richer context (playbook, proof library, similar-prospect
      // call notes) into the first message of the thread.
      const messagesForApi = [...chatMessages];
      const myContext = await buildMyContextAsync(currentProfile);
      if (myContext && messagesForApi.length === 1) {
        messagesForApi[0] = {
          role: "user",
          content: myContext + "\n\n---\n\nUSER'S QUESTION:\n" + messagesForApi[0].content,
        };
      }

      // Bounded wait (3s) for Proxycurl so chat replies have company facts
      // on the very first turn. Cache hit after that = zero wait.
      const [_playbook, _library, _notes, _ninja] = await Promise.all([
        getObjectionPlaybook(),
        getProofLibrary(),
        getRelevantCallNotes(currentProfile),
        waitForNinjaPear(currentProfile, 3000),
      ]);

      const response = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: currentProfile,
          mode: currentMode,
          brief: currentBrief,
          messages: messagesForApi,
          language: currentLanguage,
          claudeMemoryRaw: (companyProfile && companyProfile.claudeMemoryRaw) || "",
          objectionPlaybook: _playbook,
          proofLibrary: _library,
          relevantCallNotes: _notes,
          ninjaPearData: _ninja,
        }),
      });

      if (!response.ok) {
        throw new Error("Chat API error " + response.status);
      }

      const data = await response.json();
      const reply = (data && data.reply) ? data.reply.trim() : "";

      // Replace thinking bubble with actual reply
      const bubble = document.getElementById(thinkingId);
      if (bubble) {
        bubble.innerHTML = formatInline(reply);
        bubble.removeAttribute("id");
      } else {
        appendChatBubble("assistant", reply);
      }

      if (reply) {
        chatMessages.push({ role: "assistant", content: reply });
        // Pair the reply with the objection trigger if the question qualified.
        if (_pendingObjectionTrigger) {
          recordObjectionExchange(_pendingObjectionTrigger, reply, currentProfile)
            .catch(() => {});
        }
      }
    } catch (err) {
      console.error("PrepCall.AI chat error:", err);
      const bubble = document.getElementById(thinkingId);
      if (bubble) {
        bubble.innerHTML = `<em>${t("chat_error")}</em>`;
        bubble.removeAttribute("id");
      }
      // Remove the failed user message from history so retry works cleanly
      chatMessages.pop();
    }
  }

  // ============================================================
  // JUICINESS ENGINE — personality, labor illusion, celebrations
  // Inspired by Claude Code's 187 loading messages
  // ============================================================

  const LOADING_MESSAGES_EN = [
    "Scanning their LinkedIn...", "Reading their recent posts...",
    "Checking what they've been up to...", "Digging into their background...",
    "Finding the angle...", "Connecting the dots...",
    "Looking for the hook...", "Analyzing their career moves...",
    "Checking their company news...", "Finding what makes them tick...",
    "Building your unfair advantage...", "Crafting something sharp...",
    "This person is interesting...", "Found some good signals...",
    "Pulling the threads together...", "Almost there...",
    "Making it specific to you...", "Personalizing to your pitch...",
    "Cross-referencing with your ICP...", "Polishing the output...",
    "Reading between the lines...", "Checking Glassdoor chatter...",
    "Scanning for recent wins...", "Looking for mutual connections...",
    "Finding conversation gold...", "Mapping their priorities...",
    "Decoding their headline...", "Analyzing posting patterns...",
    "Checking company trajectory...", "Finding the right tone...",
    "Thinking like a founder...", "Channeling your inner closer...",
    "Making Apollo jealous...", "Better than 15 min of Googling...",
    "Klosr is doing its thing...", "Your sales co-pilot is locked in...",
    "While your competitor is still Googling...", "Pipeline doesn't build itself...",
    "Every second here = 15 min saved...", "Your outbound just got unfair...",
    "Closing starts here...", "One more prospect, one more deal...",
    "Turning a stranger into a warm lead...", "Your sales team of one just leveled up...",
    "Closing speed > closing skill...", "Research done. Time to close...",
  ];

  const LOADING_MESSAGES_ES = [
    "Escaneando su LinkedIn...", "Leyendo sus posts recientes...",
    "Viendo qué ha estado haciendo...", "Investigando su trayectoria...",
    "Buscando el ángulo...", "Conectando puntos...",
    "Buscando el gancho...", "Analizando sus movimientos...",
    "Revisando noticias de su empresa...", "Descubriendo qué les importa...",
    "Construyendo tu ventaja...", "Preparando algo afilado...",
    "Esta persona es interesante...", "Encontré buenas señales...",
    "Atando cabos...", "Ya casi...",
    "Personalizando para ti...", "Ajustando a tu pitch...",
    "Cruzando con tu ICP...", "Puliendo el resultado...",
    "Leyendo entre líneas...", "Revisando Glassdoor...",
    "Buscando logros recientes...", "Buscando conexiones en común...",
    "Encontrando oro conversacional...", "Mapeando sus prioridades...",
    "Decodificando su titular...", "Analizando patrones de posts...",
    "Revisando la trayectoria de la empresa...", "Encontrando el tono justo...",
    "Pensando como founder...", "Canalizando tu inner closer...",
    "Haciendo a Apollo envidioso...", "Mejor que 15 min en Google...",
    "Klosr está haciendo lo suyo...", "Tu sales co-pilot está enfocado...",
    "Mientras tu competencia sigue en Google...", "El pipeline no se construye solo...",
    "Cada segundo aquí = 15 min ahorrados...", "Tu outbound acaba de ser injusto...",
    "Aquí empieza el cierre...", "Un prospecto más, un deal más...",
    "Convirtiendo un desconocido en lead...", "Tu equipo de ventas de uno acaba de subir de nivel...",
    "Velocidad de cierre > habilidad de cierre...", "Research hecho. Hora de cerrar...",
  ];

  // Returns a random loading message, cycling through without repeats
  let _lastLoadingIdx = -1;
  function getJuicyMessage() {
    const messages = currentLanguage === "es" ? LOADING_MESSAGES_ES : LOADING_MESSAGES_EN;
    let idx;
    do { idx = Math.floor(Math.random() * messages.length); } while (idx === _lastLoadingIdx && messages.length > 1);
    _lastLoadingIdx = idx;
    return messages[idx];
  }

  // Labor illusion — cycles through 3-4 messages during generation
  // so the user SEES the AI working step by step
  function startLaborIllusion(container) {
    if (!container) return null;
    const msgEl = container.querySelector(".briefme-labor-msg");
    if (!msgEl) return null;
    // Cycle every 2 seconds
    const interval = setInterval(() => {
      msgEl.style.opacity = "0";
      setTimeout(() => {
        msgEl.textContent = getJuicyMessage();
        msgEl.style.opacity = "1";
      }, 200);
    }, 2200);
    return interval;
  }

  function stopLaborIllusion(interval) {
    if (interval) clearInterval(interval);
  }

  // Celebration toasts — shown when pipeline milestones are hit
  function showCelebration(message) {
    const existing = document.getElementById("briefme-celebration");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "briefme-celebration";
    toast.className = "briefme-celebration";
    toast.innerHTML = message;
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.classList.add("briefme-celebration-show"));

    // Remove after 4 seconds
    setTimeout(() => {
      toast.classList.remove("briefme-celebration-show");
      setTimeout(() => toast.remove(), 500);
    }, 4000);
  }

  // Check pipeline milestones after each prospect save
  function checkMilestones(history) {
    if (!history || !Array.isArray(history)) return;
    const total = history.length;
    const contacted = history.filter(p => ["contacted","replied","call","closing","won"].includes(p.stage)).length;
    const replied = history.filter(p => ["replied","call","closing","won"].includes(p.stage)).length;
    const won = history.filter(p => p.stage === "won").length;
    const isEs = currentLanguage === "es";

    // First-time milestones (check localStorage to avoid repeating)
    const shown = (key) => {
      try { return localStorage.getItem("prepcall_milestone_" + key) === "1"; } catch(e) { return false; }
    };
    const mark = (key) => {
      try { localStorage.setItem("prepcall_milestone_" + key, "1"); } catch(e) {}
    };

    if (total >= 5 && !shown("5prep")) {
      mark("5prep");
      showCelebration(isEs ? "🔥 5 prospectos preparados — vas en serio" : "🔥 5 prospects prepped — you mean business");
    } else if (total >= 10 && !shown("10prep")) {
      mark("10prep");
      showCelebration(isEs ? "🚀 10 prospectos en tu pipeline — estás en racha" : "🚀 10 prospects in your pipeline — you're on a streak");
    } else if (total >= 25 && !shown("25prep")) {
      mark("25prep");
      showCelebration(isEs ? "⚡ 25 prospectos — eres una máquina de outreach" : "⚡ 25 prospects — you're an outreach machine");
    } else if (contacted >= 10 && !shown("10contact")) {
      mark("10contact");
      showCelebration(isEs ? "📧 10 contactados — tu pipeline se mueve" : "📧 10 contacted — your pipeline is moving");
    } else if (replied >= 5 && !shown("5reply")) {
      mark("5reply");
      showCelebration(isEs ? "💬 5 respuestas — algo está funcionando" : "💬 5 replies — something's working");
    } else if (won >= 1 && !shown("1won")) {
      mark("1won");
      showCelebration(isEs ? "🏆 ¡PRIMER DEAL CERRADO! Klosr se acaba de pagar solo." : "🏆 FIRST DEAL WON! Klosr just paid for itself.");
    }
  }

  // ============================================================
  // TIME-SAVED TRACKER — the metric that makes founders never cancel
  // "You saved 4.2 hours this week" = measurable ROI
  // ============================================================
  const MANUAL_TIME_SECONDS = {
    quick: 900,       // 15 min to manually research + think of questions/openers
    email: 1200,      // 20 min to research + write a personalized cold email
    connection: 600,  // 10 min to think of a good 300-char connection note
    dm: 600,          // 10 min to craft a personalized LinkedIn DM
    followup: 900,    // 15 min to write a post-call follow-up
    brief: 1800,      // 30 min for a full deep-research brief manually
  };

  function trackTimeSaved(actionType, actualSeconds) {
    const manualTime = MANUAL_TIME_SECONDS[actionType] || 900;
    const saved = Math.max(0, manualTime - actualSeconds);
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get("prepcall_time_saved", (data) => {
        const ts = data && data.prepcall_time_saved ? data.prepcall_time_saved : { total: 0, thisWeek: 0, weekStart: 0, actions: 0 };

        // Reset weekly counter if it's a new week (Monday-based)
        const now = Date.now();
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        if (!ts.weekStart || (now - ts.weekStart) > weekMs) {
          ts.thisWeek = 0;
          ts.weekStart = now;
        }

        ts.total += saved;
        ts.thisWeek += saved;
        ts.actions = (ts.actions || 0) + 1;
        ts.lastAction = now;

        chrome.storage.local.set({ prepcall_time_saved: ts });
      });
    } catch (e) {}
  }

  function loadTimeSaved() {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) { resolve({ total: 0, thisWeek: 0, actions: 0 }); return; }
        chrome.storage.local.get("prepcall_time_saved", (data) => {
          resolve(data && data.prepcall_time_saved ? data.prepcall_time_saved : { total: 0, thisWeek: 0, actions: 0 });
        });
      } catch (e) { resolve({ total: 0, thisWeek: 0, actions: 0 }); }
    });
  }

  function formatTimeSaved(seconds) {
    if (seconds < 60) return seconds + "s";
    if (seconds < 3600) return Math.round(seconds / 60) + " min";
    const hours = Math.floor(seconds / 3600);
    const mins = Math.round((seconds % 3600) / 60);
    return hours + "h " + (mins > 0 ? mins + "m" : "");
  }

  // ============================================================
  // QUICK PREP — instant answers without generating a full brief
  // ============================================================

  // Send a quick question to the chat API (no brief needed — profile is enough).
  // Options:
  //   { charLimit }        — show character counter on result (connection notes)
  //   { objectionTrigger } — treat the reply as an objection rebuttal and log it
  async function sendQuickMessage(question, options) {
    logKlosrEvent("chat_message_sent", { language: currentLanguage });
    const content = document.getElementById("briefme-content");

    // Show juicy labor illusion — cycling messages that show the AI working
    content.innerHTML = `
      <div class="briefme-quick-loading">
        <div class="briefme-spinner"></div>
        <p class="briefme-labor-msg" style="transition: opacity 0.2s">${getJuicyMessage()}</p>
      </div>
    `;
    const laborInterval = startLaborIllusion(content);
    const _quickStart = Date.now();

    const objectionTrigger = (options && options.objectionTrigger)
      ? String(options.objectionTrigger)
      : (looksLikeObjectionAsk(question) ? question : null);

    try {
      // Inject the founder's company context (now including playbook, proof
      // library, and similar-prospect call notes) so the AI grounds its reply.
      const myContext = await buildMyContextAsync(currentProfile);
      const enrichedQuestion = myContext
        ? myContext + "\n\n---\n\nUSER'S QUESTION:\n" + question
        : question;

      // Bounded wait (3s) — same as sendChatMessage, so quick chips
      // and free-text asks get enrichment on the first turn too.
      const [playbook, proofLibrary, relevantNotes, ninjaPearData] = await Promise.all([
        getObjectionPlaybook(),
        getProofLibrary(),
        getRelevantCallNotes(currentProfile),
        waitForNinjaPear(currentProfile, 3000),
      ]);

      const response = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: currentProfile,
          mode: currentMode || "sales",
          brief: currentBrief || "",
          messages: [{ role: "user", content: enrichedQuestion }],
          language: currentLanguage,
          claudeMemoryRaw: (companyProfile && companyProfile.claudeMemoryRaw) || "",
          objectionPlaybook: playbook,
          proofLibrary: proofLibrary,
          relevantCallNotes: relevantNotes,
          ninjaPearData: ninjaPearData,
        }),
      });

      if (!response.ok) {
        throw new Error("API error " + response.status);
      }

      const data = await response.json();
      const reply = (data && data.reply) ? data.reply.trim() : "";

      stopLaborIllusion(laborInterval);
      if (!reply) throw new Error("Empty reply");

      if (objectionTrigger) {
        recordObjectionExchange(objectionTrigger, reply, currentProfile).catch(() => {});
      }

      const _quickSeconds = Math.round((Date.now() - _quickStart) / 1000);
      const actionType = (options && options.charLimit) ? "connection" : "quick";
      trackTimeSaved(actionType, _quickSeconds);
      showQuickResult(reply, { ...options, actualSeconds: _quickSeconds, actionType });
    } catch (err) {
      stopLaborIllusion(laborInterval);
      console.error("PrepCall.AI quick message error:", err);
      showModePicker();
    }
  }

  // Show the quick-action result in a clean card with copy + back buttons.
  // If options.charLimit is set, show a character counter (for connection notes).
  function showQuickResult(answer, options) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");

    const content = document.getElementById("briefme-content");
    const displayName = getDisplayName(currentProfile);
    const safeName = escapeHtml(displayName);
    const initials = getInitials(displayName);
    const photoUrl = currentProfile && currentProfile.photoUrl ? currentProfile.photoUrl : "";

    const avatarHtml = `
      <div class="briefme-avatar briefme-avatar-sm">
        <span class="briefme-avatar-initials">${initials}</span>
        ${photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="${safeName}" referrerpolicy="no-referrer" onerror="this.style.display='none'" />` : ""}
      </div>
    `;

    // Character counter for connection notes (LinkedIn limits to 300 chars)
    const charLimit = options && options.charLimit ? options.charLimit : 0;
    const charCount = answer.length;
    const charCounterHtml = charLimit > 0
      ? `<div class="briefme-char-counter ${charCount > charLimit ? "briefme-char-over" : ""}">${charCount} / ${charLimit} ${t("connection_chars")}</div>`
      : "";

    // Speed badge — "Done in Xs — saved ~15 min"
    const actualSec = options && options.actualSeconds ? options.actualSeconds : 0;
    const actionType = options && options.actionType ? options.actionType : "quick";
    const manualSec = MANUAL_TIME_SECONDS[actionType] || 900;
    const savedSec = Math.max(0, manualSec - actualSec);
    const isEs = currentLanguage === "es";
    const speedBadgeHtml = actualSec > 0
      ? `<div class="briefme-speed-badge">⚡ ${isEs ? "Hecho en" : "Done in"} ${actualSec}s — ${isEs ? "ahorraste" : "saved"} ~${formatTimeSaved(savedSec)}</div>`
      : "";

    content.innerHTML = `
      <div class="briefme-quick-result">
        <div class="briefme-quick-result-header">
          ${avatarHtml}
          <div class="briefme-quick-result-name">${safeName}</div>
        </div>
        ${speedBadgeHtml}
        <div class="briefme-quick-result-body">
          ${formatInline(answer)}
        </div>
        ${charCounterHtml}
        <div class="briefme-quick-result-actions">
          <button class="briefme-copy-btn" id="briefme-quick-copy">${t("quick_copy")}</button>
          <button class="briefme-refresh-btn" id="briefme-quick-another">${t("quick_another")}</button>
        </div>
        <div class="briefme-next-section">
          <div class="briefme-one-more" id="briefme-one-more"></div>
          <div class="briefme-workflow-label">${t("next_step")}</div>
          <div class="briefme-quick-chips">
            <button class="briefme-quick-chip briefme-chip-outreach" data-next="email">${t("next_send_email")}</button>
            <button class="briefme-quick-chip briefme-chip-outreach" data-next="connection">${t("next_connect")}</button>
            <button class="briefme-quick-chip briefme-chip-outreach" data-next="dm">${t("next_dm")}</button>
            <button class="briefme-quick-chip" data-next="brief">${t("next_full_brief")}</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById("briefme-quick-copy").addEventListener("click", (e) => {
      navigator.clipboard.writeText(answer).then(() => {
        const btn = e.currentTarget;
        btn.textContent = t("quick_copied");
        setTimeout(() => { btn.textContent = t("quick_copy"); }, 2000);
      });
    });

    document.getElementById("briefme-quick-another").addEventListener("click", () => {
      showModePicker();
    });

    // "One more" nudge — show pipeline context to create the "just one more" loop
    loadProspectHistory().then(history => {
      const nudge = document.getElementById("briefme-one-more");
      if (!nudge || !history || history.length === 0) return;
      const preppedOnly = history.filter(p => p.stage === "prepped").length;
      const isEs = currentLanguage === "es";
      if (preppedOnly > 0) {
        nudge.textContent = isEs
          ? `📊 ${preppedOnly} prospecto${preppedOnly > 1 ? "s" : ""} más esperando outreach`
          : `📊 ${preppedOnly} more prospect${preppedOnly > 1 ? "s" : ""} waiting for outreach`;
      }
    });

    // Next-step chips — chain actions naturally + advance deal stage
    document.querySelectorAll("[data-next]").forEach(chip => {
      chip.addEventListener("click", (e) => {
        const next = e.currentTarget.dataset.next;
        const isEs = currentLanguage === "es";
        if (next === "email") {
          if (currentProfile) saveProspectToHistory(currentProfile, "contacted");
          handleEmailClick();
        }
        else if (next === "connection") {
          if (currentProfile) saveProspectToHistory(currentProfile, "contacted");
          const prompt = isEs
            ? `Escribe una nota de solicitud de conexión de LinkedIn para ${safeName}. MÁXIMO 300 caracteres. Hazla personal — referencia algo específico de su perfil. Nada de genérico. Devuelve SOLO el texto del mensaje.`
            : `Write a LinkedIn connection request note to ${safeName}. MAXIMUM 300 characters. Make it personal — reference something specific from their profile. No generic phrases. Output ONLY the message text.`;
          sendQuickMessage(prompt, { charLimit: 300 });
        }
        else if (next === "dm") {
          if (currentProfile) saveProspectToHistory(currentProfile, "contacted");
          const prompt = isEs
            ? `Escribe un mensaje directo corto de LinkedIn para ${safeName}. 3-4 frases max. Referencia algo específico de su perfil. El objetivo es iniciar una conversación. Sé humano, no vendedor. Devuelve SOLO el texto.`
            : `Write a short LinkedIn direct message to ${safeName}. 3-4 sentences max. Reference something specific from their profile. The goal is to start a conversation. Be human, not salesy. Output ONLY the message text.`;
          sendQuickMessage(prompt);
        }
        else if (next === "brief") {
          const sidebar = document.getElementById("briefme-sidebar");
          sidebar.classList.remove("briefme-picker-view");
          analyzeProfile(currentProfile, "sales");
        }
      });
    });
  }

  // ============================================================
  // ONBOARDING — "This is me" self-scrape + short follow-up form
  // ============================================================

  // Screen 1: "This is me" — shown only when user has no profile set.
  // Explains they need to visit THEIR OWN LinkedIn profile and click the button.
  function showThisIsMeScreen() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";

    // Check if this page LOOKS like the user's own profile. LinkedIn shows
    // edit-UI affordances only on pages you own, so any of these signals
    // confirms "this is me." Covers English, Spanish, German, French, and
    // the newer profile-completion prompt + analytics tile that only render
    // for logged-in profile owners.
    const isOwnProfile = !!document.querySelector([
      '[class*="open-to-work" i]',
      'button[aria-label*="Edit intro" i]',
      'button[aria-label*="Editar intro" i]',
      'button[aria-label*="Intro bearbeiten" i]',
      'button[aria-label*="Modifier la présentation" i]',
      'button[aria-label*="Add profile section" i]',
      'button[aria-label*="Añadir sección" i]',
      'button[aria-label*="Profilabschnitt hinzufügen" i]',
      'button[aria-label*="Edit profile" i]',
      'button[aria-label*="Editar perfil" i]',
      'a[href*="/me/edit" i]',
      'a[href*="/me/skills" i]',
      'button[aria-label*="Start a post" i]',
      'a[href*="/dashboard"]',
      // Analytics tile only renders on your own profile
      'section[class*="profile-analytics" i]',
      // "Enhance profile" / "Improve your profile" / "Suggested for you" panels
      '[data-view-name="profile-premium-upsell"]',
      '[data-test-id="profile-card-me"]',
    ].join(","));

    const displayName = getDisplayName(currentProfile);

    if (isOwnProfile) {
      // They're ON their own profile — show "This is me" button
      content.innerHTML = `
        <div class="briefme-onboarding">
          <div class="briefme-onboarding-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#FFD60A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
          </div>
          <div class="briefme-onboarding-title">${isEs ? "¿Eres " + escapeHtml(displayName) + "?" : "Is this you, " + escapeHtml(displayName) + "?"}</div>
          <div class="briefme-onboarding-sub">${isEs ? "Un click y sabré todo sobre ti y tu empresa. Así puedo personalizar cada email, pregunta y brief que genere." : "One click and I'll know you and your company. Every email, question, and brief I generate will be personalized to YOUR business."}</div>
          <button class="briefme-thisisme-btn" id="briefme-thisisme">
            ${isEs ? "Sí, soy yo — importar mi perfil" : "Yes, this is me — import my profile"}
          </button>
          <button class="briefme-skip-btn" id="briefme-skip-onboarding">${isEs ? "Saltar — rellenar manualmente" : "Skip — fill in manually"}</button>
        </div>
      `;

      document.getElementById("briefme-thisisme").addEventListener("click", async () => {
        // Scrape THIS profile as the user's own identity
        content.innerHTML = `
          <div class="briefme-quick-loading">
            <div class="briefme-spinner"></div>
            <p>${isEs ? "Importando tu perfil..." : "Importing your profile..."}</p>
          </div>
        `;

        const myData = await scrapeMyProfile(currentProfile);
        await saveCompanyProfile(myData);

        // Sync sender too
        await saveSenderToStorage({
          name: myData.yourName || "",
          role: myData.yourRole || "",
          company: myData.companyName || "",
          context: myData.whatYouSell || "",
        });

        // Full review form — every field prefilled, user just tweaks.
        showOnboardingReviewForm("picker");
      });

      document.getElementById("briefme-skip-onboarding").addEventListener("click", () => {
        showCompanySetup("picker");
      });

    } else {
      // They're on SOMEONE ELSE's profile — tell them to visit their own first
      content.innerHTML = `
        <div class="briefme-onboarding">
          <div class="briefme-onboarding-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#FFD60A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
          </div>
          <div class="briefme-onboarding-title">${isEs ? "Primero, cuéntame sobre ti" : "First, let me get to know you"}</div>
          <div class="briefme-onboarding-sub">${isEs ? "Haz click abajo y te llevaré a tu perfil. Importaré tus datos automáticamente." : "Click below and I'll take you to your profile. I'll import your data automatically."}</div>
          <button class="briefme-thisisme-btn" id="briefme-goto-myprofile">
            ${isEs ? "Ir a mi perfil de LinkedIn" : "Go to my LinkedIn profile"}
          </button>
          <button class="briefme-skip-btn" id="briefme-skip-onboarding">${isEs ? "Saltar — rellenar manualmente" : "Skip — fill in manually"}</button>
          <button class="briefme-skip-btn" id="briefme-skip-entirely">${isEs ? "Usar sin personalizar" : "Use without personalizing"}</button>
        </div>
      `;

      document.getElementById("briefme-goto-myprofile").addEventListener("click", () => {
        // Set a flag so the content script auto-triggers onboarding on arrival
        try {
          chrome.storage.local.set({ prepcall_pending_onboarding: true });
        } catch (e) {}
        // Navigate in the SAME tab so the experience is seamless
        window.location.href = "https://www.linkedin.com/in/me/";
      });

      document.getElementById("briefme-skip-onboarding").addEventListener("click", () => {
        showCompanySetup("picker");
      });

      document.getElementById("briefme-skip-entirely").addEventListener("click", async () => {
        // Save a minimal profile so onboarding doesn't show again
        await saveCompanyProfile({ yourName: "User", skipped: true });
        showModePicker();
      });
    }
  }

  // Fully automatic import — scrape, save, show short form. Zero clicks.
  // Called when the user arrives on their own profile from the onboarding flow.
  async function autoImportMyProfile() {
    createSidebar();
    openSidebar();

    const isEs = currentLanguage === "es";
    const content = document.getElementById("briefme-content");
    content.innerHTML = `
      <div class="briefme-quick-loading">
        <div class="briefme-spinner"></div>
        <p class="briefme-labor-msg" style="transition: opacity 0.2s">${isEs ? "Importando tu perfil..." : "Importing your profile..."}</p>
      </div>
    `;
    const laborInterval = startLaborIllusion(content);

    try {
      currentProfile = await scrapeProfile();
    } catch (e) {
      console.error("PrepCall.AI auto-import scrape error:", e);
    }

    stopLaborIllusion(laborInterval);

    if (!currentProfile || !currentProfile.name || currentProfile.name === "Unknown") {
      // Scrape failed — fall back to manual
      showCompanySetup("picker");
      return;
    }

    // Auto-import the profile data (async — AI-infers ICP/valueProp/tone)
    const myData = await scrapeMyProfile(currentProfile);
    await saveCompanyProfile(myData);
    await saveSenderToStorage({
      name: myData.yourName || "",
      role: myData.yourRole || "",
      company: myData.companyName || "",
      context: myData.whatYouSell || "",
    });

    // Full review form — every field prefilled, user just tweaks.
    showOnboardingReviewForm("picker");
  }

  // Extract company profile fields from a scraped LinkedIn profile (the user's own).
  // Async: calls the Autofill API to have Claude infer the fields LinkedIn
  // can't directly give us (ICP, value prop, proof points, tone). Falls back
  // gracefully to scrape-only values if the API call fails.
  async function scrapeMyProfile(profile) {
    const name = profile.name || "";
    const headline = profile.headline || "";
    const about = profile.about || "";

    // Current role + company are NOT set on the scraped profile object —
    // they live inside the experience array as the first entry (LinkedIn
    // orders by "Present" first). Derive them here so the onboarding form
    // isn't blank for every new user.
    const exp0 = (Array.isArray(profile.experience) && profile.experience[0]) || null;
    let role = profile.currentRole || (exp0 && exp0.title) || "";
    let company = profile.currentCompany || (exp0 && exp0.company) || "";

    // If still nothing, try to parse role + company out of the headline.
    // Common LinkedIn headline patterns:
    //   "CEO at Acme"
    //   "CEO @ Acme"
    //   "CEO · Acme"
    //   "CEO | Acme | extra stuff"
    if ((!role || !company) && headline) {
      // "X at Y", "X @ Y", "X · Y"
      const atMatch = headline.match(/^(.+?)\s+(?:at|@|·|-)\s+([^|·\-—]+?)(?:\s*[|·\-—].*)?$/i);
      if (atMatch) {
        if (!role) role = atMatch[1].trim().slice(0, 160);
        if (!company) company = atMatch[2].trim().slice(0, 160);
      }
    }
    // Save back onto the profile object so later code paths (email / chat
    // payload) get the same values the onboarding form sees.
    profile.currentRole = role;
    profile.currentCompany = company;

    // Direct scrape: What they (probably) sell, from About or headline.
    // Include the most recent experience description as a fallback — often
    // the clearest pitch of what their company does.
    let whatYouSell = "";
    if (about && about.length > 20) {
      whatYouSell = about.slice(0, 400).trim();
    } else if (Array.isArray(profile.experience) && profile.experience[0] && profile.experience[0].description) {
      whatYouSell = String(profile.experience[0].description).slice(0, 400).trim();
    } else if (headline) {
      whatYouSell = headline;
    }

    // Direct scrape: Background summary from experience entries.
    let background = "";
    if (profile.experience && profile.experience.length > 0) {
      background = profile.experience.slice(0, 4)
        .map(e => `${e.title} at ${e.company}`)
        .join(". ") + ".";
    }

    const base = {
      yourName: name,
      yourRole: role,
      companyName: company,
      whatYouSell: whatYouSell,
      icp: "",
      valueProp: "",
      objections: "",
      proofPoints: "",
      background: background,
      tone: "",
      linkedInImported: true,
      photoUrl: profile.photoUrl || "",
    };

    // ONBOARDING ONLY: wait for NinjaPear enrichment of the user's OWN
    // profile. This is the one place we deliberately block — onboarding is
    // a once-per-user moment and richer input → materially better autofill
    // (company description, size, HQ, funding all flow into proof points
    // and value prop).
    let ninjaPearData = null;
    try {
      const enrichPromise = warmNinjaPear(profile);
      // Hard 10s cap so a slow vendor doesn't wedge onboarding.
      ninjaPearData = await Promise.race([
        enrichPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
      ]);
    } catch (e) {
      ninjaPearData = null;
    }

    // Fold in direct signals from NinjaPear that we can trust verbatim
    // without calling Claude — company size, HQ, founded date are facts.
    if (ninjaPearData && ninjaPearData.company) {
      const c = ninjaPearData.company;
      if (!base.companyName && c.name) base.companyName = c.name;
      // Background gets richer: append company description if we have it
      // and the experience-based background is short.
      if (c.description && base.background.length < 120) {
        base.background = `${base.background} ${String(c.description).slice(0, 240)}`.trim();
      }
      // Proof points — start a seeded list from visible company facts.
      const seeds = [];
      if (c.founded_year) seeds.push(`Founded ${c.founded_year}`);
      if (c.company_size_on_linkedin) seeds.push(`${c.company_size_on_linkedin} employees on LinkedIn`);
      if (Array.isArray(c.funding_data) && c.funding_data.length > 0) {
        const last = c.funding_data[c.funding_data.length - 1];
        if (last.funding_type && last.announced_date) {
          seeds.push(`${last.funding_type} (${String(last.announced_date.year || last.announced_date).slice(0, 4)})`);
        }
      }
      if (seeds.length > 0) base.proofPoints = seeds.join(". ") + ".";
    }

    // AI inference pass — fill the fields LinkedIn doesn't directly expose.
    // Now passes ninjaPearData so the model has hard company facts to ground
    // ICP / value prop / proof points in, not just headline text.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(AUTOFILL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, ninjaPearData }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok) {
        const inferred = await response.json();
        // Scraped About wins for whatYouSell (it's in their own words),
        // but if empty, use the AI summary.
        if (!base.whatYouSell && inferred.whatYouSell) base.whatYouSell = inferred.whatYouSell;
        // AI can now return yourRole / companyName — fill only if still blank.
        if (!base.yourRole    && inferred.yourRole)    base.yourRole    = inferred.yourRole;
        if (!base.companyName && inferred.companyName) base.companyName = inferred.companyName;
        base.icp         = inferred.icp         || base.icp;
        base.valueProp   = inferred.valueProp   || base.valueProp;
        base.objections  = inferred.objections  || base.objections;
        // Proof points: prefer AI version if it's richer than the seeded one.
        if (inferred.proofPoints && inferred.proofPoints.length > base.proofPoints.length) {
          base.proofPoints = inferred.proofPoints;
        }
        base.tone        = inferred.tone        || base.tone;
        if (inferred.background && inferred.background.length > base.background.length) {
          base.background = inferred.background;
        }
      }
    } catch (e) {
      console.warn("Klosr: autofill inference failed, using scrape-only values", e);
    }

    // GUARANTEED-NON-EMPTY fallbacks — run LAST after AI + enrichment.
    // Onboarding must show every field with at least a placeholder-equivalent
    // value the user can improve. No blanks.
    const firstExp = Array.isArray(profile.experience) && profile.experience[0];
    if (!base.yourRole)    base.yourRole    = (firstExp && firstExp.title)   || "Founder";
    if (!base.companyName) base.companyName = (firstExp && firstExp.company) || "";
    if (!base.whatYouSell) {
      base.whatYouSell = headline
        || (about && about.slice(0, 200))
        || (firstExp && firstExp.description && String(firstExp.description).slice(0, 200))
        || `What ${base.companyName || "your company"} does.`;
    }
    if (!base.icp) {
      // Reasonable default based on role — user can refine.
      base.icp = base.yourRole.toLowerCase().includes("founder")
        ? "Founders and operators in similar-stage companies"
        : "Teams that would benefit from what you sell";
    }
    if (!base.valueProp) {
      base.valueProp = "Faster / cheaper / more accurate than the existing alternative";
    }
    if (!base.objections) {
      base.objections = "Already using something else, not a priority this quarter, budget";
    }
    if (!base.proofPoints) {
      base.proofPoints = firstExp
        ? `${base.yourRole}${firstExp.company ? " at " + firstExp.company : ""}`
        : "Add your strongest metric, logo, or case study here.";
    }
    if (!base.tone) {
      base.tone = "Direct and clear. Short sentences. No jargon.";
    }
    if (!base.background && firstExp) {
      base.background = `${firstExp.title || "Current role"}${firstExp.company ? " at " + firstExp.company : ""}.`;
    }
    if (!base.background) base.background = "Add your background here.";
    if (!base.tone) base.tone = "Direct and clear. Short sentences. No jargon.";

    return base;
  }

  // Short follow-up form — only the 3-4 fields LinkedIn DOESN'T have
  // Full onboarding review — every field prefilled from LinkedIn +
  // Proxycurl + AI inference. User reviews, tweaks anything that's off,
  // saves in one shot. This is the first-run version of showCompanySetup —
  // same 10 fields, but framed as "review this draft" not "fill this out."
  function showOnboardingReviewForm(returnTo) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const p = companyProfile || {};
    const isEs = currentLanguage === "es";

    const title = isEs
      ? `Casi listo, ${escapeHtml(p.yourName || "")}!`
      : `Almost done, ${escapeHtml(p.yourName || "")}!`;
    const subtitle = isEs
      ? "Importé tu perfil y rellené cada campo. Revisa y ajusta lo que no esté bien, luego guarda."
      : "I imported your profile and filled in every field. Review and tweak what's off, then save.";

    const fields = [
      { id: "yourName",    label: isEs ? "Tu nombre" : "Your name",                 ph: "", type: "input" },
      { id: "yourRole",    label: isEs ? "Tu rol" : "Your role",                   ph: "", type: "input" },
      { id: "companyName", label: isEs ? "Empresa" : "Company",                    ph: "", type: "input" },
      { id: "whatYouSell", label: isEs ? "¿Qué vendes?" : "What do you sell?",     ph: t("setup_sell_ph"), type: "textarea", rows: 3 },
      { id: "icp",         label: isEs ? "¿A quién le vendes? (ICP)" : "Who do you sell to? (ICP)", ph: t("setup_icp_ph"), type: "textarea", rows: 2 },
      { id: "valueProp",   label: isEs ? "Diferenciador clave" : "Key differentiator",              ph: t("setup_value_ph"), type: "textarea", rows: 2 },
      { id: "objections",  label: isEs ? "Objeciones comunes" : "Common objections",                ph: t("setup_objections_ph"), type: "textarea", rows: 2 },
      { id: "proofPoints", label: isEs ? "Proof points" : "Proof points",                           ph: t("setup_proof_ph"), type: "textarea", rows: 2 },
      { id: "background",  label: isEs ? "Tu trayectoria" : "Your background",                      ph: t("setup_background_ph"), type: "textarea", rows: 2 },
      { id: "tone",        label: isEs ? "Tono" : "Tone",                                           ph: t("setup_tone_ph"), type: "input" },
    ];

    const fieldsHtml = fields.map(f => {
      const val = escapeHtml(p[f.id] || "");
      const filledClass = val ? "briefme-onboarding-field-filled" : "";
      if (f.type === "textarea") {
        return `
          <label class="briefme-quest-label" for="briefme-onb-${f.id}">${f.label}</label>
          <textarea id="briefme-onb-${f.id}" class="briefme-quest-textarea ${filledClass}" placeholder="${f.ph}" rows="${f.rows || 2}">${val}</textarea>
        `;
      }
      return `
        <label class="briefme-quest-label" for="briefme-onb-${f.id}">${f.label}</label>
        <input type="text" id="briefme-onb-${f.id}" class="briefme-quest-input ${filledClass}" placeholder="${f.ph}" value="${val}" autocomplete="off" />
      `;
    }).join("");

    // Count how many fields were actually prefilled — the user deserves
    // a pulse of progress so they see Klosr did real work.
    const filledCount = fields.filter(f => (p[f.id] || "").trim().length > 0).length;
    const progressLabel = isEs
      ? `${filledCount} de ${fields.length} campos rellenados automáticamente`
      : `${filledCount} of ${fields.length} fields filled automatically`;

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${title}</div>
          <div class="briefme-quest-subtitle">${subtitle}</div>
        </div>

        <div class="briefme-onboarding-progress">
          <div class="briefme-onboarding-progress-icon">✓</div>
          <div class="briefme-onboarding-progress-text">${progressLabel}</div>
        </div>

        <form class="briefme-quest-form" id="briefme-onb-form">
          ${fieldsHtml}
          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-onb-skip">${isEs ? "Saltar por ahora" : "Skip for now"}</button>
            <button type="submit" class="briefme-quest-submit">${isEs ? "Guardar perfil" : "Save profile"}</button>
          </div>
        </form>
      </div>
    `;

    const finishWith = async (updates) => {
      const merged = { ...companyProfile, ...updates };
      await saveCompanyProfile(merged);
      await saveSenderToStorage({
        name: merged.yourName || "",
        role: merged.yourRole || "",
        company: merged.companyName || "",
        context: merged.whatYouSell || "",
      });
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    };

    document.getElementById("briefme-onb-skip").addEventListener("click", () => finishWith({}));

    document.getElementById("briefme-onb-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const updates = {};
      fields.forEach(f => {
        const el = document.getElementById(`briefme-onb-${f.id}`);
        updates[f.id] = el ? el.value.trim() : "";
      });
      finishWith(updates);
    });
  }

  function showCompanyQuickForm(returnTo) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const p = companyProfile || {};
    const isEs = currentLanguage === "es";

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${isEs ? "Casi listo, " + escapeHtml(p.yourName || "") + "!" : "Almost done, " + escapeHtml(p.yourName || "") + "!"}</div>
          <div class="briefme-quest-subtitle">${isEs ? "Importé tu perfil. Solo necesito lo que LinkedIn no sabe — qué vendes y a quién." : "Imported your profile. I just need what LinkedIn doesn't know — what you sell and to who."}</div>
        </div>
        <form class="briefme-quest-form" id="briefme-quicksetup-form">

          <label class="briefme-quest-label">${t("setup_sell")}</label>
          <textarea class="briefme-quest-textarea" id="briefme-qs-sell" placeholder="${t("setup_sell_ph")}" rows="2">${escapeHtml(p.whatYouSell || "")}</textarea>

          <label class="briefme-quest-label">${t("setup_icp")}</label>
          <textarea class="briefme-quest-textarea" id="briefme-qs-icp" placeholder="${t("setup_icp_ph")}" rows="2">${escapeHtml(p.icp || "")}</textarea>

          <label class="briefme-quest-label">${t("setup_value")}</label>
          <textarea class="briefme-quest-textarea" id="briefme-qs-value" placeholder="${t("setup_value_ph")}" rows="2">${escapeHtml(p.valueProp || "")}</textarea>

          <label class="briefme-quest-label">${t("setup_tone")}</label>
          <input type="text" class="briefme-quest-input" id="briefme-qs-tone" placeholder="${t("setup_tone_ph")}" value="${escapeHtml(p.tone || "")}" autocomplete="off" />

          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-qs-skip">${isEs ? "Saltar por ahora" : "Skip for now"}</button>
            <button type="submit" class="briefme-quest-submit">${t("setup_save")}</button>
          </div>
        </form>
      </div>
    `;

    const finish = async (updates) => {
      const merged = { ...companyProfile, ...updates };
      await saveCompanyProfile(merged);
      await saveSenderToStorage({
        name: merged.yourName || "",
        role: merged.yourRole || "",
        company: merged.companyName || "",
        context: merged.whatYouSell || "",
      });
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    };

    document.getElementById("briefme-qs-skip").addEventListener("click", () => finish({}));

    document.getElementById("briefme-quicksetup-form").addEventListener("submit", (e) => {
      e.preventDefault();
      finish({
        whatYouSell: document.getElementById("briefme-qs-sell").value.trim(),
        icp: document.getElementById("briefme-qs-icp").value.trim(),
        valueProp: document.getElementById("briefme-qs-value").value.trim(),
        tone: document.getElementById("briefme-qs-tone").value.trim(),
      });
    });
  }

  // ============================================================
  // COMPANY SETUP FORM — full 10-field form (manual / edit later)
  // ============================================================

  function showCompanySetup(returnTo) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const p = companyProfile || {};

    const isEs2 = currentLanguage === "es";
    const fields = [
      { id: "yourName", label: t("setup_name"), ph: t("setup_name_ph"), type: "input", required: true },
      { id: "yourRole", label: t("setup_role"), ph: t("setup_role_ph"), type: "input" },
      { id: "companyName", label: t("setup_company"), ph: t("setup_company_ph"), type: "input" },
      { id: "whatYouSell", label: t("setup_sell"), ph: t("setup_sell_ph"), type: "textarea", rows: 2 },
      { id: "icp", label: t("setup_icp"), ph: t("setup_icp_ph"), type: "textarea", rows: 2 },
      { id: "valueProp", label: t("setup_value"), ph: t("setup_value_ph"), type: "textarea", rows: 2 },
      { id: "objections", label: t("setup_objections"), ph: t("setup_objections_ph"), type: "textarea", rows: 2 },
      { id: "proofPoints", label: t("setup_proof"), ph: t("setup_proof_ph"), type: "textarea", rows: 2 },
      { id: "background", label: t("setup_background"), ph: t("setup_background_ph"), type: "textarea", rows: 2 },
      { id: "tone", label: t("setup_tone"), ph: t("setup_tone_ph"), type: "input" },
      {
        id: "calendlyUrl",
        label: isEs2 ? "Tu link de Calendly (opcional)" : "Your Calendly link (optional)",
        ph: "https://calendly.com/you/20min",
        type: "input",
      },
    ];

    const fieldsHtml = fields.map(f => {
      const val = escapeHtml(p[f.id] || "");
      const req = f.required ? "required" : "";
      if (f.type === "textarea") {
        return `
          <label class="briefme-quest-label" for="briefme-setup-${f.id}">${f.label}</label>
          <textarea id="briefme-setup-${f.id}" class="briefme-quest-textarea" placeholder="${f.ph}" rows="${f.rows || 2}" ${req}>${val}</textarea>
        `;
      }
      return `
        <label class="briefme-quest-label" for="briefme-setup-${f.id}">${f.label}</label>
        <input type="text" id="briefme-setup-${f.id}" class="briefme-quest-input" placeholder="${f.ph}" value="${val}" autocomplete="off" ${req} />
      `;
    }).join("");

    const isEs = currentLanguage === "es";
    const importLabel = isEs
      ? "Importar desde memoria de Claude"
      : "Import from Claude memory";
    const importDesc = isEs
      ? "Pega tus notas, memoria de Claude, o bio. Claude rellena todos los campos."
      : "Paste your Claude memory, founder bio, or any context blob. Claude parses and fills all fields.";
    const importPlaceholder = isEs
      ? "Pega aquí (Claude Code memory, Claude.ai 'About me', instrucciones de proyecto, notas de Notion, tu bio, lo que sea). Mínimo ~20 caracteres."
      : "Paste here (Claude Code memory files, Claude.ai 'About me', project instructions, Notion notes, your bio — anything). Min ~20 characters.";

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${t("setup_title")}</div>
          <div class="briefme-quest-subtitle">${t("setup_subtitle")}</div>
        </div>

        <button type="button" class="briefme-import-btn" id="briefme-import-open">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          <span>${importLabel}</span>
        </button>

        <form class="briefme-quest-form" id="briefme-setup-form">
          ${fieldsHtml}

          <div class="briefme-setup-linked-row">
            <button type="button" class="briefme-setup-linked-btn" id="briefme-setup-open-proof">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 7h-9"></path><path d="M14 17H5"></path>
                <circle cx="17" cy="17" r="3"></circle><circle cx="7" cy="7" r="3"></circle>
              </svg>
              <span>${isEs ? "Gestionar biblioteca de proof points" : "Manage proof point library"}</span>
            </button>
            <button type="button" class="briefme-setup-linked-btn" id="briefme-setup-open-memory">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2a4 4 0 0 0-4 4v2"></path>
                <path d="M16 8V6a4 4 0 0 0-4-4"></path>
                <path d="M8 8h8v12a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V8z"></path>
                <path d="M8 14h8"></path>
              </svg>
              <span>${isEs ? "Ver y exportar tu memoria" : "View & export your memory"}</span>
            </button>
          </div>

          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-setup-back">${t("quick_back")}</button>
            <button type="submit" class="briefme-quest-submit">${t("setup_save")}</button>
          </div>
        </form>
      </div>

      <div class="briefme-import-modal" id="briefme-import-modal" hidden>
        <div class="briefme-import-backdrop" id="briefme-import-backdrop"></div>
        <div class="briefme-import-card">
          <div class="briefme-import-header">
            <div class="briefme-import-title">${importLabel}</div>
            <button type="button" class="briefme-import-close" id="briefme-import-close" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="briefme-import-desc">${importDesc}</div>
          <textarea id="briefme-import-text" class="briefme-import-textarea" placeholder="${importPlaceholder}" rows="10"></textarea>
          <div class="briefme-import-actions">
            <button type="button" class="briefme-import-cancel" id="briefme-import-cancel">${isEs ? "Cancelar" : "Cancel"}</button>
            <button type="button" class="briefme-import-submit" id="briefme-import-submit">${isEs ? "Parsear con Claude" : "Parse with Claude"}</button>
          </div>
          <div class="briefme-import-status" id="briefme-import-status"></div>
        </div>
      </div>
    `;

    document.getElementById("briefme-setup-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      if (returnTo === "picker") { showModePicker(); }
      else if (currentBrief) { renderBrief(currentBrief, currentMode); }
      else { showModePicker(); }
    });

    const openProofBtn = document.getElementById("briefme-setup-open-proof");
    if (openProofBtn) {
      openProofBtn.addEventListener("click", () => {
        sidebar.classList.remove("briefme-picker-view");
        showProofLibraryView("setup");
      });
    }

    const openMemoryBtn = document.getElementById("briefme-setup-open-memory");
    if (openMemoryBtn) {
      openMemoryBtn.addEventListener("click", () => {
        showMemoryView("setup");
      });
    }

    document.getElementById("briefme-setup-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const newProfile = {};
      fields.forEach(f => {
        const el = document.getElementById(`briefme-setup-${f.id}`);
        newProfile[f.id] = el ? el.value.trim() : "";
      });
      await saveCompanyProfile(newProfile);

      // Also sync the legacy sender fields for backward compat with email API
      const senderSync = {
        name: newProfile.yourName || "",
        role: newProfile.yourRole || "",
        company: newProfile.companyName || "",
        context: newProfile.whatYouSell || "",
      };
      await saveSenderToStorage(senderSync);

      sidebar.classList.remove("briefme-picker-view");
      if (returnTo === "picker") { showModePicker(); }
      else if (currentBrief) { renderBrief(currentBrief, currentMode); }
      else { showModePicker(); }
    });

    // ─── Import from Claude memory ────────────────────────────────
    const modal = document.getElementById("briefme-import-modal");
    const statusEl = document.getElementById("briefme-import-status");
    const openModal = () => {
      modal.hidden = false;
      statusEl.textContent = "";
      statusEl.className = "briefme-import-status";
      const ta = document.getElementById("briefme-import-text");
      if (ta) setTimeout(() => ta.focus(), 50);
    };
    const closeModal = () => { modal.hidden = true; };

    document.getElementById("briefme-import-open").addEventListener("click", openModal);
    document.getElementById("briefme-import-close").addEventListener("click", closeModal);
    document.getElementById("briefme-import-cancel").addEventListener("click", closeModal);
    document.getElementById("briefme-import-backdrop").addEventListener("click", closeModal);

    document.getElementById("briefme-import-submit").addEventListener("click", async () => {
      const text = document.getElementById("briefme-import-text").value.trim();
      if (text.length < 20) {
        statusEl.textContent = isEs
          ? "Pega al menos 20 caracteres para parsear."
          : "Paste at least 20 characters to parse.";
        statusEl.className = "briefme-import-status briefme-import-status-error";
        return;
      }

      const submitBtn = document.getElementById("briefme-import-submit");
      submitBtn.disabled = true;
      submitBtn.textContent = isEs ? "Parseando..." : "Parsing...";
      statusEl.textContent = isEs
        ? "Claude está leyendo tu contexto. ~5 segundos."
        : "Claude is reading your context. ~5 seconds.";
      statusEl.className = "briefme-import-status briefme-import-status-pending";

      try {
        const response = await fetch(IMPORT_MEMORY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memoryText: text }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.message || `HTTP ${response.status}`);
        }
        const parsed = await response.json();

        // Populate form fields only when the parsed value is non-empty
        let filledCount = 0;
        fields.forEach(f => {
          const val = parsed[f.id];
          if (typeof val === "string" && val.trim().length > 0) {
            const el = document.getElementById(`briefme-setup-${f.id}`);
            if (el) {
              el.value = val.trim();
              filledCount += 1;
            }
          }
        });

        statusEl.textContent = isEs
          ? `Listo. ${filledCount} campos rellenados. Revisa y guarda.`
          : `Done. ${filledCount} fields filled. Review and save.`;
        statusEl.className = "briefme-import-status briefme-import-status-success";
        setTimeout(closeModal, 1200);
      } catch (e) {
        console.error("Klosr import-from-memory failed:", e);
        statusEl.textContent = isEs
          ? `Error: ${e.message}`
          : `Error: ${e.message}`;
        statusEl.className = "briefme-import-status briefme-import-status-error";
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = isEs ? "Parsear con Claude" : "Parse with Claude";
      }
    });
  }

  // ============================================================
  // FOLLOW-UP EMAIL — post-call notes → personalized follow-up
  // ============================================================

  function showFollowUpForm() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");

    const content = document.getElementById("briefme-content");
    const displayName = getDisplayName(currentProfile);
    const isEs = currentLanguage === "es";

    const absorbTitle = isEs
      ? "Lo que vale la pena recordar para el próximo prospecto similar"
      : "What's worth remembering for next similar prospect";
    const absorbSub = isEs
      ? "Opcional. Klosr guarda estas 1-2 líneas y las reutiliza cuando aparezca un prospecto parecido."
      : "Optional. Klosr saves these 1-2 lines and surfaces them the next time a similar prospect shows up.";
    const absorbPlaceholder = isEs
      ? "p. ej. Los VPs de ingeniería de Serie B responden al marco de maker time, no al de productividad."
      : "e.g. Series-B VPs of engineering respond to the maker-time frame, not a productivity pitch.";

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${t("followup_title")}</div>
          <div class="briefme-quest-subtitle">${t("followup_subtitle")} <strong>${escapeHtml(displayName)}</strong></div>
        </div>
        <form class="briefme-quest-form" id="briefme-followup-form">
          <label class="briefme-quest-label" for="briefme-followup-outcome">${t("followup_outcome_label")}</label>
          <input
            type="text"
            id="briefme-followup-outcome"
            class="briefme-quest-input"
            placeholder="${t("followup_outcome_placeholder")}"
            autocomplete="off"
            required
          />

          <label class="briefme-quest-label" for="briefme-followup-points">${t("followup_points_label")}</label>
          <textarea
            id="briefme-followup-points"
            class="briefme-quest-textarea"
            placeholder="${t("followup_points_placeholder")}"
            rows="3"
          ></textarea>

          <label class="briefme-quest-label" for="briefme-followup-next">${t("followup_next_label")}</label>
          <textarea
            id="briefme-followup-next"
            class="briefme-quest-textarea"
            placeholder="${t("followup_next_placeholder")}"
            rows="2"
          ></textarea>

          <div class="briefme-quest-section-label">${absorbTitle}</div>
          <div class="briefme-quest-hint">${absorbSub}</div>
          <textarea
            id="briefme-followup-absorb"
            class="briefme-quest-textarea"
            placeholder="${absorbPlaceholder}"
            rows="2"
          ></textarea>

          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-followup-back">${t("followup_back")}</button>
            <button type="submit" class="briefme-quest-submit">${t("followup_submit")}</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById("briefme-followup-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      if (currentBrief) {
        renderBrief(currentBrief, currentMode);
      } else {
        showModePicker();
      }
    });

    document.getElementById("briefme-followup-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const outcome = document.getElementById("briefme-followup-outcome").value.trim();
      const points = document.getElementById("briefme-followup-points").value.trim();
      const nextSteps = document.getElementById("briefme-followup-next").value.trim();
      const absorb = document.getElementById("briefme-followup-absorb").value.trim();

      // Absorb the notes + any marked insights so a future similar prospect
      // gets the benefit. Fails open — never blocks the follow-up email.
      const raw = [outcome, points, nextSteps].filter(Boolean).join("\n");
      if (raw) {
        recordCallNotes(currentProfile, raw, absorb).catch(() => {});
      }

      sidebar.classList.remove("briefme-picker-view");
      generateFollowUpEmail(outcome, points, nextSteps);
    });
  }

  async function generateFollowUpEmail(outcome, points, nextSteps) {
    const displayName = getDisplayName(currentProfile);
    const isEs = currentLanguage === "es";
    const senderName = (currentSender && currentSender.name) ? currentSender.name : (isEs ? "[Tu nombre]" : "[Your name]");

    const prompt = isEs
      ? `Acabo de tener una llamada con ${displayName}. Escribe un email de seguimiento post-llamada.

CÓMO FUE: ${outcome || "(no especificado)"}
PUNTOS CLAVE DISCUTIDOS: ${points || "(no especificado)"}
PRÓXIMOS PASOS ACORDADOS: ${nextSteps || "(no especificado)"}

Reglas:
- 3-4 párrafos cortos MAX. Sé directo.
- Referencia algo ESPECÍFICO que discutimos en la llamada.
- Si hay próximos pasos, confirmalos claramente en el email.
- Cierra con un CTA claro (ej. "Te envío el caso de estudio esta tarde" o "¿confirmamos jueves a las 10?")
- Firma como ${senderName}.
- NO uses frases genéricas tipo "Fue un placer hablar contigo". Sé específico.
- Devuelve SOLO el email (asunto en la primera línea con "Asunto: ", luego línea en blanco, luego el cuerpo).`
      : `I just had a call with ${displayName}. Write a post-call follow-up email.

HOW IT WENT: ${outcome || "(not specified)"}
KEY POINTS DISCUSSED: ${points || "(not specified)"}
NEXT STEPS AGREED: ${nextSteps || "(not specified)"}

Rules:
- 3-4 short paragraphs MAX. Be direct.
- Reference something SPECIFIC we discussed on the call.
- If there are next steps, confirm them clearly in the email.
- End with a clear CTA (e.g. "I'll send the case study this afternoon" or "Shall we lock in Thursday at 10?")
- Sign off as ${senderName}.
- NO generic phrases like "It was great chatting." Be specific.
- Return ONLY the email (subject line first with "Subject: ", then blank line, then body).`;

    // Reuse the quick message flow — it'll show the result in a card with copy
    await sendQuickMessage(prompt);
  }

  // ============================================================
  // EMAIL FEATURE — generate, display, copy personalized outreach
  // ============================================================

  // Entry point: clicked the Email button on the brief view
  // ============================================================
  // 4-TOUCH SEQUENCE — day 1 email, day 4 DM, day 7 follow-up,
  // day 14 break-up / value drop. One Claude call returns all 4.
  // ============================================================
  async function handleSequenceClick() {
    logKlosrEvent("sequence_generated", { language: currentLanguage });
    // Gate the flow the same way email does — need sender info first.
    if (currentSender === null) await loadSenderFromStorage();
    if (!currentSender || !currentSender.name) {
      // Reuse the sender-form flow; after save, run the sequence.
      showSenderForm({ generateAfter: false });
      // The showSenderForm submit handler doesn't know about sequence mode,
      // so we bail here and tell the user to re-click after saving.
      // Simpler UX: show a quick toast-ish state in the content area.
      return;
    }
    await generateSequence();
  }

  async function generateSequence() {
    const content = document.getElementById("briefme-content");
    content.innerHTML = `
      <div class="briefme-loading">
        <div class="briefme-spinner"></div>
        <p>${currentLanguage === "es" ? "Escribiendo tu secuencia de 4 toques..." : "Writing your 4-touch sequence..."}</p>
        <p class="briefme-loading-sub">${currentLanguage === "es" ? "Día 1 email, día 4 DM, día 7 seguimiento, día 14 valor" : "Day 1 email, day 4 DM, day 7 follow-up, day 14 value"}</p>
      </div>
    `;

    try {
      const cp = companyProfile || {};
      const [voiceExamples, icpLearningsObj, objectionPlaybook, proofLibrary, relevantCallNotes, ninjaPearData] = await Promise.all([
        getVoiceExamples(),
        getICPLearnings(),
        getObjectionPlaybook(),
        getProofLibrary(),
        getRelevantCallNotes(currentProfile),
        waitForNinjaPear(currentProfile, 3000),
      ]);

      const richSender = {
        name: cp.yourName || (currentSender && currentSender.name) || "",
        role: cp.yourRole || (currentSender && currentSender.role) || "",
        company: cp.companyName || (currentSender && currentSender.company) || "",
        context: cp.whatYouSell || (currentSender && currentSender.context) || "",
        valueProp: cp.valueProp || "",
        icp: cp.icp || "",
        tone: cp.tone || "",
        proofPoints: cp.proofPoints || "",
        background: cp.background || "",
        calendlyUrl: cp.calendlyUrl || "",
        claudeMemoryRaw: cp.claudeMemoryRaw || "",
        voiceExamples: Array.isArray(voiceExamples) ? voiceExamples : [],
        icpLearnings: (icpLearningsObj && icpLearningsObj.icpSummary) || "",
        objectionPlaybook,
        proofLibrary,
        relevantCallNotes,
      };

      const res = await fetch(SEQUENCE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: currentProfile,
          mode: currentMode || "sales",
          brief: currentBrief || "",
          language: currentLanguage,
          sender: richSender,
          ninjaPearData,
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
      }

      const data = await res.json();
      if (!data || !Array.isArray(data.touches) || data.touches.length === 0) {
        throw new Error("empty sequence");
      }

      showSequenceResult(data.touches);
    } catch (err) {
      console.error("Klosr sequence error:", err);
      showApiErrorScreen(err.message || String(err), currentMode, currentProfile);
    }
  }

  // Render the 4-touch sequence as a timeline with copy buttons per touch.
  function showSequenceResult(touches) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";
    const displayName = getDisplayName(currentProfile);

    const channelLabel = (c) => {
      if (c === "linkedin_dm") return isEs ? "DM LinkedIn" : "LinkedIn DM";
      if (c === "email") return isEs ? "Email" : "Email";
      return c;
    };
    const channelIcon = (c) => c === "linkedin_dm"
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v16H4V4zm3.5 3.5h3v9h-3v-9zm0-2.5h3v-3h-3v3zm5 2.5h2.8v1.2c.4-.7 1.4-1.4 2.9-1.4 3 0 3.8 1.7 3.8 4v5.2h-3v-4.7c0-1.1-.2-2.5-1.9-2.5-1.7 0-2 1.3-2 2.4v4.8h-3v-9z"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`;

    const touchesHtml = touches.map((t, i) => {
      const daySuffix = isEs ? `día ${t.day}` : `day ${t.day}`;
      const bodyHtml = escapeHtml(t.body || "").replace(/\n/g, "<br>");
      const subjectRow = t.subject
        ? `<div class="briefme-seq-subject-row">
             <div class="briefme-seq-subject-label">${isEs ? "Asunto" : "Subject"}</div>
             <div class="briefme-seq-subject">${escapeHtml(t.subject)}</div>
             <button class="briefme-seq-mini-copy" data-copy-idx="${i}-subject">${isEs ? "Copiar" : "Copy"}</button>
           </div>`
        : "";
      return `
        <div class="briefme-seq-touch" data-idx="${i}">
          <div class="briefme-seq-touch-head">
            <div class="briefme-seq-day">${daySuffix}</div>
            <div class="briefme-seq-channel">${channelIcon(t.channel)} <span>${channelLabel(t.channel)}</span></div>
          </div>
          ${subjectRow}
          <div class="briefme-seq-body" id="briefme-seq-body-${i}" contenteditable="true" spellcheck="true">${bodyHtml}</div>
          <div class="briefme-seq-actions">
            <button class="briefme-seq-copy" data-copy-idx="${i}-full">${isEs ? "Copiar este toque" : "Copy this touch"}</button>
          </div>
        </div>
      `;
    }).join("");

    content.innerHTML = `
      <div class="briefme-seq-view">
        <div class="briefme-seq-header">
          <div class="briefme-seq-title">${isEs ? "Secuencia 4 toques" : "4-touch sequence"}</div>
          <div class="briefme-seq-sub">${isEs ? "Para" : "For"} <strong>${escapeHtml(displayName)}</strong></div>
        </div>
        <div class="briefme-seq-timeline">${touchesHtml}</div>
        <div class="briefme-seq-footer">
          <button class="briefme-email-link" id="briefme-seq-back">← ${isEs ? "Volver" : "Back"}</button>
          <button class="briefme-copy-btn" id="briefme-seq-copy-all">${isEs ? "Copiar toda la secuencia" : "Copy full sequence"}</button>
        </div>
      </div>
    `;

    // Per-touch copy
    content.querySelectorAll(".briefme-seq-mini-copy, .briefme-seq-copy").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const raw = e.currentTarget.dataset.copyIdx || "";
        const [idxStr, kind] = raw.split("-");
        const idx = Number(idxStr);
        const t = touches[idx];
        if (!t) return;
        let text = "";
        if (kind === "subject") {
          text = t.subject || "";
        } else {
          // Full touch — pull the LIVE edited body so user tweaks are honoured.
          const liveBody = (document.getElementById(`briefme-seq-body-${idx}`) || {}).innerText || t.body;
          const head = t.subject ? `Subject: ${t.subject}\n\n` : "";
          text = head + liveBody;
        }
        navigator.clipboard.writeText(text).then(() => {
          const orig = e.currentTarget.textContent;
          e.currentTarget.textContent = isEs ? "¡Copiado!" : "Copied!";
          setTimeout(() => { e.currentTarget.textContent = orig; }, 1200);
          // Voice learning: record diffs on the day 1 touch only (that's the
          // "main" email most users will edit most).
          if (idx === 0 && t.body) {
            const live = (document.getElementById(`briefme-seq-body-${idx}`) || {}).innerText || "";
            if (live && live !== t.body) recordVoiceDiff(t.body, live).catch(() => {});
          }
        });
      });
    });

    // Copy-all
    document.getElementById("briefme-seq-copy-all").addEventListener("click", (e) => {
      const blob = touches.map((t, i) => {
        const live = (document.getElementById(`briefme-seq-body-${i}`) || {}).innerText || t.body;
        const chan = t.channel === "linkedin_dm" ? "LinkedIn DM" : "Email";
        const head = `--- DAY ${t.day} · ${chan} ---`;
        const subj = t.subject ? `Subject: ${t.subject}\n` : "";
        return `${head}\n${subj}${live}`;
      }).join("\n\n");
      navigator.clipboard.writeText(blob).then(() => {
        const btn = e.currentTarget;
        const orig = btn.textContent;
        btn.textContent = isEs ? "¡Secuencia copiada!" : "Sequence copied!";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      });
    });

    document.getElementById("briefme-seq-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      if (currentBrief) renderBrief(currentBrief, currentMode);
      else showModePicker();
    });
  }

  // ============================================================
  // REPLY HANDLER — paste a reply, get classification + draft
  // ============================================================
  // CONNECTION-DEGREE ENRICHMENT
  //
  // SerpApi gives us ICP-matched profile URLs but no connection-graph
  // signal — we don't know if a lead is a 2nd-degree connection with 20
  // mutuals or a random stranger in India. Warm intros beat cold outreach
  // 3-5x on reply rate, so we enrich each lead client-side by fetching
  // the profile page inside the user's own LinkedIn session and parsing
  // the embedded JSON for {degree, mutuals}.
  //
  // Why client-side, not server-side: LinkedIn's connection graph is
  // session-scoped — whether X is a 2nd-degree is a fact about THIS user,
  // not a public fact. The backend has no way to know. The content
  // script runs on linkedin.com and Chrome attaches the user's cookies
  // on fetch, so we get the authenticated view for free.
  //
  // Reliability notes:
  //  - Normalize country subdomains (uk.linkedin.com → www.linkedin.com)
  //    so fetch stays same-origin (host_permissions only cover www).
  //  - Throttle: max 3 concurrent, 300ms between batches — LinkedIn
  //    rate-limits aggressive profile crawling.
  //  - Cache hits for 7 days (degrees change rarely).
  //  - Fail open: any failure returns {degree: null, mutuals: null} and
  //    the lead still renders without a degree badge.
  // ============================================================

  const CONN_CACHE_KEY = "klosr_conn_cache";
  const CONN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // Normalize any linkedin.com/in/ URL to www.linkedin.com. LinkedIn serves
  // the same profile content from www regardless of which country subdomain
  // (uk, in, se, ...) Google surfaced. Required so our fetch stays same-origin
  // with the content-script host (www.linkedin.com).
  function normalizeLinkedInUrl(url) {
    if (!url || typeof url !== "string") return url;
    return url.replace(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\//i, "https://www.linkedin.com/");
  }

  // Pull the LinkedIn public ID (e.g. "john-smith-1234") from a profile URL.
  // Used purely as a stable cache key (URLs vary by subdomain, query string).
  function linkedInPublicId(url) {
    if (!url) return "";
    const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : "";
  }

  async function getConnCache() {
    return (await _storageGet(CONN_CACHE_KEY)) || {};
  }
  async function setConnCache(cache) {
    await _storageSet(CONN_CACHE_KEY, cache);
  }

  // Parse degree + mutual count out of a profile's raw HTML. LinkedIn
  // embeds its server-rendered state as JSON in <code> tags. Fields we
  // look for (in priority order, most reliable first):
  //   - `"distance":{"value":"DISTANCE_2"}`      → connection degree
  //   - `"N mutual connection"` / `"N mutuals"`  → shared connection count
  //
  // Returns { degree: 1|2|3|null|"OUT_OF_NETWORK", mutuals: number|null }.
  // Any parse failure returns nulls — caller treats as "unknown".
  function parseConnectionFromHtml(html) {
    if (!html || typeof html !== "string") return { degree: null, mutuals: null };

    // Cheap session-expired detection: the login/wall pages are tiny and
    // contain no distance markers. If we see no distance at all, bail early.
    const distanceMatch = html.match(/"distance"\s*:\s*\{\s*"value"\s*:\s*"DISTANCE_(\d)"/);
    const oonMatch = html.match(/"distance"\s*:\s*\{\s*"value"\s*:\s*"OUT_OF_NETWORK"/);
    const selfMatch = html.match(/"distance"\s*:\s*\{\s*"value"\s*:\s*"SELF"/);

    let degree = null;
    if (selfMatch) degree = 0;                    // viewing your own profile
    else if (distanceMatch) degree = parseInt(distanceMatch[1], 10);
    else if (oonMatch) degree = "OUT_OF_NETWORK";

    // Mutual connections — LinkedIn surfaces this as text in multiple places:
    //   "12 mutual connections"
    //   "And 8 other mutual connections"
    //   "\"totalCount\":12,\"...mutual"
    // The simplest robust approach: the single highest "N mutual" match.
    let mutuals = null;
    const mutualsRx = /(\d{1,4})\s+mutual\s+connection/gi;
    let best = -1;
    let m;
    while ((m = mutualsRx.exec(html)) !== null) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > best) best = n;
    }
    if (best >= 0) mutuals = best;

    // Fallback: "And N other" phrasing used when LinkedIn shows 2-3 mutual
    // faces plus a count of the rest.
    if (mutuals == null) {
      const other = html.match(/[Aa]nd\s+(\d{1,4})\s+other\s+mutual/);
      if (other) mutuals = parseInt(other[1], 10) + 2;   // +2 for the ones shown
    }

    return { degree, mutuals };
  }

  // Enrich a single lead by fetching its profile HTML through the user's
  // authenticated LinkedIn session. Cached for 7 days.
  async function enrichLeadConnection(profileUrl) {
    const pid = linkedInPublicId(profileUrl);
    if (!pid) return { degree: null, mutuals: null, cached: false };

    const cache = await getConnCache();
    const now = Date.now();
    if (cache[pid] && (now - cache[pid].t) < CONN_CACHE_TTL_MS) {
      return { ...cache[pid], cached: true };
    }

    const normalizedUrl = normalizeLinkedInUrl(profileUrl);
    try {
      const res = await fetch(normalizedUrl, {
        method: "GET",
        credentials: "include",
        headers: {
          // Helps LinkedIn serve the desktop markup with embedded state.
          "Accept": "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) return { degree: null, mutuals: null, cached: false };
      const html = await res.text();
      const parsed = parseConnectionFromHtml(html);

      // Persist even null-result fetches — caching "unknown" for 7 days
      // prevents us re-hammering LinkedIn on every refresh for a lead
      // whose profile is auth-walled or was taken down.
      cache[pid] = { degree: parsed.degree, mutuals: parsed.mutuals, t: now };
      await setConnCache(cache);

      return { ...parsed, cached: false };
    } catch (e) {
      return { degree: null, mutuals: null, cached: false };
    }
  }

  // Score a lead for warm-first sorting. Higher = closer / easier intro.
  //   1st-degree connected      → huge boost (already in network)
  //   2nd-degree + mutuals      → 500 + 10 × mutuals
  //   2nd-degree no mutuals     → 400
  //   3rd-degree                → 150
  //   out-of-network            → 10
  //   unknown (enrich failed)   → 0 (sorts to bottom)
  function warmScore(lead) {
    const d = lead._degree;
    const m = typeof lead._mutuals === "number" ? lead._mutuals : 0;
    if (d === 1) return 10000 + m;
    if (d === 2) return 500 + m * 10;
    if (d === 3) return 150 + m * 2;
    if (d === "OUT_OF_NETWORK") return 10;
    return 0;
  }

  // Render the degree pill for a lead. Visible states:
  //   "⌛"          — enrichment pending
  //   "🟢 1st"      — already connected
  //   "🟢 2nd · 12" — 2nd-degree with mutual count
  //   "🟡 3rd"      — 3rd-degree
  //   "— "          — out-of-network or unknown (after enrichment resolved)
  function degreeBadgeHtml(lead, isEs) {
    if (!lead._enriched) {
      return `<span class="briefme-warm-degree briefme-warm-degree-pending" title="${isEs ? "Comprobando conexiones..." : "Checking connections..."}">⌛</span>`;
    }
    const d = lead._degree;
    const m = lead._mutuals;
    const mutText = typeof m === "number" && m > 0 ? ` · ${m}` : "";
    if (d === 0) {
      return `<span class="briefme-warm-degree briefme-warm-degree-self" title="${isEs ? "Tu propio perfil" : "Your own profile"}">${isEs ? "Tú" : "You"}</span>`;
    }
    if (d === 1) {
      return `<span class="briefme-warm-degree briefme-warm-degree-1" title="${isEs ? "Ya conectado" : "Already connected"}">🟢 1st${mutText}</span>`;
    }
    if (d === 2) {
      return `<span class="briefme-warm-degree briefme-warm-degree-2" title="${isEs ? "Conexión de 2º grado" : "2nd-degree connection"}${typeof m === "number" ? (isEs ? ` · ${m} conexiones en común` : ` · ${m} mutual connections`) : ""}">🟢 2nd${mutText}</span>`;
    }
    if (d === 3) {
      return `<span class="briefme-warm-degree briefme-warm-degree-3" title="${isEs ? "3º grado" : "3rd-degree"}">🟡 3rd${mutText}</span>`;
    }
    if (d === "OUT_OF_NETWORK") {
      return `<span class="briefme-warm-degree briefme-warm-degree-oon" title="${isEs ? "Fuera de tu red" : "Out of network"}">⚪ ${isEs ? "fuera" : "cold"}</span>`;
    }
    return `<span class="briefme-warm-degree briefme-warm-degree-unknown" title="${isEs ? "Desconocido" : "Unknown"}">—</span>`;
  }

  // ============================================================
  // LINKEDIN-NATIVE PEOPLE SEARCH (warm-first discovery)
  //
  // The problem with SerpApi-only discovery: Google's LinkedIn index has
  // zero knowledge of the founder's network. ~95% of results are random
  // out-of-network profiles. Per-lead enrichment correctly reports "cold"
  // because they ARE cold — fixing the parse doesn't help.
  //
  // The fix: drive discovery through LinkedIn's own people search with
  // the network filter set to 1st + 2nd degree (network=F,S). Every
  // result LinkedIn returns is by construction in the user's network,
  // and the results carry degree + mutual-connection data natively.
  //
  // We fetch the authenticated HTML of the people-search URL inside the
  // user's session, then parse embedded JSON blobs (<code id="bpr-guid-…">
  // that LinkedIn server-renders for fast hydration). Each entity includes
  // publicIdentifier, name, headline, distance, and insight text like
  // "John Smith and 12 other mutual connections".
  //
  // Failure modes (all silent; leads fall back to SerpApi-discovered cold
  // leads so the tab is never empty):
  //   - Not logged into LinkedIn in this browser: empty blob, 0 results
  //   - LinkedIn served a bot-check page: 0 results
  //   - Embedded JSON structure changed: log to console, 0 results
  // ============================================================

  // Strip the `site:linkedin.com/in/` prefix from a server-generated Google
  // query so the remaining keywords can be used directly in LinkedIn's
  // people search (which doesn't need the site: operator — it only indexes
  // people anyway). Boolean OR, quotes, and plain keywords all carry over.
  function googleQueryToLinkedInKeywords(q) {
    if (!q || typeof q !== "string") return "";
    return q
      .replace(/site:linkedin\.com\/in\/?/gi, "")
      .replace(/\blinkedin\.com\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // Fetch LinkedIn's authenticated people-search HTML for a given keyword
  // string, filtered to 1st + 2nd degree (network=F,S). Returns an array
  // of canonical leads with {_degree, _mutuals} already populated.
  //
  // Hedge: Also accepts "F,S,O" (incl. out-of-network) if the caller wants
  // to broaden. We default to F,S because the whole point here is warm.
  async function searchLinkedInPeopleInNetwork(keywords, opts = {}) {
    const { limit = 15, includeOutOfNetwork = false, start = 0 } = opts;
    if (!keywords || !keywords.trim()) return [];

    // network=["F","S"] = 1st + 2nd degree. Adding "O" broadens to
    // out-of-network. LinkedIn expects JSON-encoded URL parameter.
    // `page` offsets results — LinkedIn returns ~10 per page.
    const netValues = includeOutOfNetwork ? '["F","S","O"]' : '["F","S"]';
    const pageNum = Math.max(1, Math.floor(start / 10) + 1);
    const url = `https://www.linkedin.com/search/results/people/`
      + `?keywords=${encodeURIComponent(keywords.trim())}`
      + `&network=${encodeURIComponent(netValues)}`
      + `&origin=GLOBAL_SEARCH_HEADER`
      + (pageNum > 1 ? `&page=${pageNum}` : "");

    try {
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "text/html,application/xhtml+xml" },
      });
      if (!res.ok) {
        console.warn(`[Klosr] LinkedIn search HTTP ${res.status} for keywords:`, keywords);
        return [];
      }
      const html = await res.text();
      const parsed = parseLinkedInSearchHtml(html, limit);
      console.log(`[Klosr] LinkedIn search "${keywords.slice(0, 60)}" → ${parsed.length} in-network results`);
      return parsed;
    } catch (e) {
      console.warn("[Klosr] LinkedIn search fetch failed:", e && e.message);
      return [];
    }
  }

  // Parse the HTML of a LinkedIn people-search response. LinkedIn embeds
  // its hydration state as JSON inside <code id="bpr-guid-…"> blocks.
  // The relevant entities are EntityResultViewModel + MiniProfile pairs
  // in the blob's `included` array.
  //
  // We pair them up by entityUrn. Each MiniProfile has publicIdentifier +
  // name. Each EntityResultViewModel has distance + insightsResolutionResults
  // (the "N mutual connections" text). The regex-fallback path handles
  // cases where JSON.parse fails on a partially-rendered blob.
  function parseLinkedInSearchHtml(html, maxResults) {
    if (!html || html.length < 500) return [];

    // Extract all <code id="bpr-guid-..."> JSON blobs.
    const blobs = [];
    const blobRx = /<code[^>]*id="bpr-guid-[^"]*"[^>]*>([\s\S]*?)<\/code>/gi;
    let m;
    while ((m = blobRx.exec(html)) !== null) {
      const raw = m[1].trim();
      if (!raw || !raw.startsWith("{")) continue;
      try {
        // LinkedIn HTML-escapes quotes inside these blobs as &quot; etc.
        // JSON.parse handles the escaping natively because the content
        // is emitted as valid JSON (LinkedIn escapes via &#..; only for
        // display, not structure).
        const decoded = raw
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
        blobs.push(JSON.parse(decoded));
      } catch (e) { /* skip malformed blob */ }
    }

    if (blobs.length === 0) {
      console.warn("[Klosr] LinkedIn search: no parseable JSON blobs in HTML");
      return [];
    }

    // Walk blobs for `included` arrays containing miniProfile + entity
    // result entries. LinkedIn keeps schema types in `$type` or `type`.
    const profilesById = {};      // entityUrn → {publicId, firstName, lastName, occupation}
    const entitiesById = {};      // entityUrn → {distance, mutualText}

    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }

      const t = node["$type"] || node["type"] || "";

      // MiniProfile (carries name + public ID + occupation)
      if ((typeof t === "string" && /MiniProfile/i.test(t)) || node.publicIdentifier) {
        const urn = node.entityUrn || node.objectUrn || "";
        if (urn && node.publicIdentifier) {
          profilesById[urn] = {
            publicId: node.publicIdentifier,
            firstName: node.firstName || "",
            lastName: node.lastName || "",
            occupation: node.occupation || "",
            urn,
          };
        }
      }

      // Entity result row (carries distance + mutuals text)
      if (typeof t === "string" && /EntityResult|SearchProfile|SearchHit/i.test(t)) {
        const urn = node.entityUrn || node.objectUrn || node.targetUrn ||
                    (node.actor && node.actor.urn) || "";
        const distance = (node.memberDistance && node.memberDistance.value) ||
                         (node.distance && node.distance.value) || "";
        // Mutuals text lives under insightsResolutionResults[*].text.text on
        // modern LinkedIn. Walk down to grab it.
        let mutualText = "";
        if (Array.isArray(node.insightsResolutionResults)) {
          for (const ins of node.insightsResolutionResults) {
            const txt = ins && ins.text && (ins.text.text || ins.text) ||
                        (ins && ins.simpleInsight && ins.simpleInsight.text && ins.simpleInsight.text.text) ||
                        "";
            if (txt && /mutual/i.test(String(txt))) { mutualText = String(txt); break; }
          }
        }
        if (urn) entitiesById[urn] = { distance, mutualText };
      }

      // Keep recursing into nested arrays/objects
      for (const k of Object.keys(node)) {
        if (k === "$type" || k === "type") continue;
        visit(node[k]);
      }
    };

    blobs.forEach(visit);

    // Pair profiles with their entity metadata. If entity has no match,
    // we still surface the profile (degree = null, mutuals = null).
    const results = [];
    const seen = new Set();
    for (const urn of Object.keys(profilesById)) {
      const p = profilesById[urn];
      if (!p.publicId || seen.has(p.publicId)) continue;
      seen.add(p.publicId);

      const e = entitiesById[urn] || {};
      const degree = e.distance ? degreeStringToNumber(e.distance) : null;
      const { count: mutuals, names: mutualNames } = parseMutuals(e.mutualText);

      const name = `${p.firstName} ${p.lastName}`.trim() || p.occupation || "(unknown)";
      const profileUrl = `https://www.linkedin.com/in/${p.publicId}`;

      results.push({
        name,
        profileUrl,
        company: "",                     // not in search results; enriched on click
        title: p.occupation || "",
        signalText: p.occupation ? `ICP match: ${p.occupation}` : "ICP match — matches your ideal customer profile",
        signalType: "icp_match",
        signalDate: "",
        signalLink: profileUrl,
        score: null,
        source: "linkedin_native",
        _pid: p.publicId.toLowerCase(),
        _degree: degree,
        _mutuals: mutuals,
        _mutualNames: mutualNames,      // NEW: named mutuals for warm-intro ops
        _enriched: true,                // no need for the slow per-profile pass
      });
      if (results.length >= maxResults) break;
    }

    return results;
  }

  function degreeStringToNumber(value) {
    const v = String(value || "").toUpperCase();
    if (v === "DISTANCE_1" || v === "F") return 1;
    if (v === "DISTANCE_2" || v === "S") return 2;
    if (v === "DISTANCE_3" || v === "O") return 3;
    if (v === "OUT_OF_NETWORK") return "OUT_OF_NETWORK";
    if (v === "SELF") return 0;
    return null;
  }

  // Parse LinkedIn's mutual-connections insight text into {count, names}.
  // Example inputs:
  //   "Sarah Chen, Marcus Ong and 12 other mutual connections"  → {12+2, [Sarah, Marcus]}
  //   "John Smith and 8 other mutual connections"               → {9, [John]}
  //   "14 mutual connections"                                   → {14, []}
  //   "John Smith is a mutual connection"                       → {1, [John]}
  // Names are a massive prospecting unlock — they tell the founder WHO to
  // ask for the warm intro. LinkedIn only renders 1-2 names by default;
  // that's plenty to name-drop in a connection note.
  function parseMutuals(text) {
    if (!text) return { count: null, names: [] };
    const str = String(text);

    // Count extraction — same rules as before.
    let count = null;
    const other = str.match(/and\s+(\d{1,4})\s+other\s+mutual/i);
    if (other) count = parseInt(other[1], 10) + 1;   // +1 for the named one
    else {
      const m = str.match(/(\d{1,4})\s+mutual\s+connection/i);
      if (m) count = parseInt(m[1], 10);
      else if (/is\s+a\s+mutual/i.test(str)) count = 1;
    }

    // Name extraction — the names appear before "and N other mutual" or
    // "is a mutual". Split what remains by comma.
    const namesSegment = str
      .replace(/\s+and\s+\d+\s+other\s+mutual.*$/i, "")
      .replace(/\s+is\s+a\s+mutual.*$/i, "")
      .trim();
    const names = [];
    if (namesSegment && !/^\d+\s+mutual/i.test(namesSegment)) {
      for (const part of namesSegment.split(",")) {
        const n = part.trim();
        // Basic heuristic: starts with capital, 2-5 words, reasonable length.
        if (n && /^[A-Z]/.test(n) && n.length >= 2 && n.length <= 60) {
          names.push(n);
          if (names.length >= 3) break;
        }
      }
    }
    // If we have a count and exactly one name also matches "and N other",
    // we've already accounted for it in +1. Cap count to sane max.
    if (count !== null && count > 500) count = null;

    return { count, names };
  }

  // Back-compat alias — used by the older profile-enrichment pass.
  function parseMutualCount(text) { return parseMutuals(text).count; }

  // ============================================================
  // ============================================================
  // WARM LEADS — network-first LinkedIn prospects
  //
  // Discovery path (in priority order):
  //   1. LinkedIn-native people search with network=F,S filter — every
  //      result is already 1st or 2nd degree with real degree + mutual
  //      data baked into the response. Fast: no per-lead enrichment pass.
  //   2. SerpApi Google `site:linkedin.com/in/` fallback, only used if
  //      path (1) finds <3 in-network leads. Results go through the
  //      slower per-profile enrichment pass.
  //
  // Either way, the final list is sorted warmest-first (1st-degree >
  // 2nd-degree by mutual count > 3rd > out-of-network > unknown).
  // ============================================================
  // Read the prospect's headline directly from the LinkedIn DOM.
  // Multi-strategy because LinkedIn ships layout changes every few months
  // and locale variants (Spanish / German / etc.) sometimes serve subtly
  // different markup. We try, in order:
  //   1. Known-good CSS selectors
  //   2. Walk the profile top-card container looking for headline-shaped lines
  //   3. Parse document.title (LinkedIn tabs always encode "Name - Role - Company")
  // Returns "" only if all three strategies come up empty.
  function readLiveProfileHeadline() {
    // Strategy 1: precise selectors
    const precise = [
      ".text-body-medium.break-words",
      ".pv-text-details__left-panel .text-body-medium",
      "[data-test-profile-subtitle]",
      "main section .text-body-medium:not(.t-black--light)",
      ".pv-top-card--list .pv-top-card--list-bullet",
      "main h1 + div .text-body-medium",
    ];
    for (const sel of precise) {
      try {
        const el = document.querySelector(sel);
        const text = el && (el.innerText || el.textContent || "").trim();
        if (text && text.length >= 6 && text.length <= 400 && !/^\d+°$/.test(text)) {
          return text;
        }
      } catch {/* invalid selector on some browsers, skip */}
    }

    // Strategy 2: walk from the h1 into its profile container and find the
    // first non-UI line that looks like a role/headline.
    const h1 = document.querySelector("main h1, section h1, h1");
    if (h1) {
      const container = h1.closest("section") || h1.closest(".pv-top-card") ||
                        (h1.parentElement && h1.parentElement.parentElement) ||
                        h1.parentElement;
      if (container) {
        const nameText = (h1.innerText || h1.textContent || "").trim();
        const fullText = (container.innerText || "").trim();
        if (fullText) {
          const lines = fullText.split("\n").map(s => s.trim()).filter(Boolean);
          // UI strings to skip (EN + ES). Add more locales as needed.
          const isUiString = (s) => /^(Ver más|More|Mensaje|Message|Connect|Conectar|Send|Enviar|Follow|Seguir|Pendiente|Pending|Más|Añadir|Add|Saludar|Greet|\d+(er|°|st|nd|rd|th)\b|·|Información|Information|Ubicación|Location|Web|Site|Open to|Abierto|Providing services|Premium|Verified|Verificado)/i.test(s);

          // First pass: prefer lines with headline markers (comma, pipe, "at")
          for (const line of lines) {
            if (line === nameText) continue;
            if (line.length < 8 || line.length > 400) continue;
            if (isUiString(line)) continue;
            if (/[,|@]|\bat\b/i.test(line)) return line;
          }
          // Second pass: any non-trivial, non-UI line after the name
          for (const line of lines) {
            if (line === nameText) continue;
            if (line.length < 15 || line.length > 400) continue;
            if (isUiString(line)) continue;
            return line;
          }
        }
      }
    }

    // Strategy 3: document.title — LinkedIn always encodes the prospect's
    // role/company into the tab title. Format varies:
    //   "Jack Lineker - Co-founder at socialed | LinkedIn"
    //   "Jack Lineker | LinkedIn"  (empty after strip — not useful)
    //   "(1) Jack Lineker | LinkedIn"  (notification count prefix)
    const rawTitle = (document.title || "").trim();
    if (rawTitle) {
      let cleaned = rawTitle
        .replace(/\s*\|\s*LinkedIn\s*$/i, "")
        .replace(/^\(\d+\)\s*/, "")    // strip notification "(N)" prefix
        .trim();
      // Split on the first " - " / " – " — the bit after it is role+company.
      const match = cleaned.match(/^[^-–—]+[-–—]\s*(.+)$/);
      if (match && match[1]) {
        const rest = match[1].trim();
        if (rest.length >= 6 && rest.length <= 400) return rest;
      }
    }

    return "";
  }

  // ============================================================
  // DEEP RESEARCH — NinjaPear-powered company intel on the current
  // prospect's employer. Fans out to 5 endpoints in parallel:
  //   • /api/company-details      → executives, headcount, founded, specialties
  //   • /api/company-funding      → rounds, investors, total raised
  //   • /api/company-competitors  → alternatives, battlecard angles
  //   • /api/company-customers    → who's already buying from them
  //   • /api/similar-people       → warm prospects like the current one
  // Each result renders in its own collapsible section. Credit balance
  // shown in the header so the founder can track spend.
  // ============================================================
  async function showDeepResearchView() {
    logKlosrEvent("company_intel_opened", { language: currentLanguage });
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";

    if (!currentProfile) {
      content.innerHTML = `<div class="briefme-warm-empty">${isEs ? "Abre un perfil de LinkedIn primero." : "Open a LinkedIn profile first."}</div>`;
      return;
    }

    // Derive the company's domain — NinjaPear endpoints all need `website`.
    // Resolution chain:
    //   1. currentProfile.companyDomain  — set if scraper caught it
    //   2. currentProfile.currentCompanyWebsite — alt scrape path
    //   3. Claude Haiku via /api/intel "resolve-domain" using the company
    //      name (LinkedIn doesn't expose websites on a profile page).
    // If (3) fails too, we show "No domain" and the 5 cards stay empty.
    let domain = (currentProfile.companyDomain || currentProfile.currentCompanyWebsite || "")
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];

    const displayName = getDisplayName(currentProfile);

    // Headline/company resolution:
    // ALWAYS read the live DOM first — currentProfile can be stale (user
    // navigated between profiles, scraper ran early, etc.). The live DOM is
    // the source of truth for what the user is looking at RIGHT NOW.
    // Fall through to currentProfile fields only if live DOM is empty.
    let companyLabel = currentProfile.currentCompany || currentProfile.company || "";
    let headline = readLiveProfileHeadline() ||
                   currentProfile.headline ||
                   currentProfile.currentRole ||
                   "";

    // Diagnostic logging — helps debug cases where ALL strategies fail.
    // User can open DevTools → Console → share the output if needed.
    console.log("[Klosr research] resolution inputs:", {
      companyLabel,
      headline,
      profileHeadline: currentProfile.headline,
      currentRole: currentProfile.currentRole,
      currentCompany: currentProfile.currentCompany,
      h1: document.querySelector("h1") && document.querySelector("h1").textContent,
      title: document.title,
    });

    // We can resolve as long as we have SOMETHING to work with — company,
    // headline, or role. Only truly empty profiles get the red error.
    const needsResolve = !domain && (!!companyLabel || !!headline);

    content.innerHTML = `
      <div class="briefme-research-view">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">🔬 ${isEs ? "Intel empresa" : "Company intel"}</div>
          <div class="briefme-quest-subtitle">${isEs ? "Datos verificados vía NinjaPear" : "Verified data via NinjaPear"} · <span id="briefme-research-credits">${isEs ? "cargando créditos…" : "loading credits…"}</span></div>
        </div>

        <div class="briefme-research-target">
          ${currentProfile.companyLogoDataUrl ? `<img class="briefme-research-logo" src="${currentProfile.companyLogoDataUrl}" alt="" />` : ""}
          <div class="briefme-research-target-text">
            <div class="briefme-research-target-name" id="briefme-research-company-name">${escapeHtml(companyLabel || displayName)}</div>
            <div class="briefme-research-target-domain" id="briefme-research-domain-line">
              ${domain
                ? escapeHtml(domain)
                : needsResolve
                  ? `<span class="briefme-research-resolving">${isEs ? "Resolviendo empresa y dominio…" : "Resolving company and domain…"}</span>`
                  : `<span class="briefme-research-no-domain">${isEs ? "Sin datos de empresa — abre un perfil con rol visible." : "No company data — open a profile with a visible role."}</span>`}
            </div>
          </div>
        </div>

        <div class="briefme-research-grid">
          <div class="briefme-research-card" id="briefme-research-details">
            <div class="briefme-research-card-head">📋 ${isEs ? "Detalles de la empresa" : "Company details"}</div>
            <div class="briefme-research-card-body">${isEs ? "Cargando..." : "Loading..."}</div>
          </div>
          <div class="briefme-research-card" id="briefme-research-funding">
            <div class="briefme-research-card-head">💰 ${isEs ? "Historial de financiación" : "Funding history"}</div>
            <div class="briefme-research-card-body">${isEs ? "Cargando..." : "Loading..."}</div>
          </div>
          <div class="briefme-research-card" id="briefme-research-competitors">
            <div class="briefme-research-card-head">⚔️ ${isEs ? "Competidores" : "Competitors"}</div>
            <div class="briefme-research-card-body">${isEs ? "Cargando..." : "Loading..."}</div>
          </div>
          <div class="briefme-research-card" id="briefme-research-customers">
            <div class="briefme-research-card-head">🤝 ${isEs ? "Sus clientes" : "Their customers"}</div>
            <div class="briefme-research-card-body">${isEs ? "Cargando..." : "Loading..."}</div>
          </div>
          <div class="briefme-research-card briefme-research-card-intent" id="briefme-research-intent">
            <div class="briefme-research-card-head">🔥 ${isEs ? "Señal de intención (Apollo)" : "Buying intent (Apollo)"}</div>
            <div class="briefme-research-card-body">${isEs ? "Cargando..." : "Loading..."}</div>
          </div>
          <div class="briefme-research-card" id="briefme-research-whynow">
            <div class="briefme-research-card-head">⚡ ${isEs ? "Por qué ahora" : "Why now"}</div>
            <div class="briefme-research-card-body">${isEs ? "Cargando..." : "Loading..."}</div>
          </div>
          <div class="briefme-research-card" id="briefme-research-similar">
            <div class="briefme-research-card-head">👥 ${isEs ? "Prospectos similares" : "Similar prospects"}</div>
            <div class="briefme-research-card-body">${isEs ? "Cargando..." : "Loading..."}</div>
          </div>
        </div>

        <div class="briefme-quest-actions">
          <button type="button" class="briefme-quest-back" id="briefme-research-back">${isEs ? "Volver" : "Back"}</button>
        </div>
      </div>
    `;

    document.getElementById("briefme-research-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    });

    // Free endpoint — show credits. Fire it independently, never blocks.
    callIntel("credit-balance").then(d => {
      const el = document.getElementById("briefme-research-credits");
      if (el && d && typeof d.balance === "number") {
        el.textContent = `${d.balance} ${isEs ? "créditos restantes" : "credits left"}`;
      } else if (el) {
        el.textContent = isEs ? "créditos no disponibles" : "credits unavailable";
      }
    });

    // If the scraper didn't capture a domain, ask Claude Haiku to resolve
    // both company name + domain from whatever we have (headline, role).
    // Usually succeeds within ~1-2s for any company Haiku has seen during
    // training. Cached onto currentProfile so subsequent opens skip the
    // round-trip.
    if (!domain && needsResolve) {
      const resolved = await callIntel("resolve-domain", {
        companyName: companyLabel,
        headline: headline,
        context: `LinkedIn profile: ${currentProfile.profileUrl || ""}. Person: ${displayName}.`,
      });
      if (resolved && resolved.domain) {
        domain = resolved.domain.toLowerCase();
        currentProfile.companyDomain = domain;   // cache for next open
        // If Claude also extracted a clean company name and the scraper
        // didn't have one, use that in the header.
        if (resolved.company && !companyLabel) {
          companyLabel = resolved.company;
          currentProfile.currentCompany = companyLabel;   // cache for other views too
          const nameEl = document.getElementById("briefme-research-company-name");
          if (nameEl) nameEl.textContent = companyLabel;
        }
        const domainLine = document.getElementById("briefme-research-domain-line");
        if (domainLine) domainLine.textContent = domain;
        // Now that we have a domain, fire the free logo fetch too.
        loadCompanyLogoInBackground(domain);
      } else {
        // Even if domain resolution failed, use Claude's extracted company
        // name if we got one — at least the user sees what we tried to look up.
        if (resolved && resolved.company && !companyLabel) {
          companyLabel = resolved.company;
          const nameEl = document.getElementById("briefme-research-company-name");
          if (nameEl) nameEl.textContent = companyLabel;
        }
        const domainLine = document.getElementById("briefme-research-domain-line");
        if (domainLine) {
          domainLine.innerHTML = `<span class="briefme-research-no-domain">${isEs ? "No se pudo resolver el dominio — introdúcelo manualmente en el perfil." : "Couldn't auto-resolve domain — set it manually on the profile."}</span>`;
        }
        // Mark each card as "skipped" so the user doesn't sit staring at
        // "Loading..." forever.
        document.querySelectorAll(".briefme-research-card .briefme-research-card-body").forEach(el => {
          el.innerHTML = `<div class="briefme-research-empty">${isEs ? "Se necesita el dominio de la empresa." : "Needs company domain."}</div>`;
        });
        return;
      }
    }

    if (!domain) {
      // No domain AND no company name — can't do anything.
      document.querySelectorAll(".briefme-research-card .briefme-research-card-body").forEach(el => {
        el.innerHTML = `<div class="briefme-research-empty">${isEs ? "Se necesita el dominio de la empresa." : "Needs company domain."}</div>`;
      });
      return;
    }

    // ─── Fire all 4 domain-scoped endpoints in parallel ─────────────────

    // 1. Company details
    callIntel("company-details", { domain, includeEmployeeCount: true }).then(data => {
      const target = document.querySelector("#briefme-research-details .briefme-research-card-body");
      if (!target) return;
      const c = data && data.company;
      if (!c) {
        target.innerHTML = `<div class="briefme-research-empty">${isEs ? "Sin datos." : "No data."}</div>`;
        return;
      }
      const execHtml = Array.isArray(c.executives) && c.executives.length
        ? `<div class="briefme-research-subhead">${isEs ? "Ejecutivos" : "Executives"}</div>
           <ul class="briefme-research-list">${c.executives.map(e =>
             `<li>${e.linkedin_url ? `<a href="${escapeHtml(e.linkedin_url)}" target="_blank" rel="noopener">${escapeHtml(e.name)}</a>` : escapeHtml(e.name)}${e.role ? ` · <span>${escapeHtml(e.role)}</span>` : ""}</li>`
           ).join("")}</ul>` : "";
      const spec = Array.isArray(c.specialties) && c.specialties.length
        ? `<div class="briefme-research-chips">${c.specialties.map(s => `<span>${escapeHtml(s)}</span>`).join("")}</div>` : "";
      target.innerHTML = `
        <div class="briefme-research-facts">
          ${c.industry ? `<div><strong>${isEs ? "Industria" : "Industry"}:</strong> ${escapeHtml(c.industry)}</div>` : ""}
          ${c.employee_count ? `<div><strong>${isEs ? "Empleados" : "Headcount"}:</strong> ${c.employee_count}</div>` : ""}
          ${c.founded_year ? `<div><strong>${isEs ? "Fundada" : "Founded"}:</strong> ${c.founded_year}</div>` : ""}
          ${c.hq && c.hq.city ? `<div><strong>HQ:</strong> ${escapeHtml(c.hq.city)}${c.hq.country ? ", " + escapeHtml(c.hq.country) : ""}</div>` : ""}
        </div>
        ${c.description ? `<div class="briefme-research-desc">${escapeHtml(c.description).slice(0, 400)}</div>` : ""}
        ${spec}
        ${execHtml}
      `;
    });

    // 2. Funding
    callIntel("company-funding", { domain }).then(data => {
      const target = document.querySelector("#briefme-research-funding .briefme-research-card-body");
      if (!target) return;
      const rounds = Array.isArray(data && data.rounds) ? data.rounds : [];
      if (rounds.length === 0) {
        target.innerHTML = `<div class="briefme-research-empty">${isEs ? "Sin datos de financiación." : "No funding data."}</div>`;
        return;
      }
      const total = data.totalRaisedUsd ? `$${Number(data.totalRaisedUsd).toLocaleString()}` : "";
      target.innerHTML = `
        ${total ? `<div class="briefme-research-facts"><div><strong>${isEs ? "Total recaudado" : "Total raised"}:</strong> ${total}</div></div>` : ""}
        <ul class="briefme-research-list">
          ${rounds.reverse().map(r => `
            <li>
              <strong>${escapeHtml(r.roundType || "Round")}</strong>
              ${r.date ? ` · ${escapeHtml(String(r.date).slice(0, 10))}` : ""}
              ${r.amount ? ` · ${escapeHtml(String(r.amount))}` : ""}
              ${r.investors && r.investors.length ? `<br/><span class="briefme-research-subtle">${r.investors.map(i => escapeHtml(i.name)).join(", ")}</span>` : ""}
            </li>
          `).join("")}
        </ul>
      `;
    });

    // 3. Competitors
    callIntel("company-competitors", { domain }).then(data => {
      const target = document.querySelector("#briefme-research-competitors .briefme-research-card-body");
      if (!target) return;
      const comps = Array.isArray(data && data.competitors) ? data.competitors : [];
      if (comps.length === 0) {
        target.innerHTML = `<div class="briefme-research-empty">${isEs ? "Sin competidores identificados." : "No competitors identified."}</div>`;
        return;
      }
      target.innerHTML = `<ul class="briefme-research-list">${comps.map(c => `
        <li>
          <strong>${escapeHtml(c.name || c.website)}</strong>
          ${c.website ? ` · <a href="https://${escapeHtml(c.website)}" target="_blank" rel="noopener">${escapeHtml(c.website)}</a>` : ""}
          ${c.reason ? `<br/><span class="briefme-research-subtle">${escapeHtml(c.reason)}</span>` : ""}
        </li>`).join("")}</ul>`;
    });

    // 4. Customers
    callIntel("company-customers", { domain, pageSize: 10, qualityFilter: "high" }).then(data => {
      const target = document.querySelector("#briefme-research-customers .briefme-research-card-body");
      if (!target) return;
      const customers = Array.isArray(data && data.customers) ? data.customers : [];
      if (customers.length === 0) {
        target.innerHTML = `<div class="briefme-research-empty">${isEs ? "Sin clientes conocidos." : "No known customers."}</div>`;
        return;
      }
      target.innerHTML = `<ul class="briefme-research-list">${customers.map(c => `
        <li>
          <strong>${escapeHtml(c.name)}</strong>
          ${c.website ? ` · <a href="https://${escapeHtml(c.website)}" target="_blank" rel="noopener">${escapeHtml(c.website)}</a>` : ""}
          ${c.industry ? ` · <span class="briefme-research-subtle">${escapeHtml(c.industry)}</span>` : ""}
        </li>`).join("")}</ul>`;
    });

    // 5. Apollo company enrichment — intent signals + why-now news.
    //    Fires ONE call that fills TWO cards (intent + whynow).
    callIntel("apollo-company-enrich", { domain }).then(data => {
      const intentTarget = document.querySelector("#briefme-research-intent .briefme-research-card-body");
      const whynowTarget = document.querySelector("#briefme-research-whynow .briefme-research-card-body");
      const org = data && data.org;
      if (!org) {
        if (intentTarget) intentTarget.innerHTML = `<div class="briefme-research-empty">${isEs ? "Sin datos de Apollo." : "No Apollo data."}</div>`;
        if (whynowTarget) whynowTarget.innerHTML = `<div class="briefme-research-empty">${isEs ? "Sin datos de Apollo." : "No Apollo data."}</div>`;
        return;
      }

      // Intent card
      if (intentTarget) {
        if (org.intentStrength || (org.intentTopics && org.intentTopics.length)) {
          const strengthClass = `briefme-intent-${String(org.intentStrength || "").toLowerCase().replace(/[^a-z]/g, "") || "low"}`;
          const strengthLabel = {
            very_high: isEs ? "MUY ALTA" : "VERY HIGH",
            high: isEs ? "ALTA" : "HIGH",
            medium: isEs ? "MEDIA" : "MEDIUM",
            low: isEs ? "BAJA" : "LOW",
          }[String(org.intentStrength || "").toLowerCase()] || (isEs ? "SEÑAL" : "SIGNAL");
          const topicsHtml = Array.isArray(org.intentTopics) && org.intentTopics.length
            ? `<ul class="briefme-research-list">${org.intentTopics.slice(0, 6).map(t =>
                `<li><strong>${escapeHtml(t.topic)}</strong>${t.strength ? ` · <span class="briefme-research-subtle">${escapeHtml(t.strength)}</span>` : ""}</li>`
              ).join("")}</ul>`
            : `<div class="briefme-research-subtle">${isEs ? "Sin tópicos específicos — pero la señal general está activa." : "No specific topics — but general signal is active."}</div>`;
          intentTarget.innerHTML = `
            <div class="briefme-intent-strength ${strengthClass}">${strengthLabel}</div>
            ${topicsHtml}
          `;
        } else {
          intentTarget.innerHTML = `<div class="briefme-research-empty">${isEs ? "Sin señal de intención activa." : "No active intent signal."}</div>`;
        }
      }

      // Why-now card: recent news + funding triggers
      if (whynowTarget) {
        const triggers = [];
        if (org.latestFundingStage && org.latestFundingDate) {
          const date = String(org.latestFundingDate).slice(0, 10);
          triggers.push({
            text: `${isEs ? "Cerraron" : "Closed"} <strong>${escapeHtml(org.latestFundingStage)}</strong>${org.totalFundingUsd ? ` (${escapeHtml(String(org.totalFundingUsd))} ${isEs ? "total" : "total"})` : ""} · ${date}`,
            url: "",
          });
        }
        if (Array.isArray(org.recentNews)) {
          for (const n of org.recentNews.slice(0, 4)) {
            triggers.push({ text: escapeHtml(n.title), url: n.url || "", date: String(n.date || "").slice(0, 10) });
          }
        }
        if (triggers.length === 0) {
          whynowTarget.innerHTML = `<div class="briefme-research-empty">${isEs ? "Sin disparadores recientes." : "No recent triggers."}</div>`;
        } else {
          whynowTarget.innerHTML = `<ul class="briefme-research-list">${triggers.map(t =>
            `<li>${t.url ? `<a href="${t.url}" target="_blank" rel="noopener">${t.text}</a>` : t.text}${t.date ? ` <span class="briefme-research-subtle">· ${escapeHtml(t.date)}</span>` : ""}</li>`
          ).join("")}</ul>`;
        }
      }
    });

    // 6. Similar people — uses the current profile's role + company domain.
    //    Runs last / separately because it's the slowest (1-3 min on fresh
    //    queries, can be cached-instant on repeats).
    const firstName = (currentProfile.firstName || displayName.split(" ")[0] || "").trim();
    const role = (currentProfile.headline || currentProfile.currentRole || "").trim();
    if (firstName || role) {
      callIntel("similar-people", {
        firstName,
        employerWebsite: domain,
        role: role.slice(0, 120),
      }).then(data => {
        const target = document.querySelector("#briefme-research-similar .briefme-research-card-body");
        if (!target) return;
        const people = Array.isArray(data && data.similarPeople) ? data.similarPeople : [];
        if (people.length === 0) {
          target.innerHTML = `<div class="briefme-research-empty">${isEs ? "Sin prospectos similares (puede tardar hasta 3 min en una primera consulta)." : "No similar prospects (first-time query can take up to 3 min)."}</div>`;
          return;
        }
        target.innerHTML = `<ul class="briefme-research-list">${people.slice(0, 10).map(p => `
          <li>
            <strong>${p.linkedinUrl ? `<a href="${escapeHtml(p.linkedinUrl)}" target="_blank" rel="noopener">${escapeHtml(p.fullName || p.firstName)}</a>` : escapeHtml(p.fullName || p.firstName)}</strong>
            ${p.title ? ` · ${escapeHtml(p.title)}` : ""}
            ${p.company ? ` · <span class="briefme-research-subtle">${escapeHtml(p.company)}</span>` : ""}
          </li>`).join("")}</ul>`;
      });
    }
  }

  // ============================================================
  // FULL DOSSIER — "know them cold" deep profile
  //
  // Different from the sales brief (tactical: what to say NEXT) and the
  // research view (company-scoped). This is strategic on the PERSON:
  // their full career, what they've built, how they think, who they know,
  // public footprint, and 10+ specific conversational hooks.
  //
  // Data fan-out (parallel):
  //   - LinkedIn scrape (already in currentProfile)
  //   - SerpApi person search → news, talks, press
  //   - Apollo /people/match → verified work history + email
  //   - Apollo /organizations/enrich → company context (if domain resolvable)
  //   - NinjaPear /api/ninjapear → fallback enrichment
  //
  // 24hr cache per profile URL — repeat opens are instant.
  // ============================================================

  const DOSSIER_CACHE_KEY = "klosr_dossier_cache";
  const DOSSIER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  // Cache key includes language + a version marker so:
  //  (a) ES + EN versions of a dossier coexist without clobbering each other
  //  (b) old entries without version invalidate automatically when the
  //      dossier format/prompt changes (bump DOSSIER_CACHE_VERSION).
  const DOSSIER_CACHE_VERSION = "v2";
  function dossierCacheKey(profileUrl, lang) {
    const base = (profileUrl || "").toLowerCase().replace(/\/+$/, "");
    return `${base}::${lang || "en"}::${DOSSIER_CACHE_VERSION}`;
  }

  async function getDossierFromCache(profileUrl, lang) {
    const cache = (await _storageGet(DOSSIER_CACHE_KEY)) || {};
    const entry = cache[dossierCacheKey(profileUrl, lang)];
    if (!entry) return null;
    if (Date.now() - entry.t > DOSSIER_CACHE_TTL_MS) return null;
    return entry;
  }

  async function setDossierInCache(profileUrl, lang, dossier) {
    const cache = (await _storageGet(DOSSIER_CACHE_KEY)) || {};
    cache[dossierCacheKey(profileUrl, lang)] = { dossier, lang, t: Date.now() };
    // Keep cache lean — drop entries older than 7 days.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const k of Object.keys(cache)) {
      if (cache[k].t < cutoff) delete cache[k];
    }
    await _storageSet(DOSSIER_CACHE_KEY, cache);
  }

  async function showFullDossierView(opts = {}) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";

    if (!currentProfile) {
      content.innerHTML = `<div class="briefme-warm-empty">${isEs ? "Abre un perfil de LinkedIn primero." : "Open a LinkedIn profile first."}</div>`;
      return;
    }
    logKlosrEvent("dossier_generated", { language: currentLanguage, force: !!opts.force });

    const displayName = getDisplayName(currentProfile);
    const profileUrl = currentProfile.profileUrl || "";

    // Frame shell first — then progressively fill.
    content.innerHTML = `
      <div class="briefme-dossier-view">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">🧠 ${isEs ? "Conócele a fondo" : "Know them cold"}</div>
          <div class="briefme-quest-subtitle">
            <span id="briefme-dossier-subject">${escapeHtml(displayName)}</span> ·
            <span id="briefme-dossier-cache-status" class="briefme-dossier-cache">${isEs ? "generando..." : "generating..."}</span>
          </div>
        </div>

        <div class="briefme-dossier-progress" id="briefme-dossier-progress">
          <div class="briefme-dossier-step" data-step="scrape">
            <span class="briefme-dossier-step-dot"></span> ${isEs ? "Leyendo el perfil de LinkedIn" : "Reading LinkedIn profile"}
          </div>
          <div class="briefme-dossier-step" data-step="serp">
            <span class="briefme-dossier-step-dot"></span> ${isEs ? "Buscando menciones en la web" : "Searching the web for mentions"}
          </div>
          <div class="briefme-dossier-step" data-step="apollo">
            <span class="briefme-dossier-step-dot"></span> ${isEs ? "Enriqueciendo vía Apollo" : "Enriching via Apollo"}
          </div>
          <div class="briefme-dossier-step" data-step="synth">
            <span class="briefme-dossier-step-dot"></span> ${isEs ? "Sintetizando con Claude" : "Synthesizing with Claude"}
          </div>
        </div>

        <div class="briefme-dossier-body" id="briefme-dossier-body"></div>

        <div class="briefme-quest-actions">
          <button type="button" class="briefme-quest-back" id="briefme-dossier-back">${isEs ? "Volver" : "Back"}</button>
          <button type="button" class="briefme-quest-submit" id="briefme-dossier-refresh">${isEs ? "Regenerar" : "Regenerate"}</button>
        </div>
      </div>
    `;

    document.getElementById("briefme-dossier-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    });
    document.getElementById("briefme-dossier-refresh").addEventListener("click", () => {
      showFullDossierView({ force: true });
    });

    // Try cache first — instant render. Keyed by profile + language so
    // switching ES/EN always regenerates into the right language (no
    // stale English cache served to ES users or vice versa).
    if (!opts.force) {
      const cached = await getDossierFromCache(profileUrl, currentLanguage);
      if (cached && cached.dossier) {
        const ageMin = Math.round((Date.now() - cached.t) / 60000);
        renderDossier(cached.dossier, { isEs, cached: true, ageMin, displayName });
        return;
      }
    }

    const markStep = (step, state) => {
      const el = document.querySelector(`.briefme-dossier-step[data-step="${step}"]`);
      if (el) el.classList.add(`briefme-dossier-step-${state}`);   // "loading" | "done" | "skipped" | "failed"
    };

    try {
      // Parallel fan-out. Each source has its own failure mode and never
      // blocks the others — dossier generates with whatever data came back.

      // Derive a company domain if we have one; otherwise resolve via Claude.
      let domain = (currentProfile.companyDomain || currentProfile.currentCompanyWebsite || "")
        .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
      markStep("scrape", "done");     // the scrape already ran on profile load
      markStep("serp", "loading");
      markStep("apollo", "loading");

      // Resolve domain in background if missing — non-blocking.
      let domainResolve = null;
      if (!domain && (currentProfile.currentCompany || currentProfile.headline)) {
        domainResolve = callIntel("resolve-domain", {
          companyName: currentProfile.currentCompany || "",
          headline: currentProfile.headline || "",
        }).then(r => r?.domain || "");
      }

      // Kick off all three enrichment calls in parallel.
      const [serpRes, apolloPersonRes] = await Promise.all([
        // SerpApi person search via the existing analyze endpoint's helper
        // would require a new endpoint. Skip — we'll let the backend handle
        // what it gets. The backend already runs SerpApi for briefs and we
        // pass what we have. For now: send a focused person query via intel
        // if we wire it (future). Currently: scrape + Apollo only.
        Promise.resolve(null),

        // Apollo People Match — verified work history + email
        callIntel("apollo-bulk-enrich", {
          linkedinUrls: [profileUrl],
          revealPhones: false,
        }).then(r => {
          const m = r && Array.isArray(r.matches) && r.matches[0];
          return m || null;
        }),
      ]);

      markStep("serp", "done");
      markStep("apollo", apolloPersonRes ? "done" : "skipped");

      // Wait for domain resolve if it was kicked off.
      if (domainResolve) {
        try { domain = (await domainResolve) || ""; } catch {}
        if (domain) currentProfile.companyDomain = domain;
      } else if (apolloPersonRes && apolloPersonRes.companyDomain) {
        domain = apolloPersonRes.companyDomain;
      }

      // Company enrichment — Apollo for org context.
      let apolloOrg = null;
      if (domain) {
        try {
          const orgRes = await callIntel("apollo-company-enrich", { domain });
          apolloOrg = orgRes && orgRes.org ? orgRes.org : null;
        } catch {/* ignore */}
      }

      markStep("synth", "loading");

      // Send everything to Claude for the synthesis.
      const result = await callIntel("full-dossier", {
        language: currentLanguage,
        prospect: {
          name: displayName,
          title: currentProfile.headline || currentProfile.currentRole || "",
          company: currentProfile.currentCompany || currentProfile.company || "",
          profileUrl,
        },
        linkedinScrape: currentProfile,
        apolloPerson: apolloPersonRes,
        apolloOrg,
        // SerpApi data would be populated if we wire a new endpoint; for
        // now the backend's analyze-path SerpApi runs elsewhere. Future
        // work: add a small "serp-person" action that returns the results
        // ready for dossier fusion.
        serpPerson: [],
        serpCompany: [],
        ninjaPear: null,
      });

      markStep("synth", "done");

      if (!result || !result.dossier) {
        document.getElementById("briefme-dossier-body").innerHTML = `
          <div class="briefme-research-empty">${isEs
            ? "No se pudo generar el dossier. Revisa las claves de API o intenta de nuevo."
            : "Couldn't generate the dossier. Check API keys or try again."}</div>
        `;
        document.getElementById("briefme-dossier-cache-status").textContent = isEs ? "error" : "failed";
        return;
      }

      // Cache + render.
      await setDossierInCache(profileUrl, currentLanguage, result.dossier);
      renderDossier(result.dossier, { isEs, cached: false, ageMin: 0, displayName });
    } catch (err) {
      console.error("[Klosr dossier] error:", err);
      const body = document.getElementById("briefme-dossier-body");
      if (body) {
        body.innerHTML = `<div class="briefme-research-empty">${isEs
          ? "Error generando el dossier. Inténtalo de nuevo."
          : "Error generating the dossier. Try again."}</div>`;
      }
    }
  }

  // Escape HTML then upgrade markdown bold → <strong>. Used for every
  // dossier field Claude might wrap with **...** for scan-emphasis.
  function dossierFmt(raw) {
    const s = typeof raw === "string" ? raw : String(raw || "");
    return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
  // Clean text version — strips markdown bold but keeps the words.
  function stripBold(s) { return String(s || "").replace(/\*\*(.+?)\*\*/g, "$1"); }

  function renderDossier(d, opts) {
    const { isEs, cached, ageMin, displayName } = opts || {};
    const body = document.getElementById("briefme-dossier-body");
    const status = document.getElementById("briefme-dossier-cache-status");
    if (status) {
      status.textContent = cached
        ? (isEs ? `caché · hace ${ageMin}m` : `cached · ${ageMin}m ago`)
        : (isEs ? "recién generado" : "fresh");
    }
    // Hide progress tracker once dossier is ready.
    const progress = document.getElementById("briefme-dossier-progress");
    if (progress) progress.hidden = true;

    if (!body) return;

    // Insert the Copy button into the subtitle line (above the body).
    const header = document.querySelector(".briefme-dossier-view .briefme-quest-header");
    if (header && !header.querySelector(".briefme-dossier-copy")) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "briefme-dossier-copy";
      copyBtn.textContent = isEs ? "📋 Copiar dossier" : "📋 Copy dossier";
      copyBtn.addEventListener("click", async () => {
        const txt = dossierToPlainText(d, { isEs, displayName: displayName || "Prospect" });
        try {
          await navigator.clipboard.writeText(txt);
          copyBtn.textContent = isEs ? "✓ Copiado" : "✓ Copied";
          setTimeout(() => { copyBtn.textContent = isEs ? "📋 Copiar dossier" : "📋 Copy dossier"; }, 1800);
        } catch {/* silent */}
      });
      header.appendChild(copyBtn);
    }

    const sec = (emoji, title, html) => html
      ? `<section class="briefme-dossier-section">
           <h3 class="briefme-dossier-h">${emoji} ${escapeHtml(title)}</h3>
           <div class="briefme-dossier-content">${html}</div>
         </section>` : "";

    // Bullet list that honors **bold** in items.
    const listBullets = (items) => Array.isArray(items) && items.length
      ? `<ul class="briefme-dossier-list">${items.map(x =>
          `<li>${dossierFmt(typeof x === "string" ? x : JSON.stringify(x))}</li>`).join("")}</ul>` : "";

    // Essence + tagline (hero)
    const heroHtml = (d.essence || d.tagline) ? `
      <section class="briefme-dossier-hero">
        ${d.tagline ? `<div class="briefme-dossier-tagline">${dossierFmt(d.tagline)}</div>` : ""}
        ${d.essence ? `<div class="briefme-dossier-essence">${dossierFmt(d.essence)}</div>` : ""}
      </section>` : "";

    // Career arc
    const careerHtml = (d.career && (d.career.summary || (d.career.roles || []).length))
      ? `${d.career.summary ? `<p class="briefme-dossier-p">${dossierFmt(d.career.summary)}</p>` : ""}
         ${(d.career.roles || []).length ? `<ol class="briefme-dossier-timeline">${
           d.career.roles.map(r => `
             <li class="briefme-dossier-role">
               <div class="briefme-dossier-role-head">
                 <strong>${escapeHtml(r.title || "")}</strong>
                 ${r.company ? ` · <span>${escapeHtml(r.company)}</span>` : ""}
               </div>
               ${r.period ? `<div class="briefme-dossier-role-period">${escapeHtml(r.period)}</div>` : ""}
               ${r.achievement ? `<div class="briefme-dossier-role-body">${dossierFmt(r.achievement)}</div>` : ""}
               ${r.inferredReason ? `<div class="briefme-dossier-role-note">↪ ${dossierFmt(r.inferredReason)}</div>` : ""}
             </li>`).join("")
         }</ol>` : ""}` : "";

    // Education
    const eduHtml = (d.education || []).length
      ? `<ul class="briefme-dossier-edu-list">${d.education.map(e => `
           <li>
             <strong>${escapeHtml(e.school || "")}</strong>
             ${e.degree ? ` · ${escapeHtml(e.degree)}` : ""}
             ${e.field ? ` · ${escapeHtml(e.field)}` : ""}
             ${e.period ? ` <span class="briefme-dossier-subtle">${escapeHtml(e.period)}</span>` : ""}
             ${e.note ? `<div class="briefme-dossier-subtle">${dossierFmt(e.note)}</div>` : ""}
           </li>`).join("")}</ul>` : "";

    // How they think
    const thinkHtml = d.howTheyThink ? `
      ${d.howTheyThink.communicationStyle ? `<p class="briefme-dossier-p">${dossierFmt(d.howTheyThink.communicationStyle)}</p>` : ""}
      ${d.howTheyThink.tone ? `<div class="briefme-dossier-tags"><span>${isEs ? "Tono:" : "Tone:"}</span> <em>${escapeHtml(d.howTheyThink.tone)}</em></div>` : ""}
      ${Array.isArray(d.howTheyThink.recurringThemes) && d.howTheyThink.recurringThemes.length
        ? `<div class="briefme-dossier-chips">${d.howTheyThink.recurringThemes.map(t =>
            `<span class="briefme-dossier-chip">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    ` : "";

    // Network
    const networkHtml = d.network ? `
      ${d.network.summary ? `<p class="briefme-dossier-p">${dossierFmt(d.network.summary)}</p>` : ""}
      ${listBullets(d.network.notables)}
    ` : "";

    // Hooks — the actionable section, always expanded
    const hooksHtml = Array.isArray(d.conversationalHooks) && d.conversationalHooks.length
      ? `<ol class="briefme-dossier-hooks">${d.conversationalHooks.map(h =>
          `<li>${dossierFmt(h)}</li>`).join("")}</ol>` : "";

    // Power line — the pinned closer
    const powerHtml = d.powerLine
      ? `<blockquote class="briefme-dossier-power">${dossierFmt(d.powerLine)}</blockquote>` : "";

    // Avoid
    const avoidHtml = listBullets(d.avoid);

    body.innerHTML = `
      ${heroHtml}
      ${sec("🎣", isEs ? "Ganchos de conversación" : "Conversational hooks", hooksHtml)}
      ${powerHtml ? `<section class="briefme-dossier-section"><h3 class="briefme-dossier-h">⚡ ${isEs ? "Frase poder" : "Power line"}</h3><div class="briefme-dossier-content">${powerHtml}</div></section>` : ""}
      ${sec("⏳", isEs ? "Trayectoria" : "Career arc", careerHtml)}
      ${sec("🏗️", isEs ? "Qué han construido" : "What they've built", listBullets(d.builds))}
      ${sec("🧠", isEs ? "Cómo piensan" : "How they think", thinkHtml)}
      ${sec("❤️", isEs ? "Qué les importa" : "What they care about", listBullets(d.caresAbout))}
      ${sec("🌍", isEs ? "Su mundo" : "Their network", networkHtml)}
      ${sec("📣", isEs ? "Huella pública" : "Public footprint", listBullets(d.publicFootprint))}
      ${sec("🎓", isEs ? "Educación" : "Education", eduHtml)}
      ${sec("⚡", isEs ? "Disparadores recientes" : "Recent triggers", listBullets(d.triggers))}
      ${avoidHtml ? sec("🚩", isEs ? "Evita" : "Avoid", avoidHtml) : ""}
    `;
  }

  // Turn the dossier into a plain-text transcript ready to paste anywhere
  // (Notion, a doc, a DM). Strips markdown bold but preserves structure.
  function dossierToPlainText(d, { isEs, displayName }) {
    const out = [];
    const hdr = (emoji, label) => out.push("", `${emoji} ${label.toUpperCase()}`, "─".repeat(Math.min(40, label.length + 3)));
    const line = (s) => out.push(stripBold(String(s || "")));
    const bullets = (arr) => (arr || []).forEach(x => out.push("• " + stripBold(typeof x === "string" ? x : JSON.stringify(x))));

    out.push(`🧠 ${isEs ? "DOSSIER" : "DOSSIER"} — ${displayName || (isEs ? "Prospecto" : "Prospect")}`);
    out.push("═".repeat(48));

    if (d.tagline) { out.push(""); line(d.tagline); }
    if (d.essence) { out.push(""); line(d.essence); }

    if (Array.isArray(d.conversationalHooks) && d.conversationalHooks.length) {
      hdr("🎣", isEs ? "Ganchos de conversación" : "Conversational hooks");
      d.conversationalHooks.forEach((h, i) => out.push(`${i + 1}. ${stripBold(h)}`));
    }

    if (d.powerLine) {
      hdr("⚡", isEs ? "Frase poder" : "Power line");
      out.push(`"${stripBold(d.powerLine)}"`);
    }

    if (d.career && (d.career.summary || (d.career.roles || []).length)) {
      hdr("⏳", isEs ? "Trayectoria" : "Career arc");
      if (d.career.summary) line(d.career.summary);
      (d.career.roles || []).forEach(r => {
        out.push("");
        out.push(`▸ ${r.title || ""}${r.company ? " · " + r.company : ""}${r.period ? "  (" + r.period + ")" : ""}`);
        if (r.achievement) out.push("  " + stripBold(r.achievement));
        if (r.inferredReason) out.push("  ↪ " + stripBold(r.inferredReason));
      });
    }

    if ((d.builds || []).length) {
      hdr("🏗️", isEs ? "Qué han construido" : "What they've built");
      bullets(d.builds);
    }

    if (d.howTheyThink && (d.howTheyThink.communicationStyle || d.howTheyThink.recurringThemes)) {
      hdr("🧠", isEs ? "Cómo piensan" : "How they think");
      if (d.howTheyThink.tone) out.push(`${isEs ? "Tono" : "Tone"}: ${d.howTheyThink.tone}`);
      if (d.howTheyThink.communicationStyle) line(d.howTheyThink.communicationStyle);
      if (Array.isArray(d.howTheyThink.recurringThemes)) {
        out.push(`${isEs ? "Temas" : "Themes"}: ${d.howTheyThink.recurringThemes.join(" · ")}`);
      }
    }

    if ((d.caresAbout || []).length) {
      hdr("❤️", isEs ? "Qué les importa" : "What they care about");
      bullets(d.caresAbout);
    }
    if (d.network && (d.network.summary || (d.network.notables || []).length)) {
      hdr("🌍", isEs ? "Su mundo" : "Their network");
      if (d.network.summary) line(d.network.summary);
      bullets(d.network.notables);
    }
    if ((d.publicFootprint || []).length) {
      hdr("📣", isEs ? "Huella pública" : "Public footprint");
      bullets(d.publicFootprint);
    }
    if ((d.education || []).length) {
      hdr("🎓", isEs ? "Educación" : "Education");
      d.education.forEach(e => {
        const parts = [e.school, e.degree, e.field, e.period].filter(Boolean);
        out.push("• " + parts.join(" · "));
      });
    }
    if ((d.triggers || []).length) {
      hdr("⚡", isEs ? "Disparadores recientes" : "Recent triggers");
      bullets(d.triggers);
    }
    if ((d.avoid || []).length) {
      hdr("🚩", isEs ? "Evita" : "Avoid");
      bullets(d.avoid);
    }

    out.push("");
    out.push("─".repeat(48));
    out.push(`${isEs ? "Generado por Klosr" : "Generated by Klosr"} · klosr.app`);
    return out.join("\n");
  }

  // ═══════════════════════════════════════════════════════════════
  // DEAL PIPELINE VIEW — the deal-closing heart of Klosr
  //
  // Lists every deal in the pipeline (from prepcall_history, enriched with
  // dealStage / commitments / objections). Sorted by "needs your attention"
  // first — pending commitments with a due date, then recent activity.
  //
  // Actions per deal:
  //   - Open prospect's LinkedIn (external)
  //   - Re-generate brief (uses analyzeProfile)
  //   - Change stage (dropdown)
  //   - Mark won / lost (feeds ICP learning — the closed loop)
  //
  // Commitments inbox at top: every "I'll send you the proposal by Friday"
  // captured during a live call, with one-click mark-done and due-date
  // editor. This is the mechanism that turns Klosr into a "deals get
  // closed because commitments don't fall through the cracks" tool.
  // ═══════════════════════════════════════════════════════════════

  // Human-readable stage labels — localized.
  function stageLabel(stage, isEs) {
    const en = {
      prepped: "Prepped", contacted: "Contacted", replied: "Replied",
      discovery: "Discovery", objection: "Objection", negotiation: "Negotiation",
      closing: "Closing", won: "Won", lost: "Lost", ghosted: "Ghosted",
    };
    const es = {
      prepped: "Preparado", contacted: "Contactado", replied: "Respondió",
      discovery: "Descubrimiento", objection: "Objeción", negotiation: "Negociación",
      closing: "Cierre", won: "Ganado", lost: "Perdido", ghosted: "Silenciado",
    };
    return (isEs ? es : en)[stage] || stage;
  }

  function stageClass(stage) {
    // CSS modifier classes for color coding. Match the in-call deal-stage
    // palette so the pipeline visually aligns with what the coach showed.
    const map = {
      prepped: "klosr-pl-stage-prepped",
      contacted: "klosr-pl-stage-contacted",
      replied: "klosr-pl-stage-replied",
      discovery: "klosr-pl-stage-discovery",
      objection: "klosr-pl-stage-objection",
      negotiation: "klosr-pl-stage-negotiation",
      closing: "klosr-pl-stage-closing",
      won: "klosr-pl-stage-won",
      lost: "klosr-pl-stage-lost",
      ghosted: "klosr-pl-stage-ghosted",
    };
    return map[stage] || "";
  }

  function fmtRelativeTime(ts, isEs) {
    if (!ts) return "—";
    const secs = Math.floor((Date.now() - Number(ts)) / 1000);
    if (secs < 60) return isEs ? `${secs}s` : `${secs}s ago`;
    if (secs < 3600) return isEs ? `hace ${Math.floor(secs/60)}m` : `${Math.floor(secs/60)}m ago`;
    if (secs < 86400) return isEs ? `hace ${Math.floor(secs/3600)}h` : `${Math.floor(secs/3600)}h ago`;
    const d = Math.floor(secs / 86400);
    return isEs ? `hace ${d}d` : `${d}d ago`;
  }

  // Weight a deal so the list shows "needs attention" first. Logic:
  //   - Pending commitment overdue → highest
  //   - Pending commitment due within 3 days → high
  //   - Active stage (negotiation, closing) → medium-high
  //   - Stale (14d+ no activity) → moves to bottom
  //   - Won/lost → always last
  function dealUrgencyScore(deal) {
    const now = Date.now();
    if (deal.dealStage === "won" || deal.dealStage === "lost") return -1000;
    let score = 0;
    const pending = (deal.commitments || []).filter(c => !c.doneAt);
    for (const c of pending) {
      if (c.dueBy) {
        const diff = c.dueBy - now;
        if (diff < 0) score += 50;                     // overdue
        else if (diff < 3 * 86400000) score += 30;     // due soon
        else score += 10;
      } else {
        score += 5;
      }
    }
    const stageWeight = {
      closing: 40, negotiation: 30, objection: 25, discovery: 20,
      replied: 15, contacted: 10, prepped: 5,
    }[deal.dealStage || deal.stage] || 0;
    score += stageWeight;
    const daysSince = (now - (deal.lastActivityAt || deal.savedAt || 0)) / 86400000;
    if (daysSince > 14 && (deal.dealStage === "prepped" || deal.dealStage === "contacted")) score -= 20;  // stale
    return score;
  }

  // ═══════════════════════════════════════════════════════════════
  // DAILY CLOSE — the "what do I do today to close deals" dashboard
  //
  // This is the HOME VIEW for any founder with ≥3 deals. It shows:
  //   - Money at stake (closed revenue + weighted pipeline + win rate)
  //   - Today's Actions (ranked list — overdue commits, stuck deals,
  //     hot-but-silent, revive candidates, multi-thread suggestions)
  //   - Hot deals (temperature = hot) with one-click re-engage
  //   - Stuck deals with inline Revive-draft button
  //
  // Design philosophy: every row is ONE click away from action. No
  // "Okay now I need to think about what to do" — Klosr already thought.
  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // KLOSR VISION — paste any screenshot, get the right action
  //
  // Takes a screenshot from the user's clipboard (Ctrl+V) or file picker,
  // ships it to Claude Sonnet 4.5 multimodal, and returns a structured
  // response: what Klosr saw + drafted reply/action + temperature + proof
  // suggestion. Covers WhatsApp, email, Slack, SalesNav, and every other
  // channel our content scripts don't see.
  // ═══════════════════════════════════════════════════════════════
  async function showVisionView() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";
    logKlosrEvent("vision_opened", {});

    content.innerHTML = `
      <div class="klosr-vision-view">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">📸 ${isEs ? "Klosr Vision" : "Klosr Vision"}</div>
          <div class="briefme-quest-subtitle">${isEs
            ? "Pega una captura de WhatsApp, email, Slack, Sales Nav... cualquier sitio. Klosr lo ve y te da la acción."
            : "Paste a screenshot from WhatsApp, email, Slack, Sales Nav — anywhere. Klosr sees it and gives you the action."}</div>
        </div>

        <div class="klosr-vision-dropzone" id="klosr-vision-drop" tabindex="0">
          <div class="klosr-vision-drop-icon">📋</div>
          <div class="klosr-vision-drop-hint">${isEs
            ? "Pega con Ctrl+V · o arrastra una imagen · o haz clic para seleccionar"
            : "Paste with Ctrl+V · or drag an image · or click to pick one"}</div>
          <input type="file" id="klosr-vision-file" accept="image/*" hidden />
        </div>

        <div class="klosr-vision-preview" id="klosr-vision-preview" hidden></div>

        <div class="klosr-vision-intent" id="klosr-vision-intent" hidden>
          <div class="klosr-vision-intent-label">${isEs ? "¿Qué necesitas?" : "What do you need?"}</div>
          <div class="klosr-vision-intent-chips">
            <button class="klosr-vision-chip klosr-vision-chip-active" data-intent="auto">✨ ${isEs ? "Auto — tú decides Klosr" : "Auto — let Klosr decide"}</button>
            <button class="klosr-vision-chip" data-intent="draft_reply">💬 ${isEs ? "Redactar respuesta" : "Draft a reply"}</button>
            <button class="klosr-vision-chip" data-intent="identify">🎯 ${isEs ? "¿Encaja con mi ICP?" : "Is this ICP fit?"}</button>
            <button class="klosr-vision-chip" data-intent="objection">🛡️ ${isEs ? "Rebatir objeción" : "Handle objection"}</button>
            <button class="klosr-vision-chip" data-intent="buying_signal">🔥 ${isEs ? "¿Señal de compra?" : "Buying signal?"}</button>
          </div>
          <textarea class="klosr-vision-prompt" id="klosr-vision-prompt" rows="2" placeholder="${isEs ? "Contexto opcional (ej. 'es un cliente que lleva 3 meses sin responder')" : "Optional context (e.g. 'prospect went silent 3 months ago')"}"></textarea>
          <button class="klosr-vision-submit" id="klosr-vision-submit">🚀 ${isEs ? "Analizar" : "Analyze"}</button>
        </div>

        <div class="klosr-vision-result" id="klosr-vision-result"></div>

        <div class="briefme-quest-actions">
          <button type="button" class="briefme-quest-back" id="klosr-vision-back">${isEs ? "Volver" : "Back"}</button>
        </div>
      </div>
    `;

    document.getElementById("klosr-vision-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    });

    let _visionImage = null;   // { base64, mimeType, dataUrl }
    let _visionIntent = "auto";

    const dropzone = document.getElementById("klosr-vision-drop");
    const fileInput = document.getElementById("klosr-vision-file");
    const preview = document.getElementById("klosr-vision-preview");
    const intentUi = document.getElementById("klosr-vision-intent");

    const acceptImage = async (blob) => {
      if (!blob) return;
      if (!blob.type || !blob.type.startsWith("image/")) {
        dropzone.classList.add("klosr-vision-drop-error");
        setTimeout(() => dropzone.classList.remove("klosr-vision-drop-error"), 1200);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const b64 = String(dataUrl).split(",")[1] || "";
        _visionImage = { base64: b64, mimeType: blob.type, dataUrl };
        preview.hidden = false;
        preview.innerHTML = `
          <img src="${dataUrl}" alt="screenshot" />
          <button class="klosr-vision-preview-clear" id="klosr-vision-preview-clear">${isEs ? "Cambiar" : "Replace"}</button>
        `;
        intentUi.hidden = false;
        document.getElementById("klosr-vision-preview-clear").addEventListener("click", () => {
          _visionImage = null;
          preview.hidden = true;
          preview.innerHTML = "";
          intentUi.hidden = true;
          document.getElementById("klosr-vision-result").innerHTML = "";
        });
      };
      reader.readAsDataURL(blob);
    };

    // Paste handler on the dropzone (Ctrl+V)
    dropzone.addEventListener("paste", (e) => {
      e.preventDefault();
      const items = (e.clipboardData || window.clipboardData)?.items || [];
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) { acceptImage(blob); return; }
        }
      }
    });

    // Also listen at document level so Ctrl+V works even when the dropzone
    // doesn't have focus (common case: user just pasted)
    const globalPasteHandler = (e) => {
      if (_visionImage) return;   // already have an image; ignore
      const vw = document.getElementById("klosr-vision-view");
      if (!document.getElementById("klosr-vision-drop")) {
        document.removeEventListener("paste", globalPasteHandler);
        return;
      }
      const items = (e.clipboardData || window.clipboardData)?.items || [];
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) { e.preventDefault(); acceptImage(blob); return; }
        }
      }
    };
    document.addEventListener("paste", globalPasteHandler);

    // Drag-and-drop
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("klosr-vision-drop-hover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("klosr-vision-drop-hover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("klosr-vision-drop-hover");
      const file = e.dataTransfer?.files?.[0];
      if (file) acceptImage(file);
    });

    // Click to pick a file
    dropzone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) acceptImage(file);
    });

    // Intent chips
    document.querySelectorAll(".klosr-vision-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".klosr-vision-chip").forEach(c => c.classList.remove("klosr-vision-chip-active"));
        chip.classList.add("klosr-vision-chip-active");
        _visionIntent = chip.dataset.intent || "auto";
      });
    });

    // Submit
    document.getElementById("klosr-vision-submit").addEventListener("click", async () => {
      if (!_visionImage) return;
      const submitBtn = document.getElementById("klosr-vision-submit");
      const resultEl = document.getElementById("klosr-vision-result");
      const userPrompt = (document.getElementById("klosr-vision-prompt").value || "").trim();

      submitBtn.disabled = true;
      submitBtn.textContent = isEs ? "Analizando..." : "Analyzing...";
      resultEl.innerHTML = `<div class="briefme-loading"><div class="briefme-spinner"></div><p>${isEs ? "Klosr está leyendo la imagen..." : "Klosr is reading the image..."}</p></div>`;
      logKlosrEvent("vision_submitted", { intent: _visionIntent });

      try {
        const [cp, proof, playbook, voice] = await Promise.all([
          loadCompanyProfile(),
          _get("klosr_proof_library"),
          _get("klosr_objection_playbook"),
          _get("klosr_voice_diffs"),
        ]);

        const res = await callIntel("screenshot-analyze", {
          imageBase64: _visionImage.base64,
          mimeType: _visionImage.mimeType,
          userPrompt,
          intent: _visionIntent,
          language: currentLanguage,
          founder: {
            name: (cp && cp.yourName) || "",
            company: (cp && cp.companyName) || "",
            whatYouSell: (cp && cp.whatYouSell) || "",
            valueProp: (cp && cp.valueProp) || "",
            icp: (cp && cp.icp) || "",
          },
          proofLibrary: proof || [],
          objectionPlaybook: playbook || [],
          voiceExamples: voice || [],
        });

        renderVisionResult(res, resultEl, isEs);
        logKlosrEvent("vision_completed", { intent: _visionIntent, ok: !!(res && res.ok) });
      } catch (err) {
        console.error("[Klosr Vision] error:", err);
        resultEl.innerHTML = `<div class="briefme-warm-draft-error">${isEs ? "Error. Inténtalo de nuevo." : "Error. Try again."}</div>`;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = `🚀 ${isEs ? "Analizar" : "Analyze"}`;
      }
    });

    // Focus the dropzone so Ctrl+V works immediately.
    dropzone.focus();
  }

  function renderVisionResult(res, resultEl, isEs) {
    if (!res || !res.ok) {
      resultEl.innerHTML = `<div class="briefme-warm-draft-error">${isEs ? "Klosr no pudo leer la imagen." : "Klosr couldn't read the image."} ${escapeHtml(res?.reason || "")}</div>`;
      return;
    }

    const tempIcon = res.temperature === "hot" ? "🔥" : res.temperature === "warm" ? "☀️" : res.temperature === "cold" ? "❄️" : "";
    const tempLabel = res.temperature && res.temperature !== "n/a"
      ? `<span class="klosr-vision-temp klosr-vision-temp-${res.temperature}">${tempIcon} ${escapeHtml(res.temperature.toUpperCase())}${res.temperatureReason ? ` · ${escapeHtml(res.temperatureReason)}` : ""}</span>`
      : "";

    const proofHtml = res.suggestedProof && res.suggestedProof.title ? `
      <div class="klosr-vision-proof">
        <div class="klosr-vision-proof-label">📎 ${isEs ? "Cita esta prueba" : "Cite this proof"}</div>
        <div class="klosr-vision-proof-title">${escapeHtml(res.suggestedProof.title)}</div>
        <div class="klosr-vision-proof-body">${escapeHtml(res.suggestedProof.body)}</div>
      </div>
    ` : "";

    const draftHtml = res.draft ? `
      <div class="klosr-vision-draft-block">
        <div class="klosr-vision-draft-label">✍ ${isEs ? "Respuesta lista" : "Ready to send"}</div>
        <textarea class="klosr-vision-draft-ta" id="klosr-vision-draft-ta" rows="6">${escapeHtml(res.draft)}</textarea>
        <div class="klosr-vision-draft-actions">
          <button class="klosr-vision-copy-btn" id="klosr-vision-copy">${isEs ? "Copiar" : "Copy"}</button>
        </div>
      </div>
    ` : "";

    resultEl.innerHTML = `
      <div class="klosr-vision-result-card">
        <div class="klosr-vision-saw">
          <div class="klosr-vision-saw-label">👁 ${isEs ? "Klosr ve" : "Klosr sees"}</div>
          <div class="klosr-vision-saw-text">${escapeHtml(res.whatYouSaw || "")}</div>
          ${tempLabel}
        </div>
        ${draftHtml}
        ${proofHtml}
        ${res.nextStep ? `<div class="klosr-vision-next">➡️ ${escapeHtml(res.nextStep)}</div>` : ""}
      </div>
    `;

    const copyBtn = document.getElementById("klosr-vision-copy");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const ta = document.getElementById("klosr-vision-draft-ta");
        navigator.clipboard.writeText(ta.value).then(() => {
          copyBtn.textContent = isEs ? "✓ Copiado" : "✓ Copied";
          setTimeout(() => { copyBtn.textContent = isEs ? "Copiar" : "Copy"; }, 1500);
          logKlosrEvent("vision_draft_copied", {});
        });
      });
    }
  }

  // Shows an info panel inside the sidebar with the Klosr Desktop PWA URL,
  // the user's install ID (auto-copied so onboarding is one-paste), and a
  // one-click "Open Klosr Desktop" button that launches the PWA in a new tab.
  async function showKlosrDesktopInfo() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";
    logKlosrEvent("klosr_desktop_opened", {});

    const installId = await getKlosrInstallId();
    const PWA_URL = "https://backend-kappa-nine-57.vercel.app/app.html";

    content.innerHTML = `
      <div class="klosr-desktop-info">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">🖥️ ${isEs ? "Klosr Desktop" : "Klosr Desktop"}</div>
          <div class="briefme-quest-subtitle">${isEs
            ? "Klosr lee tu pantalla y redacta respuestas en tu voz, en cualquier app."
            : "Klosr reads your screen and drafts replies in your voice, across every app."}</div>
        </div>

        <div class="klosr-desktop-pitch">
          <div class="klosr-desktop-pitch-icon">👁️</div>
          <div class="klosr-desktop-pitch-body">
            <div class="klosr-desktop-pitch-title">${isEs ? "Modo Watch: Klosr observa, redacta, tú envías" : "Watch mode: Klosr sees, drafts, you send"}</div>
            <ul class="klosr-desktop-pitch-list">
              <li>${isEs ? "Comparte tu pantalla una vez" : "Share your screen once"}</li>
              <li>${isEs ? "Opus 4.7 detecta cada respuesta entrante" : "Opus 4.7 detects every incoming reply"}</li>
              <li>${isEs ? "Redacta en tu voz usando tu biblioteca de pruebas" : "Drafts in your voice using your proof library"}</li>
              <li>${isEs ? "Un clic → auto-llena WhatsApp / Gmail / Slack / Teams" : "One click → auto-fills WhatsApp / Gmail / Slack / Teams"}</li>
            </ul>
          </div>
        </div>

        <div class="klosr-desktop-steps">
          <div class="klosr-desktop-step-title">${isEs ? "Cómo empezar" : "How to start"}</div>
          <div class="klosr-desktop-step">
            <span class="klosr-desktop-step-num">1</span>
            <div>
              ${isEs ? "Abre Klosr Desktop:" : "Open Klosr Desktop:"}
              <button class="klosr-desktop-open-btn" id="klosr-desktop-open">🖥️ ${isEs ? "Abrir Klosr Desktop" : "Open Klosr Desktop"}</button>
            </div>
          </div>
          <div class="klosr-desktop-step">
            <span class="klosr-desktop-step-num">2</span>
            <div>
              ${isEs ? "Copia tu Install ID y pégalo en Klosr Desktop:" : "Copy your Install ID, paste into Klosr Desktop:"}
              <div class="klosr-desktop-iid-row">
                <code class="klosr-desktop-iid">${escapeHtml(installId || "(no instalado)")}</code>
                <button class="klosr-desktop-copy-iid" id="klosr-desktop-copy-iid">${isEs ? "Copiar" : "Copy"}</button>
              </div>
            </div>
          </div>
          <div class="klosr-desktop-step">
            <span class="klosr-desktop-step-num">3</span>
            <div>${isEs ? "En Klosr Desktop, pulsa <strong>▶ Start watching</strong> y pica ventana, pantalla o pestaña." : "In Klosr Desktop click <strong>▶ Start watching</strong> and pick a window, screen, or tab."}</div>
          </div>
          <div class="klosr-desktop-step">
            <span class="klosr-desktop-step-num">4</span>
            <div>${isEs ? "Cuando llegue una respuesta, Klosr la redactará y aparecerá el botón <strong>📤 WhatsApp / Gmail / Slack / Teams</strong>." : "When a reply arrives, Klosr drafts it and shows <strong>📤 WhatsApp / Gmail / Slack / Teams</strong> auto-fill buttons."}</div>
          </div>
        </div>

        <div class="briefme-quest-actions">
          <button type="button" class="briefme-quest-back" id="klosr-desktop-back">${isEs ? "Volver" : "Back"}</button>
        </div>
      </div>
    `;

    document.getElementById("klosr-desktop-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    });

    document.getElementById("klosr-desktop-open").addEventListener("click", () => {
      window.open(PWA_URL, "_blank", "noopener,noreferrer");
    });

    const copyBtn = document.getElementById("klosr-desktop-copy-iid");
    if (copyBtn && installId) {
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(installId).then(() => {
          copyBtn.textContent = isEs ? "✓ Copiado" : "✓ Copied";
          setTimeout(() => { copyBtn.textContent = isEs ? "Copiar" : "Copy"; }, 1500);
        });
      });
    }
  }

  async function showDailyCloseView() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";
    logKlosrEvent("daily_close_opened", {});

    content.innerHTML = `<div class="briefme-loading"><div class="briefme-spinner"></div><p>${isEs ? "Priorizando tu día..." : "Prioritizing your day..."}</p></div>`;

    // Auto-ghost stale deals before computing anything.
    await checkGhostedDeals();

    const deals = await getAllDeals();
    const commitments = await getAllPendingCommitments();

    const active = deals.filter(d => !PIPELINE_STAGES_TERMINAL.includes(d.dealStage || d.stage));
    const terminal = deals.filter(d => PIPELINE_STAGES_TERMINAL.includes(d.dealStage || d.stage));
    const wonCount = terminal.filter(d => (d.dealStage || d.stage) === "won").length;
    const lostCount = terminal.filter(d => (d.dealStage || d.stage) === "lost").length;
    const winRate = (wonCount + lostCount) > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : null;

    const STAGE_PROBABILITY = {
      prepped: 0.05, contacted: 0.10, replied: 0.20,
      discovery: 0.30, objection: 0.40,
      negotiation: 0.65, closing: 0.85,
    };
    const closedRevenue = terminal
      .filter(d => (d.dealStage || d.stage) === "won" && typeof d.acv === "number")
      .reduce((sum, d) => sum + d.acv, 0);
    const wonAcvs = terminal
      .filter(d => (d.dealStage || d.stage) === "won" && typeof d.acv === "number")
      .map(d => d.acv).sort((a, b) => a - b);
    const medianAcv = wonAcvs.length ? wonAcvs[Math.floor(wonAcvs.length / 2)] : 5000;
    const pipelineRevenue = active.reduce((sum, d) => {
      const acv = typeof d.acv === "number" ? d.acv : medianAcv;
      const prob = STAGE_PROBABILITY[d.dealStage || d.stage] || 0.05;
      return sum + (acv * prob);
    }, 0);
    const fmtMoney = (n) => {
      if (!n || n < 1) return "$0";
      if (n >= 1000000) return "$" + (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1000) return "$" + (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
      return "$" + Math.round(n).toLocaleString();
    };

    // Temperature buckets — surfaced as a tri-bar for the founder to see
    // their portfolio at a glance.
    const withTemp = active.map(d => ({ deal: d, temp: calcDealTemperature(d) }));
    const hotDeals    = withTemp.filter(x => x.temp.label === "hot").sort((a, b) => b.temp.score - a.temp.score);
    const warmDeals   = withTemp.filter(x => x.temp.label === "warm");
    const coldDeals   = withTemp.filter(x => x.temp.label === "cold");
    const frozenDeals = withTemp.filter(x => x.temp.label === "frozen");

    // Today's actions — the ranked task list.
    const actions = getTodaysActions(deals, commitments);

    const tempBadge = (t) => {
      const icon = t.label === "hot" ? "🔥" : t.label === "warm" ? "☀️" : t.label === "cold" ? "❄️" : "🧊";
      const labelTxt = isEs
        ? ({hot:"caliente",warm:"tibio",cold:"frío",frozen:"congelado"})[t.label]
        : t.label;
      return `<span class="klosr-temp klosr-temp-${t.label}" title="${escapeHtml(t.reason)}">${icon} ${labelTxt} · ${t.score}</span>`;
    };

    const actionCardHtml = (a) => {
      const tempIcon = a.payload?.commitment ? "📌" : a.type === "revive" ? "🧊" : a.type === "multithread" ? "👥" : a.type === "hot_silent" ? "🔥" : a.type === "stuck_closing" ? "🤝" : a.type === "stuck_negot" ? "⚔️" : a.type === "unresolved_obj" ? "🛑" : "📈";
      return `
        <div class="klosr-dc-action" data-action-type="${escapeHtml(a.type)}" data-action-kind="${escapeHtml(a.ctaKind)}" data-deal-url="${escapeHtml(a.dealUrl)}">
          <div class="klosr-dc-action-icon">${tempIcon}</div>
          <div class="klosr-dc-action-body">
            <div class="klosr-dc-action-title">${escapeHtml(a.title)}</div>
            <div class="klosr-dc-action-sub">${escapeHtml(a.subtitle)}</div>
          </div>
          <button class="klosr-dc-action-cta" data-action-cta="${escapeHtml(a.ctaKind)}" data-action-deal="${escapeHtml(a.dealUrl)}" data-action-idx="${escapeHtml(String(actions.indexOf(a)))}">${escapeHtml(a.ctaLabel)}</button>
        </div>
      `;
    };

    // Hot-deals list — just names + temps, one click to open pipeline.
    const hotListHtml = hotDeals.length === 0
      ? `<div class="klosr-dc-empty">${isEs ? "Aún ningún deal caliente. Mete ritmo." : "No hot deals yet. Apply more pressure."}</div>`
      : hotDeals.slice(0, 6).map(({deal: d, temp: t}) => `
        <a class="klosr-dc-hot-row" href="${escapeHtml(d.profileUrl || "")}" target="_blank" rel="noopener">
          <div class="klosr-dc-hot-who">
            <strong>${escapeHtml(d.name || "")}</strong>
            <span class="klosr-dc-hot-stage">${escapeHtml(stageLabel(d.dealStage || d.stage, isEs))}</span>
          </div>
          ${tempBadge(t)}
        </a>
      `).join("");

    content.innerHTML = `
      <div class="klosr-dailyclose">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">⚡ ${isEs ? "Cierra hoy" : "Close today"}</div>
          <div class="briefme-quest-subtitle">${isEs
            ? "Tus acciones de hoy, ordenadas por $ ganado. Un clic por tarea."
            : "Today's actions, ranked by $ won. One click per task."}</div>
        </div>

        <!-- MONEY row -->
        <div class="klosr-dc-kpis">
          <div class="klosr-dc-kpi klosr-dc-kpi-revenue">
            <div class="klosr-dc-kpi-num">${fmtMoney(closedRevenue)}</div>
            <div class="klosr-dc-kpi-label">${isEs ? "Cerrado" : "Closed"}</div>
          </div>
          <div class="klosr-dc-kpi klosr-dc-kpi-pipeline">
            <div class="klosr-dc-kpi-num">${fmtMoney(pipelineRevenue)}</div>
            <div class="klosr-dc-kpi-label">${isEs ? "Pipeline" : "Pipeline"}</div>
          </div>
          <div class="klosr-dc-kpi">
            <div class="klosr-dc-kpi-num">${winRate !== null ? winRate + "%" : "—"}</div>
            <div class="klosr-dc-kpi-label">${isEs ? "Cierre" : "Win rate"}</div>
          </div>
        </div>

        <!-- TEMPERATURE distribution -->
        ${active.length > 0 ? `
        <div class="klosr-dc-temp-bar">
          <div class="klosr-dc-temp-seg klosr-temp-hot"    style="flex:${hotDeals.length}" title="${hotDeals.length} hot">🔥 ${hotDeals.length}</div>
          <div class="klosr-dc-temp-seg klosr-temp-warm"   style="flex:${warmDeals.length}" title="${warmDeals.length} warm">☀️ ${warmDeals.length}</div>
          <div class="klosr-dc-temp-seg klosr-temp-cold"   style="flex:${coldDeals.length}" title="${coldDeals.length} cold">❄️ ${coldDeals.length}</div>
          <div class="klosr-dc-temp-seg klosr-temp-frozen" style="flex:${frozenDeals.length}" title="${frozenDeals.length} frozen">🧊 ${frozenDeals.length}</div>
        </div>
        ` : ""}

        <!-- TODAY'S ACTIONS -->
        <section class="klosr-dc-section">
          <div class="klosr-dc-section-head">
            <h3>🎯 ${isEs ? "Haz esto hoy" : "Do this today"}</h3>
            <span class="klosr-dc-section-count">${actions.length}</span>
          </div>
          <div class="klosr-dc-actions">
            ${actions.length === 0
              ? `<div class="klosr-dc-empty">${isEs ? "Sin acciones pendientes. Prospecta o añade deals al pipeline." : "No actions pending. Prospect more or add deals to pipeline."}</div>`
              : actions.map(actionCardHtml).join("")}
          </div>
        </section>

        <!-- HOT DEALS -->
        <section class="klosr-dc-section">
          <div class="klosr-dc-section-head">
            <h3>🔥 ${isEs ? "Deals calientes" : "Hot deals"}</h3>
            <span class="klosr-dc-section-count">${hotDeals.length}</span>
          </div>
          <div class="klosr-dc-hot-list">${hotListHtml}</div>
        </section>

        <div class="briefme-quest-actions">
          <button type="button" class="briefme-quest-back" id="klosr-dc-back">${isEs ? "Volver" : "Back"}</button>
          <button type="button" class="briefme-quest-submit" id="klosr-dc-pipeline">${isEs ? "Ver pipeline completo" : "Full pipeline"}</button>
        </div>
      </div>
    `;

    document.getElementById("klosr-dc-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    });
    document.getElementById("klosr-dc-pipeline").addEventListener("click", () => {
      showDealPipelineView();
    });

    // Action button handlers — dispatch on ctaKind.
    content.querySelectorAll("[data-action-cta]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const kind = btn.dataset.actionCta;
        const dealUrl = btn.dataset.actionDeal;
        const idx = parseInt(btn.dataset.actionIdx, 10);
        const action = actions[idx];
        logKlosrEvent("daily_close_action_clicked", { kind, type: action?.type });
        await handleDailyCloseAction(kind, action, dealUrl);
      });
    });

    // Whole-row click (outside the CTA button) opens the profile — common
    // quick-nav pattern.
    content.querySelectorAll(".klosr-dc-action").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-action-cta]")) return;
        const url = row.dataset.dealUrl;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      });
    });
  }

  // Handlers for Daily Close action buttons. Dispatched by ctaKind:
  //   draft_overdue_nudge / draft_commitment_followup / revive_deal /
  //   reengage_hot / multithread_suggest / handle_objection / open_deal.
  async function handleDailyCloseAction(kind, action, dealUrl) {
    const isEs = currentLanguage === "es";
    try {
      if (kind === "open_deal") {
        showDealPipelineView();
        return;
      }

      if (kind === "revive_deal" || kind === "reengage_hot") {
        // Fetch the deal + fresh company news, draft a revival angle.
        const deal = await getDeal(dealUrl);
        if (!deal) { showKlosrToast(isEs ? "Deal no encontrado" : "Deal not found"); return; }
        showKlosrToast(isEs ? "🧊 Buscando ángulo fresco..." : "🧊 Finding a fresh angle...");
        const res = await callIntel("deal-revival-draft", {
          deal: {
            name: deal.name || "",
            currentRole: deal.currentRole || deal.headline || "",
            currentCompany: deal.currentCompany || "",
            profileUrl: deal.profileUrl || "",
            dealStage: deal.dealStage || deal.stage,
            lastActivityAt: deal.lastActivityAt || deal.savedAt,
            commitments: (deal.commitments || []).slice(-5),
            objections: (deal.objections || []).slice(-5),
            buyingSignals: (deal.buyingSignals || []).slice(-5),
          },
          founder: {
            name: (companyProfile && companyProfile.yourName) || "",
            company: (companyProfile && companyProfile.companyName) || "",
            whatYouSell: (companyProfile && companyProfile.whatYouSell) || "",
            valueProp: (companyProfile && companyProfile.valueProp) || "",
            icp: (companyProfile && companyProfile.icp) || "",
          },
          language: currentLanguage,
        });
        if (!res || !res.draft) {
          showKlosrToast(isEs ? "No se pudo generar un ángulo" : "Couldn't find a fresh angle");
          return;
        }
        renderRevivalDraftModal(res, deal);
        return;
      }

      if (kind === "multithread_suggest") {
        const deal = await getDeal(dealUrl);
        if (!deal) { showKlosrToast(isEs ? "Deal no encontrado" : "Deal not found"); return; }
        showKlosrToast(isEs ? "👥 Buscando 2º contacto..." : "👥 Finding a 2nd stakeholder...");
        const res = await callIntel("multi-thread-suggest", {
          companyName: deal.currentCompany || "",
          companyDomain: deal.companyDomain || "",
          existingContact: {
            name: deal.name || "",
            title: deal.currentRole || deal.headline || "",
          },
          founder: {
            whatYouSell: (companyProfile && companyProfile.whatYouSell) || "",
            icp: (companyProfile && companyProfile.icp) || "",
          },
        });
        if (!res || !Array.isArray(res.suggestions) || res.suggestions.length === 0) {
          showKlosrToast(isEs ? "Sin sugerencias — prueba otro deal" : "No suggestions — try another deal");
          return;
        }
        renderMultithreadModal(res.suggestions, deal);
        return;
      }

      if (kind === "draft_overdue_nudge" || kind === "draft_commitment_followup") {
        const deal = await getDeal(dealUrl);
        if (!deal) { showKlosrToast(isEs ? "Deal no encontrado" : "Deal not found"); return; }
        const commitment = action?.payload?.commitment;
        showKlosrToast(isEs ? "✍ Generando mensaje..." : "✍ Drafting message...");
        const res = await callIntel("deal-revival-draft", {
          deal: {
            name: deal.name || "",
            currentRole: deal.currentRole || deal.headline || "",
            currentCompany: deal.currentCompany || "",
            profileUrl: deal.profileUrl || "",
            dealStage: deal.dealStage || deal.stage,
            lastActivityAt: deal.lastActivityAt || deal.savedAt,
            commitments: (deal.commitments || []).slice(-5),
          },
          founder: {
            name: (companyProfile && companyProfile.yourName) || "",
            company: (companyProfile && companyProfile.companyName) || "",
            whatYouSell: (companyProfile && companyProfile.whatYouSell) || "",
          },
          nudgeFor: commitment?.text || "",
          nudgeOverdue: kind === "draft_overdue_nudge",
          language: currentLanguage,
        });
        if (!res || !res.draft) {
          showKlosrToast(isEs ? "No se pudo redactar" : "Couldn't draft");
          return;
        }
        renderRevivalDraftModal(res, deal, commitment);
        return;
      }

      if (kind === "handle_objection") {
        // Open the prospect's LinkedIn and let the sidebar switch over.
        if (dealUrl) window.open(dealUrl, "_blank", "noopener,noreferrer");
        showKlosrToast(isEs ? "Abriendo perfil — usa Klosr > Responder a mensaje" : "Opening profile — use Klosr > Handle a reply");
        return;
      }
    } catch (err) {
      console.error("[Klosr daily-close] action failed:", err);
      showKlosrToast(isEs ? "Error en la acción" : "Action failed");
    }
  }

  // Simple modal: shows the drafted message, copy button, LinkedIn DM
  // shortcut, and mark-done (for commitments).
  function renderRevivalDraftModal(res, deal, commitment) {
    const isEs = currentLanguage === "es";
    const modal = document.createElement("div");
    modal.className = "klosr-dc-modal";
    modal.innerHTML = `
      <div class="klosr-dc-modal-inner">
        <div class="klosr-dc-modal-head">
          <div class="klosr-dc-modal-title">${escapeHtml(res.headline || (isEs ? "Mensaje redactado" : "Draft ready"))}</div>
          <button class="klosr-dc-modal-close" id="klosr-dc-modal-close">×</button>
        </div>
        ${res.angle ? `<div class="klosr-dc-modal-angle"><strong>${isEs ? "Ángulo:" : "Angle:"}</strong> ${escapeHtml(res.angle)}</div>` : ""}
        <div class="klosr-dc-modal-body">
          <textarea class="klosr-dc-modal-text" id="klosr-dc-draft-text" rows="8">${escapeHtml(res.draft || "")}</textarea>
        </div>
        ${Array.isArray(res.whyThisWorks) && res.whyThisWorks.length ? `
          <div class="klosr-dc-modal-why">
            <div class="klosr-dc-modal-why-title">${isEs ? "Por qué funciona" : "Why it works"}</div>
            <ul>${res.whyThisWorks.slice(0, 3).map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
          </div>
        ` : ""}
        <div class="klosr-dc-modal-actions">
          <button class="klosr-foot-btn klosr-dc-modal-btn" id="klosr-dc-copy">${isEs ? "Copiar" : "Copy"}</button>
          <a class="klosr-foot-btn klosr-dc-modal-btn" href="${escapeHtml(deal.profileUrl || "")}" target="_blank" rel="noopener">${isEs ? "Abrir LinkedIn" : "Open LinkedIn"}</a>
          ${commitment ? `<button class="klosr-foot-btn klosr-dc-modal-btn" id="klosr-dc-mark-done">${isEs ? "Marcar compromiso hecho" : "Mark commitment done"}</button>` : ""}
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector("#klosr-dc-modal-close").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

    modal.querySelector("#klosr-dc-copy").addEventListener("click", () => {
      const ta = modal.querySelector("#klosr-dc-draft-text");
      navigator.clipboard.writeText(ta.value).then(() => {
        showKlosrToast(isEs ? "Copiado al portapapeles" : "Copied to clipboard");
      });
    });

    const markDone = modal.querySelector("#klosr-dc-mark-done");
    if (markDone && commitment && deal) {
      markDone.addEventListener("click", async () => {
        const idx = (deal.commitments || []).findIndex(c => c && c.text === commitment.text && c.ts === commitment.ts);
        if (idx >= 0) {
          await toggleCommitmentDone(deal.profileUrl, idx);
          showKlosrToast(isEs ? "Compromiso marcado hecho" : "Commitment marked done");
        }
        close();
        showDailyCloseView();
      });
    }
  }

  // Multi-thread suggestion modal: shows up to 3 other decision-makers at
  // the same company, each with role + seniority + why they matter. Click
  // opens their LinkedIn in a new tab so the founder can connect + draft.
  function renderMultithreadModal(suggestions, deal) {
    const isEs = currentLanguage === "es";
    const modal = document.createElement("div");
    modal.className = "klosr-dc-modal";
    modal.innerHTML = `
      <div class="klosr-dc-modal-inner">
        <div class="klosr-dc-modal-head">
          <div class="klosr-dc-modal-title">👥 ${isEs ? "Pulla a estos al deal" : "Pull these people in"}</div>
          <button class="klosr-dc-modal-close" id="klosr-dc-mt-close">×</button>
        </div>
        <div class="klosr-dc-modal-sub">${isEs ? `En ${escapeHtml(deal.currentCompany || "")} — deals con 1 contacto mueren. Abre un 2º frente.` : `At ${escapeHtml(deal.currentCompany || "")} — single-threaded deals die. Open a second front.`}</div>
        <div class="klosr-dc-mt-list">
          ${suggestions.slice(0, 4).map(s => `
            <div class="klosr-dc-mt-row">
              <div class="klosr-dc-mt-who">
                <strong>${escapeHtml(s.name || "")}</strong>
                <span class="klosr-dc-mt-title">${escapeHtml(s.title || "")}</span>
              </div>
              ${s.reason ? `<div class="klosr-dc-mt-reason">${escapeHtml(s.reason)}</div>` : ""}
              <div class="klosr-dc-mt-actions">
                ${s.linkedinUrl ? `<a class="klosr-foot-btn klosr-dc-modal-btn" href="${escapeHtml(s.linkedinUrl)}" target="_blank" rel="noopener">${isEs ? "Ver LinkedIn" : "Open LinkedIn"}</a>` : ""}
                ${s.email ? `<button class="klosr-foot-btn klosr-dc-modal-btn klosr-dc-mt-copy-email" data-email="${escapeHtml(s.email)}">${isEs ? "Copiar email" : "Copy email"}</button>` : ""}
              </div>
            </div>
          `).join("")}
        </div>
        <div class="klosr-dc-modal-actions">
          <button class="klosr-foot-btn klosr-dc-modal-btn" id="klosr-dc-mt-done">${isEs ? "Marcar hecho" : "Mark done"}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector("#klosr-dc-mt-close").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

    modal.querySelectorAll(".klosr-dc-mt-copy-email").forEach(btn => {
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(btn.dataset.email).then(() => {
          showKlosrToast(isEs ? "Email copiado" : "Email copied");
        });
      });
    });

    // Mark done: set multithreadDone flag on the deal so we don't keep
    // surfacing the same suggestion.
    modal.querySelector("#klosr-dc-mt-done").addEventListener("click", async () => {
      await upsertDeal(deal, { multithreadDone: true });
      close();
      showKlosrToast(isEs ? "Acción marcada hecha" : "Marked done");
      showDailyCloseView();
    });
  }

  async function showDealPipelineView() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";
    logKlosrEvent("pipeline_opened", {});

    content.innerHTML = `<div class="briefme-loading"><div class="briefme-spinner"></div><p>${isEs ? "Cargando pipeline..." : "Loading pipeline..."}</p></div>`;

    // Auto-ghost stale deals (14+ days no activity on prepped/contacted/replied)
    // BEFORE we read the list so they land in the right section.
    const ghostedCount = await checkGhostedDeals();
    if (ghostedCount > 0) {
      showKlosrToast(isEs
        ? `👻 ${ghostedCount} deal${ghostedCount > 1 ? "s" : ""} movido${ghostedCount > 1 ? "s" : ""} a "silenciado" (14+ días sin actividad)`
        : `👻 ${ghostedCount} deal${ghostedCount > 1 ? "s" : ""} auto-ghosted (14+ days no activity)`);
    }

    const deals = await getAllDeals();
    const commitments = await getAllPendingCommitments();

    // Partition: active vs terminal (won/lost/ghosted)
    const active = deals
      .filter(d => !PIPELINE_STAGES_TERMINAL.includes(d.dealStage || d.stage))
      .sort((a, b) => dealUrgencyScore(b) - dealUrgencyScore(a));
    const terminal = deals
      .filter(d => PIPELINE_STAGES_TERMINAL.includes(d.dealStage || d.stage))
      .sort((a, b) => (b.closedAt || b.lastActivityAt || 0) - (a.closedAt || a.lastActivityAt || 0));

    const wonCount = terminal.filter(d => (d.dealStage || d.stage) === "won").length;
    const lostCount = terminal.filter(d => (d.dealStage || d.stage) === "lost").length;
    const winRate = (wonCount + lostCount) > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : null;

    // Revenue math — only from deals where user provided ACV on close.
    // Closed revenue = sum of won ACVs. Pipeline revenue = weighted estimate
    // using stage probabilities (sales-ops-standard weights).
    const STAGE_PROBABILITY = {
      prepped: 0.05, contacted: 0.10, replied: 0.20,
      discovery: 0.30, objection: 0.40,
      negotiation: 0.65, closing: 0.85,
    };
    const closedRevenue = terminal
      .filter(d => (d.dealStage || d.stage) === "won" && typeof d.acv === "number")
      .reduce((sum, d) => sum + d.acv, 0);
    // Use the median ACV of won deals as the estimate for active deals without
    // user-supplied ACV. Falls back to 5000 if no wins yet.
    const wonAcvs = terminal
      .filter(d => (d.dealStage || d.stage) === "won" && typeof d.acv === "number")
      .map(d => d.acv)
      .sort((a, b) => a - b);
    const medianAcv = wonAcvs.length
      ? wonAcvs[Math.floor(wonAcvs.length / 2)]
      : 5000;
    const pipelineRevenue = active.reduce((sum, d) => {
      const acv = typeof d.acv === "number" ? d.acv : medianAcv;
      const prob = STAGE_PROBABILITY[d.dealStage || d.stage] || 0.05;
      return sum + (acv * prob);
    }, 0);
    const fmtMoney = (n) => {
      if (!n || n < 1) return "$0";
      if (n >= 1000000) return "$" + (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1000) return "$" + (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
      return "$" + Math.round(n).toLocaleString();
    };

    // Stuck deals — in negotiation 14+ days or closing 7+ days means the
    // user needs to push. Surface as a prominent alert at the top of the
    // pipeline so they don't slip through the cracks.
    const now = Date.now();
    const stuck = active.filter(d => {
      const stage = d.dealStage || d.stage;
      const daysSince = (now - (d.lastActivityAt || d.savedAt || 0)) / 86400000;
      if (stage === "negotiation" && daysSince >= 14) return true;
      if (stage === "closing" && daysSince >= 7) return true;
      if (stage === "objection" && daysSince >= 10) return true;
      return false;
    });

    const fmtDateShort = (ts, isEs) => {
      if (!ts) return isEs ? "sin fecha" : "no date";
      const d = new Date(Number(ts));
      const now = Date.now();
      const diff = ts - now;
      const daysDiff = Math.round(diff / 86400000);
      if (diff < 0) {
        const daysOver = Math.abs(daysDiff);
        return isEs ? `atrasado ${daysOver}d` : `overdue ${daysOver}d`;
      }
      if (daysDiff === 0) return isEs ? "hoy" : "today";
      if (daysDiff === 1) return isEs ? "mañana" : "tomorrow";
      if (daysDiff < 7) return isEs ? `en ${daysDiff}d` : `in ${daysDiff}d`;
      return d.toISOString().slice(0, 10);   // fallback YYYY-MM-DD
    };
    const tsToInputDate = (ts) => {
      const d = ts ? new Date(Number(ts)) : new Date();
      // Returns YYYY-MM-DD in the user's local timezone — what <input type="date"> expects.
      return d.toISOString().slice(0, 10);
    };

    const commitmentsHtml = commitments.length === 0
      ? `<div class="klosr-pl-empty">${isEs ? "Sin compromisos pendientes." : "No pending commitments."}</div>`
      : commitments.slice(0, 20).map((c, i) => {
          const overdue = c.dueBy && c.dueBy < Date.now();
          const dueText = fmtDateShort(c.dueBy, isEs);
          // Find this commitment's index inside its deal for the actions
          const dealCommIdx = (c.deal.commitments || []).findIndex(x => x && x.text === c.text && x.ts === c.ts);
          return `
          <div class="klosr-pl-commitment ${overdue ? 'klosr-pl-overdue' : ''}">
            <button class="klosr-pl-commit-check" data-commit-toggle="${escapeHtml(c.deal.profileUrl)}" data-commit-idx="${dealCommIdx}" title="${isEs ? "Marcar hecho" : "Mark done"}">☐</button>
            <div class="klosr-pl-commit-body">
              <div class="klosr-pl-commit-text">${escapeHtml(c.text)}</div>
              <div class="klosr-pl-commit-meta">
                <a class="klosr-pl-commit-who" href="${escapeHtml(c.deal.profileUrl)}" target="_blank" rel="noopener">${escapeHtml(c.deal.name || c.deal.currentCompany || "")}</a>
                <button class="klosr-pl-commit-due ${c.dueBy ? '' : 'klosr-pl-commit-due-empty'}"
                        data-commit-due-edit="${escapeHtml(c.deal.profileUrl)}"
                        data-commit-due-idx="${dealCommIdx}"
                        data-commit-current="${c.dueBy ? tsToInputDate(c.dueBy) : ''}"
                        title="${isEs ? "Clic para editar fecha" : "Click to set due date"}">· ${escapeHtml(dueText)}</button>
              </div>
            </div>
          </div>`;
        }).join("");

    const dealCardHtml = (d) => {
      const stage = d.dealStage || d.stage || "prepped";
      const pendingCount = (d.commitments || []).filter(c => !c.doneAt).length;
      const initials = (d.name || "?").trim().charAt(0).toUpperCase();
      // Deal temperature — shown prominently so founders can sort in their
      // head as they scan. Reason is surfaced via tooltip.
      const temp = calcDealTemperature(d);
      const tempIcon = temp.label === "hot" ? "🔥" : temp.label === "warm" ? "☀️" : temp.label === "cold" ? "❄️" : "🧊";
      const tempLabel = isEs
        ? ({hot:"caliente",warm:"tibio",cold:"frío",frozen:"congelado"})[temp.label]
        : temp.label;
      // Actionable buttons shown based on stage + temperature. Revive is the
      // highest-value shortcut: one click drafts a re-engagement message.
      const isTerminalStage = PIPELINE_STAGES_TERMINAL.includes(stage);
      const daysSinceAct = (Date.now() - (d.lastActivityAt || d.savedAt || 0)) / 86400000;
      const showRevive = !isTerminalStage && (temp.label === "cold" || temp.label === "frozen" || daysSinceAct >= 7);
      const showMultithread = !isTerminalStage && !d.multithreadDone && ["discovery","objection","negotiation","closing"].includes(stage);
      return `
        <div class="klosr-pl-deal ${stageClass(stage)} klosr-pl-temp-${temp.label}" data-deal-url="${escapeHtml(d.profileUrl || "")}">
          <div class="klosr-pl-deal-head">
            <div class="klosr-pl-deal-avatar">
              ${d.photoUrl ? `<img src="${escapeHtml(d.photoUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" />` : `<span>${escapeHtml(initials)}</span>`}
            </div>
            <div class="klosr-pl-deal-who">
              <div class="klosr-pl-deal-name">${escapeHtml(d.name || "")}</div>
              ${d.currentCompany || d.currentRole
                ? `<div class="klosr-pl-deal-sub">${escapeHtml(d.currentRole || "")}${d.currentRole && d.currentCompany ? " · " : ""}${escapeHtml(d.currentCompany || "")}</div>`
                : ""}
            </div>
            <div class="klosr-pl-deal-stage-wrap">
              ${!isTerminalStage ? `<span class="klosr-temp klosr-temp-${temp.label}" title="${escapeHtml(temp.reason)}">${tempIcon} ${escapeHtml(tempLabel)}</span>` : ""}
              <span class="klosr-pl-stage-pill ${stageClass(stage)}">${escapeHtml(stageLabel(stage, isEs))}</span>
            </div>
          </div>
          <div class="klosr-pl-deal-meta">
            <span class="klosr-pl-meta-item" title="${isEs ? "Última actividad" : "Last activity"}">🕒 ${fmtRelativeTime(d.lastActivityAt || d.savedAt, isEs)}</span>
            ${typeof d.acv === "number" && d.acv > 0 ? `<span class="klosr-pl-meta-item klosr-pl-meta-acv" title="${isEs ? "Valor del deal" : "Deal value"}">💰 ${fmtMoney(d.acv)}</span>` : ""}
            ${d.callsHad ? `<span class="klosr-pl-meta-item" title="${isEs ? "Llamadas" : "Calls"}">📞 ${d.callsHad}</span>` : ""}
            ${d.emailsSent ? `<span class="klosr-pl-meta-item" title="${isEs ? "Emails" : "Emails"}">✉️ ${d.emailsSent}</span>` : ""}
            ${pendingCount ? `<span class="klosr-pl-meta-item klosr-pl-meta-alert" title="${isEs ? "Compromisos pendientes" : "Pending commitments"}">📌 ${pendingCount}</span>` : ""}
            ${!isTerminalStage ? `<span class="klosr-pl-meta-item klosr-pl-meta-reason" title="${escapeHtml(temp.reason)}">💡 ${escapeHtml(temp.reason)}</span>` : ""}
          </div>
          <div class="klosr-pl-deal-actions">
            <a class="klosr-pl-action" href="${escapeHtml(d.profileUrl || "")}" target="_blank" rel="noopener">👤 ${isEs ? "LinkedIn" : "LinkedIn"}</a>
            <button class="klosr-pl-action klosr-pl-stage-edit" data-deal-stage-edit="${escapeHtml(d.profileUrl)}">🎯 ${isEs ? "Etapa" : "Stage"}</button>
            ${showRevive ? `<button class="klosr-pl-action klosr-pl-revive" data-deal-revive="${escapeHtml(d.profileUrl)}" title="${isEs ? "Genera un mensaje para reactivar el deal" : "Draft a message to revive this deal"}">🧊 ${isEs ? "Revivir" : "Revive"}</button>` : ""}
            ${showMultithread ? `<button class="klosr-pl-action klosr-pl-multi" data-deal-multi="${escapeHtml(d.profileUrl)}" title="${isEs ? "Encuentra otro decisor en la empresa" : "Find another decision-maker at this company"}">👥 ${isEs ? "2º contacto" : "2nd contact"}</button>` : ""}
            <button class="klosr-pl-action klosr-pl-won" data-deal-won="${escapeHtml(d.profileUrl)}">✅ ${isEs ? "Ganado" : "Won"}</button>
            <button class="klosr-pl-action klosr-pl-lost" data-deal-lost="${escapeHtml(d.profileUrl)}">❌ ${isEs ? "Perdido" : "Lost"}</button>
          </div>
        </div>`;
    };

    content.innerHTML = `
      <div class="klosr-pipeline">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">📊 ${isEs ? "Pipeline" : "Pipeline"}</div>
          <div class="briefme-quest-subtitle">${isEs ? "Tus deals en una vista. Cierra más." : "All your deals in one view. Close more."}</div>
        </div>

        <!-- Primary KPI row: money. This is what a founder opens Klosr to see. -->
        <div class="klosr-pl-kpis klosr-pl-kpis-money">
          <div class="klosr-pl-kpi klosr-pl-kpi-revenue">
            <div class="klosr-pl-kpi-num">${fmtMoney(closedRevenue)}</div>
            <div class="klosr-pl-kpi-label">${isEs ? "Revenue cerrado" : "Closed revenue"}</div>
          </div>
          <div class="klosr-pl-kpi klosr-pl-kpi-pipeline">
            <div class="klosr-pl-kpi-num">${fmtMoney(pipelineRevenue)}</div>
            <div class="klosr-pl-kpi-label">${isEs ? "Pipeline (ponderado)" : "Pipeline (weighted)"}</div>
          </div>
          <div class="klosr-pl-kpi">
            <div class="klosr-pl-kpi-num">${winRate !== null ? winRate + "%" : "—"}</div>
            <div class="klosr-pl-kpi-label">${isEs ? "Cierre" : "Win rate"}</div>
          </div>
        </div>

        <!-- Secondary KPI row: volumes -->
        <div class="klosr-pl-kpis klosr-pl-kpis-volume">
          <div class="klosr-pl-kpi-mini"><span>${active.length}</span> ${isEs ? "activos" : "active"}</div>
          <div class="klosr-pl-kpi-mini"><span>${commitments.length}</span> ${isEs ? "pendientes" : "pending"}</div>
          <div class="klosr-pl-kpi-mini"><span>${wonCount}</span> ${isEs ? "ganados" : "won"}</div>
          <div class="klosr-pl-kpi-mini"><span>${lostCount}</span> ${isEs ? "perdidos" : "lost"}</div>
        </div>

        ${stuck.length > 0 ? `
          <div class="klosr-pl-stuck-alert">
            <div class="klosr-pl-stuck-head">🚨 ${stuck.length} ${isEs ? `deal${stuck.length > 1 ? "s" : ""} atascado${stuck.length > 1 ? "s" : ""} — muévelo${stuck.length > 1 ? "s" : ""} o cierra como perdido` : `deal${stuck.length > 1 ? "s" : ""} stuck — push or kill`}</div>
            <div class="klosr-pl-stuck-list">
              ${stuck.slice(0, 5).map(d => {
                const stage = d.dealStage || d.stage;
                const days = Math.round((now - (d.lastActivityAt || d.savedAt || 0)) / 86400000);
                return `<a class="klosr-pl-stuck-row" href="${escapeHtml(d.profileUrl || "")}" target="_blank" rel="noopener"><strong>${escapeHtml(d.name || "")}</strong> · ${escapeHtml(stageLabel(stage, isEs))} ${days}${isEs ? "d" : "d"}</a>`;
              }).join("")}
            </div>
          </div>
        ` : ""}

        <section class="klosr-pl-section">
          <div class="klosr-pl-section-head">
            <h3>📌 ${isEs ? "Compromisos pendientes" : "Pending commitments"}</h3>
            <span class="klosr-pl-section-count">${commitments.length}</span>
          </div>
          <div class="klosr-pl-commits">${commitmentsHtml}</div>
        </section>

        <section class="klosr-pl-section">
          <div class="klosr-pl-section-head">
            <h3>🔥 ${isEs ? "Deals activos" : "Active deals"}</h3>
            <span class="klosr-pl-section-count">${active.length}</span>
          </div>
          <div class="klosr-pl-deals">
            ${active.length === 0
              ? `<div class="klosr-pl-empty">${isEs ? "Aún sin deals activos. Prepara un prospecto en LinkedIn para añadirlo aquí." : "No active deals yet. Prep a prospect on LinkedIn to add them here."}</div>`
              : active.map(dealCardHtml).join("")}
          </div>
        </section>

        ${terminal.length > 0 ? `
          <section class="klosr-pl-section klosr-pl-section-closed">
            <div class="klosr-pl-section-head">
              <h3>✅ ${isEs ? "Cerrados" : "Closed"}</h3>
              <span class="klosr-pl-section-count">${terminal.length}</span>
            </div>
            <div class="klosr-pl-deals">
              ${terminal.slice(0, 20).map(dealCardHtml).join("")}
            </div>
          </section>
        ` : ""}

        <div class="briefme-quest-actions">
          <button type="button" class="briefme-quest-back" id="klosr-pl-back">${isEs ? "Volver" : "Back"}</button>
        </div>
      </div>
    `;

    document.getElementById("klosr-pl-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    });

    // Commitment done-toggle
    content.querySelectorAll("[data-commit-toggle]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const url = btn.dataset.commitToggle;
        const idx = parseInt(btn.dataset.commitIdx, 10);
        if (!url || Number.isNaN(idx)) return;
        await toggleCommitmentDone(url, idx);
        showDealPipelineView();   // re-render
      });
    });

    // Commitment due-date editor — swap button for <input type="date"> in-place.
    // User picks a date → save → re-render. Blur without change → revert.
    content.querySelectorAll("[data-commit-due-edit]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const url = btn.dataset.commitDueEdit;
        const idx = parseInt(btn.dataset.commitDueIdx, 10);
        const current = btn.dataset.commitCurrent;
        if (!url || Number.isNaN(idx)) return;

        const input = document.createElement("input");
        input.type = "date";
        input.className = "klosr-pl-commit-due-input";
        if (current) input.value = current;
        btn.replaceWith(input);
        input.focus();

        let committed = false;
        const save = async (val) => {
          if (committed) return;
          committed = true;
          if (val) {
            const parts = val.split("-").map(Number);
            // Treat the chosen date as end-of-day local so "due today" isn't overdue by noon.
            const ts = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1, 23, 59, 59).getTime();
            await setCommitmentDueBy(url, idx, ts);
          } else {
            await setCommitmentDueBy(url, idx, null);
          }
          showDealPipelineView();
        };
        input.addEventListener("change", () => save(input.value));
        input.addEventListener("blur", () => { if (!committed) showDealPipelineView(); });
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { save(input.value); }
          if (ev.key === "Escape") { showDealPipelineView(); }
        });
      });
    });

    // Stage editor — tiny inline dropdown that replaces the action button
    content.querySelectorAll("[data-deal-stage-edit]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const url = btn.dataset.dealStageEdit;
        const stages = ["prepped", "contacted", "replied", "discovery", "objection", "negotiation", "closing", "ghosted"];
        const picker = document.createElement("select");
        picker.className = "klosr-pl-stage-select";
        for (const s of stages) {
          const opt = document.createElement("option");
          opt.value = s; opt.textContent = stageLabel(s, isEs);
          picker.appendChild(opt);
        }
        btn.replaceWith(picker);
        picker.focus();
        picker.addEventListener("change", async () => {
          await setDealStage(url, picker.value);
          showDealPipelineView();
        });
        picker.addEventListener("blur", () => showDealPipelineView());
      });
    });

    // Won — collect ACV (deal value) + closing notes, then mark + ICP learning.
    // ACV feeds the pipeline $ KPI + per-deal revenue tracking. Closing notes
    // feed Claude's proof-extractor → auto-proof-library entry.
    content.querySelectorAll("[data-deal-won]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const url = btn.dataset.dealWon;
        const acvRaw = prompt(isEs
          ? "💰 Valor del deal en USD (ACV — opcional pero recomendado para tracking de revenue):"
          : "💰 Deal value in USD (ACV — optional but recommended for revenue tracking):", "");
        // Parse — strips $ , k K suffixes. "$4,900" → 4900, "10k" → 10000
        let acv = null;
        if (acvRaw) {
          const cleaned = acvRaw.replace(/[$,\s]/g, "").toLowerCase();
          const num = parseFloat(cleaned);
          if (!isNaN(num) && num > 0) {
            acv = /k\b|k$/i.test(cleaned) ? num * 1000
                : /m\b|m$/i.test(cleaned) ? num * 1000000
                : num;
          }
        }
        const notes = prompt(isEs
          ? "🔑 ¿Qué cerró este deal? (alimenta biblioteca de pruebas + aprendizaje ICP)"
          : "🔑 What closed this deal? (feeds proof library + ICP learning)", "") || "";
        await markDealWonOrLost(url, true, notes, acv);
        // Proof library just grew + ICP learning refreshed — push to cloud
        // so the PWA's Vision drafts use the new context immediately.
        syncStateToCloud(true).catch(() => {});
        showDealPipelineView();
      });
    });
    content.querySelectorAll("[data-deal-lost]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const url = btn.dataset.dealLost;
        const notes = prompt(isEs ? "¿Por qué se perdió este deal? (opcional — alimenta aprendizaje ICP)" : "Why was this deal lost? (optional — feeds ICP learning)", "") || "";
        await markDealWonOrLost(url, false, notes);
        syncStateToCloud(true).catch(() => {});
        showDealPipelineView();
      });
    });

    // Revive — one-click draft a re-engagement message for a stuck deal.
    // Delegates to the same handler the Daily Close Dashboard uses so the
    // modal + UX is consistent.
    content.querySelectorAll("[data-deal-revive]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = btn.dataset.dealRevive;
        logKlosrEvent("pipeline_revive_clicked", { dealUrl: url });
        await handleDailyCloseAction("revive_deal", null, url);
      });
    });

    // Multi-thread — find other decision-makers at the same company.
    content.querySelectorAll("[data-deal-multi]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = btn.dataset.dealMulti;
        logKlosrEvent("pipeline_multithread_clicked", { dealUrl: url });
        await handleDailyCloseAction("multithread_suggest", null, url);
      });
    });
  }

  async function showWarmLeadsView() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";

    // Gate: warm leads filter ONLY makes sense against a user ICP.
    // Without an ICP, we'd be serving a generic "recent job changes" feed,
    // which isn't useful — block the view and point the user to setup.
    const cpGate = companyProfile || {};
    const icpDeclared = (cpGate.icp || "").trim();
    const icpObj = await getICPLearnings();
    const icpEmpirical = (icpObj && icpObj.icpSummary) || "";

    if (!icpDeclared && !icpEmpirical) {
      content.innerHTML = `
        <div class="briefme-warm-view">
          <div class="briefme-quest-header">
            <div class="briefme-quest-title">🔥 ${isEs ? "Leads calientes" : "Warm leads"}</div>
            <div class="briefme-quest-subtitle">${isEs
              ? "Para filtrar leads a TU negocio, Klosr necesita saber qué vendes y a quién."
              : "To filter leads to YOUR business, Klosr needs to know what you sell and who you sell to."}</div>
          </div>
          <div class="briefme-warm-empty">
            ${isEs
              ? "Tu ICP aún no está configurado. Rellena \"¿A quién le vendes?\" en ajustes para que los leads se filtren a tu producto."
              : "Your ICP isn't set yet. Fill in \"Who you sell to\" in settings so leads are filtered to your product."}
          </div>
          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-warm-back">${isEs ? "Volver" : "Back"}</button>
            <button type="button" class="briefme-quest-submit" id="briefme-warm-setup">${isEs ? "Configurar ICP" : "Set up ICP"}</button>
          </div>
        </div>
      `;
      document.getElementById("briefme-warm-back").addEventListener("click", () => {
        sidebar.classList.remove("briefme-picker-view");
        showModePicker();
      });
      document.getElementById("briefme-warm-setup").addEventListener("click", () => {
        sidebar.classList.remove("briefme-picker-view");
        showCompanySetup("picker");
      });
      return;
    }

    // Active ICP to filter on — empirical (learned from outcomes) wins
    // over declared when both exist, because it's what ACTUALLY closes.
    const activeIcp = icpEmpirical || icpDeclared;
    const icpSource = icpEmpirical ? "empirical" : "declared";
    const sourceLabel = icpSource === "empirical"
      ? (isEs ? "(aprendido de ganados/perdidos)" : "(learned from wins/losses)")
      : (isEs ? "(de tu perfil)" : "(from your profile)");

    content.innerHTML = `
      <div class="briefme-warm-view">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">🤝 ${isEs ? "Leads cálidos" : "Warm leads"}</div>
          <div class="briefme-quest-subtitle">${isEs
            ? "Prospectos en TU red (1º + 2º grado) que coinciden con tu ICP — el camino más corto a un sí."
            : "Prospects in YOUR network (1st + 2nd degree) matching your ICP — the shortest path to yes."}</div>
        </div>

        <div class="briefme-warm-icp-bar">
          <div class="briefme-warm-icp-label">
            ${isEs ? "Buscando por tu ICP" : "Searching by your ICP"} <span class="briefme-warm-icp-source">${sourceLabel}</span>
          </div>
          <div class="briefme-warm-icp-text">${escapeHtml(activeIcp.slice(0, 280))}</div>
          ${icpLooksGeneric(activeIcp) ? `
            <div class="briefme-warm-icp-warning">
              ⚠ ${isEs
                ? "Tu ICP parece genérico (IA autorellenó). Edítalo con detalles reales para obtener leads mucho mejores."
                : "Your ICP looks generic (AI-autofilled). Edit it with real specifics to get much better leads."}
              <button class="briefme-warm-icp-edit-btn" id="briefme-warm-icp-edit">${isEs ? "Editar ICP" : "Edit ICP"}</button>
            </div>
          ` : ""}
        </div>

        <!-- Control bar: filter tabs + sort dropdown + bulk action bar.
             Hidden while the initial fetch runs; revealed once leads land. -->
        <div class="briefme-warm-controls" id="briefme-warm-controls" hidden>
          <div class="briefme-warm-degree-tabs" id="briefme-warm-tabs"></div>
          <div class="briefme-warm-sort-row">
            <label class="briefme-warm-sort-label">${isEs ? "Orden" : "Sort"}</label>
            <select class="briefme-warm-sort-select" id="briefme-warm-sort">
              <option value="warmth">${isEs ? "Más cálido primero" : "Warmest first"}</option>
              <option value="mutuals">${isEs ? "Más conexiones en común" : "Most mutuals"}</option>
              <option value="score">${isEs ? "Puntuación ICP" : "ICP score"}</option>
              <option value="name">${isEs ? "Nombre A-Z" : "Name A-Z"}</option>
            </select>
          </div>
          <div class="briefme-warm-bulk-bar" id="briefme-warm-bulk-bar" hidden>
            <span class="briefme-warm-bulk-count" id="briefme-warm-bulk-count">0 ${isEs ? "seleccionados" : "selected"}</span>
            <button class="briefme-warm-bulk-btn" data-bulk="draft-notes">✉️ ${isEs ? "Notas" : "Draft notes"}</button>
            <button class="briefme-warm-bulk-btn" data-bulk="contacted">✓ ${isEs ? "Contactados" : "Contacted"}</button>
            <button class="briefme-warm-bulk-btn briefme-warm-bulk-danger" data-bulk="dismiss">✕ ${isEs ? "Descartar" : "Dismiss"}</button>
            <button class="briefme-warm-bulk-btn" data-bulk="clear">${isEs ? "Deseleccionar" : "Clear"}</button>
          </div>
        </div>

        <div class="briefme-warm-list" id="briefme-warm-list">
          <div class="briefme-loading" style="padding: 30px 0;">
            <div class="briefme-spinner"></div>
            <p>${isEs ? "Buscando leads en tu red que coinciden con tu ICP..." : "Finding warm leads in your network..."}</p>
          </div>
        </div>

        <!-- Load-more footer: hidden until we've landed an initial batch AND
             the source has more pages available. Clicking runs another
             LinkedIn search pass with start=N. -->
        <div class="briefme-warm-loadmore" id="briefme-warm-loadmore" hidden>
          <button class="briefme-warm-loadmore-btn" id="briefme-warm-loadmore-btn">${isEs ? "Cargar más leads" : "Load more leads"}</button>
        </div>

        <!-- Restore drawer: appears only when dismissed count > 0. Opens to
             show a list of hidden leads with ↩ restore buttons. -->
        <div class="briefme-warm-restore" id="briefme-warm-restore" hidden>
          <button class="briefme-warm-restore-toggle" id="briefme-warm-restore-toggle">
            <span id="briefme-warm-restore-count">0</span> ${isEs ? "leads ocultos" : "hidden leads"} <span class="briefme-warm-restore-caret">▸</span>
          </button>
          <div class="briefme-warm-restore-body" id="briefme-warm-restore-body" hidden></div>
        </div>

        <div class="briefme-quest-actions">
          <button type="button" class="briefme-quest-back" id="briefme-warm-back">${isEs ? "Volver" : "Back"}</button>
          <button type="button" class="briefme-quest-submit" id="briefme-warm-refresh">${isEs ? "Refrescar" : "Refresh"}</button>
        </div>
      </div>
    `;

    document.getElementById("briefme-warm-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    });

    const runFetch = () => fetchWarmLeadsInto();
    document.getElementById("briefme-warm-refresh").addEventListener("click", runFetch);

    // "Edit ICP" button — only present when icpLooksGeneric triggered the warning.
    const editIcpBtn = document.getElementById("briefme-warm-icp-edit");
    if (editIcpBtn) {
      editIcpBtn.addEventListener("click", () => {
        sidebar.classList.remove("briefme-picker-view");
        showCompanySetup("picker");
      });
    }

    await runFetch();
  }

  // Detect the AI-autofill filler that earlier versions of the autofill
  // prompt were emitting. If any of these patterns match the stored ICP,
  // we show a warning banner pointing the user back to onboarding.
  function icpLooksGeneric(icp) {
    if (!icp || typeof icp !== "string") return false;
    const fillerPatterns = [
      /your product/i,
      /your offering/i,
      /your solution/i,
      /what you sell/i,
      /pain point your product/i,
      /problem you solve/i,
      /feel the pain/i,
      /need what you offer/i,
      /resonates with/i,
      /aligns with/i,
      /speaks to/i,
      /people who could benefit/i,
      /prospects looking for/i,
      /businesses that would/i,
      /organizations? (?:that|who) (?:need|would|could)/i,
    ];
    return fillerPatterns.some(rx => rx.test(icp));
  }

  // Persistent state for warm-leads — dismissed + contacted sets, keyed by
  // LinkedIn public ID. Dismissed leads vanish from the list; contacted
  // leads stay visible but wear a ✓ badge so you can track what's been hit.
  const WARM_DISMISSED_KEY = "klosr_warm_dismissed";
  const WARM_CONTACTED_KEY = "klosr_warm_contacted";
  const WARM_DRAFT_CACHE_KEY = "klosr_warm_draft_cache";
  async function getWarmDismissed() { return (await _storageGet(WARM_DISMISSED_KEY)) || {}; }
  async function getWarmContacted() { return (await _storageGet(WARM_CONTACTED_KEY)) || {}; }
  async function setWarmDismissed(m) { await _storageSet(WARM_DISMISSED_KEY, m); }
  async function setWarmContacted(m) { await _storageSet(WARM_CONTACTED_KEY, m); }
  async function getWarmDraftCache() { return (await _storageGet(WARM_DRAFT_CACHE_KEY)) || {}; }
  async function setWarmDraftCache(m) { await _storageSet(WARM_DRAFT_CACHE_KEY, m); }

  async function fetchWarmLeadsInto(attempt) {
    if (!attempt || attempt === 1) logKlosrEvent("warm_leads_search", { language: currentLanguage });
    const isEs = currentLanguage === "es";
    const list = document.getElementById("briefme-warm-list");
    if (!list) return;
    const tryCount = typeof attempt === "number" ? attempt : 1;

    list.innerHTML = `
      <div class="briefme-loading" style="padding: 30px 0;">
        <div class="briefme-spinner"></div>
        <p>${isEs ? "Buscando leads en tu red que coinciden con tu ICP..." : "Finding warm leads in your network..."}${tryCount > 1 ? ` (${isEs ? "reintentando" : "retrying"}…)` : ""}</p>
      </div>
    `;

    try {
      const cp = companyProfile || {};
      const icpObj = await getICPLearnings();
      const founderContext = {
        yourName: cp.yourName || "",
        yourRole: cp.yourRole || "",
        companyName: cp.companyName || "",
        whatYouSell: cp.whatYouSell || "",
        valueProp: cp.valueProp || "",
        icp: cp.icp || "",
        icpEmpirical: (icpObj && icpObj.icpSummary) || "",
        icpTopPatterns: (icpObj && Array.isArray(icpObj.topPatterns)) ? icpObj.topPatterns : [],
        background: cp.background || "",
      };

      // Step 1: ask the backend to translate the ICP into search queries
      // AND run SerpApi as a backfill in one round-trip. We use the queries
      // client-side for LinkedIn-native search; we use data.leads as the
      // cold-backfill pool if LinkedIn search finds too few warm leads.
      const res = await fetch(LEADS_DISCOVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ founderContext, limit: 20 }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      const serpLeads = (Array.isArray(data.leads) ? data.leads : [])
        .map(l => ({ ...l, source: l.source || "proxycurl" }));
      const serverQueries = Array.isArray(data.queries) ? data.queries : [];

      // Step 2: LinkedIn-native people search with network=F,S filter.
      // For each Claude-generated query, strip the `site:linkedin.com/in/`
      // prefix and run it through LinkedIn's own search. All results are
      // by construction 1st or 2nd degree — the warm pool we actually want.
      const linkedInKeywords = serverQueries
        .map(googleQueryToLinkedInKeywords)
        .filter(k => k.length > 0);

      let warmLeads = [];
      const warmSeen = new Set();
      for (const kw of linkedInKeywords) {
        const hits = await searchLinkedInPeopleInNetwork(kw, { limit: 15 });
        for (const h of hits) {
          if (!h._pid || warmSeen.has(h._pid)) continue;
          warmSeen.add(h._pid);
          warmLeads.push(h);
        }
        if (warmLeads.length >= 20) break;
      }
      console.log(`[Klosr] Warm-leads: ${warmLeads.length} in-network via LinkedIn search, ${serpLeads.length} via SerpApi backfill`);

      // Remember queries + page count so "Load more" can fetch next page.
      _warmQueries = linkedInKeywords;
      _warmPagesLoaded = 1;

      // Step 3: if LinkedIn search was thin (<5 warm leads), try Apollo
      // People Search as the primary backfill. Apollo returns pre-enriched
      // leads (email + phone + company domain baked in) filtered to the
      // user's ICP. Falls back to SerpApi cold results if Apollo also
      // returns empty / is not configured.
      const combined = [...warmLeads];
      if (warmLeads.length < 5) {
        // Extract 3-5 key role titles from the ICP queries for Apollo's
        // person_titles filter. The LinkedIn keywords already carry titles
        // in Boolean OR form — split them out.
        const extractTitles = (queries) => {
          const titles = new Set();
          for (const q of queries) {
            const quoted = q.match(/"([^"]{2,60})"/g) || [];
            for (const t of quoted) titles.add(t.replace(/"/g, ""));
          }
          return Array.from(titles).slice(0, 8);
        };
        const icpTitles = extractTitles(linkedInKeywords);
        const apolloRes = await callIntel("apollo-people-search", {
          keywords: founderContext.icp || founderContext.icpEmpirical || "",
          titles: icpTitles,
          limit: 15,
        });
        const apolloPeople = (apolloRes && Array.isArray(apolloRes.people)) ? apolloRes.people : [];
        // If Apollo People Search returned plan_required, log once and
        // silently fall through to SerpApi — no user-facing error, just
        // a degraded cold pool. Pro+ unlocks this endpoint.
        if (apolloRes && apolloRes.reason === "apollo_plan_required" && apolloPeople.length === 0) {
          console.log("[Klosr] Apollo People Search requires Professional plan — falling back to SerpApi.");
        }
        for (const ap of apolloPeople) {
          const pid = linkedInPublicId(ap.linkedinUrl);
          if (!pid || warmSeen.has(pid)) continue;
          warmSeen.add(pid);
          combined.push({
            name: ap.name,
            profileUrl: ap.linkedinUrl,
            company: ap.company || "",
            title: ap.title || "",
            signalText: ap.title ? `ICP match: ${ap.title}${ap.company ? " at " + ap.company : ""}` : "ICP match",
            signalType: "icp_match",
            signalDate: "",
            signalLink: ap.linkedinUrl,
            score: null,
            source: "apollo",
            _pid: pid,
            _degree: "OUT_OF_NETWORK",     // Apollo has no graph data for this user
            _mutuals: 0,
            _mutualNames: [],
            _enriched: true,
            _apolloEnriched: true,
            _apolloEmail: ap.email || "",
            _apolloEmailStatus: ap.emailStatus || "",
            _apolloPhones: ap.phones || [],
            _recentJobChange: !!ap.recentJobChange,
            companyDomain: ap.companyDomain || "",
          });
        }
        // If Apollo also returned nothing, SerpApi leftovers as last resort.
        if (apolloPeople.length === 0) {
          for (const sl of serpLeads) {
            const pid = linkedInPublicId(sl.profileUrl);
            if (!pid || warmSeen.has(pid)) continue;
            warmSeen.add(pid);
            combined.push({ ...sl, _pid: pid, _enriched: false });
          }
        }
      }

      const leads = combined;

      if (leads.length === 0) {
        const reason = data.reason || "";

        // Auto-retry once on transient upstream errors.
        const transient = [
          "exception", "network_error",
        ].includes(reason) || reason.startsWith("upstream_");
        if (transient && tryCount < 2) {
          console.log(`[Klosr] leads-discover transient (${reason}), auto-retrying in 1.2s`);
          await new Promise(r => setTimeout(r, 1200));
          return fetchWarmLeadsInto(2);
        }

        let reasonMsg;
        if (reason === "serpapi_not_configured") {
          reasonMsg = isEs ? "SerpApi no configurado en el servidor." : "SerpApi not configured on the server.";
        } else if (reason === "anthropic_not_configured") {
          reasonMsg = isEs ? "Claude no configurado en el servidor." : "Claude not configured on the server.";
        } else if (reason === "no_icp_configured") {
          reasonMsg = isEs ? "Tu ICP no está configurado." : "Your ICP isn't configured.";
        } else if (reason === "icp_translation_failed") {
          reasonMsg = isEs
            ? "No pude traducir tu ICP a una consulta de búsqueda. Intenta refinarlo en ajustes."
            : "Couldn't translate your ICP into a search query. Try refining it in settings.";
        } else if (reason === "exception" || reason.startsWith("upstream_") || reason === "network_error") {
          reasonMsg = isEs ? "Error al buscar leads. Pulsa Refrescar." : "Error searching for leads. Tap Refresh.";
        } else {
          reasonMsg = isEs
            ? "No se encontraron leads para tu ICP. Intenta ampliar o refinar el ICP en ajustes."
            : "No leads found for your ICP. Try broadening or refining your ICP in settings.";
        }
        list.innerHTML = `<div class="briefme-warm-empty">${reasonMsg}</div>`;
        return;
      }

      // Source badge — every lead is an ICP match. Show the network source
      // (LinkedIn-native vs. cold backfill) so the user knows which path
      // found the lead.
      const sourceBadge = (lead) => {
        if (lead.source === "linkedin_native") {
          return `<span class="briefme-warm-source-badge briefme-warm-source-discover" title="${isEs ? "En tu red de LinkedIn" : "In your LinkedIn network"}">🤝 ${isEs ? "Red" : "Network"}</span>`;
        }
        if (lead.source === "apollo") {
          return `<span class="briefme-warm-source-badge briefme-warm-source-apollo" title="${isEs ? "Fuente: Apollo.io (con email verificado)" : "Source: Apollo.io (pre-enriched)"}">⚡ Apollo</span>`;
        }
        return `<span class="briefme-warm-source-badge briefme-warm-source-discover" title="${isEs ? "Coincidencia con tu ICP" : "Matches your ICP"}">🎯 ${isEs ? "ICP" : "ICP"}</span>`;
      };

      // Filter out dismissed leads up front. User can restore them later
      // (not wired yet — future ship) but for now dismissing is a one-way
      // "don't show this person again" operation.
      const dismissedMap = await getWarmDismissed();
      const contactedMap = await getWarmContacted();
      const draftCacheMap = await getWarmDraftCache();
      // Already-in-pipeline check — prevents founders from duplicating work
      // by reaching out to a lead who's already in their deal tracker. We
      // normalize URLs (strip query / trailing slash) so the matcher is
      // resilient to LinkedIn's URL shape drift.
      const pipelineDeals = await loadProspectHistory();
      const normalizeLiUrl = (u) => String(u || "").toLowerCase().split("?")[0].split("#")[0].replace(/\/+$/, "");
      const pipelineByUrl = new Map();
      for (const d of (pipelineDeals || [])) {
        const k = normalizeLiUrl(d.profileUrl);
        if (k) pipelineByUrl.set(k, d);
      }
      const visibleLeads = leads.filter(l => l._pid && !dismissedMap[l._pid]);
      // Stash founderContext on module-scope so action handlers below can
      // pass it to the backend when generating drafts.
      _warmFounderContext = founderContext;

      // Build the initial render function. Called once with the pending
      // state, then again (with updated ordering + badges) after enrichment.
      const renderLead = (lead) => {
        const safeName = escapeHtml(lead.name || "(unknown)");
        const safeCompany = escapeHtml(lead.company || "");
        const safeTitle = escapeHtml(lead.title || "");
        const safeSignal = escapeHtml(lead.signalText || "");
        const safeType = escapeHtml(lead.signalType || "intent").toLowerCase();
        const safeDate = escapeHtml(lead.signalDate || "");
        const scoreTag = typeof lead.score === "number"
          ? `<span class="briefme-warm-score">${Math.round(lead.score * (lead.score <= 1 ? 100 : 1))}</span>`
          : "";
        const openUrl = lead.profileUrl || "";
        const pidAttr = lead._pid ? `data-pid="${escapeHtml(lead._pid)}"` : "";
        const isContacted = !!contactedMap[lead._pid];

        // Mutual connection names block — "🫂 via Sarah Chen, Marcus + 10"
        // is the single highest-impact addition to the card: tells the user
        // EXACTLY who to ask for a warm intro. Shown only when we have names.
        const hasMutualNames = Array.isArray(lead._mutualNames) && lead._mutualNames.length > 0;
        const mutualCount = typeof lead._mutuals === "number" ? lead._mutuals : 0;
        let mutualsBlock = "";
        if (hasMutualNames) {
          const shownNames = lead._mutualNames.slice(0, 2).map(n => `<strong>${escapeHtml(n)}</strong>`).join(", ");
          const remaining = Math.max(0, mutualCount - lead._mutualNames.length);
          const remainingText = remaining > 0
            ? ` ${isEs ? `+ ${remaining} más` : `+ ${remaining} others`}`
            : "";
          mutualsBlock = `<div class="briefme-warm-mutuals">🫂 ${isEs ? "vía" : "via"} ${shownNames}${remainingText}</div>`;
        } else if (mutualCount > 0) {
          mutualsBlock = `<div class="briefme-warm-mutuals briefme-warm-mutuals-count-only">🫂 ${mutualCount} ${isEs ? "conexiones en común" : "mutual connections"}</div>`;
        }

        // Apollo contact-info block — renders only once bulk-enrichment
        // populates _apolloEmail / _apolloPhones. One-click copy + `tel:` /
        // `mailto:` deep links turn each card into a send-button.
        const apolloEmail = lead._apolloEmail || "";
        const apolloPhones = Array.isArray(lead._apolloPhones) ? lead._apolloPhones : [];
        const hasApolloContact = apolloEmail || apolloPhones.length > 0;
        let apolloContactBlock = "";
        if (hasApolloContact) {
          const parts = [];
          if (apolloEmail) {
            parts.push(`<a class="briefme-warm-contact-pill briefme-warm-contact-email" href="mailto:${escapeHtml(apolloEmail)}" title="${escapeHtml(apolloEmail)}">✉️ ${escapeHtml(apolloEmail.slice(0, 34))}${apolloEmail.length > 34 ? "…" : ""}</a>`);
          }
          if (apolloPhones.length) {
            const p = apolloPhones[0];
            parts.push(`<a class="briefme-warm-contact-pill briefme-warm-contact-phone" href="tel:${escapeHtml(p.sanitized || p.number)}" title="${escapeHtml(p.type)}">📞 ${escapeHtml(p.number)}</a>`);
          }
          apolloContactBlock = `<div class="briefme-warm-apollo-contact">${parts.join("")}</div>`;
        }

        // "New role" trigger — Apollo tells us when they started < 180d ago.
        // Huge buying signal; budget just unlocked, orientation phase.
        const newRoleBadge = lead._recentJobChange
          ? `<div class="briefme-warm-trigger">🆕 ${isEs ? "Rol nuevo (últ. 6 meses)" : "New role (last 6 mo)"}</div>`
          : "";

        // ICP-fit badge (populated after scoreLeads resolves). Renders only
        // when we have a score. Tier drives color: hot = red, warm = amber,
        // ok = muted, weak = grey.
        let icpBadge = "";
        if (typeof lead._icpScore === "number") {
          const tier = lead._icpTier || "ok";
          const emoji = tier === "hot" ? "🔥" : tier === "warm" ? "⭐" : tier === "weak" ? "·" : "🎯";
          const tierLabel = {
            hot: isEs ? "Caliente" : "Hot",
            warm: isEs ? "Cálido" : "Warm",
            ok: "OK",
            weak: isEs ? "Débil" : "Weak",
          }[tier] || "";
          const reason = lead._icpReason ? ` · ${escapeHtml(lead._icpReason)}` : "";
          icpBadge = `<div class="briefme-warm-icp-score briefme-warm-icp-${tier}">
            <span class="briefme-warm-icp-pill">${emoji} ${tierLabel} ${lead._icpScore}/10</span>${reason}
          </div>`;
        }

        const isSelected = _warmSelected.has(lead._pid);

        // Pipeline-dedupe — look up this lead's URL in the already-in-pipeline
        // map we built before rendering. If they're already a deal, show a
        // distinct "In pipeline — Stage X" chip and neutralize the "Add to
        // pipeline" button so the founder doesn't create duplicate records.
        const pipelineDeal = pipelineByUrl.get(normalizeLiUrl(lead.profileUrl));
        const inPipeline = !!pipelineDeal;
        const pipelineStage = pipelineDeal ? (pipelineDeal.dealStage || pipelineDeal.stage || "prepped") : "";
        const pipelineStageLabelTxt = pipelineDeal ? stageLabel(pipelineStage, isEs) : "";
        const pipelineBadge = inPipeline
          ? `<div class="briefme-warm-in-pipeline" title="${isEs ? "Ya está en tu pipeline — no dupliques contactos" : "Already in your pipeline — don't duplicate work"}">
               📊 ${isEs ? "En pipeline" : "In pipeline"} · <strong>${escapeHtml(pipelineStageLabelTxt)}</strong>
             </div>`
          : "";

        return `
          <div class="briefme-warm-lead${isContacted ? " briefme-warm-lead-contacted" : ""}${isSelected ? " briefme-warm-lead-selected" : ""}${inPipeline ? " briefme-warm-lead-inpipeline" : ""}" ${pidAttr}>
            <div class="briefme-warm-lead-head">
              <label class="briefme-warm-select-wrap" title="${isEs ? "Seleccionar" : "Select"}">
                <input type="checkbox" class="briefme-warm-select" data-pid="${escapeHtml(lead._pid)}" ${isSelected ? "checked" : ""} />
              </label>
              <div class="briefme-warm-lead-who">
                <div class="briefme-warm-lead-name">
                  ${safeName}
                  ${isContacted ? `<span class="briefme-warm-contacted-badge" title="${isEs ? "Contactado" : "Contacted"}">✓</span>` : ""}
                </div>
                ${safeTitle || safeCompany
                  ? `<div class="briefme-warm-lead-sub">${safeTitle}${safeTitle && safeCompany ? " · " : ""}${safeCompany}</div>`
                  : ""}
                ${pipelineBadge}
                ${mutualsBlock}
                ${newRoleBadge}
                ${icpBadge}
                ${apolloContactBlock}
              </div>
              <div class="briefme-warm-lead-meta">
                <span class="briefme-warm-degree-slot">${degreeBadgeHtml(lead, isEs)}</span>
                ${sourceBadge(lead)}
                ${scoreTag}
                <button class="briefme-warm-dismiss-btn" data-action="dismiss" data-pid="${escapeHtml(lead._pid)}" title="${isEs ? "Descartar" : "Dismiss"}">✕</button>
              </div>
            </div>
            ${safeSignal && !hasMutualNames ? `
              <div class="briefme-warm-lead-signal">
                <span class="briefme-warm-lead-type">${safeType}</span>
                ${safeDate ? `<span class="briefme-warm-lead-date">${safeDate}</span>` : ""}
                <div class="briefme-warm-lead-text">${safeSignal}</div>
              </div>
            ` : ""}
            <div class="briefme-warm-lead-actions">
              <button class="briefme-warm-action-btn briefme-warm-draft-note" data-action="draft-note" data-pid="${escapeHtml(lead._pid)}">
                ✉️ ${isEs ? "Nota" : "Connect note"}
              </button>
              <button class="briefme-warm-action-btn briefme-warm-draft-dm" data-action="draft-dm" data-pid="${escapeHtml(lead._pid)}">
                💬 ${isEs ? "DM" : "DM"}
              </button>
              ${openUrl
                ? `<a class="briefme-warm-action-btn briefme-warm-open-link" href="${escapeHtml(openUrl)}" target="_blank" rel="noopener noreferrer">👤 ${isEs ? "Perfil" : "Profile"}</a>`
                : ""}
              ${inPipeline
                ? `<button class="briefme-warm-action-btn briefme-warm-open-deal" data-action="open-pipeline" data-pid="${escapeHtml(lead._pid)}">
                     📊 ${isEs ? "Ver deal" : "Open deal"}
                   </button>`
                : `<button class="briefme-warm-action-btn briefme-warm-add-pipeline" data-action="add-to-pipeline" data-pid="${escapeHtml(lead._pid)}">
                     📊 ${isEs ? "Añadir al pipeline" : "Add to pipeline"}
                   </button>`}
              <button class="briefme-warm-action-btn briefme-warm-contacted-btn${isContacted ? " is-active" : ""}" data-action="toggle-contacted" data-pid="${escapeHtml(lead._pid)}">
                ${isContacted ? (isEs ? "✓ Contactado" : "✓ Contacted") : (isEs ? "Marcar contactado" : "Mark contacted")}
              </button>
            </div>
            <div class="briefme-warm-draft-panel" id="briefme-warm-draft-${escapeHtml(lead._pid)}"></div>
          </div>
        `;
      };

      // Store the full pool (dismissed shown here so Restore drawer can list them).
      _warmAllLeads = leads;
      _warmRenderLead = renderLead;
      _warmVisibleRenderFn = () => renderWarmLeads(list, isEs);
      // Initial render via the filter/sort pipeline.
      renderWarmLeads(list, isEs);
      attachWarmLeadControlHandlers(isEs);
      updateRestoreDrawer(isEs);

      // Kick off ICP scoring in background — updates cards as it lands.
      scoreWarmLeadsInBackground(founderContext, isEs);
      // Kick off Apollo bulk enrichment — every card gains email/phone/
      // recent-job-change signal. Emails default on, phones opt-in via
      // revealPhones flag (saves phone credits on the bulk path).
      bulkEnrichWarmLeadsInBackground(isEs);

      // Enrichment pass — only needed for SerpApi backfill leads (LinkedIn-
      // native ones already carry {_degree, _mutuals, _enriched: true} from
      // the search response). Fetches each backfill profile inside the
      // user's LinkedIn session, parses degree + mutual count, updates the
      // badge in-place. When all resolve, re-sort warmest-first.
      //
      // Concurrency: 3 in flight, 300ms between batches. LinkedIn throttles
      // aggressive profile crawls — this pace keeps us well under.
      const CONCURRENCY = 3;
      const BATCH_DELAY_MS = 300;
      const enrichableLeads = leads.filter(l => l._pid && !l._enriched);

      (async () => {
        for (let i = 0; i < enrichableLeads.length; i += CONCURRENCY) {
          const batch = enrichableLeads.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (lead) => {
            try {
              const { degree, mutuals } = await enrichLeadConnection(lead.profileUrl);
              lead._degree = degree;
              lead._mutuals = mutuals;
              lead._enriched = true;
              // Update the badge in place without re-rendering the whole list.
              const card = list.querySelector(`[data-pid="${CSS.escape(lead._pid)}"]`);
              if (card) {
                const slot = card.querySelector(".briefme-warm-degree-slot");
                if (slot) slot.innerHTML = degreeBadgeHtml(lead, isEs);
              }
            } catch (e) {
              lead._enriched = true;   // mark as done so the final sort doesn't
                                       // wait forever
            }
          }));
          if (i + CONCURRENCY < enrichableLeads.length) {
            await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
          }
        }

        // Filter SELF out of the pool and re-render via the filter/sort
        // pipeline. Dismissed leads are kept in the pool so the Restore
        // drawer can still list them.
        _warmAllLeads = leads.filter(l => l._degree !== 0);
        renderWarmLeads(list, isEs);
      })();
    } catch (err) {
      console.error("Klosr warm leads error:", err);
      list.innerHTML = `<div class="briefme-warm-empty">${isEs ? "Error al cargar señales. Inténtalo de nuevo." : "Error loading signals. Try again."}</div>`;
    }
  }

  // Event delegation for all warm-lead card buttons. Re-called after every
  // render (initial + post-enrichment). Actions: dismiss, toggle-contacted,
  // draft-note (LinkedIn connection note), draft-dm (first LinkedIn DM).
  function attachWarmLeadActionHandlers(listEl, isEs) {
    if (!listEl) return;
    listEl.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = btn.dataset.action;
        const pid = btn.dataset.pid;
        if (!pid) return;

        if (action === "dismiss") {
          const map = await getWarmDismissed();
          map[pid] = Date.now();
          await setWarmDismissed(map);
          // Remove the card from the DOM; it's gone until the user opens
          // a "restore dismissed" drawer (future ship).
          const card = listEl.querySelector(`.briefme-warm-lead[data-pid="${CSS.escape(pid)}"]`);
          if (card) card.remove();
          return;
        }

        if (action === "toggle-contacted") {
          const map = await getWarmContacted();
          if (map[pid]) delete map[pid];
          else map[pid] = Date.now();
          await setWarmContacted(map);
          const card = listEl.querySelector(`.briefme-warm-lead[data-pid="${CSS.escape(pid)}"]`);
          if (card) {
            const on = !!map[pid];
            card.classList.toggle("briefme-warm-lead-contacted", on);
            const button = card.querySelector(".briefme-warm-contacted-btn");
            if (button) {
              button.classList.toggle("is-active", on);
              button.textContent = on
                ? (isEs ? "✓ Contactado" : "✓ Contacted")
                : (isEs ? "Marcar contactado" : "Mark contacted");
            }
            const badge = card.querySelector(".briefme-warm-contacted-badge");
            const nameEl = card.querySelector(".briefme-warm-lead-name");
            if (on && !badge && nameEl) {
              nameEl.insertAdjacentHTML("beforeend", `<span class="briefme-warm-contacted-badge" title="${isEs ? "Contactado" : "Contacted"}">✓</span>`);
            } else if (!on && badge) {
              badge.remove();
            }
          }
          return;
        }

        if (action === "open-pipeline") {
          // Lead is already in the pipeline — jump there so the founder
          // works from the existing deal instead of duplicating it.
          logKlosrEvent("warm_open_existing_deal", { pid });
          showDealPipelineView();
          return;
        }

        if (action === "add-to-pipeline") {
          // One-click: skip the "generate brief" step and push this lead
          // straight into the pipeline as a "prepped" deal. Fast path for
          // bulk warm-lead triage — user can prep individual briefs later.
          const lead = _warmLeadIndex && _warmLeadIndex[pid];
          if (!lead) return;
          await upsertDeal({
            name: lead.name || "",
            profileUrl: lead.profileUrl || "",
            headline: lead.title || "",
            currentCompany: lead.company || "",
            currentRole: lead.title || "",
            photoUrl: lead.profilePicUrl || "",
          }, { stage: "prepped", dealStage: "prepped" });
          logKlosrEvent("warm_lead_added_to_pipeline", {});
          showKlosrToast(isEs
            ? `📊 ${lead.name} añadido al pipeline`
            : `📊 ${lead.name} added to pipeline`);
          btn.textContent = isEs ? "✓ En pipeline" : "✓ In pipeline";
          btn.classList.add("is-active");
          btn.disabled = true;
          return;
        }

        if (action === "draft-note" || action === "draft-dm") {
          const type = action === "draft-note" ? "connection_note" : "dm";
          logKlosrEvent("warm_lead_drafted", { type, language: currentLanguage });
          const lead = _warmLeadIndex && _warmLeadIndex[pid];
          if (!lead) return;
          const panel = document.getElementById(`briefme-warm-draft-${pid}`);
          if (!panel) return;

          // Cache hit — instant display if we already drafted this exact
          // type for this lead earlier in the session.
          const cache = await getWarmDraftCache();
          const cacheKey = `${pid}::${type}`;
          if (cache[cacheKey]) {
            renderWarmDraftPanel(panel, cache[cacheKey], type, lead, isEs);
            return;
          }

          panel.classList.add("is-open");
          panel.innerHTML = `
            <div class="briefme-warm-draft-loading">
              <div class="briefme-spinner"></div>
              <span>${isEs ? "Redactando..." : "Drafting..."}</span>
            </div>
          `;

          const res = await callIntel("draft-warm-outreach", {
            prospect: {
              name: lead.name,
              title: lead.title,
              company: lead.company,
              profileUrl: lead.profileUrl,
              mutualNames: lead._mutualNames || [],
            },
            founderContext: _warmFounderContext || {},
            type,
          });
          const draft = (res && res.draft) || "";
          if (!draft) {
            panel.innerHTML = `<div class="briefme-warm-draft-error">${isEs ? "No se pudo generar. Pulsa de nuevo." : "Couldn't generate. Tap again."}</div>`;
            return;
          }
          cache[cacheKey] = draft;
          await setWarmDraftCache(cache);
          renderWarmDraftPanel(panel, draft, type, lead, isEs);
        }
      });
    });
  }

  function renderWarmDraftPanel(panel, draft, type, lead, isEs) {
    panel.classList.add("is-open");
    const typeLabel = type === "connection_note"
      ? (isEs ? "Nota de conexión" : "Connection note")
      : (isEs ? "Mensaje directo" : "Direct message");
    const charCount = draft.length;
    const charCap = type === "connection_note" ? 300 : null;
    const charLabel = charCap
      ? `${charCount} / ${charCap}`
      : `${charCount} ${isEs ? "caracteres" : "chars"}`;
    panel.innerHTML = `
      <div class="briefme-warm-draft-head">
        <span class="briefme-warm-draft-type">${typeLabel}</span>
        <span class="briefme-warm-draft-chars${charCap && charCount > charCap ? " briefme-warm-draft-over" : ""}">${charLabel}</span>
      </div>
      <div class="briefme-warm-draft-text">${escapeHtml(draft)}</div>
      <div class="briefme-warm-draft-foot">
        <button class="briefme-warm-action-btn briefme-warm-send-btn" data-send="${encodeURIComponent(draft)}" data-send-type="${escapeHtml(type)}" title="${isEs ? "Copia el texto, abre LinkedIn y auto-llena el compositor. Programa follow-ups día 4 y 9." : "Copy text, open LinkedIn, auto-fill composer. Schedules day-4 & day-9 follow-ups."}">📤 ${isEs ? "Enviar con Klosr" : "Send via Klosr"}</button>
        <button class="briefme-warm-action-btn briefme-warm-copy-btn" data-copy="${encodeURIComponent(draft)}">${isEs ? "Copiar" : "Copy"}</button>
        <button class="briefme-warm-action-btn briefme-warm-close-btn" data-close="1">${isEs ? "Cerrar" : "Close"}</button>
      </div>
    `;
    const copyBtn = panel.querySelector(".briefme-warm-copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const text = decodeURIComponent(copyBtn.dataset.copy || "");
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = isEs ? "✓ Copiado" : "✓ Copied";
          setTimeout(() => { copyBtn.textContent = isEs ? "Copiar" : "Copy"; }, 1500);
          // Auto-schedule follow-ups even on pure copy (user intent = sending)
          await scheduleFollowupsForLead(lead, text);
        } catch {/* silent */}
      });
    }

    // Send via Klosr — one-click:
    //   1) Copies the draft to clipboard (belt + suspenders)
    //   2) Stashes the draft in chrome.storage under a 5-min TTL key so the
    //      target tab can auto-fill when the profile loads
    //   3) Opens the prospect's LinkedIn profile in a new tab
    //   4) Auto-schedules day-4 + day-9 follow-up commitments on the deal
    // The content script running on the target tab will detect the pending
    // DM via chrome.storage and show an auto-send banner.
    const sendBtn = panel.querySelector(".briefme-warm-send-btn");
    if (sendBtn) {
      sendBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const text = decodeURIComponent(sendBtn.dataset.send || "");
        const dmType = sendBtn.dataset.sendType || "dm";
        if (!text || !lead.profileUrl) return;
        sendBtn.disabled = true;
        sendBtn.textContent = isEs ? "Enviando..." : "Sending...";
        try {
          // 1. Copy to clipboard (fallback if auto-fill fails)
          await navigator.clipboard.writeText(text).catch(() => {});

          // 2. Stash for cross-tab auto-fill
          const pending = {
            url: lead.profileUrl,
            draft: text,
            type: dmType,
            ts: Date.now(),
            name: lead.name || "",
          };
          await new Promise(r => chrome.storage.local.set({ klosr_pending_dm: pending }, r));

          // 3. Schedule follow-ups
          await scheduleFollowupsForLead(lead, text);
          logKlosrEvent("warm_lead_sent_via_klosr", { type: dmType });

          // 4. Open the profile in a new tab — Klosr's auto-inject on the
          // target page picks up the pending DM and shows the auto-send banner.
          window.open(lead.profileUrl, "_blank", "noopener,noreferrer");

          sendBtn.textContent = isEs ? "✓ Enviado + follow-ups programados" : "✓ Sent + follow-ups scheduled";
          setTimeout(() => {
            sendBtn.disabled = false;
            sendBtn.textContent = `📤 ${isEs ? "Enviar con Klosr" : "Send via Klosr"}`;
          }, 2500);
        } catch (err) {
          console.warn("[Klosr] send-via-klosr failed:", err);
          sendBtn.disabled = false;
          sendBtn.textContent = `📤 ${isEs ? "Enviar con Klosr" : "Send via Klosr"}`;
        }
      });
    }

    const closeBtn = panel.querySelector(".briefme-warm-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        panel.classList.remove("is-open");
        panel.innerHTML = "";
      });
    }
  }

  // ============================================================
  // WARM LEADS — filter / sort / bulk / pagination / restore pipeline
  //
  // renderWarmLeads()  → applies current filter + sort to _warmAllLeads,
  //                      updates tab counts, re-binds action handlers.
  // attachWarmLeadControlHandlers() → wires tabs, sort, bulk bar, load more.
  // updateRestoreDrawer() → shows "N hidden leads" at bottom + restore list.
  // scoreWarmLeadsInBackground() → batch Claude call, progressive card update.
  // loadMoreWarmLeads() → fetches next page from LinkedIn, appends.
  // ============================================================

  async function renderWarmLeads(list, isEs) {
    if (!list) return;
    const dismissedMap = await getWarmDismissed();
    const contactedMap = await getWarmContacted();

    // Pool before filter: every lead not dismissed (except for "contacted"
    // filter, which shows ALL contacted leads regardless of degree).
    let pool = _warmAllLeads.filter(l => l && l._pid);

    if (_warmDegreeFilter === "contacted") {
      pool = pool.filter(l => contactedMap[l._pid]);
    } else {
      pool = pool.filter(l => !dismissedMap[l._pid]);
      if (_warmDegreeFilter === "1") pool = pool.filter(l => l._degree === 1);
      else if (_warmDegreeFilter === "2") pool = pool.filter(l => l._degree === 2);
      else if (_warmDegreeFilter === "3") pool = pool.filter(l => l._degree === 3);
      // "all" → no additional filter
    }

    // Sort
    if (_warmSortMode === "mutuals") {
      pool.sort((a, b) => (b._mutuals || 0) - (a._mutuals || 0));
    } else if (_warmSortMode === "score") {
      pool.sort((a, b) => (b._icpScore || 0) - (a._icpScore || 0));
    } else if (_warmSortMode === "name") {
      pool.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    } else {
      pool.sort((a, b) => warmScore(b) - warmScore(a));
    }

    // Update tab counts
    const counts = {
      all: _warmAllLeads.filter(l => l._pid && !dismissedMap[l._pid]).length,
      "1": _warmAllLeads.filter(l => l._degree === 1 && !dismissedMap[l._pid]).length,
      "2": _warmAllLeads.filter(l => l._degree === 2 && !dismissedMap[l._pid]).length,
      "3": _warmAllLeads.filter(l => l._degree === 3 && !dismissedMap[l._pid]).length,
      contacted: Object.keys(contactedMap).length,
    };
    const tabsEl = document.getElementById("briefme-warm-tabs");
    if (tabsEl) {
      const tab = (key, label) => `<button class="briefme-warm-tab${_warmDegreeFilter === key ? " is-active" : ""}" data-degree="${key}">${label} <span class="briefme-warm-tab-count">${counts[key] || 0}</span></button>`;
      tabsEl.innerHTML = [
        tab("all", isEs ? "Todos" : "All"),
        tab("1", "1st"),
        tab("2", "2nd"),
        tab("3", "3rd"),
        tab("contacted", isEs ? "✓ Contactados" : "✓ Contacted"),
      ].join("");
    }

    // Reveal controls now that we have leads (first render only matters).
    const controlsEl = document.getElementById("briefme-warm-controls");
    if (controlsEl && _warmAllLeads.length) controlsEl.hidden = false;

    // Render the filtered pool
    _warmLeadIndex = {};
    for (const l of pool) _warmLeadIndex[l._pid] = l;

    if (pool.length === 0) {
      const msg = _warmDegreeFilter === "contacted"
        ? (isEs ? "Aún no has marcado a nadie como contactado." : "You haven't marked anyone as contacted yet.")
        : (isEs ? `Sin leads en este filtro (${_warmDegreeFilter}).` : `No leads in this filter (${_warmDegreeFilter}).`);
      list.innerHTML = `<div class="briefme-warm-empty">${msg}</div>`;
    } else if (_warmRenderLead) {
      list.innerHTML = pool.map(_warmRenderLead).join("");
      attachWarmLeadActionHandlers(list, isEs);
      attachWarmLeadCheckboxHandlers(list, isEs);
    }

    // Load-more footer visibility: only when we have LinkedIn queries AND
    // we're on the "all" or degree-1/2/3 tab (not contacted).
    const lm = document.getElementById("briefme-warm-loadmore");
    if (lm) lm.hidden = !(_warmQueries.length && _warmDegreeFilter !== "contacted");

    updateRestoreDrawer(isEs);
    updateBulkBar(isEs);
  }

  function attachWarmLeadControlHandlers(isEs) {
    const list = document.getElementById("briefme-warm-list");
    // Tab clicks
    const tabsEl = document.getElementById("briefme-warm-tabs");
    if (tabsEl) {
      tabsEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-degree]");
        if (!btn) return;
        _warmDegreeFilter = btn.dataset.degree;
        _warmSelected.clear();
        renderWarmLeads(list, isEs);
      });
    }
    // Sort change
    const sortEl = document.getElementById("briefme-warm-sort");
    if (sortEl) {
      sortEl.addEventListener("change", () => {
        _warmSortMode = sortEl.value;
        renderWarmLeads(list, isEs);
      });
    }
    // Bulk-bar buttons
    const bulkEl = document.getElementById("briefme-warm-bulk-bar");
    if (bulkEl) {
      bulkEl.addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-bulk]");
        if (!btn) return;
        e.preventDefault();
        await handleBulkAction(btn.dataset.bulk, isEs);
      });
    }
    // Load-more button
    const lmBtn = document.getElementById("briefme-warm-loadmore-btn");
    if (lmBtn) {
      lmBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await loadMoreWarmLeads(isEs);
      });
    }
    // Restore drawer toggle
    const restoreToggle = document.getElementById("briefme-warm-restore-toggle");
    if (restoreToggle) {
      restoreToggle.addEventListener("click", (e) => {
        e.preventDefault();
        const body = document.getElementById("briefme-warm-restore-body");
        const caret = restoreToggle.querySelector(".briefme-warm-restore-caret");
        if (body) {
          body.hidden = !body.hidden;
          if (caret) caret.textContent = body.hidden ? "▸" : "▾";
        }
      });
    }
  }

  function attachWarmLeadCheckboxHandlers(listEl, isEs) {
    listEl.querySelectorAll(".briefme-warm-select").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const pid = e.currentTarget.dataset.pid;
        if (!pid) return;
        if (e.currentTarget.checked) _warmSelected.add(pid);
        else _warmSelected.delete(pid);
        // Highlight card + update bulk bar
        const card = listEl.querySelector(`.briefme-warm-lead[data-pid="${CSS.escape(pid)}"]`);
        if (card) card.classList.toggle("briefme-warm-lead-selected", e.currentTarget.checked);
        updateBulkBar(isEs);
      });
    });
  }

  function updateBulkBar(isEs) {
    const bar = document.getElementById("briefme-warm-bulk-bar");
    const countEl = document.getElementById("briefme-warm-bulk-count");
    if (!bar || !countEl) return;
    const n = _warmSelected.size;
    if (n === 0) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    countEl.textContent = `${n} ${isEs ? "seleccionados" : "selected"}`;
  }

  async function handleBulkAction(action, isEs) {
    const list = document.getElementById("briefme-warm-list");
    const selectedPids = Array.from(_warmSelected);
    if (selectedPids.length === 0) return;

    if (action === "clear") {
      _warmSelected.clear();
      renderWarmLeads(list, isEs);
      return;
    }

    if (action === "dismiss") {
      const map = await getWarmDismissed();
      for (const pid of selectedPids) map[pid] = Date.now();
      await setWarmDismissed(map);
      _warmSelected.clear();
      renderWarmLeads(list, isEs);
      return;
    }

    if (action === "contacted") {
      const map = await getWarmContacted();
      for (const pid of selectedPids) map[pid] = Date.now();
      await setWarmContacted(map);
      _warmSelected.clear();
      renderWarmLeads(list, isEs);
      return;
    }

    if (action === "draft-notes") {
      // Open a modal with N drafts streamed in. Runs one Haiku call per
      // lead (serial, throttled), each ~1-2s.
      openBulkDraftModal(selectedPids, isEs);
      return;
    }
  }

  async function openBulkDraftModal(pids, isEs) {
    const modal = document.createElement("div");
    modal.className = "briefme-warm-bulk-modal";
    modal.innerHTML = `
      <div class="briefme-warm-bulk-modal-card">
        <div class="briefme-warm-bulk-modal-head">
          <div class="briefme-warm-bulk-modal-title">${isEs ? "Notas de conexión" : "Connection notes"}</div>
          <button class="briefme-warm-bulk-modal-close" id="briefme-warm-bulk-close">✕</button>
        </div>
        <div class="briefme-warm-bulk-modal-body" id="briefme-warm-bulk-modal-body">
          <div class="briefme-warm-bulk-progress" id="briefme-warm-bulk-progress">
            ${isEs ? "Preparando" : "Preparing"} 0/${pids.length}…
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector("#briefme-warm-bulk-close").addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

    const body = modal.querySelector("#briefme-warm-bulk-modal-body");
    const progress = modal.querySelector("#briefme-warm-bulk-progress");
    const cache = await getWarmDraftCache();
    let done = 0;
    for (const pid of pids) {
      const lead = _warmLeadIndex[pid];
      if (!lead) { done++; continue; }
      const cacheKey = `${pid}::connection_note`;
      let draft = cache[cacheKey];
      if (!draft) {
        const res = await callIntel("draft-warm-outreach", {
          prospect: {
            name: lead.name,
            title: lead.title,
            company: lead.company,
            profileUrl: lead.profileUrl,
            mutualNames: lead._mutualNames || [],
          },
          founderContext: _warmFounderContext || {},
          type: "connection_note",
        });
        draft = (res && res.draft) || "";
        if (draft) {
          cache[cacheKey] = draft;
          await setWarmDraftCache(cache);
        }
      }
      done++;
      if (progress) progress.textContent = `${isEs ? "Generando" : "Generating"} ${done}/${pids.length}…`;
      if (draft) {
        const row = document.createElement("div");
        row.className = "briefme-warm-bulk-row";
        row.innerHTML = `
          <div class="briefme-warm-bulk-row-head">
            <strong>${escapeHtml(lead.name)}</strong>
            ${lead.title ? `<span>· ${escapeHtml(lead.title.slice(0, 90))}</span>` : ""}
          </div>
          <div class="briefme-warm-bulk-row-draft">${escapeHtml(draft)}</div>
          <div class="briefme-warm-bulk-row-foot">
            <button class="briefme-warm-action-btn briefme-warm-copy-btn" data-copy="${encodeURIComponent(draft)}">${isEs ? "Copiar" : "Copy"}</button>
            <a class="briefme-warm-action-btn briefme-warm-open-link" href="${escapeHtml(lead.profileUrl || "")}" target="_blank" rel="noopener noreferrer">${isEs ? "Abrir LinkedIn" : "Open LinkedIn"}</a>
          </div>
        `;
        body.insertBefore(row, progress);
        const cb = row.querySelector(".briefme-warm-copy-btn");
        cb.addEventListener("click", async () => {
          const text = decodeURIComponent(cb.dataset.copy || "");
          try {
            await navigator.clipboard.writeText(text);
            cb.textContent = isEs ? "✓ Copiado" : "✓ Copied";
            setTimeout(() => { cb.textContent = isEs ? "Copiar" : "Copy"; }, 1500);
          } catch {/* silent */}
        });
      }
    }
    if (progress) progress.remove();
  }

  async function updateRestoreDrawer(isEs) {
    const drawer = document.getElementById("briefme-warm-restore");
    const countEl = document.getElementById("briefme-warm-restore-count");
    const bodyEl = document.getElementById("briefme-warm-restore-body");
    if (!drawer || !countEl || !bodyEl) return;

    const dismissed = await getWarmDismissed();
    const dismissedPids = Object.keys(dismissed);
    if (dismissedPids.length === 0) {
      drawer.hidden = true;
      return;
    }
    drawer.hidden = false;
    countEl.textContent = dismissedPids.length;

    // Only populate the body if it's actually open (lazy-render).
    if (bodyEl.hidden) return;

    // Look up each dismissed lead's display info from the pool (or fall back
    // to just showing the pid if we don't have it).
    const poolByPid = {};
    for (const l of _warmAllLeads) poolByPid[l._pid] = l;

    bodyEl.innerHTML = dismissedPids.map(pid => {
      const lead = poolByPid[pid];
      const label = lead
        ? `${escapeHtml(lead.name)}${lead.title ? " · " + escapeHtml(lead.title.slice(0, 60)) : ""}`
        : escapeHtml(pid);
      return `
        <div class="briefme-warm-restore-row">
          <span class="briefme-warm-restore-name">${label}</span>
          <button class="briefme-warm-action-btn briefme-warm-restore-btn" data-restore="${escapeHtml(pid)}">↩ ${isEs ? "Restaurar" : "Restore"}</button>
        </div>
      `;
    }).join("");

    bodyEl.querySelectorAll("[data-restore]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const pid = btn.dataset.restore;
        if (!pid) return;
        const map = await getWarmDismissed();
        delete map[pid];
        await setWarmDismissed(map);
        const list = document.getElementById("briefme-warm-list");
        renderWarmLeads(list, isEs);
      });
    });
  }

  // Bulk-enrich every warm lead through Apollo's /people/bulk_match. Each
  // card gains: verified email, phone numbers, company domain, a
  // "new-role" indicator if they started in the last 180 days. Runs once
  // per render; results merge onto the lead objects in place.
  //
  // Credit cost: ~1 Apollo email credit per enriched lead. Phones off by
  // default (premium credit pool), flip revealPhones:true if you want.
  async function bulkEnrichWarmLeadsInBackground(isEs) {
    if (!Array.isArray(_warmAllLeads) || _warmAllLeads.length === 0) return;
    const urls = _warmAllLeads
      .filter(l => l.profileUrl && !l._apolloEnriched)
      .map(l => l.profileUrl)
      .slice(0, 25);
    if (urls.length === 0) return;

    const res = await callIntel("apollo-bulk-enrich", { linkedinUrls: urls });
    if (!res || !Array.isArray(res.matches)) return;

    // Match Apollo results back to lead objects by LinkedIn URL (normalized).
    const normalize = (u) => (u || "").toString().toLowerCase().replace(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\//i, "https://www.linkedin.com/").replace(/\/+$/, "");
    const byUrl = {};
    for (const m of res.matches) {
      if (m.linkedinUrl) byUrl[normalize(m.linkedinUrl)] = m;
    }

    for (const lead of _warmAllLeads) {
      const key = normalize(lead.profileUrl);
      const m = byUrl[key];
      if (!m) continue;
      lead._apolloEnriched = true;
      if (m.email) lead._apolloEmail = m.email;
      if (m.emailStatus) lead._apolloEmailStatus = m.emailStatus;
      if (Array.isArray(m.phones) && m.phones.length) lead._apolloPhones = m.phones;
      if (m.companyDomain && !lead.companyDomain) lead.companyDomain = m.companyDomain;
      if (m.title && !lead.title) lead.title = m.title;
      if (m.company && !lead.company) lead.company = m.company;
      if (m.recentJobChange) lead._recentJobChange = true;
    }

    // Re-render so the new info shows up inline.
    const list = document.getElementById("briefme-warm-list");
    renderWarmLeads(list, isEs);
  }

  async function scoreWarmLeadsInBackground(founderContext, isEs) {
    // Score all leads in a single batch (capped at 25 server-side).
    const toScore = _warmAllLeads
      .filter(l => l._pid && !l._icpScore)
      .slice(0, 25);
    if (toScore.length === 0) return;

    const res = await callIntel("score-leads", {
      founderContext,
      leads: toScore.map(l => ({
        pid: l._pid,
        name: l.name,
        title: l.title,
        company: l.company,
        degree: l._degree,
        mutuals: l._mutuals,
      })),
    });
    const scores = (res && Array.isArray(res.scores)) ? res.scores : [];
    for (const s of scores) {
      const lead = _warmLeadIndex[s.pid] ||
                   _warmAllLeads.find(l => l._pid === s.pid);
      if (lead) {
        lead._icpScore = s.score;
        lead._icpTier = s.tier;
        lead._icpReason = s.reason;
      }
    }
    // Re-render so scores appear inline. Also, if user had switched to
    // "ICP score" sort, the list reorders now.
    const list = document.getElementById("briefme-warm-list");
    renderWarmLeads(list, isEs);
  }

  async function loadMoreWarmLeads(isEs) {
    const lmBtn = document.getElementById("briefme-warm-loadmore-btn");
    if (lmBtn) {
      lmBtn.disabled = true;
      lmBtn.textContent = isEs ? "Cargando..." : "Loading...";
    }
    const nextStart = _warmPagesLoaded * 10;
    const knownPids = new Set(_warmAllLeads.map(l => l._pid));
    let added = 0;
    for (const kw of _warmQueries) {
      const hits = await searchLinkedInPeopleInNetwork(kw, { limit: 10, start: nextStart });
      for (const h of hits) {
        if (!h._pid || knownPids.has(h._pid)) continue;
        knownPids.add(h._pid);
        _warmAllLeads.push(h);
        added++;
      }
    }
    _warmPagesLoaded += 1;
    if (lmBtn) {
      lmBtn.disabled = false;
      lmBtn.textContent = isEs ? "Cargar más leads" : "Load more leads";
    }
    const list = document.getElementById("briefme-warm-list");
    renderWarmLeads(list, isEs);
    // Score the new ones too.
    if (added > 0) scoreWarmLeadsInBackground(_warmFounderContext || {}, isEs);
  }

  function showHandleReplyForm() {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";
    const displayName = getDisplayName(currentProfile);

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${isEs ? "Respuesta del prospecto" : "Prospect reply"}</div>
          <div class="briefme-quest-subtitle">${isEs ? "De" : "From"} <strong>${escapeHtml(displayName)}</strong>. ${isEs ? "Pega su respuesta, Klosr clasifica y escribe tu siguiente movimiento." : "Paste their reply, Klosr classifies it and writes your next move."}</div>
        </div>
        <form class="briefme-quest-form" id="briefme-reply-form">
          <label class="briefme-quest-label">${isEs ? "Canal" : "Channel"}</label>
          <div class="briefme-reply-channel">
            <label><input type="radio" name="channel" value="email" checked /> Email</label>
            <label><input type="radio" name="channel" value="linkedin_dm" /> LinkedIn DM</label>
          </div>

          <label class="briefme-quest-label" for="briefme-reply-original">${isEs ? "Tu mensaje original (opcional)" : "Your original outreach (optional)"}</label>
          <textarea id="briefme-reply-original" class="briefme-quest-textarea" rows="2" placeholder="${isEs ? "Lo que les enviaste" : "What you sent them"}"></textarea>

          <label class="briefme-quest-label" for="briefme-reply-text">${isEs ? "Su respuesta" : "Their reply"}</label>
          <textarea id="briefme-reply-text" class="briefme-quest-textarea" rows="6" placeholder="${isEs ? "Pega lo que te escribieron" : "Paste what they wrote back"}" required></textarea>

          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-reply-back">${isEs ? "Volver" : "Back"}</button>
            <button type="submit" class="briefme-quest-submit">${isEs ? "Analizar y responder" : "Classify + draft reply"}</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById("briefme-reply-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      showModePicker();
    });

    document.getElementById("briefme-reply-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const channel = (document.querySelector('input[name="channel"]:checked') || { value: "email" }).value;
      const original = document.getElementById("briefme-reply-original").value.trim();
      const replyText = document.getElementById("briefme-reply-text").value.trim();
      if (!replyText) return;
      await runHandleReply({ replyText, originalOutreach: original, channel });
    });
  }

  async function runHandleReply({ replyText, originalOutreach, channel }) {
    const content = document.getElementById("briefme-content");
    content.innerHTML = `
      <div class="briefme-loading">
        <div class="briefme-spinner"></div>
        <p>${currentLanguage === "es" ? "Analizando la respuesta..." : "Reading the reply..."}</p>
      </div>
    `;
    // Pipeline hook: receiving a reply means they came back — advance to
    // "replied" stage + log the activity.
    if (currentProfile && currentProfile.profileUrl) {
      recordDealActivity(currentProfile.profileUrl, "reply", { channel }).catch(() => {});
      setDealStage(currentProfile.profileUrl, "replied").catch(() => {});
    }

    try {
      const cp = companyProfile || {};
      const [voiceExamples, icpLearningsObj, objectionPlaybook, proofLibrary, relevantCallNotes, ninjaPearData] = await Promise.all([
        getVoiceExamples(), getICPLearnings(), getObjectionPlaybook(),
        getProofLibrary(), getRelevantCallNotes(currentProfile),
        waitForNinjaPear(currentProfile, 3000),
      ]);

      const richSender = {
        name: cp.yourName || (currentSender && currentSender.name) || "",
        role: cp.yourRole || (currentSender && currentSender.role) || "",
        company: cp.companyName || (currentSender && currentSender.company) || "",
        context: cp.whatYouSell || (currentSender && currentSender.context) || "",
        valueProp: cp.valueProp || "",
        icp: cp.icp || "",
        tone: cp.tone || "",
        proofPoints: cp.proofPoints || "",
        background: cp.background || "",
        calendlyUrl: cp.calendlyUrl || "",
        claudeMemoryRaw: cp.claudeMemoryRaw || "",
        voiceExamples: Array.isArray(voiceExamples) ? voiceExamples : [],
        icpLearnings: (icpLearningsObj && icpLearningsObj.icpSummary) || "",
        objectionPlaybook, proofLibrary, relevantCallNotes,
      };

      const res = await fetch(HANDLE_REPLY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: currentProfile,
          replyText,
          originalOutreach,
          channel,
          language: currentLanguage,
          sender: richSender,
          ninjaPearData,
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = await res.json();
      showHandleReplyResult(data, { replyText, channel });
    } catch (err) {
      console.error("Klosr handle-reply error:", err);
      showApiErrorScreen(err.message || String(err), currentMode, currentProfile);
    }
  }

  function showHandleReplyResult(data, ctx) {
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";
    const displayName = getDisplayName(currentProfile);

    const classLabelMap = {
      interested:  isEs ? "Interesado"     : "Interested",
      objection:   isEs ? "Objeción"        : "Objection",
      booking:     isEs ? "Agendando"       : "Booking",
      deferral:    isEs ? "Posponiendo"     : "Deferral",
      not_fit:     isEs ? "No encaja"       : "Not a fit",
      off_topic:   isEs ? "Fuera de tema"   : "Off-topic",
    };
    const classColorMap = {
      interested: "green", objection: "gold", booking: "green",
      deferral: "muted", not_fit: "red", off_topic: "muted",
    };
    const cls = data.classification || "off_topic";
    const cColor = classColorMap[cls] || "muted";
    const cLabel = classLabelMap[cls] || cls;

    const subj = (data.suggestedReply && data.suggestedReply.subject) || "";
    const body = (data.suggestedReply && data.suggestedReply.body) || "";

    content.innerHTML = `
      <div class="briefme-reply-result">
        <div class="briefme-reply-head">
          <div class="briefme-reply-from">${isEs ? "Respuesta de" : "Reply from"} <strong>${escapeHtml(displayName)}</strong></div>
          <span class="briefme-reply-pill briefme-reply-pill-${cColor}">${escapeHtml(cLabel)}${data.confidence ? ` · ${escapeHtml(data.confidence)}` : ""}</span>
        </div>

        ${data.summary ? `<div class="briefme-reply-summary">${escapeHtml(data.summary)}</div>` : ""}

        ${subj ? `
          <div class="briefme-email-section">
            <div class="briefme-email-section-row">
              <div class="briefme-email-section-label">${isEs ? "Asunto" : "Subject"}</div>
              <button class="briefme-email-mini-copy" id="briefme-reply-copy-subj">${isEs ? "Copiar" : "Copy"}</button>
            </div>
            <div class="briefme-email-subject-box">${escapeHtml(subj)}</div>
          </div>
        ` : ""}

        <div class="briefme-email-section">
          <div class="briefme-email-section-row">
            <div class="briefme-email-section-label">${isEs ? "Tu respuesta" : "Your draft"}</div>
            <button class="briefme-email-mini-copy" id="briefme-reply-copy-body">${isEs ? "Copiar" : "Copy"}</button>
          </div>
          <div class="briefme-email-body-box" id="briefme-reply-body-box" contenteditable="true" spellcheck="true">${escapeHtml(body).replace(/\n/g, "<br>")}</div>
        </div>

        ${data.nextStep ? `
          <div class="briefme-reply-next">
            <div class="briefme-reply-next-label">${isEs ? "SIGUIENTE PASO" : "NEXT STEP"}</div>
            <div class="briefme-reply-next-text">${escapeHtml(data.nextStep)}</div>
          </div>
        ` : ""}

        <div class="briefme-email-actions">
          <button class="briefme-copy-btn" id="briefme-reply-copy-full">${isEs ? "Copiar respuesta completa" : "Copy full reply"}</button>
        </div>

        <div class="briefme-email-footer">
          <button class="briefme-email-link" id="briefme-reply-another">${isEs ? "Otra respuesta" : "Handle another reply"}</button>
          <button class="briefme-email-link" id="briefme-reply-back-picker">← ${isEs ? "Volver" : "Back"}</button>
        </div>
      </div>
    `;

    const liveBody = () => {
      const box = document.getElementById("briefme-reply-body-box");
      if (!box) return body;
      const clone = box.cloneNode(true);
      clone.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
      clone.querySelectorAll("div").forEach(d => d.replaceWith(document.createTextNode("\n" + d.textContent)));
      return (clone.textContent || "").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    };

    const subBtn = document.getElementById("briefme-reply-copy-subj");
    if (subBtn) subBtn.addEventListener("click", (e) => {
      navigator.clipboard.writeText(subj).then(() => flashCopy(e.currentTarget));
    });
    document.getElementById("briefme-reply-copy-body").addEventListener("click", (e) => {
      const b = liveBody();
      navigator.clipboard.writeText(b).then(() => {
        flashCopy(e.currentTarget);
        if (b !== body) recordVoiceDiff(body, b).catch(() => {});
      });
    });
    document.getElementById("briefme-reply-copy-full").addEventListener("click", (e) => {
      const b = liveBody();
      const full = subj ? `Subject: ${subj}\n\n${b}` : b;
      navigator.clipboard.writeText(full).then(() => {
        const btn = e.currentTarget;
        const orig = btn.textContent;
        btn.textContent = isEs ? "¡Copiado!" : "Copied!";
        setTimeout(() => { btn.textContent = orig; }, 1500);
        if (b !== body) recordVoiceDiff(body, b).catch(() => {});
      });
    });
    document.getElementById("briefme-reply-another").addEventListener("click", showHandleReplyForm);
    document.getElementById("briefme-reply-back-picker").addEventListener("click", () => {
      document.getElementById("briefme-sidebar").classList.remove("briefme-picker-view");
      showModePicker();
    });
  }

  async function handleEmailClick() {
    logKlosrEvent("email_drafted", { language: currentLanguage });
    if (currentProfile && currentProfile.profileUrl) {
      recordDealActivity(currentProfile.profileUrl, "email", {}).catch(() => {});
      setDealStage(currentProfile.profileUrl, "contacted").catch(() => {});
    }
    // Make sure sender info is loaded from chrome.storage
    if (currentSender === null) {
      await loadSenderFromStorage();
    }

    // No sender info? Show the setup form first
    if (!currentSender || !currentSender.name) {
      showSenderForm({ generateAfter: true });
      return;
    }

    // Have sender info — go straight to generation
    generateEmail();
  }

  // Show the sender info setup form. If generateAfter is true, will
  // call generateEmail() after submit; otherwise just returns to brief.
  function showSenderForm({ generateAfter } = {}) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view"); // reuse the wider chrome

    const content = document.getElementById("briefme-content");
    const prev = currentSender || { name: "", role: "", company: "", context: "" };

    content.innerHTML = `
      <div class="briefme-questionnaire">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${t("email_setup_title")}</div>
          <div class="briefme-quest-subtitle">${t("email_setup_subtitle")}</div>
        </div>
        <form class="briefme-quest-form" id="briefme-sender-form">
          <label class="briefme-quest-label" for="briefme-sender-name">${t("email_setup_name_label")}</label>
          <input
            type="text"
            id="briefme-sender-name"
            class="briefme-quest-input"
            placeholder="${t("email_setup_name_placeholder")}"
            value="${escapeHtml(prev.name || "")}"
            autocomplete="off"
            required
          />

          <label class="briefme-quest-label" for="briefme-sender-role">${t("email_setup_role_label")}</label>
          <input
            type="text"
            id="briefme-sender-role"
            class="briefme-quest-input"
            placeholder="${t("email_setup_role_placeholder")}"
            value="${escapeHtml(prev.role || "")}"
            autocomplete="off"
          />

          <label class="briefme-quest-label" for="briefme-sender-company">${t("email_setup_company_label")}</label>
          <input
            type="text"
            id="briefme-sender-company"
            class="briefme-quest-input"
            placeholder="${t("email_setup_company_placeholder")}"
            value="${escapeHtml(prev.company || "")}"
            autocomplete="off"
          />

          <label class="briefme-quest-label" for="briefme-sender-context">${t("email_setup_context_label")}</label>
          <textarea
            id="briefme-sender-context"
            class="briefme-quest-textarea"
            placeholder="${t("email_setup_context_placeholder")}"
            rows="2"
          >${escapeHtml(prev.context || "")}</textarea>

          <div class="briefme-quest-actions">
            <button type="button" class="briefme-quest-back" id="briefme-sender-back">${t("email_setup_back")}</button>
            <button type="submit" class="briefme-quest-submit">${t("email_setup_submit")}</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById("briefme-sender-back").addEventListener("click", () => {
      sidebar.classList.remove("briefme-picker-view");
      // Return to wherever we came from — re-render the brief
      if (currentBrief) {
        renderBrief(currentBrief, currentMode);
      } else {
        showModePicker();
      }
    });

    document.getElementById("briefme-sender-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const sender = {
        name: document.getElementById("briefme-sender-name").value.trim(),
        role: document.getElementById("briefme-sender-role").value.trim(),
        company: document.getElementById("briefme-sender-company").value.trim(),
        context: document.getElementById("briefme-sender-context").value.trim(),
      };
      await saveSenderToStorage(sender);

      sidebar.classList.remove("briefme-picker-view");

      if (generateAfter) {
        generateEmail();
      } else if (currentEmail) {
        // Re-render existing email with new sign-off
        showEmailView(currentEmail);
      } else if (currentBrief) {
        renderBrief(currentBrief, currentMode);
      } else {
        showModePicker();
      }
    });
  }

  // Show the loading state while the email is being generated
  function showEmailLoading() {
    const content = document.getElementById("briefme-content");
    content.innerHTML = `
      <div class="briefme-loading">
        <div class="briefme-spinner"></div>
        <p>${t("email_loading")}</p>
        <p class="briefme-loading-sub">${t("email_loading_sub")}</p>
      </div>
    `;
  }

  // Call the email API to generate subject/body/guesses
  async function generateEmail() {
    showEmailLoading();
    try {
      // Build a rich sender object from the company profile + legacy sender,
      // plus every accumulated learning signal (voice, ICP, objections, proof,
      // call notes). These make each email sharper than the last.
      const cp = companyProfile || {};
      // Bounded wait (3s) for enrichment — email drafts benefit meaningfully
      // from real company facts (funding for proof points, size for ICP
      // framing). Cache hit after the first touch = zero wait.
      const [voiceExamples, icpLearningsObj, objectionPlaybook, proofLibrary, relevantCallNotes, ninjaPearData] = await Promise.all([
        getVoiceExamples(),
        getICPLearnings(),
        getObjectionPlaybook(),
        getProofLibrary(),
        getRelevantCallNotes(currentProfile),
        waitForNinjaPear(currentProfile, 3000),
      ]);

      const richSender = {
        name: cp.yourName || (currentSender && currentSender.name) || "",
        role: cp.yourRole || (currentSender && currentSender.role) || "",
        company: cp.companyName || (currentSender && currentSender.company) || "",
        context: cp.whatYouSell || (currentSender && currentSender.context) || "",
        valueProp: cp.valueProp || "",
        icp: cp.icp || "",
        tone: cp.tone || "",
        proofPoints: cp.proofPoints || "",
        background: cp.background || "",
        calendlyUrl: cp.calendlyUrl || "",
        claudeMemoryRaw: cp.claudeMemoryRaw || "",
        voiceExamples: Array.isArray(voiceExamples) ? voiceExamples : [],
        icpLearnings: (icpLearningsObj && icpLearningsObj.icpSummary) || "",
        objectionPlaybook: objectionPlaybook,
        proofLibrary: proofLibrary,
        relevantCallNotes: relevantCallNotes,
      };

      const response = await fetch(EMAIL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: currentProfile,
          mode: currentMode,
          brief: currentBrief,
          language: currentLanguage,
          sender: richSender,
          ninjaPearData: ninjaPearData,
          systemPromptVersion: "2.0",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error("PrepCall.AI Email API failure:", {
          status: response.status,
          error: errorText.slice(0, 500),
        });
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200) || "no body"}`);
      }

      const data = await response.json();
      if (!data || typeof data.subject !== "string" || typeof data.body !== "string") {
        throw new Error("Email API returned invalid data");
      }

      const hasScrapedEmails = Array.isArray(currentProfile.extractedEmails)
        && currentProfile.extractedEmails.length > 0;

      currentEmail = {
        subject: data.subject,
        body: data.body,
        emailGuesses: Array.isArray(data.emailGuesses) ? data.emailGuesses : [],
        // Apollo state: idle | searching | found | notfound | error
        leadmagicState: hasScrapedEmails ? "idle" : "searching",
      };

      // Render immediately so the user sees the email while we fetch real
      // addresses from Apollo in the background.
      showEmailView(currentEmail);

      // Only hit Apollo if the DOM scrape didn't already find emails —
      // Apollo credits cost money, no point spending them when we already
      // have a real email from the profile itself.
      if (!hasScrapedEmails && currentProfile.profileUrl) {
        fetchProxycurlEmails(currentProfile.profileUrl);
      }
    } catch (error) {
      console.error("Klosr generateEmail error:", error);
      showApiErrorScreen(error.message || String(error), currentMode, currentProfile);
    }
  }

  // Proxycurl enrichment — runs in the BACKGROUND, never blocks a brief.
  //
  // Strategy: warm up the second we know which profile the user is on
  // (triggered from scrapeProfile), and serve cached results on demand
  // via getNinjaPearCached(). Callers of briefs/emails/chat do NOT await
  // this — they call the sync getter and use whatever's ready, so the
  // first brief is never delayed by enrichment latency. By the time the
  // user clicks a second action, the enrichment is usually done (cached
  // for 30 min) and it's zero cost.
  //
  // Session-wide in-flight map so concurrent calls dedupe to one fetch.
  const _ninjaInFlight = new Map(); // key = canonical URL, val = Promise

  function getNinjaPearCached(profile) {
    if (!profile) return null;
    if (profile.ninjaPearData && profile.ninjaPearFetchedAt) {
      const age = Date.now() - profile.ninjaPearFetchedAt;
      if (age < 30 * 60 * 1000) return profile.ninjaPearData;
    }
    return null;
  }

  // Kick off enrichment for a profile if we haven't already. Returns a
  // Promise only when the caller explicitly wants to await (rare). Callers
  // that just want "warm the cache" can ignore the return value entirely.
  function warmNinjaPear(profile) {
    if (!profile) return null;

    // Cache hit — no work needed.
    if (getNinjaPearCached(profile)) return Promise.resolve(profile.ninjaPearData);

    // Already failed once this session — don't re-fire, but don't block either.
    if (profile.ninjaPearAttempted && !profile.ninjaPearData) return Promise.resolve(null);

    const canonicalUrl = canonicalizeLinkedInUrl(profile.profileUrl || "");
    if (!canonicalUrl) return Promise.resolve(null);

    // Dedupe concurrent warm-ups for the same profile URL (e.g. mode picker
    // render + brief click + email click all fire within 200ms).
    if (_ninjaInFlight.has(canonicalUrl)) return _ninjaInFlight.get(canonicalUrl);

    profile.ninjaPearAttempted = true;
    const payload = {
      linkedinUrl: canonicalUrl,
      name: profile.name || "",
      headline: profile.headline || "",
      company: profile.currentCompany || "",
      role: profile.currentRole || "",
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const p = fetch(NINJAPEAR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }).then(async (res) => {
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object") return null;
      profile.ninjaPearData = data;
      profile.ninjaPearFetchedAt = Date.now();
      return data;
    }).catch(() => {
      clearTimeout(timer);
      return null;
    }).finally(() => {
      _ninjaInFlight.delete(canonicalUrl);
    });

    _ninjaInFlight.set(canonicalUrl, p);
    return p;
  }

  // Back-compat shim so older call sites that awaited this keep working.
  // New code should call getNinjaPearCached + warmNinjaPear directly.
  async function enrichProfileWithNinjaPear(profile) {
    if (!profile) return null;
    const cached = getNinjaPearCached(profile);
    if (cached) return cached;
    // Don't block — just warm + return whatever's cached (null if first call).
    warmNinjaPear(profile);
    return getNinjaPearCached(profile);
  }

  // Bounded wait: returns cached enrichment instantly if we have it, otherwise
  // kicks off a warm-up and waits UP TO maxWaitMs for it to complete. Used by
  // the brief path so first-time briefs actually contain company facts (vs
  // returning empty and forcing the model to say "profile is thin"). Subsequent
  // briefs get the cache free — zero wait.
  async function waitForNinjaPear(profile, maxWaitMs = 4000) {
    if (!profile) return null;
    const cached = getNinjaPearCached(profile);
    if (cached) return cached;
    const pending = warmNinjaPear(profile);
    if (!pending || typeof pending.then !== "function") return null;
    try {
      const result = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve(null), maxWaitMs)),
      ]);
      return result || getNinjaPearCached(profile);
    } catch (e) {
      return null;
    }
  }

  // Canonicalize a LinkedIn profile URL before handing it to Apollo.
  // Apollo's matcher is picky: query params, trailing slashes, Sales Nav
  // URLs, and the legacy /pub/ format all reduce the hit rate. Output is
  // always the form "https://www.linkedin.com/in/<handle>" with no trailing
  // slash, no tracking params, no locale subdomain.
  function canonicalizeLinkedInUrl(raw) {
    if (!raw) return "";
    let s = String(raw).trim();
    // Drop query + hash — miniProfileUrn, trackingId etc. break matching
    s = s.split("?")[0].split("#")[0];
    // Normalize subdomain: www is canonical, anything else (locale, m.) → www
    s = s.replace(/^https?:\/\/[a-z]{2,3}\.linkedin\.com\//i, "https://www.linkedin.com/");
    s = s.replace(/^https?:\/\/m\.linkedin\.com\//i, "https://www.linkedin.com/");
    // Sales Navigator — /sales/people/<slug>,xxx → /in/<slug>
    const salesMatch = s.match(/\/sales\/(?:people|lead)\/([^,/]+)/i);
    if (salesMatch) s = `https://www.linkedin.com/in/${salesMatch[1]}`;
    // Legacy /pub/<slug>/<a>/<b>/<c> → /in/<slug>-<c>-<b>-<a>
    const pubMatch = s.match(/\/pub\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/i);
    if (pubMatch) {
      s = `https://www.linkedin.com/in/${pubMatch[1]}-${pubMatch[4]}-${pubMatch[3]}-${pubMatch[2]}`;
    }
    // Strip trailing slashes
    s = s.replace(/\/+$/, "");
    // Ensure scheme
    if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
    return s;
  }

  // Sniff obvious junk out of returned emails before surfacing them to the
  // user. Apollo occasionally returns role/system addresses or scraper
  // artefacts; we trust the backend but not blindly.
  function isUsableEmail(addr) {
    if (!addr || typeof addr !== "string") return false;
    const e = addr.toLowerCase().trim();
    if (!/^[a-z0-9._+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return false;
    if (e.includes("@linkedin.com") || e.includes("@licdn.com")) return false;
    if (e.startsWith("noreply@") || e.startsWith("no-reply@") || e.startsWith("donotreply@")) return false;
    if (e.includes("@example.") || e.includes(".test")) return false;
    // Obvious placeholder/scraper artefacts
    if (/^(test|fake|dummy|null|undefined|admin)@/.test(e)) return false;
    return true;
  }

  // Single attempt against the Klosr find-email endpoint with a hard timeout.
  // Returns { status, emails[] } where status is "found" | "notfound" | "retryable" | "fatal".
  async function _findEmailOnce(linkedinUrl, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(FIND_EMAIL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinUrl }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status >= 500) return { status: "retryable", emails: [], phones: [] };
      if (res.status === 429) return { status: "retryable", emails: [], phones: [] };
      if (!res.ok) {
        // Parse the error body so the UI can show the right message.
        // 402 with "apollo_plan_required" → user needs a paid Apollo plan.
        // 402 with "apollo_credits_exhausted" → out of credits this month.
        // 402 with "apollo_auth_failed" → bad or missing key.
        // 402 with "apollo_not_configured" → server missing APOLLO_API_KEY.
        // 404 or other 4xx → just "no data for this profile".
        const data = await res.json().catch(() => ({}));
        const reason = data && data.error || "";
        console.warn("Klosr find-email: lookup unsuccessful", res.status, reason);
        if (reason === "apollo_plan_required") {
          return { status: "plan_required", emails: [], phones: [], reason };
        }
        if (reason === "apollo_auth_failed" || reason === "apollo_not_configured") {
          return { status: "config_error", emails: [], phones: [], reason };
        }
        if (reason === "apollo_credits_exhausted") {
          return { status: "credits_out", emails: [], phones: [], reason };
        }
        return { status: "notfound", emails: [], phones: [] };
      }

      const data = await res.json().catch(() => ({}));
      const raw = Array.isArray(data.personalEmails) ? data.personalEmails : [];
      const emails = raw
        .map(e => String(e).trim().toLowerCase())
        .filter(isUsableEmail);
      // Apollo returns phone numbers alongside emails (different credit pool).
      // Shape: [{number, sanitized, type, verified, dnc}, ...] already ranked
      // mobile > work_direct > home > other > work_hq.
      const phones = Array.isArray(data.phones) ? data.phones.slice(0, 6) : [];

      return (emails.length > 0 || phones.length > 0)
        ? { status: "found", emails, phones }
        : { status: "notfound", emails: [], phones: [] };
    } catch (e) {
      clearTimeout(timer);
      // AbortError (timeout) + generic network errors are retryable
      return { status: "retryable", emails: [], phones: [] };
    }
  }

  // Call the Klosr find-email endpoint (Apollo-backed). Fast path:
  //   - 1 attempt, 5s timeout. On 5xx/429, ONE retry at 4s.
  //   - No Contact Info overlay fallback on the auto-path. The overlay is
  //     expensive (opens LinkedIn's own modal + polls for 2.5s) AND visual,
  //     so it's too slow for the "user just opened the extension" flow.
  //     If the user explicitly needs an email, they can use the email guesses
  //     or the backend can re-run via a dedicated button later.
  async function fetchProxycurlEmails(linkedinUrl) {
    const setState = (newState) => {
      if (currentProfile) currentProfile.leadmagicState = newState;
      if (currentEmail) currentEmail.leadmagicState = newState;
      if (document.getElementById("briefme-picker-email")) renderPickerEmail();
      if (currentEmail && document.querySelector(".briefme-email-view")) showEmailView(currentEmail);
    };

    const mergeEmails = (incoming) => {
      const existing = Array.isArray(currentProfile.extractedEmails)
        ? currentProfile.extractedEmails : [];
      const merged = Array.from(new Set(
        [...incoming, ...existing].map(e => String(e).trim().toLowerCase()),
      )).filter(isUsableEmail);
      currentProfile.extractedEmails = merged;
      // Fire NinjaPear disposable-email check in the background — free
      // endpoint, results populate currentProfile.emailVerification so the
      // email view can flag ⚠ next to risky addresses without blocking
      // the initial render.
      verifyEmailsInBackground(merged);
      return merged.length > 0;
    };

    const mergePhones = (incoming) => {
      if (!Array.isArray(incoming) || incoming.length === 0) return;
      const existing = Array.isArray(currentProfile.extractedPhones)
        ? currentProfile.extractedPhones : [];
      // Dedupe by sanitized digits — keep first-seen ordering (Apollo returns
      // them pre-ranked: mobile > work_direct > others).
      const seen = new Set(existing.map(p => p.sanitized));
      const merged = [...existing];
      for (const p of incoming) {
        if (!p || !p.sanitized || seen.has(p.sanitized)) continue;
        seen.add(p.sanitized);
        merged.push(p);
      }
      currentProfile.extractedPhones = merged;
    };

    const canonical = canonicalizeLinkedInUrl(linkedinUrl);

    // First attempt — short timeout, no delay.
    let result = await _findEmailOnce(canonical, 5000);
    if (result.status === "found") {
      mergePhones(result.phones);
      if (mergeEmails(result.emails) || (result.phones && result.phones.length)) {
        setState("found");
        return;
      }
    }

    // ONE retry on transient failure only. Keep it quick.
    if (result.status === "retryable") {
      await new Promise(r => setTimeout(r, 400));
      result = await _findEmailOnce(canonical, 6000);
      if (result.status === "found") {
        mergePhones(result.phones);
        if (mergeEmails(result.emails) || (result.phones && result.phones.length)) {
          setState("found");
          return;
        }
      }
    }

    // Map sub-status to display state so the email view shows the right
    // banner (plan upgrade, config error, out-of-credits, or just "no data").
    const nextState = result.status === "notfound" ? "notfound"
                    : result.status === "plan_required" ? "plan_required"
                    : result.status === "config_error" ? "config_error"
                    : result.status === "credits_out" ? "credits_out"
                    : "error";
    setState(nextState);
  }

  // NinjaPear disposable-email check — free, run in background for every
  // email Klosr discovers (Apollo or DOM-scraped). Populates
  // currentProfile.emailVerification = { [email]: { disposable, free } } so
  // showEmailView can render ⚠ badges on risky addresses.
  async function verifyEmailsInBackground(emails) {
    if (!Array.isArray(emails) || emails.length === 0 || !currentProfile) return;
    if (!currentProfile.emailVerification) currentProfile.emailVerification = {};

    const todo = emails.filter(e => !currentProfile.emailVerification[e]);
    if (todo.length === 0) return;

    // Sequential with a small gap — we're usually only verifying 1-3 emails
    // at a time, and the endpoint is free but still hits NinjaPear's
    // quota-level rate limits. Keep it polite.
    for (const email of todo) {
      const data = await callIntel("verify-email", { email });
      if (!data) continue;
      currentProfile.emailVerification[email] = {
        disposable: Boolean(data.isDisposable),
        free: Boolean(data.isFree),
      };
    }

    // Re-render if the email view is currently visible so the new badges
    // show up without forcing the user to navigate away + back.
    if (currentEmail && document.querySelector(".briefme-email-view")) {
      showEmailView(currentEmail);
    }
  }

  // NinjaPear company-logo fetch — free endpoint. Called when a profile
  // loads and we know the company domain. Populates
  // currentProfile.companyLogoDataUrl so the sidebar header can render it
  // next to the prospect's company name.
  async function loadCompanyLogoInBackground(domain) {
    if (!domain || !currentProfile || currentProfile.companyLogoDataUrl) return;
    const data = await callIntel("company-logo", { domain });
    if (data && data.logoDataUrl) {
      currentProfile.companyLogoDataUrl = data.logoDataUrl;
      const headerImg = document.getElementById("briefme-company-logo-img");
      if (headerImg) {
        headerImg.src = data.logoDataUrl;
        headerImg.style.display = "inline-block";
      }
    }
  }

  // Render the generated email with copy buttons + email guesses
  function showEmailView(email) {
    const content = document.getElementById("briefme-content");
    const displayName = getDisplayName(currentProfile);

    // REAL emails scraped from the LinkedIn profile (mailto: links, About text, etc.)
    const realEmails = Array.isArray(currentProfile && currentProfile.extractedEmails)
      ? currentProfile.extractedEmails
      : [];
    const hasRealEmails = realEmails.length > 0;

    // Priority order for the hero "Draft in Gmail" button:
    // 1. First REAL email found on the profile
    // 2. First AI-guessed pattern
    // 3. Nothing — compose blank
    const primaryRecipient = hasRealEmails
      ? realEmails[0]
      : (email.emailGuesses && email.emailGuesses[0]) || "";

    // Build Gmail compose URL
    const gmailUrl = "https://mail.google.com/mail/?view=cm&fs=1" +
      (primaryRecipient ? "&to=" + encodeURIComponent(primaryRecipient) : "") +
      "&su=" + encodeURIComponent(email.subject) +
      "&body=" + encodeURIComponent(email.body);

    // Apollo-revealed phone numbers. Ranked mobile > work_direct > other.
    // We display up to 4 to keep the view tight. Each row has a tel: link
    // (native OS handoff — iOS FaceTime, macOS Phone, Android dialer) and a
    // copy button for when the user wants to paste into their CRM or a
    // softphone like Aircall / Dialpad.
    const realPhones = Array.isArray(currentProfile && currentProfile.extractedPhones)
      ? currentProfile.extractedPhones.slice(0, 4)
      : [];
    const hasPhones = realPhones.length > 0;
    const phoneTypeLabel = (t) => {
      const x = String(t || "").toLowerCase();
      if (x === "mobile")       return isEs ? "móvil" : "mobile";
      if (x === "work_direct")  return isEs ? "directo trabajo" : "direct";
      if (x === "work_hq" || x === "corporate_main") return isEs ? "central" : "HQ";
      if (x === "home")         return isEs ? "casa" : "home";
      return isEs ? "otro" : "other";
    };
    const phonesHtml = hasPhones ? `
      <div class="briefme-email-section">
        <div class="briefme-email-section-row">
          <div class="briefme-email-section-label-with-badge">
            <span class="briefme-email-section-label">${isEs ? "Teléfonos (Apollo)" : "Phone numbers (Apollo)"}</span>
            <span class="briefme-email-verified-badge">${realPhones.length}</span>
          </div>
        </div>
        <div class="briefme-email-guesses">
          ${realPhones.map((p) => {
            const typeCls = String(p.type || "other").toLowerCase().replace(/[^a-z_]/g, "");
            return `
            <div class="briefme-phone-row briefme-phone-${escapeHtml(typeCls)}">
              <a class="briefme-phone-number" href="tel:${escapeHtml(p.sanitized || p.number)}" title="${isEs ? "Llamar" : "Call"}">${escapeHtml(p.number)}</a>
              <span class="briefme-phone-type">${escapeHtml(phoneTypeLabel(p.type))}${p.verified ? ` · <span class="briefme-phone-verified">${isEs ? "verificado" : "verified"}</span>` : ""}${p.dnc ? ` · <span class="briefme-phone-dnc" title="${isEs ? "No llamar (DNC)" : "Do-not-call list"}">⚠ DNC</span>` : ""}</span>
              <button class="briefme-email-guess-copy" data-phone="${escapeHtml(p.sanitized || p.number)}" title="${isEs ? "Copiar" : "Copy"}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
            </div>
          `;}).join("")}
        </div>
      </div>
    ` : "";

    // Real-emails section (green, "VERIFIED" style) — shown only if we found any
    const realEmailsHtml = hasRealEmails
      ? `
        <div class="briefme-email-section">
          <div class="briefme-email-section-row">
            <div class="briefme-email-section-label-with-badge">
              <span class="briefme-email-section-label">${t("email_found_label")}</span>
              <span class="briefme-email-verified-badge">${t("email_found_badge")}</span>
            </div>
          </div>
          <div class="briefme-email-guesses">
            ${realEmails.map((addr) => {
              // NinjaPear-verified flags — show ⚠ for disposable / ℹ for
              // free-mail (gmail, outlook, etc). Silent when address looks
              // normal / work-domain. Neutral when verification hasn't run yet.
              const ver = currentProfile && currentProfile.emailVerification && currentProfile.emailVerification[addr];
              let flag = "";
              if (ver) {
                if (ver.disposable) {
                  flag = `<span class="briefme-email-flag briefme-email-flag-disposable" title="${isEs ? "Dirección desechable — probablemente no recibe respuestas" : "Disposable address — unlikely to get a reply"}">⚠ ${isEs ? "desechable" : "disposable"}</span>`;
                } else if (ver.free) {
                  flag = `<span class="briefme-email-flag briefme-email-flag-free" title="${isEs ? "Correo personal (gmail, hotmail, etc.)" : "Personal email (gmail, hotmail, etc.)"}">${isEs ? "personal" : "personal"}</span>`;
                }
              }
              return `
              <div class="briefme-email-guess briefme-email-guess-real">
                <span class="briefme-email-guess-addr">${escapeHtml(addr)}</span>
                ${flag}
                <button class="briefme-email-guess-copy" data-addr="${escapeHtml(addr)}" title="${t("email_copy")}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              </div>
            `}).join("")}
          </div>
        </div>
      `
      : "";

    // AI-guessed patterns section — show only if we have any, labeled as guesses
    const guessesHtml = email.emailGuesses && email.emailGuesses.length > 0
      ? `
        <div class="briefme-email-section">
          <div class="briefme-email-section-label">${t("email_guesses_label")}</div>
          <div class="briefme-email-guesses">
            ${email.emailGuesses.map((addr) => `
              <div class="briefme-email-guess">
                <span class="briefme-email-guess-addr">${escapeHtml(addr)}</span>
                <button class="briefme-email-guess-copy" data-addr="${escapeHtml(addr)}" title="${t("email_copy")}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              </div>
            `).join("")}
          </div>
        </div>
      `
      : (hasRealEmails ? "" : `<div class="briefme-email-no-guesses">${t("email_no_guesses")}</div>`);

    // Apollo status indicator — only shown while the verified section is empty
    const isEs = currentLanguage === "es";
    const leadmagicHtml = (!hasRealEmails && email.leadmagicState)
      ? (() => {
          if (email.leadmagicState === "searching") {
            return `<div class="briefme-leadmagic-status briefme-leadmagic-searching">
              <div class="briefme-leadmagic-spinner"></div>
              <span>${isEs ? "Buscando email verificado vía Apollo…" : "Searching Apollo for a verified email…"}</span>
            </div>`;
          }
          if (email.leadmagicState === "notfound") {
            return `<div class="briefme-leadmagic-status briefme-leadmagic-notfound">
              ${isEs
                ? "Apollo no tiene email verificado para este perfil. Prueba con los patrones de arriba."
                : "Apollo has no verified email for this profile. Try the guess patterns above."}
            </div>`;
          }
          if (email.leadmagicState === "plan_required") {
            return `<div class="briefme-leadmagic-status briefme-leadmagic-error">
              ${isEs
                ? "Apollo People Match requiere un plan de pago (Basic o superior). "
                : "Apollo People Match requires a paid plan (Basic or above). "}
              <a href="https://app.apollo.io/#/settings/billing" target="_blank" rel="noopener noreferrer" style="color:#FFD60A; text-decoration:underline;">${isEs ? "Mejorar plan" : "Upgrade plan"}</a>
              ${isEs ? ". Mientras tanto, usa los patrones de arriba." : ". Use the patterns above in the meantime."}
            </div>`;
          }
          if (email.leadmagicState === "config_error") {
            return `<div class="briefme-leadmagic-status briefme-leadmagic-error">
              ${isEs
                ? "Clave de Apollo inválida o no configurada. Avisa al admin."
                : "Apollo API key invalid or not set. Contact the admin."}
            </div>`;
          }
          if (email.leadmagicState === "credits_out") {
            return `<div class="briefme-leadmagic-status briefme-leadmagic-error">
              ${isEs
                ? "Sin créditos de Apollo este mes. "
                : "Out of Apollo credits this month. "}
              <a href="https://app.apollo.io/#/settings/billing" target="_blank" rel="noopener noreferrer" style="color:#FFD60A; text-decoration:underline;">${isEs ? "Comprar más" : "Buy more"}</a>
            </div>`;
          }
          if (email.leadmagicState === "error") {
            return `<div class="briefme-leadmagic-status briefme-leadmagic-error">
              ${isEs
                ? "Error de red buscando el email. Vuelve a intentar."
                : "Network error looking up email. Try again."}
            </div>`;
          }
          return "";
        })()
      : "";

    // Hero "Draft in Gmail" button — the primary CTA
    const heroRecipientLabel = primaryRecipient
      ? `<div class="briefme-hero-gmail-to">${t("email_sending_to")} <strong>${escapeHtml(primaryRecipient)}</strong></div>`
      : `<div class="briefme-hero-gmail-to briefme-hero-gmail-to-empty">${t("email_no_recipient")}</div>`;

    content.innerHTML = `
      <div class="briefme-email-view">
        <div class="briefme-email-header">
          <div class="briefme-email-recipient-label">${t("email_btn")} → ${escapeHtml(displayName)}</div>
        </div>

        <a class="briefme-hero-gmail-btn" href="${gmailUrl}" target="_blank" rel="noopener noreferrer">
          <div class="briefme-hero-gmail-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0A0A0A" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
              <polyline points="22,6 12,13 2,6"></polyline>
            </svg>
          </div>
          <div class="briefme-hero-gmail-text">
            <div class="briefme-hero-gmail-title">${t("email_draft_gmail")}</div>
            ${heroRecipientLabel}
          </div>
          <div class="briefme-hero-gmail-arrow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </div>
        </a>

        ${realEmailsHtml}
        ${phonesHtml}
        ${leadmagicHtml}
        ${guessesHtml}

        <div class="briefme-email-section">
          <div class="briefme-email-section-row">
            <div class="briefme-email-section-label">${t("email_subject_label")}</div>
            <button class="briefme-email-mini-copy" id="briefme-email-copy-subject">${t("email_copy")}</button>
          </div>
          <div class="briefme-email-subject-box">${escapeHtml(email.subject)}</div>
        </div>

        <div class="briefme-email-section">
          <div class="briefme-email-section-row">
            <div class="briefme-email-section-label">${t("email_body_label")}</div>
            <button class="briefme-email-mini-copy" id="briefme-email-copy-body">${t("email_copy")}</button>
          </div>
          <div class="briefme-email-body-box" id="briefme-email-body-box" contenteditable="true" spellcheck="true" data-original-body="${escapeHtml(email.body)}">${escapeHtml(email.body).replace(/\n/g, "<br>")}</div>
        </div>

        <div class="briefme-email-actions">
          <button class="briefme-copy-btn" id="briefme-email-copy-full">${t("email_copy_full")}</button>
        </div>

        <div class="briefme-email-outcome" id="briefme-email-outcome">
          <div class="briefme-email-outcome-label">Did it land? Klosr learns from outcomes.</div>
          <div class="briefme-email-outcome-actions">
            <button class="briefme-outcome-btn briefme-outcome-won" data-stage="won">Won</button>
            <button class="briefme-outcome-btn briefme-outcome-lost" data-stage="lost">Lost</button>
            <button class="briefme-outcome-btn briefme-outcome-skip" data-stage="skip">Skip</button>
          </div>
        </div>

        <div class="briefme-email-footer">
          <button class="briefme-email-link" id="briefme-email-back">← ${t("email_back_to_brief")}</button>
          <button class="briefme-email-link" id="briefme-email-edit-sender">${t("email_edit_sender")}</button>
        </div>
      </div>
    `;

    // Wire up all the copy buttons + nav
    document.getElementById("briefme-email-copy-subject").addEventListener("click", (e) => {
      navigator.clipboard.writeText(email.subject).then(() => flashCopy(e.currentTarget));
    });

    // Helper to read the live edited body out of the contenteditable div.
    const readLiveBody = () => {
      const box = document.getElementById("briefme-email-body-box");
      if (!box) return email.body;
      const clone = box.cloneNode(true);
      clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
      clone.querySelectorAll("div").forEach((d) => {
        d.replaceWith(document.createTextNode("\n" + d.textContent));
      });
      return (clone.textContent || "").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    };

    // Record voice diff — fires on copy/send. Debounced via flag so we don't
    // spam the store with near-identical snapshots.
    let _voiceRecorded = false;
    const recordDiffOnce = async () => {
      if (_voiceRecorded) return;
      const live = readLiveBody();
      if (live && live !== email.body) {
        _voiceRecorded = true;
        await recordVoiceDiff(email.body, live);
      }
    };

    document.getElementById("briefme-email-copy-body").addEventListener("click", (e) => {
      const body = readLiveBody();
      navigator.clipboard.writeText(body).then(() => {
        flashCopy(e.currentTarget);
        recordDiffOnce();
      });
    });

    document.getElementById("briefme-email-copy-full").addEventListener("click", (e) => {
      const body = readLiveBody();
      const full = `Subject: ${email.subject}\n\n${body}`;
      navigator.clipboard.writeText(full).then(() => {
        const btn = e.currentTarget;
        const orig = btn.textContent;
        btn.textContent = t("email_copied_full");
        setTimeout(() => { btn.textContent = orig; }, 2000);
        recordDiffOnce();
      });
    });

    // Won / Lost / Skip — the ICP learning loop.
    document.querySelectorAll(".briefme-outcome-btn").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        const stage = ev.currentTarget.dataset.stage;
        if (stage === "skip") {
          const zone = document.getElementById("briefme-email-outcome");
          if (zone) zone.innerHTML = `<div class="briefme-email-outcome-done">Skipped. You can mark won/lost anytime from this email.</div>`;
          return;
        }
        await handleOutcomeClick(stage, currentProfile);
      });
    });

    document.querySelectorAll(".briefme-email-guess-copy").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        // Same button template used for both email + phone rows — check
        // data-addr first (emails), fall back to data-phone (Apollo numbers).
        const addr = e.currentTarget.dataset.addr || e.currentTarget.dataset.phone;
        if (!addr) return;
        navigator.clipboard.writeText(addr).then(() => flashCopy(e.currentTarget));
      });
    });

    document.getElementById("briefme-email-back").addEventListener("click", () => {
      if (currentBrief) {
        renderBrief(currentBrief, currentMode);
      } else {
        showModePicker();
      }
    });

    document.getElementById("briefme-email-edit-sender").addEventListener("click", () => {
      showSenderForm({ generateAfter: false });
    });
  }

  // Tiny "Copied!" flash animation helper for any copy button
  function flashCopy(btn) {
    if (!btn) return;
    btn.classList.add("briefme-flash-copied");
    const orig = btn.textContent;
    if (orig && !orig.match(/^[A-Za-z]{0,12}$/)) {
      // It's an icon button — don't replace text, just flash the class
      setTimeout(() => btn.classList.remove("briefme-flash-copied"), 1200);
    } else {
      btn.textContent = t("email_copied");
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove("briefme-flash-copied");
      }, 1200);
    }
  }

  // Format the AI response into HTML with card-based sections for scannability.
  // Different section types get different visual treatments so the brief can be
  // scanned in 5 seconds:
  //   - TL;DR        → hero card (largest, gradient background)
  //   - Power/Opening Line → quote card (italic with quote marks)
  //   - Real-Time Intel + Recent News → "fresh" card (yellow accent border, RECENT badge)
  //   - everything else → standard card
  function formatBrief(text) {
    // The TL;DR gets the hero treatment
    const HERO_SECTIONS = ["TL;DR"];

    // Power Line / Opening Line get the quote-card treatment
    const QUOTE_SECTIONS = [
      "POWER LINE",
      "OPENING LINE",
      "FRASE PODER",
      "FRASE DE APERTURA",
    ];

    // "Recent" sections get a freshness badge + accent border
    const RECENT_SECTIONS = [
      "REAL-TIME INTEL",
      "INTEL EN TIEMPO REAL",
      "RECENT ACHIEVEMENTS & NEWS",
      "LOGROS Y NOTICIAS RECIENTES",
    ];

    // Split on ## headers, keeping each header with its section body
    const parts = text.split(/(?=^## )/gm).filter(p => p.trim());

    return parts.map(part => {
      const headerMatch = part.match(/^## (.+)$/m);
      if (!headerMatch) {
        return formatInline(part);
      }

      const title = headerMatch[1].trim();
      const titleUpper = title.toUpperCase();
      const body = part.replace(/^## .+\n?/m, "").trim();

      const isHero = HERO_SECTIONS.includes(titleUpper);
      const isQuote = QUOTE_SECTIONS.includes(titleUpper);
      const isRecent = RECENT_SECTIONS.includes(titleUpper);

      let cardClass = "briefme-card";
      if (isHero) cardClass += " briefme-card-hero";
      else if (isQuote) cardClass += " briefme-card-quote";
      else if (isRecent) cardClass += " briefme-card-recent";

      // Hero (TL;DR) gets a special label, no section title
      if (isHero) {
        return `
          <div class="${cardClass}">
            <div class="briefme-hero-eyebrow">${title}</div>
            <div class="briefme-hero-body">${formatInline(body)}</div>
          </div>
        `;
      }

      // Quote cards get big quotation marks
      if (isQuote) {
        return `
          <div class="${cardClass}">
            <div class="briefme-section-title">${title}</div>
            <div class="briefme-quote-mark">"</div>
            <div class="briefme-card-body">${formatInline(body)}</div>
          </div>
        `;
      }

      // Recent cards get a small "FRESH" badge
      if (isRecent) {
        const freshLabel = currentLanguage === "es" ? "ÚLTIMOS 90 DÍAS" : "LAST 90 DAYS";
        return `
          <div class="${cardClass}">
            <div class="briefme-section-title-row">
              <div class="briefme-section-title">${title}</div>
              <div class="briefme-fresh-badge">${freshLabel}</div>
            </div>
            <div class="briefme-card-body">${formatInline(body)}</div>
          </div>
        `;
      }

      // Standard card
      return `
        <div class="${cardClass}">
          <div class="briefme-section-title">${title}</div>
          <div class="briefme-card-body">${formatInline(body)}</div>
        </div>
      `;
    }).join("");
  }

  // Convert inline markdown (bullets, bold, numbered) to HTML.
  // Preprocesses to stitch mid-bullet continuation lines back together —
  // the model sometimes outputs bullets with blank lines inside them,
  // which would otherwise render as broken paragraphs.
  function formatInline(text) {
    const lines = text.split("\n");
    const stitched = [];
    let inBullet = false;

    const isStructural = (s) =>
      /^- /.test(s) || /^\d+\. /.test(s) || /^## /.test(s) || /^### /.test(s);

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (/^- /.test(trimmed) || /^\d+\. /.test(trimmed)) {
        inBullet = true;
        stitched.push(trimmed);
      } else if (/^## /.test(trimmed) || /^### /.test(trimmed)) {
        inBullet = false;
        stitched.push(trimmed);
      } else if (trimmed === "") {
        if (inBullet) {
          // Look ahead — is the next non-blank line a new structural element?
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === "") j++;
          if (j >= lines.length || isStructural(lines[j].trim())) {
            inBullet = false;
            stitched.push("");
          }
          // Else: continuation, drop the blank line entirely
        } else {
          stitched.push("");
        }
      } else {
        // Regular text
        if (inBullet && stitched.length > 0) {
          stitched[stitched.length - 1] += " " + trimmed;
        } else {
          stitched.push(trimmed);
        }
      }
    }

    return stitched
      .join("\n")
      .replace(/### (.*)/g, '<div class="briefme-subsection-title">$1</div>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.*)/gm, '<div class="briefme-bullet">$1</div>')
      .replace(/^(\d+)\. (.*)/gm, '<div class="briefme-numbered"><span class="briefme-num">$1.</span> $2</div>')
      .replace(/\n\n/g, '<div class="briefme-spacer"></div>')
      .replace(/\n/g, '<br>');
  }

  // Call the API
  async function analyzeProfile(profileData, mode = "sales", opts) {
    showLoading();
    openSidebar();

    const callMode = (opts && typeof opts.callMode === "string") ? opts.callMode : "COLD";
    if (mode === "sales") currentSalesCallMode = callMode;

    logKlosrEvent("brief_generated", {
      mode,
      callMode,
      language: currentLanguage,
    });

    // Pipeline hook: every brief generated = a deal in pipeline. Creates if new,
    // updates last-activity + brief count if existing. This is where "prepped"
    // becomes the initial pipeline state.
    upsertDeal(profileData, { stage: "prepped", dealStage: "prepped" }).catch(() => {});
    recordDealActivity(profileData?.profileUrl, "brief", { mode, callMode }).catch(() => {});

    // Load accumulated-knowledge inputs + bounded enrichment wait in parallel.
    // Proxycurl gets up to 4 seconds on the brief path — after that, the
    // brief fires with whatever we have. In the common case (user scrolls
    // through the picker for a beat before clicking), the warm-up started
    // during scrapeProfile is already done and this adds zero latency.
    // Also loads the deal record if this prospect is already in pipeline —
    // feeds past commitments/objections into the brief so it compounds
    // on what Klosr already knows about this deal.
    const [voiceExamples, icpLearningsObj, objectionPlaybook, proofLibrary, relevantCallNotes, ninjaPearData, existingDeal] = await Promise.all([
      getVoiceExamples(),
      getICPLearnings(),
      getObjectionPlaybook(),
      getProofLibrary(),
      getRelevantCallNotes(profileData),
      waitForNinjaPear(profileData, 4000),
      getDeal(profileData?.profileUrl || ""),
    ]);

    // Build the dealContext payload — only present when this prospect has
    // past interactions worth citing. Compact to essentials only so the
    // prompt doesn't bloat. If a prospect has 20 captured commitments,
    // we send the 5 most recent open ones + 5 most recent objections.
    let dealContext = null;
    if (existingDeal && (existingDeal.callsHad > 0 || existingDeal.emailsSent > 0 ||
        (existingDeal.commitments || []).length > 0 || (existingDeal.objections || []).length > 0)) {
      const openCommits = (existingDeal.commitments || []).filter(c => !c.doneAt).slice(-5);
      dealContext = {
        stage: existingDeal.dealStage || existingDeal.stage || "",
        callsHad: existingDeal.callsHad || 0,
        emailsSent: existingDeal.emailsSent || 0,
        commitments: openCommits,
        objections: (existingDeal.objections || []).slice(-5),
        buyingSignals: (existingDeal.buyingSignals || []).slice(-3),
        lastActivityNote: existingDeal.closedNotes || "",
      };
    }

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: profileData,
          mode: "sales",                // v4: sales-only product
          language: currentLanguage,
          callMode: callMode,
          companyProfile: companyProfile || null,
          claudeMemoryRaw: (companyProfile && companyProfile.claudeMemoryRaw) || "",
          voiceExamples: Array.isArray(voiceExamples) ? voiceExamples : [],
          icpLearnings: (icpLearningsObj && icpLearningsObj.icpSummary) || "",
          objectionPlaybook: objectionPlaybook,
          proofLibrary: proofLibrary,
          relevantCallNotes: relevantCallNotes,
          ninjaPearData: ninjaPearData,
          // NEW in v4.2: deal context from pipeline — if this prospect is
          // already a deal, the brief compounds on past commitments,
          // objections, buying signals, current stage. Claude-alone can't
          // do this. This is the moat.
          dealContext: dealContext,
          systemPromptVersion: "4.2",
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error("PrepCall.AI API failure:", {
          status: response.status,
          error: errorText.slice(0, 500),
          profile: {
            name: profileData.name,
            hasHeadline: !!profileData.headline,
            hasAbout: !!profileData.about,
            experienceCount: profileData.experience?.length || 0,
            postsCount: profileData.recentPosts?.length || 0,
            rawTextLength: profileData.rawProfileText?.length || 0,
          },
          mode,
          language: currentLanguage,
        });
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200) || "no body"}`);
      }

      const data = await response.json();
      if (!data || typeof data.brief !== "string" || !data.brief.trim()) {
        throw new Error("API returned an empty brief");
      }

      renderBrief(data.brief, mode);
    } catch (error) {
      console.error("PrepCall.AI analyze error:", error);
      showApiErrorScreen(error.message || String(error), mode, profileData);
    }
  }

  // Clean error screen shown when the API call fails. Gives the user
  // (1) a one-click retry, (2) a re-scrape button, (3) collapsible details.
  function showApiErrorScreen(errorMessage, mode, profileData) {
    const content = document.getElementById("briefme-content");
    const isEn = currentLanguage === "en";

    const title = isEn ? "Brief generation failed" : "Error al generar el brief";
    const sub = isEn
      ? "Something went wrong talking to the API. Retry, or re-scrape the profile and try again."
      : "Algo salió mal con la API. Reintenta, o re-escanea el perfil y prueba de nuevo.";
    const retryLabel = isEn ? "Retry" : "Reintentar";
    const rescrapeLabel = isEn ? "Re-scrape profile" : "Re-escanear perfil";
    const detailsLabel = isEn ? "Show details" : "Ver detalles";

    content.innerHTML = `
      <div class="briefme-error-panel">
        <div class="briefme-error-icon">!</div>
        <div class="briefme-error-title">${title}</div>
        <div class="briefme-error-sub">${sub}</div>
        <div class="briefme-error-actions">
          <button class="briefme-copy-btn" id="briefme-error-retry">${retryLabel}</button>
          <button class="briefme-refresh-btn" id="briefme-error-rescrape">${rescrapeLabel}</button>
        </div>
        <details class="briefme-error-details">
          <summary>${detailsLabel}</summary>
          <pre class="briefme-error-pre">${escapeHtml(errorMessage || "(no details)")}</pre>
        </details>
      </div>
    `;

    document.getElementById("briefme-error-retry").addEventListener("click", () => {
      analyzeProfile(currentProfile || profileData, mode);
    });

    document.getElementById("briefme-error-rescrape").addEventListener("click", async () => {
      showScrapingState();
      try {
        currentProfile = await scrapeProfile();
      } catch (e) {
        console.error("PrepCall.AI re-scrape error:", e);
      }
      if (isProfileEmpty(currentProfile)) {
        showScrapeFailedScreen();
      } else {
        analyzeProfile(currentProfile, mode);
      }
    });
  }

  // Generate prompt for Claude based on mode.
  // SALES uses the v2.0 Klosr Sales Brief system prompt:
  //   - source-labelled factual claims
  //   - call-mode adaptation (COLD / FOLLOW-UP / PRE-CALL)
  //   - new sections: Competitive Intel, Stakeholder Map
  //   - 900-word budget, prose over bullets
  // Used as a client-side fallback and as documentation of the server contract.
  function generatePrompt(profile, mode, opts) {
    const callMode = (opts && opts.callMode) || "COLD";
    const profileText = `
Name: ${profile.name}
Headline: ${profile.headline}
Location: ${profile.location}
About: ${profile.about}
Experience: ${profile.experience.map(e => `${e.title} at ${e.company} (${e.duration})`).join("; ")}
Recent Posts: ${profile.recentPosts.join(" | ")}
Followers: ${profile.followers}
URL: ${profile.profileUrl}
    `.trim();

    const salesMasterPrompt = `You are a sales intelligence analyst generating a prospect research brief for a founder doing their own sales outreach. The founder's context is provided below including their name, company, what they sell, their ICP, their value proposition, their proof points, and their preferred tone.

The prospect's LinkedIn profile data, recent posts, company information, and any available web intelligence are also provided.

Your job is to produce a sales brief that feels like it was written by a sharp analyst who knows both parties well. It is not a Wikipedia summary of the prospect. It is not a company profile. It is intelligence that helps a specific founder have a better first conversation with a specific person.

CALL MODE: ${callMode}
- COLD — first contact, no prior interaction. Prioritise opening line quality, The Bridge, and Real-Time Intel. Competitive Intel and Stakeholder Map are fully included.
- FOLLOW-UP — prospect has been contacted but not yet responded or has responded briefly. Prioritise Likely Objections, The Ask, and What They Care About Right Now. Include a short note at the top of the brief summarising what has been sent so far and what has been observed.
- PRE-CALL — a meeting is booked. Prioritise Talking Points, Likely Objections, Stakeholder Map, and Competitive Intel. Replace Opening Line with a Conversation Agenda section (three to four specific topics to cover in order, based on the prospect's current signals).

RULES THAT APPLY TO EVERY SECTION:
- Write in plain, direct prose. No bullet point padding. No em dashes. No phrases like "it is worth noting," "this is a strong signal," or "this suggests." Trust the founder to draw conclusions from facts without editorialising.
- Never describe what a section is doing. Do not write "this section covers" or "the following outlines." Just write the content.
- Never use the words leverage, synergy, actionable, impactful, resonate, or align.
- SOURCE LABELING: Every factual claim must carry an inline source tag in parentheses immediately after the claim. Use one of: (LinkedIn profile), (LinkedIn post, [timeframe]), (LinkedIn activity), (Company website), (Web search, [publication]), (Job posting), (Funding data). If a claim cannot be sourced, write "Not available" instead.
- Every section should reflect the founder's context. The brief is not about the prospect in isolation. It is about the prospect in relation to what the founder sells and who they are.
- Keep the whole brief under 900 words. Density beats length. The Bridge and Real-Time Intel receive the most space if trade-offs are needed.

SECTIONS (COLD mode — full structure):
## Power Line
One or two sentences with the single most useful thing the founder should know before reaching out. Source-tagged. Specific to this person, not their role.

## TL;DR
Three to four sentences. Professional background briefly, tenure, prior role, current company situation. End by connecting their situation to why they might be receptive now. Source each factual claim.

## Real-Time Intel
Three to five short paragraphs of fresh intelligence from the last 90 days. Each paragraph = one distinct signal, stated plainly with date + source tag. No interpretation. Recency beats breadth.

## The Bridge
One paragraph, four to six sentences. Connect the prospect's current situation to what the founder sells, without pitching. Name the pattern the founder should recognise. No source tags — this is analysis.

## What They Care About Right Now
Three to five sentences. What this specific person is visibly prioritising, grounded in observable signals. Source every claim.

## Competitive Intel
Two to four sentences as a continuous paragraph. Part one: what tools/vendors they currently use (displacement angle). Part two: what that means for the conversation (integration or replacement angle). If no competitive data is available, say so in one line.

## Stakeholder Map
Two to three sentences. Who they report to, who reports to them, adjacent peers or internal champions relevant to what the founder sells. Source all claims. Note limits when org structure is not identifiable.

## Likely Objections
Two or three objections this specific prospect is likely to raise. For each: one sentence stating it in the prospect's own language, then one to two sentences giving a grounded rebuttal tied to the prospect's situation or the founder's proof points. No generic sales objections.

## The Ask
Two to three sentences. Exactly what to ask for in the first outreach — format, length, framing. Match the prospect's seniority and style.

## Opening Line
One opening line the founder can use verbatim. References something specific and recent, connects it to the founder's world without mentioning the product. Max two sentences. No flattery, no "I came across your profile," no "I wanted to reach out."

## Avoid
Two to three specific things the founder should not do or say, grounded in this person's background, communication style, role, or public persona.

FOLLOW-UP mode differences:
- Add a short "Since Last Contact" note at the top summarising what has been sent and what has been observed.
- Prioritise Likely Objections, The Ask, What They Care About Right Now.

PRE-CALL mode differences:
- Replace ## Opening Line with ## Conversation Agenda: three to four specific topics in the order that makes most sense, each grounded in something from the brief. No generic "introductions" or "next steps."
- Prioritise Talking Points, Likely Objections, Stakeholder Map, Competitive Intel.

${profileText}

Output the brief now. Obey the rules above. Keep it under 900 words.`;

    const prompts = {
      sales: salesMasterPrompt,

      // Legacy sales prompt (kept for reference; not used while v2.0 is active):
      salesLegacy: `You are a sales intelligence analyst. Analyze this LinkedIn profile and create a one-page sales call prep brief.

${profileText}

Generate a brief with these sections:
## One-Line Summary
Who they are in one sentence.

## Background
3-4 bullet points on their career trajectory and what matters most.

## What They Care About
Based on their posts, headline, and experience — what problems are they trying to solve?

## Pain Points You Can Reference
3 specific pain points based on their role and industry.

## Conversation Starters
3 natural ways to open the conversation that show you did your homework.

## Questions to Ask
3 insightful questions that will impress them and uncover needs.

## How to Pitch Them
Based on their background, what angle would resonate most? What language to use and avoid.

## Red Flags / Notes
Anything to watch out for — topics to avoid, sensitivities, potential objections.

Keep it punchy. No fluff. Every line should be actionable.`,

      interview: `You are a career intelligence analyst. Analyze this LinkedIn profile to prepare someone for a job interview with this person.

${profileText}

Generate a brief with these sections:
## Who They Are
One-line summary of their career and current role.

## Their Career Journey
Key moves and what they reveal about their values and priorities.

## What They Value in People
Based on their background — what traits and skills would they respect?

## Topics They'll Likely Ask About
3-4 topics or questions they're likely to bring up based on their expertise.

## How to Impress Them
What to say, reference, or demonstrate to stand out.

## Questions to Ask Them
3 questions that show you understand their world and are genuinely curious.

## Things to Avoid
Topics, tones, or claims that could backfire with this specific person.

## Power Line
One sentence you can say in the interview that would make them remember you.

Keep it direct and actionable. This is for someone walking into an interview in 10 minutes.`,

      pitch: `You are a pitch intelligence analyst. Analyze this LinkedIn profile to prepare someone to pitch this person on a product, service, or partnership.

${profileText}

Generate a brief with these sections:
## Who They Are
One-line summary and what they control (budget, decisions, team).

## What They've Built
Key achievements that reveal what they care about.

## Their Likely Problems
3 pain points based on their role, industry, and company stage.

## How to Frame Your Pitch
The angle that will resonate based on their background. What language to use.

## Opening Line
The first thing to say that hooks their attention.

## Objections They'll Raise
2-3 likely pushbacks and how to handle each.

## The Ask
How to close — what's the lowest-friction next step for someone like them?

## Reference Points
People, companies, or achievements from their profile you can reference naturally in conversation.

Keep it punchy. This is for someone pitching in 5 minutes.`
    };

    return prompts[mode] || prompts.sales;
  }

  // Is this profile basically empty? (i.e. scrape didn't find anything useful)
  function isProfileEmpty(p) {
    if (!p) return true;
    const hasHeadline = !!(p.headline && p.headline.trim());
    const hasAbout = !!(p.about && p.about.trim());
    const hasExperience = Array.isArray(p.experience) && p.experience.length > 0;
    const hasRaw = !!(p.rawProfileText && p.rawProfileText.length > 200);
    return !(hasHeadline || hasAbout || hasExperience || hasRaw);
  }

  // Main click handler — opens the sidebar, scrapes (with lazy-load), then shows picker
  // ============================================================
  // BULK MODE — runs on LinkedIn /search/ and /sales/ pages.
  // Detects profile cards, lets the user multi-select, then generates
  // a lightweight brief + cold email for each in parallel (throttled).
  // ============================================================

  // Detect every profile card on the current results page. LinkedIn's
  // DOM is inconsistent across search views, so we grab any anchor to
  // /in/<handle> and group by profile URL.
  function scrapeSearchResults() {
    const results = new Map();
    const seen = new Set();
    const anchors = document.querySelectorAll('a[href*="/in/"]');
    for (const a of anchors) {
      const href = (a.href || "").split("?")[0].replace(/\/$/, "");
      if (!/\/in\/[^/]+$/i.test(href)) continue;
      const key = href.toLowerCase();
      if (seen.has(key)) continue;

      // Walk up to find the card container — one of the common variants.
      const card = a.closest(
        'li, div[data-chameleon-result-urn], div[data-test-search-result], ' +
        'div.entity-result, div.reusable-search__result-container, ' +
        'div.artdeco-entity-lockup, div[data-view-name="search-entity-result-universal-template"]'
      ) || a.parentElement;
      if (!card) continue;

      // Extract name + headline from the card itself.
      let name = "";
      const nameEl = card.querySelector(
        '[aria-hidden="true"].entity-result__title-text, ' +
        '.entity-result__title-text a span[aria-hidden="true"], ' +
        'a[href*="/in/"] span[aria-hidden="true"], ' +
        '.artdeco-entity-lockup__title span[aria-hidden="true"]'
      );
      if (nameEl) name = cleanScrapedName(nameEl.textContent || "");
      if (!name) name = cleanScrapedName(a.textContent || "");
      if (!name || name.length < 2) continue;

      let headline = "";
      const headlineEl = card.querySelector(
        '.entity-result__primary-subtitle, ' +
        '.artdeco-entity-lockup__subtitle, ' +
        'div.t-14.t-black.t-normal'
      );
      if (headlineEl) headline = (headlineEl.textContent || "").trim().slice(0, 200);

      let photoUrl = "";
      const imgEl = card.querySelector("img.ivm-view-attr__img--centered, img.presence-entity__image, img.entity-result__image");
      if (imgEl && imgEl.src && !imgEl.src.includes("ghost")) photoUrl = imgEl.src;

      seen.add(key);
      results.set(href, { name, headline, profileUrl: href, photoUrl });
    }
    return Array.from(results.values());
  }

  // Floating button in the bottom-right of the search page that opens the
  // bulk-mode sidebar. Re-renders itself whenever the results list changes
  // (LinkedIn search is SPA + infinite scroll).
  let _bulkFloatBtn = null;
  let _bulkResultsCache = [];
  function startBulkModeOnSearchPage() {
    // Render the float-button once; keep it alive across DOM mutations.
    const renderButton = () => {
      const rows = scrapeSearchResults();
      _bulkResultsCache = rows;
      if (!_bulkFloatBtn) {
        _bulkFloatBtn = document.createElement("div");
        _bulkFloatBtn.id = "briefme-bulk-float";
        _bulkFloatBtn.addEventListener("click", () => {
          createSidebar();
          openSidebar();
          showBulkModeView(_bulkResultsCache);
        });
        document.body.appendChild(_bulkFloatBtn);
      }
      if (rows.length === 0) {
        _bulkFloatBtn.style.display = "none";
      } else {
        _bulkFloatBtn.style.display = "";
        _bulkFloatBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 4v16"/><path d="M6 12l7-8"/><path d="M6 12l7 8"/>
          </svg>
          <span>${currentLanguage === "es" ? `Prep en lote (${rows.length})` : `Bulk prep (${rows.length})`}</span>
        `;
      }
    };

    renderButton();

    // Re-scan on DOM mutations (infinite scroll, filter changes).
    const mo = new MutationObserver(() => {
      // Debounce — results change rapidly on filter interactions.
      clearTimeout(startBulkModeOnSearchPage._debounce);
      startBulkModeOnSearchPage._debounce = setTimeout(renderButton, 400);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // Main bulk-mode view — grid of checkbox cards, generate button,
  // results panel. Lightweight: one scrape-less brief + email per
  // selected prospect, 3 concurrent at a time to respect rate limits.
  async function showBulkModeView(initialRows) {
    const sidebar = document.getElementById("briefme-sidebar");
    sidebar.classList.add("briefme-picker-view");
    const content = document.getElementById("briefme-content");
    const isEs = currentLanguage === "es";

    // Onboarding gate — bulk mode writes to everything, so we want the
    // founder profile in place. Reuse the same gate the main flow uses.
    if (!companyProfile || !companyProfile.yourName) {
      await loadCompanyProfile();
      if (!companyProfile || !companyProfile.yourName) {
        content.innerHTML = `
          <div class="briefme-onboarding">
            <div class="briefme-onboarding-title">${isEs ? "Primero configúrate" : "Set up your profile first"}</div>
            <div class="briefme-onboarding-sub">${isEs ? "Abre Klosr en tu propio perfil de LinkedIn para importar tu info — luego vuelve aquí." : "Open Klosr on your own LinkedIn profile to import yourself, then come back here."}</div>
          </div>
        `;
        return;
      }
    }

    const rows = Array.isArray(initialRows) && initialRows.length > 0
      ? initialRows
      : scrapeSearchResults();

    const rowsHtml = rows.length === 0
      ? `<div class="briefme-bulk-empty">${isEs ? "No se detectan prospectos en esta página. Prueba otra búsqueda." : "No prospects detected on this page. Try another search."}</div>`
      : rows.map((r, i) => `
        <label class="briefme-bulk-card" data-idx="${i}">
          <input type="checkbox" class="briefme-bulk-check" data-idx="${i}" checked />
          <div class="briefme-bulk-card-body">
            <div class="briefme-bulk-name">${escapeHtml(r.name)}</div>
            ${r.headline ? `<div class="briefme-bulk-headline">${escapeHtml(r.headline)}</div>` : ""}
          </div>
        </label>
      `).join("");

    content.innerHTML = `
      <div class="briefme-bulk-view">
        <div class="briefme-quest-header">
          <div class="briefme-quest-title">${isEs ? "Prep en lote" : "Bulk prep"}</div>
          <div class="briefme-quest-subtitle">${isEs
            ? `${rows.length} prospectos detectados. Desmarca los que no quieras. Klosr genera un mini-brief + email para cada uno.`
            : `${rows.length} prospects detected. Uncheck the ones you don't want. Klosr generates a mini-brief + cold email for each.`}</div>
        </div>

        <div class="briefme-bulk-toolbar">
          <button type="button" class="briefme-bulk-toolbar-btn" id="briefme-bulk-all">${isEs ? "Marcar todos" : "Select all"}</button>
          <button type="button" class="briefme-bulk-toolbar-btn" id="briefme-bulk-none">${isEs ? "Desmarcar" : "Clear"}</button>
          <div class="briefme-bulk-count" id="briefme-bulk-count">${rows.length}</div>
        </div>

        <div class="briefme-bulk-list" id="briefme-bulk-list">${rowsHtml}</div>

        <div class="briefme-quest-actions">
          <button type="button" class="briefme-quest-back" id="briefme-bulk-back">${isEs ? "Volver" : "Back"}</button>
          <button type="button" class="briefme-quest-submit" id="briefme-bulk-run">${isEs ? "Generar todo" : "Generate all"}</button>
        </div>

        <div id="briefme-bulk-results"></div>
      </div>
    `;

    const countEl = document.getElementById("briefme-bulk-count");
    const updateCount = () => {
      const n = content.querySelectorAll(".briefme-bulk-check:checked").length;
      countEl.textContent = String(n);
    };
    content.querySelectorAll(".briefme-bulk-check").forEach(cb => {
      cb.addEventListener("change", updateCount);
    });
    document.getElementById("briefme-bulk-all").addEventListener("click", () => {
      content.querySelectorAll(".briefme-bulk-check").forEach(cb => { cb.checked = true; });
      updateCount();
    });
    document.getElementById("briefme-bulk-none").addEventListener("click", () => {
      content.querySelectorAll(".briefme-bulk-check").forEach(cb => { cb.checked = false; });
      updateCount();
    });
    document.getElementById("briefme-bulk-back").addEventListener("click", () => {
      closeSidebar();
    });

    document.getElementById("briefme-bulk-run").addEventListener("click", () => {
      const selected = Array.from(content.querySelectorAll(".briefme-bulk-check:checked"))
        .map(cb => rows[Number(cb.dataset.idx)])
        .filter(Boolean);
      if (selected.length === 0) return;
      runBulkGeneration(selected);
    });
  }

  // Fire N per-prospect backend calls with bounded concurrency. Each
  // prospect gets a short brief + a cold email in two parallel calls.
  // Results stream into the panel as they land so the user sees progress.
  async function runBulkGeneration(rows) {
    const isEs = currentLanguage === "es";
    const panel = document.getElementById("briefme-bulk-results");
    const runBtn = document.getElementById("briefme-bulk-run");
    const backBtn = document.getElementById("briefme-bulk-back");
    if (runBtn) runBtn.disabled = true;

    panel.innerHTML = `
      <div class="briefme-bulk-panel-head">
        ${isEs ? "Procesando" : "Processing"} <strong>${rows.length}</strong> ${isEs ? "prospectos" : "prospects"}…
      </div>
      <div class="briefme-bulk-progress"><div class="briefme-bulk-progress-fill" id="briefme-bulk-fill" style="width: 0%"></div></div>
      <div class="briefme-bulk-results-list" id="briefme-bulk-rl"></div>
    `;

    const cp = companyProfile || {};
    const richSender = {
      name: cp.yourName || "",
      role: cp.yourRole || "",
      company: cp.companyName || "",
      context: cp.whatYouSell || "",
      valueProp: cp.valueProp || "",
      icp: cp.icp || "",
      tone: cp.tone || "",
      proofPoints: cp.proofPoints || "",
      background: cp.background || "",
      calendlyUrl: cp.calendlyUrl || "",
      claudeMemoryRaw: cp.claudeMemoryRaw || "",
      voiceExamples: await getVoiceExamples(),
      icpLearnings: (await getICPLearnings() || {}).icpSummary || "",
      objectionPlaybook: await getObjectionPlaybook(),
      proofLibrary: await getProofLibrary(),
      relevantCallNotes: [],
    };

    const list = document.getElementById("briefme-bulk-rl");
    const fill = document.getElementById("briefme-bulk-fill");
    let done = 0;

    // Build a skinny profile from what we scraped off the card — no DOM
    // deep-scrape per prospect (that would require navigating). Backend
    // enriches via Proxycurl + SerpApi so each prospect still gets real data.
    const CONCURRENCY = 3;
    const queue = rows.slice();

    async function processOne(row) {
      const profileStub = {
        name: row.name,
        headline: row.headline || "",
        profileUrl: row.profileUrl,
        photoUrl: row.photoUrl || "",
        about: "",
        experience: [],
        recentPosts: [],
        location: "",
      };

      // Render a pending card first so progress is visible.
      const rowId = "bulk-row-" + Math.random().toString(36).slice(2, 8);
      const card = document.createElement("div");
      card.className = "briefme-bulk-result";
      card.id = rowId;
      card.innerHTML = `
        <div class="briefme-bulk-result-head">
          <div class="briefme-bulk-result-name">${escapeHtml(row.name)}</div>
          <span class="briefme-bulk-result-state briefme-bulk-state-pending">${isEs ? "Generando…" : "Generating…"}</span>
        </div>
        ${row.headline ? `<div class="briefme-bulk-result-headline">${escapeHtml(row.headline)}</div>` : ""}
      `;
      list.appendChild(card);

      try {
        const emailRes = await fetch(EMAIL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: profileStub,
            mode: "sales",
            brief: "",
            language: currentLanguage,
            sender: richSender,
            systemPromptVersion: "2.0",
          }),
        });
        if (!emailRes.ok) throw new Error(`email ${emailRes.status}`);
        const email = await emailRes.json();
        const subj = escapeHtml(email.subject || "");
        const body = escapeHtml(email.body || "").replace(/\n/g, "<br>");

        card.innerHTML = `
          <div class="briefme-bulk-result-head">
            <a class="briefme-bulk-result-name" href="${escapeHtml(row.profileUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.name)}</a>
            <span class="briefme-bulk-result-state briefme-bulk-state-ok">${isEs ? "Listo" : "Ready"}</span>
          </div>
          ${row.headline ? `<div class="briefme-bulk-result-headline">${escapeHtml(row.headline)}</div>` : ""}
          <div class="briefme-bulk-result-subject"><strong>${isEs ? "Asunto" : "Subject"}:</strong> ${subj}</div>
          <div class="briefme-bulk-result-body">${body}</div>
          <div class="briefme-bulk-result-actions">
            <button class="briefme-bulk-copy" data-copy="full">${isEs ? "Copiar email" : "Copy email"}</button>
            <a class="briefme-bulk-open" target="_blank" rel="noopener noreferrer"
               href="https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(email.subject || "")}&body=${encodeURIComponent(email.body || "")}">
              ${isEs ? "Abrir Gmail" : "Open Gmail"}
            </a>
          </div>
        `;
        const copyBtn = card.querySelector(".briefme-bulk-copy");
        if (copyBtn) {
          copyBtn.addEventListener("click", () => {
            const full = `Subject: ${email.subject}\n\n${email.body}`;
            navigator.clipboard.writeText(full).then(() => {
              const orig = copyBtn.textContent;
              copyBtn.textContent = isEs ? "¡Copiado!" : "Copied!";
              setTimeout(() => { copyBtn.textContent = orig; }, 1200);
            });
          });
        }
        saveProspectToHistory(profileStub, "prepped");
      } catch (e) {
        console.warn("bulk row failed:", row.name, e);
        card.innerHTML = `
          <div class="briefme-bulk-result-head">
            <div class="briefme-bulk-result-name">${escapeHtml(row.name)}</div>
            <span class="briefme-bulk-result-state briefme-bulk-state-err">${isEs ? "Falló" : "Failed"}</span>
          </div>
        `;
      } finally {
        done += 1;
        const pct = Math.round((done / rows.length) * 100);
        if (fill) fill.style.width = pct + "%";
        if (done === rows.length) {
          const head = panel.querySelector(".briefme-bulk-panel-head");
          if (head) head.innerHTML = `${isEs ? "Terminado." : "Done."} <strong>${done}</strong> ${isEs ? "prospectos procesados" : "prospects processed"}.`;
          if (runBtn) runBtn.disabled = false;
        }
      }
    }

    async function worker() {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) break;
        await processOne(row);
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, rows.length); i++) workers.push(worker());
    await Promise.all(workers);
  }

  async function handleClick() {
    createSidebar();
    openSidebar();
    showScrapingState();

    const fallbackUrl = window.location.href.split("?")[0];
    const emptyProfile = {
      name: deriveNameFromUrl(fallbackUrl) || "Unknown",
      headline: "",
      location: "",
      about: "",
      experience: [],
      currentRole: "",
      currentCompany: "",
      recentPosts: [],
      followers: "",
      profileUrl: fallbackUrl,
      rawProfileText: "",
      photoUrl: "",
      extractedEmails: [],
    };

    try {
      currentProfile = await scrapeProfile();

      // Retry once if we got nothing — LinkedIn sometimes needs another beat to hydrate
      if (isProfileEmpty(currentProfile)) {
        console.warn("PrepCall.AI: first scrape returned empty, retrying...");
        await new Promise(r => setTimeout(r, 500));
        currentProfile = await scrapeProfile();
      }
    } catch (e) {
      console.error("PrepCall.AI scrape error:", e);
      currentProfile = emptyProfile;
    }

    // If we STILL have nothing usable, show a clear scrape-failed error
    if (isProfileEmpty(currentProfile)) {
      console.warn("PrepCall.AI: scrape failed on this page, showing error");
      showScrapeFailedScreen();
      return;
    }

    // Save to prospect history — the founder builds their pipeline over time
    saveProspectToHistory(currentProfile);

    // First-time onboarding: if no company profile exists, show "This is me" flow
    if (!companyProfile || !companyProfile.yourName) {
      await loadCompanyProfile();
      if (!companyProfile || !companyProfile.yourName) {
        showThisIsMeScreen();
        return;
      }
    }

    showModePicker();
  }

  // Shown when the scraper couldn't find anything useful on the page
  function showScrapeFailedScreen() {
    const content = document.getElementById("briefme-content");
    const isEn = currentLanguage === "en";
    const title = isEn ? "Couldn't read this profile" : "No se pudo leer este perfil";
    const sub = isEn
      ? "LinkedIn hasn't finished loading, or the DOM changed. Refresh the LinkedIn page and try again."
      : "LinkedIn no ha terminado de cargar, o el DOM cambió. Recarga la página de LinkedIn y prueba de nuevo.";
    const retryLabel = isEn ? "Retry scrape" : "Reintentar";
    const reloadLabel = isEn ? "Reload LinkedIn page" : "Recargar LinkedIn";

    content.innerHTML = `
      <div class="briefme-error-panel">
        <div class="briefme-error-icon">!</div>
        <div class="briefme-error-title">${title}</div>
        <div class="briefme-error-sub">${sub}</div>
        <div class="briefme-error-actions">
          <button class="briefme-copy-btn" id="briefme-error-retry">${retryLabel}</button>
          <button class="briefme-refresh-btn" id="briefme-error-reload">${reloadLabel}</button>
        </div>
      </div>
    `;

    document.getElementById("briefme-error-retry").addEventListener("click", async () => {
      showScrapingState();
      try {
        currentProfile = await scrapeProfile();
      } catch (e) {
        console.error("PrepCall.AI retry scrape error:", e);
      }
      if (isProfileEmpty(currentProfile)) {
        showScrapeFailedScreen();
      } else {
        showModePicker();
      }
    });

    document.getElementById("briefme-error-reload").addEventListener("click", () => {
      window.location.reload();
    });
  }

  // Initialize
  // ═══════════════════════════════════════════════════════════════
  // SEND VIA KLOSR — auto-fill LinkedIn's DM composer
  //
  // When the user clicks "Send via Klosr" from a warm-lead card, we stash
  // the draft in chrome.storage (key: klosr_pending_dm) + open the target
  // profile in a new tab. The content script running on the target profile
  // picks up the pending draft and shows a floating banner. One click →
  // Klosr clicks LinkedIn's "Message" button → waits for composer modal →
  // fills the textarea → focuses Send. User hits Enter to ship.
  //
  // Why not auto-click Send? Too risky. LinkedIn's UI layers change, DM
  // quotas exist, and we want the human to confirm before wire. Auto-fill
  // + focus is 10x faster than copy-paste without being reckless.
  // ═══════════════════════════════════════════════════════════════
  const _normalizeLiUrl = (u) => String(u || "").toLowerCase().split("?")[0].split("#")[0].replace(/\/+$/, "");
  const PENDING_DM_TTL_MS = 5 * 60 * 1000;   // 5 min — long enough for slow connections

  async function checkPendingDmForThisProfile() {
    try {
      const currentUrl = _normalizeLiUrl(window.location.href);
      const data = await new Promise(r => chrome.storage.local.get("klosr_pending_dm", (d) => r(d && d.klosr_pending_dm)));
      if (!data || !data.url || !data.draft) return;
      if (_normalizeLiUrl(data.url) !== currentUrl) return;
      if (Date.now() - (data.ts || 0) > PENDING_DM_TTL_MS) {
        // Stale — clear it and bail.
        chrome.storage.local.remove("klosr_pending_dm");
        return;
      }
      showPendingDmBanner(data);
    } catch (e) {
      console.warn("[Klosr] pending-dm check failed:", e);
    }
  }

  function showPendingDmBanner(pending) {
    if (document.getElementById("klosr-pending-dm-banner")) return;
    const isEs = currentLanguage === "es";
    const banner = document.createElement("div");
    banner.id = "klosr-pending-dm-banner";
    banner.className = "klosr-pending-dm-banner";
    banner.innerHTML = `
      <div class="klosr-pending-dm-icon">📤</div>
      <div class="klosr-pending-dm-body">
        <div class="klosr-pending-dm-title">
          ${isEs ? "Klosr tiene un mensaje listo" : "Klosr has a DM ready"}
          ${pending.name ? `<span class="klosr-pending-dm-for">${isEs ? "para" : "for"} <strong>${escapeHtml(pending.name)}</strong></span>` : ""}
        </div>
        <div class="klosr-pending-dm-preview">${escapeHtml((pending.draft || "").slice(0, 120))}${(pending.draft || "").length > 120 ? "…" : ""}</div>
      </div>
      <div class="klosr-pending-dm-actions">
        <button class="klosr-pending-dm-btn klosr-pending-dm-send" id="klosr-pending-dm-autofill">${isEs ? "Auto-llenar" : "Auto-fill"}</button>
        <button class="klosr-pending-dm-btn klosr-pending-dm-dismiss" id="klosr-pending-dm-close" title="${isEs ? "Cerrar" : "Dismiss"}">✕</button>
      </div>
    `;
    document.body.appendChild(banner);

    document.getElementById("klosr-pending-dm-close").addEventListener("click", () => {
      banner.remove();
      chrome.storage.local.remove("klosr_pending_dm");
    });

    document.getElementById("klosr-pending-dm-autofill").addEventListener("click", async () => {
      const btn = document.getElementById("klosr-pending-dm-autofill");
      btn.disabled = true;
      btn.textContent = isEs ? "Abriendo…" : "Opening…";
      const ok = await autofillLinkedInDM(pending.draft);
      if (ok) {
        btn.textContent = isEs ? "✓ Listo — pulsa Enter" : "✓ Ready — hit Enter";
        logKlosrEvent("dm_autofill_success", { url: pending.url });
        // Clear the pending draft so we don't re-prompt on navigation.
        chrome.storage.local.remove("klosr_pending_dm");
        setTimeout(() => { banner.remove(); }, 4000);
      } else {
        btn.disabled = false;
        btn.textContent = isEs ? "Reintentar (o copia manual)" : "Retry (or paste manually)";
        logKlosrEvent("dm_autofill_failed", { url: pending.url });
      }
    });
  }

  // The actual DOM automation. Returns true on success, false otherwise.
  // LinkedIn's message button + composer DOM is localized and has varied
  // over time, so we use multiple fallback selectors + poll for the
  // composer to mount (modal opens asynchronously).
  async function autofillLinkedInDM(draft) {
    try {
      // 1. Find + click the "Message" button on the profile page.
      // LinkedIn uses aria-label prefixes in every locale:
      //   EN: "Message <Name>"
      //   ES: "Enviar mensaje a <Name>" / "Mensaje <Name>"
      //   DE: "Nachricht an <Name>" ...
      // Fallback: button text content match.
      const messageBtn =
        document.querySelector('button[aria-label^="Message" i]') ||
        document.querySelector('button[aria-label^="Enviar mensaje" i]') ||
        document.querySelector('button[aria-label^="Mensaje" i]') ||
        document.querySelector('button[aria-label^="Nachricht" i]') ||
        document.querySelector('a[aria-label^="Message" i]') ||
        Array.from(document.querySelectorAll("main button")).find(b =>
          /^(message|enviar mensaje|mensaje|nachricht|message à|messaggio|mensagem)$/i.test((b.textContent || "").trim())
        );
      if (!messageBtn) {
        console.warn("[Klosr] autofill: Message button not found");
        return false;
      }
      messageBtn.click();

      // 2. Wait for the composer to mount. LinkedIn uses a contenteditable
      // div with class "msg-form__contenteditable" (stable since ~2020).
      const composer = await waitForSelector(
        '.msg-form__contenteditable[contenteditable="true"], .msg-form__contenteditable, [role="textbox"][contenteditable="true"].msg-form__contenteditable',
        5000
      );
      if (!composer) {
        console.warn("[Klosr] autofill: composer did not mount");
        return false;
      }

      // 3. Fill the composer. LinkedIn listens for input events on the
      // contenteditable and tracks state in its React tree — simple
      // textContent assignment won't trigger send-button activation.
      // We use the clipboard-paste path via execCommand for robustness,
      // falling back to direct DOM manipulation + input event dispatch.
      composer.focus();

      // Clear any placeholder text LinkedIn might have inserted.
      composer.innerHTML = "";

      // Insert the text. `insertText` command triggers the proper input
      // events so LinkedIn's React state updates and the Send button
      // becomes active.
      let filled = false;
      try {
        filled = document.execCommand("insertText", false, draft);
      } catch { filled = false; }

      if (!filled) {
        // Fallback: inject a paragraph + fire input event manually.
        const p = document.createElement("p");
        p.textContent = draft;
        composer.appendChild(p);
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: draft }));
      }

      // 4. Find + focus (NOT click) the Send button so user can just hit
      // Enter or click. Send button has class "msg-form__send-button" or
      // "msg-form__send-btn" across LinkedIn versions.
      await new Promise(r => setTimeout(r, 250));   // let React render
      const sendBtn =
        document.querySelector(".msg-form__send-button") ||
        document.querySelector(".msg-form__send-btn") ||
        document.querySelector('button[type="submit"].msg-form__send-button') ||
        Array.from(document.querySelectorAll(".msg-form__msg-content-container button, .msg-form__footer button")).find(b =>
          /send|enviar/i.test((b.textContent || "").trim())
        );
      if (sendBtn) {
        try { sendBtn.focus(); } catch {}
        // Soft highlight so the user sees where the next click goes.
        sendBtn.classList.add("klosr-send-highlight");
        setTimeout(() => sendBtn.classList.remove("klosr-send-highlight"), 4000);
      }

      return true;
    } catch (err) {
      console.warn("[Klosr] autofillLinkedInDM exception:", err);
      return false;
    }
  }

  // Small DOM helper: resolves with the first element matching `selector`
  // once it appears in the document, or null after `timeoutMs`.
  function waitForSelector(selector, timeoutMs) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) { resolve(existing); return; }
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      obs.observe(document.body, { subtree: true, childList: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeoutMs || 5000);
    });
  }

  function init() {
    const path = window.location.pathname;

    // Profile pages — main Klosr entry point.
    if (path.startsWith("/in/")) {
      ensureOverlayHiderInstalled();
      startEmailAutoCatcher();
      createButton();
      loadSenderFromStorage();
      loadCompanyProfile();

      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get("prepcall_pending_onboarding", (data) => {
            if (data && data.prepcall_pending_onboarding) {
              chrome.storage.local.remove("prepcall_pending_onboarding");
              setTimeout(() => { autoImportMyProfile(); }, 2500);
            }
          });
        }
      } catch (e) {}

      // Pending-DM auto-fill banner — when the user clicked "Send via Klosr"
      // on a warm-lead card, we stashed the draft in chrome.storage. If we're
      // now loading that prospect's profile and the draft is fresh (<5 min
      // old), show a banner offering to auto-fill LinkedIn's message composer.
      setTimeout(() => { checkPendingDmForThisProfile(); }, 1500);

      // Push user state (proof / playbook / voice / ICP learnings) to the
      // cloud so the Klosr PWA can use it for personalized Vision drafts.
      // One-shot on page load + interval every 30 min. No-op if state
      // hasn't changed since last sync.
      setTimeout(() => { syncStateToCloud(false); }, 3500);
      if (_syncStateTimer) clearInterval(_syncStateTimer);
      _syncStateTimer = setInterval(() => syncStateToCloud(false), 30 * 60 * 1000);

      return;
    }

    // Search / Sales Navigator result pages — bulk mode. A floating
    // "Bulk prep N" button appears when we detect profile cards on the page.
    if (path.startsWith("/search/") || path.startsWith("/sales/")) {
      loadSenderFromStorage();
      loadCompanyProfile();
      startBulkModeOnSearchPage();
      return;
    }
  }

  // Install the overlay hider at content-script-load time so there's zero
  // window where the Contact Info scrape could fire before the CSS is in
  // place. init() will re-call it later (idempotent).
  try { ensureOverlayHiderInstalled(); } catch (e) {}

  // Watch for page navigation (LinkedIn is SPA)
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      if (url.includes("/in/")) {
        setTimeout(init, 1000);
      }
    }
  }).observe(document, { subtree: true, childList: true });

  // Initial load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
