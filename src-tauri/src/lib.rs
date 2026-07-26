// AI Studio — Rust backend.
// All network calls live here so the webview never sees CORS issues and the
// API key is passed per-request rather than embedded in the frontend bundle.

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

mod comfy;
mod guard;
mod pty;
mod server;

/// The guard policy for a desktop tool call, derived from the settings the
/// frontend pushes on every change. Falls back to "home directory, protections
/// on" if nothing has been pushed yet, so the agent is never unguarded.
fn agent_policy(settings: &tauri::State<'_, server::RemoteSettings>) -> guard::Policy {
    let v = settings.value();
    if v.is_null() {
        guard::Policy::default_home()
    } else {
        guard::Policy::from_settings(&v)
    }
}

/// A sink for streamed events, abstracting over the Tauri IPC Channel (desktop
/// webview) and a WebSocket connection (remote/phone). Streaming command cores
/// emit through this so the exact same logic serves both transports.
pub(crate) trait EventSink: Send + Sync {
    fn emit(&self, value: serde_json::Value);
}

/// Serialize a typed event and push it into a sink.
pub(crate) fn emit_ev<T: Serialize>(sink: &dyn EventSink, ev: T) {
    sink.emit(serde_json::to_value(ev).unwrap_or(serde_json::Value::Null));
}

/// EventSink backed by a Tauri IPC Channel — the desktop webview transport.
struct ChannelSink(Channel<serde_json::Value>);
impl EventSink for ChannelSink {
    fn emit(&self, value: serde_json::Value) {
        let _ = self.0.send(value);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateParams {
    /// OpenAI-compatible base, e.g. "https://openrouter.ai/api/v1"
    /// or a local Ollama server "http://localhost:11434/v1".
    base_url: String,
    /// May be empty for local providers that don't need auth.
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    max_tokens: u32,
}

/// Events streamed back to the frontend during text generation.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum StreamEvent {
    Token { content: String },
    Reasoning { content: String },
    Done,
    Error { message: String },
}

/// Stream a chat completion token-by-token to the frontend via a Channel.
/// Works with any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio, ...).
/// `request_id` (optional) registers a cancellation flag so Stop can abort the
/// upstream request server-side rather than merely ignoring tokens.
#[tauri::command]
async fn generate_text(
    params: GenerateParams,
    request_id: Option<String>,
    registry: tauri::State<'_, server::CancelRegistry>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    let cancel = request_id.as_ref().map(|id| registry.register(id.clone()));
    let res = generate_text_core(params, &ChannelSink(on_event), cancel).await;
    if let Some(id) = request_id {
        registry.remove(&id);
    }
    res
}

/// Core streaming logic shared by the Tauri command and the remote WS server. When
/// `cancel` is set and flips to true, the stream is dropped (aborting the upstream
/// HTTP request) and a Done event is emitted.
pub(crate) async fn generate_text_core(
    params: GenerateParams,
    sink: &dyn EventSink,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<(), String> {
    let url = format!("{}/chat/completions", params.base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": params.model,
        "messages": params.messages.iter().map(|m| serde_json::json!({
            "role": m.role,
            "content": m.content,
        })).collect::<Vec<_>>(),
        "temperature": params.temperature,
        "max_tokens": params.max_tokens,
        "stream": true,
    });

    // No total timeout (generations are long), but bound connection setup so a
    // dead endpoint can't hang the stream forever.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    // Retry the CONNECTION only (429/5xx/network) — safe because no token has been
    // emitted yet. Once streaming starts we can't resume, so we never retry then.
    let resp = {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let mut req = client
                .post(&url)
                .header("Content-Type", "application/json")
                // OpenRouter asks for these; harmless for other providers.
                .header("HTTP-Referer", "https://ai-studio.local")
                .header("X-Title", "AI Studio")
                .json(&body);
            if !params.api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", params.api_key.trim()));
            }
            match req.send().await {
                Ok(r) if r.status().is_success() => break r,
                Ok(r) => {
                    let s = r.status();
                    if is_transient(s) && attempt < MAX_ATTEMPTS && !is_cancelled_flag(&cancel) {
                        backoff(attempt).await;
                        continue;
                    }
                    let text = r.text().await.unwrap_or_default();
                    emit_ev(sink, StreamEvent::Error { message: friendly_http_error(s, &text) });
                    return Ok(());
                }
                Err(e) => {
                    if attempt < MAX_ATTEMPTS && !is_cancelled_flag(&cancel) {
                        backoff(attempt).await;
                        continue;
                    }
                    emit_ev(sink, StreamEvent::Error { message: format!("Request failed: {e}") });
                    return Ok(());
                }
            }
        }
    };

    // Parse the Server-Sent-Events stream: lines beginning with "data: ".
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    let is_cancelled = || is_cancelled_flag(&cancel);

    loop {
        // Poll the cancel flag even while waiting on a slow chunk, so Stop takes
        // effect within ~250ms regardless of token cadence.
        if is_cancelled() {
            emit_ev(sink, StreamEvent::Done);
            return Ok(());
        }
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => continue,
        };
        let Some(chunk) = chunk else { break };
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                emit_ev(sink, StreamEvent::Error { message: format!("Stream error: {e}") });
                return Ok(());
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // SSE events are separated by newlines; process complete lines only.
        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim().to_string();
            buffer.drain(..=newline);

            let data = match line.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => continue,
            };
            if data == "[DONE]" {
                emit_ev(sink, StreamEvent::Done);
                return Ok(());
            }
            if data.is_empty() {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                let delta = &json["choices"][0]["delta"];
                // Reasoning models expose thoughts on a separate field.
                let reasoning = delta["reasoning"]
                    .as_str()
                    .or_else(|| delta["reasoning_content"].as_str());
                if let Some(r) = reasoning {
                    if !r.is_empty() {
                        emit_ev(sink, StreamEvent::Reasoning { content: r.to_string() });
                    }
                }
                if let Some(content) = delta["content"].as_str() {
                    if !content.is_empty() {
                        emit_ev(sink, StreamEvent::Token { content: content.to_string() });
                    }
                }
            }
        }
    }

    emit_ev(sink, StreamEvent::Done);
    Ok(())
}

/// One OpenRouter catalog entry, trimmed to what the picker needs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenrouterModel {
    id: String,
    name: String,
    context_length: u64,
    /// USD per prompt token (0 for free models).
    prompt_price: f64,
    /// Unix seconds the model was added — used to sort newest-first.
    created: u64,
    /// Modality flags so the frontend can split text vs image pickers itself.
    output_text: bool,
    output_image: bool,
    input_image: bool,
}

/// Fetch OpenRouter's live model catalog so the picker never goes stale.
/// The endpoint is public; the key is optional (only affects per-account visibility).
#[tauri::command]
async fn list_openrouter_models(api_key: Option<String>) -> Result<Vec<OpenrouterModel>, String> {
    let client = reqwest::Client::new();
    let mut req = client
        .get("https://openrouter.ai/api/v1/models")
        .header("HTTP-Referer", "https://ai-studio.local")
        .header("X-Title", "AI Studio");
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", key.trim()));
        }
    }
    let resp = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    if !resp.status().is_success() {
        let s = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {s}: {t}"));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = json["data"].as_array().cloned().unwrap_or_default();
    // Helper: does an architecture modality array/string contain a modality?
    fn has_modality(arch: &serde_json::Value, key: &str, want: &str) -> Option<bool> {
        match arch[key].as_array() {
            Some(mods) => Some(mods.iter().any(|x| x.as_str() == Some(want))),
            None => arch["modality"].as_str().map(|s| s.contains(want)),
        }
    }
    let mut models: Vec<OpenrouterModel> = arr
        .iter()
        .map(|m| {
            let arch = &m["architecture"];
            OpenrouterModel {
                id: m["id"].as_str().unwrap_or("").to_string(),
                name: m["name"].as_str().unwrap_or("").to_string(),
                context_length: m["context_length"].as_u64().unwrap_or(0),
                prompt_price: m["pricing"]["prompt"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0),
                created: m["created"].as_u64().unwrap_or(0),
                // Default text-out true when unknown (most models are text).
                output_text: has_modality(arch, "output_modalities", "text").unwrap_or(true),
                output_image: has_modality(arch, "output_modalities", "image").unwrap_or(false),
                input_image: has_modality(arch, "input_modalities", "image").unwrap_or(false),
            }
        })
        .filter(|m| !m.id.is_empty())
        .collect();
    models.sort_by(|a, b| b.created.cmp(&a.created)); // newest first
    Ok(models)
}

