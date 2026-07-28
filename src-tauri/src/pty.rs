// Interactive pseudo-terminal (PTY) sessions for the Terminal tab. A real shell
// stays alive on the Mac, addressable by a stable id, so it survives a dropped
// WebSocket (phone sleep, Wi-Fi↔cellular, Tailscale reconnect): the client simply
// re-attaches to the same id and the recent output is replayed. Serves the desktop
// webview (Tauri Channel) and a paired phone (companion WebSocket) identically.
//
// A shell cannot outlive the app — its PTY master fd belongs to this process — so
// quitting really does end every shell. What we can carry across a restart is what
// you were LOOKING at and where you were: each session's recent output and its
// working directory are snapshotted to ~/.ai-box/terminals, and a tab reopened
// after a restart replays that screen before its fresh shell starts, in the same
// directory. Running processes are gone; the transcript and your place aren't.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::{emit_ev, EventSink};

/// How much recent output to keep per session for replay on re-attach.
const BUFFER_CAP: usize = 512 * 1024;

/// How often the ticker writes changed screens to disk. This is the primary
/// save path, not a backstop — short enough that quitting seconds after a
/// command still keeps its output, and free for idle terminals, which skip the
/// write entirely.
const SNAPSHOT_EVERY: Duration = Duration::from_secs(3);

/// Saved screens older than this are dropped at shutdown, so tabs closed on
/// another device don't leave records behind forever.
const RECORD_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// Escape sequences that put the emulator back in a sane state before we print
/// the divider: the saved tail may have ended inside a full-screen TUI (claude,
/// vim, top), which would otherwise swallow everything after it.
const RESTORE_RESET: &str = "\x1b[?1049l\x1b[?25h\x1b[?7h\x1b[0m";
const RESTORE_BANNER: &str = "\r\n\x1b[90m── previous session (restored) ──\x1b[0m\r\n";

