// Novel Studio — Rust backend.
// All network calls live here so the webview never sees CORS issues and the
// API key is passed per-request rather than embedded in the frontend bundle.

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

mod server;

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

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            emit_ev(sink, StreamEvent::Error { message: format!("Request failed: {e}") });
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        emit_ev(sink, StreamEvent::Error {
            message: format!("HTTP {status}: {text}"),
        });
        return Ok(());
    }

    // Parse the Server-Sent-Events stream: lines beginning with "data: ".
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    let is_cancelled =
        || cancel.as_ref().map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed));

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
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "NovelStudio", "images": ["8", 0]}}
    });

    run_comfy_workflow(&client, &root, workflow).await
}

/// Submit a workflow to ComfyUI, wait for completion, and return the image as base64.
async fn run_comfy_workflow(
    client: &reqwest::Client,
    root: &str,
    workflow: serde_json::Value,
) -> Result<String, String> {
    let body = serde_json::json!({ "prompt": workflow, "client_id": "novel-studio" });
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
        .file_name("novelstudio_input.png")
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
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "NovelStudio", "images": ["8", 0]}},
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

/// One non-streaming chat completion. Returns choices[0].message (content + tool_calls).
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
    let mut req = client
        .post(&url)
        .header("HTTP-Referer", "https://ai-studio.local")
        .header("X-Title", "AI Studio")
        .json(&body);
    if !params.api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", params.api_key.trim()));
    }
    let resp = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    if !resp.status().is_success() {
        let s = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {s}: {t}"));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["choices"][0]["message"].clone())
}

/// Expand a leading ~ to the user's home directory.
fn expand_path(p: &str) -> String {
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

/// Read a text file (auto — no approval).
#[tauri::command]
fn fs_read(path: String) -> Result<String, String> {
    let path = expand_path(&path);
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Write a text file, creating parent dirs (auto — no approval).
#[tauri::command]
fn fs_write(path: String, content: String) -> Result<String, String> {
    let path = expand_path(&path);
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))?;
    Ok(format!("Wrote {path}"))
}

/// List a directory's entries (auto — no approval).
#[tauri::command]
fn fs_list(path: String) -> Result<Vec<String>, String> {
    let path = expand_path(&path);
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
    Done { code: i32 },
    Error { message: String },
}

/// Run a shell command, streaming stdout/stderr lines to the frontend and
/// enforcing a timeout. Also returns the aggregated output + exit code for the
/// agent loop. FRONTEND gates this behind user approval. kill_on_drop ensures a
/// timed-out (dropped) child is terminated.
#[tauri::command]
async fn run_command_stream(
    command: String,
    timeout_secs: Option<u64>,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    run_command_stream_core(command, timeout_secs, &ChannelSink(on_event)).await
}

/// Core shared by the Tauri command and the remote WS server.
pub(crate) async fn run_command_stream_core(
    command: String,
    timeout_secs: Option<u64>,
    sink: &dyn EventSink,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;

    let mut out_lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err_lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let dur = std::time::Duration::from_secs(timeout_secs.unwrap_or(120).clamp(1, 1800));

    let mut collected = String::new();
    let run = async {
        let (mut out_done, mut err_done) = (false, false);
        while !(out_done && err_done) {
            tokio::select! {
                l = out_lines.next_line(), if !out_done => match l {
                    Ok(Some(s)) => { collected.push_str(&s); collected.push('\n'); emit_ev(sink, CmdEvent::Line { text: s }); }
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
            emit_ev(sink, CmdEvent::Done { code });
            Ok(serde_json::json!({ "output": collected, "code": code }))
        }
        Err(_) => {
            emit_ev(sink, CmdEvent::Error {
                message: format!("timed out after {}s (process killed)", dur.as_secs()),
            });
            Ok(serde_json::json!({ "output": "", "code": -1, "timedOut": true }))
        }
    }
}

/// Recursively search a directory by filename and/or file content. Bounded to
/// keep results and time in check; skips heavy/hidden dirs. Auto (read-only).
#[tauri::command]
fn fs_search(root: String, query: String, kind: Option<String>) -> Result<Vec<String>, String> {
    let root = expand_path(&root);
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

/// Replace the first exact occurrence of `old` with `new` in a file, returning
/// a compact diff. Requires `old` to be unique. Auto (a diff is surfaced in UI).
#[tauri::command]
fn fs_edit(path: String, old: String, new: String) -> Result<serde_json::Value, String> {
    let path = expand_path(&path);
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

/// Move/rename a path. FRONTEND gates this behind user approval.
#[tauri::command]
fn fs_move(from: String, to: String) -> Result<String, String> {
    let from = expand_path(&from);
    let to = expand_path(&to);
    if let Some(p) = std::path::Path::new(&to).parent() {
        let _ = std::fs::create_dir_all(p);
    }
    std::fs::rename(&from, &to).map_err(|e| format!("move: {e}"))?;
    Ok(format!("Moved {from} → {to}"))
}

/// Delete a file or directory (recursive). FRONTEND gates this behind approval.
#[tauri::command]
fn fs_delete(path: String) -> Result<String, String> {
    let path = expand_path(&path);
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat {path}: {e}"))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("delete {path}: {e}"))?;
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("delete {path}: {e}"))?;
    }
    Ok(format!("Deleted {path}"))
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

// ---- Shared key/value store (chat history etc.) --------------------------
// A small JSON file on the Mac, reachable from BOTH the desktop (Tauri IPC) and
// a paired phone (through the server), so history is the same on every device.

fn remote_store_path() -> String {
    expand_path("~/.ai-studio/store.json")
}
fn remote_store_lock() -> &'static std::sync::Mutex<()> {
    static L: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(|| std::sync::Mutex::new(()))
}

/// Read one key from the shared store (null if absent).
#[tauri::command]
fn remote_store_get(key: String) -> Option<String> {
    let _g = remote_store_lock().lock().ok()?;
    let content = std::fs::read_to_string(remote_store_path()).ok()?;
    let map: serde_json::Value = serde_json::from_str(&content).ok()?;
    map.get(&key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Write one key into the shared store (read-modify-write under a lock).
#[tauri::command]
fn remote_store_set(key: String, value: String) -> Result<(), String> {
    let _g = remote_store_lock().lock().map_err(|_| "store lock poisoned".to_string())?;
    let path = remote_store_path();
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut map = std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    map.insert(key, serde_json::Value::String(value));
    std::fs::write(&path, serde_json::Value::Object(map).to_string()).map_err(|e| e.to_string())
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
    std::fs::write(format!("{dir}/{id}.json"), record).map_err(|e| e.to_string())
}

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
        .manage(server::ApprovalRegistry::default())
        .manage(server::RemoteState::default())
        .manage(server::RemoteSettings::default())
        .manage(server::CancelRegistry::default())
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
            fs_list,
            fs_search,
            fs_edit,
            fs_move,
            fs_delete,
            web_fetch,
            run_command,
            run_command_stream,
            system_info,
            download_file,
            start_remote_server,
            stop_remote_server,
            remote_urls,
            resolve_remote_approval,
            set_remote_settings,
            cancel_generation,
            remote_store_get,
            remote_store_set,
            image_put,
            image_list,
            image_get,
            image_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
