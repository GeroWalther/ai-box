// The user's own browser: the tabs they already have open, in Brave, Chrome or
// Safari, driven through the browsers' AppleScript.
//
// The assistant's own Chrome (browser.rs) is where it works by default. This is
// for when the user says "do it in my browser": the page they are looking at,
// signed in as they are. It is not screen-clicking — every browser here can
// run JavaScript in a tab on request, so the page is read with the same
// snapshot as the assistant's browser (numbered elements, no password fields)
// and acted on by element, not by guessing coordinates from a screenshot.
//
// Two things the user grants once, and which the errors below explain:
//   * macOS: AI Box may control the browser (Privacy & Security → Automation).
//   * The browser: Chrome and Brave need View → Developer → "Allow JavaScript
//     from Apple Events"; Safari needs Develop → "Allow JavaScript from Apple
//     Events".
//
// Clicks made this way are the page's own `click()`, which a handful of sites
// ignore because it is not a real mouse. Everything else — links, buttons,
// forms, React inputs — responds to it.

use serde_json::{json, Value};

const SNAPSHOT: &str = include_str!("browser_snapshot.js");

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Chromium(&'static str),
    Safari,
}

const BROWSERS: &[Kind] = &[Kind::Chromium("Brave Browser"), Kind::Chromium("Google Chrome"), Kind::Safari];

impl Kind {
    fn app(self) -> &'static str {
        match self {
            Kind::Chromium(name) => name,
            Kind::Safari => "Safari",
        }
    }

    pub fn from_name(name: &str) -> Option<Kind> {
        let n = name.to_lowercase();
        if n.trim().is_empty() {
            return None;
        }
        BROWSERS.iter().copied().find(|k| {
            let app = k.app().to_lowercase();
            app == n || app.contains(n.trim()) || n.contains(&app)
        })
    }
}

/// A tab, addressed the way AppleScript does: window and tab by position.
#[derive(Clone, Debug, PartialEq)]
pub struct TabRef {
    pub kind: Kind,
    pub window: u32,
    pub tab: u32,
}

impl TabRef {
    /// "Brave Browser 1:3" — what the model passes back to pick a tab.
    pub fn id(&self) -> String {
        format!("{} {}:{}", self.kind.app(), self.window, self.tab)
    }

    pub fn parse(id: &str) -> Option<TabRef> {
        let (name, pos) = id.trim().rsplit_once(' ')?;
        let (w, t) = pos.split_once(':')?;
        Some(TabRef { kind: Kind::from_name(name)?, window: w.parse().ok()?, tab: t.parse().ok()? })
    }
}

/// Run AppleScript from stdin (no argument-length limit, no shell quoting).
fn osa(script: &str) -> Result<String, String> {
    use std::io::Write;
    let mut child = std::process::Command::new("/usr/bin/osascript")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("osascript: {e}"))?;
    child.stdin.take().unwrap().write_all(script.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string());
    }
    Err(explain(&String::from_utf8_lossy(&out.stderr)))
}

/// The two failures everyone hits once, said so they can be fixed.
fn explain(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("javascript") && (e.contains("turned off") || e.contains("allow javascript")) {
        return "That browser does not allow JavaScript from Apple Events yet. In Brave or Chrome: View → \
Developer → Allow JavaScript from Apple Events. In Safari: Develop → Allow JavaScript from Apple Events. \
Ask the user to switch it on, then try again."
            .into();
    }
    if e.contains("-1743") || e.contains("not authorized") || e.contains("not allowed to send apple events") {
        return "AI Box is not allowed to control that browser. The user can allow it in System Settings → \
Privacy & Security → Automation → AI Box."
            .into();
    }
    format!("the browser refused: {}", err.trim())
}

/// A string literal for AppleScript.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Every open tab in every supported browser that is running. Browsers that
/// are not running are left alone — asking about one would start it.
pub fn list_tabs() -> Result<Vec<Value>, String> {
    let mut out = vec![];
    for kind in BROWSERS {
        let app = kind.app();
        let body = match kind {
            Kind::Chromium(_) => "set ai to active tab index of window w
                repeat with t from 1 to count of tabs of window w
                    set r to r & w & sep & t & sep & (t = ai) & sep & (title of tab t of window w) & sep & (URL of tab t of window w) & linefeed
                end repeat",
            Kind::Safari => "set ai to index of current tab of window w
                repeat with t from 1 to count of tabs of window w
                    set r to r & w & sep & t & sep & (t = ai) & sep & (name of tab t of window w) & sep & (URL of tab t of window w) & linefeed
                end repeat",
        };
        let script = format!(
            "if application {q} is running then
                set sep to character id 9
                set r to \"\"
                tell application {q}
                    repeat with w from 1 to count of windows
                        {body}
                    end repeat
                end tell
                return r
            end if
            return \"\"",
            q = quote(app)
        );
        let raw = match osa(&script) {
            Ok(r) => r,
            // One browser refusing must not hide the others' tabs.
            Err(e) => {
                out.push(json!({ "browser": app, "error": e }));
                continue;
            }
        };
        for line in raw.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 5 {
                continue;
            }
            let (Ok(w), Ok(t)) = (f[0].parse::<u32>(), f[1].parse::<u32>()) else { continue };
            let r = TabRef { kind: *kind, window: w, tab: t };
            out.push(json!({
                "tab": r.id(),
                "front": f[2] == "true" && w == 1,
                "title": f[3],
                "url": f[4],
            }));
        }
    }
    Ok(out)
}

