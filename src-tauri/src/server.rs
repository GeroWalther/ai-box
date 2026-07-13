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

fn authorized(ctx: &ServerCtx, headers: &HeaderMap) -> bool {
    if ctx.token.is_empty() {
        return true; // no token configured → open (LAN-only dev)
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim());
    bearer == Some(ctx.token.as_str())
}

/// Block until the desktop user approves (or denies / times out) an action.
async fn require_approval(ctx: &ServerCtx, title: &str, body: &str) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<bool>();
    ctx.registry.register(id.clone(), tx);
    let _ = ctx.app.emit(
        "remote-approval",
        json!({ "id": id, "title": title, "body": body }),
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
        // --- text / models (safe) ---
        "chat_completion" => crate::chat_completion(params(&args)?).await,
        "list_openrouter_models" => {
            let key = args.get("apiKey").and_then(|v| v.as_str()).map(|s| s.to_string());
            serde_json::to_value(crate::list_openrouter_models(key).await?).map_err(|e| e.to_string())
        }
        "list_ollama_models" => Ok(json!(crate::list_ollama_models(s("baseUrl")).await?)),
        "list_comfy_checkpoints" => Ok(json!(crate::list_comfy_checkpoints(s("baseUrl")).await?)),
        "system_info" => Ok(crate::system_info()),
        // The desktop's settings, so a paired phone adopts the same key/model/etc.
        "get_remote_settings" => Ok(ctx.settings.value()),
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
            Ok(Value::String(crate::generate_image_openrouter(params(&args)?).await?))
        }
        "edit_image_openrouter" => {
            Ok(Value::String(crate::edit_image_openrouter(params(&args)?).await?))
        }
        // --- filesystem / web (read-only, safe) ---
        "fs_read" => Ok(Value::String(crate::fs_read(s("path"))?)),
        "fs_list" => Ok(json!(crate::fs_list(s("path"))?)),
        "fs_search" => {
            let kind = args.get("kind").and_then(|v| v.as_str()).map(|s| s.to_string());
            Ok(json!(crate::fs_search(s("root"), s("query"), kind)?))
        }
        "web_fetch" => Ok(Value::String(crate::web_fetch(s("url")).await?)),
        // --- dangerous → approve on the Mac ---
        "fs_write" => {
            require_approval(ctx, "Write a file?", &s("path")).await?;
            Ok(Value::String(crate::fs_write(s("path"), s("content"))?))
        }
        "fs_edit" => {
            require_approval(ctx, "Edit a file?", &s("path")).await?;
            crate::fs_edit(s("path"), s("old"), s("new"))
        }
        "fs_move" => {
            require_approval(ctx, "Move a file?", &format!("{}\n→ {}", s("from"), s("to"))).await?;
            Ok(Value::String(crate::fs_move(s("from"), s("to"))?))
        }
        "fs_delete" => {
            require_approval(ctx, "Delete this path?", &s("path")).await?;
            Ok(Value::String(crate::fs_delete(s("path"))?))
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
    if !ctx.token.is_empty() && q.token.as_deref() != Some(ctx.token.as_str()) {
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
        let ctx2 = ctx.clone();
        let tx2 = tx.clone();
        // Each request runs concurrently; results are multiplexed by id.
        tokio::spawn(async move {
            let sink = WsSink { id, tx: tx2.clone() };
            let frame = match dispatch_ws(&ctx2, &command, cmd_args, &sink).await {
                Ok(v) => json!({ "id": id, "done": true, "result": v }),
                Err(e) => json!({ "id": id, "done": true, "error": e }),
            };
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
) -> Result<Value, String> {
    let s = |key: &str| {
        args.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match command {
        "generate_text" => {
            crate::generate_text_core(params(&args)?, sink).await?;
            Ok(Value::Null)
        }
        "pull_ollama_model" => {
            crate::pull_ollama_model_core(s("baseUrl"), s("model"), sink).await?;
            Ok(Value::Null)
        }
        "download_file" => {
            crate::download_file_core(s("url"), s("dest"), sink).await?;
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