/// List locally installed Ollama models so the user can pick one.
#[tauri::command]
async fn list_ollama_models(base_url: String) -> Result<Vec<String>, String> {
    // Ollama's native tag endpoint lives at /api/tags (not under /v1).
    let root = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_string();
    let url = format!("{root}/api/tags");

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Could not reach Ollama at {root}: {e}"))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let models = json["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

/// Pull an Ollama model, streaming progress lines to the frontend.
#[tauri::command]
async fn pull_ollama_model(
    base_url: String,
    model: String,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    pull_ollama_model_core(base_url, model, &ChannelSink(on_event)).await
}

/// Core shared by the Tauri command and the remote WS server.
pub(crate) async fn pull_ollama_model_core(
    base_url: String,
    model: String,
    sink: &dyn EventSink,
) -> Result<(), String> {
    let root = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_string();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{root}/api/pull"))
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Ollama at {root}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama pull failed: HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer.drain(..=nl);
            if line.is_empty() {
                continue;
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(err) = json["error"].as_str() {
                    return Err(err.to_string());
                }
                let status = json["status"].as_str().unwrap_or("");
                let msg = match (json["completed"].as_u64(), json["total"].as_u64()) {
                    (Some(c), Some(t)) if t > 0 => format!("{status} — {}%", c * 100 / t),
                    _ => status.to_string(),
                };
                sink.emit(serde_json::Value::String(msg));
            }
        }
    }
    sink.emit(serde_json::Value::String("done".to_string()));
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageParams {
    /// Base URL of an Automatic1111 / Forge server, e.g. "http://localhost:7860".
    base_url: String,
    prompt: String,
    negative_prompt: String,
    steps: u32,
    width: u32,
    height: u32,
    cfg_scale: f32,
    sampler_name: String,
}

/// Generate an explicit-capable image locally via the Automatic1111/Forge
/// txt2img API. Returns a base64-encoded PNG (data payload only, no prefix).
#[tauri::command]
async fn generate_image(params: ImageParams) -> Result<String, String> {
    let url = format!("{}/sdapi/v1/txt2img", params.base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "prompt": params.prompt,
        "negative_prompt": params.negative_prompt,
        "steps": params.steps,
        "width": params.width,
        "height": params.height,
        "cfg_scale": params.cfg_scale,
        "sampler_name": params.sampler_name,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach image server at {}: {e}", params.base_url))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Image server error HTTP {status}: {text}"));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    json["images"][0]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "No image returned by server".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComfyParams {
    /// Base URL of a ComfyUI server, e.g. "http://127.0.0.1:8188".
    base_url: String,
    /// Checkpoint filename as ComfyUI lists it, e.g. "waiNSFW.safetensors".
    checkpoint: String,
    prompt: String,
    negative_prompt: String,
    steps: u32,
    width: u32,
    height: u32,
    cfg_scale: f32,
    sampler_name: String, // ComfyUI sampler id, e.g. "dpmpp_2m"
    scheduler: String,    // e.g. "karras"
    /// Fixed seed for reproducibility (the frontend supplies one each call).
    seed: u64,
}

/// Generate an image via ComfyUI: submit a standard txt2img graph, poll the
/// history for completion, then fetch the PNG. Returns base64 (no prefix).
#[tauri::command]
async fn generate_image_comfy(params: ComfyParams) -> Result<String, String> {
    let root = params.base_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let seed = params.seed;

    let workflow = serde_json::json!({
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": params.steps, "cfg": params.cfg_scale,
            "sampler_name": params.sampler_name, "scheduler": params.scheduler,
            "denoise": 1.0, "model": ["4", 0], "positive": ["6", 0],
            "negative": ["7", 0], "latent_image": ["5", 0]
        }},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": params.checkpoint}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {
            "width": params.width, "height": params.height, "batch_size": 1
        }},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": params.prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": params.negative_prompt, "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "AIStudio", "images": ["8", 0]}}
    });

    run_comfy_workflow(&client, &root, workflow).await
}

/// Submit a workflow to ComfyUI, wait for completion, and return the image as base64.
async fn run_comfy_workflow(
    client: &reqwest::Client,
    root: &str,
    workflow: serde_json::Value,
) -> Result<String, String> {
    let body = serde_json::json!({ "prompt": workflow, "client_id": "ai-studio" });
    let resp = client
        .post(format!("{root}/prompt"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach ComfyUI at {root}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("ComfyUI rejected the job (HTTP {status}): {text}"));
    }
    let submit: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let prompt_id = submit["prompt_id"]
        .as_str()
        .ok_or("ComfyUI did not return a prompt_id")?
        .to_string();

    // Poll history for completion (~7.5 min ceiling at 500ms intervals).
    let mut image_ref: Option<(String, String, String)> = None;
    for _ in 0..900 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let hist = match client.get(format!("{root}/history/{prompt_id}")).send().await {
            Ok(r) => r,
            Err(_) => continue,
        };
        let hist: serde_json::Value = match hist.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let entry = &hist[&prompt_id];
        if entry.is_null() {
            continue;
        }
        if let Some(outputs) = entry["outputs"].as_object() {
            for (_node, out) in outputs {
                if let Some(img) = out["images"].as_array().and_then(|a| a.first()) {
                    image_ref = Some((
                        img["filename"].as_str().unwrap_or("").to_string(),
                        img["subfolder"].as_str().unwrap_or("").to_string(),
                        img["type"].as_str().unwrap_or("output").to_string(),
                    ));
                    break;
                }
            }
        }
        if image_ref.is_some() {
            break;
        }
        if entry["status"]["status_str"].as_str() == Some("error") {
            return Err("ComfyUI errored while generating — check the checkpoint name and the server console.".to_string());
        }
    }

    let (filename, subfolder, typ) =
        image_ref.ok_or("Timed out waiting for ComfyUI to produce an image.")?;

    let img_resp = client
        .get(format!("{root}/view"))
        .query(&[
            ("filename", filename.as_str()),
            ("subfolder", subfolder.as_str()),
            ("type", typ.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to fetch image: {e}"))?;
    let bytes = img_resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Img2ImgParams {
    base_url: String,
    checkpoint: String,
    prompt: String,
    negative_prompt: String,
    steps: u32,
    cfg_scale: f32,
    sampler_name: String,
    scheduler: String,
    /// 0.0 = keep source unchanged, 1.0 = ignore source. ~0.5–0.7 is typical.
    denoise: f32,
    /// Source image as base64 (no data-URI prefix).
    image_base64: String,
    /// Fixed seed for reproducibility.
    seed: u64,
}

/// Transform an uploaded image via ComfyUI img2img (upload → VAE encode → sample).
#[tauri::command]
async fn generate_img2img_comfy(params: Img2ImgParams) -> Result<String, String> {
    let root = params.base_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let seed = params.seed;

    // Decode the source image and upload it to ComfyUI's input folder.
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(params.image_base64.trim())
        .map_err(|e| format!("Bad image data: {e}"))?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("aistudio_input.png")
        .mime_str("image/png")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("overwrite", "true");
    let up = client
        .post(format!("{root}/upload/image"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Could not upload image to ComfyUI at {root}: {e}"))?;
    if !up.status().is_success() {
        let s = up.status();
        let t = up.text().await.unwrap_or_default();
        return Err(format!("Image upload failed (HTTP {s}): {t}"));
    }
    let upjson: serde_json::Value = up.json().await.map_err(|e| e.to_string())?;
    let name = upjson["name"]
        .as_str()
        .ok_or("Upload returned no filename")?
        .to_string();
    let subfolder = upjson["subfolder"].as_str().unwrap_or("");
    let image_ref = if subfolder.is_empty() {
        name
    } else {
        format!("{subfolder}/{name}")
    };

    let workflow = serde_json::json!({
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": params.steps, "cfg": params.cfg_scale,
            "sampler_name": params.sampler_name, "scheduler": params.scheduler,
            "denoise": params.denoise, "model": ["4", 0], "positive": ["6", 0],
            "negative": ["7", 0], "latent_image": ["10", 0]
        }},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": params.checkpoint}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": params.prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": params.negative_prompt, "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "AIStudio", "images": ["8", 0]}},
        "10": {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["4", 2]}},
        "11": {"class_type": "LoadImage", "inputs": {"image": image_ref}}
    });

    run_comfy_workflow(&client, &root, workflow).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenrouterImageParams {
    api_key: String,
    model: String,
    prompt: String,
    resolution: String,   // "512" | "1K" | "2K" | "4K"
    aspect_ratio: String, // "1:1" | "16:9" | "9:16" | "3:4" | "4:3"
}

/// Generate an image via OpenRouter's cloud Image API. Returns base64 (no prefix).
#[tauri::command]
async fn generate_image_openrouter(params: OpenrouterImageParams) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": params.model,
        "prompt": params.prompt,
        "resolution": params.resolution,
        "aspect_ratio": params.aspect_ratio,
        "n": 1,
    });
    let resp = client
        .post("https://openrouter.ai/api/v1/images")
        .header("Authorization", format!("Bearer {}", params.api_key.trim()))
        .header("HTTP-Referer", "https://ai-studio.local")
        .header("X-Title", "AI Studio")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    if !resp.status().is_success() {
        let s = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("OpenRouter image error HTTP {s}: {t}"));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(b64) = json["data"][0]["b64_json"].as_str() {
        return Ok(b64.to_string());
    }
    // Some providers return a URL instead — fetch and encode it.
    if let Some(url) = json["data"][0]["url"].as_str() {
        let img = client.get(url).send().await.map_err(|e| e.to_string())?;
        let bytes = img.bytes().await.map_err(|e| e.to_string())?;
        return Ok(base64::engine::general_purpose::STANDARD.encode(&bytes));
    }
    Err("OpenRouter returned no image data".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenrouterEditParams {
    api_key: String,
    model: String,
    prompt: String,
    /// Source image as base64 (no data-URI prefix).
    image_base64: String,
}

/// Edit / transform an uploaded image via OpenRouter. Image editing goes through
/// the chat-completions API with modalities:["image","text"] and the source image
/// passed as an image_url. Only image-input models work (Gemini Flash Image,
/// FLUX Kontext, GPT-Image-1). Returns base64 (no prefix).
#[tauri::command]
async fn edit_image_openrouter(params: OpenrouterEditParams) -> Result<String, String> {
    let client = reqwest::Client::new();
    let data_url = format!("data:image/png;base64,{}", params.image_base64.trim());
    let body = serde_json::json!({
        "model": params.model,
        "modalities": ["image", "text"],
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": params.prompt },
                { "type": "image_url", "image_url": { "url": data_url } }
            ]
        }],
    });
    let resp = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", params.api_key.trim()))
        .header("HTTP-Referer", "https://ai-studio.local")
        .header("X-Title", "AI Studio")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    if !resp.status().is_success() {
        let s = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("OpenRouter edit error HTTP {s}: {t}"));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    extract_openrouter_image(&json, &client).await
}

