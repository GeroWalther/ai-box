// Images attached to a chat message.
//
// A chat session is JSON that lives in localStorage and is merged between the
// Mac and a paired phone, so the pixels cannot live in it: a handful of photos
// would exhaust the quota and make every sync carry megabytes. The message
// keeps an id; the image is a file on the Mac, and both devices fetch it from
// there, the same way the image gallery works.
//
// Images are shrunk on the way in. Vision models downscale anything past about
// 1.5k pixels on the long edge anyway, so a 12-megapixel photo sent as-is is
// paying to upload detail the model throws away — and it is re-sent on every
// agent step, because the whole conversation goes up each time.

use base64::Engine;
use serde::Serialize;

/// Long-edge cap. Anthropic's recommended maximum, and at or above what the
/// other vision models keep.
const MAX_EDGE: u32 = 1568;
const MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Serialize)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    /// Where the original lives on the Mac, when it was dropped from Finder.
    /// Lets the agent act on the real file ("put this in the project") rather
    /// than on the shrunk copy.
    pub source: Option<String>,
}

fn dir() -> String {
    crate::app_path("attachments")
}

fn file_for(id: &str) -> Result<std::path::PathBuf, String> {
    // Ids come back from a remote device, so only ever accept the shape we
    // issue — never a path.
    let valid = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !valid {
        return Err("not an attachment id".into());
    }
    Ok(std::path::Path::new(&dir()).join(format!("{id}.jpg")))
}

/// Decode anything the `image` crate reads; on macOS fall back to `sips` for
/// the formats it does not (HEIC from an iPhone, TIFF, …).
fn decode(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    if let Ok(img) = image::load_from_memory(bytes) {
        return Ok(img);
    }
    #[cfg(target_os = "macos")]
    {
        let tmp = std::env::temp_dir();
        let src = tmp.join(format!("ai-box-attach-{}", uuid::Uuid::new_v4()));
        let out = src.with_extension("png");
        let converted = std::fs::write(&src, bytes).is_ok()
            && std::process::Command::new("/usr/bin/sips")
                .args(["-s", "format", "png"])
                .arg(&src)
                .arg("--out")
                .arg(&out)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
        let img = converted
            .then(|| std::fs::read(&out).ok())
            .flatten()
            .and_then(|b| image::load_from_memory(&b).ok());
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
        if let Some(img) = img {
            return Ok(img);
        }
    }
    Err("that file is not an image AI Box can read".into())
}

fn store(bytes: &[u8], name: &str, source: Option<String>) -> Result<Attachment, String> {
    if bytes.len() > MAX_BYTES {
        return Err("that image is larger than 25 MB".into());
    }
    let mut img = decode(bytes)?;
    if img.width().max(img.height()) > MAX_EDGE {
        img = img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3);
    }
    // JPEG has no alpha. Flatten onto white, so a transparent logo does not
    // turn into a black square.
    let rgba = img.to_rgba8();
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        rgb.put_pixel(x, y, image::Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let path = file_for(&id)?;
    std::fs::create_dir_all(dir()).map_err(|e| format!("create attachments folder: {e}"))?;
    let mut out = std::io::BufWriter::new(
        std::fs::File::create(&path).map_err(|e| format!("write attachment: {e}"))?,
    );
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 88)
        .encode_image(&rgb)
        .map_err(|e| format!("encode attachment: {e}"))?;

    let name = name.rsplit('/').next().unwrap_or("image").to_string();
    Ok(Attachment { id, name, source })
}

/// An image the user dropped from Finder onto the desktop app. Desktop only:
/// it reads an arbitrary path, so it is deliberately absent from the remote
/// server's command table.
#[tauri::command]
pub fn attach_image_path(path: String) -> Result<Attachment, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    store(&bytes, &path, Some(path.clone()))
}

/// An image pasted, picked, or dropped as bytes — the only route from a phone.
#[tauri::command]
pub fn attach_image_bytes(base64: String, name: String) -> Result<Attachment, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("decode image: {e}"))?;
    store(&bytes, &name, None)
}

/// The stored image as a data URL, for thumbnails and for the model request.
#[tauri::command]
pub fn attachment_get(id: String) -> Result<String, String> {
    let bytes = std::fs::read(file_for(&id)?).map_err(|_| "that image is no longer on the Mac".to_string())?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_cannot_walk_out_of_the_folder() {
        assert!(file_for("../../.ssh/id_rsa").is_err());
        assert!(file_for("").is_err());
        assert!(file_for("3f2b9c1e-0000-4000-8000-000000000000").is_ok());
    }

    #[test]
    fn a_large_transparent_image_is_shrunk_and_flattened() {
        let img = image::RgbaImage::from_pixel(4000, 1000, image::Rgba([0, 0, 0, 0]));
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let a = store(png.get_ref(), "logo.png", None).unwrap();
        let bytes = std::fs::read(file_for(&a.id).unwrap()).unwrap();
        let back = image::load_from_memory(&bytes).unwrap().to_rgb8();
        let _ = std::fs::remove_file(file_for(&a.id).unwrap());
        assert_eq!((back.width(), back.height()), (1568, 392));
        // Transparent became white, not black.
        assert!(back.get_pixel(10, 10)[0] > 240);
    }

    #[test]
    fn a_non_image_is_refused_with_a_reason() {
        let err = store(b"just some text", "notes.txt", None).err().unwrap();
        assert!(err.contains("not an image"), "{err}");
    }
}
