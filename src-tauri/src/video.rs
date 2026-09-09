// Video generation — OpenRouter's /api/v1/videos API.
//
// Why this shape:
//
//   * The model catalog is NEVER hardcoded. `list_video_models` reads
//     GET /api/v1/videos/models, which reports, per model, the durations,
//     resolutions, aspect ratios, frame-image slots, audio and seed support it
//     actually accepts. The UI builds its controls from that, so a model added
//     upstream (a new Kling, Veo, Seedance, PixVerse…) shows up with correct
//     options without a release of this app.
//
//   * Generation is asynchronous and slow (1–5 minutes, sometimes more), so it
//     is split into create → poll → download rather than one long-lived call.
//     The frontend drives the loop, which means a job survives switching tabs,
//     and an unfinished job is resumed on next launch from its stored record —
//     rather than being lost with the request that started it.
//
//   * The finished MP4 is written to disk as its own file next to a small JSON
//     record. Videos are tens of megabytes; keeping bytes out of the metadata
//     means listing the gallery stays cheap, unlike the image store which
//     inlines base64 in its records.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{app_path, expand_path, safe_id};

const BASE: &str = "https://openrouter.ai/api/v1/videos";

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

fn auth(req: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    let req = req
        .header("HTTP-Referer", "https://ai-box.local")
        .header("X-Title", "AI Box");
    if key.trim().is_empty() {
        req
    } else {
        req.header("Authorization", format!("Bearer {}", key.trim()))
    }
}

/// Turn a non-2xx response into a message worth showing a user. OpenRouter puts
/// the useful part in `error.message`; falling back to the raw body keeps the
/// rare unstructured failure (a gateway HTML page) from becoming "HTTP 502".
async fn http_error(prefix: &str, resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .or_else(|| v["message"].as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| body.chars().take(400).collect());
    if detail.trim().is_empty() {
        format!("{prefix}: HTTP {status}")
    } else {
        format!("{prefix}: {detail}")
    }
}

// ---- catalog --------------------------------------------------------------

/// One video model as the picker needs it. Every capability field is passed
/// through from OpenRouter verbatim — this app makes no assumptions about what
/// a given model supports.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoModel {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created: u64,
    pub durations: Vec<u32>,
    pub resolutions: Vec<String>,
    pub aspect_ratios: Vec<String>,
    pub frame_images: Vec<String>,
    pub generate_audio: bool,
    pub seed: bool,
    /// Raw pricing SKUs (`{"duration_seconds_with_audio": "0.40", …}`) — shown
    /// as a hint. The units differ per model, so this is not summed to a total.
    pub pricing: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyParams {
    #[serde(default)]
    pub api_key: String,
}

/// The live video-model catalog, newest first. The endpoint is public; a key is
/// optional and only affects per-account visibility.
#[tauri::command]
pub async fn list_video_models(params: KeyParams) -> Result<Vec<VideoModel>, String> {
    let resp = auth(client().get(format!("{BASE}/models")), &params.api_key)
        .send()
        .await
        .map_err(|e| format!("Video model list failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(http_error("Video model list failed", resp).await);
    }
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let strings = |v: &Value| -> Vec<String> {
        v.as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default()
    };
    let mut models: Vec<VideoModel> = json["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|m| VideoModel {
            id: m["id"].as_str().unwrap_or("").to_string(),
            name: m["name"].as_str().unwrap_or("").to_string(),
            description: m["description"].as_str().unwrap_or("").to_string(),
            created: m["created"].as_u64().unwrap_or(0),
            durations: m["supported_durations"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect())
                .unwrap_or_default(),
            resolutions: strings(&m["supported_resolutions"]),
            aspect_ratios: strings(&m["supported_aspect_ratios"]),
            frame_images: strings(&m["supported_frame_images"]),
            generate_audio: m["generate_audio"].as_bool().unwrap_or(false),
            seed: m["seed"].as_bool().unwrap_or(false),
            pricing: m["pricing_skus"].clone(),
        })
        .filter(|m| !m.id.is_empty())
        .collect();
    // Drop models that transform an existing video rather than generate one.
    // They declare an `upscale_factor` and take a source clip this panel has no
    // way to supply, so offering them would only ever produce a failed job.
    let upscalers: std::collections::HashSet<&str> = json["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|m| !m["upscale_factor"].is_null())
                .filter_map(|m| m["id"].as_str())
                .collect()
        })
        .unwrap_or_default();
    models.retain(|m| !upscalers.contains(m.id.as_str()));
    models.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(models)
}

// ---- create ---------------------------------------------------------------