/// Pull a generated image out of an OpenRouter chat-completions response,
/// tolerating the few shapes different image models use.
async fn extract_openrouter_image(
    json: &serde_json::Value,
    client: &reqwest::Client,
) -> Result<String, String> {
    let msg = &json["choices"][0]["message"];

    // 1) Chat-completions image output: message.images[].image_url.url
    if let Some(imgs) = msg["images"].as_array() {
        if let Some(first) = imgs.first() {
            let url = first["image_url"]["url"]
                .as_str()
                .or_else(|| first["url"].as_str());
            if let Some(u) = url {
                return url_or_data_to_b64(u, client).await;
            }
        }
    }
    // 2) Responses-style output array with a base64 result.
    if let Some(out) = json["output"].as_array() {
        for item in out {
            if let Some(res) = item["result"].as_str() {
                return Ok(res.rsplit("base64,").next().unwrap_or(res).to_string());
            }
        }
    }
    // 3) A data URL embedded in the text content.
    if let Some(content) = msg["content"].as_str() {
        if let Some(idx) = content.find("data:image") {
            let sub = &content[idx..];
            let end = sub
                .find(|c: char| c == ')' || c.is_whitespace())
                .unwrap_or(sub.len());
            return url_or_data_to_b64(&sub[..end], client).await;
        }
    }
    Err("OpenRouter returned no image — the selected model may not support image editing.".to_string())
}

/// Turn a data: URL or http(s) URL into raw base64 (no prefix).
async fn url_or_data_to_b64(u: &str, client: &reqwest::Client) -> Result<String, String> {
    if let Some(idx) = u.find("base64,") {
        return Ok(u[idx + 7..].to_string());
    }
    if u.starts_with("http") {
        let img = client.get(u).send().await.map_err(|e| e.to_string())?;
        let bytes = img.bytes().await.map_err(|e| e.to_string())?;
        return Ok(base64::engine::general_purpose::STANDARD.encode(&bytes));
    }
    Err("Unrecognized image URL from OpenRouter".to_string())
}

/// List checkpoints ComfyUI can see, for the model picker.
#[tauri::command]
async fn list_comfy_checkpoints(base_url: String) -> Result<Vec<String>, String> {
    let root = base_url.trim_end_matches('/').to_string();
    let resp = reqwest::get(format!("{root}/object_info/CheckpointLoaderSimple"))
        .await
        .map_err(|e| format!("Could not reach ComfyUI at {root}: {e}"))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let names = json["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(names)
}

// ---- Phase 2: agent tools ------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionParams {
    base_url: String,
    api_key: String,
    model: String,
    /// Raw OpenAI-format message array (may include tool/assistant tool_call messages).
    messages: serde_json::Value,
    /// Raw OpenAI-format tools array (empty to disable tool calling).
    tools: serde_json::Value,
    temperature: f32,
}

/// Map a provider HTTP error to an actionable message instead of a raw dump.
fn friendly_http_error(status: reqwest::StatusCode, body: &str) -> String {
    let code = status.as_u16();
    let hint = match code {
        401 | 403 => "Unauthorized — check your API key in Settings.",
        404 => "Model or endpoint not found — pick a different model / check the base URL.",
        402 => "Payment required — your provider account is out of credit.",
        429 => "Rate limited — wait a moment and try again.",
        500..=599 => "The provider had a server error — try again shortly.",
        _ => "",
    };
    if hint.is_empty() {
        let snippet: String = body.chars().take(300).collect();
        format!("HTTP {code}: {snippet}")
    } else {
        format!("{hint} (HTTP {code})")
    }
}

/// Transient errors worth retrying: rate limits and server errors.
fn is_transient(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

/// Whether a streaming cancel flag is set (used to bail out of connection retries).
fn is_cancelled_flag(cancel: &Option<std::sync::Arc<std::sync::atomic::AtomicBool>>) -> bool {
    cancel
        .as_ref()
        .map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed))
}

/// Backoff before retry attempt `attempt` (1-indexed): 400ms, 800ms, …
async fn backoff(attempt: u32) {
    tokio::time::sleep(std::time::Duration::from_millis(400 * attempt as u64)).await;
}

const MAX_ATTEMPTS: u32 = 3;

/// One non-streaming chat completion. Returns choices[0].message (content + tool_calls).
/// Retries transient failures (429/5xx/network) with backoff.
#[tauri::command]
async fn chat_completion(params: ChatCompletionParams) -> Result<serde_json::Value, String> {
    let url = format!("{}/chat/completions", params.base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": params.model,
        "messages": params.messages,
        "temperature": params.temperature,
        "stream": false,
    });
    if params.tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        body["tools"] = params.tools;
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let mut attempt = 0;
    loop {
        attempt += 1;
        let mut req = client
            .post(&url)
            .header("HTTP-Referer", "https://ai-studio.local")
            .header("X-Title", "AI Studio")
            .json(&body);
        if !params.api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", params.api_key.trim()));
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                if attempt < MAX_ATTEMPTS {
                    backoff(attempt).await;
                    continue;
                }
                return Err(format!("Request failed: {e}"));
            }
        };
        if !resp.status().is_success() {
            let s = resp.status();
            if is_transient(s) && attempt < MAX_ATTEMPTS {
                backoff(attempt).await;
                continue;
            }
            let t = resp.text().await.unwrap_or_default();
            return Err(friendly_http_error(s, &t));
        }
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        return Ok(json["choices"][0]["message"].clone());
    }
}

/// Expand a leading ~ to the user's home directory.
pub(crate) fn expand_path(p: &str) -> String {
    if p == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| p.to_string());
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    p.to_string()
}

// The `*_core` functions do the actual work and assume their path has ALREADY
// been through `guard::confine`. The `#[tauri::command]` wrappers are what the
// desktop webview calls, and they do that confinement; the companion server
// confines with the same function before calling the core directly.

pub(crate) fn fs_read_core(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Read a text file. Confined to the agent workspace; protected paths refused.
#[tauri::command]
fn fs_read(
    path: String,
    settings: tauri::State<'_, server::RemoteSettings>,
) -> Result<String, String> {
    fs_read_core(guard::confine(&agent_policy(&settings), &path)?)
}

pub(crate) fn fs_write_core(path: String, content: String) -> Result<String, String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))?;
    Ok(format!("Wrote {path}"))
}

/// Write a text file, creating parent dirs. Confined; the FRONTEND additionally
/// shows a diff and asks for approval before calling this.
#[tauri::command]
fn fs_write(
    path: String,
    content: String,
    settings: tauri::State<'_, server::RemoteSettings>,
) -> Result<String, String> {
    fs_write_core(guard::confine(&agent_policy(&settings), &path)?, content)
}

/// Save a base64-encoded PNG to the desktop machine's Downloads folder, returning
/// the final path. This is how a phone browsing the app over the LAN gets a
/// generated image onto the Mac/PC — the browser can't write to the host's disk,
/// but this command (invoked over the companion server) can. Names collisions are
/// avoided by appending " (2)", " (3)", … to the base name.
#[tauri::command]
fn save_png(base64: String, name: Option<String>) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("decode png: {e}"))?;
    let dir = expand_path("~/Downloads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir}: {e}"))?;
    // Sanitize the requested name; fall back to a stable default.
    let raw = name.unwrap_or_default();
    let stem = raw.trim().trim_end_matches(".png");
    let stem: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_') { c } else { '-' })
        .collect();
    let stem = if stem.trim().is_empty() { "ai-studio-image".to_string() } else { stem.trim().to_string() };
    let mut path = std::path::Path::new(&dir).join(format!("{stem}.png"));
    let mut n = 2;
    while path.exists() {
        path = std::path::Path::new(&dir).join(format!("{stem} ({n}).png"));
        n += 1;
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

pub(crate) fn fs_list_core(path: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| format!("list {path}: {e}"))? {
        if let Ok(entry) = entry {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            out.push(format!(
                "{}{}",
                entry.file_name().to_string_lossy(),
                if is_dir { "/" } else { "" }
            ));
        }
    }
    out.sort();
    Ok(out)
}

