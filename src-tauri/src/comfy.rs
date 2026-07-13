// Managed local image generation: install and run ComfyUI without the user ever
// touching a terminal. We fetch a pinned uv (Python toolchain), a pinned ComfyUI
// release, build a venv with its deps (PyTorch ships MPS-capable wheels on macOS),
// download a curated checkpoint, then start/stop ComfyUI as a child process.
//
// Everything lives under ~/.ai-studio/comfy so it's isolated from any hand-rolled
// ComfyUI the user may already have. These commands are desktop-only (never
// exposed over the companion server) — a phone can't drive a Mac subprocess.

use crate::{expand_path, EventSink};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

// Pinned versions — bump deliberately, never track "latest" at runtime.
const UV_VERSION: &str = "0.11.28";
const COMFY_TAG: &str = "v0.27.1";
pub const COMFY_PORT: u16 = 8188;

fn base_dir() -> String {
    expand_path("~/.ai-studio/comfy")
}
fn src_dir() -> String {
    format!("{}/ComfyUI", base_dir())
}
fn venv_python() -> String {
    format!("{}/venv/bin/python", src_dir())
}
fn uv_bin() -> String {
    format!("{}/bin/uv", base_dir())
}
fn checkpoints_dir() -> String {
    format!("{}/models/checkpoints", src_dir())
}

/// True once the runtime is fully installed (source + venv). Model presence is a
/// separate concern surfaced via `list_comfy_checkpoints`.
pub fn is_installed() -> bool {
    Path::new(&format!("{}/main.py", src_dir())).exists() && Path::new(&venv_python()).exists()
}

/// Health-probe a ComfyUI instance. Reused to detect either our managed process
/// or a ComfyUI the user started themselves on the same port.
pub async fn probe(url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(format!("{}/system_stats", url.trim_end_matches('/')))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

// ---- Progress events -----------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// One of: uv | source | deps | model | done
    stage: String,
    message: String,
    /// 0-100 for downloads; absent for indeterminate steps.
    pct: Option<u64>,
}

fn emit(sink: &dyn EventSink, stage: &str, message: impl Into<String>, pct: Option<u64>) {
    crate::emit_ev(
        sink,
        Progress {
            stage: stage.into(),
            message: message.into(),
            pct,
        },
    );
}

// ---- Setup ---------------------------------------------------------------

/// Checkpoints already downloaded into the managed install.
pub fn installed_models() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(checkpoints_dir()) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".safetensors") || name.ends_with(".ckpt") {
                out.push(name);
            }
        }
    }
    out.sort();
    out
}

/// Install the ComfyUI runtime (Python toolchain, ComfyUI, venv + PyTorch) — no
/// model. Idempotent: each step is skipped if already present, so it's cheap to
/// call before every model download and resumes cleanly after a failure.
pub async fn ensure_runtime(sink: &dyn EventSink) -> Result<(), String> {
    let base = base_dir();
    let src = src_dir();
    std::fs::create_dir_all(format!("{base}/bin")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&checkpoints_dir()).map_err(|e| e.to_string())?;

    // 1. uv (Python toolchain) — a single static binary.
    if !Path::new(&uv_bin()).exists() {
        emit(sink, "uv", "Setting up the Python toolchain…", None);
        ensure_uv(sink).await?;
    }

    // 2. ComfyUI source (pinned release tarball, extracted flat into src/).
    if !Path::new(&format!("{src}/main.py")).exists() {
        emit(sink, "source", format!("Downloading ComfyUI {COMFY_TAG}…"), None);
        let tarball = format!(
            "https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/{COMFY_TAG}.tar.gz"
        );
        let tmp = format!("{base}/comfyui-src.tar.gz");
        download_with_progress(&tarball, &tmp, "source", sink).await?;
        std::fs::create_dir_all(&src).map_err(|e| e.to_string())?;
        emit(sink, "source", "Extracting ComfyUI…", None);
        run_streamed(
            tokio::process::Command::new("tar")
                .arg("-xzf")
                .arg(&tmp)
                .arg("--strip-components=1")
                .arg("-C")
                .arg(&src),
            "source",
            sink,
        )
        .await?;
        let _ = std::fs::remove_file(&tmp);
    }

    // 3. Virtualenv + dependencies (PyTorch etc. — the big, slow step).
    if !Path::new(&venv_python()).exists() {
        emit(sink, "deps", "Creating the Python environment…", None);
        run_streamed(
            tokio::process::Command::new(uv_bin())
                .arg("venv")
                .arg("--python")
                .arg("3.11")
                .arg(format!("{src}/venv")),
            "deps",
            sink,
        )
        .await?;
    }
    emit(
        sink,
        "deps",
        "Installing PyTorch + ComfyUI dependencies — this is the big one, grab a coffee…",
        None,
    );
    run_streamed(
        tokio::process::Command::new(uv_bin())
            .arg("pip")
            .arg("install")
            .arg("--python")
            .arg(venv_python())
            .arg("-r")
            .arg(format!("{src}/requirements.txt")),
        "deps",
        sink,
    )
    .await?;
    Ok(())
}

