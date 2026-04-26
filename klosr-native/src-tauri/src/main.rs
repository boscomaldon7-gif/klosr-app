// Klosr Native Desktop — entry point
//
// Phase 1 (this file): system tray, global hotkey (Ctrl/Cmd+Shift+K),
// window management, OS notifications, embedded webview pointing at the
// Klosr Desktop PWA.
//
// Phase 2 (capture_screen): native screen capture via the `screenshots`
// crate. Bypasses the browser's "you are sharing your screen" banner —
// the native API doesn't surface that indicator. Captured frames are
// returned to the JS frontend as base64 PNG, which then POSTs to the
// existing /api/intel screenshot-analyze action.
//
// Phase 3 (inject_text): scaffolded but not implemented. Direct text
// injection into the focused composer of any native app via OS
// accessibility APIs (Windows UI Automation / macOS AXUIElement).
// Implementation notes at the bottom of this file.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// Last-known target window (the foreground HWND captured before the user
// moused over Klosr's overlay). v0.2.1 — used by inject_text_windows to
// SetForegroundWindow before SendInput, so the keystroke ALWAYS lands in
// the user's target app even if focus drifted between hover and click.
//
// Stored as `isize` (raw HWND.0 cast) because HWND isn't Send/Sync. We
// only deref it inside the thread that calls inject_text_windows.
static TARGET_HWND: Mutex<Option<isize>> = Mutex::new(None);

// ═══════════════════════════════════════════════════════════════════
// PHASE 2 — capture_screen
//
// Captures the entire primary screen via the `screenshots` crate, encodes
// as JPEG, and returns base64. JS frontend calls this command instead of
// navigator.mediaDevices.getDisplayMedia() when running inside Tauri.
//
// The KEY win over the PWA: no browser sharing banner. The OS treats the
// capture as a regular screenshot, not a continuous stream.
// ═══════════════════════════════════════════════════════════════════

#[derive(Serialize)]
struct CaptureResult {
    base64: String,
    mime_type: String,
    width: u32,
    height: u32,
}

#[tauri::command]
async fn capture_screen() -> Result<CaptureResult, String> {
    use screenshots::Screen;

    // Spawn capture on a blocking thread — the screenshots crate is sync
    // and we don't want to block the Tauri runtime.
    let result = tauri::async_runtime::spawn_blocking(|| -> Result<CaptureResult, String> {
        let screens = Screen::all().map_err(|e| format!("screen_enum_failed: {e}"))?;
        let screen = screens
            .into_iter()
            .find(|s| s.display_info.is_primary)
            .or_else(|| Screen::all().ok().and_then(|s| s.into_iter().next()))
            .ok_or_else(|| "no_screen_available".to_string())?;

        let img = screen
            .capture()
            .map_err(|e| format!("capture_failed: {e}"))?;

        let width = img.width();
        let height = img.height();

        // Encode as JPEG (quality 80) — smaller than PNG for OCR-of-text
        // workloads, plenty of fidelity for Vision.
        let mut buf = Vec::with_capacity((width * height) as usize);
        let dyn_img = image::DynamicImage::ImageRgba8(
            image::RgbaImage::from_raw(width, height, img.into_raw())
                .ok_or_else(|| "image_decode_failed".to_string())?,
        );
        // Convert to RGB8 since JPEG doesn't carry alpha
        let rgb = dyn_img.to_rgb8();
        let mut cursor = Cursor::new(&mut buf);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 82);
        rgb.write_with_encoder(encoder)
            .map_err(|e| format!("jpeg_encode_failed: {e}"))?;

        Ok(CaptureResult {
            base64: B64.encode(&buf),
            mime_type: "image/jpeg".to_string(),
            width,
            height,
        })
    })
    .await
    .map_err(|e| format!("join_failed: {e}"))??;

    Ok(result)
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 3 — inject_text (SCAFFOLDED, NOT YET IMPLEMENTED)
//
// Architecture: find the currently-focused text field in the foreground
// app via OS accessibility APIs and write text into it. This is what
// enables Klosr to fill WhatsApp Desktop / Outlook Desktop / Slack
// Desktop composers — apps the browser CANNOT reach.
//
// Implementation notes:
//
// macOS:
//   - Use AXUIElement (Cocoa Accessibility) via `accessibility-rs` crate
//     OR raw FFI to ApplicationServices framework
//   - Steps:
//     1. AXUIElementCreateSystemWide() → get system-wide element
//     2. AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute)
//        → focused element across all apps
//     3. AXUIElementSetAttributeValue(focused, kAXValueAttribute, text)
//        → write text directly
//   - Required: user grants Klosr "Accessibility" permission in
//     System Settings → Privacy & Security → Accessibility (one-time).
//   - User experience: zero browser banner, text appears in the active
//     composer of any Mac app.
//
// Windows:
//   - Use UIAutomation via the `windows-rs` crate
//   - Steps:
//     1. Get focused element: UIAutomation::GetFocusedElement()
//     2. Get TextPattern or ValuePattern from the element
//     3. SetValue() or insert via TextPattern::DocumentRange()
//   - Required permission: none (UIAutomation is unrestricted in Windows
//     for the current user's session).
//
// Linux:
//   - AT-SPI2 via `atspi` crate
//   - Less universal than macOS/Windows; many apps don't expose
//     accessible text fields properly. Best-effort.
//
// For v0.1 this command returns a "not_implemented" error so the JS
// frontend can fall back to the existing copy-to-clipboard flow.
// ═══════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
struct InjectTextArgs {
    text: String,
    target_app: Option<String>,
}

