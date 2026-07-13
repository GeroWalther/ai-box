// Companion HTTP + WebSocket server for phone / remote access.
//
// It serves the SAME built React bundle the desktop webview uses (via Tauri's
// embedded asset resolver) and mirrors the app's commands over the network:
//   POST /rpc/:command   → one-shot commands (JSON in, JSON out)
//   GET  /ws?token=...   → streaming commands multiplexed by request id
//   GET  /*              → the built UI (SPA)
//
// Security: every /rpc and /ws call must carry the shared bearer token. Dangerous
// agent actions (shell, file writes/moves/deletes) are gated by an approval that
// pops up ON THE DESKTOP MAC — the remote device can request, but a human at the
// Mac must approve. Bind is LAN/Tailscale-facing; never port-forward publicly.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::EventSink;

/// Pending remote approvals keyed by id — shared between the axum handlers (which
/// create and await them) and the `resolve_remote_approval` command (which the
/// desktop UI calls to fulfil them).
#[derive(Default, Clone)]
pub struct ApprovalRegistry(Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>);

impl ApprovalRegistry {
    /// Called from the desktop after the user approves/denies on the Mac.
    pub fn resolve(&self, id: &str, approved: bool) {
        if let Some(tx) = self.0.lock().unwrap().remove(id) {
            let _ = tx.send(approved);
        }
    }
    fn register(&self, id: String, tx: oneshot::Sender<bool>) {
        self.0.lock().unwrap().insert(id, tx);
    }
    fn cancel(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

/// Per-request cancellation flags for streaming generation, shared between the
/// task running the stream and the `cancel_generation` command the UI calls when
/// the user hits Stop. Keyed by a client-supplied request id so Stop actually
/// aborts the upstream request (and stops burning cloud credits) instead of just
/// ignoring tokens on the client.
#[derive(Default, Clone)]
pub struct CancelRegistry(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

impl CancelRegistry {
    /// Register a fresh flag for `id` and return it for the stream loop to poll.
    pub fn register(&self, id: String) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().unwrap().insert(id, flag.clone());
        flag
    }
    /// Signal the stream for `id` to stop (called from the desktop when Stop is hit).
    pub fn cancel(&self, id: &str) {
        if let Some(f) = self.0.lock().unwrap().get(id) {
            f.store(true, Ordering::Relaxed);
        }
    }
    pub fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

/// The desktop's current settings (API key, model, generation options, …), pushed
/// from the webview so a paired phone uses the *same* configuration instead of its
/// own empty per-device localStorage. Held as the raw JSON the frontend serializes.
#[derive(Default, Clone)]
pub struct RemoteSettings(Arc<Mutex<Option<String>>>);

impl RemoteSettings {
    pub fn set(&self, json: String) {
        *self.0.lock().unwrap() = Some(json);
    }
    fn value(&self) -> Value {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null)
    }
}

/// Lifecycle handle for the running server (shutdown signal + wake-lock child).
#[derive(Default)]
pub struct RemoteState(Mutex<RemoteInner>);

#[derive(Default)]
struct RemoteInner {
    shutdown: Option<oneshot::Sender<()>>,
    caffeinate: Option<std::process::Child>,
    token: String,
    port: u16,
    running: bool,
}

/// State handed to every axum handler.
#[derive(Clone)]
struct ServerCtx {
    app: AppHandle,
    token: String,
    registry: ApprovalRegistry,
    settings: RemoteSettings,
}

/// Start (or restart) the server. Returns the reachable URLs + token.
pub async fn start(
    app: AppHandle,
    state: &RemoteState,
    registry: &ApprovalRegistry,
    settings: &RemoteSettings,
    port: u16,
    token: String,
    wake_lock: bool,
) -> Result<Value, String> {
    // Tear down any previous instance first.
    stop(state);

    let ctx = ServerCtx {
        app: app.clone(),
        token: token.clone(),
        registry: registry.clone(),
        settings: settings.clone(),
    };
    let router = Router::new()
        .route("/rpc/:command", post(rpc))
        .route("/ws", get(ws_upgrade))
        .fallback(get(serve_asset))
        .with_state(ctx);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Could not bind port {port}: {e}"))?;

    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });

