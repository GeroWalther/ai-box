// Screen Assist — the overlay that looks at your screen, answers out loud, and
// draws on top of whatever app you are actually using.
//
// Three pieces live here: capturing the screen, speaking the answer, and the
// overlay window itself.
//
// The overlay is one full-screen transparent window that is ALWAYS running and
// simply hidden most of the time — creating it per question would flash and cost
// a window-server round trip in the middle of an interaction.
//
// Click-through is handled by MODE rather than by hit-testing. The usual Tauri
// trick is a 60fps loop polling the cursor and toggling ignore_cursor_events as
// it crosses UI, which burns a core and still lags. Here the window only ever
// has two states: the ask bar is open and the window takes clicks, or an answer
// is on screen and the whole window is click-through — so you can click the very
// button it just circled. Nothing to poll.

use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// The overlay's window label, used everywhere it needs to be looked up.
pub const OVERLAY: &str = "screen-assist";

// ---- capture --------------------------------------------------------------

/// Grab the screen as base64 PNG.
///
/// The overlay is hidden first, or every screenshot would contain the ask bar
/// and the previous answer's annotations — the model would end up reading its
/// own output back and pointing at its own arrows. macOS needs a moment to
/// actually composite the window away, hence the pause; without it the capture
/// races the window server and catches the overlay mid-fade.
#[tauri::command]
pub async fn capture_screen(app: tauri::AppHandle) -> Result<String, String> {
    // Both layers must go: the bar would appear in the shot, and the previous
    // answer's marks would have the model reading its own arrows back.
    let mut restore = Vec::new();
    for label in [BAR, MARKS] {
        if let Some(w) = app.get_webview_window(label) {
            if w.is_visible().unwrap_or(false) {
                let _ = w.hide();
                restore.push(w);
            }
        }
    }
    if !restore.is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(140)).await;
    }

    // Asked up front: a capture without permission fails in ways that are hard
    // to tell from a real error, and this names the cause exactly.
    let result = if crate::control::screen_access() {
        capture_to_base64().await
    } else {
        Err("AI Box is not allowed to see your screen. Open System Settings → \
Privacy & Security → Screen & System Audio Recording and switch AI Box on."
            .to_string())
    };

    for w in restore {
        let _ = w.show();
    }
    result
}

