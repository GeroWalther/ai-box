// Turning a Tauri window into a macOS panel that never steals focus.
//
// The problem this solves: showing and focusing an ordinary NSWindow activates
// the whole application, and macOS then orders EVERY window of that app to the
// front. So opening a small assistant bar dragged the entire AI Box main window
// over whatever the user was actually looking at — the precise opposite of an
// overlay.
//
// The fix is the one Spotlight itself uses: NSWindowStyleMaskNonactivatingPanel,
// which lets a window take clicks and key events without activating its app.
// That style is only honoured on an NSPanel, and Tauri builds NSWindows, so the
// live object's class is swapped. This is sound in the one narrow case that
// matters here: NSPanel declares no additional instance variables over NSWindow,
// so the existing allocation is already the right size and layout, and the swap
// only changes which method table it dispatches through. It is what every
// Tauri/Electron spotlight-alike does, and it is why no third-party crate is
// needed for it.

#![cfg(target_os = "macos")]

use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use std::sync::OnceLock;

/// `NSWindowStyleMaskNonactivatingPanel`. AppKit defines it as `1 << 7` but
/// exposes no constant for it outside NSPanel's own header.
const NONACTIVATING_PANEL: usize = 1 << 7;

/// `NSStatusWindowLevel` — above normal and floating windows, below the screen
/// saver. High enough to sit over a full-screen editor, not so high that it
/// covers system alerts the user needs to answer.
const STATUS_WINDOW_LEVEL: isize = 25;

/// Collection behaviour: join every Space, and be an auxiliary over full-screen
/// apps rather than forcing a Space switch. Without `FullScreenAuxiliary` the
/// overlay simply never appears over a full-screen window, which is exactly
/// where a user most wants help.
const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
const IGNORES_CYCLE: usize = 1 << 6;

/// Make `window` a non-activating floating panel.
///
/// `focusable` decides whether it may become the key window: the bar needs keys
/// so it can be typed into, the marks layer must never take them.
pub fn make_panel(window: &tauri::WebviewWindow, focusable: bool) -> Result<(), String> {
    let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;
    if ptr.is_null() {
        return Err("no NSWindow behind this window".into());
    }

    unsafe {
        let obj = &*ptr;

        // Swap NSWindow -> our NSPanel subclass, so the nonactivating style is
        // honoured AND the panel is allowed to take the keyboard.
        let panel_class = if focusable {
            key_panel_class()?
        } else {
            AnyClass::get(c"NSPanel").ok_or("NSPanel missing")? as *const AnyClass
        };
        let current: *const AnyClass = objc2::msg_send![obj, class];
        if current != panel_class {
            let _: *const objc2::ffi::objc_class =
                objc2::ffi::object_setClass(ptr.cast(), panel_class.cast());
        }

        let mask: usize = objc2::msg_send![obj, styleMask];
        let _: () = objc2::msg_send![obj, setStyleMask: mask | NONACTIVATING_PANEL];

        // Float above ordinary windows, on every Space, and stay out of ⌘`
        // window cycling — it is a HUD, not a document.
        let _: () = objc2::msg_send![obj, setLevel: STATUS_WINDOW_LEVEL];
        let _: () = objc2::msg_send![
            obj,
            setCollectionBehavior: CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUXILIARY | IGNORES_CYCLE
        ];

        // A panel that hides itself when the app deactivates would vanish the
        // instant it appeared, since the app is never activated in the first
        // place.
        let _: () = objc2::msg_send![obj, setHidesOnDeactivate: false];
        let _: () = objc2::msg_send![obj, setFloatingPanel: true];
        // Only take key status when something actually wants typing, so merely
        // showing the marks never pulls focus off the user's editor.
        let _: () = objc2::msg_send![obj, setBecomesKeyOnlyIfNeeded: !focusable];
    }
    Ok(())
}