    // Away mode: keep the Mac awake (but let the display sleep) while serving.
    // `-w <pid>` makes caffeinate exit automatically if the app quits, so the
    // wake-lock can't outlive the process even if `stop` is never called.
    let caffeinate = if wake_lock {
        std::process::Command::new("caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .spawn()
            .ok()
    } else {
        None
    };

    {
        let mut inner = state.0.lock().unwrap();
        inner.shutdown = Some(tx);
        inner.caffeinate = caffeinate;
        inner.token = token;
        inner.port = port;
        inner.running = true;
    }

    Ok(urls(state))
}

/// Stop the server and release the wake-lock.
pub fn stop(state: &RemoteState) {
    let mut inner = state.0.lock().unwrap();
    if let Some(tx) = inner.shutdown.take() {
        let _ = tx.send(());
    }
    if let Some(mut child) = inner.caffeinate.take() {
        let _ = child.kill();
    }
    inner.running = false;
}

/// Reachable URLs (LAN + Tailscale) plus token / running state, for the UI + QR.
pub fn urls(state: &RemoteState) -> Value {
    let inner = state.0.lock().unwrap();
    let port = if inner.port == 0 { 8787 } else { inner.port };
    let lan = local_ip_address::local_ip()
        .ok()
        .map(|ip| format!("http://{ip}:{port}"));
    let tailscale = tailscale_ip().map(|ip| format!("http://{ip}:{port}"));
    json!({
        "running": inner.running,
        "port": port,
        "token": inner.token,
        "lan": lan,
        "tailscale": tailscale,
    })
}

/// Best-effort Tailscale IPv4 lookup (the CLI often isn't on a GUI app's PATH).
fn tailscale_ip() -> Option<String> {
    let candidates = [
        "tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ];
    for bin in candidates {
        if let Ok(out) = std::process::Command::new(bin).args(["ip", "-4"]).output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                if let Some(line) = s.lines().next() {
                    let ip = line.trim();
                    if !ip.is_empty() {
                        return Some(ip.to_string());
                    }
                }
            }
        }
    }
    None
}

// ---- auth ----------------------------------------------------------------

/// Length-independent-leak-only constant-time byte comparison (guards the token
/// check against timing side-channels).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn authorized(ctx: &ServerCtx, headers: &HeaderMap) -> bool {
    if ctx.token.is_empty() {
        return false; // fail closed — never serve command endpoints without a token
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim());
    match bearer {
        Some(b) => constant_time_eq(b.as_bytes(), ctx.token.as_bytes()),
        None => false,
    }
}

// ---- remote filesystem confinement ---------------------------------------

/// Root the remote (phone) filesystem tools are confined to. Desktop/local access
/// is unrestricted; only network callers are jailed here so a paired device can't
/// read ~/.ssh, ~/.aws, etc. Honours a `remoteWorkspace` field pushed in the
/// desktop settings, else defaults to ~/Documents.
fn workspace_root(ctx: &ServerCtx) -> std::path::PathBuf {
    let configured = ctx
        .settings
        .value()
        .get("remoteWorkspace")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let raw = configured.unwrap_or_else(|| format!("{home}/Documents"));
    let expanded = if raw == "~" {
        home.clone()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        raw
    };
    let p = std::path::PathBuf::from(&expanded);
    p.canonicalize().unwrap_or(p)
}

/// Nearest ancestor of `p` that exists on disk (so we can canonicalize a path that
/// doesn't exist yet, e.g. a file about to be written).
fn nearest_existing(p: &std::path::Path) -> std::path::PathBuf {
    let mut cur = p;
    loop {
        if cur.exists() {
            return cur.to_path_buf();
        }
        match cur.parent() {
            Some(parent) => cur = parent,
            None => return std::path::PathBuf::from("/"),
        }
    }
}

/// Resolve a remote-supplied path inside the workspace root, rejecting `~`, `..`,
/// and anything that canonicalizes outside the root (defeats symlink escapes).
/// Relative paths are taken relative to the root. Returns an absolute path string.
fn confine(ctx: &ServerCtx, path: &str) -> Result<String, String> {
    if path.contains('~') {
        return Err("remote paths can't use ~".into());
    }
    let root = workspace_root(ctx);
    let candidate = std::path::Path::new(path);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    if joined
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("remote paths can't contain ..".into());
    }
    let canon = nearest_existing(&joined)
        .canonicalize()
        .map_err(|e| format!("bad path: {e}"))?;
    if !canon.starts_with(&root) {
        return Err("path is outside the remote workspace".into());
    }
    Ok(joined.to_string_lossy().to_string())
}

/// Block until the desktop user approves (or denies / times out) an action.
async fn require_approval(ctx: &ServerCtx, title: &str, body: &str) -> Result<(), String> {
    require_approval_diff(ctx, title, body, None).await
}

