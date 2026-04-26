# Klosr Native Desktop

Native macOS + Windows desktop app for Klosr. Built with Tauri 2.0 (Rust core + system webview).

The Klosr Chrome extension + PWA covers web apps. **Klosr Native is what unlocks the rest** — WhatsApp Desktop, Outlook Desktop, Slack Desktop, Telegram, Discord, anywhere on your screen — without the browser's "you're sharing your screen" banner, with a global hotkey, and (Phase 3) direct text injection into the focused composer of any native app.

---

## Status

| Phase | Status | What it ships |
|-------|--------|---------------|
| **Phase 1** | ✅ **Built** | System tray, global hotkey (Ctrl/Cmd+Shift+K), embedded webview pointing to Klosr Desktop PWA, OS notifications, auto-updater config |
| **Phase 2** | ✅ **Built (Rust side)** | Native screen capture via `screenshots` crate. JS Watch loop auto-detects Tauri context and switches to native capture instead of `getDisplayMedia`. No browser sharing banner. |
| **Phase 3** | 🟡 **Scaffolded** | `inject_text` Rust command exists but returns `not_implemented`. Architecture documented in `src/main.rs`. JS frontend gracefully falls back to clipboard. Needs: Windows UI Automation + macOS AXUIElement bindings. |

---

## Quick start (Windows)

### Prerequisites (one-time, ~30 min)

1. **Rust** — https://rustup.rs/ (run `rustup-init.exe`, accept defaults)
2. **Visual Studio Build Tools** — https://visualstudio.microsoft.com/downloads/?q=build+tools (install "Desktop development with C++" workload, including the Windows 10/11 SDK)
3. **WebView2 Runtime** — preinstalled on Windows 11; for Win 10 download from https://developer.microsoft.com/microsoft-edge/webview2/
4. **Node.js** (for the Tauri CLI) — https://nodejs.org/ (LTS)

### Build + run (5 min)

```powershell
cd C:\Users\bosco\Downloads\klosr\klosr-native

# install the Tauri CLI dependency
npm install

# dev mode — opens the app, hot-reloads Rust changes
npm run tauri dev
```

The app window opens, the K icon appears in your system tray, and `Ctrl+Shift+K` toggles the window from anywhere.

### Build a distributable installer

```powershell
npm run tauri build
```

Output: `src-tauri/target/release/bundle/`
- `nsis/Klosr_0.1.0_x64-setup.exe` — Windows NSIS installer
- `msi/Klosr_0.1.0_x64_en-US.msi` — Windows MSI

Both are unsigned for v0.1 (Windows SmartScreen will warn users on first run). For production:

1. Buy a code-signing certificate (Sectigo, DigiCert — €200-400/yr)
2. Set `windows.certificateThumbprint` in `tauri.conf.json` to your cert thumbprint
3. Re-run `npm run tauri build`

---

## Quick start (macOS)

### Prerequisites

1. **Xcode Command Line Tools** — `xcode-select --install`
2. **Rust** — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
3. **Node.js** — https://nodejs.org/

### Dev + build

```bash
cd ~/path/to/klosr-native
npm install
npm run tauri dev      # dev mode
npm run tauri build    # produce .dmg
```

Output: `src-tauri/target/release/bundle/dmg/Klosr_0.1.0_x64.dmg`

For Mac App Store / distribution outside it, you need an Apple Developer Program account ($99/yr) and to:

1. Set `macOS.signingIdentity` in `tauri.conf.json` to your Developer ID
2. Notarize via `xcrun notarytool` after `tauri build`
3. Distribute the signed + notarized `.dmg`

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  KLOSR NATIVE (Tauri 2.0)                                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Rust core (src-tauri/src/main.rs)                     │ │
│  │   - System tray + menu                                 │ │
│  │   - Global hotkey: Ctrl/Cmd+Shift+K                    │ │
│  │   - Window: show / hide / focus                        │ │
│  │   - capture_screen()  → native, no browser banner      │ │
│  │   - inject_text()     → Phase 3, accessibility APIs    │ │
│  │   - notify()          → OS-native notifications        │ │
│  │   - auto-updater                                       │ │
│  └─────────────────────┬──────────────────────────────────┘ │
│                        │ Tauri IPC                          │
│  ┌─────────────────────▼──────────────────────────────────┐ │
│  │  Webview (system WebView2 / WKWebView)                 │ │
│  │  Loads: https://backend-kappa-nine-57.vercel.app/app.html │
│  │   - Detects window.klosrNative + window.__TAURI__      │ │
│  │   - Switches Watch mode from getDisplayMedia →         │ │
│  │     Tauri capture_screen (no banner)                   │ │
│  │   - Sends drafts via existing /api/intel               │ │
│  │   - Inject buttons try native first, fall back to      │ │
│  │     clipboard / queue-pending-reply                    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**No frontend bundling needed for v0.1.** The webview points at the live Klosr PWA URL, which already detects Tauri context and adapts. This means: backend deploys to klosr.com automatically update the desktop app without rebuilding the binary. (We'll bundle locally in v1.0 for offline support.)

---

## Files in this folder

```
klosr-native/
├── README.md                       # This file
├── package.json                    # Tauri CLI script aliases
├── .gitignore
└── src-tauri/
    ├── Cargo.toml                  # Rust dependencies
    ├── tauri.conf.json             # Tauri app config (window, bundle, plugins)
    ├── build.rs                    # Tauri build script
    ├── entitlements.plist          # macOS entitlements (screen capture, accessibility)
    ├── capabilities/
    │   └── default.json            # Tauri 2 capabilities (perms granted to webview)
    ├── icons/
    │   ├── icon.png                # 128×128 (placeholder — run `tauri icon` to generate full set)
    │   ├── 32x32.png
    │   ├── 128x128.png
    │   └── 128x128@2x.png
    └── src/
        └── main.rs                 # Rust entry point (tray + hotkey + commands)
```

---

## Generate the full icon set (one-time)

Tauri needs `.icns` (macOS), `.ico` (Windows), plus various PNG sizes. Generate them all from a single high-res source:

```bash
# from klosr-native/
npm install -g @tauri-apps/cli
npx @tauri-apps/cli icon path/to/source-icon-1024x1024.png
```

This populates `src-tauri/icons/` with everything. Use the existing 1024×1024 Klosr brand icon if you have one; otherwise upscale from `icons/icon128.png`.

---

## Phase 3 — implementing native text injection

This is what makes Klosr Native end-game-grade. Architecture is fully documented at the bottom of `src-tauri/src/main.rs`. Quick summary:

### Windows (UI Automation)

```toml
# Cargo.toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "UI_UIAutomation",
    "Win32_System_Com",
    "Win32_UI_Accessibility",
] }
```

```rust
// pseudo-code
let automation = CUIAutomation::new()?;
let focused = automation.GetFocusedElement()?;
let pattern: ValuePattern = focused.GetCurrentPatternAs(UIA_ValuePatternId)?;
pattern.SetValue(text)?;
```

No special permission needed on Windows — UIAutomation is unrestricted in user session.

### macOS (Accessibility / AXUIElement)

```toml
[target.'cfg(target_os = "macos")'.dependencies]
core-foundation = "0.10"
core-graphics = "0.24"
accessibility-sys = "0.1"
```

```rust
// pseudo-code
unsafe {
    let system_wide = AXUIElementCreateSystemWide();
    let mut focused: CFTypeRef = ptr::null();
    AXUIElementCopyAttributeValue(
        system_wide,
        kAXFocusedUIElementAttribute,
        &mut focused,
    );
    AXUIElementSetAttributeValue(
        focused as AXUIElementRef,
        kAXValueAttribute,
        cf_string(text),
    );
}
```

User must grant Klosr "Accessibility" permission once in System Settings → Privacy & Security → Accessibility. macOS will prompt automatically on first injection attempt.

Estimated effort for full Phase 3 implementation: 3-4 days, mostly platform-specific edge cases (composer field detection across diverse apps, formatting preservation, etc).

---

## Distribution plan

### Pre-launch (now → 1 week)
- ✅ Phase 1 + Phase 2 built
- 🟡 Test build locally on your machine (`npm run tauri build`)
- 🟡 Run on your own setup for 3-5 days alongside Pau's sprint
- 🟡 Iterate on bugs

### Launch (week 2)
- Set up code signing (Windows Authenticode + Apple Developer)
- GitHub Releases as the auto-update endpoint (or Vercel-hosted JSON manifest)
- Add `klosr.com/download` page with Mac + Windows installer links
- Push to founder network: Klosr Native is now available, $0 for Founder tier

### Phase 3 ship (week 3-4)
- Implement `inject_text` for Windows + macOS
- This is THE moment Klosr leapfrogs Cluely on sales depth
- Case study → Pau's wins published with native demo video

---

## Why this matters

The browser path (Chrome ext + PWA) covers **web apps**. That's already 80% of where Spanish/LatAm B2B founders sell. But the remaining 20% — WhatsApp Desktop, native email clients, native Slack — is exactly where the highest-LTV customers live (enterprise, traditional industries, anti-Chrome holdouts).

Klosr Native unlocks that long tail. Pro tier upsell justification: "the Pro tier is the desktop app, which works on EVERY app you use, not just web."

This is the moat.

— Built by Bosco Maldonado Arias · 2026 · klosr.com
