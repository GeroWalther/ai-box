// Motion graphics: an explainer or ad made as an animated web page, voiced,
// scored, and filmed frame by frame into an MP4.
//
// The pipeline, and why each part is what it is:
//
//   1. Research. The App Store lookup API gives the real icon, screenshots and
//      description for free; the website gives the pitch in the maker's words;
//      the person's own images (logo, product) are kept as they are — PNGs with
//      their transparency, not flattened like chat attachments. An ad shows the
//      real product, never an invented one.
//   2. Script. The text model writes it; the person edits and approves it
//      before anything that costs money runs.
//   3. Voice. The whole script in one take (more natural than sentence by
//      sentence), then the time of every word. Two routes: ElevenLabs on the
//      person's own key returns character times with the audio; any speech
//      model on OpenRouter (ElevenLabs, Gemini, MiniMax…) needs no second key,
//      and its word times come from a transcription of the take. Every
//      animation is placed on those times — that is what makes the picture
//      land on the word.
//   4. Look + images. The text model plans the look, the image motifs and the
//      sound accents; the images are made with a transparent background so the
//      composition can move, turn and combine them rather than show slides.
//   5. Sound. Music and effects are synthesised here — no library, no licence
//      question — then mixed under the voice with ducking, and brought to
//      −14 LUFS, where every platform plays it without turning it down.
//   6. Composition. The text model writes one HTML page: CSS for the look, a
//      single paused GSAP timeline for every movement, timed to the words.
//   7. Render. A headless Chrome seeks that timeline frame by frame (30 fps),
//      screenshots each frame and pipes it into ffmpeg with the mix. Anything
//      a browser can draw can be animated, and seeking makes it deterministic:
//      a slow frame never makes the video stutter.
//
// A project lives in ~/.ai-box/motion/<id>/ — project.json, assets/, the
// audio, index.html — so every step can be looked at afterwards, and the
// finished MP4 is filed in the video library like any other clip.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::AsyncWriteExt;

const GSAP: &str = include_str!("../../node_modules/gsap/dist/gsap.min.js");
const ELEVEN: &str = "https://api.elevenlabs.io";
const FPS: u32 = 30;
/// Silence before the first word, so the picture can open before the voice.
const LEAD: f64 = 0.4;
/// Picture after the last word: the end card holds while the music resolves.
const TAIL: f64 = 1.4;
const MAX_IMAGES: usize = 6;
const RATE: u32 = 44_100;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn root() -> String {
    crate::app_path("motion")
}

fn dir_of(id: &str) -> String {
    format!("{}/{}", root(), crate::safe_id(id))
}

// ---- the project -------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Brief {
    pub product: String,
    pub audience: String,
    pub message: String,
    pub tone: String,
    pub notes: String,
    /// "explainer" | "ad"
    pub kind: String,
    /// An App Store link, an app id, or an app's name.
    pub app_store: String,
    pub website: String,
    /// "9:16" | "16:9" | "1:1"
    pub format: String,
    pub seconds: u32,
    /// What the voice speaks, e.g. "English", "Deutsch".
    pub language: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    /// The file under assets/, which is also how the composition refers to it.
    pub file: String,
    /// icon | screenshot | user | ai
    pub kind: String,
    pub width: u32,
    pub height: u32,
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub at: i64,
    pub title: String,
    /// None while running.
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    /// researching | script | running | done | failed | stopped
    pub status: String,
    pub created: i64,
    pub updated: i64,
    pub rev: u64,
    pub brief: Brief,
    /// What research found, as the script writer was given it.
    pub research: String,
    pub title: String,
    pub script: String,
    pub voice_id: String,
    pub voice_name: String,
    /// "elevenlabs" (own key) | "openrouter"
    #[serde(default)]
    pub voice_source: String,
    /// The OpenRouter speech model, when voice_source is "openrouter".
    #[serde(default)]
    pub speech_model: String,
    pub image_model: String,
    pub text_model: String,
    pub base_url: String,
    pub assets: Vec<Asset>,
    pub steps: Vec<Step>,
    /// Dollars, as the providers reported them.
    pub cost: f64,
    /// Characters sent to ElevenLabs (billed against the person's quota).
    pub voice_chars: usize,
    /// Videos made from this project so far.
    #[serde(default)]
    pub versions: u32,
    /// What the last video was made with (script, voice, image model,
    /// format), so "Make video" redoes only what changed.
    #[serde(default)]
    pub made: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    projects: Mutex<HashMap<String, Project>>,
    stops: Mutex<HashMap<String, Arc<AtomicBool>>>,
    loaded: std::sync::OnceLock<()>,
}

#[derive(Default, Clone)]
pub struct Motion(Arc<Inner>);

fn save(p: &Project) {
    let d = dir_of(&p.id);
    let _ = std::fs::create_dir_all(&d);
    if let Ok(raw) = serde_json::to_string_pretty(p) {
        let _ = std::fs::write(format!("{d}/project.json"), raw);
    }
}

impl Motion {
    /// Projects from earlier launches. One that was mid-run when the app quit is
    /// marked stopped; "Make video" again picks it up from its approved script.
    fn ensure_loaded(&self) {
        self.0.loaded.get_or_init(|| {
            let mut map = self.0.projects.lock().unwrap();
            for entry in std::fs::read_dir(root()).into_iter().flatten().flatten() {
                let Ok(raw) = std::fs::read_to_string(entry.path().join("project.json")) else { continue };
                let Ok(mut p) = serde_json::from_str::<Project>(&raw) else { continue };
                if p.status == "running" || p.status == "researching" {
                    p.status = if p.script.is_empty() { "failed".into() } else { "stopped".into() };
                    p.error = Some("AI Box was closed while this video was being made.".into());
                    save(&p);
                }
                map.insert(p.id.clone(), p);
            }
        });
    }

    fn get(&self, id: &str) -> Option<Project> {
        self.ensure_loaded();
        self.0.projects.lock().unwrap().get(id).cloned()
    }

    fn update<R: Runtime>(&self, app: &AppHandle<R>, id: &str, f: impl FnOnce(&mut Project)) {
        let rev = {
            let mut map = self.0.projects.lock().unwrap();
            let Some(p) = map.get_mut(id) else { return };
            f(p);
            p.rev += 1;
            p.updated = now_ms();
            save(p);
            p.rev
        };
        let _ = app.emit("motion://changed", json!({ "id": id, "rev": rev }));
    }

    fn stopped(&self, id: &str) -> bool {
        self.0.stops.lock().unwrap().get(id).map(|f| f.load(Ordering::Relaxed)).unwrap_or(true)
    }
}

/// One step of the job: shown on the timeline as it runs, ticked or crossed
/// when it ends.
struct Job<R: Runtime> {
    app: AppHandle<R>,
    motion: Motion,
    id: String,
    dir: String,
}

impl<R: Runtime> Job<R> {
    fn begin(&self, title: &str) -> usize {
        let mut i = 0;
        self.motion.update(&self.app, &self.id, |p| {
            p.steps.push(Step { at: now_ms(), title: title.into(), ok: None, detail: None });
            i = p.steps.len() - 1;
        });
        i
    }

    fn end(&self, i: usize, ok: bool, detail: Option<String>) {
        self.motion.update(&self.app, &self.id, |p| {
            if let Some(s) = p.steps.get_mut(i) {
                s.ok = Some(ok);
                s.detail = detail.map(|d| d.chars().take(2000).collect());
            }
        });
    }

    async fn step<T>(&self, title: &str, work: impl std::future::Future<Output = Result<(T, Option<String>), String>>) -> Result<T, String> {
        if self.motion.stopped(&self.id) {
            return Err("stopped".into());
        }
        let i = self.begin(title);
        match work.await {
            Ok((v, detail)) => {
                self.end(i, true, detail);
                Ok(v)
            }
            Err(e) => {
                self.end(i, false, Some(e.clone()));
                Err(e)
            }
        }
    }

    fn project(&self) -> Project {
        self.motion.get(&self.id).expect("project exists while its job runs")
    }

    fn path(&self, rel: &str) -> String {
        format!("{}/{rel}", self.dir)
    }
}

// ---- keys and models ---------------------------------------------------------

fn settings<R: Runtime>(app: &AppHandle<R>) -> Value {
    app.state::<crate::server::RemoteSettings>().value()
}

fn key(settings: &Value, name: &str) -> String {
    settings[name].as_str().unwrap_or("").trim().to_string()
}

async fn ask<R: Runtime>(app: &AppHandle<R>, base_url: &str, model: &str, system: &str, user: Value, temperature: f32) -> Result<String, String> {
    let s = settings(app);
    let reply = crate::chat_completion(crate::ChatCompletionParams {
        base_url: base_url.to_string(),
        api_key: crate::server::mac_key_for(&s, base_url, model),
        model: model.to_string(),
        messages: json!([{ "role": "system", "content": system }, { "role": "user", "content": user }]),
        tools: json!([]),
        temperature,
    })
    .await?;
    let text = reply["content"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err("The text model returned nothing.".into());
    }
    Ok(text)
}

/// The first JSON object in a reply, fenced or not.
fn json_in(text: &str) -> Option<Value> {
    for (i, _) in text.match_indices('{') {
        let mut it = serde_json::Deserializer::from_str(&text[i..]).into_iter::<Value>();
        if let Some(Ok(v)) = it.next() {
            if v.is_object() {
                return Some(v);
            }
        }
    }
    None
}

/// The HTML document in a reply.
fn html_in(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let start = lower.find("<!doctype").or_else(|| lower.find("<html"))?;
    let end = lower.rfind("</html>")? + "</html>".len();
    (end > start).then(|| text[start..end].to_string())
}

fn stage_size(format: &str) -> (u32, u32) {
    match format {
        "16:9" => (1920, 1080),
        "1:1" => (1080, 1080),
        _ => (1080, 1920),
    }
}

/// Image models on OpenRouter that can return a transparent background,
/// newest first. Read from the live catalog, like every other model list here.
pub async fn motion_image_models<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Value>, String> {
    let s = settings(&app);
    let resp = reqwest::Client::new()
        .get("https://openrouter.ai/api/v1/images/models")
        .header("Authorization", format!("Bearer {}", key(&s, "openrouterKey")))
        .send()
        .await
        .map_err(|e| format!("Image model list failed: {e}"))?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut out: Vec<Value> = json["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| {
            m["supported_parameters"]["background"]["values"]
                .as_array()
                .map_or(false, |v| v.iter().any(|x| x == "transparent"))
        })
        .map(|m| json!({ "id": m["id"], "name": m["name"], "created": m["created"] }))
        .collect();
    out.sort_by(|a, b| b["created"].as_u64().cmp(&a["created"].as_u64()));
    Ok(out)
}

/// The person's ElevenLabs voices, each with its free preview clip.
pub async fn motion_voices<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Value>, String> {
    let k = key(&settings(&app), "elevenlabsKey");
    if k.is_empty() {
        return Err("Add your ElevenLabs key in Settings → General → Voice for videos.".into());
    }
    let resp = reqwest::Client::new()
        .get(format!("{ELEVEN}/v2/voices?page_size=100"))
        .header("xi-api-key", &k)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(eleven_error(status, &resp.text().await.unwrap_or_default()));
    }
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["voices"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|v| {
            let labels = &v["labels"];
            let tags: Vec<String> = ["gender", "age", "accent", "descriptive", "use_case"]
                .iter()
                .filter_map(|k| labels[*k].as_str().map(|s| s.replace('_', " ")))
                .collect();
            json!({
                "id": v["voice_id"],
                "name": v["name"],
                "description": v["description"],
                "tags": tags.join(" · "),
                "previewUrl": v["preview_url"],
                "category": v["category"],
            })
        })
        .collect())
}

/// ElevenLabs words its errors as {"detail": {"message": …}} (or a plain
/// string), which the OpenAI-shaped reader misses — and its sentence is the
/// useful part ("quota exceeded", "voice not found").
fn eleven_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body).ok().and_then(|v| {
        v["detail"]["message"].as_str().or(v["detail"].as_str()).map(String::from)
    });
    match detail {
        Some(d) => format!("ElevenLabs: {d} (HTTP {})", status.as_u16()),
        None => format!("ElevenLabs: {}", crate::friendly_http_error(status, body)),
    }
}

