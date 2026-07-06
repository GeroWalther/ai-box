// Novel Studio — Rust backend.
// All network calls live here so the webview never sees CORS issues and the
// API key is passed per-request rather than embedded in the frontend bundle.

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

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
#[tauri::command]
async fn generate_text(params: GenerateParams, on_event: Channel<StreamEvent>) -> Result<(), String> {
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

    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        // OpenRouter asks for these; harmless for other providers.
        .header("HTTP-Referer", "https://novel-studio.local")
        .header("X-Title", "Novel Studio")
        .json(&body);

    if !params.api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", params.api_key));
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(StreamEvent::Error { message: format!("Request failed: {e}") });
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            message: format!("HTTP {status}: {text}"),
        });
        return Ok(());
    }

    // Parse the Server-Sent-Events stream: lines beginning with "data: ".
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = on_event.send(StreamEvent::Error { message: format!("Stream error: {e}") });
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
                let _ = on_event.send(StreamEvent::Done);
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
                        let _ = on_event.send(StreamEvent::Reasoning { content: r.to_string() });
                    }
                }
                if let Some(content) = delta["content"].as_str() {
                    if !content.is_empty() {
                        let _ = on_event.send(StreamEvent::Token { content: content.to_string() });
                    }
                }
            }
        }
    }

    let _ = on_event.send(StreamEvent::Done);
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
            req = req.header("Authorization", format!("Bearer {}", key));
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
    let mut models: Vec<OpenrouterModel> = arr
        .iter()
        .filter(|m| {
            // Keep only models that can OUTPUT text (drop pure image/audio generators).
            let out = &m["architecture"]["output_modalities"];
            match out.as_array() {
                Some(mods) => mods.iter().any(|x| x.as_str() == Some("text")),
                None => m["architecture"]["modality"]
                    .as_str()
                    .map(|s| s.contains("text"))
                    .unwrap_or(true),
            }
        })
        .map(|m| OpenrouterModel {
            id: m["id"].as_str().unwrap_or("").to_string(),
            name: m["name"].as_str().unwrap_or("").to_string(),
            context_length: m["context_length"].as_u64().unwrap_or(0),
            prompt_price: m["pricing"]["prompt"]
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0),
            created: m["created"].as_u64().unwrap_or(0),
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
    on_event: Channel<String>,
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
                let _ = on_event.send(msg);
            }
        }
    }
    let _ = on_event.send("done".to_string());
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
}

/// Generate an image via ComfyUI: submit a standard txt2img graph, poll the
/// history for completion, then fetch the PNG. Returns base64 (no prefix).
#[tauri::command]
async fn generate_image_comfy(params: ComfyParams) -> Result<String, String> {
    let root = params.base_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();

    // Vary the seed each call without Math.random on the frontend.
    let seed: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);

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
}

/// Transform an uploaded image via ComfyUI img2img (upload → VAE encode → sample).
#[tauri::command]
async fn generate_img2img_comfy(params: Img2ImgParams) -> Result<String, String> {
    let root = params.base_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();

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

    let seed: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);

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
        .header("Authorization", format!("Bearer {}", params.api_key))
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
        .header("Authorization", format!("Bearer {}", params.api_key))
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

    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .header("HTTP-Referer", "https://ai-studio.local")
        .header("X-Title", "AI Studio")
        .json(&body);
    if !params.api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", params.api_key));
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

/// Run a shell command. The FRONTEND gates this behind user approval.
#[tauri::command]
async fn run_command(command: String) -> Result<serde_json::Value, String> {
    let out = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .output()
        .await
        .map_err(|e| format!("spawn failed: {e}"))?;
    Ok(serde_json::json!({
        "stdout": String::from_utf8_lossy(&out.stdout),
        "stderr": String::from_utf8_lossy(&out.stderr),
        "code": out.status.code().unwrap_or(-1),
    }))
}

/// Download a URL to a destination path, streaming progress lines. For installing
/// image checkpoints into ComfyUI. Supports ~ in the destination.
#[tauri::command]
async fn download_file(
    url: String,
    dest: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    use std::io::Write;
    let dest = expand_path(&dest);
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let client = reqwest::Client::new();
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
                let _ = on_event.send(format!("{pct}%  ({} MB)", downloaded / 1_000_000));
            }
        } else {
            let _ = on_event.send(format!("{} MB", downloaded / 1_000_000));
        }
    }
    let _ = on_event.send("done".to_string());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            run_command,
            system_info,
            download_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
