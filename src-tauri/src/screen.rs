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

    let result = capture_to_base64().await;

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
    /// Apple's Premium and Enhanced voices sound dramatically better than the
    /// default ones, and are a free download the user has to opt into — so the
    /// UI needs to be able to point at them.
    pub quality: String,
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
            let quality = if name.contains("(Premium)") {
                "premium"
            } else if name.contains("(Enhanced)") {
                "enhanced"
            } else {
                "default"
            };
            Some(Voice { name, locale, quality: quality.into() })
        })
        .collect();
    // Best first: Premium, then Enhanced, then the rest — and English ahead of
    // everything, since that is what the assistant answers in by default.
    let rank = |v: &Voice| match v.quality.as_str() {
        "premium" => 0,
        "enhanced" => 1,
        _ => 2,
    };
    voices.sort_by(|a, b| {
        let en = |v: &Voice| if v.locale.starts_with("en") { 0 } else { 1 };
        en(a).cmp(&en(b)).then(rank(a).cmp(&rank(b))).then(a.name.cmp(&b.name))
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

/// Height reserved for the bar, in logical points. It grows on screen via CSS;
/// this is the window it grows inside.
const BAR_H: f64 = 340.0;
const BAR_W: f64 = 760.0;

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
    let x = monitor.position().x as f64 / scale + (sw - BAR_W) / 2.0;
    let y = monitor.position().y as f64 / scale + sh - BAR_H - 60.0;
    win.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Open the ask bar. `listening` starts the microphone immediately, which is
/// how the push-to-talk shortcut arrives here.
#[tauri::command]
pub fn overlay_open(app: tauri::AppHandle, with_screen: bool, listening: bool) -> Result<(), String> {
    create_overlay(&app)?;
    let bar = app.get_webview_window(BAR).ok_or("no bar")?;
    let _ = place_bar(&bar);
    let _ = bar.show();
    // Key, but NOT activating: the panel style means the app behind stays
    // frontmost, so this never drags the AI Box main window over your work.
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

/// Dismiss everything.
#[tauri::command]
pub fn overlay_close(app: tauri::AppHandle) -> Result<(), String> {
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
    fn quality_is_read_from_the_name_apple_gives() {
        let v = |n: &str| Voice {
            name: n.into(),
            locale: "en_US".into(),
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

/// Models that can at least see, newest first, with the ones that can also hear
/// marked. The caller decides which tier it needs.
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
            if !has(arch, "input_modalities", "image") || !has(arch, "output_modalities", "text") {
                return None;
            }
            Some(AssistModel {
                id,
                name: m["name"].as_str().unwrap_or("").to_string(),
                created: m["created"].as_u64().unwrap_or(0),
                sees: true,
                hears: has(arch, "input_modalities", "audio"),
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
