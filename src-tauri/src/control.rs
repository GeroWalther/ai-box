// Using the Mac: the hands behind Screen Assist.
//
// Screen Assist could already see the screen and talk about it. This is what
// lets it act on what it sees — move the pointer, click, type, scroll, and flip
// the system switches a person would reach for in Control Centre.
//
// Everything here posts REAL events at the HID level rather than scripting a
// particular app. That is deliberate: a click synthesised this way is
// indistinguishable from the user's own, so it works in every app — native,
// Electron, a web page, a game — without per-app automation support. The price
// is that macOS requires Accessibility permission, which is why `trusted()`
// exists and why the frontend checks it before the first action rather than
// letting clicks silently vanish into a permission check the user never saw.
//
// Coordinates crossing this boundary are always SCREEN POINTS (not pixels, not
// the model's normalised space) with the origin at the top-left of the main
// display. The frontend owns that conversion because it is the side that knows
// the display size.

use core_foundation::base::TCFType;
use core_foundation::dictionary::CFDictionary;
use core_foundation::boolean::CFBoolean;
use core_foundation::string::CFString;
use core_graphics::display::CGPoint;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
    ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use foreign_types::ForeignType;
use serde::Serialize;
use std::ffi::c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

// core-graphics exposes mouse and keyboard constructors but not the scroll one,
// so it is declared here against the same framework the crate already links.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateScrollWheelEvent2(
        source: core_graphics::sys::CGEventSourceRef,
        units: u32,
        wheel_count: u32,
        wheel1: i32,
        wheel2: i32,
        wheel3: i32,
    ) -> core_graphics::sys::CGEventRef;
}

/// A pixel-unit scroll event, `wheel1` vertical and `wheel2` horizontal.
fn scroll_event(src: &CGEventSource, wheel1: i32, wheel2: i32) -> Result<CGEvent, String> {
    unsafe {
        let raw = CGEventCreateScrollWheelEvent2(
            src.as_ptr(),
            ScrollEventUnit::PIXEL,
            2,
            wheel1,
            wheel2,
            0,
        );
        if raw.is_null() {
            return Err("could not build a scroll event".into());
        }
        Ok(CGEvent::from_ptr(raw))
    }
}

/// Is AI Box allowed to drive the mouse and keyboard?
///
/// `prompt` shows macOS's own "open System Settings" dialog. It is only ever
/// passed when the user has just asked for something that needs the permission —
/// an unprompted dialog on launch is how apps train people to click Deny.
fn trusted(prompt: bool) -> bool {
    unsafe {
        if !prompt {
            // Checking without the option dictionary never prompts.
            return AXIsProcessTrustedWithOptions(std::ptr::null());
        }
        let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
        let opts = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        AXIsProcessTrustedWithOptions(opts.as_CFTypeRef() as *const c_void)
    }
}

const NO_ACCESS: &str = "AI Box is not allowed to control your Mac yet. Open System Settings → \
Privacy & Security → Accessibility, switch AI Box on, then try again.";

fn require_access() -> Result<(), String> {
    if trusted(false) {
        Ok(())
    } else {
        Err(NO_ACCESS.into())
    }
}

/// True if AI Box can drive the Mac right now.
#[tauri::command]
pub fn control_trusted() -> bool {
    trusted(false)
}

/// Ask macOS to show its Accessibility prompt. Returns the state *before* the
/// user answers — the dialog is not modal to us, so a false here means "we just
/// asked", not "they said no".
#[tauri::command]
pub fn control_request_access() -> bool {
    trusted(true)
}

fn source() -> Result<CGEventSource, String> {
    // HIDSystemState makes the events look like they came from real hardware,
    // which matters to apps that filter synthetic input.
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "could not open an event source".to_string())
}

fn post(event: CGEvent) {
    event.post(CGEventTapLocation::HID);
}

