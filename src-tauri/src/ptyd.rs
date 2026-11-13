// The terminal service: shells that outlive the app.
//
// A shell cannot outlive the process that holds its PTY master, so as long as
// the app held it, quitting AI Box ended every shell — and with it any `claude`
// session running inside. Here the PTYs live in a small background process
// instead: the same AI Box binary started with `--pty-daemon`, detached into a
// session of its own so quitting the app does not reach it. The app (and,
// through it, a paired phone) talks to it over a Unix socket in ~/.ai-box.
// Quit, relaunch, and each tab re-attaches to the very shell it left — the
// program in it still running, its output since then in the replay buffer.
//
// The PTY code itself is unchanged and shared: the daemon runs the ordinary
// `PtyRegistry`, and the app's registry forwards to it. If the daemon cannot be
// started for any reason, the app falls back to holding the shells itself, as
// it always did — terminals keep working, they just end with the app again.
//
// Wire protocol: newline-delimited JSON, one request object per line.
//   {"op":"hello"}                          → {"v":PROTO,"pid":…,"sessions":n}
//   {"op":"attach","id",rows,cols}          → a stream of PtyEvent objects
//   {"op":"write","id","data"}              (no reply)
//   {"op":"resize","id",rows,cols}          (no reply)
//   {"op":"kill","id"}                      (no reply)
//   {"op":"list"}                           → {"sessions":[…]}
//   {"op":"exit"}                           daemon exits if nothing is running
// An attach connection stays open; closing it detaches without ending the shell.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream as StdStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::pty::{self, PtyRegistry};
use crate::EventSink;

/// Bumped when the protocol changes incompatibly.
const PROTO: u64 = 1;

/// The argument that turns the AI Box binary into the terminal service.
pub const DAEMON_ARG: &str = "--pty-daemon";

/// With no shells and nobody attached for this long, the service exits.
const IDLE_EXIT: Duration = Duration::from_secs(10 * 60);

fn socket_path() -> String {
    // Overridable so tests can run a service of their own without touching
    // the real one.
    std::env::var("AI_BOX_PTYD_SOCK").unwrap_or_else(|_| crate::app_path("ptyd.sock"))
}

// ---- the service ------------------------------------------------------------

/// Entry point for `ai-box --pty-daemon`. Never returns while it has work.
pub fn run_daemon() {
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(serve());
}