/// List a directory's entries. Confined to the agent workspace.
#[tauri::command]
fn fs_list(
    path: String,
    settings: tauri::State<'_, server::RemoteSettings>,
) -> Result<Vec<String>, String> {
    fs_list_core(guard::confine(&agent_policy(&settings), &path)?)
}

/// Run a shell command. The FRONTEND gates this behind user approval; over the
/// remote server the desktop must approve. Bounded to 120s with kill-on-drop so a
/// hung command (approved from a phone, say) can't run forever.
#[tauri::command]
async fn run_command(command: String) -> Result<serde_json::Value, String> {
    let child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    let dur = std::time::Duration::from_secs(120);
    let out = match tokio::time::timeout(dur, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| format!("run failed: {e}"))?,
        Err(_) => return Err("command timed out after 120s (process killed)".into()),
    };
    Ok(serde_json::json!({
        "stdout": String::from_utf8_lossy(&out.stdout),
        "stderr": String::from_utf8_lossy(&out.stderr),
        "code": out.status.code().unwrap_or(-1),
    }))
}

/// Live events streamed while a command runs.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum CmdEvent {
    Line { text: String },
    /// `cwd` is the working directory after the command ran, so the caller can
    /// keep a persistent shell dir across commands (each run is a fresh `sh -c`).
    Done { code: i32, cwd: Option<String> },
    Error { message: String },
}

/// Sentinel the wrapped command prints so we can recover the final working
/// directory (making `cd` stick between commands) without a persistent shell.
const CWD_MARK: &str = "__AISTUDIO_CWD__:";

/// Run a shell command, streaming stdout/stderr lines to the frontend and
/// enforcing a timeout. Also returns the aggregated output + exit code for the
/// agent loop. FRONTEND gates this behind user approval. kill_on_drop ensures a
/// timed-out (dropped) child is terminated.
#[tauri::command]
async fn run_command_stream(
    command: String,
    timeout_secs: Option<u64>,
    cwd: Option<String>,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    run_command_stream_core(command, timeout_secs, cwd, &ChannelSink(on_event)).await
}

/// Core shared by the Tauri command and the remote WS server. `cwd` sets the
/// directory the command runs in (defaults to the user's home); the returned
/// `cwd` reflects any `cd` the command performed.
pub(crate) async fn run_command_stream_core(
    command: String,
    timeout_secs: Option<u64>,
    cwd: Option<String>,
    sink: &dyn EventSink,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    // Resolve the starting directory: the requested cwd if it still exists, else
    // the user's home. Never inherit the app's own working dir (e.g. src-tauri).
    let start_dir = cwd
        .map(|c| expand_path(&c))
        .filter(|c| std::path::Path::new(c).is_dir())
        .unwrap_or_else(|| expand_path("~"));

    // Run the user's command, then print the resulting pwd behind a sentinel so a
    // `cd` persists to the next command. `exit $__ec` preserves the real code.
    let wrapped = format!(
        "{command}\n__ec=$?\nprintf '%s%s\\n' '{CWD_MARK}' \"$(pwd)\"\nexit $__ec"
    );

    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&wrapped)
        .current_dir(&start_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;

    let mut out_lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err_lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let dur = std::time::Duration::from_secs(timeout_secs.unwrap_or(120).clamp(1, 1800));

    let mut collected = String::new();
    let mut final_cwd = start_dir.clone();
    let run = async {
        let (mut out_done, mut err_done) = (false, false);
        while !(out_done && err_done) {
            tokio::select! {
                l = out_lines.next_line(), if !out_done => match l {
                    // A stdout line is either normal output or our cwd sentinel
                    // (recorded to persist `cd`, and never shown to the user).
                    Ok(Some(s)) => {
                        if let Some(dir) = s.strip_prefix(CWD_MARK) {
                            final_cwd = dir.to_string();
                        } else {
                            collected.push_str(&s);
                            collected.push('\n');
                            emit_ev(sink, CmdEvent::Line { text: s });
                        }
                    }
                    _ => out_done = true,
                },
                l = err_lines.next_line(), if !err_done => match l {
                    Ok(Some(s)) => { collected.push_str(&s); collected.push('\n'); emit_ev(sink, CmdEvent::Line { text: s }); }
                    _ => err_done = true,
                },
            }
        }
        child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1)
    };

    match tokio::time::timeout(dur, run).await {
        Ok(code) => {
            emit_ev(sink, CmdEvent::Done { code, cwd: Some(final_cwd.clone()) });
            Ok(serde_json::json!({ "output": collected, "code": code, "cwd": final_cwd }))
        }
        Err(_) => {
            emit_ev(sink, CmdEvent::Error {
                message: format!("timed out after {}s (process killed)", dur.as_secs()),
            });
            Ok(serde_json::json!({ "output": "", "code": -1, "timedOut": true }))
        }
    }
}

// ---- Interactive terminal (PTY) — desktop command wrappers ----------------

#[tauri::command]
async fn pty_open(
    id: String,
    rows: u16,
    cols: u16,
    reg: tauri::State<'_, pty::PtyRegistry>,
    cancels: tauri::State<'_, server::CancelRegistry>,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    // Register a cancel flag keyed by the pty id so the UI can detach this stream
    // (via `cancel_generation`) when it navigates away — without killing the shell.
    let flag = cancels.register(id.clone());
    let res = pty::pty_open_core(id.clone(), rows, cols, &reg, &ChannelSink(on_event), Some(flag)).await;
    cancels.remove(&id);
    res
}

#[tauri::command]
fn pty_write(id: String, data: String, reg: tauri::State<'_, pty::PtyRegistry>) -> Result<(), String> {
    pty::pty_write_core(&id, &data, &reg)
}

#[tauri::command]
fn pty_resize(id: String, rows: u16, cols: u16, reg: tauri::State<'_, pty::PtyRegistry>) -> Result<(), String> {
    pty::pty_resize_core(&id, rows, cols, &reg)
}

#[tauri::command]
fn pty_kill(id: String, reg: tauri::State<'_, pty::PtyRegistry>) {
    pty::pty_kill_core(&id, &reg);
}