/// Settle time after an event, so the app under the pointer has repainted before
/// the next screenshot. Without it the model looks at the screen as it was
/// *before* its own click and concludes nothing happened.
fn settle(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

fn button_for(name: &str) -> (CGMouseButton, CGEventType, CGEventType) {
    match name {
        "right" => (
            CGMouseButton::Right,
            CGEventType::RightMouseDown,
            CGEventType::RightMouseUp,
        ),
        _ => (
            CGMouseButton::Left,
            CGEventType::LeftMouseDown,
            CGEventType::LeftMouseUp,
        ),
    }
}

/// Move the pointer, visibly.
///
/// The move is a separate posted event rather than a coordinate on the click,
/// because many apps only show hover state — and only accept the click — after a
/// mouse-moved event has reached them.
fn move_to(src: &CGEventSource, p: CGPoint) -> Result<(), String> {
    let ev = CGEvent::new_mouse_event(src.clone(), CGEventType::MouseMoved, p, CGMouseButton::Left)
        .map_err(|_| "could not build a mouse event".to_string())?;
    post(ev);
    Ok(())
}

#[tauri::command]
pub fn control_move(x: f64, y: f64) -> Result<String, String> {
    require_access()?;
    let src = source()?;
    move_to(&src, CGPoint::new(x, y))?;
    settle(40);
    Ok(format!("Moved the pointer to {x:.0}, {y:.0}."))
}

/// Click at a point. `count` 2 is a double-click, 3 a triple-click.
#[tauri::command]
pub fn control_click(x: f64, y: f64, button: String, count: i64) -> Result<String, String> {
    require_access()?;
    let src = source()?;
    let p = CGPoint::new(x, y);
    let (btn, down, up) = button_for(&button);
    move_to(&src, p)?;
    settle(60);

    let clicks = count.clamp(1, 3);
    for n in 1..=clicks {
        for kind in [down, up] {
            let ev = CGEvent::new_mouse_event(src.clone(), kind, p, btn)
                .map_err(|_| "could not build a mouse event".to_string())?;
            // A double-click is not two clicks: it is one click with a click
            // state of 2. Apps read this field, and without it the target sees
            // two separate single clicks and never opens anything.
            ev.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, n);
            post(ev);
        }
        if n < clicks {
            settle(40);
        }
    }
    settle(260);

    let what = match (button.as_str(), clicks) {
        ("right", _) => "Right-clicked".to_string(),
        (_, 2) => "Double-clicked".to_string(),
        (_, 3) => "Triple-clicked".to_string(),
        _ => "Clicked".to_string(),
    };
    Ok(format!("{what} at {x:.0}, {y:.0}."))
}