/// An NSPanel that will actually take the keyboard.
///
/// This is the whole bug in one line: `canBecomeKeyWindow` returns NO for a
/// BORDERLESS window, and the overlay is borderless because it draws its own
/// rounded bar. So the panel could never become key, the web view could be made
/// first responder all day, and every keystroke went to whatever app the user
/// was in — no caret, no typing, no error anywhere to explain it.
///
/// AppKit exposes no flag for this; the only way is a subclass that says yes.
/// `canBecomeMainWindow` stays NO on purpose: main is what makes an app look
/// frontmost, and this window must never take the user's attention away from
/// what they were doing.
unsafe fn key_panel_class() -> Result<*const AnyClass, String> {
    static CLASS: OnceLock<usize> = OnceLock::new();
    let addr = CLASS.get_or_init(|| {
        // Written against NSObject rather than AnyObject: the trait that accepts
        // a method implementation needs a concrete callee type, and a borrow of
        // AnyObject leaves the lifetime too general for it.
        extern "C-unwind" fn yes(_: &objc2::runtime::NSObject, _: Sel) -> Bool {
            Bool::YES
        }
        extern "C-unwind" fn no(_: &objc2::runtime::NSObject, _: Sel) -> Bool {
            Bool::NO
        }
        let name = c"AiBoxKeyPanel";
        // Already registered — a second window, or a reload during development.
        if let Some(existing) = AnyClass::get(name) {
            return existing as *const AnyClass as usize;
        }
        let Some(base) = AnyClass::get(c"NSPanel") else {
            return 0;
        };
        let Some(mut builder) = ClassBuilder::new(name, base) else {
            return 0;
        };
        unsafe {
            builder.add_method(
                objc2::sel!(canBecomeKeyWindow),
                yes as extern "C-unwind" fn(_, _) -> _,
            );
            builder.add_method(
                objc2::sel!(canBecomeMainWindow),
                no as extern "C-unwind" fn(_, _) -> _,
            );
        }
        builder.register() as *const AnyClass as usize
    });
    if *addr == 0 {
        return Err("could not build the key-taking panel class".into());
    }
    Ok(*addr as *const AnyClass)
}

/// Make the panel key WITHOUT activating the app.
///
/// Tauri's `set_focus` activates the application, which is precisely what an
/// overlay must not do: pressing the shortcut would pull AI Box to the front and
/// push the user's work behind it. `makeKeyAndOrderFront:` on a nonactivating
/// panel gives it the keyboard and leaves the frontmost app exactly where it was.
pub fn make_key(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;
    if ptr.is_null() {
        return Err("no NSWindow behind this window".into());
    }
    unsafe {
        let obj = &*ptr;
        let nil: *mut AnyObject = std::ptr::null_mut();
        let _: () = objc2::msg_send![obj, makeKeyAndOrderFront: nil];
    }
    focus_webview(window)
}

/// Put the keyboard into the panel's web view.
///
/// A non-activating panel can be the key window while its app is not the active
/// one — that is the whole point of the style — but making the WINDOW key is not
/// the same as giving the keyboard to the web view inside it. Tauri's
/// `set_focus` does the first; without the second the window is key, the page
/// calls `input.focus()` quite happily, and every keystroke still goes to
/// whatever the user was using. No caret, no typing, no error.
///
/// The web view is the content view's first subview. Falling back to the content
/// view itself is harmless: AppKit walks the responder chain down from whatever
/// it is handed.
pub fn focus_webview(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;
    if ptr.is_null() {
        return Err("no NSWindow behind this window".into());
    }
    unsafe {
        let obj = &*ptr;
        let content: *mut AnyObject = objc2::msg_send![obj, contentView];
        if content.is_null() {
            return Err("no content view".into());
        }
        let subviews: *mut AnyObject = objc2::msg_send![&*content, subviews];
        let count: usize = if subviews.is_null() {
            0
        } else {
            objc2::msg_send![&*subviews, count]
        };
        let target: *mut AnyObject = if count > 0 {
            objc2::msg_send![&*subviews, objectAtIndex: 0usize]
        } else {
            content
        };
        // The window must already be able to become key for this to mean
        // anything — see `key_panel_class`.
        let _: bool = objc2::msg_send![obj, makeFirstResponder: target];
    }
    Ok(())
}