/// Recursively search a directory by filename and/or file content. Bounded to
/// keep results and time in check; skips heavy/hidden dirs. Auto (read-only).
pub(crate) fn fs_search_core(
    root: String,
    query: String,
    kind: Option<String>,
) -> Result<Vec<String>, String> {
    let kind = kind.unwrap_or_else(|| "both".to_string());
    let want_name = kind == "name" || kind == "both";
    let want_content = kind == "content" || kind == "both";
    let q = query.to_lowercase();
    const LIMIT: usize = 200;
    let skip = ["node_modules", ".git", "target", "dist", "build", ".next", ".venv"];
    let mut out: Vec<String> = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(&root)];
    while let Some(dir) = stack.pop() {
        if out.len() >= LIMIT {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if out.len() >= LIMIT {
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if skip.contains(&name.as_str()) || name.starts_with('.') {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if want_name && name.to_lowercase().contains(&q) {
                out.push(path.to_string_lossy().to_string());
                continue;
            }
            if want_content {
                if entry.metadata().map(|m| m.len() > 1_000_000).unwrap_or(true) {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    for (i, line) in content.lines().enumerate() {
                        if line.to_lowercase().contains(&q) {
                            let snip: String = line.trim().chars().take(160).collect();
                            out.push(format!("{}:{}: {snip}", path.to_string_lossy(), i + 1));
                            if out.len() >= LIMIT {
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Search file names and/or contents under `root`. Confined to the workspace.
#[tauri::command]
fn fs_search(
    root: String,
    query: String,
    kind: Option<String>,
    settings: tauri::State<'_, server::RemoteSettings>,
) -> Result<Vec<String>, String> {
    fs_search_core(guard::confine(&agent_policy(&settings), &root)?, query, kind)
}

/// Replace the first exact occurrence of `old` with `new` in a file, returning
/// a compact diff. Requires `old` to be unique.
pub(crate) fn fs_edit_core(
    path: String,
    old: String,
    new: String,
) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    let count = content.matches(&old).count();
    if count == 0 {
        return Err("`old` string not found in file".into());
    }
    if count > 1 {
        return Err(format!(
            "`old` string is not unique ({count} matches) — include more surrounding context"
        ));
    }
    let updated = content.replacen(&old, &new, 1);
    std::fs::write(&path, &updated).map_err(|e| format!("write {path}: {e}"))?;
    let diff = old
        .lines()
        .map(|l| format!("- {l}"))
        .chain(new.lines().map(|l| format!("+ {l}")))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(serde_json::json!({ "message": format!("Edited {path}"), "diff": diff }))
}

/// Targeted file edit. Confined; the frontend shows the diff and asks first.
#[tauri::command]
fn fs_edit(
    path: String,
    old: String,
    new: String,
    settings: tauri::State<'_, server::RemoteSettings>,
) -> Result<serde_json::Value, String> {
    fs_edit_core(guard::confine(&agent_policy(&settings), &path)?, old, new)
}

pub(crate) fn fs_move_core(from: String, to: String) -> Result<String, String> {
    if let Some(p) = std::path::Path::new(&to).parent() {
        let _ = std::fs::create_dir_all(p);
    }
    std::fs::rename(&from, &to).map_err(|e| format!("move: {e}"))?;
    Ok(format!("Moved {from} → {to}"))
}

/// Move/rename a path. Both ends confined; the frontend asks for approval.
#[tauri::command]
fn fs_move(
    from: String,
    to: String,
    settings: tauri::State<'_, server::RemoteSettings>,
) -> Result<String, String> {
    let policy = agent_policy(&settings);
    fs_move_core(
        guard::confine(&policy, &from)?,
        guard::confine(&policy, &to)?,
    )
}

pub(crate) fn fs_delete_core(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat {path}: {e}"))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("delete {path}: {e}"))?;
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("delete {path}: {e}"))?;
    }
    Ok(format!("Deleted {path}"))
}

/// Delete a file or directory (recursive). Confined; approval required.
#[tauri::command]
fn fs_delete(
    path: String,
    settings: tauri::State<'_, server::RemoteSettings>,
) -> Result<String, String> {
    fs_delete_core(guard::confine(&agent_policy(&settings), &path)?)
}

/// True for addresses that must never be reached by a server-side fetch: loopback,
/// RFC1918 private, link-local (incl. the 169.254.169.254 cloud-metadata range),
/// unspecified/broadcast, and their IPv6 equivalents (ULA, link-local, mapped v4).
fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.octets()[0] == 0
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || v6
                    .to_ipv4_mapped()
                    .map(|m| is_blocked_ip(std::net::IpAddr::V4(m)))
                    .unwrap_or(false)
        }
    }
}

/// Reject non-http(s) schemes and any URL whose host resolves to a private,
/// loopback, or link-local address (SSRF guard). Resolving here defends against a
/// hostname pointing at internal services; DNS-rebinding at connect time is a
/// known residual limitation.
pub(crate) fn validate_public_url(raw: &str) -> Result<(), String> {
    use std::net::ToSocketAddrs;
    let parsed = url::Url::parse(raw).map_err(|_| "invalid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("scheme `{other}` not allowed (http/https only)")),
    }
    let host = parsed.host_str().ok_or("URL has no host")?;
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve host: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err("host did not resolve".into());
    }
    if addrs.iter().any(|a| is_blocked_ip(a.ip())) {
        return Err("refusing to fetch a private/loopback/link-local address".into());
    }
    Ok(())
}

/// Fetch a URL and return readable text (HTML stripped, capped). SSRF-guarded and
/// time-bounded so it can't hang or reach internal services.
#[tauri::command]
async fn web_fetch(url: String) -> Result<String, String> {
    validate_public_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("User-Agent", "AI Studio/1.0")
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let text = if ct.contains("html") { strip_html(&body) } else { body };
    Ok(text.chars().take(100_000).collect())
}

/// Strip HTML tags (and script/style bodies) to plain, whitespace-collapsed text.
fn strip_html(html: &str) -> String {
    let mut out = String::new();
    let mut tag = String::new();
    let mut in_tag = false;
    let mut skip = false; // inside a <script>/<style> body
    for c in html.chars() {
        if in_tag {
            if c == '>' {
                in_tag = false;
                let t = tag.trim().to_lowercase();
                if t.starts_with("script") || t.starts_with("style") {
                    skip = true;
                } else if t.starts_with("/script") || t.starts_with("/style") {
                    skip = false;
                }
                tag.clear();
            } else {
                tag.push(c);
            }
        } else if c == '<' {
            in_tag = true;
        } else if !skip {
            out.push(c);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Download a URL to a destination path, streaming progress lines. For installing
/// image checkpoints into ComfyUI. Supports ~ in the destination.
#[tauri::command]
async fn download_file(
    url: String,
    dest: String,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    download_file_core(url, dest, &ChannelSink(on_event)).await
}

/// Core shared by the Tauri command and the remote WS server.
pub(crate) async fn download_file_core(
    url: String,
    dest: String,
    sink: &dyn EventSink,
) -> Result<(), String> {
    use std::io::Write;
    validate_public_url(&url)?;
    let dest = expand_path(&dest);
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&dest).map_err(|e| format!("create {dest}: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_pct: u64 = 200;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        if total > 0 {
            let pct = downloaded * 100 / total;
            if pct != last_pct {
                last_pct = pct;
                sink.emit(serde_json::Value::String(format!("{pct}%  ({} MB)", downloaded / 1_000_000)));
            }
        } else {
            sink.emit(serde_json::Value::String(format!("{} MB", downloaded / 1_000_000)));
        }
    }
    sink.emit(serde_json::Value::String("done".to_string()));
    Ok(())
}

/// Detect total (unified) memory and chip so the UI can recommend model sizes.
#[tauri::command]
fn system_info() -> serde_json::Value {
    fn sysctl(key: &str) -> Option<String> {
        std::process::Command::new("sysctl")
            .arg("-n")
            .arg(key)
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
    }
    let mem_bytes: u64 = sysctl("hw.memsize").and_then(|s| s.parse().ok()).unwrap_or(0);
    let ram_gb = (mem_bytes as f64) / 1024.0 / 1024.0 / 1024.0;
    let chip = sysctl("machdep.cpu.brand_string")
        .or_else(|| sysctl("hw.model"))
        .unwrap_or_else(|| "Unknown".to_string());
    // Apple Silicon shares memory, so usable "VRAM" ≈ total RAM.
    serde_json::json!({ "ramGb": ram_gb, "chip": chip })
}

// ---- Managed local image generation (ComfyUI) ----------------------------

/// Report whether the managed ComfyUI runtime is installed and whether an
/// instance is currently answering on the port (ours or the user's own).
#[tauri::command]
async fn comfy_status() -> serde_json::Value {
    let url = comfy::url();
    let running = comfy::probe(&url).await;
    serde_json::json!({
        "installed": comfy::is_installed(),
        "running": running,
        "url": url,
    })
}

/// Download one model into the managed install, bootstrapping the runtime (uv →
/// ComfyUI → venv + PyTorch) on the first call. Streams stage/message/pct.
#[tauri::command]
async fn comfy_download_model(
    model_url: String,
    model_name: String,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    comfy::download_model(model_url, model_name, &ChannelSink(on_event)).await
}

/// Checkpoints already downloaded into the managed install (filenames).
#[tauri::command]
fn comfy_installed_models() -> Vec<String> {
    comfy::installed_models()
}

/// Start the managed ComfyUI (reuses an already-running instance on the port).
#[tauri::command]
async fn comfy_start(managed: tauri::State<'_, comfy::ManagedComfy>) -> Result<String, String> {
    comfy::start(managed.inner()).await
}

/// Stop the ComfyUI we spawned (leaves a user-launched instance alone).
#[tauri::command]
fn comfy_stop(managed: tauri::State<'_, comfy::ManagedComfy>) {
    managed.kill();
}

// ---- Remote access (phone) server control --------------------------------

/// Start the companion HTTP+WebSocket server that serves the built UI and mirrors
/// commands to remote devices. Returns the reachable URLs + token.
#[tauri::command]
async fn start_remote_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, server::RemoteState>,
    registry: tauri::State<'_, server::ApprovalRegistry>,
    settings: tauri::State<'_, server::RemoteSettings>,
    port: Option<u16>,
    token: String,
    wake_lock: bool,
) -> Result<serde_json::Value, String> {
    // Never run the remote server open: a non-empty bearer token is mandatory.
    if token.trim().is_empty() {
        return Err("refusing to start the remote server without an access token".into());
    }
    server::start(
        app,
        state.inner(),
        registry.inner(),
        settings.inner(),
        port.unwrap_or(8787),
        token,
        wake_lock,
    )
    .await
}

/// Push the desktop's current settings into the shared store so a paired phone
/// uses the same configuration (API key, model, generation options, …).
#[tauri::command]
fn set_remote_settings(store: tauri::State<'_, server::RemoteSettings>, settings: String) {
    store.set(settings);
}

/// Abort an in-flight streaming generation by request id (Stop button). Stops the
/// upstream request server-side so it doesn't keep generating / billing.
#[tauri::command]
fn cancel_generation(registry: tauri::State<'_, server::CancelRegistry>, request_id: String) {
    registry.cancel(&request_id);
}

// ---- Secret storage (macOS Keychain) -------------------------------------
// API keys live in the OS keychain at rest instead of plaintext localStorage.
// These are desktop-only Tauri commands (not exposed over the companion server),
// so a paired phone can never read the Mac's keychain.

// Only referenced by the release-build keychain path; dev builds use a 0600 file.
#[cfg_attr(debug_assertions, allow(dead_code))]
const KEYCHAIN_SERVICE: &str = "com.gwintech.aistudio";

/// The pre-rename bundle identifier. Keys stored by an older install live under
/// this service name, so `secret_get` falls back to it (and migrates the value
/// forward) rather than making the user re-enter an API key after updating.
#[cfg(not(debug_assertions))]
const LEGACY_KEYCHAIN_SERVICE: &str = "com.novelstudio.app";

// In DEBUG (dev) builds the binary is unsigned and its identity changes on every
// rebuild, so macOS re-prompts for the login-keychain password on every key read.
// That's intolerable during development, so dev builds keep secrets in a 0600 file
// under the app dir instead. RELEASE (signed) builds always use the OS keychain,
// where access is silent and stable.
#[cfg(debug_assertions)]
fn dev_secret_file() -> String {
    expand_path("~/.ai-studio/dev-secrets.json")
}

#[cfg(debug_assertions)]
fn dev_secrets_read() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(dev_secret_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Store (or, with an empty value, delete) a secret.
#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let mut map = dev_secrets_read();
        if value.is_empty() {
            map.remove(&name);
        } else {
            map.insert(name, serde_json::Value::String(value));
        }
        let path = dev_secret_file();
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&path, serde_json::to_string(&map).unwrap_or_default())
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        return Ok(());
    }
    #[cfg(not(debug_assertions))]
    {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &name).map_err(|e| e.to_string())?;
        if value.is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        } else {
            entry.set_password(&value).map_err(|e| e.to_string())
        }
    }
}