/// What we keep on disk for one terminal tab between app runs.
#[derive(Serialize, Deserialize, Default)]
struct SavedTerm {
    /// The shell's working directory when we last looked.
    #[serde(default)]
    cwd: Option<String>,
    /// Unix ms, for TTL pruning.
    #[serde(default)]
    saved_at: u64,
    /// Recent raw terminal output, base64.
    #[serde(default)]
    screen: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Session ids come from the client — including a paired phone — so they are
/// untrusted input on a path. Reduce to an unmistakably safe filename stem, and
/// refuse (`None`) rather than guess if nothing usable is left.
fn record_stem(id: &str) -> Option<String> {
    let stem: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if stem.is_empty() {
        None
    } else {
        Some(stem)
    }
}

fn record_path(id: &str) -> Option<String> {
    record_stem(id).map(|s| crate::app_path(&format!("terminals/{s}.json")))
}

fn load_record(id: &str) -> Option<SavedTerm> {
    let path = record_path(id)?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_record(id: &str, rec: &SavedTerm) {
    let Some(path) = record_path(id) else { return };
    if let Some(parent) = Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(json) = serde_json::to_string(rec) else { return };
    // Temp file + rename, so a quit mid-write can't leave a truncated record
    // that would replay as garbage on the next launch.
    let tmp = format!("{path}.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn delete_record(id: &str) {
    if let Some(path) = record_path(id) {
        let _ = std::fs::remove_file(path);
    }
}

/// Drop saved screens nobody has re-opened in a month.
fn prune_records() {
    let dir = crate::app_path("terminals");
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let cutoff = now_ms().saturating_sub(RECORD_TTL_MS);
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let stale = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<SavedTerm>(&raw).ok())
            .map(|rec| rec.saved_at < cutoff)
            .unwrap_or(true); // unreadable → not worth keeping
        if stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The working directory of a running process. Used to reopen a restored tab
/// where you left it instead of dumping you back in $HOME.
#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    // `lsof -a -d cwd -Fn -p PID` prints machine-readable fields, one per line;
    // the cwd path is the line beginning with 'n'.
    let out = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-Fn", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(str::to_string))
        .filter(|p| !p.is_empty())
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}

/// One live shell + its PTY, its output fanned out to a replay buffer and a
/// broadcast so multiple/rotating clients can attach over the session's lifetime.
struct PtySession {
    /// The tab id this shell belongs to — also the name of its saved screen.
    id: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    tx: broadcast::Sender<Vec<u8>>,
    buffer: Mutex<VecDeque<u8>>,
    dead: AtomicBool,
    /// The user closed this tab: stop saving. Killing the shell makes the reader
    /// hit EOF, and its exit snapshot would otherwise write the record back
    /// moments after the close deleted it.
    closed: AtomicBool,
    /// Last directory we saw the shell in, kept so a snapshot still has one if
    /// the lookup fails (e.g. the shell is exiting as we ask).
    last_cwd: Mutex<Option<String>>,
    /// Total bytes the shell has produced, and how many were on disk as of the
    /// last save. Unequal means there is something new worth writing.
    bytes_seen: AtomicU64,
    bytes_saved: AtomicU64,
}

impl PtySession {
    /// Write this session's screen + cwd to disk so the next launch can restore it.
    fn snapshot(&self) {
        if self.closed.load(Ordering::Relaxed) {
            return; // tab is gone; its record has been deleted on purpose
        }
        let seen = self.bytes_seen.load(Ordering::Relaxed);
        let screen: Vec<u8> = self.buffer.lock().unwrap().iter().copied().collect();
        let pid = self.child.lock().unwrap().process_id();
        let cwd = pid.and_then(process_cwd);
        let mut last = self.last_cwd.lock().unwrap();
        if cwd.is_some() {
            *last = cwd.clone();
        }
        write_record(
            &self.id,
            &SavedTerm {
                cwd: cwd.or_else(|| last.clone()),
                saved_at: now_ms(),
                screen: b64(&screen),
            },
        );
        self.bytes_saved.store(seen, Ordering::Relaxed);
    }

    /// Save only if the shell has produced something since the last save, so an
    /// idle terminal costs nothing on every tick.
    fn snapshot_if_dirty(&self) {
        if self.bytes_seen.load(Ordering::Relaxed) != self.bytes_saved.load(Ordering::Relaxed) {
            self.snapshot();
        }
    }
}

/// App-global registry of open PTY sessions, keyed by a stable client id (the
/// terminal tab's id), so a re-attach finds the same shell.
pub struct PtyRegistry {
    sessions: Arc<Mutex<HashMap<String, Arc<PtySession>>>>,
    /// Guards the one-time start of the snapshot ticker.
    ticker: std::sync::Once,
}

// Hand-written because `Once` has no Default.
impl Default for PtyRegistry {
    fn default() -> Self {
        Self {
            sessions: Arc::default(),
            ticker: std::sync::Once::new(),
        }
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl PtyRegistry {
    fn get(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }
    fn remove(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().unwrap().remove(id)
    }

    /// Save on a timer, not on shell output.
    ///
    /// Snapshotting from the output reader looks equivalent and is not: after
    /// `ls` finishes, no further chunks arrive, so the reader never runs again
    /// and the final screen — the thing you actually want back — is never
    /// written. A timer sees the terminal as it rests. It also means an exit
    /// hook that fails to fire costs seconds of transcript, not all of it.
    fn start_ticker(&self) {
        let sessions = self.sessions.clone();
        self.ticker.call_once(move || {
            std::thread::spawn(move || loop {
                std::thread::sleep(SNAPSHOT_EVERY);
                let live: Vec<Arc<PtySession>> =
                    sessions.lock().unwrap().values().cloned().collect();
                for s in live {
                    s.snapshot_if_dirty();
                }
            });
        });
    }

    /// App shutdown: save each session's screen and cwd, then kill it so no shell
    /// is orphaned. The save has to happen first — once the child is gone we can
    /// no longer ask the OS what directory it was in.
    ///
    /// Safe to call more than once: macOS delivers quit as `Exit` and a window
    /// close as `ExitRequested`, and we listen for both rather than bet on which.
    pub fn shutdown(&self) {
        for (_, s) in self.sessions.lock().unwrap().drain() {
            s.snapshot();
            let _ = s.child.lock().unwrap().kill();
        }
        prune_records();
    }

    /// Attach to a live session (returning its replay buffer) or spawn a fresh
    /// shell. Resizes the PTY to the attaching client's viewport.
    fn attach(
        &self,
        id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(Arc<PtySession>, broadcast::Receiver<Vec<u8>>, Vec<u8>), String> {
        let size = PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        self.start_ticker();
        let mut map = self.sessions.lock().unwrap();

        // Re-attach to an existing, still-running shell (multiple viewers allowed).
        if let Some(s) = map.get(id) {
            if !s.dead.load(Ordering::Relaxed) {
                let rx = s.tx.subscribe();
                let replay: Vec<u8> = s.buffer.lock().unwrap().iter().copied().collect();
                let _ = s.master.lock().unwrap().resize(size); // triggers a TUI redraw
                return Ok((s.clone(), rx, replay));
            }
            map.remove(id); // dead → recreate below
        }

        // No live shell for this tab: spawn one. If we saved a screen for this id
        // on a previous run, pick up where it left off — same directory, and the
        // old transcript seeded into the replay buffer below.
        let saved = load_record(id);

        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| format!("openpty: {e}"))?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color");
        // Suppress zsh's reverse-video "%" end-of-line marker (shown for output
        // without a trailing newline) — it looks like stray junk in the UI.
        cmd.env("PROMPT_EOL_MARK", "");
        // The saved directory may since have been renamed or deleted; fall back
        // to $HOME rather than failing to spawn.
        let start_dir = saved
            .as_ref()
            .and_then(|r| r.cwd.as_deref())
            .filter(|p| Path::new(p).is_dir())
            .map(str::to_string)
            .or_else(|| std::env::var("HOME").ok());
        if let Some(dir) = start_dir {
            cmd.cwd(dir);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn shell: {e}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("pty writer: {e}"))?;

        // Seed the replay buffer with the restored transcript, so both this client
        // and any later re-attach see the same continuous history. The divider
        // marks where the old session stopped and the new shell begins.
        let mut seed: Vec<u8> = Vec::new();
        if let Some(screen) = saved
            .as_ref()
            .map(|r| r.screen.as_str())
            .filter(|s| !s.is_empty())
            .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
            .filter(|b| !b.is_empty())
        {
            seed.extend(screen);
            seed.extend(RESTORE_RESET.as_bytes());
            seed.extend(RESTORE_BANNER.as_bytes());
        }

        let (tx, rx) = broadcast::channel::<Vec<u8>>(2048);
        let session = Arc::new(PtySession {
            id: id.to_string(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            tx,
            buffer: Mutex::new(seed.iter().copied().collect()),
            dead: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            last_cwd: Mutex::new(saved.and_then(|r| r.cwd)),
            // The restored seed is already on disk, so it is not "unsaved".
            bytes_seen: AtomicU64::new(seed.len() as u64),
            bytes_saved: AtomicU64::new(seed.len() as u64),
        });
        map.insert(id.to_string(), session.clone());

        // Reader thread (portable-pty is blocking): fan output into the replay
        // buffer + broadcast. On EOF the shell has exited.
        let s2 = session.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        {
                            let mut b = s2.buffer.lock().unwrap();
                            b.extend(chunk.iter().copied());
                            while b.len() > BUFFER_CAP {
                                b.pop_front();
                            }
                        }
                        s2.bytes_seen.fetch_add(n as u64, Ordering::Relaxed);
                        let _ = s2.tx.send(chunk); // Err when no subscribers — fine
                    }
                }
            }
            // The shell exited. Snapshot the final screen so "Restart shell" — and
            // the next app launch — still show what it left behind.
            s2.snapshot();
            s2.dead.store(true, Ordering::Relaxed);
            let _ = s2.tx.send(Vec::new()); // wake any subscriber so it emits Exit
        });

        Ok((session, rx, seed))
    }
}

