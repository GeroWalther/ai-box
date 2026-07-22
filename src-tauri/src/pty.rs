// Interactive pseudo-terminal (PTY) sessions for the Terminal tab. Unlike the
// one-shot `run_command_stream`, this keeps a real shell alive so interactive
// programs (claude, vim, top, a REPL) work — the same session serves the desktop
// webview (Tauri Channel) and a paired phone (companion WebSocket).
//
// Protocol: the UI opens a session (`pty_open`, streaming) that emits raw output
// bytes as base64; it writes keystrokes (`pty_write`), resizes (`pty_resize`) and
// closes (`pty_kill`) via one-shot commands keyed by a client-generated id.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::{emit_ev, EventSink};

/// One live shell + its PTY master, addressable for write/resize/kill.
struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

/// App-global registry of open PTY sessions, keyed by the client's session id.
#[derive(Default)]
pub struct PtyRegistry(Mutex<HashMap<String, Arc<PtySession>>>);

impl PtyRegistry {
    fn get(&self, id: &str) -> Option<Arc<PtySession>> {
        self.0.lock().unwrap().get(id).cloned()
    }
    fn remove(&self, id: &str) -> Option<Arc<PtySession>> {
        self.0.lock().unwrap().remove(id)
    }
}

/// Streamed PTY output / lifecycle events.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PtyEvent {
    /// Raw terminal bytes, base64-encoded.
    Data { data: String },
    /// The shell exited or the session was closed.
    Exit,
}

/// Open a shell in a fresh PTY and stream its output until it exits (or `cancel`
/// flips — used when a phone disconnects so we don't orphan the shell). Runs for
/// the whole session lifetime, so callers should spawn it.
pub async fn pty_open_core(
    id: String,
    rows: u16,
    cols: u16,
    reg: &PtyRegistry,
    sink: &dyn EventSink,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<serde_json::Value, String> {
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty: {e}"))?;

    // Launch the user's login shell in the home directory, advertising a
    // color-capable terminal so programs render properly.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
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

    let session = Arc::new(PtySession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    reg.0.lock().unwrap().insert(id.clone(), session.clone());

    // portable-pty is blocking, so read the master on a dedicated thread and
    // forward chunks into the async loop.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    loop {
        tokio::select! {
            chunk = rx.recv() => match chunk {
                Some(bytes) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    emit_ev(sink, PtyEvent::Data { data });
                }
                None => break, // shell exited (reader hit EOF)
            },
            // Periodically check whether the client vanished (phone disconnect).
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                if cancel.as_ref().map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
                    break;
                }
            }
        }
    }

    // Tear the session down: kill the shell (no-op if it already exited) and drop it.
    if let Some(s) = reg.remove(&id) {
        let _ = s.child.lock().unwrap().kill();
    }
    emit_ev(sink, PtyEvent::Exit);
    Ok(serde_json::Value::Null)
}

/// Send keystrokes (base64-encoded bytes) to a session's shell.
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

/// Kill a session's shell and forget it.
pub fn pty_kill_core(id: &str, reg: &PtyRegistry) {
    if let Some(s) = reg.remove(id) {
        let _ = s.child.lock().unwrap().kill();
    }
}