/// The tab the user is looking at: the active tab of the front window of the
/// frontmost supported browser.
pub fn front_tab() -> Result<TabRef, String> {
    let front = osa("tell application \"System Events\" to return name of first application process whose frontmost is true")
        .unwrap_or_default();
    let tabs = list_tabs()?;
    let pick = |app: &str| tabs.iter().find(|t| t["front"] == true && t["tab"].as_str().map_or(false, |id| id.starts_with(app)));
    let chosen = BROWSERS
        .iter()
        .find(|k| k.app() == front)
        .and_then(|k| pick(k.app()))
        .or_else(|| tabs.iter().find(|t| t["front"] == true));
    chosen
        .and_then(|t| t["tab"].as_str())
        .and_then(TabRef::parse)
        .ok_or_else(|| "No Brave, Chrome or Safari window is open.".into())
}

/// Run JavaScript in a tab and return what it returned, as JSON.
fn run_js(tab: &TabRef, js_expression: &str) -> Result<Value, String> {
    // Always hand back a string: AppleScript turns anything else into its own
    // record syntax, which is not worth parsing.
    let js = format!("JSON.stringify(({js_expression}))");
    let script = match tab.kind {
        Kind::Chromium(app) => format!(
            "tell application {} to execute tab {} of window {} javascript {}",
            quote(app),
            tab.tab,
            tab.window,
            quote(&js)
        ),
        Kind::Safari => format!(
            "tell application \"Safari\" to do JavaScript {} in tab {} of window {}",
            quote(&js),
            tab.tab,
            tab.window
        ),
    };
    let raw = osa(&script)?;
    if raw.is_empty() || raw == "missing value" {
        return Ok(Value::Null);
    }
    serde_json::from_str(&raw).map_err(|_| format!("the page answered something unexpected: {}", raw.chars().take(200).collect::<String>()))
}

/// Read a tab: the same numbered elements and text as the assistant's browser.
pub fn read(tab: &TabRef) -> Result<(String, Vec<Value>), String> {
    let snap = run_js(tab, SNAPSHOT)?;
    if snap.is_null() {
        return Err("the page could not be read (still loading?)".into());
    }
    let elements: Vec<Value> = snap["elements"].as_array().cloned().unwrap_or_default();
    let summary = format!("Tab: {}\n{}", tab.id(), crate::browser::describe(&snap, &elements));
    Ok((summary, elements))
}

fn node_js(node: u64, body: &str) -> String {
    format!(
        "(() => {{ const e = window.__aibox && window.__aibox.nodes.get({node});
           if (!e || !e.isConnected) return 'gone';
           e.scrollIntoView({{block: 'center', inline: 'center'}});
           {body} }})()"
    )
}

fn outcome(v: Value) -> Result<(), String> {
    match v.as_str() {
        Some("ok") => Ok(()),
        Some("gone") => Err("that element is no longer on the page — read the tab again".into()),
        Some(other) => Err(other.to_string()),
        None => Ok(()),
    }
}

/// Settle after an action: the page may navigate, and reading it mid-way
/// fails.
fn settle() {
    std::thread::sleep(std::time::Duration::from_millis(900));
}

// Pointer events first, then click(): menus built on pointerdown open, and
// ordinary buttons and links still get their click.
fn click_js(node: u64) -> String {
    node_js(
        node,
        "const o = {bubbles: true, cancelable: true, view: window};
         for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'])
           e.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
         e.click();
         return 'ok';",
    )
}

pub fn click(tab: &TabRef, node: u64) -> Result<(), String> {
    outcome(run_js(tab, &click_js(node))?)?;
    settle();
    Ok(())
}

// The value is set through the prototype's own setter, not `e.value = …`:
// React and friends watch that setter, and ignore a plain assignment.
fn type_js(node: u64, text: &str, submit: bool) -> String {
    let body = format!(
        "e.focus();
         const text = {text};
         if (e.isContentEditable) {{
           document.execCommand('selectAll', false); document.execCommand('insertText', false, text);
         }} else {{
           const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
           Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, text);
           e.dispatchEvent(new Event('input', {{bubbles: true}}));
           e.dispatchEvent(new Event('change', {{bubbles: true}}));
         }}
         if ({submit}) {{
           const k = {{key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}};
           const go = e.dispatchEvent(new KeyboardEvent('keydown', k));
           e.dispatchEvent(new KeyboardEvent('keyup', k));
           if (go && e.form) e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit();
         }}
         return 'ok';",
        text = serde_json::to_string(text).unwrap_or_default(),
        submit = submit
    );
    node_js(node, &body)
}

pub fn type_text(tab: &TabRef, node: u64, text: &str, submit: bool) -> Result<(), String> {
    outcome(run_js(tab, &type_js(node, text, submit))?)?;
    settle();
    Ok(())
}