/// Streamed PTY output / lifecycle events.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PtyEvent {
    /// Raw terminal bytes, base64-encoded.
    Data { data: String },
    /// The shell process exited (not a mere disconnect).
    Exit,
}

/// Attach to (or open) a session and stream its output until the shell exits or the
/// client disconnects. On disconnect (`cancel` flips) the shell is LEFT RUNNING so a
/// reconnect can re-attach; only a real shell exit emits `Exit`.
pub async fn pty_open_core(
    id: String,
    rows: u16,
    cols: u16,
    reg: &PtyRegistry,
    sink: &dyn EventSink,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<serde_json::Value, String> {
    let (session, mut rx, replay) = reg.attach(&id, rows, cols)?;

    // Replay recent output so a re-attached (or freshly reloaded) client sees the
    // current screen. The client resets its terminal before applying this.
    if !replay.is_empty() {
        emit_ev(sink, PtyEvent::Data { data: b64(&replay) });
    }

    let mut detached = false;
    loop {
        tokio::select! {
            r = rx.recv() => match r {
                Ok(bytes) => {
                    if !bytes.is_empty() {
                        emit_ev(sink, PtyEvent::Data { data: b64(&bytes) });
                    }
                    if session.dead.load(Ordering::Relaxed) {
                        break;
                    }
                }
                // Fell behind the broadcast; the periodic replay-on-reattach keeps
                // the gross screen state correct, so just resume.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            // This client detached (navigated away / closed the view). The shell is
            // left running for re-attach; other viewers keep streaming.
            _ = tokio::time::sleep(std::time::Duration::from_millis(400)) => {
                if cancel.as_ref().map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
                    detached = true;
                    break;
                }
            }
        }
    }

    if session.dead.load(Ordering::Relaxed) && !detached {
        reg.remove(&id);
        emit_ev(sink, PtyEvent::Exit);
    }
    // Detached (client gone): the shell keeps running for a later re-attach.
    Ok(serde_json::Value::Null)
}

/// Send keystrokes (base64 bytes) to a session's shell.
pub fn pty_write_core(id: &str, data_b64: &str, reg: &PtyRegistry) -> Result<(), String> {
    let session = reg.get(id).ok_or("no such terminal session")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|e| format!("decode input: {e}"))?;
    let mut w = session.writer.lock().unwrap();
    w.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
    let _ = w.flush();
    Ok(())
}