// ---- 1. research ---------------------------------------------------------------

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let r = reqwest::Client::new().get(url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status()));
    }
    Ok(r.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

/// Save an image into assets/ as PNG (keeping transparency), no larger than
/// `max` on its long side. Returns the asset.
fn store_image(dir: &str, file: &str, bytes: &[u8], kind: &str, note: &str, max: u32) -> Result<Asset, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("not an image: {e}"))?;
    let img = if img.width().max(img.height()) > max { img.resize(max, max, image::imageops::FilterType::Lanczos3) } else { img };
    let _ = std::fs::create_dir_all(format!("{dir}/assets"));
    img.save_with_format(format!("{dir}/assets/{file}"), image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(Asset { file: file.into(), kind: kind.into(), width: img.width(), height: img.height(), note: note.into() })
}

/// The numeric id in an App Store link (…/id6738291234), or a bare id.
fn app_id(q: &str) -> Option<String> {
    q.split(|c: char| !c.is_ascii_alphanumeric())
        .find_map(|w| w.strip_prefix("id").filter(|n| n.len() >= 6 && n.chars().all(|c| c.is_ascii_digit())).map(String::from))
        .or_else(|| (q.len() >= 6 && q.chars().all(|c| c.is_ascii_digit())).then(|| q.to_string()))
}

/// An image file name the model chose, made safe: lowercase, dashes, .png.
fn png_name(s: &str) -> String {
    let stem: String = s
        .trim_end_matches(".png")
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let stem: String = stem.chars().take(40).collect();
    if stem.is_empty() { String::new() } else { format!("ai-{stem}.png") }
}

/// The App Store's own record for an app: from a link (…/id123456), a bare
/// id, or failing those a search by name.
async fn app_store(query: &str, dir: &str) -> Result<(String, Vec<Asset>), String> {
    let q = query.trim();
    let country = q.split('/').find(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_lowercase())).unwrap_or("us");
    let url = match app_id(q) {
        Some(id) => format!("https://itunes.apple.com/lookup?id={id}&country={country}"),
        None => format!(
            "https://itunes.apple.com/search?entity=software&limit=1&country={country}&term={}",
            q.split_whitespace().collect::<Vec<_>>().join("+")
        ),
    };
    let json: Value = serde_json::from_slice(&download(&url).await?).map_err(|e| e.to_string())?;
    let app = json["results"].get(0).cloned().ok_or("the App Store has no app by that name or id")?;
    let mut assets = vec![];
    if let Some(icon) = app["artworkUrl512"].as_str() {
        if let Ok(b) = download(icon).await {
            if let Ok(a) = store_image(dir, "app-icon.png", &b, "icon", "the app's real App Store icon", 1024) {
                assets.push(a);
            }
        }
    }
    let shots: Vec<String> = app["screenshotUrls"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_str().map(String::from)).take(4).collect();
    for (i, u) in shots.iter().enumerate() {
        if let Ok(b) = download(u).await {
            if let Ok(a) = store_image(dir, &format!("screenshot-{}.png", i + 1), &b, "screenshot", &format!("real App Store screenshot {}", i + 1), 1290) {
                assets.push(a);
            }
        }
    }
    let desc: String = app["description"].as_str().unwrap_or("").chars().take(3000).collect();
    let text = format!(
        "App Store: {} by {} — {} · {} · rated {:.1} ({} ratings)\n{}",
        app["trackName"].as_str().unwrap_or(""),
        app["sellerName"].as_str().unwrap_or(""),
        app["primaryGenreName"].as_str().unwrap_or(""),
        app["formattedPrice"].as_str().unwrap_or(""),
        app["averageUserRating"].as_f64().unwrap_or(0.0),
        app["userRatingCount"].as_u64().unwrap_or(0),
        desc
    );
    Ok((text, assets))
}

// ---- the chat's handle on a project ---------------------------------------------------
//
// A video is made in conversation (tasks.rs, kind "video"): the agent asks what
// it needs, researches, writes the script with the person, and calls these.

/// A new, empty project for a video chat.
pub fn create<R: Runtime>(app: &AppHandle<R>, base_url: &str, model: &str) -> Project {
    let motion = app.state::<Motion>().inner().clone();
    motion.ensure_loaded();
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(format!("{}/assets", dir_of(&id)));
    let p = Project {
        id: id.clone(),
        status: "draft".into(),
        created: now_ms(),
        updated: now_ms(),
        rev: 1,
        brief: Brief { kind: "ad".into(), format: "9:16".into(), language: "English".into(), ..Default::default() },
        research: String::new(),
        title: "New video".into(),
        script: String::new(),
        voice_id: String::new(),
        voice_name: String::new(),
        voice_source: String::new(),
        speech_model: String::new(),
        image_model: String::new(),
        text_model: model.into(),
        base_url: base_url.into(),
        assets: vec![],
        steps: vec![],
        cost: 0.0,
        voice_chars: 0,
        versions: 0,
        made: Value::Null,
        video_id: None,
        error: None,
    };
    save(&p);
    motion.0.projects.lock().unwrap().insert(id, p.clone());
    p
}

/// The text model follows the chat's: switching models in the chat switches
/// who writes the animation too.
pub fn set_text_model<R: Runtime>(app: &AppHandle<R>, id: &str, base_url: &str, model: &str) {
    app.state::<Motion>().update(app, id, |p| {
        p.base_url = base_url.into();
        p.text_model = model.into();
    });
}

/// An image the person attached in the chat — a logo, a product photo — kept
/// as the original, transparency and all. Returns the asset's file name.
pub fn add_image<R: Runtime>(app: &AppHandle<R>, id: &str, attachment: &str, name: &str) -> Result<String, String> {
    let motion = app.state::<Motion>().inner().clone();
    motion.get(id).ok_or("no such video project")?;
    let bytes = crate::attach::original_bytes(attachment)?;
    let stem: String = name
        .rsplit('/')
        .next()
        .unwrap_or("image")
        .split('.')
        .next()
        .unwrap_or("image")
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(30)
        .collect();
    let n = &uuid::Uuid::new_v4().simple().to_string()[..6];
    let a = store_image(&dir_of(id), &format!("user-{n}-{stem}.png"), &bytes, "user", &format!("the person's own image \"{name}\" — show it as it is"), 1600)?;
    let file = a.file.clone();
    motion.update(app, id, |p| p.assets.push(a));
    Ok(file)
}

/// The App Store record and/or a website, for the script and the real assets.
pub async fn research<R: Runtime>(app: &AppHandle<R>, id: &str, app_store_query: &str, website: &str) -> Result<String, String> {
    let motion = app.state::<Motion>().inner().clone();
    let dir = dir_of(id);
    let mut found = vec![];
    if !app_store_query.trim().is_empty() {
        let (text, assets) = app_store(app_store_query, &dir).await?;
        let files: Vec<String> = assets.iter().map(|a| format!("assets/{} ({})", a.file, a.note)).collect();
        motion.update(app, id, |p| {
            p.assets.retain(|a| a.kind != "icon" && a.kind != "screenshot");
            p.assets.extend(assets);
        });
        found.push(format!("{text}\n\nSaved for the video: {}", if files.is_empty() { "(no images)".into() } else { files.join(", ") }));
    }
    if !website.trim().is_empty() {
        let url = if website.contains("://") { website.to_string() } else { format!("https://{}", website.trim()) };
        let t = crate::web_fetch(url.clone()).await?;
        found.push(format!("Website {url}:\n{}", t.chars().take(5000).collect::<String>()));
    }
    let text = found.join("\n\n");
    motion.update(app, id, |p| {
        p.research = format!("{}\n\n{}", p.research, text).trim().to_string();
    });
    Ok(text)
}

/// The images the video can use, for the agent.
pub fn assets_text<R: Runtime>(app: &AppHandle<R>, id: &str) -> String {
    app.state::<Motion>().get(id).map(|p| asset_lines(&p.assets)).unwrap_or_default()
}

// ---- 3. voice -------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
struct Word {
    w: String,
    /// Seconds from the start of the video (the lead-in included).
    s: f64,
    e: f64,
}

/// Character times from ElevenLabs → word times.
fn words_from(alignment: &Value, offset: f64) -> Vec<Word> {
    let chars = alignment["characters"].as_array().cloned().unwrap_or_default();
    let starts = alignment["character_start_times_seconds"].as_array().cloned().unwrap_or_default();
    let ends = alignment["character_end_times_seconds"].as_array().cloned().unwrap_or_default();
    let mut out = vec![];
    let mut cur: Option<Word> = None;
    for (i, c) in chars.iter().enumerate() {
        let c = c.as_str().unwrap_or("");
        let (s, e) = (starts.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0), ends.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0));
        if c.trim().is_empty() {
            out.extend(cur.take());
            continue;
        }
        match cur.as_mut() {
            Some(w) => {
                w.w.push_str(c);
                w.e = e + offset;
            }
            None => cur = Some(Word { w: c.to_string(), s: s + offset, e: e + offset }),
        }
    }
    out.extend(cur);
    out
}

/// The recorded take, whichever route made it.
fn voice_file(dir: &str) -> String {
    let wav = format!("{dir}/voice.wav");
    if std::path::Path::new(&wav).exists() { wav } else { format!("{dir}/voice.mp3") }
}

async fn voice<R: Runtime>(job: &Job<R>, p: &Project) -> Result<(Vec<Word>, f64, f64), String> {
    let _ = std::fs::remove_file(job.path("voice.wav"));
    let _ = std::fs::remove_file(job.path("voice.mp3"));
    if p.voice_source == "elevenlabs" {
        let (w, d) = voice_elevenlabs(job, p).await?;
        return Ok((w, d, 0.0));
    }
    voice_openrouter(job, p).await
}