/// Read a secret (null if not set).
#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    {
        return Ok(dev_secrets_read()
            .get(&name)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()));
    }
    #[cfg(not(debug_assertions))]
    {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &name).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            // Nothing under the current service — look for a key left by the
            // pre-rename install and migrate it forward, so updating the app
            // never silently loses the user's API key.
            Err(keyring::Error::NoEntry) => {
                let legacy = keyring::Entry::new(LEGACY_KEYCHAIN_SERVICE, &name)
                    .ok()
                    .and_then(|e| e.get_password().ok());
                match legacy {
                    Some(v) => {
                        let _ = entry.set_password(&v);
                        Ok(Some(v))
                    }
                    None => Ok(None),
                }
            }
            Err(e) => Err(e.to_string()),
        }
    }
}

// ---- Shared key/value store (chat history etc.) --------------------------
// A small JSON file on the Mac, reachable from BOTH the desktop (Tauri IPC) and
// a paired phone (through the server), so history is the same on every device.

fn remote_store_path() -> String {
    expand_path("~/.ai-studio/store.json")
}

/// Append a line to ~/.ai-studio/app.log, capped so it can't grow forever.
///
/// Reserved for events worth explaining after the fact — a recovered store, a
/// refused path — not routine chatter. When a user reports "my documents
/// vanished", this file is the difference between a guess and an answer.
fn log_line(message: &str) {
    let path = expand_path("~/.ai-studio/app.log");
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Rotate at ~256 KB by keeping only the newest half.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 256 * 1024 {
            if let Ok(existing) = std::fs::read_to_string(&path) {
                let keep = existing.split_at(existing.len() / 2).1;
                let _ = std::fs::write(&path, keep);
            }
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{stamp} {message}");
    }
}
fn remote_store_lock() -> &'static std::sync::Mutex<()> {
    static L: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(|| std::sync::Mutex::new(()))
}

/// Parse the store file, falling back to the newest usable hourly backup if it
/// is missing or corrupt.
///
/// We were already *taking* backups before every write but never reading them,
/// so a truncated store (a crash mid-write on an older build, a disk full) read
/// as "no documents" — and the next save would then happily overwrite the good
/// backup set with that emptiness. Recovering here closes that loop.
fn read_store_value() -> Option<serde_json::Value> {
    let path = remote_store_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            return Some(v);
        }
        log_line(&format!("store at {path} is unreadable — trying backups"));
    }

    let dir = expand_path("~/.ai-studio/backups");
    let mut candidates: Vec<(u64, std::path::PathBuf)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            let n = name.strip_prefix("store-")?.strip_suffix(".json")?.parse().ok()?;
            Some((n, p))
        })
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0)); // newest bucket first
    for (_, p) in candidates {
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                log_line(&format!("recovered store from backup {}", p.display()));
                return Some(v);
            }
        }
    }
    None
}

/// Read one key from the shared store (null if absent).
#[tauri::command]
fn remote_store_get(key: String) -> Option<String> {
    let _g = remote_store_lock().lock().ok()?;
    read_store_value()?
        .get(&key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Write one key into the shared store (read-modify-write under a lock).
#[tauri::command]
fn remote_store_set(key: String, value: String) -> Result<(), String> {
    let _g = remote_store_lock().lock().map_err(|_| "store lock poisoned".to_string())?;
    let path = remote_store_path();
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Recovering here matters as much as on read: starting from an empty map
    // because the file was corrupt would merge against nothing and then persist
    // that emptiness over every good backup.
    let mut map = read_store_value()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    map.insert(key, serde_json::Value::String(value));
    snapshot_store(&path);
    atomic_write(&path, &serde_json::Value::Object(map).to_string()).map_err(|e| e.to_string())
}

// ---- Conflict-free list sync ---------------------------------------------
// Documents and chat sessions are lists of items keyed by `id` with an `updatedAt`
// timestamp. Devices used to overwrite the whole list, so concurrent edits on the
// desktop and phone silently clobbered each other. `store_merge_list` instead
// merges item-by-item: last-writer-wins by `updatedAt`, with tombstones (a
// `deleted: {id: ts}` map) so a delete on one device isn't resurrected by the
// other. Both saving and syncing go through this one merge, so no committed edit
// is ever lost in either direction.

fn item_updated_at(v: &serde_json::Value) -> i64 {
    v.get("updatedAt").and_then(|x| x.as_i64()).unwrap_or(0)
}

/// Parse a stored value (a JSON string) into (items-by-id, deleted-by-id). Accepts
/// the new `{items, deleted}` shape and a legacy bare `[...]` array.
fn parse_sync_list(
    raw: Option<&str>,
) -> (
    serde_json::Map<String, serde_json::Value>,
    serde_json::Map<String, serde_json::Value>,
) {
    let mut items = serde_json::Map::new();
    let mut deleted = serde_json::Map::new();
    let v: serde_json::Value = raw
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Null);
    let take_items = |arr: &Vec<serde_json::Value>, into: &mut serde_json::Map<String, serde_json::Value>| {
        for it in arr {
            if let Some(id) = it.get("id").and_then(|x| x.as_str()) {
                into.insert(id.to_string(), it.clone());
            }
        }
    };
    match v {
        serde_json::Value::Array(arr) => take_items(&arr, &mut items),
        serde_json::Value::Object(o) => {
            if let Some(serde_json::Value::Array(arr)) = o.get("items") {
                take_items(arr, &mut items);
            }
            if let Some(serde_json::Value::Object(d)) = o.get("deleted") {
                deleted = d.clone();
            }
        }
        _ => {}
    }
    (items, deleted)
}

/// Merge `incoming` into `base` (item LWW by updatedAt + tombstone union) and
/// return the merged list serialized as `{items:[…], deleted:{…}}`, items sorted
/// most-recently-updated first.
fn merge_sync_lists(
    base: (serde_json::Map<String, serde_json::Value>, serde_json::Map<String, serde_json::Value>),
    incoming: (serde_json::Map<String, serde_json::Value>, serde_json::Map<String, serde_json::Value>),
) -> String {
    let (mut items, mut deleted) = base;
    let (in_items, in_deleted) = incoming;

    for (id, it) in in_items {
        let take = match items.get(&id) {
            Some(existing) => item_updated_at(&it) >= item_updated_at(existing),
            None => true,
        };
        if take {
            items.insert(id, it);
        }
    }
    for (id, ts) in in_deleted {
        let t = ts.as_i64().unwrap_or(0);
        let cur = deleted.get(&id).and_then(|x| x.as_i64()).unwrap_or(0);
        if t >= cur {
            deleted.insert(id, serde_json::Value::from(t));
        }
    }
    // Apply tombstones: drop an item deleted at or after its last edit. (An edit
    // newer than the delete wins — the item survives.)
    let ids: Vec<String> = items.keys().cloned().collect();
    for id in ids {
        if let Some(dts) = deleted.get(&id).and_then(|x| x.as_i64()) {
            if dts >= item_updated_at(&items[&id]) {
                items.remove(&id);
            }
        }
    }

    let mut arr: Vec<serde_json::Value> = items.into_iter().map(|(_, v)| v).collect();
    arr.sort_by(|a, b| item_updated_at(b).cmp(&item_updated_at(a)));
    serde_json::json!({ "items": arr, "deleted": serde_json::Value::Object(deleted) }).to_string()
}

/// Merge a device's list into the shared store and return the merged union.
/// `incoming` is a JSON string `{items:[…], deleted:{…}}`.
#[tauri::command]
fn store_merge_list(key: String, incoming: String) -> Result<String, String> {
    let _g = remote_store_lock().lock().map_err(|_| "store lock poisoned".to_string())?;
    let path = remote_store_path();
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Recovering here matters as much as on read: starting from an empty map
    // because the file was corrupt would merge against nothing and then persist
    // that emptiness over every good backup.
    let mut map = read_store_value()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let base = parse_sync_list(map.get(&key).and_then(|v| v.as_str()));
    let incoming_list = parse_sync_list(Some(&incoming));
    let merged = merge_sync_lists(base, incoming_list);

    map.insert(key, serde_json::Value::String(merged.clone()));
    snapshot_store(&path);
    atomic_write(&path, &serde_json::Value::Object(map).to_string()).map_err(|e| e.to_string())?;
    Ok(merged)
}

/// Write a file atomically (temp file + rename) so a crash or concurrent write
/// can't leave the shared store half-written / corrupt.
fn atomic_write(path: &str, contents: &str) -> std::io::Result<()> {
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

/// Keep up to this many hourly store snapshots for recovery.
const STORE_BACKUPS: usize = 48;

/// Before overwriting the shared store, keep an hourly snapshot in
/// ~/.ai-studio/backups so a bad write or accidental mass-delete is recoverable.
/// One snapshot per hour bucket (bounded I/O), pruned to the newest N.
fn snapshot_store(path: &str) {
    let src = std::path::Path::new(path);
    if !src.exists() {
        return;
    }
    let dir = expand_path("~/.ai-studio/backups");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let bucket = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 3600)
        .unwrap_or(0);
    let dest = format!("{dir}/store-{bucket}.json");
    if !std::path::Path::new(&dest).exists() {
        let _ = std::fs::copy(src, &dest);
        prune_numbered(&dir, "store-", ".json", STORE_BACKUPS);
    }
}

/// Keep only the `keep` newest `<prefix><number><suffix>` files in `dir`.
fn prune_numbered(dir: &str, prefix: &str, suffix: &str, keep: usize) {
    let mut nums: Vec<(u64, std::path::PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            let n = name
                .strip_prefix(prefix)?
                .strip_suffix(suffix)?
                .parse::<u64>()
                .ok()?;
            Some((n, p))
        })
        .collect();
    if nums.len() <= keep {
        return;
    }
    nums.sort_by(|a, b| b.0.cmp(&a.0)); // newest (highest) first
    for (_, p) in nums.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

/// Cap the image gallery: keep the newest N images (by mtime), delete the rest.
fn prune_images(dir: &str, keep: usize) {
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((mtime, p))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    for (_, p) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

// ---- Document version history --------------------------------------------
// A writing tool that can lose a draft is not a writing tool. The shared store
// already merges and keeps hourly backups, but that protects the *set* of
// documents, not the history of one manuscript: an accidental select-all-delete,
// or an AI rewrite the author regrets an hour later, was unrecoverable.
//
// Each snapshot is one JSON file under ~/.ai-studio/versions/<doc-id>/<ts>.json,
// which makes listing cheap (metadata read per file), pruning trivial, and the
// whole history readable with `cat` if the app itself is broken.

fn versions_dir(doc_id: &str) -> Option<String> {
    let id = safe_id(doc_id);
    if id.is_empty() {
        return None;
    }
    Some(expand_path(&format!("~/.ai-studio/versions/{id}")))
}

/// Snapshots kept per document. At the ~2 minute cadence the frontend uses,
/// this is roughly the last few days of active writing on one manuscript.
const VERSION_CAP: usize = 60;

/// Store one snapshot of a document. `record` is the JSON the frontend keeps
/// (`{id, at, title, html, words}`); `at` doubles as the filename so listings
/// sort chronologically without opening every file.
#[tauri::command]
fn doc_version_put(doc_id: String, at: i64, record: String) -> Result<(), String> {
    let dir = versions_dir(&doc_id).ok_or("bad document id")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    atomic_write(&format!("{dir}/{at}.json"), &record).map_err(|e| e.to_string())?;
    prune_numbered(&dir, "", ".json", VERSION_CAP);
    Ok(())
}

/// Snapshot metadata for one document, newest first, WITHOUT the `html` body.
#[tauri::command]
fn doc_version_list(doc_id: String) -> Vec<serde_json::Value> {
    let Some(dir) = versions_dir(&doc_id) else {
        return Vec::new();
    };
    let mut items: Vec<serde_json::Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(e.path()) {
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(o) = v.as_object_mut() {
                        o.remove("html"); // keep the listing light
                    }
                    items.push(v);
                }
            }
        }
    }
    items.sort_by(|a, b| b["at"].as_i64().unwrap_or(0).cmp(&a["at"].as_i64().unwrap_or(0)));
    items
}

