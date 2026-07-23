// Interactive pseudo-terminal (PTY) sessions for the Terminal tab. A real shell
// stays alive on the Mac, addressable by a stable id, so it survives a dropped
// WebSocket (phone sleep, Wi-Fi↔cellular, Tailscale reconnect): the client simply
// re-attaches to the same id and the recent output is replayed. Serves the desktop
// webview (Tauri Channel) and a paired phone (companion WebSocket) identically.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::{emit_ev, EventSink};

/// How much recent output to keep per session for replay on re-attach.
const BUFFER_CAP: usize = 512 * 1024;

/// One live shell + its PTY, its output fanned out to a replay buffer and a
/// broadcast so multiple/rotating clients can attach over the session's lifetime.
struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    tx: broadcast::Sender<Vec<u8>>,
    buffer: Mutex<VecDeque<u8>>,
    dead: AtomicBool,
}

/// App-global registry of open PTY sessions, keyed by a stable client id (the
/// terminal tab's id), so a re-attach finds the same shell.
#[derive(Default)]
pub struct PtyRegistry(Mutex<HashMap<String, Arc<PtySession>>>);

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl PtyRegistry {
    fn get(&self, id: &str) -> Option<Arc<PtySession>> {
        self.0.lock().unwrap().get(id).cloned()
    }
    fn remove(&self, id: &str) -> Option<Arc<PtySession>> {
        self.0.lock().unwrap().remove(id)
    }

    /// Kill every session — used on app shutdown so no shell is orphaned.
    pub fn kill_all(&self) {
        for (_, s) in self.0.lock().unwrap().drain() {
            let _ = s.child.lock().unwrap().kill();
        }
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
        let mut map = self.0.lock().unwrap();

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

        // Spawn a new login shell in the home directory.
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| format!("openpty: {e}"))?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color");
        // Suppress zsh's reverse-video "%" end-of-line marker (shown for output
        // without a trailing newline) — it looks like stray junk in the UI.
        cmd.env("PROMPT_EOL_MARK", "");
        if let Ok(home) = std::env::var("HOME") {
            cmd.cwd(home);
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

        let (tx, rx) = broadcast::channel::<Vec<u8>>(2048);
        let session = Arc::new(PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            tx,
            buffer: Mutex::new(VecDeque::new()),
            dead: AtomicBool::new(false),
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
                        let _ = s2.tx.send(chunk); // Err when no subscribers — fine
                    }
                }
            }
            s2.dead.store(true, Ordering::Relaxed);
            let _ = s2.tx.send(Vec::new()); // wake any subscriber so it emits Exit
        });

        Ok((session, rx, Vec::new()))
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

/// Kill a session's shell and forget it (user closed the tab).
pub fn pty_kill_core(id: &str, reg: &PtyRegistry) {
    if let Some(s) = reg.remove(id) {
        let _ = s.child.lock().unwrap().kill();
    }
}