/// Resize a session's PTY (rows/cols) when the UI viewport changes.
pub fn pty_resize_core(id: &str, rows: u16, cols: u16, reg: &PtyRegistry) -> Result<(), String> {
    let session = reg.get(id).ok_or("no such terminal session")?;
    let res = session.master.lock().unwrap().resize(PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    });
    res.map_err(|e| format!("resize: {e}"))
}

/// Kill a session's shell and forget it (user closed the tab). Closing a tab is
/// deliberate, so the saved screen goes too — otherwise a new tab that happened
/// to reuse the id would come back haunted.
pub fn pty_kill_core(id: &str, reg: &PtyRegistry) {
    if let Some(s) = reg.remove(id) {
        // Order matters: mark closed BEFORE killing. The kill lands as EOF in the
        // reader thread, whose exit snapshot would otherwise recreate the record
        // just after we delete it.
        s.closed.store(true, Ordering::Relaxed);
        let _ = s.child.lock().unwrap().kill();
    }
    delete_record(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session id is untrusted (it can come from a paired phone), so it must
    /// never be able to steer the write outside the terminals directory.
    #[test]
    fn record_stem_strips_path_traversal() {
        assert_eq!(record_stem("../../etc/passwd").as_deref(), Some("etcpasswd"));
        assert_eq!(record_stem("a/b").as_deref(), Some("ab"));
        assert_eq!(record_stem("../.."), None);
        assert_eq!(record_stem(""), None);
        assert_eq!(record_stem("7846e931-8c63-4979").as_deref(), Some("7846e931-8c63-4979"));
        assert!(record_stem(&"x".repeat(500)).unwrap().len() <= 64);
    }

    /// The whole point of the feature: quit, relaunch, and the tab shows what it
    /// showed before, in the directory it was in.
    #[test]
    fn a_restarted_tab_replays_its_screen_and_keeps_its_directory() {
        let reg = PtyRegistry::default();
        let id = "test-restore-roundtrip";
        delete_record(id);

        let tmp = std::env::temp_dir().join("ai-box-pty-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let dir = tmp.canonicalize().unwrap().to_string_lossy().into_owned();

        // A first run: the shell cds somewhere and prints something.
        let (session, _rx, replay) = reg.attach(id, 24, 80).unwrap();
        assert!(replay.is_empty(), "nothing saved yet, so nothing to replay");
        pty_write_core(
            id,
            &b64(format!("cd {dir} && echo MARKER_FROM_LAST_RUN\n").as_bytes()),
            &reg,
        )
        .unwrap();
        // Wait for the command to actually RUN, not merely be echoed back: the
        // marker appears twice (once in the echoed command line, once as output)
        // and the shell has really moved directory.
        let pid = session.child.lock().unwrap().process_id().unwrap();
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(50));
            let screen = String::from_utf8_lossy(&drain(&session)).into_owned();
            if screen.matches("MARKER_FROM_LAST_RUN").count() >= 2 && same_dir(process_cwd(pid), &dir)
            {
                break;
            }
        }

        // Quitting the app.
        reg.shutdown();

        // Relaunching: same tab id attaches to a brand-new shell.
        let (session2, _rx2, replay2) = reg.attach(id, 24, 80).unwrap();
        let restored = String::from_utf8_lossy(&replay2).into_owned();
        assert!(
            restored.contains("MARKER_FROM_LAST_RUN"),
            "previous screen should be replayed, got: {restored:?}"
        );
        assert!(
            restored.contains("previous session"),
            "the divider should mark where the old session ended"
        );

        // …and the new shell starts in the directory the old one was left in.
        let pid2 = session2.child.lock().unwrap().process_id().unwrap();
        assert!(
            same_dir(process_cwd(pid2), &dir),
            "should reopen where we left off, got {:?}",
            process_cwd(pid2)
        );

        pty_kill_core(id, &reg);
        assert!(load_record(id).is_none(), "closing a tab discards its saved screen");
    }

    /// Killing the shell makes the output reader hit EOF, and the EOF path
    /// snapshots. Nothing may write the record back after the close deleted it.
    #[test]
    fn closing_a_tab_leaves_no_saved_screen_behind() {
        let reg = PtyRegistry::default();
        let id = "test-close-no-resurrect";
        delete_record(id);

        let _open = reg.attach(id, 24, 80).unwrap();
        std::thread::sleep(Duration::from_millis(400)); // let the shell print a prompt

        pty_kill_core(id, &reg);
        std::thread::sleep(Duration::from_millis(600)); // room for the reader to misbehave

        assert!(
            load_record(id).is_none(),
            "a closed tab must not leave a saved screen behind"
        );
    }

    /// The reported bug: run `ls`, quit, and the output was gone. Snapshotting
    /// from the output reader missed it — once a command finishes no more chunks
    /// arrive, so nothing ever saved the resting screen — and Cmd+Q never
    /// reached the exit hook. The ticker must save a settled terminal on its own,
    /// with no shutdown() and no kill anywhere in this test.
    #[test]
    fn the_ticker_saves_a_resting_terminal_with_no_quit_hook() {
        let reg = PtyRegistry::default();
        let id = "test-ticker-saves-at-rest";
        delete_record(id);

        let _open = reg.attach(id, 24, 80).unwrap();
        pty_write_core(id, &b64(b"echo TICKER_MARKER\n"), &reg).unwrap();

        let saved = (0..40).find_map(|_| {
            std::thread::sleep(Duration::from_millis(250));
            let rec = load_record(id)?;
            let screen = base64::engine::general_purpose::STANDARD
                .decode(&rec.screen)
                .ok()?;
            let text = String::from_utf8_lossy(&screen).into_owned();
            // Twice: the echoed command line, and the line the shell printed.
            (text.matches("TICKER_MARKER").count() >= 2).then_some(text)
        });

        pty_kill_core(id, &reg);
        assert!(
            saved.is_some(),
            "the ticker must persist a resting terminal without any quit hook"
        );
    }

    fn drain(session: &Arc<PtySession>) -> Vec<u8> {
        session.buffer.lock().unwrap().iter().copied().collect()
    }

    /// Compare paths through the filesystem, since /var and /private/var are the
    /// same directory on macOS.
    fn same_dir(got: Option<String>, want: &str) -> bool {
        let real = |p: &str| std::path::Path::new(p).canonicalize().ok();
        got.and_then(|p| real(&p)) == real(want)
    }
}