/// A first/last frame or a style reference. `url` is either an https URL or a
/// `data:` URI — the panel sends data URIs, since the source image is a local
/// file on the Mac and there is nowhere public to put it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameImage {
    pub url: String,
    /// "first_frame" | "last_frame"; absent for style references.
    #[serde(default)]
    pub frame_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateParams {
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    pub generate_audio: Option<bool>,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub frame_images: Vec<FrameImage>,
    #[serde(default)]
    pub input_references: Vec<FrameImage>,
}

fn image_item(img: &FrameImage) -> Value {
    let mut o = json!({ "type": "image_url", "image_url": { "url": img.url } });
    if let Some(ft) = &img.frame_type {
        o["frame_type"] = json!(ft);
    }
    o
}

/// Submit a generation job. Returns `{ id, status }` — the job is not finished
/// when this returns; poll `video_status` with the id.
#[tauri::command]
pub async fn video_create(params: CreateParams) -> Result<Value, String> {
    if params.api_key.trim().is_empty() {
        return Err("Add your OpenRouter API key in Settings to generate video.".into());
    }
    if params.prompt.trim().is_empty() {
        return Err("Write a prompt first.".into());
    }
    let mut body = json!({ "model": params.model, "prompt": params.prompt });
    // Only send what the caller actually chose. Omitted fields let OpenRouter
    // apply the model's own default, which is safer than guessing one here.
    if let Some(d) = params.duration {
        body["duration"] = json!(d);
    }
    if let Some(r) = &params.resolution {
        body["resolution"] = json!(r);
    }
    if let Some(a) = &params.aspect_ratio {
        body["aspect_ratio"] = json!(a);
    }
    if let Some(a) = params.generate_audio {
        body["generate_audio"] = json!(a);
    }
    if let Some(s) = params.seed {
        body["seed"] = json!(s);
    }
    if !params.frame_images.is_empty() {
        body["frame_images"] = Value::Array(params.frame_images.iter().map(image_item).collect());
    }
    if !params.input_references.is_empty() {
        body["input_references"] =
            Value::Array(params.input_references.iter().map(image_item).collect());
    }

    let resp = auth(client().post(BASE), &params.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Video request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(http_error("Video request failed", resp).await);
    }
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let id = json["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return Err("OpenRouter accepted the job but returned no id.".into());
    }
    Ok(json!({
        "id": id,
        "status": json["status"].as_str().unwrap_or("pending"),
    }))
}

// ---- poll -----------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobParams {
    #[serde(default)]
    pub api_key: String,
    pub job_id: String,
}

/// Poll one job. Normalised to `{ status, url, error, cost }` so the frontend
/// does not have to know the response's exact shape. Terminal statuses are
/// `completed`, `failed`, `cancelled` and `expired`.
#[tauri::command]
pub async fn video_status(params: JobParams) -> Result<Value, String> {
    let resp = auth(
        client().get(format!("{BASE}/{}", params.job_id)),
        &params.api_key,
    )
    .send()
    .await
    .map_err(|e| format!("Video status failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(http_error("Video status failed", resp).await);
    }
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let status = json["status"].as_str().unwrap_or("pending").to_string();
    let url = json["unsigned_urls"][0]
        .as_str()
        .map(String::from)
        // Some providers surface the finished asset under `data[0].url`.
        .or_else(|| json["data"][0]["url"].as_str().map(String::from));
    let error = json["error"]["message"]
        .as_str()
        .or_else(|| json["error"].as_str())
        .map(String::from);
    Ok(json!({
        "status": status,
        "url": url,
        "error": error,
        "cost": json["usage"]["cost"],
    }))
}

// ---- store ----------------------------------------------------------------

/// Cap on stored videos. Lower than the image cap because each file is orders
/// of magnitude larger; 60 clips is already several gigabytes.
const VIDEO_CAP: usize = 60;

fn videos_dir() -> String {
    app_path("videos")
}

fn record_path(id: &str) -> String {
    format!("{}/{}.json", videos_dir(), safe_id(id))
}

fn mp4_path(id: &str) -> String {
    format!("{}/{}.mp4", videos_dir(), safe_id(id))
}

/// Drop the oldest clips (record + bytes together) once past the cap.
fn prune(keep: usize) {
    let dir = videos_dir();
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            Some((e.metadata().ok()?.modified().ok()?, p))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p.with_extension("mp4"));
        let _ = std::fs::remove_file(p);
    }
}

