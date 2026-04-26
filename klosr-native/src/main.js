// Klosr Main App — full-screen window with onboarding, settings, billing.
// Companion to the floating overlay (index.html / app.js).
//
// Flow on first launch:
//   Welcome → Email → Verify → Tell us more → Which fits → Tutorial → Dashboard
// On subsequent launches: jumps directly to Dashboard.

const INTEL_URL = "https://backend-kappa-nine-57.vercel.app/api/intel";
const IID_KEY     = "klosr_pwa_install_id";
const USER_KEY    = "klosr_pwa_user";
const ONB_KEY     = "klosr_onboarded_v1";
const SETTINGS_KEY = "klosr_settings_v1";
const STATS_KEY    = "klosr_stats_v1";
const KLOSR_VERSION = "0.3.2";

let _user = null;
let _onb = { role: null, source: null, fits: null, email: null };
const defaultSettings = {
  detectable: true, autostart: false, notifications: true, pulse: true,
  sensitivity: 50, theme: "system",
};
let _settings = { ...defaultSettings };
const navHistory = ["welcome"];
let navIndex = 0;

const isTauri = () => !!window.__TAURI__;
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

function loadSettings() {
  try { _settings = { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings)); } catch {}
}

function todayStats() {
  try {
    const d = new Date();
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const all = JSON.parse(localStorage.getItem(STATS_KEY) || "{}");
    return all[k] || { drafts: 0, sent: 0, watchSec: 0, hot: 0 };
  } catch { return { drafts: 0, sent: 0, watchSec: 0, hot: 0 }; }
}

async function callIntel(action, params) {
  try {
    const res = await fetch(INTEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, params: params || {} }),
    });
    return await res.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

function showToast(msg) {
  const host = $("toast-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast-msg";
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function openExternal(url) {
  if (window.__TAURI__?.shell?.open) {
    window.__TAURI__.shell.open(url).catch(() => { try { window.open(url); } catch {} });
  } else {
    try { window.open(url, "_blank"); } catch {}
  }
}

// ─── Routing ──────────────────────────────────────────────────────
function showPage(id, opts = {}) {
  $$(".page").forEach(p => p.classList.remove("active"));
  const target = $(`page-${id}`);
  if (target) target.classList.add("active");

  // Sidebar visibility — hide during onboarding
  const sidebar = $("sidebar");
  const onboardingPages = ["welcome", "email", "verify", "tellus", "fits", "tutorial"];
  if (sidebar) sidebar.classList.toggle("hidden", onboardingPages.includes(id));

  // Active nav item
  $$(".nav-item").forEach(n => {
    n.classList.toggle("active", n.dataset.route === id);
  });

  // Push to history
  if (!opts.noPush) {
    navHistory.length = navIndex + 1;
    navHistory.push(id);
    navIndex = navHistory.length - 1;
  }

  // Page-specific refresh
  if (id === "dashboard") refreshDashboard();
  if (id === "general")   refreshSettingsPanel();
  if (id === "profile")   refreshProfile();
  if (id === "billing")   refreshBilling();
  if (id === "integrations") refreshIntegrations();

  // Scroll to top
  $("main")?.scrollTo?.({ top: 0 });
}

function navBack() { if (navIndex > 0) { navIndex--; showPage(navHistory[navIndex], { noPush: true }); } }
function navFwd()  { if (navIndex < navHistory.length - 1) { navIndex++; showPage(navHistory[navIndex], { noPush: true }); } }

// ─── Onboarding wiring ────────────────────────────────────────────
function wireOnboarding() {
  // Welcome → Email
  $("welcome-continue")?.addEventListener("click", () => showPage("email"));

  // Email → Verify
  $("email-send")?.addEventListener("click", async () => {
    const email = ($("email-input")?.value || "").trim();
    if (!email || !email.includes("@")) {
      $("email-input").focus(); return;
    }
    _onb.email = email;
    $("verify-email-display").textContent = email;
    const btn = $("email-send");
    btn.disabled = true; btn.textContent = "Sending…";
    const res = await callIntel("auth-magic-link-request", { email });
    btn.disabled = false; btn.textContent = "Send code";
    if (res?.ok) {
      showToast("Code sent");
      showPage("verify");
      startResendCountdown();
      setTimeout(() => $$(`#code-row input`)[0]?.focus(), 100);
    } else {
      showToast(res?.error || "Couldn't send — try again");
    }
  });
  $("email-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("email-send").click();
  });

  // Verify code: auto-advance between inputs
  const codeInputs = $$("#code-row input");
  codeInputs.forEach((inp, i) => {
    inp.addEventListener("input", (e) => {
      const v = e.target.value.replace(/[^0-9]/g, "");
      e.target.value = v.slice(-1);
      if (v && i < codeInputs.length - 1) codeInputs[i+1].focus();
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !inp.value && i > 0) codeInputs[i-1].focus();
    });
    inp.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData?.getData("text") || "").replace(/[^0-9]/g, "");
      text.split("").slice(0, 6).forEach((c, j) => { if (codeInputs[j]) codeInputs[j].value = c; });
      codeInputs[Math.min(text.length, 5)]?.focus();
    });
  });

  $("verify-continue")?.addEventListener("click", async () => {
    const code = Array.from(codeInputs).map(i => i.value).join("");
    if (code.length !== 6) { codeInputs[0].focus(); return; }
    const btn = $("verify-continue");
    btn.disabled = true; btn.textContent = "Verifying…";
    const res = await callIntel("auth-magic-link-verify", { email: _onb.email, code });
    btn.disabled = false; btn.textContent = "Continue ›";
    if (res?.ok && res.installId) {
      localStorage.setItem(IID_KEY, res.installId);
      _user = res.user || { email: _onb.email };
      localStorage.setItem(USER_KEY, JSON.stringify(_user));
      showPage("tellus");
    } else {
      showToast("Invalid code — try again");
      codeInputs[0].focus();
    }
  });

  // Tell us more — chip toggling (single-select per group)
  $$("#chips-role .chip").forEach(c => {
    c.addEventListener("click", () => {
      $$("#chips-role .chip").forEach(x => x.classList.remove("active"));
      c.classList.add("active");
      _onb.role = c.dataset.val;
    });
  });
  $$("#chips-source .chip").forEach(c => {
    c.addEventListener("click", () => {
      $$("#chips-source .chip").forEach(x => x.classList.remove("active"));
      c.classList.add("active");
      _onb.source = c.dataset.val;
    });
  });
  $("tellus-continue")?.addEventListener("click", () => {
    callIntel("log-event", { event: "onboarding_role", role: _onb.role, source: _onb.source }).catch(() => {});
    showPage("fits");
  });

  // Which fits
  $$(".fits-card").forEach(c => {
    c.addEventListener("click", () => {
      $$(".fits-card").forEach(x => x.classList.remove("active"));
      c.classList.add("active");
      _onb.fits = c.dataset.val;
      setTimeout(() => showPage("tutorial"), 280);
    });
  });

  // Tutorial → finish
  $("tutorial-start")?.addEventListener("click", () => {
    finishOnboarding();
  });
  $("tutorial-skip")?.addEventListener("click", () => {
    finishOnboarding();
  });
}

