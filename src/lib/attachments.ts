// Images attached to a chat message. The pixels live on the Mac
// (src-tauri/src/attach.rs); a message only carries these small records, so
// chat history stays light enough for localStorage and device sync.
import { invokeCmd } from "./transport";

export interface Attached {
  id: string;
  name: string;
  /** The original file on the Mac, when it was dropped from Finder. */
  source?: string | null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
export const isImagePath = (path: string) => IMAGE_EXT.test(path);
export const isImageFile = (file: File) => file.type.startsWith("image/") || IMAGE_EXT.test(file.name);

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** A pasted, picked, or phone-dropped image. */
export async function attachFile(file: File): Promise<Attached> {
  const base64 = await fileToBase64(file);
  return invokeCmd<Attached>("attach_image_bytes", { base64, name: file.name || "pasted image" });
}

/** An image dropped from Finder onto the desktop app. */
export const attachPath = (path: string) => invokeCmd<Attached>("attach_image_path", { path });

// Images never change once stored, so a fetched one is kept for the session:
// thumbnails and every agent step reuse it instead of refetching.
const cache = new Map<string, Promise<string>>();

export function attachmentUrl(id: string): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    p = invokeCmd<string>("attachment_get", { id });
    // A failure is not cached, so a later look can succeed.
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/**
 * A user message as the model should see it: plain text when there are no
 * images, otherwise the OpenAI content-part array, which the backend also
 * translates for Anthropic. An image that has gone missing is skipped rather
 * than failing the whole request.
 */
export async function userContent(text: string, images?: Attached[]): Promise<string | unknown[]> {
  if (!images?.length) return text;
  // Name where each original lives, so the agent can act on the file itself
  // ("move this into the project"), not just look at it.
  const sources = images.filter((a) => a.source).map((a) => `- ${a.source}`);
  const body = sources.length ? `${text}\n\n[Attached image files on this Mac:\n${sources.join("\n")}]` : text;
  const parts: unknown[] = [];
  if (body.trim()) parts.push({ type: "text", text: body });
  for (const a of images) {
    try {
      parts.push({ type: "image_url", image_url: { url: await attachmentUrl(a.id) } });
    } catch {
      parts.push({ type: "text", text: `[image "${a.name}" is no longer available]` });
    }
  }
  return parts;
}