/// One full snapshot, including its `html`, for preview or restore.
#[tauri::command]
fn doc_version_get(doc_id: String, at: i64) -> Option<String> {
    let dir = versions_dir(&doc_id)?;
    std::fs::read_to_string(format!("{dir}/{at}.json")).ok()
}

/// Drop a document's whole history (called when the document itself is deleted,
/// so old drafts don't linger on disk after the user thinks they're gone).
#[tauri::command]
fn doc_versions_clear(doc_id: String) -> Result<(), String> {
    if let Some(dir) = versions_dir(&doc_id) {
        let _ = std::fs::remove_dir_all(dir);
    }
    Ok(())
}

/// Make a filename safe to join onto the export directory.
///
/// The name comes from a user-chosen document title, which may contain path
/// separators ("Act 1/2"), be a traversal attempt (".."), or be empty. Anything
/// that could escape the export folder becomes an ordinary character.
fn safe_export_name(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' => '-',
            // Control characters have no business in a filename.
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = mapped.trim().trim_start_matches('.').trim();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Write every document to a timestamped folder in ~/Downloads and return its
/// path. The library lives in an app-private store, which is fine until the day
/// someone wants their manuscripts *out* — this is that escape hatch, and it
/// works from the phone too (the Mac writes the files).
#[tauri::command]
fn export_library(files: Vec<serde_json::Value>) -> Result<String, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dir = expand_path(&format!("~/Downloads/AI Studio Export {stamp}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create export folder: {e}"))?;
    for f in &files {
        let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("untitled");
        let content = f.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let safe = safe_export_name(name);
        std::fs::write(format!("{dir}/{safe}"), content)
            .map_err(|e| format!("write {safe}: {e}"))?;
    }
    Ok(dir)
}

// ---- Shared image gallery ------------------------------------------------
// Each generated image is one JSON file on the Mac (record + base64 data), so
// the gallery is the same on the desktop and any paired phone. The list returns
// metadata only (no image bytes); thumbnails are fetched per-image on demand.

fn images_dir() -> String {
    expand_path("~/.ai-studio/images")
}
/// Keep ids filesystem-safe (they're UUIDs, but guard against traversal).
fn safe_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

/// Save one image record (JSON incl. its base64 data) as its own file.
#[tauri::command]
fn image_put(id: String, record: String) -> Result<(), String> {
    let id = safe_id(&id);
    if id.is_empty() {
        return Err("bad image id".into());
    }
    let dir = images_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(format!("{dir}/{id}.json"), record).map_err(|e| e.to_string())?;
    prune_images(&dir, IMAGE_CAP);
    Ok(())
}

/// Cap on stored images so the gallery can't grow without bound.
const IMAGE_CAP: usize = 500;

/// List image metadata (newest first), WITHOUT the heavy `dataUrl` field.
#[tauri::command]
fn image_list() -> Vec<serde_json::Value> {
    let dir = images_dir();
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(e.path()) {
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(o) = v.as_object_mut() {
                        o.remove("dataUrl");
                    }
                    items.push(v);
                }
            }
        }
    }
    items.sort_by(|a, b| b["at"].as_i64().unwrap_or(0).cmp(&a["at"].as_i64().unwrap_or(0)));
    items
}

/// Full record (with `dataUrl`) for one image.
#[tauri::command]
fn image_get(id: String) -> Option<String> {
    std::fs::read_to_string(format!("{}/{}.json", images_dir(), safe_id(&id))).ok()
}

/// Delete one image from the shared gallery.
#[tauri::command]
fn image_delete(id: String) -> Result<(), String> {
    let _ = std::fs::remove_file(format!("{}/{}.json", images_dir(), safe_id(&id)));
    Ok(())
}

/// Stop the remote server and release the wake-lock.
#[tauri::command]
fn stop_remote_server(state: tauri::State<'_, server::RemoteState>) {
    server::stop(state.inner());
}

/// Reachable URLs (LAN + Tailscale) + current token / running state.
#[tauri::command]
fn remote_urls(state: tauri::State<'_, server::RemoteState>) -> serde_json::Value {
    server::urls(state.inner())
}

/// Turn on a `tailscale serve` HTTPS endpoint for the companion port; returns the
/// resulting https URL (or a helpful error if Tailscale/HTTPS isn't set up).
#[tauri::command]
async fn tailscale_serve_enable(state: tauri::State<'_, server::RemoteState>) -> Result<String, String> {
    server::serve_enable(state.inner()).await
}