async function finishOnboarding() {
  localStorage.setItem(ONB_KEY, "1");
  callIntel("log-event", { event: "onboarding_complete", fits: _onb.fits }).catch(() => {});
  // Tell Tauri to open the overlay capsule
  if (isTauri()) {
    try { await window.__TAURI__.core.invoke("show_overlay"); } catch {}
  }
  showPage("dashboard");
}

// ─── Resend countdown ─────────────────────────────────────────────
function startResendCountdown() {
  const link = $("resend-link");
  if (!link) return;
  let secs = 30;
  link.classList.add("disabled");
  const tick = () => {
    secs -= 1;
    if (secs > 0) {
      link.textContent = `Didn't receive a code? Resend (${secs})`;
      setTimeout(tick, 1000);
    } else {
      link.textContent = "Didn't receive a code? Resend";
      link.classList.remove("disabled");
      link.onclick = async () => {
        if (link.classList.contains("disabled")) return;
        if (!_onb.email) return;
        link.classList.add("disabled");
        await callIntel("auth-magic-link-request", { email: _onb.email });
        showToast("Code resent");
        startResendCountdown();
      };
    }
  };
  setTimeout(tick, 1000);
}

// ─── Dashboard ────────────────────────────────────────────────────
function refreshDashboard() {
  const stats = todayStats();
  $("d-drafts").textContent = stats.drafts;
  $("d-sent").textContent = stats.sent;
  const m = Math.floor((stats.watchSec || 0) / 60);
  $("d-watch").textContent = m >= 60 ? `${(m/60).toFixed(1)}h` : `${m}m`;
  $("d-hot").textContent = stats.hot || 0;
  $("dash-version").textContent = `v${KLOSR_VERSION}`;
  if (_user?.yourName || _user?.firstName) {
    $("dash-firstname").textContent = (_user.yourName || _user.firstName || "Founder").split(" ")[0];
  }
}

function wireDashboard() {
  $("dash-toggle-watch")?.addEventListener("click", async () => {
    if (isTauri()) {
      await window.__TAURI__.core.invoke("show_overlay").catch(() => {});
      await window.__TAURI__.core.invoke("toggle_watch_from_main").catch(() => {});
      showToast("Switched to capsule — watching now");
    } else { showToast("Open Klosr Desktop to start watching"); }
  });
  $("dash-open-overlay")?.addEventListener("click", async () => {
    if (isTauri()) await window.__TAURI__.core.invoke("show_overlay").catch(() => {});
  });
  $("dash-empty-start")?.addEventListener("click", () => $("dash-toggle-watch").click());
}