/// Press at one point, drag to another, release — for sliders, scrollbars,
/// selections and moving things around.
#[tauri::command]
pub fn control_drag(x1: f64, y1: f64, x2: f64, y2: f64) -> Result<String, String> {
    require_access()?;
    let src = source()?;
    let from = CGPoint::new(x1, y1);
    let to = CGPoint::new(x2, y2);

    move_to(&src, from)?;
    settle(60);
    let down = CGEvent::new_mouse_event(src.clone(), CGEventType::LeftMouseDown, from, CGMouseButton::Left)
        .map_err(|_| "could not build a mouse event".to_string())?;
    post(down);
    settle(60);

    // Dragged in steps: a single jump to the destination reads as a teleport and
    // sliders, which track movement rather than endpoints, ignore it.
    const STEPS: i32 = 14;
    for i in 1..=STEPS {
        let t = i as f64 / STEPS as f64;
        let p = CGPoint::new(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
        let ev = CGEvent::new_mouse_event(src.clone(), CGEventType::LeftMouseDragged, p, CGMouseButton::Left)
            .map_err(|_| "could not build a mouse event".to_string())?;
        post(ev);
        settle(12);
    }

    let up = CGEvent::new_mouse_event(src.clone(), CGEventType::LeftMouseUp, to, CGMouseButton::Left)
        .map_err(|_| "could not build a mouse event".to_string())?;
    post(up);
    settle(260);
    Ok(format!("Dragged from {x1:.0}, {y1:.0} to {x2:.0}, {y2:.0}."))
}

/// Scroll at a point. Positive `dy` scrolls down the page, matching how a person
/// describes it rather than how the wheel signs it.
#[tauri::command]
pub fn control_scroll(x: f64, y: f64, dx: f64, dy: f64) -> Result<String, String> {
    require_access()?;
    let src = source()?;
    move_to(&src, CGPoint::new(x, y))?;
    settle(40);

    // Delivered in chunks so momentum-scrolling views keep up, and so a large
    // request doesn't fly past the target in a single frame.
    let steps = (dy.abs().max(dx.abs()) / 60.0).ceil().max(1.0) as i32;
    for _ in 0..steps {
        let ev = scroll_event(
            &src,
            (-dy / steps as f64) as i32,
            (-dx / steps as f64) as i32,
        )?;
        post(ev);
        settle(24);
    }
    settle(220);
    Ok(format!("Scrolled {} at {x:.0}, {y:.0}.", if dy >= 0.0 { "down" } else { "up" }))
}

/// Type text literally.
///
/// Sent as a unicode string on a synthetic key event rather than as keycodes:
/// keycodes are laid out per keyboard, so "ü" or "@" on a German layout would
/// land as something else entirely. This types the characters themselves.
#[tauri::command]
pub fn control_type(text: String) -> Result<String, String> {
    require_access()?;
    if text.is_empty() {
        return Ok("Nothing to type.".into());
    }
    let src = source()?;
    // Chunked: CGEventKeyboardSetUnicodeString truncates long strings, and a
    // burst of hundreds of characters outruns some text fields.
    for chunk in text.chars().collect::<Vec<_>>().chunks(18) {
        let s: String = chunk.iter().collect();
        for down in [true, false] {
            let ev = CGEvent::new_keyboard_event(src.clone(), 0, down)
                .map_err(|_| "could not build a key event".to_string())?;
            ev.set_string(&s);
            post(ev);
        }
        settle(16);
    }
    settle(200);
    Ok(format!("Typed {:?}.", truncate(&text, 60)))
}

/// A key combination, written the way a person would: "cmd+s", "return",
/// "cmd+shift+4", "escape".
#[tauri::command]
pub fn control_key(combo: String) -> Result<String, String> {
    require_access()?;
    let mut flags = CGEventFlags::CGEventFlagNull;
    let mut code: Option<u16> = None;

    for part in combo.split(['+', '-']).map(|p| p.trim().to_lowercase()) {
        match part.as_str() {
            "" => continue,
            "cmd" | "command" | "meta" | "super" => flags |= CGEventFlags::CGEventFlagCommand,
            "shift" => flags |= CGEventFlags::CGEventFlagShift,
            "alt" | "option" | "opt" => flags |= CGEventFlags::CGEventFlagAlternate,
            "ctrl" | "control" => flags |= CGEventFlags::CGEventFlagControl,
            "fn" | "function" => flags |= CGEventFlags::CGEventFlagSecondaryFn,
            other => code = keycode(other),
        }
    }
    let code = code.ok_or_else(|| format!("I don't know the key {combo:?}."))?;
    let src = source()?;
    for down in [true, false] {
        let ev = CGEvent::new_keyboard_event(src.clone(), code, down)
            .map_err(|_| "could not build a key event".to_string())?;
        ev.set_flags(flags);
        post(ev);
        settle(16);
    }
    settle(240);
    Ok(format!("Pressed {combo}."))
}

/// US-layout virtual keycodes for the keys worth naming.
///
/// Letters and digits are here for shortcuts only — anything the user wants
/// *typed* goes through `control_type`, which is layout-independent. A shortcut
/// is defined by its physical key ("⌘S" is the S key wherever the layout puts
/// it), so the US table is the right one even on a German keyboard.
fn keycode(name: &str) -> Option<u16> {
    let letters = "asdfhgzxcv bqweryt123465=97-80]ou[ip lj'k;\\,/nm.";
    if name.len() == 1 {
        let c = name.chars().next().unwrap();
        if let Some(i) = letters.find(c) {
            if c != ' ' {
                return Some(i as u16);
            }
        }
    }
    Some(match name {
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "forwarddelete" => 117,
        "f1" => 122,
        "f2" => 120,
        "f3" => 99,
        "f4" => 118,
        "f5" => 96,
        "f6" => 97,
        "f7" => 98,
        "f8" => 100,
        "f9" => 101,
        "f10" => 109,
        "f11" => 103,
        "f12" => 111,
        _ => return None,
    })
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

// ---- the switches a person reaches for -------------------------------------

/// Where the cursor is now, so the frontend can put it back after acting.
#[derive(Serialize)]
pub struct Pointer {
    pub x: f64,
    pub y: f64,
}

fn sh(program: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("run {program}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("{program} failed")
        } else {
            err
        })
    }
}

fn osa(script: &str) -> Result<String, String> {
    sh("/usr/bin/osascript", &["-e", script])
}