async fn voice_elevenlabs<R: Runtime>(job: &Job<R>, p: &Project) -> Result<(Vec<Word>, f64), String> {
    let k = key(&settings(&job.app), "elevenlabsKey");
    if k.is_empty() {
        return Err("No ElevenLabs key — add it in Settings.".into());
    }
    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(240))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{ELEVEN}/v1/text-to-speech/{}/with-timestamps?output_format=mp3_44100_128", p.voice_id))
        .header("xi-api-key", &k)
        .json(&json!({ "text": p.script, "model_id": "eleven_v4" }))
        .send()
        .await
        .map_err(|e| format!("ElevenLabs: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(eleven_error(status, &resp.text().await.unwrap_or_default()));
    }
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let audio = base64::engine::general_purpose::STANDARD
        .decode(json["audio_base64"].as_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    std::fs::write(job.path("voice.mp3"), &audio).map_err(|e| e.to_string())?;
    let words = words_from(&json["alignment"], LEAD);
    let spoken = probe_seconds(&job.path("voice.mp3")).await.unwrap_or_else(|| words.last().map_or(0.0, |w| w.e - LEAD));
    std::fs::write(job.path("words.json"), serde_json::to_string(&words).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok((words, spoken))
}

/// Speech from an OpenRouter model. Returns the audio and its file extension.
/// Most models answer in MP3; some (Gemini) only in raw PCM, which is wrapped
/// as WAV here using the rate the response declares.
async fn or_speech(key: &str, model: &str, voice: &str, text: &str) -> Result<(Vec<u8>, &'static str, Option<String>), String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(240)).build().map_err(|e| e.to_string())?;
    let mut format = "mp3";
    loop {
        let resp = client
            .post("https://openrouter.ai/api/v1/audio/speech")
            .header("Authorization", format!("Bearer {key}"))
            .header("HTTP-Referer", "https://ai-box.local")
            .header("X-Title", "AI Box")
            .json(&json!({ "model": model, "input": text, "voice": voice, "response_format": format }))
            .send()
            .await
            .map_err(|e| format!("speech request failed: {e}"))?;
        let status = resp.status();
        let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let gen = resp.headers().get("x-generation-id").and_then(|v| v.to_str().ok()).map(String::from);
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        if !status.is_success() {
            let body = String::from_utf8_lossy(&bytes).to_string();
            if format == "mp3" && body.contains("pcm") {
                format = "pcm";
                continue;
            }
            return Err(format!("{model}: {}", crate::friendly_http_error(status, &body)));
        }
        if ctype.starts_with("audio/pcm") || format == "pcm" {
            let param = |k: &str| ctype.split(';').find_map(|p| p.trim().strip_prefix(k).and_then(|v| v.parse::<u32>().ok()));
            return Ok((pcm_wav(&bytes, param("rate=").unwrap_or(24_000), param("channels=").unwrap_or(1) as u16), "wav", gen));
        }
        return Ok((bytes, "mp3", gen));
    }
}

/// 16-bit little-endian PCM → a WAV file.
fn pcm_wav(pcm: &[u8], rate: u32, channels: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    out.extend_from_slice(&(channels * 2).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// What a generation cost, as OpenRouter bills it. Best effort: the record
/// can take a moment to appear.
async fn generation_cost(key: &str, id: &str) -> f64 {
    for _ in 0..4 {
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let Ok(r) = reqwest::Client::new()
            .get(format!("https://openrouter.ai/api/v1/generation?id={id}"))
            .header("Authorization", format!("Bearer {key}"))
            .send()
            .await
        else {
            continue;
        };
        if let Ok(v) = r.json::<Value>().await {
            if let Some(c) = v["data"]["total_cost"].as_f64() {
                return c;
            }
        }
    }
    0.0
}

/// Word times for a take, from a transcription. The script goes along as the
/// prompt, so names and brand words are heard the way they are written.
async fn transcribe_words(key: &str, path: &str, script: &str) -> Result<(Vec<Word>, f64), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let name = path.rsplit('/').next().unwrap_or("voice.mp3").to_string();
    let mime = if name.ends_with(".wav") { "audio/wav" } else { "audio/mpeg" };
    let form = reqwest::multipart::Form::new()
        .text("model", "openai/whisper-1")
        .text("response_format", "verbose_json")
        .text("timestamp_granularities[]", "word")
        .text("prompt", script.chars().take(800).collect::<String>())
        .part("file", reqwest::multipart::Part::bytes(bytes).file_name(name).mime_str(mime).map_err(|e| e.to_string())?);
    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?
        .post("https://openrouter.ai/api/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("transcription failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Word timing: {}", crate::friendly_http_error(status, &text)));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let words: Vec<Word> = v["words"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|w| Some(Word { w: w["word"].as_str()?.trim().to_string(), s: w["start"].as_f64()? + LEAD, e: w["end"].as_f64()? + LEAD }))
        .collect();
    if words.is_empty() {
        return Err("The transcription returned no word times.".into());
    }
    Ok((words, v["usage"]["cost"].as_f64().unwrap_or(0.0)))
}

async fn voice_openrouter<R: Runtime>(job: &Job<R>, p: &Project) -> Result<(Vec<Word>, f64, f64), String> {
    let k = key(&settings(&job.app), "openrouterKey");
    let (audio, ext, gen) = or_speech(&k, &p.speech_model, &p.voice_id, &p.script).await?;
    let file = job.path(&format!("voice.{ext}"));
    std::fs::write(&file, &audio).map_err(|e| e.to_string())?;
    let (words, timing_cost) = transcribe_words(&k, &file, &p.script).await?;
    let spoken = probe_seconds(&file).await.unwrap_or_else(|| words.last().map_or(0.0, |w| w.e - LEAD));
    std::fs::write(job.path("words.json"), serde_json::to_string(&words).unwrap_or_default()).map_err(|e| e.to_string())?;
    let speech_cost = match gen {
        Some(id) => generation_cost(&k, &id).await,
        None => 0.0,
    };
    Ok((words, spoken, speech_cost + timing_cost))
}

/// OpenRouter's speech models, each with the voices it offers, newest first.
pub async fn motion_speech_models<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Value>, String> {
    let s = settings(&app);
    let resp = reqwest::Client::new()
        .get("https://openrouter.ai/api/v1/models?output_modalities=speech")
        .header("Authorization", format!("Bearer {}", key(&s, "openrouterKey")))
        .send()
        .await
        .map_err(|e| format!("Speech model list failed: {e}"))?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut out: Vec<Value> = json["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m["supported_voices"].as_array().map_or(false, |v| !v.is_empty()))
        .map(|m| json!({ "id": m["id"], "name": m["name"], "created": m["created"], "voices": m["supported_voices"] }))
        .collect();
    out.sort_by(|a, b| b["created"].as_u64().cmp(&a["created"].as_u64()));
    Ok(out)
}


async fn probe_seconds(path: &str) -> Option<f64> {
    let ffprobe = ffmpeg()?.replace("ffmpeg", "ffprobe");
    let out = tokio::process::Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path])
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

// ---- 4. look and images -----------------------------------------------------------

const PLAN_SYSTEM: &str = "You are the art director of a motion-graphics video. You plan the look, the AI image motifs \
and the sound accents; a separate step writes the animation.\n\
- Images are BUILDING BLOCKS for motion graphics: isolated objects, characters, devices, props — each on a transparent \
background, all in ONE consistent illustration style. Never full-frame scenes or backgrounds, never text in images.\n\
- Plan at most {max} images, only ones that earn their place, each with its own idea. Do not plan images of things the \
real assets already show (the real app icon, screenshots and the person's own images are used as they are).\n\
- Sound accents go on the moments the picture changes: a new scene, a word that lands, a reveal. 6–14 accents for 30 s.\n\
Kinds: whoosh (transition), pop (something appears), hit (big reveal), riser (build-up ending at t), click (UI tap), shimmer (magic/sparkle).\n\
Reply with JSON only:\n\
{\"look\": {\"palette\": [\"#hex\", ...4-6], \"fonts\": \"one or two Google Fonts families\", \"style\": \"one paragraph: the visual idea, shapes, textures, motion character\", \"imageStyle\": \"one sentence describing the illustration style shared by every image\"},\n\
 \"images\": [{\"file\": \"kebab-name.png\", \"prompt\": \"what the object is, its pose and material\", \"use\": \"where it appears and why\"}],\n\
 \"sfx\": [{\"t\": 1.68, \"kind\": \"whoosh\"}],\n\
 \"music\": {\"mood\": \"upbeat|calm|epic|tech|warm\", \"bpm\": 100}}";

fn word_lines(words: &[Word]) -> String {
    words.iter().map(|w| format!("{:.2} {}", w.s, w.w)).collect::<Vec<_>>().join("\n")
}

fn asset_lines(assets: &[Asset]) -> String {
    if assets.is_empty() {
        return "(none)".into();
    }
    assets.iter().map(|a| format!("assets/{} — {}×{} — {} ({})", a.file, a.width, a.height, a.note, a.kind)).collect::<Vec<_>>().join("\n")
}

/// Crop a transparent PNG to what is actually drawn, with a little air, so the
/// composition can place and scale it by what it shows.
fn trim_alpha(img: image::RgbaImage) -> image::RgbaImage {
    let (w, h) = img.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (x, y, p) in img.enumerate_pixels() {
        if p[3] > 8 {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    if x1 <= x0 || y1 <= y0 {
        return img;
    }
    let pad = ((x1 - x0).max(y1 - y0) / 40).max(4);
    let (x0, y0) = (x0.saturating_sub(pad), y0.saturating_sub(pad));
    let (x1, y1) = ((x1 + pad).min(w - 1), (y1 + pad).min(h - 1));
    image::imageops::crop_imm(&img, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image()
}

async fn make_image(openrouter_key: &str, model: &str, prompt: &str, refs: &[String]) -> Result<(Vec<u8>, f64), String> {
    let mut body = json!({ "model": model, "prompt": prompt, "n": 1, "background": "transparent", "aspect_ratio": "1:1", "quality": "medium" });
    if !refs.is_empty() {
        body["input_references"] = json!(refs);
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let mut last = String::new();
    for attempt in 0..2 {
        let resp = client
            .post("https://openrouter.ai/api/v1/images")
            .header("Authorization", format!("Bearer {openrouter_key}"))
            .header("HTTP-Referer", "https://ai-box.local")
            .header("X-Title", "AI Box")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("image request failed: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            last = crate::friendly_http_error(status, &text);
            // "quality" is not declared by every transparent-capable model.
            if attempt == 0 && text.contains("quality") {
                body.as_object_mut().unwrap().remove("quality");
                continue;
            }
            return Err(last);
        }
        let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let cost = json["usage"]["cost"].as_f64().unwrap_or(0.0);
        if let Some(b64) = json["data"][0]["b64_json"].as_str() {
            return Ok((base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?, cost));
        }
        if let Some(url) = json["data"][0]["url"].as_str() {
            return Ok((download(url).await?, cost));
        }
        last = "the image model returned no image".into();
    }
    Err(last)
}

// ---- 5. sound ------------------------------------------------------------------------

/// A tiny, deterministic noise source (xorshift), so the same project always
/// sounds the same.
struct Noise(u32);
impl Noise {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

fn midi_hz(n: f32) -> f32 {
    440.0 * 2f32.powf((n - 69.0) / 12.0)
}

/// A music bed: pad chords, a bass, and — for the energetic moods — a beat.
/// Four-bar progressions per mood, in a key that sits under a voice.
fn music(seconds: f64, mood: &str, bpm: f32) -> Vec<[f32; 2]> {
    let n = (seconds * RATE as f64) as usize;
    let mut out = vec![[0f32; 2]; n];
    let bpm = bpm.clamp(70.0, 140.0);
    let beat = 60.0 / bpm;
    let bar = beat * 4.0;
    // Chord roots (MIDI) and whether each is minor.
    let (prog, drums): (&[(f32, bool)], bool) = match mood {
        "calm" | "warm" => (&[(53.0, false), (57.0, true), (50.0, true), (55.0, false)], false), // F Am Dm G
        "epic" => (&[(50.0, true), (46.0, false), (53.0, false), (48.0, false)], true),          // Dm Bb F C
        "tech" => (&[(45.0, true), (41.0, false), (48.0, false), (43.0, false)], true),          // Am F C G
        _ => (&[(48.0, false), (55.0, false), (57.0, true), (53.0, false)], true),               // C G Am F
    };
    let mut noise = Noise(0x9e3779b9);
    let mut lp = [0f32; 2];
    for (i, frame) in out.iter_mut().enumerate() {
        let t = i as f32 / RATE as f32;
        let bar_i = (t / bar) as usize;
        let (root, minor) = prog[bar_i % prog.len()];
        let in_bar = t % bar;
        // Pad: root, third, fifth, octave — soft saw-ish stacks, slow swell per chord.
        let third = if minor { 3.0 } else { 4.0 };
        let swell = (in_bar / 0.6).min(1.0) * (1.0 - ((in_bar - bar + 0.25).max(0.0) / 0.25) * 0.3);
        let mut pad = [0f32; 2];
        for (j, iv) in [0.0, third, 7.0, 12.0].iter().enumerate() {
            let f = midi_hz(root + 12.0 + iv);
            for (side, det) in [(0usize, 0.997f32), (1, 1.003)] {
                let ph = t * f * det;
                let v = (ph * std::f32::consts::TAU).sin() + 0.35 * (ph * 2.0 * std::f32::consts::TAU).sin() + 0.15 * (ph * 3.0 * std::f32::consts::TAU).sin();
                pad[side] += v * 0.045 * swell * if j == 3 { 0.6 } else { 1.0 };
            }
        }
        // Bass: root on every beat, plucked.
        let in_beat = t % beat;
        let bass = (t * midi_hz(root - 12.0) * std::f32::consts::TAU).sin() * (-in_beat * 5.0).exp() * 0.22;
        let mut drum = 0.0;
        if drums {
            // Kick on 1 and 3, a pitch-dropping sine.
            let beat_n = (t / beat) as usize % 4;
            if beat_n % 2 == 0 {
                let f = 50.0 + 90.0 * (-in_beat * 30.0).exp();
                drum += (in_beat * f * std::f32::consts::TAU).sin() * (-in_beat * 9.0).exp() * 0.5;
            }
            // Hats on the off-beats.
            let half = beat / 2.0;
            let in_half = t % half;
            if ((t / half) as usize) % 2 == 1 {
                drum += noise.next() * (-in_half * 60.0).exp() * 0.06;
            }
            // Clap on 2 and 4.
            if beat_n % 2 == 1 {
                drum += noise.next() * (-in_beat * 25.0).exp() * 0.12;
            }
        }
        for s in 0..2 {
            // One-pole low-pass keeps the pad warm and out of the voice's way.
            lp[s] += 0.12 * (pad[s] - lp[s]);
            frame[s] = lp[s] + bass + drum;
        }
    }
    // Fade in, and out over the last second and a half.
    let fade_in = (RATE as f64 * 1.0) as usize;
    let fade_out = (RATE as f64 * 1.5) as usize;
    for i in 0..n {
        let g = (i as f32 / fade_in as f32).min(1.0) * ((n - i) as f32 / fade_out as f32).min(1.0);
        out[i][0] *= g;
        out[i][1] *= g;
    }
    out
}

/// Effects at their moments. `riser` ends at its time; everything else starts there.
fn effects(seconds: f64, accents: &[(f64, String)]) -> Vec<[f32; 2]> {
    let n = (seconds * RATE as f64) as usize;
    let mut out = vec![[0f32; 2]; n];
    let mut noise = Noise(0x2545f491);
    let mut add = |at: f64, len: f64, f: &mut dyn FnMut(f32, f32) -> (f32, f32)| {
        let start = (at.max(0.0) * RATE as f64) as usize;
        let count = (len * RATE as f64) as usize;
        for k in 0..count {
            let i = start + k;
            if i >= n {
                break;
            }
            let t = k as f32 / RATE as f32;
            let (l, r) = f(t, len as f32);
            out[i][0] += l;
            out[i][1] += r;
        }
    };
    for (t, kind) in accents {
        match kind.as_str() {
            "whoosh" => {
                let mut lp = 0f32;
                let mut lp2 = 0f32;
                add(*t - 0.15, 0.55, &mut |x, len| {
                    let env = (std::f32::consts::PI * x / len).sin().powi(2);
                    let cut = 0.02 + 0.25 * (x / len);
                    lp += cut * (noise.next() - lp);
                    lp2 += 0.5 * cut * (lp - lp2);
                    let v = (lp - lp2) * env * 1.4;
                    let pan = x / len;
                    (v * (1.0 - pan * 0.6), v * (0.4 + pan * 0.6))
                });
            }
            "pop" => add(*t, 0.12, &mut |x, _| {
                let f = 600.0 + 900.0 * (x / 0.12);
                let v = (x * f * std::f32::consts::TAU).sin() * (-x * 40.0).exp() * 0.35;
                (v, v)
            }),
            "hit" => add(*t, 1.2, &mut |x, _| {
                let f = 45.0 + 60.0 * (-x * 12.0).exp();
                let boom = (x * f * std::f32::consts::TAU).sin() * (-x * 3.5).exp() * 0.6;
                let crack = noise.next() * (-x * 30.0).exp() * 0.25;
                (boom + crack, boom + crack)
            }),
            "riser" => add(*t - 1.4, 1.4, &mut |x, len| {
                let p = x / len;
                let f = 220.0 + 660.0 * p * p;
                let v = ((x * f * std::f32::consts::TAU).sin() * 0.08 + noise.next() * 0.06) * p * p;
                (v, v)
            }),
            "click" => add(*t, 0.03, &mut |x, _| {
                let v = noise.next() * (-x * 250.0).exp() * 0.3;
                (v, v)
            }),
            "shimmer" => add(*t, 1.0, &mut |x, _| {
                let mut v = 0.0;
                for (k, n) in [84.0f32, 88.0, 91.0, 96.0].iter().enumerate() {
                    let on = (x - k as f32 * 0.07).max(0.0);
                    v += (on * midi_hz(*n) * std::f32::consts::TAU).sin() * (-on * 4.0).exp() * if on > 0.0 { 0.05 } else { 0.0 };
                }
                (v, v * 0.8)
            }),
            _ => {}
        }
    }
    out
}

fn write_wav(path: &str, samples: &[[f32; 2]]) -> Result<(), String> {
    let mut data = Vec::with_capacity(44 + samples.len() * 4);
    let bytes = (samples.len() * 4) as u32;
    data.extend_from_slice(b"RIFF");
    data.extend_from_slice(&(36 + bytes).to_le_bytes());
    data.extend_from_slice(b"WAVEfmt ");
    data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes()); // PCM
    data.extend_from_slice(&2u16.to_le_bytes()); // stereo
    data.extend_from_slice(&RATE.to_le_bytes());
    data.extend_from_slice(&(RATE * 4).to_le_bytes());
    data.extend_from_slice(&4u16.to_le_bytes());
    data.extend_from_slice(&16u16.to_le_bytes());
    data.extend_from_slice(b"data");
    data.extend_from_slice(&bytes.to_le_bytes());
    for s in samples {
        for c in s {
            data.extend_from_slice(&((c.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
    }
    std::fs::write(path, data).map_err(|e| e.to_string())
}

fn ffmpeg() -> Option<String> {
    crate::video::ffmpeg_bin()
}

async fn run_ffmpeg(args: &[String]) -> Result<String, String> {
    let bin = ffmpeg().ok_or("Motion video needs ffmpeg: install it with `brew install ffmpeg`.")?;
    let out = tokio::process::Command::new(bin).args(args).output().await.map_err(|e| e.to_string())?;
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        return Err(format!("ffmpeg failed: {}", err.lines().rev().take(4).collect::<Vec<_>>().join(" / ")));
    }
    Ok(err)
}

/// Voice over ducked music plus effects, at streaming loudness. Returns the
/// measured integrated loudness.
///
/// Two passes: one-pass loudnorm guesses as it goes and lands a couple of LU
/// short on material this short; measuring first and then correcting linearly
/// hits the target and leaves the dynamics alone.
async fn mix(dir: &str, total: f64) -> Result<String, String> {
    let s = |x: &str| x.to_string();
    let inputs = || vec![
        s("-y"), s("-i"), voice_file(dir), s("-i"), format!("{dir}/music.wav"), s("-i"), format!("{dir}/sfx.wav"),
    ];
    let base = format!(
        "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay={ms}|{ms},apad[v];\
[v]asplit=2[v1][v2];\
[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.55[m];\
[m][v2]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=350[md];\
[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.9[fx];\
[v1][md][fx]amix=inputs=3:normalize=0:duration=longest,atrim=0:{total:.3}",
        ms = (LEAD * 1000.0) as u32
    );
    const TARGET: &str = "I=-14:TP=-1.5:LRA=11";
    let mut first = inputs();
    first.extend([s("-filter_complex"), format!("{base},loudnorm={TARGET}:print_format=json[out]"), s("-map"), s("[out]"), s("-f"), s("null"), s("-")]);
    let report = run_ffmpeg(&first).await?;
    let measured = report.rfind('{').and_then(|i| json_in(&report[i..]));
    let m = |k: &str| measured.as_ref().and_then(|v| v[k].as_str().map(String::from));
    let norm = match (m("input_i"), m("input_tp"), m("input_lra"), m("input_thresh"), m("target_offset")) {
        (Some(i), Some(tp), Some(lra), Some(th), Some(off)) => format!(
            "loudnorm={TARGET}:measured_I={i}:measured_TP={tp}:measured_LRA={lra}:measured_thresh={th}:offset={off}:linear=true"
        ),
        _ => format!("loudnorm={TARGET}"),
    };
    let mut second = inputs();
    second.extend([s("-filter_complex"), format!("{base},{norm}[out]"), s("-map"), s("[out]"), s("-ar"), s("48000"), s("-ac"), s("2"), format!("{dir}/mix.wav")]);
    run_ffmpeg(&second).await?;
    let report = run_ffmpeg(&[s("-i"), format!("{dir}/mix.wav"), s("-af"), s("ebur128"), s("-f"), s("null"), s("-")]).await?;
    let lufs = report
        .lines()
        .rev()
        .find_map(|l| l.trim().strip_prefix("I:").map(|v| v.trim().to_string()))
        .unwrap_or_else(|| "?".into());
    Ok(lufs)
}

// ---- 6. composition --------------------------------------------------------------

const COMPOSE_SYSTEM: &str = "You are a senior motion designer who animates in code. Write ONE complete HTML document that \
is a {w}×{h} px motion-graphics video of {dur:.2} seconds. It will be filmed frame by frame at 30 fps by seeking a GSAP \
timeline, then the voice-over and music are added — so the page itself is silent.\n\n\
THE CONTRACT (the renderer depends on it):\n\
1. <body> is exactly {w}×{h} px, margin 0, overflow hidden, with an explicit background.\n\
2. GSAP 3 core is already loaded as the global `gsap` (no plugins). Do not load any other script.\n\
3. Build exactly ONE timeline: `const tl = gsap.timeline({paused: true});` add every animation to it with absolute \
positions (tl.to(el, {...}, 1.68)), and end with `window.__timeline = tl;`. Its duration must reach {dur:.2} s — add \
`tl.set({}, {}, {dur:.2});` at the end. Never call tl.play().\n\
4. Nothing may move on its own: no setTimeout, setInterval, requestAnimationFrame, Date, video or audio elements. \
CSS @keyframes animations are fine (the renderer seeks them too). Math.random is fine only while building the page.\n\
5. Images: only the files listed, as <img src=\"assets/…\">. They are transparent PNGs; place and scale them by their \
listed size. Fonts: Google Fonts via <link> are allowed.\n\n\
WHAT MAKES IT GOOD:\n\
- It is motion graphics on every layer: kinetic typography, shapes, UI elements, diagrams, transitions — and the \
background moves the whole time (drifting gradients, particles, grids, shapes). Never a still slide with text on it.\n\
- The picture shows what the voice says at that moment. Place each reveal on the time of the word it belongs to \
(the word list below has each word's start time in seconds). Scene changes land on sentence starts.\n\
- Every scene has its own visual idea. Images are building blocks: animate them in, move, rotate, combine, \
parallax — never a slideshow, and never the same image in the same way twice.\n\
- On-screen words come only from the voice-over and the brief: never invent offers, prices, claims, \
\"free\", ratings or features.\n\
- On-screen text is short (2–6 words), big, bold, high contrast. Keep important content inside the central 80% \
(for 9:16, also clear of the top 12% and bottom 18%, where apps put their own interface).\n\
- Use the real assets (app icon, screenshots — show those inside a phone frame drawn in CSS — and the person's \
images) where the voice talks about the product. Never draw a fake version of the product. The person's logo is \
the brand: show it clearly, at least on the end card, never distorted or recoloured.\n\
- Use easing with character (power3.out, back.out(1.7), expo.inOut), overlap tweens, and stagger letters/words.\n\
- End with a held end card: product name / logo and the call to action, from the last sentence to the end.\n\n\
Reply with the HTML document only.";

fn compose_user(p: &Project, words: &[Word], plan: &Value, assets: &[Asset], dur: f64) -> String {
    format!(
        "Title: {}\nType: {}\nAudience: {}\nTone: {}\nBrand notes: {}\n\nLook (from the art director):\n{}\n\n\
Images available:\n{}\n\nSound accents already placed (make the picture hit on them too):\n{}\n\n\
Voice-over:\n{}\n\nWord start times (seconds):\n{}\n\nTotal duration: {:.2} s",
        p.title,
        if p.brief.kind == "explainer" { "explainer" } else { "ad" },
        p.brief.audience,
        p.brief.tone,
        p.brief.notes,
        serde_json::to_string_pretty(&plan["look"]).unwrap_or_default(),
        asset_lines(assets),
        plan["sfx"].as_array().map(|a| a.iter().map(|s| format!("{} at {}", s["kind"].as_str().unwrap_or(""), s["t"])).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
        p.script,
        word_lines(words),
        dur
    )
}

/// Put GSAP and the renderer's hooks into the page, ahead of its own scripts.
fn instrument(html: &str) -> String {
    let hooks = r#"<script>window.__errors=[];addEventListener('error',e=>__errors.push(String(e.message||e)));</script>
<script src="gsap.min.js"></script>"#;
    let lower = html.to_lowercase();
    match lower.find("<head>") {
        Some(i) => format!("{}{hooks}{}", &html[..i + 6], &html[i + 6..]),
        None => format!("{hooks}{html}"),
    }
}

const SEEK: &str = r#"window.__seek = (t) => {
  const tl = window.__timeline;
  tl.seek(t, false);
  // Strays: tweens made outside the timeline would otherwise run on the clock.
  for (const c of gsap.globalTimeline.getChildren(false, true, true)) {
    if (c !== tl) { c.paused(true); c.totalTime(Math.min(t, c.totalDuration())); }
  }
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }
  return new Promise(r => requestAnimationFrame(() => r(true)));
};
gsap.ticker.sleep && gsap.ticker.sleep();
true"#;

/// Load the composition in the render browser and report what is wrong with
/// it, if anything — the text model gets to fix its own mistakes.
async fn check(tab: &mut crate::browser::Tab, file: &str, dur: f64) -> Result<(), String> {
    tab.open_file(file).await?;
    let _ = tab.js("document.fonts.ready.then(() => Promise.all([...document.images].map(i => i.decode().catch(() => 0)))).then(() => true)").await;
    let errors = tab.js("JSON.stringify(window.__errors || [])").await.unwrap_or(json!("[]"));
    let errors = errors.as_str().unwrap_or("[]").to_string();
    if errors != "[]" {
        return Err(format!("The page threw errors: {errors}"));
    }
    let has = tab.js("typeof gsap !== 'undefined' && !!window.__timeline && typeof window.__timeline.seek === 'function'").await?;
    if has != json!(true) {
        return Err("window.__timeline is missing — the page must end with `window.__timeline = tl;`.".into());
    }
    let d = tab.js("window.__timeline.duration()").await?.as_f64().unwrap_or(0.0);
    if d + 0.05 < dur {
        return Err(format!("The timeline is {d:.2} s long but must reach {dur:.2} s — add `tl.set({{}}, {{}}, {dur:.2});`."));
    }
    let missing = tab.js("JSON.stringify([...document.images].filter(i => !i.naturalWidth).map(i => i.getAttribute('src')))").await?;
    if missing.as_str().map_or(false, |m| m != "[]") {
        return Err(format!("These images did not load (use only the listed files): {}", missing.as_str().unwrap_or("")));
    }
    Ok(())
}

// ---- 7. render --------------------------------------------------------------------------

async fn render<R: Runtime>(job: &Job<R>, tab: &mut crate::browser::Tab, w: u32, h: u32, dur: f64, out: &str) -> Result<String, String> {
    tab.cdp("Emulation.setDeviceMetricsOverride", json!({ "width": w, "height": h, "deviceScaleFactor": 1, "mobile": false })).await?;
    check(tab, &job.path("index.html"), dur).await?;
    tab.js(SEEK).await?;
    let bin = ffmpeg().ok_or("Motion video needs ffmpeg: install it with `brew install ffmpeg`.")?;
    let mut child = tokio::process::Command::new(bin)
        .args(["-y", "-f", "image2pipe", "-framerate", &FPS.to_string(), "-c:v", "mjpeg", "-i", "-"])
        .args(["-i", &job.path("mix.wav")])
        .args(["-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"])
        .args(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", out])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start ffmpeg: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("ffmpeg has no input")?;
    let frames = (dur * FPS as f64).ceil() as u32;
    // Frozen stretches: a run of identical frames is a scene that stopped moving.
    let (mut last_hash, mut run, mut longest, mut longest_at) = (0u64, 0u32, 0u32, 0u32);
    let started = std::time::Instant::now();
    for f in 0..frames {
        if job.motion.stopped(&job.id) {
            return Err("stopped".into());
        }
        let t = f as f64 / FPS as f64;
        tab.js(&format!("window.__seek({t:.5})")).await.map_err(|e| format!("frame {f}: {e}"))?;
        let shot = tab.cdp("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 92, "optimizeForSpeed": true })).await?;
        let jpeg = base64::engine::general_purpose::STANDARD.decode(shot["data"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
        let hash = {
            use std::hash::{Hash, Hasher};
            let mut hs = std::collections::hash_map::DefaultHasher::new();
            jpeg.hash(&mut hs);
            hs.finish()
        };
        if hash == last_hash {
            run += 1;
            if run > longest {
                longest = run;
                longest_at = f - run;
            }
        } else {
            run = 0;
        }
        last_hash = hash;
        stdin.write_all(&jpeg).await.map_err(|e| format!("ffmpeg stopped taking frames: {e}"))?;
        if f % 30 == 0 {
            let done = f as f64 / frames as f64;
            let title = format!("Rendering · {:.0}% ({}/{} frames)", done * 100.0, f, frames);
            job.motion.update(&job.app, &job.id, |p| {
                if let Some(s) = p.steps.last_mut().filter(|s| s.ok.is_none()) {
                    s.title = title;
                }
            });
        }
    }
    drop(stdin);
    job.motion.update(&job.app, &job.id, |p| {
        if let Some(s) = p.steps.last_mut().filter(|s| s.ok.is_none()) {
            s.title = "Rendering".into();
        }
    });
    let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg failed: {}", err.lines().rev().take(3).collect::<Vec<_>>().join(" / ")));
    }
    let mut note = format!("{frames} frames in {:.0} s", started.elapsed().as_secs_f64());
    let still = longest as f64 / FPS as f64;
    if still >= 1.5 {
        note.push_str(&format!(" · note: the picture stands still for {still:.1} s from {:.1} s", longest_at as f64 / FPS as f64));
    }
    Ok(note)
}

// ---- the job ------------------------------------------------------------------------------

/// Where a run starts. Everything before it is reused from the last run, so a
/// note like "make the logo bigger" costs one animation pass, not a new voice
/// and new images.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum From {
    /// Everything: a new script or a new voice.
    Voice,
    /// Same voice; a new look, new images, new sound.
    Images,
    /// Same voice, images and sound; the animation is revised.
    Animation,
}

async fn make<R: Runtime>(job: &Job<R>, from: From, feedback: &str) -> Result<String, String> {
    let p = job.project();
    let from = if from != From::Voice && !std::path::Path::new(&job.path("words.json")).exists() { From::Voice } else { from };
    let from = if from == From::Animation && !std::path::Path::new(&job.path("plan.json")).exists() { From::Images } else { from };
    let note = if feedback.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nWhat the person asked for after the previous version — this matters most:\n{}", feedback.trim())
    };
    let s = settings(&job.app);
    let or_key = key(&s, "openrouterKey");
    if or_key.is_empty() {
        return Err("Images (and the voice, unless it's ElevenLabs on your own key) come through OpenRouter — add an OpenRouter key in Settings.".into());
    }
    if ffmpeg().is_none() {
        return Err("Motion video needs ffmpeg: install it with `brew install ffmpeg`.".into());
    }
    let (w, h) = stage_size(&p.brief.format);

    // 3. Voice.
    let via = if p.voice_source == "elevenlabs" {
        "ElevenLabs".to_string()
    } else {
        p.speech_model.split('/').last().unwrap_or(&p.speech_model).to_string()
    };
    let (words, spoken) = if from == From::Voice {
        let (words, spoken, voice_cost) = job
            .step(&format!("Recording the voice · {} · {via}", p.voice_name), async {
                let r = voice(job, &p).await?;
                let mut detail = format!("{:.1} s spoken, {} words timed", r.1, r.0.len());
                if r.2 > 0.0 {
                    detail.push_str(&format!(" · ${:.3}", r.2));
                }
                Ok((r, Some(detail)))
            })
            .await?;
        job.motion.update(&job.app, &job.id, |p| {
            if p.voice_source == "elevenlabs" {
                p.voice_chars += p.script.chars().count();
            }
            p.cost += voice_cost;
        });
        (words, spoken)
    } else {
        let words: Vec<Word> = serde_json::from_str(&std::fs::read_to_string(job.path("words.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let spoken = probe_seconds(&voice_file(&job.dir)).await.unwrap_or_else(|| words.last().map_or(0.0, |w| w.e - LEAD));
        (words, spoken)
    };
    let dur = LEAD + spoken + TAIL;

    // 4. Look, images, accents.
    let plan = if from == From::Animation {
        serde_json::from_str::<Value>(&std::fs::read_to_string(job.path("plan.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?
    } else {
        // New images replace the last run's; the real ones stay.
        for a in p.assets.iter().filter(|a| a.kind == "ai") {
            let _ = std::fs::remove_file(job.path(&format!("assets/{}", a.file)));
        }
        job.motion.update(&job.app, &job.id, |p| p.assets.retain(|a| a.kind != "ai"));
        let p = job.project();
        job.step("Planning the look, images and sound", async {
            let system = PLAN_SYSTEM.replace("{max}", &MAX_IMAGES.to_string());
            let user = format!(
                "Title: {}\nType: {}\nAudience: {}\nTone: {}\nBrand notes: {}\nFormat: {}×{}\n\nReal assets already available:\n{}\n\n\
Voice-over:\n{}\n\nWord start times (seconds):\n{}\n\nTotal: {:.2} s{note}",
                p.title, p.brief.kind, p.brief.audience, p.brief.tone, p.brief.notes, w, h,
                asset_lines(&p.assets), p.script, word_lines(&words), dur
            );
            let reply = ask(&job.app, &p.base_url, &p.text_model, &system, json!(user), 0.6).await?;
            let plan = json_in(&reply).ok_or("The art direction wasn't readable.")?;
            let detail = format!(
                "{} · {} images · {} accents",
                plan["look"]["style"].as_str().unwrap_or("").chars().take(160).collect::<String>(),
                plan["images"].as_array().map_or(0, |a| a.len().min(MAX_IMAGES)),
                plan["sfx"].as_array().map_or(0, |a| a.len())
            );
            Ok((plan, Some(detail)))
        })
        .await?
    };
    if from != From::Animation {
        let _ = std::fs::write(job.path("plan.json"), serde_json::to_string_pretty(&plan).unwrap_or_default());
    }

    let wanted: Vec<Value> = plan["images"].as_array().cloned().unwrap_or_default().into_iter().take(MAX_IMAGES).collect();
    if from != From::Animation && !wanted.is_empty() {
        let style = plan["look"]["imageStyle"].as_str().unwrap_or("").to_string();
        let model = p.image_model.clone();
        let made = job
            .step(&format!("Making {} images · {}", wanted.len(), model.rsplit('/').next().unwrap_or(&model)), async {
                let tasks = wanted.iter().enumerate().map(|(i, img)| {
                    let file = img["file"].as_str().map(png_name).filter(|f| !f.is_empty()).unwrap_or_else(|| format!("image-{}.png", i + 1));
                    let prompt = format!(
                        "{}. Style: {}. A single isolated subject, fully visible with a margin around it, on a fully transparent \
background. No text, no lettering, no frame, no ground shadow, no background scene.",
                        img["prompt"].as_str().unwrap_or(""),
                        style
                    );
                    let (key, model, use_) = (or_key.clone(), model.clone(), img["use"].as_str().unwrap_or("").to_string());
                    async move {
                        let (bytes, cost) = make_image(&key, &model, &prompt, &[]).await?;
                        Ok::<_, String>((file, bytes, cost, use_))
                    }
                });
                let results = futures_util::future::join_all(tasks).await;
                let (mut assets, mut cost, mut failed) = (vec![], 0.0, vec![]);
                for r in results {
                    match r {
                        Ok((file, bytes, c, use_)) => {
                            cost += c;
                            let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?.to_rgba8();
                            let img = trim_alpha(img);
                            let mut png = std::io::Cursor::new(Vec::new());
                            image::DynamicImage::ImageRgba8(img).write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
                            assets.push(store_image(&job.dir, &file, png.get_ref(), "ai", &format!("AI image: {use_}"), 1024)?);
                        }
                        Err(e) => failed.push(e),
                    }
                }
                if assets.is_empty() && !failed.is_empty() {
                    return Err(failed.join("; "));
                }
                let detail = format!(
                    "{} made{} · ${cost:.2}",
                    assets.len(),
                    if failed.is_empty() { String::new() } else { format!(", {} failed ({})", failed.len(), failed[0]) }
                );
                Ok(((assets, cost), Some(detail)))
            })
            .await?;
        job.motion.update(&job.app, &job.id, |p| {
            p.assets.extend(made.0.clone());
            p.cost += made.1;
        });
    }
    let p = job.project();

    // 5. Sound.
    let accents: Vec<(f64, String)> = plan["sfx"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|a| Some((a["t"].as_f64()?, a["kind"].as_str()?.to_string())))
        .filter(|(t, _)| *t >= 0.0 && *t < dur)
        .collect();
    let mood = plan["music"]["mood"].as_str().unwrap_or("upbeat").to_string();
    let bpm = plan["music"]["bpm"].as_f64().unwrap_or(104.0) as f32;
    if from != From::Animation || !std::path::Path::new(&job.path("mix.wav")).exists() {
    job.step("Composing music and effects, mixing to −14 LUFS", async {
        let dir = job.dir.clone();
        let (accents2, mood2) = (accents.clone(), mood.clone());
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            write_wav(&format!("{dir}/music.wav"), &music(dur, &mood2, bpm))?;
            write_wav(&format!("{dir}/sfx.wav"), &effects(dur, &accents2))
        })
        .await
        .map_err(|e| e.to_string())??;
        let lufs = mix(&job.dir, dur).await?;
        Ok(((), Some(format!("{mood} at {bpm:.0} bpm · {} accents · {lufs}", accents.len()))))
    })
    .await?;
    }

    // 6 + 7. Composition, checked in the render browser and fixed by the model
    // until it loads cleanly, then filmed.
    let host = crate::browser::BrowserHost::headless(crate::app_path("render-browser"));
    let mut tab = crate::browser::Tab::open(&host).await?;
    let result = async {
        tab.cdp("Emulation.setDeviceMetricsOverride", json!({ "width": w, "height": h, "deviceScaleFactor": 1, "mobile": false })).await?;
        std::fs::write(job.path("gsap.min.js"), GSAP).map_err(|e| e.to_string())?;
        let system = COMPOSE_SYSTEM.replace("{w}", &w.to_string()).replace("{h}", &h.to_string()).replace("{dur:.2}", &format!("{dur:.2}"));
        let previous = std::fs::read_to_string(job.path("index.html")).ok().filter(|_| from == From::Animation);
        let user = match &previous {
            // A revision: the last document, changed where the person asked.
            Some(prev) => format!(
                "{}{note}\n\nThis is a revision. Below is the previous document, which already works. Change what the person \
asked for and keep everything else as it is. Return the complete revised document.\n\n{}",
                compose_user(&p, &words, &plan, &p.assets, dur),
                prev
            ),
            None => format!("{}{note}", compose_user(&p, &words, &plan, &p.assets, dur)),
        };
        let title = if previous.is_some() { "Revising the animation" } else { "Writing the animation" };
        job.step(title, async {
            let mut messages_user = json!(user.clone());
            let mut last_err = String::new();
            for attempt in 0..3 {
                let reply = ask(&job.app, &p.base_url, &p.text_model, &system, messages_user.clone(), 0.5).await?;
                let html = html_in(&reply).ok_or("The animation came back without an HTML document.")?;
                std::fs::write(job.path("index.html"), instrument(&html)).map_err(|e| e.to_string())?;
                match check(&mut tab, &job.path("index.html"), dur).await {
                    Ok(()) => {
                        let kb = html.len() / 1024;
                        return Ok(((), Some(format!("{kb} KB of HTML/CSS/GSAP{}", if attempt > 0 { format!(", fixed after {attempt} check(s)") } else { String::new() }))));
                    }
                    Err(e) => {
                        last_err = e.clone();
                        messages_user = json!(format!(
                            "{user}\n\nYour previous document failed the renderer's check:\n{e}\n\nHere it is — return the corrected complete document.\n\n{html}"
                        ));
                    }
                }
            }
            Err(format!("The animation still fails after three tries: {last_err}"))
        })
        .await?;
        let out = job.path("video.mp4");
        job.step("Rendering", async { render(job, &mut tab, w, h, dur, &out).await.map(|n| ((), Some(n))) }).await
    }
    .await;
    // The render browser is ours alone; close it rather than leave it running.
    if let Ok(c) = host.connection().await {
        let _ = c.call(None, "Browser.close", json!({})).await;
    }
    result?;

    // File it in the library — every run a version of its own, so an earlier
    // cut is still there when a change turns out worse.
    job.motion.update(&job.app, &job.id, |p| p.versions += 1);
    let p = job.project();
    let video_id = uuid::Uuid::new_v4().to_string();
    let bytes = std::fs::metadata(job.path("video.mp4")).map(|m| m.len()).unwrap_or(0);
    crate::video::store_file(&video_id, &job.path("video.mp4"))?;
    let name = if p.versions > 1 { format!("{} (v{})", p.title, p.versions) } else { p.title.clone() };
    let record = json!({
        "id": video_id, "jobId": format!("motion:{}", p.id), "prompt": name, "model": "motion",
        "modelName": "Motion graphics", "status": "completed", "at": now_ms(), "duration": dur.round() as u64,
        "resolution": format!("{w}×{h}"), "aspect": p.brief.format, "audio": true, "bytes": bytes, "cost": p.cost,
    });
    crate::video::video_put(video_id.clone(), record.to_string())?;
    job.motion.update(&job.app, &job.id, |p| p.video_id = Some(video_id.clone()));
    Ok(video_id)
}

/// What the chat decided: the script, the voice, the shape of the video.
#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct Spec {
    pub title: String,
    pub script: String,
    /// "ad" | "explainer"
    pub kind: String,
    /// "9:16" | "16:9" | "1:1"
    pub format: String,
    pub language: String,
    pub audience: String,
    pub tone: String,
    /// Brand colours, fonts, style direction, things to avoid.
    pub notes: String,
    /// "openrouter" | "elevenlabs"
    pub voice_source: String,
    /// The OpenRouter speech model (voice_source "openrouter").
    pub speech_model: String,
    /// The voice: a name on the speech model, or an ElevenLabs voice id.
    pub voice: String,
    pub voice_name: String,
}

/// Apply what changed. Empty fields keep what the project has.
pub fn apply<R: Runtime>(app: &AppHandle<R>, id: &str, spec: &Spec) {
    let keep = |new: &str, old: &str| if new.trim().is_empty() { old.to_string() } else { new.trim().to_string() };
    app.state::<Motion>().update(app, id, |p| {
        p.title = keep(&spec.title, &p.title);
        p.script = keep(&spec.script, &p.script);
        p.brief.kind = keep(&spec.kind, &p.brief.kind);
        p.brief.format = match spec.format.trim() {
            f @ ("9:16" | "16:9" | "1:1") => f.to_string(),
            _ => p.brief.format.clone(),
        };
        p.brief.language = keep(&spec.language, &p.brief.language);
        p.brief.audience = keep(&spec.audience, &p.brief.audience);
        p.brief.tone = keep(&spec.tone, &p.brief.tone);
        p.brief.notes = keep(&spec.notes, &p.brief.notes);
        if !spec.voice.trim().is_empty() {
            p.voice_source = if spec.voice_source == "elevenlabs" { "elevenlabs".into() } else { "openrouter".into() };
            p.speech_model = spec.speech_model.trim().to_string();
            p.voice_id = spec.voice.trim().to_string();
            p.voice_name = keep(&spec.voice_name, &spec.voice);
        }
    });
}

/// Make (or remake) the video, from `from`, and wait for it. `progress` hears
/// the step being worked on; `cancelled` is asked between frames and steps.
/// Returns the library id of the new video and a summary for the agent.
pub async fn run<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    from: From,
    feedback: &str,
    mut progress: impl FnMut(&str),
    cancelled: impl Fn() -> bool,
) -> Result<(String, String), String> {
    let motion = app.state::<Motion>().inner().clone();
    let p = motion.get(id).ok_or("no such video project")?;
    if p.status == "running" {
        return Err("This video is already being made.".into());
    }
    if p.script.trim().is_empty() {
        return Err("There is no script yet.".into());
    }
    if p.voice_id.trim().is_empty() || (p.voice_source != "elevenlabs" && p.speech_model.trim().is_empty()) {
        return Err("No voice chosen yet.".into());
    }
    // The image model: the person's choice, else the newest that can cut out.
    let image_model = match (p.image_model.trim(), key(&settings(app), "motionImageModel")) {
        (m, _) if !m.is_empty() => m.to_string(),
        (_, m) if !m.is_empty() => m,
        _ => motion_image_models(app.clone())
            .await?
            .first()
            .and_then(|m| m["id"].as_str().map(String::from))
            .ok_or("OpenRouter lists no image model that can make transparent images.")?,
    };
    let cost_before = p.cost;
    motion.update(app, id, |p| {
        p.status = "running".into();
        p.image_model = image_model;
        p.steps.clear();
        p.error = None;
    });
    let flag = Arc::new(AtomicBool::new(false));
    motion.0.stops.lock().unwrap().insert(id.to_string(), flag.clone());
    let job = Job { app: app.clone(), motion: motion.clone(), id: id.to_string(), dir: dir_of(id) };
    let feedback = feedback.to_string();
    let work = tauri::async_runtime::spawn(async move {
        let r = make(&job, from, &feedback).await;
        (job, r)
    });
    tokio::pin!(work);
    let (job, outcome) = loop {
        tokio::select! {
            done = &mut work => break done.map_err(|e| e.to_string())?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(700)) => {
                if cancelled() {
                    flag.store(true, Ordering::Relaxed);
                }
                if let Some(s) = motion.get(id).and_then(|p| p.steps.into_iter().rev().find(|s| s.ok.is_none())) {
                    progress(&s.title);
                }
            }
        }
    };
    motion.0.stops.lock().unwrap().remove(id);
    motion.update(app, id, |p| match &outcome {
        Ok(_) => p.status = "done".into(),
        Err(e) if e == "stopped" => p.status = "stopped".into(),
        Err(e) => {
            p.status = "failed".into();
            p.error = Some(e.clone());
        }
    });
    let video_id = outcome?;
    let p = job.project();
    let steps: Vec<String> = p
        .steps
        .iter()
        .map(|s| format!("- {}{}", s.title, s.detail.as_ref().map(|d| format!(": {d}")).unwrap_or_default()))
        .collect();
    let summary = format!(
        "Video ready (version {}). It is shown to the person in the chat and saved in their library.\nCost of this run: ${:.3} on OpenRouter{}.\nWhat was done:\n{}",
        p.versions,
        p.cost - cost_before,
        if p.voice_source == "elevenlabs" && from == From::Voice { format!(" + {} ElevenLabs characters", p.script.chars().count()) } else { String::new() },
        steps.join("\n")
    );
    Ok((video_id, summary))
}

/// The voices on offer, as text for the agent: OpenRouter's speech models with
/// their voices, and the person's ElevenLabs voices when they have a key.
pub async fn voice_catalog<R: Runtime>(app: &AppHandle<R>) -> String {
    let mut out = String::new();
    match motion_speech_models(app.clone()).await {
        Ok(models) => {
            out.push_str("OpenRouter speech models (voice_source \"openrouter\"; voice = one of the names listed):\n");
            for m in models.iter().take(14) {
                let voices: Vec<&str> = m["voices"].as_array().map(|v| v.iter().filter_map(|x| x.as_str()).take(40).collect()).unwrap_or_default();
                out.push_str(&format!("- {} ({}): {}\n", m["id"].as_str().unwrap_or(""), m["name"].as_str().unwrap_or(""), voices.join(", ")));
            }
            out.push_str("Good defaults: elevenlabs/eleven-v4 (most natural; voices are ElevenLabs' stock voices), google/gemini-3.8-flash-tts (cheapest, many languages).\n");
        }
        Err(e) => out.push_str(&format!("(OpenRouter speech models unavailable: {e})\n")),
    }
    match motion_voices(app.clone()).await {
        Ok(voices) => {
            out.push_str("\nThe person's own ElevenLabs account (voice_source \"elevenlabs\"; voice = the id):\n");
            for v in voices.iter().take(40) {
                out.push_str(&format!("- {} — id {} — {}\n", v["name"].as_str().unwrap_or(""), v["id"].as_str().unwrap_or(""), v["tags"].as_str().unwrap_or("")));
            }
        }
        Err(_) => out.push_str("\n(No ElevenLabs key in Settings, so only the OpenRouter voices are available.)\n"),
    }
    out
}

/// A short sample of a voice, saved in the project for the chat to play.
/// Returns the file name under samples/.
pub async fn sample<R: Runtime>(app: &AppHandle<R>, id: &str, source: &str, model: &str, voice: &str, text: &str) -> Result<String, String> {
    let dir = format!("{}/samples", dir_of(id));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text: String = if text.trim().is_empty() { "Here is how this voice sounds.".into() } else { text.chars().take(200).collect() };
    let (bytes, ext) = if source == "elevenlabs" {
        let k = key(&settings(app), "elevenlabsKey");
        let resp = reqwest::Client::new()
            .post(format!("{ELEVEN}/v1/text-to-speech/{voice}?output_format=mp3_44100_128"))
            .header("xi-api-key", &k)
            .json(&json!({ "text": text, "model_id": "eleven_v4" }))
            .send()
            .await
            .map_err(|e| format!("ElevenLabs: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(eleven_error(status, &resp.text().await.unwrap_or_default()));
        }
        (resp.bytes().await.map_err(|e| e.to_string())?.to_vec(), "mp3")
    } else {
        let (b, ext, _) = or_speech(&key(&settings(app), "openrouterKey"), model, voice, &text).await?;
        (b, ext)
    };
    let file = format!("{}.{ext}", uuid::Uuid::new_v4());
    std::fs::write(format!("{dir}/{file}"), bytes).map_err(|e| e.to_string())?;
    Ok(file)
}

/// A voice sample, as a data URL the chat can play.
#[tauri::command]
pub fn motion_audio(id: String, file: String) -> Result<String, String> {
    let file = file.rsplit('/').next().unwrap_or("").to_string();
    if file.is_empty() || file.starts_with('.') {
        return Err("bad file".into());
    }
    let bytes = std::fs::read(format!("{}/samples/{file}", dir_of(&id))).map_err(|_| "that sample is gone".to_string())?;
    let mime = if file.ends_with(".wav") { "audio/wav" } else { "audio/mpeg" };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Remove a project with its chat.
pub fn delete<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let m = app.state::<Motion>();
    if let Some(f) = m.0.stops.lock().unwrap().get(id) {
        f.store(true, Ordering::Relaxed);
    }
    m.ensure_loaded();
    m.0.projects.lock().unwrap().remove(id);
    let _ = std::fs::remove_dir_all(dir_of(id));
}

// ---- the Video tab -------------------------------------------------------------
// The tab is a form: what the video is about, the models, the voice, format and
// length, and the person's own images. "Write script" fills in a script to edit;
// "Make video" makes it, redoing only what changed since the last one; "Change
// something" revises the last video, by default with one animation pass.

const SCRIPT_SYSTEM: &str = "You write voice-over scripts for short motion-graphics videos.\n\
Rules:\n\
- Written to be SPOKEN: complete, natural sentences with rhythm. No staccato fragments, no lists, no hashtags.\n\
- Plain text only. No stage directions, no [brackets], no emojis, no speaker names — everything you write is read aloud.\n\
- Length: about {words} words for {seconds} seconds. Never more.\n\
- An explainer opens with the question of what this is about, then answers it simply.\n\
- An ad wins attention in the first two seconds, shows the benefit to the viewer rather than listing features, and ends with one clear call to action.\n\
- Use only facts from the brief and research. Never invent prices, numbers, awards, offers or features.\n\
- Write in {language}.\n\
Reply with JSON only: {\"title\": \"short working title\", \"script\": \"the voice-over\"}";

fn words_for(seconds: u32, language: &str) -> u32 {
    // Spoken pace: English ~2.5 words/s; German and others run a little slower.
    let rate = if language.to_lowercase().starts_with("en") { 2.5 } else { 2.2 };
    ((seconds as f64) * rate * 0.92) as u32
}

/// What the form holds. Empty fields leave the project as it is.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Form {
    /// What the video is about, in the person's words; links in it are looked up.
    pub brief: String,
    /// "ad" | "explainer"
    pub kind: String,
    pub format: String,
    pub seconds: u32,
    pub language: String,
    pub title: String,
    pub script: String,
    pub voice_source: String,
    pub speech_model: String,
    pub voice: String,
    pub voice_name: String,
    pub image_model: String,
    pub base_url: String,
    pub model: String,
}

fn take_form<R: Runtime>(app: &AppHandle<R>, id: &str, f: &Form) {
    let keep = |new: &str, old: &str| if new.trim().is_empty() { old.to_string() } else { new.trim().to_string() };
    app.state::<Motion>().update(app, id, |p| {
        p.brief.product = keep(&f.brief, &p.brief.product);
        p.brief.kind = keep(&f.kind, &p.brief.kind);
        if matches!(f.format.as_str(), "9:16" | "16:9" | "1:1") {
            p.brief.format = f.format.clone();
        }
        if f.seconds > 0 {
            p.brief.seconds = f.seconds.clamp(10, 120);
        }
        p.brief.language = keep(&f.language, &p.brief.language);
        p.title = keep(&f.title, &p.title);
        p.script = keep(&f.script, &p.script);
        if !f.voice.trim().is_empty() {
            p.voice_source = if f.voice_source == "elevenlabs" { "elevenlabs".into() } else { "openrouter".into() };
            p.speech_model = f.speech_model.trim().to_string();
            p.voice_id = f.voice.trim().to_string();
            p.voice_name = keep(&f.voice_name, &f.voice);
        }
        p.image_model = keep(&f.image_model, &p.image_model);
        if !f.model.trim().is_empty() {
            p.text_model = f.model.trim().to_string();
            p.base_url = f.base_url.trim().to_string();
        }
    });
}

/// Links in the brief: an App Store link (or app id) and a website.
fn links_in(brief: &str) -> (String, String) {
    let mut app_store = String::new();
    let mut website = String::new();
    for w in brief.split_whitespace() {
        let w = w.trim_matches(|c: char| matches!(c, '(' | ')' | ',' | '.' | '<' | '>' | '"' | '\''));
        if w.contains("apps.apple.com") || w.contains("itunes.apple.com") {
            app_store = w.to_string();
        } else if (w.starts_with("http://") || w.starts_with("https://")) && website.is_empty() {
            website = w.to_string();
        }
    }
    (app_store, website)
}

fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    let Some(n) = app.try_state::<tauri_plugin_notification::Notification<R>>() else { return };
    let body: String = body.chars().take(180).collect();
    let _ = n.builder().title(title).body(body).show();
}

/// Make or revise in the background; the tab follows along with motion_get.
fn start<R: Runtime>(app: &AppHandle<R>, id: &str, from: From, feedback: String) -> Result<(), String> {
    let motion = app.state::<Motion>().inner().clone();
    let p = motion.get(id).ok_or("no such video project")?;
    if p.status == "running" {
        return Err("This video is already being made.".into());
    }
    let (app, id) = (app.clone(), id.to_string());
    tauri::async_runtime::spawn(async move {
        let made = {
            let p = motion.get(&id);
            p.map(|p| json!({ "script": p.script, "voice": format!("{}|{}|{}", p.voice_source, p.speech_model, p.voice_id), "format": p.brief.format }))
        };
        match run(&app, &id, from, &feedback, |_| {}, || false).await {
            Ok(_) => {
                let p = motion.get(&id);
                motion.update(&app, &id, |p| {
                    if let Some(mut m) = made {
                        m["imageModel"] = json!(p.image_model);
                        p.made = m;
                    }
                });
                notify(&app, "Video ready", &p.map(|p| p.title).unwrap_or_default());
            }
            Err(e) if e == "stopped" => {}
            Err(e) => {
                // A refusal before the run began (no voice, no script) still
                // has to reach the tab.
                motion.update(&app, &id, |p| {
                    if p.status != "failed" {
                        p.status = "failed".into();
                        p.error = Some(e.clone());
                    }
                });
                notify(&app, "Video failed", &e);
            }
        }
    });
    Ok(())
}

/// What the form offers: image models that can cut out, OpenRouter speech
/// models with their voices, and the person's ElevenLabs voices.
#[tauri::command]
pub async fn motion_options<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    let (images, speech, eleven) =
        tokio::join!(motion_image_models(app.clone()), motion_speech_models(app.clone()), motion_voices(app.clone()));
    let error = images.as_ref().err().or(speech.as_ref().err()).cloned();
    Ok(json!({
        "imageModels": images.unwrap_or_default(),
        "speechModels": speech.unwrap_or_default(),
        "elevenVoices": eleven.as_ref().ok(),
        "elevenError": eleven.err(),
        "error": error,
    }))
}

/// Projects, newest first, for the sidebar. Empty ones are left out.
#[tauri::command]
pub fn motion_list<R: Runtime>(app: AppHandle<R>) -> Vec<Value> {
    let m = app.state::<Motion>();
    m.ensure_loaded();
    let map = m.0.projects.lock().unwrap();
    let mut out: Vec<&Project> = map
        .values()
        .filter(|p| !p.script.trim().is_empty() || p.versions > 0 || p.assets.iter().any(|a| a.kind == "user"))
        .collect();
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    out.iter()
        .map(|p| json!({ "id": p.id, "title": p.title, "status": p.status, "updated": p.updated, "versions": p.versions, "videoId": p.video_id }))
        .collect()
}

#[tauri::command]
pub fn motion_new<R: Runtime>(app: AppHandle<R>, base_url: String, model: String) -> Project {
    let mut p = create(&app, &base_url, &model);
    app.state::<Motion>().update(&app, &p.id, |q| {
        q.brief.seconds = 30;
        q.status = "draft".into();
    });
    p.brief.seconds = 30;
    p
}

/// Keep what the form holds without doing anything with it.
#[tauri::command]
pub fn motion_save<R: Runtime>(app: AppHandle<R>, id: String, form: Form) -> Result<Project, String> {
    take_form(&app, &id, &form);
    app.state::<Motion>().get(&id).ok_or("no such video project".into())
}

#[tauri::command]
pub fn motion_add_asset<R: Runtime>(app: AppHandle<R>, id: String, attachment: String, name: String) -> Result<Project, String> {
    add_image(&app, &id, &attachment, &name)?;
    app.state::<Motion>().get(&id).ok_or("no such video project".into())
}

#[tauri::command]
pub fn motion_remove_asset<R: Runtime>(app: AppHandle<R>, id: String, file: String) -> Result<Project, String> {
    let file = file.rsplit('/').next().unwrap_or("").to_string();
    let motion = app.state::<Motion>().inner().clone();
    motion.update(&app, &id, |p| p.assets.retain(|a| a.file != file));
    let _ = std::fs::remove_file(format!("{}/assets/{file}", dir_of(&id)));
    motion.get(&id).ok_or("no such video project".into())
}

/// One of the project's images, as a data URL for its thumbnail.
#[tauri::command]
pub fn motion_asset(id: String, file: String) -> Result<String, String> {
    let file = file.rsplit('/').next().unwrap_or("").to_string();
    if file.is_empty() || file.starts_with('.') {
        return Err("bad file".into());
    }
    let bytes = std::fs::read(format!("{}/assets/{file}", dir_of(&id))).map_err(|_| "that image is gone".to_string())?;
    let mime = if file.ends_with(".png") { "image/png" } else { "image/jpeg" };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Look up links in the brief and write a script to edit. Nothing paid but
/// the text model has run when this returns.
#[tauri::command]
pub async fn motion_script<R: Runtime>(app: AppHandle<R>, id: String, form: Form) -> Result<Project, String> {
    if form.brief.trim().is_empty() {
        return Err("Say what the video is about first.".into());
    }
    take_form(&app, &id, &form);
    let motion = app.state::<Motion>().inner().clone();
    let p = motion.get(&id).ok_or("no such video project")?;
    let (app_store_link, website) = links_in(&p.brief.product);
    // Each link is looked up once; the result stays with the project.
    let new_store = if app_store_link != p.brief.app_store { app_store_link.clone() } else { String::new() };
    let new_site = if website != p.brief.website { website.clone() } else { String::new() };
    if !new_store.is_empty() || !new_site.is_empty() {
        motion.update(&app, &id, |p| {
            p.brief.app_store = app_store_link.clone();
            p.brief.website = website.clone();
        });
        if let Err(e) = research(&app, &id, &new_store, &new_site).await {
            motion.update(&app, &id, |p| p.research = format!("{}\n(Lookup failed: {e})", p.research).trim().to_string());
        }
    }
    let p = motion.get(&id).ok_or("no such video project")?;
    let seconds = if p.brief.seconds == 0 { 30 } else { p.brief.seconds };
    let language = if p.brief.language.trim().is_empty() { "English".to_string() } else { p.brief.language.clone() };
    let system = SCRIPT_SYSTEM
        .replace("{words}", &words_for(seconds, &language).to_string())
        .replace("{seconds}", &seconds.to_string())
        .replace("{language}", &language);
    let user = format!(
        "Video type: {}\nWhat it is about (the person's brief):\n{}\n\nTheir own images: {}\n\nResearch:\n{}",
        if p.brief.kind == "explainer" { "explainer" } else { "ad / promo spot" },
        p.brief.product,
        { let own: Vec<&str> = p.assets.iter().filter(|a| a.kind == "user").map(|a| a.note.as_str()).collect(); if own.is_empty() { "none".to_string() } else { own.join("; ") } },
        if p.research.trim().is_empty() { "(none)" } else { &p.research }
    );
    let reply = ask(&app, &p.base_url, &p.text_model, &system, json!(user), 0.7).await?;
    let v = json_in(&reply).ok_or("The text model's script wasn't readable — try again.")?;
    let script = v["script"].as_str().unwrap_or("").trim().to_string();
    if script.is_empty() {
        return Err("The text model wrote no script — try again.".into());
    }
    motion.update(&app, &id, |p| {
        p.script = script;
        if let Some(t) = v["title"].as_str().filter(|t| !t.trim().is_empty()) {
            p.title = t.trim().to_string();
        }
        if p.status == "draft" {
            p.status = "script".into();
        }
    });
    motion.get(&id).ok_or("no such video project".into())
}

/// Make the video from the form, redoing only what changed since the last
/// one: a new script or voice redoes everything; a new image model, the look;
/// a new format, the animation; nothing changed, a fresh look.
#[tauri::command]
pub fn motion_make<R: Runtime>(app: AppHandle<R>, id: String, form: Form) -> Result<Project, String> {
    take_form(&app, &id, &form);
    let motion = app.state::<Motion>().inner().clone();
    let p = motion.get(&id).ok_or("no such video project")?;
    if p.script.trim().is_empty() {
        return Err("Write the script first (or let \"Write script\" draft it).".into());
    }
    if p.voice_id.trim().is_empty() {
        return Err("Pick a voice.".into());
    }
    let m = &p.made;
    let from = if p.versions == 0 || m.is_null() || !std::path::Path::new(&format!("{}/words.json", dir_of(&id))).exists() {
        From::Voice
    } else if m["script"] != p.script.as_str() || m["voice"] != format!("{}|{}|{}", p.voice_source, p.speech_model, p.voice_id).as_str() {
        From::Voice
    } else if m["imageModel"] != p.image_model.as_str() {
        From::Images
    } else if m["format"] != p.brief.format.as_str() {
        From::Animation
    } else {
        From::Images
    };
    start(&app, &id, from, String::new())?;
    motion.get(&id).ok_or("no such video project".into())
}

/// Change the last video: "animation" (the default, one pass of the
/// animation), "images" (new look, images and sound), or "voice" (all of it).
#[tauri::command]
pub fn motion_revise<R: Runtime>(app: AppHandle<R>, id: String, feedback: String, redo: String) -> Result<(), String> {
    if feedback.trim().is_empty() {
        return Err("Say what should change.".into());
    }
    let from = match redo.as_str() {
        "voice" => From::Voice,
        "images" => From::Images,
        _ => From::Animation,
    };
    start(&app, &id, from, feedback)
}

/// A short sample of a voice, as a data URL to play.
#[tauri::command]
pub async fn motion_sample<R: Runtime>(app: AppHandle<R>, id: String, source: String, model: String, voice: String, text: String) -> Result<String, String> {
    let file = sample(&app, &id, &source, &model, &voice, &text).await?;
    motion_audio(id, file)
}

#[tauri::command]
pub fn motion_delete<R: Runtime>(app: AppHandle<R>, id: String) {
    delete(&app, &id);
}

/// The project, or nothing if it has not changed since `since`.
#[tauri::command]
pub fn motion_get<R: Runtime>(app: AppHandle<R>, id: String, since: Option<u64>) -> Result<Option<Project>, String> {
    let p = app.state::<Motion>().get(&id).ok_or("no such video project")?;
    Ok((since.map_or(true, |r| p.rev > r)).then_some(p))
}

#[tauri::command]
pub fn motion_stop<R: Runtime>(app: AppHandle<R>, id: String) {
    if let Some(f) = app.state::<Motion>().0.stops.lock().unwrap().get(&id) {
        f.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole pipeline against the real services, as the chat drives it:
    /// voice → images → sound → animation → render, then a revision of the
    /// animation only. Ignored by default: it needs OPENROUTER_API_KEY in the
    /// environment, Chrome and ffmpeg, and spends a few cents.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn makes_and_revises_a_spot_end_to_end() {
        let or = std::env::var("OPENROUTER_API_KEY").unwrap();
        let app = tauri::test::mock_builder()
            .manage(Motion::default())
            .manage(crate::server::RemoteSettings::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle().clone();
        handle.state::<crate::server::RemoteSettings>().set(json!({ "openrouterKey": or }).to_string());
        let model = std::env::var("MOTION_TEXT_MODEL").unwrap_or("google/gemini-3.8-flash".into());
        let p = create(&handle, "https://openrouter.ai/api/v1", &model);
        let catalog = voice_catalog(&handle).await;
        assert!(catalog.contains("gemini"), "{catalog}");
        apply(&handle, &p.id, &Spec {
            title: "See the Break".into(),
            script: "Stop guessing your putts. Green Reader reads the green with your iPhone's LiDAR and shows your line in augmented reality. See the break before you putt.".into(),
            kind: "ad".into(),
            format: "9:16".into(),
            tone: "Bold & energetic".into(),
            voice_source: "openrouter".into(),
            speech_model: "google/gemini-3.8-flash-tts".into(),
            voice: "Puck".into(),
            ..Default::default()
        });
        let show = |s: &str| println!("… {s}");
        let (v1, summary) = run(&handle, &p.id, From::Voice, "", show, || false).await.unwrap();
        println!("{summary}");
        let (v2, summary) = run(&handle, &p.id, From::Animation, "Make the end card's call to action twice as big and hold it longer.", show, || false)
            .await
            .unwrap();
        println!("{summary}\nDIR {}", dir_of(&p.id));
        assert_ne!(v1, v2);
        assert!(summary.contains("Revising the animation") && !summary.contains("Recording the voice"), "{summary}");
    }

    /// The Video tab's form, end to end against the real services: options,
    /// a brief with an App Store link → script → make → "change something"
    /// (one animation pass). Ignored by default: needs OPENROUTER_API_KEY,
    /// Chrome and ffmpeg, and spends a few cents.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn the_form_writes_makes_and_changes_a_video() {
        let or = std::env::var("OPENROUTER_API_KEY").unwrap();
        let app = tauri::test::mock_builder()
            .manage(Motion::default())
            .manage(crate::server::RemoteSettings::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle().clone();
        handle.state::<crate::server::RemoteSettings>().set(json!({ "openrouterKey": or }).to_string());
        let options = motion_options(handle.clone()).await.unwrap();
        println!("image models: {}", options["imageModels"].as_array().map_or(0, |a| a.len()));
        println!("speech models: {}", options["speechModels"].as_array().map_or(0, |a| a.len()));
        assert!(options["error"].is_null(), "{}", options["error"]);
        let model = std::env::var("MOTION_TEXT_MODEL").unwrap_or("google/gemini-3.8-flash".into());
        let p = motion_new(handle.clone(), "https://openrouter.ai/api/v1".into(), model.clone());
        let form = || Form {
            brief: "A 15-second ad for Duolingo, the language-learning app: https://apps.apple.com/app/id570060128".into(),
            kind: "ad".into(),
            format: "9:16".into(),
            seconds: 15,
            language: "English".into(),
            voice_source: "openrouter".into(),
            speech_model: "google/gemini-3.8-flash-tts".into(),
            voice: "Puck".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            model: model.clone(),
            ..Default::default()
        };
        let written = motion_script(handle.clone(), p.id.clone(), form()).await.unwrap();
        println!("TITLE {}\nSCRIPT {}", written.title, written.script);
        assert!(written.assets.iter().any(|a| a.kind == "icon"), "the App Store icon is looked up");
        let wait = |h: AppHandle<tauri::test::MockRuntime>, id: String| async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let p = h.state::<Motion>().get(&id).unwrap();
                if p.status != "running" {
                    return p;
                }
            }
        };
        motion_make(handle.clone(), p.id.clone(), Form { script: written.script.clone(), title: written.title.clone(), ..form() }).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let done = wait(handle.clone(), p.id.clone()).await;
        assert_eq!(done.status, "done", "{:?}", done.error);
        let first = done.video_id.clone().unwrap();
        println!("v1 {first} ${:.3}", done.cost);
        motion_revise(handle.clone(), p.id.clone(), "Make the title twice as big.".into(), "animation".into()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let done = wait(handle.clone(), p.id.clone()).await;
        assert_eq!(done.status, "done", "{:?}", done.error);
        let steps: Vec<&str> = done.steps.iter().map(|s| s.title.as_str()).collect();
        println!("revision steps: {steps:?} · total ${:.3}\nDIR {}", done.cost, dir_of(&p.id));
        assert_ne!(done.video_id.unwrap(), first);
        assert_eq!(done.versions, 2);
        assert!(!steps.iter().any(|s| s.contains("voice")), "a revision keeps the voice");
    }

    /// Re-mix a finished project: MOTION_DIR=~/.ai-box/motion/<id>.
    #[tokio::test]
    #[ignore]
    async fn remix_hits_the_loudness_target() {
        let dir = std::env::var("MOTION_DIR").unwrap();
        let dur = probe_seconds(&format!("{dir}/music.wav")).await.unwrap();
        let lufs = mix(&dir, dur).await.unwrap();
        println!("LUFS {lufs}");
        let v: f64 = lufs.split_whitespace().next().unwrap().parse().unwrap();
        assert!((v + 14.0).abs() < 0.6, "{lufs}");
    }

    #[test]
    fn character_times_become_word_times() {
        let a = json!({
            "characters": ["H","i"," ","y","o","u","."],
            "character_start_times_seconds": [0.0,0.1,0.2,0.3,0.4,0.5,0.6],
            "character_end_times_seconds": [0.1,0.2,0.3,0.4,0.5,0.6,0.7],
        });
        let w = words_from(&a, 0.4);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].w, "Hi");
        assert!((w[0].s - 0.4).abs() < 1e-9 && (w[0].e - 0.6).abs() < 1e-9);
        assert_eq!(w[1].w, "you.");
        assert!((w[1].s - 0.7).abs() < 1e-9);
    }

    #[test]
    fn replies_are_read_fenced_or_not() {
        assert_eq!(json_in("Sure!\n```json\n{\"script\": \"x\"}\n```").unwrap()["script"].as_str(), Some("x"));
        assert!(html_in("Here:\n```html\n<!DOCTYPE html><html><body></body></html>\n```").unwrap().starts_with("<!DOCTYPE"));
        assert!(html_in("no document").is_none());
    }

    #[test]
    fn gsap_goes_in_before_the_pages_own_scripts() {
        let out = instrument("<!doctype html><html><head><script>tl()</script></head></html>");
        assert!(out.find("gsap.min.js").unwrap() < out.find("tl()").unwrap());
    }

    #[test]
    fn transparent_margins_are_trimmed() {
        let mut img = image::RgbaImage::from_pixel(400, 400, image::Rgba([0, 0, 0, 0]));
        for x in 100..200 {
            for y in 150..250 {
                img.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
            }
        }
        let t = trim_alpha(img);
        assert!(t.width() < 120 && t.height() < 120, "{}x{}", t.width(), t.height());
    }

    #[test]
    fn sound_is_the_right_length_and_never_clips_hard() {
        let m = music(3.0, "upbeat", 110.0);
        assert_eq!(m.len(), 3 * RATE as usize);
        assert!(m.iter().all(|s| s[0].abs() < 1.5 && s[1].abs() < 1.5));
        let fx = effects(3.0, &[(1.0, "whoosh".into()), (2.0, "hit".into()), (2.5, "riser".into())]);
        assert!(fx.iter().any(|s| s[0].abs() > 0.01));
    }

    #[test]
    fn app_store_ids_are_found_in_links() {
        assert_eq!(app_id("https://apps.apple.com/de/app/eyeguide-live/id6738291234").as_deref(), Some("6738291234"));
        assert_eq!(app_id("6738291234").as_deref(), Some("6738291234"));
        assert_eq!(app_id("EyeGuide Live"), None);
        assert_eq!(png_name("Rocket Ship!.png"), "ai-rocket-ship.png");
        assert_eq!(png_name("../../x"), "ai-x.png");
    }
}