// ─── Settings ─────────────────────────────────────────────────────
function refreshSettingsPanel() {
  $("gen-version").textContent = KLOSR_VERSION;
  $$("[data-set]").forEach(sw => {
    const k = sw.dataset.set;
    sw.classList.toggle("on", !!_settings[k]);
  });
  if ($("theme-select")) $("theme-select").value = _settings.theme;
  if ($("sens-slider")) $("sens-slider").value = _settings.sensitivity;
}
function wireSettings() {
  $$("[data-set]").forEach(sw => {
    sw.addEventListener("click", () => {
      const k = sw.dataset.set;
      _settings[k] = !_settings[k];
      sw.classList.toggle("on", _settings[k]);
      saveSettings();
    });
  });
  $("theme-select")?.addEventListener("change", (e) => {
    _settings.theme = e.target.value;
    saveSettings();
  });
  $("sens-slider")?.addEventListener("input", (e) => {
    _settings.sensitivity = Number(e.target.value);
    saveSettings();
  });
  $("check-updates")?.addEventListener("click", async () => {
    const btn = $("check-updates");
    btn.disabled = true; btn.textContent = "Checking…";
    try {
      const res = await fetch(`https://backend-kappa-nine-57.vercel.app/api/updater/windows-x86_64/${KLOSR_VERSION}`);
      if (!res || res.status === 204) showToast("Up to date");
      else if (res.ok) {
        const j = await res.json().catch(() => null);
        showToast(j?.version ? `Update available: ${j.version}` : "Update available");
      } else { showToast("Couldn't check"); }
    } catch { showToast("Couldn't check"); }
    btn.textContent = "Check for updates"; btn.disabled = false;
  });
  $("sec-clear")?.addEventListener("click", () => {
    if (!confirm("Clear all locally cached drafts, stats, and settings?")) return;
    localStorage.removeItem(STATS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    _settings = { ...defaultSettings };
    refreshSettingsPanel();
    showToast("Local data cleared");
  });
}

// ─── Profile ──────────────────────────────────────────────────────
function refreshProfile() {
  $("profile-name").value = _user?.yourName || "";
  $("profile-company").value = _user?.companyName || "";
  $("profile-email").textContent = _user?.email || _onb.email || "—";
  // Avatar initial
  const initial = (_user?.yourName || _user?.email || "K").charAt(0).toUpperCase();
  if ($("avatar")) $("avatar").textContent = initial;
}
function wireProfile() {
  ["profile-name", "profile-company"].forEach(id => {
    $(id)?.addEventListener("change", () => {
      _user = _user || {};
      _user.yourName = $("profile-name").value;
      _user.companyName = $("profile-company").value;
      try { localStorage.setItem(USER_KEY, JSON.stringify(_user)); } catch {}
      // Persist to backend
      const iid = localStorage.getItem(IID_KEY);
      if (iid) callIntel("log-event", { event: "profile_update", installId: iid, ..._user }).catch(() => {});
    });
  });
}

// ─── Billing ──────────────────────────────────────────────────────
let billingMode = "annual";
function refreshBilling() {
  const monthly = $("bill-monthly");
  const annual = $("bill-annual");
  if (!monthly || !annual) return;
  $$(".plan-card .strike, .plan-card .amt").forEach(el => {
    const v = billingMode === "monthly" ? el.dataset.mo : el.dataset.yr;
    if (v) el.textContent = v;
  });
  $$(".plan-card .pct").forEach(el => {
    el.textContent = billingMode === "monthly" ? "" : "-45%";
    el.style.display = billingMode === "monthly" ? "none" : "";
  });
}
function wireBilling() {
  $("bill-monthly")?.addEventListener("click", () => {
    billingMode = "monthly";
    $("bill-monthly").classList.add("active");
    $("bill-annual").classList.remove("active");
    refreshBilling();
  });
  $("bill-annual")?.addEventListener("click", () => {
    billingMode = "annual";
    $("bill-annual").classList.add("active");
    $("bill-monthly").classList.remove("active");
    refreshBilling();
  });
  $$(".plan-card .upg").forEach(b => {
    b.addEventListener("click", async () => {
      const plan = b.dataset.plan;
      const iid = localStorage.getItem(IID_KEY) || "";
      const res = await callIntel("stripe-create-checkout", { plan, period: billingMode, installId: iid });
      if (res?.url) openExternal(res.url);
      else showToast("Couldn't open checkout");
    });
  });
}

// ─── Integrations ─────────────────────────────────────────────────
async function refreshIntegrations() {
  const iid = localStorage.getItem(IID_KEY);
  if (!iid) return;
  const res = await callIntel("sync-state", { installId: iid });
  if (!res?.ok) return;
  const integ = res.syncedState?.integrations || {};
  ["hubspot", "salesforce", "pipedrive", "slack"].forEach(k => {
    const el = document.querySelector(`.pill[data-int="${k}"]`);
    if (!el) return;
    const ok = !!integ[k]?.connected;
    el.textContent = ok ? "Connected" : "Not connected";
    el.classList.toggle("hot", false);
    el.classList.toggle("warm", ok);
    el.classList.toggle("cold", !ok);
  });
}

// ─── Sidebar / Title bar wiring ───────────────────────────────────
function wireShell() {
  $$(".nav-item[data-route]").forEach(n => {
    n.addEventListener("click", () => showPage(n.dataset.route));
  });
  $$("[data-route]").forEach(n => {
    if (!n.classList.contains("nav-item")) {
      n.addEventListener("click", () => showPage(n.dataset.route));
    }
  });
  $$("[data-ext]").forEach(n => {
    n.addEventListener("click", (e) => { e.preventDefault(); openExternal(n.dataset.ext); });
  });

  // Title bar nav
  $("nav-back")?.addEventListener("click", navBack);
  $("nav-fwd")?.addEventListener("click", navFwd);

  // Window controls
  if (isTauri()) {
    const win = window.__TAURI__.window?.getCurrentWindow?.();
    $("win-min")?.addEventListener("click", () => win?.minimize?.());
    $("win-max")?.addEventListener("click", async () => {
      const max = await win?.isMaximized?.();
      if (max) win?.unmaximize?.(); else win?.maximize?.();
    });
    $("win-close")?.addEventListener("click", () => win?.close?.());
  }

  // Sign out / Quit
  $("signout-btn")?.addEventListener("click", () => {
    if (!confirm("Sign out of Klosr?")) return;
    localStorage.removeItem(IID_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ONB_KEY);
    location.reload();
  });
  $("quit-btn")?.addEventListener("click", async () => {
    if (isTauri()) {
      try { await window.__TAURI__.process?.exit?.(0); } catch {}
    }
  });

  // Avatar → profile
  $("avatar")?.addEventListener("click", () => showPage("profile"));

  // Search bar — basic command palette: route names match
  $("searchbar")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const map = {
      "settings": "general", "general": "general",
      "billing": "billing", "pricing": "billing", "upgrade": "billing",
      "drafts": "drafts", "sessions": "sessions", "voice": "voice",
      "integrations": "integrations", "crm": "integrations",
      "profile": "profile", "account": "profile",
      "keybinds": "keybinds", "shortcuts": "keybinds",
      "language": "language", "release": "release", "release notes": "release",
      "help": "help", "support": "support", "contact": "support",
      "dashboard": "dashboard", "home": "dashboard",
    };
    const route = map[q];
    if (route) { showPage(route); e.target.value = ""; }
    else showToast(`No page for "${q}"`);
  });
}