/// Ensure the runtime, then download one checkpoint into the managed install.
/// This is the single entry point behind every model in the library — the first
/// download bootstraps the runtime, later ones just fetch the file.
pub async fn download_model(
    model_url: String,
    model_name: String,
    sink: &dyn EventSink,
) -> Result<(), String> {
    ensure_runtime(sink).await?;
    let safe_name = sanitize_filename(&model_name);
    let ckpt = format!("{}/{safe_name}", checkpoints_dir());
    if !Path::new(&ckpt).exists() {
        emit(sink, "model", format!("Downloading model ({safe_name})…"), Some(0));
        download_with_progress(&model_url, &ckpt, "model", sink).await?;
    }
    emit(sink, "done", "Ready.", Some(100));
    Ok(())
}

/// Reject path separators / traversal in a user-supplied filename.
fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        "model.safetensors".into()
    } else if cleaned.ends_with(".safetensors") {
        cleaned
    } else {
        format!("{cleaned}.safetensors")
    }
}

async fn ensure_uv(sink: &dyn EventSink) -> Result<(), String> {
    let arch = if std::env::consts::ARCH == "aarch64" {
        "aarch64"
    } else {
        "x86_64"
    };
    let url = format!(
        "https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-{arch}-apple-darwin.tar.gz"
    );
    let tmp = format!("{}/uv.tar.gz", base_dir());
    download_with_progress(&url, &tmp, "uv", sink).await?;
    // Extracts uv + uvx flat into bin/.
    run_streamed(
        tokio::process::Command::new("tar")
            .arg("-xzf")
            .arg(&tmp)
            .arg("--strip-components=1")
            .arg("-C")
            .arg(format!("{}/bin", base_dir())),
        "uv",
        sink,
    )
    .await?;
    let _ = std::fs::remove_file(&tmp);
    // Downloaded binaries may carry a quarantine xattr → clear it so it runs.
    let _ = std::process::Command::new("xattr")
        .args(["-dr", "com.apple.quarantine", &uv_bin()])
        .status();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(uv_bin()) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            let _ = std::fs::set_permissions(uv_bin(), perm);
        }
    }
    Ok(())
}