fn select_js(node: u64, option: &str) -> String {
    let body = format!(
        "const want = {o};
         const x = [...e.options].find(o => o.label.trim() === want.trim()) ||
                   [...e.options].find(o => o.label.toLowerCase().includes(want.toLowerCase().trim()));
         if (!x || x.disabled) return 'that dropdown has no such option';
         e.value = x.value;
         e.dispatchEvent(new Event('input', {{bubbles: true}}));
         e.dispatchEvent(new Event('change', {{bubbles: true}}));
         return 'ok';",
        o = serde_json::to_string(option).unwrap_or_default()
    );
    node_js(node, &body)
}

pub fn select(tab: &TabRef, node: u64, option: &str) -> Result<(), String> {
    outcome(run_js(tab, &select_js(node, option))?)?;
    settle();
    Ok(())
}

pub fn scroll(tab: &TabRef, down: bool) -> Result<(), String> {
    run_js(tab, &format!("(window.scrollBy(0, {}), 'ok')", if down { 700 } else { -700 }))?;
    std::thread::sleep(std::time::Duration::from_millis(300));
    Ok(())
}

/// Load a URL in the tab.
pub fn navigate(tab: &TabRef, url: &str) -> Result<(), String> {
    let url = if url.contains("://") { url.to_string() } else { format!("https://{url}") };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only web addresses (http or https) can be opened".into());
    }
    let script = match tab.kind {
        Kind::Chromium(app) => format!(
            "tell application {} to set URL of tab {} of window {} to {}",
            quote(app),
            tab.tab,
            tab.window,
            quote(&url)
        ),
        Kind::Safari => format!("tell application \"Safari\" to set URL of tab {} of window {} to {}", tab.tab, tab.window, quote(&url)),
    };
    osa(&script)?;
    std::thread::sleep(std::time::Duration::from_millis(2000));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_ids_round_trip() {
        let t = TabRef { kind: Kind::Chromium("Brave Browser"), window: 2, tab: 7 };
        assert_eq!(t.id(), "Brave Browser 2:7");
        assert_eq!(TabRef::parse("Brave Browser 2:7"), Some(t));
        assert_eq!(TabRef::parse("Safari 1:1").unwrap().kind, Kind::Safari);
        assert_eq!(TabRef::parse("Chrome 1:2").unwrap().kind, Kind::Chromium("Google Chrome"));
        assert!(TabRef::parse("Firefox 1:1").is_none());
    }

    #[test]
    fn applescript_strings_are_escaped() {
        assert_eq!(quote(r#"a "b" \c"#), r#""a \"b\" \\c""#);
    }

    #[test]
    fn the_usual_refusals_are_explained() {
        assert!(explain("Executing JavaScript through AppleScript is turned off.").contains("View → Developer"));
        assert!(explain("execution error: Not authorized to send Apple events to Brave Browser. (-1743)").contains("Automation"));
    }

    /// The page-side scripts, exactly as sent to a user's tab, run in a headless
    /// Chrome against a form whose input only notices React-style value
    /// changes. Ignored by default: it needs Chrome.
    #[tokio::test]
    #[ignore]
    async fn page_scripts_read_type_choose_and_click() {
        use crate::browser::{BrowserHost, Tab};
        let page = "data:text/html,<title>T</title><form onsubmit=\"document.title='sent:'+window.seen+':'+s.value;return false\">\
            <label>Name <input id=q></label><select id=s><option>One</option><option>Two</option></select>\
            <button>Send it</button></form><script>\
            const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');\
            q.addEventListener('input',()=>{window.seen=q.value});</script>";
        let dir = std::env::temp_dir().join(format!("aibox-ub-test-{}", uuid::Uuid::new_v4()));
        let host = BrowserHost::headless(dir.to_string_lossy().to_string());
        let mut tab = Tab::open(&host).await.unwrap();
        tab.goto_for_test(page).await;
        let js = |e: String| format!("JSON.stringify(({e}))");
        let snap: Value = serde_json::from_str(tab.eval_for_test(&js(SNAPSHOT.to_string())).await.unwrap().as_str().unwrap()).unwrap();
        let els = snap["elements"].as_array().unwrap().clone();
        let node = |label: &str| els.iter().find(|e| e["label"] == label || e["role"] == label).unwrap()["node"].as_u64().unwrap();
        for script in [type_js(node("Name"), "Gero", false), select_js(node("select"), "Two"), click_js(node("Send it"))] {
            let v = tab.eval_for_test(&js(script)).await.unwrap();
            assert_eq!(v.as_str(), Some("\"ok\""), "{v}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let title = tab.eval_for_test("document.title").await.unwrap();
        assert_eq!(title, "sent:Gero:Two");
        let _ = host.connection().await.unwrap().call(None, "Browser.close", json!({})).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Lists the real open tabs. Ignored: it needs a browser open and asks
    /// macOS for permission the first time.
    #[test]
    #[ignore]
    fn lists_real_tabs() {
        for t in list_tabs().unwrap() {
            println!("{t}");
        }
    }
}