/// Fulfil a pending remote approval — called by the desktop after the user
/// approves/denies on the Mac.
#[tauri::command]
fn resolve_remote_approval(
    registry: tauri::State<'_, server::ApprovalRegistry>,
    id: String,
    approved: bool,
) {
    registry.resolve(&id, approved);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(server::ApprovalRegistry::default())
        .manage(server::RemoteState::default())
        .manage(server::RemoteSettings::default())
        .manage(server::CancelRegistry::default())
        .manage(comfy::ManagedComfy::default())
        .manage(pty::PtyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            generate_text,
            list_openrouter_models,
            list_ollama_models,
            pull_ollama_model,
            generate_image,
            generate_image_comfy,
            generate_img2img_comfy,
            generate_image_openrouter,
            edit_image_openrouter,
            list_comfy_checkpoints,
            chat_completion,
            fs_read,
            fs_write,
            save_png,
            fs_list,
            fs_search,
            fs_edit,
            fs_move,
            fs_delete,
            web_fetch,
            run_command,
            run_command_stream,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
            system_info,
            download_file,
            start_remote_server,
            stop_remote_server,
            remote_urls,
            tailscale_serve_enable,
            resolve_remote_approval,
            set_remote_settings,
            cancel_generation,
            secret_set,
            secret_get,
            remote_store_get,
            remote_store_set,
            store_merge_list,
            image_put,
            image_list,
            image_get,
            image_delete,
            doc_version_put,
            doc_version_list,
            doc_version_get,
            doc_versions_clear,
            export_library,
            comfy_status,
            comfy_download_model,
            comfy_installed_models,
            comfy_start,
            comfy_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Reap the managed ComfyUI child on quit so we don't orphan a Python
            // process holding gigabytes of model in memory.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                app.state::<comfy::ManagedComfy>().kill();
                app.state::<pty::PtyRegistry>().kill_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Test sink that counts token events and notes when Done is emitted.
    struct TestSink {
        tokens: Arc<AtomicUsize>,
        done: Arc<AtomicBool>,
    }
    impl EventSink for TestSink {
        fn emit(&self, value: serde_json::Value) {
            match value.get("type").and_then(|t| t.as_str()) {
                Some("token") => {
                    self.tokens.fetch_add(1, Ordering::Relaxed);
                }
                Some("done") => self.done.store(true, Ordering::Relaxed),
                _ => {}
            }
        }
    }

    /// A mock OpenAI-compatible endpoint that streams a token every 100ms for a
    /// long time — long enough that a mid-stream cancel must cut it short.
    async fn spawn_mock_sse() -> String {
        use axum::{http::header, response::Response, routing::post, Router};
        async fn handler() -> Response {
            let body = futures_util::stream::unfold(0usize, |i| async move {
                if i >= 100 {
                    return None;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let chunk = "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n".to_string();
                Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk)), i + 1))
            });
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(axum::body::Body::from_stream(body))
                .unwrap()
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route("/chat/completions", post(handler));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_stops_stream_early() {
        let base_url = spawn_mock_sse().await;
        let params = GenerateParams {
            base_url,
            api_key: String::new(),
            model: "mock".into(),
            messages: vec![ChatMessage { role: "user".into(), content: "hi".into() }],
            temperature: 0.0,
            max_tokens: 100,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let tokens = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicBool::new(false));
        let sink = TestSink { tokens: tokens.clone(), done: done.clone() };

        // Cancel 350ms in — a few tokens will have streamed by then.
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(350)).await;
            c2.store(true, Ordering::Relaxed);
        });

        let start = std::time::Instant::now();
        generate_text_core(params, &sink, Some(cancel)).await.unwrap();
        let elapsed = start.elapsed();

        assert!(done.load(Ordering::Relaxed), "cancel should emit a Done event");
        let n = tokens.load(Ordering::Relaxed);
        assert!(n > 0 && n < 30, "cancel should stop early (got {n} tokens of 100)");
        assert!(elapsed < std::time::Duration::from_secs(2), "should return promptly (took {elapsed:?})");
    }

    fn merge(base: &str, incoming: &str) -> serde_json::Value {
        let m = merge_sync_lists(parse_sync_list(Some(base)), parse_sync_list(Some(incoming)));
        serde_json::from_str(&m).unwrap()
    }

    #[test]
    fn merge_keeps_newer_edit_per_item() {
        // Desktop edited doc A (t=200); phone still has old A (t=100) but edited B.
        // Neither edit should be lost.
        let desktop = r#"{"items":[{"id":"A","html":"A-new","updatedAt":200},{"id":"B","html":"B-old","updatedAt":50}],"deleted":{}}"#;
        let phone = r#"{"items":[{"id":"A","html":"A-old","updatedAt":100},{"id":"B","html":"B-new","updatedAt":300}],"deleted":{}}"#;
        let out = merge(desktop, phone);
        let items = out["items"].as_array().unwrap();
        let a = items.iter().find(|i| i["id"] == "A").unwrap();
        let b = items.iter().find(|i| i["id"] == "B").unwrap();
        assert_eq!(a["html"], "A-new", "desktop's newer A wins");
        assert_eq!(b["html"], "B-new", "phone's newer B wins");
    }

    #[test]
    fn merge_adds_new_items_from_both() {
        let a = r#"{"items":[{"id":"A","updatedAt":1}],"deleted":{}}"#;
        let b = r#"{"items":[{"id":"C","updatedAt":1}],"deleted":{}}"#;
        let out = merge(a, b);
        let ids: Vec<&str> = out["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&"A") && ids.contains(&"C"));
    }

    #[test]
    fn merge_honours_tombstones_but_edit_after_delete_wins() {
        // A deleted at 200 — stays deleted even though a stale copy (t=100) exists.
        let store = r#"{"items":[{"id":"A","updatedAt":100},{"id":"B","updatedAt":100}],"deleted":{}}"#;
        let del = r#"{"items":[],"deleted":{"A":200}}"#;
        let out = merge(store, del);
        let ids: Vec<&str> = out["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
        assert!(!ids.contains(&"A"), "tombstoned A is removed");
        assert!(ids.contains(&"B"));
        // But a re-edit of A at t=300 (after the 200 delete) resurrects it.
        let reedit = r#"{"items":[{"id":"A","updatedAt":300}],"deleted":{}}"#;
        let out2 = merge(&out.to_string(), reedit);
        let ids2: Vec<&str> = out2["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
        assert!(ids2.contains(&"A"), "edit newer than the delete wins");
    }

    #[test]
    fn merge_migrates_legacy_bare_array() {
        let legacy = r#"[{"id":"A","html":"x","updatedAt":5}]"#;
        let incoming = r#"{"items":[{"id":"A","html":"y","updatedAt":9}],"deleted":{}}"#;
        let out = merge(legacy, incoming);
        assert_eq!(out["items"][0]["html"], "y");
    }

    #[test]
    fn export_names_cannot_escape_the_folder() {
        // A title with separators must not become a path.
        assert_eq!(safe_export_name("Act 1/2.md"), "Act 1-2.md");
        assert_eq!(safe_export_name("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(safe_export_name("..").as_str(), "untitled");
        assert_eq!(safe_export_name("   ").as_str(), "untitled");
        assert_eq!(safe_export_name(".hidden"), "hidden");
        assert_eq!(safe_export_name("C:\\Windows\\evil"), "C--Windows-evil");
        // Ordinary titles survive intact.
        assert_eq!(safe_export_name("Chapter 3 — The Fall.md"), "Chapter 3 — The Fall.md");
        // No result may contain a separator, whatever went in.
        for evil in ["../x", "a/b/c", "..\\..\\x", "\u{0}/etc"] {
            let out = safe_export_name(evil);
            assert!(!out.contains('/') && !out.contains('\\'), "{evil} -> {out}");
        }
    }

    #[test]
    fn prune_numbered_keeps_newest() {
        let dir = std::env::temp_dir().join(format!("ns-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_str().unwrap();
        for n in [10u64, 5, 42, 7, 100, 3] {
            std::fs::write(dir.join(format!("store-{n}.json")), "{}").unwrap();
        }
        prune_numbered(d, "store-", ".json", 3);
        let mut left: Vec<u64> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| {
                e.path().file_name()?.to_str()?.strip_prefix("store-")?.strip_suffix(".json")?.parse().ok()
            })
            .collect();
        left.sort();
        assert_eq!(left, vec![10, 42, 100], "keeps the 3 highest buckets");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn uncancelled_stream_runs_to_completion() {
        // Sanity: without cancel, the same core consumes the whole stream.
        let base_url = spawn_mock_sse().await;
        let params = GenerateParams {
            base_url,
            api_key: String::new(),
            model: "mock".into(),
            messages: vec![ChatMessage { role: "user".into(), content: "hi".into() }],
            temperature: 0.0,
            max_tokens: 100,
        };
        let tokens = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicBool::new(false));
        let sink = TestSink { tokens: tokens.clone(), done: done.clone() };
        generate_text_core(params, &sink, None).await.unwrap();
        assert!(done.load(Ordering::Relaxed));
        assert_eq!(tokens.load(Ordering::Relaxed), 100, "all tokens should stream when not cancelled");
    }
}