/// Stream a subprocess's stdout+stderr to the UI as progress lines; error on
/// non-zero exit.
async fn run_streamed(
    cmd: &mut tokio::process::Command,
    stage: &str,
    sink: &dyn EventSink,
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to launch: {e}"))?;
    // Drain stdout AND stderr concurrently — pip/uv write progress to stderr, and
    // reading one to EOF first would deadlock once the other's pipe buffer fills.
    let mut out = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut err = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
    let mut out_alive = true;
    let mut err_alive = true;
    loop {
        tokio::select! {
            res = out.next_line(), if out_alive => match res {
                Ok(Some(line)) => { if !line.trim().is_empty() { emit(sink, stage, line, None); } }
                _ => out_alive = false,
            },
            res = err.next_line(), if err_alive => match res {
                Ok(Some(line)) => { if !line.trim().is_empty() { emit(sink, stage, line, None); } }
                _ => err_alive = false,
            },
            else => break,
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "step '{stage}' failed (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

const DOWNLOAD_UA: &str =
    "AIStudio/0.1 (+https://github.com/GeroWalther/novel-studio)";
const MAX_DL_ATTEMPTS: u32 = 5;

/// Transient HTTP statuses worth retrying. 403 is included because Hugging Face's
/// large-file CDN signals rate-limiting with a 403 that clears on its own.
fn is_transient_status(code: u16) -> bool {
    matches!(code, 403 | 408 | 425 | 429 | 500..=599)
}

/// Download a URL to `dest` with a `.part` staging file (so an interrupted
/// download never looks complete). Sends a User-Agent, retries transient failures
/// with backoff, and RESUMES from the partial file via a Range request rather than
/// restarting a multi-GB download from zero.
async fn download_with_progress(
    url: &str,
    dest: &str,
    stage: &str,
    sink: &dyn EventSink,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;
    crate::validate_public_url(url)?;
    if let Some(parent) = Path::new(dest).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .user_agent(DOWNLOAD_UA)
        .build()
        .map_err(|e| e.to_string())?;
    let part = format!("{dest}.part");

    let mut attempt = 0u32;
    loop {
        attempt += 1;
        // Resume: if a partial file exists, ask only for the remaining bytes.
        let have: u64 = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let mut req = client.get(url);
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                if attempt < MAX_DL_ATTEMPTS {
                    emit(sink, stage, format!("connection issue — retrying ({attempt})…"), None);
                    tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                    continue;
                }
                return Err(format!("download failed: {e}"));
            }
        };

        let status = resp.status();
        // Decide how to open the part file based on the server's response.
        let (mut file, mut done, total) = if have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT
        {
            let f = std::fs::OpenOptions::new()
                .append(true)
                .open(&part)
                .map_err(|e| format!("open {part}: {e}"))?;
            let remaining = resp.content_length().unwrap_or(0);
            (f, have, have + remaining)
        } else if status.is_success() {
            // Server ignored the range (or fresh start) — write from scratch.
            let f = std::fs::File::create(&part).map_err(|e| format!("create {part}: {e}"))?;
            (f, 0u64, resp.content_length().unwrap_or(0))
        } else if is_transient_status(status.as_u16()) && attempt < MAX_DL_ATTEMPTS {
            let hint = if status.as_u16() == 403 {
                " (host is rate-limiting; waiting)"
            } else {
                ""
            };
            emit(sink, stage, format!("HTTP {}{hint} — retrying ({attempt})…", status.as_u16()), None);
            tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
            continue;
        } else {
            let _ = std::fs::remove_file(&part);
            if status.as_u16() == 403 {
                return Err("download blocked (HTTP 403) — the model host is rate-limiting this network. Wait a few minutes and try again.".into());
            }
            return Err(format!("download failed: HTTP {}", status.as_u16()));
        };

        // Stream the body; on a mid-stream error, keep the .part and retry (resume).
        let mut stream = resp.bytes_stream();
        let mut last_pct: u64 = u64::MAX;
        let mut stream_err = false;
        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(_) => {
                    stream_err = true;
                    break;
                }
            };
            if file.write_all(&bytes).is_err() {
                stream_err = true;
                break;
            }
            done += bytes.len() as u64;
            if total > 0 {
                let pct = done * 100 / total;
                if pct != last_pct {
                    last_pct = pct;
                    emit(
                        sink,
                        stage,
                        format!("{pct}%  ({} / {} MB)", done / 1_000_000, total / 1_000_000),
                        Some(pct),
                    );
                }
            } else if done % (8 * 1_000_000) < bytes.len() as u64 {
                emit(sink, stage, format!("{} MB", done / 1_000_000), None);
            }
        }
        drop(file);

        if stream_err {
            if attempt < MAX_DL_ATTEMPTS {
                emit(sink, stage, format!("connection dropped — resuming ({attempt})…"), None);
                tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                continue;
            }
            return Err("download failed: connection dropped repeatedly".into());
        }

        std::fs::rename(&part, dest).map_err(|e| format!("finalize {dest}: {e}"))?;
        return Ok(());
    }
}

// ---- Managed process -----------------------------------------------------

/// Holds the ComfyUI child process we spawned, so we can stop it and reap it on
/// app exit. We never touch a ComfyUI the user launched themselves.
#[derive(Default)]
pub struct ManagedComfy(pub Mutex<Option<std::process::Child>>);

impl ManagedComfy {
    pub fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    fn store(&self, child: std::process::Child) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut old) = guard.replace(child) {
                let _ = old.kill();
            }
        }
    }
    fn child_alive(&self) -> bool {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.as_mut() {
                return matches!(child.try_wait(), Ok(None));
            }
        }
        false
    }
}

pub fn url() -> String {
    format!("http://127.0.0.1:{COMFY_PORT}")
}

/// Start ComfyUI if it isn't already answering on the port. Reuses a ComfyUI the
/// user started themselves (same port) instead of spawning a duplicate. Waits for
/// the HTTP API to come up before returning.
pub async fn start(managed: &ManagedComfy) -> Result<String, String> {
    let url = url();
    if probe(&url).await {
        return Ok(url); // ours from a previous start, or the user's own instance
    }
    if !is_installed() {
        return Err("Local image generation isn't set up yet.".into());
    }
    let log_path = format!("{}/comfy.log", base_dir());
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let child = std::process::Command::new(venv_python())
        .arg("main.py")
        .arg("--port")
        .arg(COMFY_PORT.to_string())
        .current_dir(src_dir())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err))
        .spawn()
        .map_err(|e| format!("failed to start ComfyUI: {e}"))?;
    managed.store(child);

    // Wait up to ~90s for the server (first launch imports torch — slow).
    for _ in 0..90 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if probe(&url).await {
            return Ok(url);
        }
        if !managed.child_alive() {
            return Err(format!(
                "ComfyUI exited during startup — see {log_path} for details."
            ));
        }
    }
    Err(format!(
        "ComfyUI didn't come up in time — see {log_path} for details."
    ))
}