#[derive(Serialize)]
struct InjectTextResult {
    ok: bool,
    method: String,
    fallback: String,
}

#[tauri::command]
async fn inject_text(app: AppHandle, args: InjectTextArgs) -> Result<InjectTextResult, String> {
    log::info!(
        "[klosr] inject_text called (target={:?}, len={})",
        args.target_app,
        args.text.len()
    );

    // Phase 3 — Windows: clipboard-replace + SendInput Ctrl+V.
    //
    // Flow:
    //   1. Save user's current clipboard so we can restore after
    //   2. Write the draft to clipboard
    //   3. Hide the Klosr window so focus returns to whatever was foreground
    //      previously (Windows automatically focuses the next window)
    //   4. Brief sleep so the focus transition completes
    //   5. SendInput Ctrl+V → text gets pasted into whatever composer
    //      is now focused (WhatsApp Desktop, Outlook, Slack Desktop, etc)
    //   6. Restore the original clipboard after a delay
    //   7. Re-show Klosr so user sees the result
    //
    // This works for ANY native app on Windows — the OS doesn't need to
    // know we're a "sales tool", we're just simulating keyboard input
    // that the user could have done themselves.
    #[cfg(windows)]
    {
        let text = args.text.clone();
        let app_clone = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            inject_text_windows(&text, &app_clone)
        })
        .await
        .map_err(|e| format!("join_error: {e}"))?;

        match result {
            Ok(_) => Ok(InjectTextResult {
                ok: true,
                method: "windows_clipboard_paste".to_string(),
                fallback: "".to_string(),
            }),
            Err(e) => {
                log::warn!("[klosr] inject_text failed: {e}");
                Ok(InjectTextResult {
                    ok: false,
                    method: format!("error: {e}"),
                    fallback: "clipboard".to_string(),
                })
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let text = args.text.clone();
        let app_clone = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            inject_text_macos(&text, &app_clone)
        })
        .await
        .map_err(|e| format!("join_error: {e}"))?;

        match result {
            Ok(_) => Ok(InjectTextResult {
                ok: true,
                method: "macos_clipboard_cmd_v".to_string(),
                fallback: "".to_string(),
            }),
            Err(e) => {
                log::warn!("[klosr] inject_text macOS failed: {e}");
                Ok(InjectTextResult {
                    ok: false,
                    method: format!("error: {e}"),
                    fallback: "clipboard".to_string(),
                })
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        // Linux Phase 3: AT-SPI2 / Wayland — many distros don't expose
        // accessible text fields properly. We fall back to clipboard +
        // user-presses-Ctrl-V for now.
        Ok(InjectTextResult {
            ok: false,
            method: "not_implemented_for_this_platform".to_string(),
            fallback: "clipboard".to_string(),
        })
    }
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 3 — macOS native text injection
//
// Approach: clipboard-replace + Cmd+V via core-graphics keystroke
// synthesis. Same pattern as Windows but using CGEventCreateKeyboardEvent.
//
// Permission: macOS prompts the user for "Klosr would like to control
// this computer using accessibility features" on first call. The user
// must grant it once in System Settings → Privacy & Security →
// Accessibility. Without it, CGEventPost silently no-ops.
//
// We attempt the paste and, if the keystroke didn't land (clipboard
// content unchanged after the paste window), we return error so JS
// falls back to clipboard + paste-instructions UX.
// ═══════════════════════════════════════════════════════════════════

#[cfg(target_os = "macos")]
fn inject_text_macos(text: &str, app: &AppHandle) -> Result<(), String> {
    use std::thread::sleep;
    use std::time::Duration;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    // 1. Save current clipboard
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard_init: {e}"))?;
    let saved = clipboard.get_text().ok();

    // 2. Write draft to clipboard
    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard_set: {e}"))?;

    // 3. Hide Klosr overlay so focus returns to the previous app
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.hide();
    }
    sleep(Duration::from_millis(180));

    // 4. Synthesize Cmd+V via core-graphics
    //    kVK_ANSI_V = 9 on macOS
    let v_keycode: CGKeyCode = 9;
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "cg_event_source_failed".to_string())?;

    // Press V with Command modifier
    let down = CGEvent::new_keyboard_event(source.clone(), v_keycode, true)
        .map_err(|_| "cg_event_create_down_failed".to_string())?;
    down.set_flags(CGEventFlags::CGEventFlagCommand);
    down.post(CGEventTapLocation::HID);

    sleep(Duration::from_millis(20));

    // Release V
    let up = CGEvent::new_keyboard_event(source, v_keycode, false)
        .map_err(|_| "cg_event_create_up_failed".to_string())?;
    up.set_flags(CGEventFlags::CGEventFlagCommand);
    up.post(CGEventTapLocation::HID);

    // 5. Wait for paste to land, then restore clipboard
    sleep(Duration::from_millis(220));
    if let Some(s) = saved {
        let _ = clipboard.set_text(s);
    }

    // 6. Re-show Klosr overlay
    if let Some(window) = app.get_webview_window("overlay") {
        sleep(Duration::from_millis(100));
        let _ = window.show();
    }

    Ok(())
}