async fn serve() {
    let path = socket_path();
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // A socket file nobody answers on is left over from a crash or a reboot.
    // One that answers belongs to a service already running: leave it be.
    if StdStream::connect(&path).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(&path);
    let listener = match tokio::net::UnixListener::bind(&path) {
        Ok(l) => l,
        Err(_) => return,
    };
    // Only this user may drive these shells.
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    let reg = Arc::new(PtyRegistry::default());
    let clients = Arc::new(AtomicUsize::new(0));
    let last_busy = Arc::new(Mutex::new(Instant::now()));

    // Leave when there is nothing left to keep alive.
    {
        let (reg, clients, last_busy, path) = (reg.clone(), clients.clone(), last_busy.clone(), path.clone());
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if reg.live_count() > 0 || clients.load(Ordering::Relaxed) > 0 {
                    *last_busy.lock().unwrap() = Instant::now();
                } else if last_busy.lock().unwrap().elapsed() > IDLE_EXIT {
                    let _ = std::fs::remove_file(&path);
                    std::process::exit(0);
                }
            }
        });
    }

    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let (reg, clients) = (reg.clone(), clients.clone());
        tokio::spawn(async move {
            clients.fetch_add(1, Ordering::Relaxed);
            handle(stream, reg).await;
            clients.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

/// Forwards a session's events onto the socket, through a channel so the
/// synchronous `emit` never waits on the network.
struct ChanSink(tokio::sync::mpsc::UnboundedSender<Value>);
impl EventSink for ChanSink {
    fn emit(&self, value: Value) {
        let _ = self.0.send(value);
    }
}

async fn handle(stream: tokio::net::UnixStream, reg: Arc<PtyRegistry>) {
    let (rd, mut wr) = stream.into_split();
    let mut lines = tokio::io::BufReader::new(rd).lines();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    // Everything this connection says goes through one writer task, in order.
    let writer = tokio::spawn(async move {
        while let Some(v) = rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if wr.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    // Set when this connection goes away, which detaches its attach (if any).
    let gone = Arc::new(AtomicBool::new(false));
    let mut attach_task: Option<tokio::task::JoinHandle<()>> = None;

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let s = |k: &str| req[k].as_str().unwrap_or("").to_string();
        let n = |k: &str, d: u64| req[k].as_u64().unwrap_or(d) as u16;
        match req["op"].as_str().unwrap_or("") {
            "hello" => {
                let _ = tx.send(json!({ "v": PROTO, "pid": std::process::id(), "sessions": reg.live_count() }));
            }
            "attach" if attach_task.is_none() => {
                let (reg, sink, gone) = (reg.clone(), ChanSink(tx.clone()), gone.clone());
                let (id, rows, cols) = (s("id"), n("rows", 24), n("cols", 80));
                attach_task = Some(tokio::spawn(async move {
                    if let Err(e) = pty::open_local(id, rows, cols, &reg, &sink, Some(gone)).await {
                        sink.emit(json!({ "type": "error", "message": e }));
                    }
                    sink.emit(json!({ "type": "end" }));
                }));
            }
            "write" => {
                let _ = pty::write_local(&s("id"), &s("data"), &reg);
            }
            "resize" => {
                let _ = pty::resize_local(&s("id"), n("rows", 24), n("cols", 80), &reg);
            }
            "kill" => pty::kill_local(&s("id"), &reg),
            "list" => {
                let _ = tx.send(json!({ "sessions": reg.list() }));
            }
            "exit" => {
                if reg.live_count() == 0 {
                    let _ = std::fs::remove_file(socket_path());
                    std::process::exit(0);
                }
            }
            _ => {}
        }
    }
    // The client hung up: detach, leaving the shell running.
    gone.store(true, Ordering::Relaxed);
    if let Some(t) = attach_task {
        let _ = t.await;
    }
    drop(tx);
    let _ = writer.await;
}

// ---- the app's side -----------------------------------------------------------

/// The app's connection to the terminal service.
pub struct DaemonClient {
    /// One long-lived connection for keystrokes and resizes, so they arrive in
    /// the order they were typed. Reconnected on failure.
    control: Mutex<Option<StdStream>>,
}

impl DaemonClient {
    /// Connect to the running service, starting one if there is none. `None`
    /// means it could not be reached at all; the caller falls back to local.
    pub fn connect_or_spawn() -> Option<Self> {
        if let Some(c) = Self::try_connect() {
            return Some(c);
        }
        spawn_daemon().ok()?;
        for _ in 0..60 {
            std::thread::sleep(Duration::from_millis(50));
            if let Some(c) = Self::try_connect() {
                return Some(c);
            }
        }
        None
    }

    fn try_connect() -> Option<Self> {
        let mut s = StdStream::connect(socket_path()).ok()?;
        s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
        let hello = request(&mut s, json!({ "op": "hello" }))?;
        let v = hello["v"].as_u64().unwrap_or(0);
        if v != PROTO {
            // An older service from before an update. Replace it if it is idle;
            // otherwise its shells matter more than its version, so use it.
            if hello["sessions"].as_u64().unwrap_or(1) == 0 {
                let _ = send_line(&mut s, &json!({ "op": "exit" }));
                // Let it remove its socket before a new one is started.
                std::thread::sleep(Duration::from_millis(300));
                return None;
            }
        }
        Some(Self { control: Mutex::new(Some(s)) })
    }

    /// Fire-and-forget a control message, reconnecting once if the old
    /// connection broke (the service restarted, say).
    pub fn send(&self, msg: Value) -> Result<(), String> {
        let mut guard = self.control.lock().unwrap();
        if let Some(s) = guard.as_mut() {
            if send_line(s, &msg).is_ok() {
                return Ok(());
            }
        }
        let fresh = Self::connect_or_spawn().ok_or("terminal service unavailable")?;
        let mut s = fresh.control.into_inner().unwrap().ok_or("terminal service unavailable")?;
        send_line(&mut s, &msg).map_err(|e| e.to_string())?;
        *guard = Some(s);
        Ok(())
    }

    /// Ask something and wait for the answer, on a connection of its own.
    pub fn ask(&self, msg: Value) -> Option<Value> {
        let mut s = StdStream::connect(socket_path()).ok()?;
        s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
        request(&mut s, msg)
    }

    /// Attach to a session and relay its events until it exits or `cancel`
    /// flips. Same contract as the local `pty_open_core`.
    pub async fn open(
        &self,
        id: String,
        rows: u16,
        cols: u16,
        sink: &dyn EventSink,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<Value, String> {
        let stream = match tokio::net::UnixStream::connect(socket_path()).await {
            Ok(s) => s,
            Err(_) => {
                // The service went away (killed, or the Mac slept through an
                // idle exit). Start it again and try once more.
                tokio::task::spawn_blocking(DaemonClient::connect_or_spawn)
                    .await
                    .ok()
                    .flatten()
                    .ok_or("terminal service unavailable")?;
                tokio::net::UnixStream::connect(socket_path())
                    .await
                    .map_err(|e| format!("terminal service: {e}"))?
            }
        };
        let (rd, mut wr) = stream.into_split();
        let req = json!({ "op": "attach", "id": id, "rows": rows, "cols": cols });
        wr.write_all(format!("{req}\n").as_bytes())
            .await
            .map_err(|e| format!("terminal service: {e}"))?;

        let mut lines = tokio::io::BufReader::new(rd).lines();
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else {
                        // The service died under us: the shell is gone with it.
                        crate::emit_ev(sink, json!({ "type": "exit" }));
                        return Ok(Value::Null);
                    };
                    let Ok(ev) = serde_json::from_str::<Value>(&line) else { continue };
                    match ev["type"].as_str().unwrap_or("") {
                        "end" => return Ok(Value::Null),
                        "error" => return Err(ev["message"].as_str().unwrap_or("terminal error").to_string()),
                        _ => sink.emit(ev),
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(400)) => {
                    if cancel.as_ref().map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
                        // Dropping the connection detaches; the shell runs on.
                        return Ok(Value::Null);
                    }
                }
            }
        }
    }
}

fn send_line(s: &mut StdStream, v: &Value) -> std::io::Result<()> {
    let mut line = v.to_string();
    line.push('\n');
    s.write_all(line.as_bytes())
}

fn request(s: &mut StdStream, v: Value) -> Option<Value> {
    send_line(s, &v).ok()?;
    let mut line = String::new();
    BufReader::new(s.try_clone().ok()?).read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

/// Start the service as a process of its own: new session (setsid), so
/// quitting the app — or the terminal it was launched from, in development —
/// sends it nothing; no inherited stdio; its own log for when things go wrong.
fn spawn_daemon() -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe()?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crate::app_path("ptyd.log"))
        .ok();
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(DAEMON_ARG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(match log {
            Some(f) => std::process::Stdio::from(f),
            None => std::process::Stdio::null(),
        });
    // SAFETY: setsid is async-signal-safe and touches nothing in the parent.
    unsafe {
        cmd.pre_exec(|| {
            libc_setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    // Reap it if it exits while we are still running, so it never lingers as a
    // zombie; the thread is harmless if it outlives nothing.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

extern "C" {
    fn setsid() -> i32;
}

fn libc_setsid() {
    // SAFETY: plain syscall wrapper; failure (already a group leader) is fine.
    unsafe {
        setsid();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    struct Collect(Mutex<Vec<u8>>, AtomicBool);
    impl EventSink for Collect {
        fn emit(&self, v: Value) {
            match v["type"].as_str() {
                Some("data") => {
                    let b = base64::engine::general_purpose::STANDARD
                        .decode(v["data"].as_str().unwrap_or(""))
                        .unwrap_or_default();
                    self.0.lock().unwrap().extend(b);
                }
                Some("exit") => self.1.store(true, Ordering::Relaxed),
                _ => {}
            }
        }
    }
    impl Collect {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    /// The whole point of the service: a client goes away, and the shell —
    /// with what it printed — is still there when the next one attaches.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_shell_survives_its_client_and_replays_on_reattach() {
        let dir = std::env::temp_dir().join(format!("ptyd-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("s.sock");
        // SAFETY: set before any thread here reads it; the variable is only
        // read by this module, and no other test sets it.
        unsafe { std::env::set_var("AI_BOX_PTYD_SOCK", &sock) };
        tokio::spawn(serve());
        let client = {
            let mut c = None;
            for _ in 0..100 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                c = tokio::task::spawn_blocking(DaemonClient::try_connect).await.unwrap();
                if c.is_some() {
                    break;
                }
            }
            Arc::new(c.expect("service answers"))
        };
        let id = format!("ptyd-test-{}", uuid::Uuid::new_v4().simple());

        // First client: open, type, see the output, then go away.
        let first = Arc::new(Collect(Mutex::default(), AtomicBool::new(false)));
        let cancel = Arc::new(AtomicBool::new(false));
        let task = {
            let (client, first, cancel, id) = (client.clone(), first.clone(), cancel.clone(), id.clone());
            tokio::spawn(async move { client.open(id, 24, 80, &*first, Some(cancel)).await })
        };
        tokio::time::sleep(Duration::from_millis(500)).await;
        let enc = |t: &str| base64::engine::general_purpose::STANDARD.encode(t);
        client.send(json!({ "op": "write", "id": id, "data": enc("echo SURVIVES_$((40+2))\r") })).unwrap();
        for _ in 0..50 {
            if first.text().contains("SURVIVES_42") { break }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(first.text().contains("SURVIVES_42"), "first client saw: {}", first.text());
        cancel.store(true, Ordering::Relaxed);
        task.await.unwrap().unwrap();
        assert!(!first.1.load(Ordering::Relaxed), "detaching must not end the shell");

        // The service still has it…
        let listed = client.ask(json!({ "op": "list" })).unwrap();
        assert!(listed["sessions"].as_array().unwrap().iter().any(|v| v == &json!(id)));

        // …and a second client gets the history back from the live shell.
        let second = Arc::new(Collect(Mutex::default(), AtomicBool::new(false)));
        let cancel2 = Arc::new(AtomicBool::new(false));
        let task2 = {
            let (client, second, cancel2, id) = (client.clone(), second.clone(), cancel2.clone(), id.clone());
            tokio::spawn(async move { client.open(id, 24, 80, &*second, Some(cancel2)).await })
        };
        for _ in 0..30 {
            if second.text().contains("SURVIVES_42") { break }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(second.text().contains("SURVIVES_42"), "re-attach replayed: {}", second.text());
        assert!(!second.text().contains("restored from your last session"), "a live shell is not a restore");

        // Closing the tab really ends it.
        client.send(json!({ "op": "kill", "id": id })).unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(5), task2).await;
        assert!(ended.is_ok(), "kill ends the attached stream");
        assert!(second.1.load(Ordering::Relaxed), "and says the shell exited");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