async fn capture_to_base64() -> Result<String, String> {
    let path = std::env::temp_dir().join(format!("ai-box-screen-{}.png", uuid::Uuid::new_v4()));
    // -x: no shutter sound. -o: no window shadow. -C: skip the cursor, which the
    // model would otherwise sometimes describe as part of the interface.
    let status = tokio::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-C", "-t", "png"])
        .arg(&path)
        .status()
        .await
        .map_err(|e| format!("run screencapture: {e}"))?;
    if !status.success() {
        return Err("Screen capture failed. Grant AI Box Screen Recording permission in \
System Settings → Privacy & Security → Screen Recording, then restart it."
            .into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read capture: {e}"))?;
    let _ = std::fs::remove_file(&path);
    if bytes.is_empty() {
        return Err("Screen capture produced an empty image. Check Screen Recording permission.".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Logical size of the display the overlay covers, so the frontend can map the
/// model's normalised 0–1000 coordinates onto real points.
#[tauri::command]
pub fn screen_size(app: tauri::AppHandle) -> Result<(f64, f64), String> {
    let win = app
        .get_webview_window(MARKS)
        .or_else(|| app.get_webview_window("main"))
        .ok_or("no window")?;
    let monitor = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor")?;
    let size = monitor.size();
    let scale = monitor.scale_factor();
    Ok((size.width as f64 / scale, size.height as f64 / scale))
}

// ---- speech ---------------------------------------------------------------

/// An installed macOS voice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub name: String,
    pub locale: String,
    /// One of the handful worth offering by default — the voices a person would
    /// actually choose to be read to by, as opposed to the other 170.
    pub classic: bool,
    /// Apple's Premium and Enhanced voices sound dramatically better than the
    /// default ones, and are a free download the user has to opt into — so the
    /// UI needs to be able to point at them.
    pub quality: String,
}

/// Novelty and legacy voices, which are not voices in any useful sense.
///
/// macOS ships jokes (Bubbles, Zarvox, Bad News) alongside 1980s formant
/// synthesisers (Albert, Fred, Ralph) in the same list as its real ones. They
/// are unusable for reading an answer aloud, and because the list is otherwise
/// alphabetical, "Albert" was winning the English default outright.
const NOVELTY: &[&str] = &[
    "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Deranged", "Fred",
    "Good News", "Grandma", "Grandpa", "Hysterical", "Jester", "Junior", "Kathy", "Organ",
    "Pipe Organ", "Princess", "Ralph", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox",
];

/// The shortlist, best first within each language.
///
/// Ordered deliberately rather than alphabetically: the first match for a
/// language becomes the automatic choice, so Samantha reads English and Anna
/// reads German without anyone opening a menu.
const CLASSIC: &[&str] = &[
    // English
    "Samantha", "Alex", "Ava", "Allison", "Tom", "Susan", "Karen", "Daniel", "Serena", "Kate",
    "Oliver", "Moira", "Fiona", "Tessa", "Rishi", "Reed", "Flo", "Sandy", "Eddy", "Rocko",
    "Shelley",
    // German
    "Anna", "Markus", "Petra", "Viktor", "Helena",
    // French, Spanish, Italian, Portuguese, Dutch, the Nordics
    "Thomas", "Amélie", "Audrey", "Aurélie", "Marie", "Mónica", "Jorge", "Paulina", "Juan",
    "Alice", "Luca", "Federica", "Joana", "Luciana", "Xander", "Ellen", "Alva", "Nora", "Sara",
    "Satu", "Zosia", "Milena", "Yuna", "Kyoko", "Otoya", "Ting-Ting", "Sin-ji",
];

/// The name without the "(Enhanced)" or "(English (UK))" tail macOS appends.
fn bare_name(name: &str) -> &str {
    name.split(" (").next().unwrap_or(name).trim()
}

/// Voices `say` can actually use, English first.
///
/// Siri's own voice is deliberately absent: Apple does not expose it to `say`
/// or to AVSpeechSynthesizer, so no third-party app can speak in it. Premium is
/// the closest thing available.
#[tauri::command]
pub fn list_voices() -> Vec<Voice> {
    let out = match std::process::Command::new("/usr/bin/say").args(["-v", "?"]).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut voices: Vec<Voice> = text
        .lines()
        .filter_map(|line| {
            // "Samantha           en_US    # Hello! My name is Samantha."
            let (head, _) = line.split_once('#')?;
            let head = head.trim_end();
            let idx = head.rfind(char::is_whitespace)?;
            let (name, locale) = head.split_at(idx);
            let name = name.trim().to_string();
            let locale = locale.trim().to_string();
            if name.is_empty() || !locale.contains('_') {
                return None;
            }
            if NOVELTY.contains(&bare_name(&name)) {
                return None;
            }
            let quality = if name.contains("(Premium)") {
                "premium"
            } else if name.contains("(Enhanced)") {
                "enhanced"
            } else {
                "default"
            };
            let classic = CLASSIC.contains(&bare_name(&name));
            Some(Voice { name, locale, classic, quality: quality.into() })
        })
        .collect();
    // Best first, because the FIRST match for a language is what gets used when
    // nobody has picked a voice. Quality leads — a Premium voice is a different
    // class of thing — and the shortlist breaks the tie in its own order, so an
    // alphabetical accident can never decide how the assistant sounds.
    let rank = |v: &Voice| match v.quality.as_str() {
        "premium" => 0,
        "enhanced" => 1,
        _ => 2,
    };
    let shortlist = |v: &Voice| {
        CLASSIC
            .iter()
            .position(|c| *c == bare_name(&v.name))
            .unwrap_or(CLASSIC.len())
    };
    voices.sort_by(|a, b| {
        let en = |v: &Voice| if v.locale.starts_with("en") { 0 } else { 1 };
        en(a)
            .cmp(&en(b))
            .then(rank(a).cmp(&rank(b)))
            .then(shortlist(a).cmp(&shortlist(b)))
            .then(a.name.cmp(&b.name))
    });
    voices
}

/// The currently speaking `say` process, so a new answer can cut off the old one.
#[derive(Default)]
pub struct Speaker(std::sync::Mutex<Option<tokio::process::Child>>);

/// Speak `text`. Interrupts whatever was being said — an assistant that queues
/// up three stale answers while you ask a fourth is worse than a silent one.
#[tauri::command]
pub async fn speak(
    text: String,
    voice: Option<String>,
    rate: Option<u32>,
    speaker: tauri::State<'_, Speaker>,
) -> Result<(), String> {
    // Kill the previous utterance inline rather than via stop_speaking: State
    // is not Clone, and holding the lock across the await below would deadlock
    // the next call.
    if let Some(mut old) = speaker.0.lock().unwrap().take() {
        let _ = old.start_kill();
    }
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    let mut cmd = tokio::process::Command::new("/usr/bin/say");
    if let Some(v) = voice.as_deref().filter(|v| !v.trim().is_empty()) {
        cmd.args(["-v", v]);
    }
    if let Some(r) = rate.filter(|r| *r >= 80 && *r <= 400) {
        cmd.args(["-r", &r.to_string()]);
    }
    // Pass the text via stdin rather than as an argument: an answer starting
    // with "-" would otherwise be read as a flag, and long answers can exceed
    // the argument limit.
    cmd.arg("-f").arg("-").stdin(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("run say: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(text.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    *speaker.0.lock().unwrap() = Some(child);
    Ok(())
}

/// Cut off whatever is being spoken. Safe to call when nothing is.
#[tauri::command]
pub fn stop_speaking(speaker: tauri::State<'_, Speaker>) {
    if let Some(mut child) = speaker.0.lock().unwrap().take() {
        let _ = child.start_kill();
    }
}

// ---- the overlay windows --------------------------------------------------
//
// TWO windows, not one, and the split is what makes the thing usable.
//
//   * `MARKS` is full-screen, transparent, and permanently click-through. It
//     only ever draws. Because it never takes a click, it can never come
//     between you and the button it just highlighted.
//
//   * `BAR` is small, sits near the bottom, and takes clicks and keys normally.
//
// A single window cannot be both. The earlier version toggled click-through on
// the whole window per phase, which meant the answer's own buttons became
// unclickable the moment the answer appeared — and while the bar was open, the
// full-screen window swallowed every click meant for the app underneath. The
// usual workaround is a 60fps loop polling the cursor to decide; splitting the
// window makes the question moot.

/// The full-screen drawing layer. Never focusable, never clickable.
pub const MARKS: &str = "screen-assist";
/// The small ask/answer bar. Focusable, but non-activating.
pub const BAR: &str = "screen-assist-bar";

/// The bar window's height, in logical points, before the page has measured
/// itself. Everything beyond the bar is TRANSPARENT but still part of the
/// window, and a transparent window still swallows clicks — so a window sized
/// for the tallest possible answer puts an invisible wall over the user's
/// screen. The page reports its real height and `overlay_fit` shrinks the
/// window to it.
const BAR_H: f64 = 92.0;
/// The tallest it may grow to, when an answer has a long trail of steps.
const BAR_MAX_H: f64 = 620.0;
const BAR_W: f64 = 760.0;

/// Set once the user drags the bar somewhere they want it.
///
/// After that it stays put for the rest of the session: re-centring a window
/// someone has just deliberately moved is the app arguing with them. It is not
/// persisted — a fresh launch starts at the sensible default again.
static BAR_MOVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Build both windows once, hidden.
pub fn create_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(MARKS).is_none() {
        let marks = WebviewWindowBuilder::new(
            app,
            MARKS,
            WebviewUrl::App("index.html?overlay=marks".into()),
        )
        .title("Screen Assist")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| format!("create marks layer: {e}"))?;
        // Permanent: this layer exists only to draw.
        let _ = marks.set_ignore_cursor_events(true);
        #[cfg(target_os = "macos")]
        let _ = crate::panel::make_panel(&marks, false);
        let _ = fit_to_screen(&marks);
    }

    if app.get_webview_window(BAR).is_none() {
        let bar = WebviewWindowBuilder::new(
            app,
            BAR,
            WebviewUrl::App("index.html?overlay=bar".into()),
        )
        .title("Ask AI Box")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .inner_size(BAR_W, BAR_H)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| format!("create bar: {e}"))?;
        #[cfg(target_os = "macos")]
        let _ = crate::panel::make_panel(&bar, true);
        let _ = place_bar(&bar);
    }
    Ok(())
}

/// Cover the whole of the current display.
fn fit_to_screen(win: &tauri::WebviewWindow) -> Result<(), String> {
    let monitor = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor")?;
    let _ = win.set_position(tauri::PhysicalPosition::new(
        monitor.position().x,
        monitor.position().y,
    ));
    let _ = win.set_size(*monitor.size());
    Ok(())
}

/// Sit the bar low and centred, where a HUD belongs and where it covers least.
fn place_bar(win: &tauri::WebviewWindow) -> Result<(), String> {
    let monitor = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor")?;
    let scale = monitor.scale_factor();
    let sw = monitor.size().width as f64 / scale;
    let sh = monitor.size().height as f64 / scale;
    // Its CURRENT height, not the starting one: the window is resized to fit its
    // content, so anchoring to a constant would drift further from the bottom
    // every time an answer had made it taller.
    let height = win
        .outer_size()
        .map(|s| s.height as f64 / scale)
        .unwrap_or(BAR_H);
    let x = monitor.position().x as f64 / scale + (sw - BAR_W) / 2.0;
    let y = monitor.position().y as f64 / scale + sh - height - 60.0;
    win.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Open the ask bar. `listening` starts the microphone immediately, which is
/// how the push-to-talk shortcut arrives here.
#[tauri::command]
pub fn overlay_open(app: tauri::AppHandle, with_screen: bool, listening: bool) -> Result<(), String> {
    create_overlay(&app)?;
    let bar = app.get_webview_window(BAR).ok_or("no bar")?;
    if !BAR_MOVED.load(std::sync::atomic::Ordering::Relaxed) {
        let _ = place_bar(&bar);
    }
    let _ = bar.show();
    // Key, but NOT activating. Tauri's set_focus activates the application,
    // which pulls AI Box to the front and pushes the user's work behind it —
    // the precise opposite of an overlay. `make_key` orders the panel forward
    // and hands the keyboard to its web view, leaving the frontmost app alone.
    #[cfg(target_os = "macos")]
    let _ = crate::panel::make_key(&bar);
    #[cfg(not(target_os = "macos"))]
    let _ = bar.set_focus();
    app.emit_to(
        BAR,
        "screen-assist://open",
        serde_json::json!({ "withScreen": with_screen, "listening": listening }),
    )
    .map_err(|e| e.to_string())
}

/// Draw a set of marks over the screen, or clear them when empty.
#[tauri::command]
pub fn overlay_marks(app: tauri::AppHandle, annotations: serde_json::Value) -> Result<(), String> {
    create_overlay(&app)?;
    let marks = app.get_webview_window(MARKS).ok_or("no marks layer")?;
    let empty = annotations.as_array().map(|a| a.is_empty()).unwrap_or(true);
    if empty {
        let _ = marks.hide();
    } else {
        let _ = fit_to_screen(&marks);
        // Show without focusing: this layer must never take key status away
        // from whatever the user is working in.
        let _ = marks.show();
    }
    app.emit_to(MARKS, "screen-assist://marks", annotations)
        .map_err(|e| e.to_string())
}

/// Shrink the window to the height the page actually needs.
///
/// The overlay draws a small bar at the bottom of a window that would otherwise
/// be sized for the largest answer it might ever show. The rest is transparent —
/// and a transparent window is still a window: it takes every click in that
/// region and does nothing with it, so the user cannot reach what is underneath
/// without dismissing the bar first.
///
/// The bottom edge is held still while the height changes, so the bar stays
/// where it is on screen (and where the user dragged it to) and grows upward.
#[tauri::command]
pub fn overlay_fit(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let bar = app.get_webview_window(BAR).ok_or("no bar")?;
    let scale = bar.scale_factor().unwrap_or(1.0);
    let size = bar.outer_size().map_err(|e| e.to_string())?;
    let pos = bar.outer_position().map_err(|e| e.to_string())?;

    let current = size.height as f64 / scale;
    let wanted = height.clamp(48.0, BAR_MAX_H);
    // A point or two of jitter as text reflows is not worth a window resize.
    if (current - wanted).abs() < 2.0 {
        return Ok(());
    }
    let top = pos.y as f64 / scale + (current - wanted);
    bar.set_size(tauri::LogicalSize::new(BAR_W, wanted))
        .map_err(|e| e.to_string())?;
    bar.set_position(tauri::LogicalPosition::new(pos.x as f64 / scale, top))
        .map_err(|e| e.to_string())
}

/// Take the keyboard, from wherever it currently is.
///
/// Called when the user clicks the bar. The panel does not activate the app, so
/// key status can be sitting in another application entirely — the field would
/// take the click, show no caret, and swallow every keystroke.
#[tauri::command]
pub fn overlay_take_keyboard(app: tauri::AppHandle) -> Result<(), String> {
    let bar = app.get_webview_window(BAR).ok_or("no bar")?;
    #[cfg(target_os = "macos")]
    crate::panel::make_key(&bar)?;
    #[cfg(not(target_os = "macos"))]
    let _ = bar.set_focus();
    Ok(())
}

/// The user has dragged the bar; leave it where they put it.
#[tauri::command]
pub fn overlay_bar_moved() {
    BAR_MOVED.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Let a synthetic click pass straight through the ask bar.
///
/// The bar floats over the very screen it is about to click, so a click landing
/// on it would press the assistant's own UI instead of the button underneath.
/// Hiding the bar would fix that too, but it would also take the running
/// commentary — and the Stop button — off screen at exactly the moment the user
/// most wants both. Click-through keeps the bar visible and simply makes it not
/// there as far as the mouse is concerned.
///
/// Toggled per action rather than for the whole run, so between steps the Stop
/// button is a real button again.
#[tauri::command]
pub fn overlay_pass_clicks(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    let bar = app.get_webview_window(BAR).ok_or("no bar")?;
    bar.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
    if on {
        // The window server applies this on its own clock; without the pause the
        // first click can still land on a bar that is already click-through.
        std::thread::sleep(std::time::Duration::from_millis(60));
    }
    Ok(())
}

/// Escape belongs to Screen Assist while its bar is open.
///
/// It has to be global rather than a keydown handler in the overlay: the panel
/// is non-activating, and the moment the assistant clicks something — or the
/// user does — key focus is in another app and the overlay stops hearing
/// anything at all. That is exactly when Escape matters most, whether it means
/// "stop driving my Mac" or just "close this".
///
/// Taken when the bar opens and given straight back when it closes, so the only
/// seconds it is borrowed are seconds the user is looking at the bar.
#[tauri::command]
pub fn overlay_escape(app: tauri::AppHandle, active: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    if !active {
        let _ = gs.unregister("Escape");
        // Never leave the bar deaf to the mouse because a run ended badly.
        if let Some(bar) = app.get_webview_window(BAR) {
            let _ = bar.set_ignore_cursor_events(false);
        }
        return Ok(());
    }
    // Re-registering the same shortcut is an error, not a no-op.
    let _ = gs.unregister("Escape");
    gs.on_shortcut("Escape", |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            let _ = app.emit_to(BAR, "screen-assist://escape", ());
        }
    })
    .map_err(|e| format!("Could not take over Escape: {e}"))
}

/// Dismiss everything.
#[tauri::command]
pub fn overlay_close(app: tauri::AppHandle) -> Result<(), String> {
    // Whatever route got us here, Escape goes back to the rest of the Mac.
    let _ = overlay_escape(app.clone(), false);
    if let Some(bar) = app.get_webview_window(BAR) {
        let _ = bar.hide();
    }
    if let Some(marks) = app.get_webview_window(MARKS) {
        let _ = marks.hide();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_probe_image_is_screenshot_sized_not_a_swatch() {
        let png = base64::engine::general_purpose::STANDARD
            .decode(probe_image())
            .expect("valid base64");
        let img = image::load_from_memory(&png).expect("valid png");
        assert_eq!((img.width(), img.height()), (1440, 900));
    }

    use super::*;

    #[test]
    fn voices_parse_and_rank_premium_english_first() {
        let voices = list_voices();
        assert!(!voices.is_empty(), "expected `say` to report voices");
        // Names and locales must actually be split apart, not left glued.
        for v in &voices {
            assert!(!v.name.is_empty());
            assert!(v.locale.contains('_'), "bad locale {:?} for {:?}", v.locale, v.name);
            assert!(!v.name.contains('#'));
        }
        // English before non-English.
        let first_non_en = voices.iter().position(|v| !v.locale.starts_with("en"));
        let last_en = voices.iter().rposition(|v| v.locale.starts_with("en"));
        if let (Some(f), Some(l)) = (first_non_en, last_en) {
            assert!(l < f, "English voices must come first");
        }
        // Samantha ships on every Mac, so she is a safe fixture.
        assert!(voices.iter().any(|v| v.name == "Samantha"), "Samantha missing");
    }

    #[test]
    fn the_automatic_english_voice_is_not_a_1980s_joke() {
        let voices = list_voices();
        // No novelty synthesiser survives the filter at all.
        for name in ["Albert", "Zarvox", "Bubbles", "Bad News", "Fred"] {
            assert!(
                !voices.iter().any(|v| bare_name(&v.name) == name),
                "{name} should have been filtered out"
            );
        }
        // And the first English voice — the one picked when nobody has chosen —
        // is a real one. Alphabetical ordering used to hand this to Albert.
        let first_en = voices
            .iter()
            .find(|v| v.locale.starts_with("en"))
            .expect("some English voice");
        assert!(first_en.classic, "the default English voice must be a real one");
    }

    #[test]
    fn quality_is_read_from_the_name_apple_gives() {
        let v = |n: &str| Voice {
            name: n.into(),
            locale: "en_US".into(),
            classic: CLASSIC.contains(&bare_name(n)),
            quality: if n.contains("(Premium)") {
                "premium".into()
            } else if n.contains("(Enhanced)") {
                "enhanced".into()
            } else {
                "default".into()
            },
        };
        assert_eq!(v("Ava (Premium)").quality, "premium");
        assert_eq!(v("Zoe (Enhanced)").quality, "enhanced");
        assert_eq!(v("Samantha").quality, "default");
    }
}

// ---- which models can do this ---------------------------------------------

/// A model the assistant can use, with what it can actually perceive.
///
/// Not a hardcoded list: read from OpenRouter at runtime and filtered by
/// declared modalities, so a better model next month shows up on its own. The
/// two tiers matter — a typed question only needs eyes, a spoken one needs ears
/// too, and roughly ten times as many models have eyes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistModel {
    pub id: String,
    pub name: String,
    pub created: u64,
    /// Accepts a screenshot.
    pub sees: bool,
    /// Accepts microphone audio, so speech needs no separate transcription step.
    pub hears: bool,
    /// USD per million input tokens, for the picker's cost hint.
    pub prompt_price: f64,
}

/// Models that can do the whole job, newest first.
///
/// All three capabilities are required, not preferred. Screen Assist shows a
/// screenshot (image in), takes the question as held-key audio (audio in), and
/// acts through tool calls — a model missing any one of those does not half
/// work, it fails at the moment the user tries the thing it cannot do. Better
/// to leave it out of the menu than to let someone pick it and find out.
#[tauri::command]
pub async fn list_assist_models(params: crate::video::KeyParams) -> Result<Vec<AssistModel>, String> {
    let client = reqwest::Client::new();
    let mut req = client
        .get("https://openrouter.ai/api/v1/models")
        .header("HTTP-Referer", "https://ai-box.local")
        .header("X-Title", "AI Box");
    if !params.api_key.trim().is_empty() {
        req = req.header("Authorization", format!("Bearer {}", params.api_key.trim()));
    }
    let resp = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    if !resp.status().is_success() {
        let s = resp.status();
        return Err(format!("Model list failed: HTTP {s}"));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let has = |arch: &serde_json::Value, key: &str, want: &str| -> bool {
        arch[key]
            .as_array()
            .map(|a| a.iter().any(|x| x.as_str() == Some(want)))
            .unwrap_or(false)
    };
    let mut models: Vec<AssistModel> = json["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            let arch = &m["architecture"];
            let id = m["id"].as_str().unwrap_or("").to_string();
            // Must read a screenshot and answer in text. `:batch` variants
            // answer minutes later, which is useless for a live overlay.
            if id.is_empty() || id.ends_with(":batch") {
                return None;
            }
            if !has(arch, "input_modalities", "image")
                || !has(arch, "input_modalities", "audio")
                || !has(arch, "output_modalities", "text")
            {
                return None;
            }
            // Acting is tool calls. A model that cannot make them can still
            // describe a screen, but it can never do anything on it.
            if !has(m, "supported_parameters", "tools") {
                return None;
            }
            Some(AssistModel {
                id,
                name: m["name"].as_str().unwrap_or("").to_string(),
                created: m["created"].as_u64().unwrap_or(0),
                sees: true,
                hears: true,
                prompt_price: m["pricing"]["prompt"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0),
            })
        })
        // A negative price is OpenRouter's marker for a routing pseudo-model
        // (auto-beta); it has no fixed capabilities to reason about.
        .filter(|m| m.prompt_price >= 0.0)
        .collect();
    models.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(models)
}

/// A screenshot-shaped PNG for the model check.
///
/// 1440×900 of plausible window furniture. The SIZE is the point: a real
/// screenshot costs about 1,500 tokens, and models exist that answer a small
/// image instantly and then stall for minutes on a real one. A check that
/// cannot tell those apart certifies a model that cannot do the job.
fn probe_image() -> String {
    let mut img = image::RgbImage::from_pixel(1440, 900, image::Rgb([246, 246, 248]));
    let mut paint = |img: &mut image::RgbImage, x: u32, y: u32, w: u32, h: u32, c: [u8; 3]| {
        for dy in 0..h {
            for dx in 0..w {
                if x + dx < 1440 && y + dy < 900 {
                    img.put_pixel(x + dx, y + dy, image::Rgb(c));
                }
            }
        }
    };
    paint(&mut img, 0, 0, 1440, 56, [58, 64, 86]);      // title bar
    paint(&mut img, 0, 56, 300, 844, [38, 42, 58]);     // sidebar
    paint(&mut img, 1080, 780, 260, 64, [80, 110, 230]); // a button
    paint(&mut img, 360, 140, 620, 40, [225, 228, 236]); // a text field
    let mut png = std::io::Cursor::new(Vec::new());
    let _ = image::DynamicImage::ImageRgb8(img).write_to(&mut png, image::ImageFormat::Png);
    base64::engine::general_purpose::STANDARD.encode(png.into_inner())
}

/// A real spoken question, synthesised by macOS, as 16 kHz mono WAV.
///
/// Silence would prove only that the request shape was accepted. A question the
/// model has to hear and answer proves it has ears.
fn probe_audio() -> Option<String> {
    let dir = std::env::temp_dir();
    let aiff = dir.join(format!("ai-box-probe-{}.aiff", uuid::Uuid::new_v4()));
    let wav = aiff.with_extension("wav");
    let spoke = std::process::Command::new("/usr/bin/say")
        .args([
            "-o".as_ref(),
            aiff.as_os_str(),
            "Describe this screen in one short sentence.".as_ref(),
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let converted = spoke
        && std::process::Command::new("/usr/bin/afconvert")
            .args([
                "-f".as_ref(),
                "WAVE".as_ref(),
                "-d".as_ref(),
                "LEI16@16000".as_ref(),
                "-c".as_ref(),
                "1".as_ref(),
                aiff.as_os_str(),
                wav.as_os_str(),
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    let data = if converted { std::fs::read(&wav).ok() } else { None };
    let _ = std::fs::remove_file(&aiff);
    let _ = std::fs::remove_file(&wav);
    data.map(|b| base64::engine::general_purpose::STANDARD.encode(b))
}

/// The screenshot and spoken question a model check is run with.
///
/// Only the ASSETS live here. The check itself runs in the frontend, through the
/// same prompt builder, the same tools and the same parser as a real question —
/// a check that reimplements the thing it is checking ends up testing its own
/// copy, and the copies drift. That is not hypothetical: a simplified check
/// asked one thing in text and another in audio, and threw out a good model for
/// answering the audio.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeAssets {
    /// base64 PNG, roughly the token cost of a real screenshot.
    pub image: String,
    /// base64 16 kHz mono WAV, or none if `say` is unavailable.
    pub audio: Option<String>,
}

#[tauri::command]
pub fn probe_assets() -> ProbeAssets {
    ProbeAssets {
        image: probe_image(),
        audio: probe_audio(),
    }
}

/// Models already on this Mac that could actually do this job.
///
/// Ollama reports what each model can do, so this asks rather than guessing from
/// the name — "qwen2.5" and "qwen2.5vl" differ by two characters and by whether
/// there are eyes behind them.
///
/// Audio is not required here, unlike the hosted list: essentially no local
/// model takes audio, so requiring it would empty the menu. A local model means
/// typed questions, which the frontend says plainly.
#[tauri::command]
pub async fn list_local_assist_models(base_url: String) -> Result<Vec<String>, String> {
    let root = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_string();
    let client = reqwest::Client::new();
    let tags: serde_json::Value = client
        .get(format!("{root}/api/tags"))
        .send()
        .await
        .map_err(|e| format!("Could not reach Ollama at {root}: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let names: Vec<String> = tags["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let mut usable = Vec::new();
    for name in names {
        let shown: serde_json::Value = match client
            .post(format!("{root}/api/show"))
            .json(&serde_json::json!({ "model": name }))
            .send()
            .await
        {
            Ok(r) => match r.json().await {
                Ok(v) => v,
                // An older Ollama that does not report capabilities is not a
                // reason to hide every local model; let it through and let the
                // frontend's warning do the work.
                Err(_) => {
                    usable.push(name);
                    continue;
                }
            },
            Err(_) => continue,
        };
        let caps = shown["capabilities"].as_array().cloned().unwrap_or_default();
        if caps.is_empty() {
            usable.push(name);
            continue;
        }
        let can = |want: &str| caps.iter().any(|c| c.as_str() == Some(want));
        if can("vision") && can("tools") {
            usable.push(name);
        }
    }
    Ok(usable)
}

// ---- the global hotkey ----------------------------------------------------

/// Bind (or rebind) the shortcut that summons the ask bar.
///
/// Unregisters everything first so rebinding cannot leave the previous
/// combination live — two hotkeys opening the same overlay is the kind of bug
/// that only shows up after a user has changed the setting twice.
///
/// The `shift` variant of the same key opens with the screen attached, so the
/// two modes are one muscle memory apart: ask, or ask about *this*.
#[tauri::command]
pub fn set_assist_hotkey(
    app: tauri::AppHandle,
    accelerator: String,
    push_to_talk: bool,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let accelerator = accelerator.trim().to_string();
    if accelerator.is_empty() {
        return Ok(()); // empty means "no hotkey", not an error
    }
    let with_screen = format!("Shift+{accelerator}");

    // Push-to-talk: the same modifier with M. Held down it records, released it
    // sends — so asking out loud is one gesture rather than open, click, speak,
    // click. Derived from the chosen accelerator so both shortcuts always share
    // a modifier and stay one muscle memory apart.
    let talk = accelerator
        .rsplit_once('+')
        .map(|(mods, _)| format!("{mods}+M"))
        .unwrap_or_else(|| "Alt+M".into());

    // Compare parsed shortcuts, never their Display strings: `Shortcut`'s
    // formatting is not the accelerator syntax it was parsed from ("alt+KeyM"
    // vs "Alt+M"), so a string compare here silently never matched and every
    // press fell through to the plain open-the-bar branch.
    let talk_shortcut: tauri_plugin_global_shortcut::Shortcut = talk
        .parse()
        .map_err(|e| format!("Could not parse {talk}: {e}"))?;
    let handler = move |app: &tauri::AppHandle, shortcut: &tauri_plugin_global_shortcut::Shortcut, event: tauri_plugin_global_shortcut::ShortcutEvent| {
        let pressed = event.state() == ShortcutState::Pressed;
        let is_talk = *shortcut == talk_shortcut;

        // Hold to talk, release to send — for the dedicated talk key, and for
        // the main shortcut too when the user has asked for that. Holding a key
        // you already press to open the bar is the shortest path there is from
        // "I have a question" to having asked it.
        if is_talk || push_to_talk {
            if pressed {
                let with_screen = is_talk || shortcut.mods.shift();
                let _ = overlay_open(app.clone(), with_screen, true);
            } else {
                let _ = app.emit_to(BAR, "screen-assist://talk-end", ());
            }
            return;
        }
        // Otherwise the plain shortcut just opens the bar for typing; fire on
        // press only, or the key-up would immediately reopen it.
        if pressed {
            let _ = overlay_open(app.clone(), shortcut.mods.shift(), false);
        }
    };

    gs.on_shortcuts(
        [accelerator.as_str(), with_screen.as_str(), talk.as_str()],
        handler,
    )
    .map_err(|e| format!("Could not bind {accelerator}: {e}"))?;
    Ok(())
}

// ---- handing an exchange to Agentic Chat -----------------------------------

/// Record an overlay exchange in the main window's chat history, optionally
/// bringing that window forward to carry on there.
///
/// The overlay deliberately keeps no history of its own. Chat already has
/// sessions, a sidebar, search and conflict-free sync between devices, and a
/// screen question is just a message with an image attached — a second store
/// would duplicate all of that and agree with it only by luck.
///
/// The main window does the writing, not this one. Both windows share an origin
/// and therefore a localStorage, so if the overlay wrote sessions directly the
/// main window's next save would clobber it. One writer, always.
#[tauri::command]
pub fn assist_to_chat(
    app: tauri::AppHandle,
    question: String,
    answer: String,
    saw_screen: bool,
    focus: bool,
) -> Result<(), String> {
    app.emit_to(
        "main",
        "screen-assist://exchange",
        serde_json::json!({
            "question": question,
            "answer": answer,
            "sawScreen": saw_screen,
            "focus": focus,
        }),
    )
    .map_err(|e| e.to_string())?;

    if focus {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
        let _ = overlay_close(app);
    }
    Ok(())
}