/// blueutil, but with the one failure that actually happens explained.
///
/// macOS 26 puts the Bluetooth API behind a privacy permission. blueutil does
/// not ask for it — it aborts — and the raw "Received abort signal" it prints is
/// no use to anyone. The permission belongs to AI Box, since it is the app
/// responsible for the process it spawned.
fn bt_sh(bin: &str, args: &[&str]) -> Result<String, String> {
    sh(bin, args).map_err(|e| {
        if e.contains("abort") || e.is_empty() || e.contains("blueutil failed") {
            "macOS hasn't given AI Box access to Bluetooth yet. Open System Settings → \
Privacy & Security → Bluetooth and switch AI Box on."
                .to_string()
        } else {
            e
        }
    })
}

/// blueutil, wherever Homebrew put it.
///
/// macOS ships no supported way to turn Bluetooth on or off from a script —
/// there is no `networksetup` equivalent, and the old `defaults write` trick
/// stopped working years ago. blueutil is the one tool that does it cleanly, so
/// when it is missing the honest answer is to say so and offer to install it,
/// rather than clicking blindly through Control Centre.
fn blueutil() -> Option<String> {
    for p in [
        "/opt/homebrew/bin/blueutil",
        "/usr/local/bin/blueutil",
        "/opt/local/bin/blueutil",
    ] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    None
}

fn brew() -> Option<String> {
    for p in ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    None
}

/// The Wi-Fi interface, which is not always en0 (it is en1 on Macs with
/// Ethernet, and moves again on a Mac Pro).
fn wifi_device() -> String {
    let listing = sh("/usr/sbin/networksetup", &["-listallhardwareports"]).unwrap_or_default();
    let mut lines = listing.lines();
    while let Some(line) = lines.next() {
        if line.contains("Wi-Fi") || line.contains("AirPort") {
            for next in lines.by_ref() {
                if let Some(dev) = next.strip_prefix("Device: ") {
                    return dev.trim().to_string();
                }
            }
        }
    }
    "en0".into()
}

fn wants_on(value: &str) -> Result<bool, String> {
    match value.trim().to_lowercase().as_str() {
        "on" | "true" | "yes" | "enable" | "enabled" | "1" => Ok(true),
        "off" | "false" | "no" | "disable" | "disabled" | "0" => Ok(false),
        other => Err(format!("Say on or off, not {other:?}.")),
    }
}

/// One of the system switches, by name. Returns the sentence to report back.
#[tauri::command]
pub fn control_system(action: String, value: String) -> Result<String, String> {
    match action.as_str() {
        "bluetooth" => {
            let Some(bin) = blueutil() else {
                return Err(
                    "Bluetooth needs the `blueutil` helper, which isn't installed. Ask me to \
install it and I'll run `brew install blueutil` — it takes a few seconds."
                        .into(),
                );
            };
            let state = if value.trim().eq_ignore_ascii_case("toggle") {
                bt_sh(&bin, &["-p"])?.trim() != "1"
            } else {
                wants_on(&value)?
            };
            bt_sh(&bin, &["-p", if state { "1" } else { "0" }])?;
            Ok(format!("Bluetooth is {}.", if state { "on" } else { "off" }))
        }
        "install_bluetooth_helper" => {
            let Some(brew) = brew() else {
                return Err("Homebrew isn't installed, so I can't install blueutil. \
Install Homebrew from brew.sh first."
                    .into());
            };
            sh(&brew, &["install", "blueutil"])?;
            if blueutil().is_some() {
                Ok("blueutil is installed — I can switch Bluetooth on and off now.".into())
            } else {
                Err("The install ran but blueutil still isn't there.".into())
            }
        }
        "wifi" => {
            let dev = wifi_device();
            let state = if value.trim().eq_ignore_ascii_case("toggle") {
                let now = sh("/usr/sbin/networksetup", &["-getairportpower", &dev])?;
                !now.to_lowercase().contains(": on")
            } else {
                wants_on(&value)?
            };
            sh(
                "/usr/sbin/networksetup",
                &["-setairportpower", &dev, if state { "on" } else { "off" }],
            )?;
            Ok(format!("Wi-Fi is {}.", if state { "on" } else { "off" }))
        }
        "volume" => {
            let n: i64 = value
                .trim()
                .parse()
                .map_err(|_| format!("Volume should be 0–100, not {value:?}."))?;
            let n = n.clamp(0, 100);
            osa(&format!("set volume output volume {n}"))?;
            if n > 0 {
                osa("set volume without output muted")?;
            }
            Ok(format!("Volume is at {n}%."))
        }
        "mute" => {
            let on = wants_on(&value)?;
            osa(&format!(
                "set volume {} output muted",
                if on { "with" } else { "without" }
            ))?;
            Ok(if on { "Muted." } else { "Unmuted." }.into())
        }
        "appearance" => {
            let dark = match value.trim().to_lowercase().as_str() {
                "dark" => true,
                "light" => false,
                "toggle" => {
                    let now = osa(
                        "tell application \"System Events\" to tell appearance preferences to get dark mode",
                    )?;
                    !now.trim().eq_ignore_ascii_case("true")
                }
                other => return Err(format!("Say light or dark, not {other:?}.")),
            };
            osa(&format!(
                "tell application \"System Events\" to tell appearance preferences to set dark mode to {dark}"
            ))?;
            Ok(format!("Switched to {} mode.", if dark { "dark" } else { "light" }))
        }
        "open_app" => {
            let name = value.trim();
            if name.is_empty() {
                return Err("Which app?".into());
            }
            sh("/usr/bin/open", &["-a", name])?;
            Ok(format!("Opened {name}."))
        }
        "quit_app" => {
            let name = value.trim();
            if name.is_empty() {
                return Err("Which app?".into());
            }
            // `quit` rather than a kill: an app with unsaved work gets to put up
            // its own save dialog instead of losing it.
            osa(&format!("tell application \"{name}\" to quit"))?;
            Ok(format!("Asked {name} to quit."))
        }
        "open_url" => {
            let url = value.trim();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("Only http and https links.".into());
            }
            sh("/usr/bin/open", &[url])?;
            Ok(format!("Opened {url}."))
        }
        "lock" => {
            sh("/usr/bin/pmset", &["displaysleepnow"])?;
            Ok("Screen off.".into())
        }
        "sleep" => {
            osa("tell application \"System Events\" to sleep")?;
            Ok("Going to sleep.".into())
        }
        other => Err(format!("I don't know the system action {other:?}.")),
    }
}