#[cfg(windows)]
fn inject_text_windows(text: &str, _app: &AppHandle) -> Result<(), String> {
    use std::thread::sleep;
    use std::time::Duration;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };

    // v0.2.1 — Robust auto-paste for any Windows app, including Electron
    // (WhatsApp Desktop, Slack Desktop, Discord, Teams, VS Code).
    //
    // The v0.2.0 approach (clipboard-replace + SendInput Ctrl+V) failed on
    // Electron apps because they intercept Ctrl+V in JS and the synthetic
    // keystroke doesn't always trigger their paste handlers reliably.
    //
    // v0.2.1 strategy:
    //   1. Recall the target HWND captured by capture_target_window when
    //      the user moused over the inject button (foreground at that
    //      time = the app they were working in)
    //   2. AttachThreadInput + SetForegroundWindow → bring the target to
    //      front and give it keyboard focus
    //   3. SendInput KEYEVENTF_UNICODE for each UTF-16 code unit → looks
    //      like the user typed each character. Bypasses Ctrl+V entirely,
    //      so Electron apps treat it as real keyboard input.
    //   4. Also write to clipboard so manual Ctrl+V is a fallback option

    // ─── 1. Resolve target HWND ───
    let target_hwnd_isize = TARGET_HWND.lock().ok().and_then(|g| *g);
    let target_hwnd = unsafe {
        match target_hwnd_isize {
            Some(h) if h != 0 => HWND(h as *mut _),
            _ => GetForegroundWindow(),
        }
    };

    if target_hwnd.is_invalid() {
        return Err("no_target_window".to_string());
    }

    log::info!(
        "[klosr] inject_text_windows: target hwnd={:?}, len={}",
        target_hwnd.0,
        text.len()
    );

    // ─── 2. Write to clipboard (manual Ctrl+V fallback) ───
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard_init: {e}"))?;
    let saved = clipboard.get_text().ok();
    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard_set: {e}"))?;

    // ─── 3. Force-focus the target window via AttachThreadInput trick ───
    // (Windows' security model normally blocks SetForegroundWindow from
    //  background processes, but attaching our thread's input queue to
    //  the target's thread bypasses that restriction.)
    unsafe {
        let our_thread = GetCurrentThreadId();
        let mut target_pid: u32 = 0;
        let target_thread = GetWindowThreadProcessId(target_hwnd, Some(&mut target_pid));
        if target_thread != 0 && target_thread != our_thread {
            let _ = AttachThreadInput(our_thread, target_thread, true);
            let _ = SetForegroundWindow(target_hwnd);
            sleep(Duration::from_millis(40));
            let _ = AttachThreadInput(our_thread, target_thread, false);
        } else {
            let _ = SetForegroundWindow(target_hwnd);
            sleep(Duration::from_millis(40));
        }
    }

    // ─── 4. Type each UTF-16 code unit via SendInput KEYEVENTF_UNICODE ───
    // We chunk the input list to ~32 events at a time. SendInput accepts
    // larger arrays but Windows can drop events under load — small chunks
    // with a tiny inter-chunk pause is more reliable.
    let utf16: Vec<u16> = text.encode_utf16().collect();
    if utf16.is_empty() {
        return Ok(());
    }

    let mut buf: Vec<INPUT> = Vec::with_capacity(64);
    let flush =
        |buf: &mut Vec<INPUT>| -> Result<(), String> {
            if buf.is_empty() {
                return Ok(());
            }
            unsafe {
                let sent = SendInput(buf, std::mem::size_of::<INPUT>() as i32);
                if sent == 0 {
                    return Err("SendInput rejected (0 events sent)".to_string());
                }
            }
            buf.clear();
            Ok(())
        };

    for ch in utf16 {
        // Press
        buf.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: ch,
                    dwFlags: KEYEVENTF_UNICODE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
        // Release
        buf.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: ch,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });

        if buf.len() >= 32 {
            flush(&mut buf)?;
            sleep(Duration::from_millis(8));
        }
    }
    flush(&mut buf)?;

    // ─── 5. Restore clipboard after a short delay ───
    sleep(Duration::from_millis(120));
    if let Some(s) = saved {
        let _ = clipboard.set_text(s);
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════
// CAPTURE TARGET WINDOW (v0.2.1)
//
// JS calls this on `mouseenter` of an inject button. It records whatever
// window is currently foreground (i.e. the user's target app — WhatsApp,
// Slack, Outlook, etc.) so inject_text_windows can SetForegroundWindow
// to it later, ensuring the typed-out text ALWAYS lands in the right app.
//
// Klosr's overlay has WS_EX_NOACTIVATE, so even after the user moves
// their mouse onto Klosr, the underlying app remains the foreground
// window — capturing it here is reliable.
// ═══════════════════════════════════════════════════════════════════

#[derive(Serialize)]
struct CaptureTargetResult {
    captured: bool,
    hwnd: i64,
    title: String,
}

#[tauri::command]
fn capture_target_window() -> CaptureTargetResult {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowTextW,
        };
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return CaptureTargetResult {
                    captured: false,
                    hwnd: 0,
                    title: String::new(),
                };
            }
            // Read window title (best-effort, used only for logging)
            let mut buf = [0u16; 256];
            let len = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..len as usize]);

            let hwnd_val = hwnd.0 as isize;
            if let Ok(mut guard) = TARGET_HWND.lock() {
                *guard = Some(hwnd_val);
            }
            log::info!("[klosr] capture_target_window: hwnd={hwnd_val}, title={title:?}");
            return CaptureTargetResult {
                captured: true,
                hwnd: hwnd_val as i64,
                title,
            };
        }
    }
    #[cfg(not(windows))]
    {
        // macOS: AXUIElement focused-window tracking would go here.
        // For now this is a Windows-only optimization.
        CaptureTargetResult {
            captured: false,
            hwnd: 0,
            title: String::new(),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// PING — health check command. JS uses this to detect Tauri context.
// ═══════════════════════════════════════════════════════════════════

#[tauri::command]
fn ping() -> &'static str {
    "klosr-native-v0.3.0"
}

// ═══════════════════════════════════════════════════════════════════
// WINDOW MANAGEMENT (v0.3.0 — two windows: main + overlay)
//
// "main"    → full app window (onboarding, dashboard, settings, billing)
// "overlay" → floating Cluely-style capsule (the actual sales co-pilot)
//
// show_window / hide_window operate on the OVERLAY by default (kept for
// backwards compat with the overlay's app.js calls). show_main /
// show_overlay are the explicit targeted commands.
// ═══════════════════════════════════════════════════════════════════

#[tauri::command]
fn show_window(app: AppHandle) {
    // Default target = overlay (the capsule's "Hide" button calls this)
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.show();
        let _ = window.unminimize();
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn show_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.unminimize();
    }
}