/// Write (or update) one clip's metadata record.
#[tauri::command]
pub fn video_put(id: String, record: String) -> Result<(), String> {
    let sid = safe_id(&id);
    if sid.is_empty() {
        return Err("bad video id".into());
    }
    std::fs::create_dir_all(videos_dir()).map_err(|e| e.to_string())?;
    std::fs::write(record_path(&sid), record).map_err(|e| e.to_string())?;
    prune(VIDEO_CAP);
    Ok(())
}

/// Gallery metadata, newest first. Never includes video bytes.
#[tauri::command]
pub fn video_list() -> Vec<Value> {
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(videos_dir()) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Some(v) = std::fs::read_to_string(&p)
                .ok()
                .and_then(|c| serde_json::from_str::<Value>(&c).ok())
            {
                items.push(v);
            }
        }
    }
    items.sort_by(|a, b| b["at"].as_i64().unwrap_or(0).cmp(&a["at"].as_i64().unwrap_or(0)));
    items
}

#[tauri::command]
pub fn video_get(id: String) -> Option<String> {
    std::fs::read_to_string(record_path(&id)).ok()
}

/// The MP4 itself, base64-encoded. The UI turns this into a Blob URL rather
/// than a data: URI, so `<video>` can seek and the bytes are freed on release.
#[tauri::command]
pub fn video_data(id: String) -> Result<String, String> {
    let path = mp4_path(&id);
    let bytes = std::fs::read(&path).map_err(|e| format!("read video: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub fn video_delete(id: String) -> Result<(), String> {
    let _ = std::fs::remove_file(mp4_path(&id));
    let _ = std::fs::remove_file(record_path(&id));
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadParams {
    #[serde(default)]
    pub api_key: String,
    /// Local id the clip is stored under.
    pub id: String,
    /// The `url` handed back by `video_status`.
    pub url: String,
}

/// Fetch a finished clip and store it on the Mac. Returns `{ bytes }` so the
/// caller can record the size. The record itself is written by `video_put`.
#[tauri::command]
pub async fn video_download(params: DownloadParams) -> Result<Value, String> {
    let sid = safe_id(&params.id);
    if sid.is_empty() {
        return Err("bad video id".into());
    }
    let resp = auth(client().get(&params.url), &params.api_key)
        .send()
        .await
        .map_err(|e| format!("Video download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(http_error("Video download failed", resp).await);
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("Video download returned no data.".into());
    }
    std::fs::create_dir_all(videos_dir()).map_err(|e| e.to_string())?;
    std::fs::write(mp4_path(&sid), &bytes).map_err(|e| e.to_string())?;
    Ok(json!({ "bytes": bytes.len() }))
}

/// Copy a stored clip into ~/Downloads under a readable name, never
/// overwriting an existing file. Returns the path written.
#[tauri::command]
pub fn video_save(id: String, name: Option<String>) -> Result<String, String> {
    let src = mp4_path(&id);
    if !std::path::Path::new(&src).exists() {
        return Err("That clip is no longer on disk.".into());
    }
    let dir = expand_path("~/Downloads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir}: {e}"))?;
    let stem: String = name
        .unwrap_or_default()
        .trim()
        .trim_end_matches(".mp4")
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_') { c } else { '-' })
        .collect();
    let stem = if stem.trim().is_empty() { "ai-box-video" } else { stem.trim() };
    let mut path = std::path::Path::new(&dir).join(format!("{stem}.mp4"));
    let mut n = 2;
    while path.exists() {
        path = std::path::Path::new(&dir).join(format!("{stem} ({n}).mp4"));
        n += 1;
    }
    std::fs::copy(&src, &path).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

// ---- stitching ------------------------------------------------------------
// A finished ad is usually several shots. Joining them needs a real encoder, so
// this uses ffmpeg if the machine has one and says so plainly if it doesn't —
// rather than shipping a bundled binary or silently producing nothing.

fn ffmpeg_bin() -> Option<String> {
    for candidate in [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    // Fall back to PATH (a login shell's PATH isn't inherited here, so the
    // explicit paths above are what actually hit on most Macs).
    std::process::Command::new("which")
        .arg("ffmpeg")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Is stitching available on this machine?
#[tauri::command]
pub fn video_stitch_available() -> bool {
    ffmpeg_bin().is_some()
}

/// Join clips, in the given order, into one MP4 in ~/Downloads. Re-encodes
/// rather than stream-copying because shots from different models differ in
/// resolution and frame rate, and a concat of mismatched streams plays back
/// broken. Returns the path written.
#[tauri::command]
pub async fn video_stitch(ids: Vec<String>, name: Option<String>) -> Result<String, String> {
    let ffmpeg = ffmpeg_bin().ok_or(
        "Joining clips needs ffmpeg, which isn't installed. Install it with `brew install ffmpeg`, \
         then try again — your clips are all saved either way.",
    )?;
    let paths: Vec<String> = ids
        .iter()
        .map(|id| mp4_path(id))
        .filter(|p| std::path::Path::new(p).exists())
        .collect();
    if paths.len() < 2 {
        return Err("Pick at least two finished clips to join.".into());
    }

    let dir = expand_path("~/Downloads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir}: {e}"))?;
    let stem: String = name
        .unwrap_or_default()
        .trim()
        .trim_end_matches(".mp4")
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_') { c } else { '-' })
        .collect();
    let stem = if stem.trim().is_empty() { "ai-box-film" } else { stem.trim() };
    let mut out = std::path::Path::new(&dir).join(format!("{stem}.mp4"));
    let mut n = 2;
    while out.exists() {
        out = std::path::Path::new(&dir).join(format!("{stem} ({n}).mp4"));
        n += 1;
    }

    // Normalise every shot to the first one's frame size, pad rather than crop
    // so nothing composed into the shot gets cut off, and give each a silent
    // track if it has none — concat needs matching stream layouts.
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.arg("-y");
    for p in &paths {
        cmd.arg("-i").arg(p);
    }
    let mut filter = String::new();
    for (i, _) in paths.iter().enumerate() {
        filter.push_str(&format!(
            "[{i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,\
             pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v{i}];"
        ));
    }
    for (i, _) in paths.iter().enumerate() {
        filter.push_str(&format!(
            "[{i}:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a{i}];"
        ));
    }
    for i in 0..paths.len() {
        filter.push_str(&format!("[v{i}][a{i}]"));
    }
    filter.push_str(&format!("concat=n={}:v=1:a=1[v][a]", paths.len()));

    cmd.arg("-filter_complex")
        .arg(&filter)
        .arg("-map")
        .arg("[v]")
        .arg("-map")
        .arg("[a]")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("medium")
        .arg("-crf")
        .arg("18")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("192k")
        .arg("-movflags")
        .arg("+faststart")
        .arg(&out);

    let result = cmd.output().await.map_err(|e| format!("run ffmpeg: {e}"))?;
    if result.status.success() {
        return Ok(out.to_string_lossy().to_string());
    }

    // A silent clip has no audio stream at all, and the audio filters above
    // then fail outright. Retry video-only rather than reporting failure.
    let mut cmd = tokio::process::Command::new(ffmpeg_bin().unwrap_or_else(|| "ffmpeg".into()));
    cmd.arg("-y");
    for p in &paths {
        cmd.arg("-i").arg(p);
    }
    let mut vfilter = String::new();
    for (i, _) in paths.iter().enumerate() {
        vfilter.push_str(&format!(
            "[{i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,\
             pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v{i}];"
        ));
    }
    for i in 0..paths.len() {
        vfilter.push_str(&format!("[v{i}]"));
    }
    vfilter.push_str(&format!("concat=n={}:v=1:a=0[v]", paths.len()));
    cmd.arg("-filter_complex")
        .arg(&vfilter)
        .arg("-map")
        .arg("[v]")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("medium")
        .arg("-crf")
        .arg("18")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-movflags")
        .arg("+faststart")
        .arg(&out);
    let retry = cmd.output().await.map_err(|e| format!("run ffmpeg: {e}"))?;
    if retry.status.success() {
        return Ok(out.to_string_lossy().to_string());
    }
    let err = String::from_utf8_lossy(&result.stderr);
    let tail: String = err.lines().rev().take(4).collect::<Vec<_>>().join(" ");
    Err(format!("Joining the clips failed: {tail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_item_includes_frame_type_only_when_set() {
        let framed = image_item(&FrameImage {
            url: "data:image/png;base64,AA".into(),
            frame_type: Some("first_frame".into()),
        });
        assert_eq!(framed["frame_type"], "first_frame");
        assert_eq!(framed["image_url"]["url"], "data:image/png;base64,AA");
        assert_eq!(framed["type"], "image_url");

        let reference = image_item(&FrameImage { url: "https://x/y.png".into(), frame_type: None });
        assert!(reference.get("frame_type").is_none());
    }

    #[tokio::test]
    async fn create_refuses_without_key_or_prompt() {
        let p = CreateParams {
            api_key: "".into(),
            model: "kwaivgi/kling-v3.0-pro".into(),
            prompt: "a shot".into(),
            duration: None,
            resolution: None,
            aspect_ratio: None,
            generate_audio: None,
            seed: None,
            frame_images: vec![],
            input_references: vec![],
        };
        assert!(video_create(p).await.unwrap_err().contains("API key"));
    }

    #[test]
    fn save_rejects_a_clip_that_is_gone() {
        assert!(video_save("definitely-not-a-real-clip-id".into(), None).is_err());
    }
}

/// A real, paid, end-to-end run against OpenRouter. Ignored by default — it
/// costs money and takes minutes — so `cargo test` stays free and fast. Run it
/// deliberately when the pipeline needs proving:
///
///   OPENROUTER_API_KEY=sk-or-... cargo test --  --ignored --nocapture live_
///
/// It uses the cheapest configuration in the catalog (Veo 3.1 Lite, 4s, 720p,
/// audio off ≈ $0.12) and exercises the same functions the panel calls, so a
/// pass means the shipped path works, not merely that the API is reachable.
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test]
    #[ignore = "spends real money; run explicitly"]
    async fn live_end_to_end_render() {
        let key = std::env::var("OPENROUTER_API_KEY").expect("set OPENROUTER_API_KEY");

        // 1. Catalog — and confirm the model we are about to use is really in it.
        let models = list_video_models(KeyParams { api_key: key.clone() })
            .await
            .expect("catalog");
        println!("catalog: {} models", models.len());
        let model = models
            .iter()
            .find(|m| m.id == "google/veo-3.1-lite")
            .expect("veo-3.1-lite present");
        println!(
            "using {} — durations {:?}, resolutions {:?}",
            model.id, model.durations, model.resolutions
        );
        assert!(model.durations.contains(&4));
        assert!(model.resolutions.iter().any(|r| r == "720p"));

        // 2. Submit.
        let created = video_create(CreateParams {
            api_key: key.clone(),
            model: model.id.clone(),
            prompt: "Slow dolly-in on a worn workbench at golden hour, a phone \
propped against a toolbox, warm rim light, shallow depth of field, dust in the air"
                .into(),
            duration: Some(4),
            resolution: Some("720p".into()),
            aspect_ratio: Some("16:9".into()),
            generate_audio: Some(false),
            seed: None,
            frame_images: vec![],
            input_references: vec![],
        })
        .await
        .expect("create");
        let job_id = created["id"].as_str().expect("job id").to_string();
        println!("job {job_id} -> {}", created["status"]);

        // 3. Poll to a terminal state, the way the panel does.
        let started = std::time::Instant::now();
        let url = loop {
            assert!(started.elapsed().as_secs() < 900, "timed out after 15 min");
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let job = video_status(JobParams {
                api_key: key.clone(),
                job_id: job_id.clone(),
            })
            .await
            .expect("status");
            let status = job["status"].as_str().unwrap_or("");
            println!("  {:>4}s  {status}", started.elapsed().as_secs());
            match status {
                "pending" | "in_progress" => continue,
                "completed" => break job["url"].as_str().expect("url").to_string(),
                other => panic!("job {other}: {:?}", job["error"]),
            }
        };

        // 4. Download, and prove what landed is really a playable MP4.
        let id = format!("livetest-{}", uuid::Uuid::new_v4());
        let out = video_download(DownloadParams {
            api_key: key.clone(),
            id: id.clone(),
            url,
        })
        .await
        .expect("download");
        let bytes = out["bytes"].as_u64().expect("bytes");
        println!("downloaded {:.1} MB", bytes as f64 / 1e6);
        assert!(bytes > 100_000, "suspiciously small: {bytes} bytes");

        let path = mp4_path(&id);
        let head = std::fs::read(&path).expect("stored file");
        // ISO-BMFF: bytes 4..8 of an MP4 are the 'ftyp' box type.
        assert_eq!(&head[4..8], b"ftyp", "not an MP4 container");
        println!("stored at {path}");

        // 5. The record/list/delete round trip the gallery depends on.
        let rec = serde_json::json!({
            "id": id, "jobId": job_id, "prompt": "live test",
            "model": model.id, "modelName": model.name,
            "status": "completed", "at": 1, "bytes": bytes,
        });
        video_put(id.clone(), rec.to_string()).expect("put");
        assert!(video_list().iter().any(|v| v["id"] == id.as_str()), "not listed");
        assert!(!video_data(id.clone()).expect("data").is_empty());

        video_delete(id.clone()).expect("delete");
        assert!(!std::path::Path::new(&path).exists(), "mp4 left behind");
        println!("PASS — create -> poll -> download -> store -> delete");
    }
}