/// What the switches say right now, so the model can answer "is Bluetooth on?"
/// without clicking anything, and knows the starting state before it flips one.
#[tauri::command]
pub fn control_status() -> serde_json::Value {
    let bluetooth = match blueutil() {
        Some(bin) => match bt_sh(&bin, &["-p"]) {
            Ok(v) if v.trim() == "1" => "on",
            Ok(_) => "off",
            // Said plainly, because the model needs to relay it rather than
            // guess: this is a permission the user has to grant, not a fault.
            Err(_) => "unreadable — AI Box needs Bluetooth permission",
        },
        None => "helper not installed",
    };
    let wifi = match sh("/usr/sbin/networksetup", &["-getairportpower", &wifi_device()]) {
        Ok(v) if v.to_lowercase().contains(": on") => "on",
        Ok(_) => "off",
        Err(_) => "unknown",
    };
    let volume = sh("/usr/bin/osascript", &["-e", "output volume of (get volume settings)"])
        .unwrap_or_else(|_| "unknown".into());
    let dark = osa("tell application \"System Events\" to tell appearance preferences to get dark mode")
        .unwrap_or_else(|_| "unknown".into());
    let front = osa(
        "tell application \"System Events\" to get name of first application process whose frontmost is true",
    )
    .unwrap_or_default();

    serde_json::json!({
        "bluetooth": bluetooth,
        "wifi": wifi,
        "volume": volume,
        "appearance": if dark.trim().eq_ignore_ascii_case("true") { "dark" } else { "light" },
        "frontmostApp": front,
        "canControl": trusted(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_switch_words() {
        assert_eq!(wants_on("On").unwrap(), true);
        assert_eq!(wants_on("disable").unwrap(), false);
        assert!(wants_on("maybe").is_err());
    }

    #[test]
    fn knows_the_keys_that_matter() {
        assert_eq!(keycode("s"), Some(1));
        assert_eq!(keycode("return"), Some(36));
        assert_eq!(keycode("escape"), Some(53));
        assert_eq!(keycode("f5"), Some(96));
        assert_eq!(keycode("nonsense"), None);
    }

    #[test]
    fn truncates_on_characters_not_bytes() {
        assert_eq!(truncate("äöü", 3), "äöü");
        assert_eq!(truncate("äöüx", 3), "äöü…");
    }
}