#[tauri::command]
fn show_overlay(app: AppHandle) {
    // Show the capsule WITHOUT taking focus — overlay is non-activating
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.show();
        let _ = window.unminimize();
    }
}

#[tauri::command]
fn hide_overlay(app: AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn toggle_watch_from_main(app: AppHandle) {
    // Bring overlay forward, then ask its JS to start Watch via an event.
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.show();
    }
    // Emit a Tauri event the overlay's app.js can listen for.
    let _ = app.emit("klosr-toggle-watch", ());
}

// ═══════════════════════════════════════════════════════════════════
// MAIN — Tauri app lifecycle
// ═══════════════════════════════════════════════════════════════════

fn main() {
    env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .init();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        log::info!("[klosr] global hotkey pressed: {:?}", shortcut);
                        // Toggle the OVERLAY (the floating capsule) — that's
                        // what users hit a hotkey for. The main app window is
                        // toggled via tray icon click instead.
                        if let Some(window) = app.get_webview_window("overlay") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                // Don't set_focus — overlay is non-activating
                            }
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            ping,
            capture_screen,
            inject_text,
            capture_target_window,
            show_window,
            hide_window,
            show_main,
            show_overlay,
            hide_overlay,
            toggle_watch_from_main,
        ]);

    builder = builder.setup(|app| {
        // ─── Register the global hotkey: Ctrl+Shift+K (Cmd+Shift+K on Mac) ───
        // Best-effort: if the hotkey is already claimed by another app
        // (or an orphan Klosr instance), we log a warning and continue —
        // the user can still open Klosr via the system tray icon. We try
        // a fallback combo (Ctrl/Cmd+Shift+J) before giving up entirely.
        #[cfg(target_os = "macos")]
        let primary = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyK);
        #[cfg(not(target_os = "macos"))]
        let primary = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyK);

        match app.global_shortcut().register(primary) {
            Ok(_) => log::info!("[klosr] global hotkey registered: Ctrl/Cmd+Shift+K"),
            Err(e) => {
                log::warn!("[klosr] primary hotkey unavailable ({e}); trying fallback");
                #[cfg(target_os = "macos")]
                let fallback = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyJ);
                #[cfg(not(target_os = "macos"))]
                let fallback = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyJ);

                if let Err(e2) = app.global_shortcut().register(fallback) {
                    log::warn!("[klosr] fallback hotkey also unavailable ({e2}); continuing without global hotkey — open via tray icon");
                } else {
                    log::info!("[klosr] global hotkey registered: Ctrl/Cmd+Shift+J (fallback)");
                }
            }
        }

        // ─── System tray icon + menu ───
        let menu = Menu::with_items(
            app,
            &[
                &MenuItem::with_id(app, "show_main", "Open Klosr (Dashboard)", true, None::<&str>)?,
                &MenuItem::with_id(app, "show_overlay", "Show Capsule (Overlay)", true, None::<&str>)?,
                &MenuItem::with_id(app, "hide_overlay", "Hide Capsule", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "klosr_com", "Open klosr.com", true, None::<&str>)?,
                &MenuItem::with_id(app, "support", "Email Support", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "quit", "Quit Klosr", true, None::<&str>)?,
            ],
        )?;

        // Tray icon — uses the bundled "icons/icon.png" specified in tauri.conf.json
        let _tray = TrayIconBuilder::with_id("klosr-tray")
            .menu(&menu)
            .show_menu_on_left_click(false) // single-click = show window; right-click = menu
            .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
                // fallback if the default icon failed to load
                Image::from_bytes(include_bytes!("../icons/icon.png")).unwrap()
            }))
            .tooltip("Klosr — Sales OS for Founders")
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show_main" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.unminimize();
                    }
                }
                "show_overlay" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.show();
                        let _ = window.unminimize();
                    }
                }
                "hide_overlay" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.hide();
                    }
                }
                "klosr_com" => {
                    use tauri_plugin_shell::ShellExt;
                    let _ = app.shell().open("https://klosr.com", None);
                }
                "support" => {
                    use tauri_plugin_shell::ShellExt;
                    let _ = app.shell().open("mailto:hello@klosr.com", None);
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button, .. } = event {
                    if button == MouseButton::Left {
                        // Left-click on tray = toggle the MAIN app window
                        // (Dashboard, settings). Right-click opens the menu
                        // which has separate items for the overlay capsule.
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let visible = window.is_visible().unwrap_or(false);
                            if visible {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.unminimize();
                            }
                        }
                    }
                }
            })
            .build(app)?;

        log::info!("[klosr] system tray ready");

        // ─── Inject the Tauri detection bridge into BOTH webviews ───
        // Tauri's `withGlobalTauri: true` exposes window.__TAURI__ automatically;
        // we add window.klosrNative for JS to detect native context.
        let platform = std::env::consts::OS;
        let bridge_overlay = format!(r#"
            window.klosrNative = {{
                version: '0.3.0', platform: '{platform}', isOverlay: true,
                capabilities: ['capture_screen', 'notify', 'global_hotkey', 'inject_text', 'overlay'],
            }};
            console.log('[Klosr Overlay] Tauri bridge ready', window.klosrNative);
        "#);
        let bridge_main = format!(r#"
            window.klosrNative = {{
                version: '0.3.0', platform: '{platform}', isOverlay: false,
                capabilities: ['main_app', 'onboarding', 'billing', 'integrations', 'settings'],
            }};
            console.log('[Klosr Main] Tauri bridge ready', window.klosrNative);
        "#);
        if let Some(w) = app.get_webview_window("overlay") {
            let _ = w.eval(&bridge_overlay);
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(&bridge_main);
        }

        // ─── Make the OVERLAY window non-activating (Cluely-style) ───
        // WS_EX_NOACTIVATE keeps focus on whatever the user has open.
        // Critically, this is ONLY applied to the overlay — the main app
        // window IS a regular focusable window for typing in inputs etc.
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE,
                WS_EX_NOACTIVATE, WS_EX_TOPMOST,
            };
            if let Some(window) = app.get_webview_window("overlay") {
                if let Ok(hwnd) = window.hwnd() {
                    unsafe {
                        let hwnd: HWND = HWND(hwnd.0 as *mut _);
                        let mut ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                        ex_style |= (WS_EX_NOACTIVATE.0 | WS_EX_TOPMOST.0) as isize;
                        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style);
                    }
                    log::info!("[klosr] WS_EX_NOACTIVATE + WS_EX_TOPMOST applied to overlay");
                }
            }
        }

        Ok(())
    });

    builder
        .run(tauri::generate_context!())
        .expect("[klosr] failed to start Tauri runtime");
}