/// Like `require_approval`, but also sends a `diff` preview so the human at the Mac
/// sees exactly what a file write/edit will change before approving.
async fn require_approval_diff(
    ctx: &ServerCtx,
    title: &str,
    body: &str,
    diff: Option<String>,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<bool>();
    ctx.registry.register(id.clone(), tx);
    let _ = ctx.app.emit(
        "remote-approval",
        json!({ "id": id, "title": title, "body": body, "diff": diff }),
    );
    match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err("Denied on the desktop Mac".to_string()),
        _ => {
            ctx.registry.cancel(&id);
            Err("No response on the desktop Mac (approval timed out)".to_string())
        }
    }
}

/// A capped, naive line-level diff for the approval preview: old lines as `-`,
/// new lines as `+`. Good enough to see what an edit/overwrite does.
fn preview_diff(old: &str, new: &str) -> String {
    const MAX: usize = 200;
    let mut out = String::new();
    for l in old.lines().take(MAX) {
        out.push_str("- ");
        out.push_str(l);
        out.push('\n');
    }
    if old.lines().count() > MAX {
        out.push_str("… (truncated)\n");
    }
    for l in new.lines().take(MAX) {
        out.push_str("+ ");
        out.push_str(l);
        out.push('\n');
    }
    if new.lines().count() > MAX {
        out.push_str("… (truncated)\n");
    }
    out
}

// ---- API-key confidentiality ---------------------------------------------

/// Placeholder the phone sees in place of a real key: non-empty so the UI's
/// "is a key configured?" checks pass, but never the actual secret. The server
/// treats it as "empty" and injects the Mac's real key.
const REMOTE_KEY_SENTINEL: &str = "__stored-on-mac__";

fn is_placeholder_or_empty(k: &str) -> bool {
    k.is_empty() || k == REMOTE_KEY_SENTINEL
}

/// Strip secrets from the settings blob before it's ever sent to a paired device.
/// A configured key becomes a non-empty sentinel (so the phone knows one exists)
/// but never the real value; the pairing token is removed outright. Provider calls
/// run on the Mac, which injects the real key, so it never traverses the LAN or
/// lives in the phone's storage.
fn strip_secrets(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        for k in ["openrouterKey", "customKey"] {
            let configured = o.get(k).and_then(|x| x.as_str()).map_or(false, |s| !s.is_empty());
            o.insert(
                k.into(),
                Value::String(if configured { REMOTE_KEY_SENTINEL.into() } else { String::new() }),
            );
        }
        o.remove("remoteToken");
    }
    v
}

/// The Mac's own API key appropriate for `base_url` (OpenRouter vs. a custom
/// OpenAI-compatible endpoint), read from the desktop-pushed `settings` JSON.
fn mac_key_for(settings: &Value, base_url: &str) -> String {
    let pick = |k: &str| settings.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    if base_url.contains("openrouter.ai") {
        pick("openrouterKey")
    } else {
        let custom = pick("customKey");
        if custom.is_empty() {
            pick("openrouterKey")
        } else {
            custom
        }
    }
}

/// Fill in `params.apiKey` with `key` when the incoming key is empty.
fn inject_key_value(mut args: Value, key: &str) -> Value {
    if !key.is_empty() {
        if let Some(params) = args.get_mut("params").and_then(|p| p.as_object_mut()) {
            let needs = params
                .get("apiKey")
                .and_then(|v| v.as_str())
                .map_or(true, is_placeholder_or_empty);
            if needs {
                params.insert("apiKey".into(), Value::String(key.to_string()));
            }
        }
    }
    args
}

