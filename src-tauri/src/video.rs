// The video library: finished clips stored on the Mac.
//
// Videos are made by motion.rs (Video → Motion graphics). Each clip is an MP4
// written next to a small JSON record. Videos are tens of megabytes; keeping
// bytes out of the metadata means listing the library stays cheap, and the
// phone sees the same library because it lives here.

use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

use crate::{app_path, expand_path, safe_id};

/// `{ apiKey }` — the parameters of a catalog call that only needs a key.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyParams {
    #[serde(default)]
    pub api_key: String,
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


// ffmpeg is found where Homebrew puts it; the motion renderer needs it and says
// so plainly when it is missing, rather than shipping a bundled binary.

pub(crate) fn ffmpeg_bin() -> Option<String> {
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

/// File a video made on the Mac (motion graphics) under a library id.
pub(crate) fn store_file(id: &str, src: &str) -> Result<(), String> {
    let sid = safe_id(id);
    if sid.is_empty() {
        return Err("bad video id".into());
    }
    std::fs::create_dir_all(videos_dir()).map_err(|e| e.to_string())?;
    std::fs::copy(src, mp4_path(&sid)).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_rejects_a_clip_that_is_gone() {
        assert!(video_save("definitely-not-a-real-clip-id".into(), None).is_err());
    }
}