// ─── Boot ─────────────────────────────────────────────────────────
// Each step is wrapped in try/catch — a single broken handler must NEVER
// prevent the splash from hiding or the rest of the app from booting.
const safe = (fn, label) => { try { fn(); } catch (e) { console.error(`[klosr] ${label} failed:`, e); } };

(function bootKlosr() {
  console.log("[klosr] main.js booting v" + KLOSR_VERSION);

  // No splash anymore — welcome renders directly. Belt-and-suspenders
  // cleanup in case an old cached main.html still has a #splash element.
  try { $("splash")?.remove(); } catch {}

  safe(loadSettings, "loadSettings");
  safe(wireShell, "wireShell");
  safe(wireOnboarding, "wireOnboarding");
  safe(wireDashboard, "wireDashboard");
  safe(wireSettings, "wireSettings");
  safe(wireProfile, "wireProfile");
  safe(wireBilling, "wireBilling");

  // Load cached user
  try { _user = JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch {}
  const onboarded = localStorage.getItem(ONB_KEY) === "1";
  const iid = localStorage.getItem(IID_KEY);

  try {
    if (onboarded && iid) {
      showPage("dashboard");
      // Background-sync user state — fire and forget, don't block UI
      callIntel("pwa-bootstrap", { installId: iid }).then(res => {
        if (res?.ok) {
          _user = { ...res.user, syncedState: res.syncedState || null };
          try { localStorage.setItem(USER_KEY, JSON.stringify(_user)); } catch {}
          safe(refreshDashboard, "refreshDashboard");
          safe(refreshProfile, "refreshProfile");
        }
      }).catch(err => console.warn("[klosr] pwa-bootstrap failed", err));
    } else {
      showPage("welcome");
    }
  } catch (e) {
    console.error("[klosr] boot routing failed, falling back to welcome:", e);
    try { showPage("welcome"); } catch {}
  }

  console.log("[klosr] main.js boot complete");
})();