/// Inject the Mac's key chosen by `params.baseUrl` (for chat/text calls that carry
/// a base URL). The phone never needs — or receives — the key.
fn inject_key(ctx: &ServerCtx, args: Value) -> Value {
    let base = args
        .get("params")
        .and_then(|p| p.get("baseUrl"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let key = mac_key_for(&ctx.settings.value(), base);
    inject_key_value(args, &key)
}

// ---- /rpc (one-shot commands) --------------------------------------------

async fn rpc(
    State(ctx): State<ServerCtx>,
    Path(command): Path<String>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> Response {
    if !authorized(&ctx, &headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    match dispatch_rpc(&ctx, &command, args).await {
        Ok(v) => Json(json!({ "result": v })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

/// Deserialize the `params` object commands receive (mirrors `invoke(name, {params})`).
fn params<T: DeserializeOwned>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.get("params").cloned().unwrap_or(Value::Null))
        .map_err(|e| e.to_string())
}

async fn dispatch_rpc(ctx: &ServerCtx, command: &str, args: Value) -> Result<Value, String> {
    let s = |key: &str| {
        args.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match command {
        // --- text / models (safe) — the Mac injects its own key ---
        "chat_completion" => crate::chat_completion(params(&inject_key(ctx, args.clone()))?).await,
        "list_openrouter_models" => {
            let mut key = args.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if is_placeholder_or_empty(&key) {
                key = mac_key_for(&ctx.settings.value(), "https://openrouter.ai");
            }
            let key = if key.is_empty() { None } else { Some(key) };
            serde_json::to_value(crate::list_openrouter_models(key).await?).map_err(|e| e.to_string())
        }
        "list_ollama_models" => Ok(json!(crate::list_ollama_models(s("baseUrl")).await?)),
        "list_comfy_checkpoints" => Ok(json!(crate::list_comfy_checkpoints(s("baseUrl")).await?)),
        "system_info" => Ok(crate::system_info()),
        // The desktop's settings, so a paired phone adopts the same model/options —
        // but with secrets (API key, token) stripped: the key never leaves the Mac.
        "get_remote_settings" => Ok(strip_secrets(ctx.settings.value())),
        // Shared key/value store (chat history), same on desktop and phone.
        "remote_store_get" => {
            Ok(crate::remote_store_get(s("key")).map(Value::String).unwrap_or(Value::Null))
        }
        "remote_store_set" => {
            crate::remote_store_set(s("key"), s("value"))?;
            Ok(Value::Null)
        }
        // Shared image gallery (files on the Mac), same on desktop and phone.
        "image_put" => {
            crate::image_put(s("id"), s("record"))?;
            Ok(Value::Null)
        }
        "image_list" => Ok(Value::Array(crate::image_list())),
        "image_get" => Ok(crate::image_get(s("id")).map(Value::String).unwrap_or(Value::Null)),
        "image_delete" => {
            crate::image_delete(s("id"))?;
            Ok(Value::Null)
        }
        // --- image generation (safe) ---
        "generate_image" => Ok(Value::String(crate::generate_image(params(&args)?).await?)),
        "generate_image_comfy" => Ok(Value::String(crate::generate_image_comfy(params(&args)?).await?)),
        "generate_img2img_comfy" => {
            Ok(Value::String(crate::generate_img2img_comfy(params(&args)?).await?))
        }
        "generate_image_openrouter" => {
            let a = inject_key_value(args.clone(), &mac_key_for(&ctx.settings.value(), "https://openrouter.ai"));
            Ok(Value::String(crate::generate_image_openrouter(params(&a)?).await?))
        }
        "edit_image_openrouter" => {
            let a = inject_key_value(args.clone(), &mac_key_for(&ctx.settings.value(), "https://openrouter.ai"));
            Ok(Value::String(crate::edit_image_openrouter(params(&a)?).await?))
        }
        // --- filesystem / web (read-only, confined to the workspace root) ---
        "fs_read" => Ok(Value::String(crate::fs_read(confine(ctx, &s("path"))?)?)),
        "fs_list" => Ok(json!(crate::fs_list(confine(ctx, &s("path"))?)?)),
        "fs_search" => {
            let kind = args.get("kind").and_then(|v| v.as_str()).map(|s| s.to_string());
            Ok(json!(crate::fs_search(confine(ctx, &s("root"))?, s("query"), kind)?))
        }
        "web_fetch" => Ok(Value::String(crate::web_fetch(s("url")).await?)),
        // --- dangerous → confined AND approved on the Mac ---
        "fs_write" => {
            let path = confine(ctx, &s("path"))?;
            let old = std::fs::read_to_string(&path).unwrap_or_default();
            let diff = preview_diff(&old, &s("content"));
            let title = if old.is_empty() { "Create a file?" } else { "Overwrite a file?" };
            require_approval_diff(ctx, title, &path, Some(diff)).await?;
            Ok(Value::String(crate::fs_write(path, s("content"))?))
        }
        "fs_edit" => {
            let path = confine(ctx, &s("path"))?;
            let diff = preview_diff(&s("old"), &s("new"));
            require_approval_diff(ctx, "Edit a file?", &path, Some(diff)).await?;
            crate::fs_edit(path, s("old"), s("new"))
        }
        "fs_move" => {
            let from = confine(ctx, &s("from"))?;
            let to = confine(ctx, &s("to"))?;
            require_approval(ctx, "Move a file?", &format!("{from}\n→ {to}")).await?;
            Ok(Value::String(crate::fs_move(from, to)?))
        }
        "fs_delete" => {
            let path = confine(ctx, &s("path"))?;
            require_approval(ctx, "Delete this path?", &path).await?;
            Ok(Value::String(crate::fs_delete(path)?))
        }
        "run_command" => {
            require_approval(ctx, "Run this command?", &s("command")).await?;
            crate::run_command(s("command")).await
        }
        other => Err(format!("unknown or non-RPC command: {other}")),
    }
}

// ---- /ws (streaming commands) --------------------------------------------

#[derive(serde::Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn ws_upgrade(
    State(ctx): State<ServerCtx>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    // Fail closed: an empty configured token never authorizes, and the supplied
    // token is compared in constant time.
    let ok = !ctx.token.is_empty()
        && q
            .token
            .as_deref()
            .map(|t| constant_time_eq(t.as_bytes(), ctx.token.as_bytes()))
            .unwrap_or(false);
    if !ok {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.on_upgrade(move |socket| handle_ws(socket, ctx))
}

/// EventSink that frames streamed events as `{id, event}` onto the WebSocket.
struct WsSink {
    id: u64,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
}
impl EventSink for WsSink {
    fn emit(&self, value: Value) {
        let frame = json!({ "id": self.id, "event": value });
        let _ = self.tx.send(frame.to_string());
    }
}

async fn handle_ws(socket: WebSocket, ctx: ServerCtx) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Single writer drains the outbound queue to the socket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Cancellation flags for in-flight streaming generations on THIS connection,
    // keyed by the client's request id, so a `cancel_generation` frame can abort a
    // running `generate_text`.
    let cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> = Arc::new(Mutex::new(HashMap::new()));

    while let Some(Ok(msg)) = receiver.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let req: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = req["id"].as_u64().unwrap_or(0);
        let command = req["command"].as_str().unwrap_or("").to_string();
        let cmd_args = req["args"].clone();

        // Cancel is handled inline (don't spawn): flip the target request's flag.
        if command == "cancel_generation" {
            if let Some(rid) = cmd_args.get("targetRequestId").and_then(|v| v.as_str()) {
                if let Some(f) = cancels.lock().unwrap().get(rid) {
                    f.store(true, Ordering::Relaxed);
                }
            }
            let _ = tx.send(json!({ "id": id, "done": true, "result": Value::Null }).to_string());
            continue;
        }

        // For a streaming generation, register a cancel flag under its request id.
        let cancel = if command == "generate_text" {
            cmd_args.get("requestId").and_then(|v| v.as_str()).map(|rid| {
                let f = Arc::new(AtomicBool::new(false));
                cancels.lock().unwrap().insert(rid.to_string(), f.clone());
                (rid.to_string(), f)
            })
        } else {
            None
        };

        let ctx2 = ctx.clone();
        let tx2 = tx.clone();
        let cancels2 = cancels.clone();
        // Each request runs concurrently; results are multiplexed by id.
        tokio::spawn(async move {
            let sink = WsSink { id, tx: tx2.clone() };
            let flag = cancel.as_ref().map(|(_, f)| f.clone());
            let frame = match dispatch_ws(&ctx2, &command, cmd_args, &sink, flag).await {
                Ok(v) => json!({ "id": id, "done": true, "result": v }),
                Err(e) => json!({ "id": id, "done": true, "error": e }),
            };
            if let Some((rid, _)) = cancel {
                cancels2.lock().unwrap().remove(&rid);
            }
            let _ = tx2.send(frame.to_string());
        });
    }

    drop(tx);
    let _ = writer.await;
}

async fn dispatch_ws(
    ctx: &ServerCtx,
    command: &str,
    args: Value,
    sink: &dyn EventSink,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<Value, String> {
    let s = |key: &str| {
        args.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match command {
        "generate_text" => {
            crate::generate_text_core(params(&inject_key(ctx, args.clone()))?, sink, cancel).await?;
            Ok(Value::Null)
        }
        "pull_ollama_model" => {
            crate::pull_ollama_model_core(s("baseUrl"), s("model"), sink).await?;
            Ok(Value::Null)
        }
        "download_file" => {
            let dest = confine(ctx, &s("dest"))?;
            require_approval(ctx, "Download a file?", &format!("{}\n→ {dest}", s("url"))).await?;
            crate::download_file_core(s("url"), dest, sink).await?;
            Ok(Value::Null)
        }
        "run_command_stream" => {
            require_approval(ctx, "Run this command?", &s("command")).await?;
            let timeout = args.get("timeoutSecs").and_then(|v| v.as_u64());
            crate::run_command_stream_core(s("command"), timeout, sink).await
        }
        other => Err(format!("unknown streaming command: {other}")),
    }
}

// ---- static UI (the built React bundle, embedded by Tauri) ----------------

async fn serve_asset(State(ctx): State<ServerCtx>, uri: Uri) -> Response {
    let raw = uri.path().trim_start_matches('/');
    let path = if raw.is_empty() { "index.html" } else { raw };
    let resolver = ctx.app.asset_resolver();
    // Tauri keys assets with a leading slash; try a few forms then fall back to
    // index.html so client-side routes still load (SPA).
    let asset = resolver
        .get(format!("/{path}"))
        .or_else(|| resolver.get(path.to_string()))
        .or_else(|| resolver.get("/index.html".to_string()))
        .or_else(|| resolver.get("index.html".to_string()));
    if let Some(a) = asset {
        return ([(header::CONTENT_TYPE, a.mime_type)], a.bytes).into_response();
    }
    // In `tauri dev` the embedded assets are empty (the webview uses the Vite dev
    // server), so fall back to the built `dist/` on disk if present — this makes
    // remote access testable in dev after a one-time `npm run build`.
    if let Some(resp) = serve_from_dist(path) {
        return resp;
    }
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// Serve a file from a nearby `dist/` directory (dev fallback). Guards against
/// path traversal by rejecting any `..` component.
fn serve_from_dist(path: &str) -> Option<Response> {
    if path.split('/').any(|seg| seg == "..") {
        return None;
    }
    let candidates = ["../dist", "dist", "../../dist"];
    for base in candidates {
        let dir = std::path::Path::new(base);
        if !dir.join("index.html").exists() {
            continue;
        }
        let file = dir.join(path);
        let bytes = std::fs::read(&file)
            .ok()
            .or_else(|| std::fs::read(dir.join("index.html")).ok())?;
        let mime = mime_for(&file);
        return Some(([(header::CONTENT_TYPE, mime)], bytes).into_response());
    }
    None
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_secrets_masks_keys_and_removes_token() {
        let input = json!({
            "openrouterKey": "sk-real-secret",
            "customKey": "",
            "remoteToken": "tok-123",
            "model": "anthropic/claude-fable-5",
        });
        let out = strip_secrets(input);
        // A configured key becomes the sentinel, never the real value.
        assert_eq!(out["openrouterKey"], REMOTE_KEY_SENTINEL);
        assert!(!out.to_string().contains("sk-real-secret"));
        // An unset key stays empty; the token is removed entirely.
        assert_eq!(out["customKey"], "");
        assert!(out.get("remoteToken").is_none());
        // Non-secret settings survive.
        assert_eq!(out["model"], "anthropic/claude-fable-5");
    }

    #[test]
    fn mac_key_for_picks_by_base_url() {
        let s = json!({ "openrouterKey": "sk-or", "customKey": "sk-cust" });
        assert_eq!(mac_key_for(&s, "https://openrouter.ai/api/v1"), "sk-or");
        assert_eq!(mac_key_for(&s, "http://my-proxy.local/v1"), "sk-cust");
        // With no custom key, a custom endpoint falls back to the OpenRouter key.
        let s2 = json!({ "openrouterKey": "sk-or", "customKey": "" });
        assert_eq!(mac_key_for(&s2, "http://my-proxy.local/v1"), "sk-or");
    }

    #[test]
    fn inject_key_value_fills_placeholder_and_empty_only() {
        let key = "sk-injected";
        // Empty apiKey → filled.
        let a = inject_key_value(json!({ "params": { "apiKey": "" } }), key);
        assert_eq!(a["params"]["apiKey"], "sk-injected");
        // Sentinel apiKey (what the phone holds) → filled.
        let b = inject_key_value(json!({ "params": { "apiKey": REMOTE_KEY_SENTINEL } }), key);
        assert_eq!(b["params"]["apiKey"], "sk-injected");
        // A real key the caller set → left untouched.
        let c = inject_key_value(json!({ "params": { "apiKey": "sk-caller" } }), key);
        assert_eq!(c["params"]["apiKey"], "sk-caller");
        // No key to inject → unchanged.
        let d = inject_key_value(json!({ "params": { "apiKey": "" } }), "");
        assert_eq!(d["params"]["apiKey"], "");
    }
}
