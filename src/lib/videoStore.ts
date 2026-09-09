// The clip library. Like the image gallery, records live as files ON THE MAC,
// so the desktop and a paired phone see the same set. Unlike it, the MP4 is a
// separate file rather than base64 inside the record — clips are tens of
// megabytes, and listing must not drag them along.
//
// A record is written the moment a job is submitted, not when it finishes. That
// is what makes generation survivable: quitting mid-render leaves a `pending`
// record with its job id, and the panel resumes polling it on next launch
// instead of losing a paid render.
import { invokeCmd } from "./transport";
import type { VideoJobStatus } from "./api";

export interface VideoRecord {
  /** Local id — also the filename of the stored MP4. */
  id: string;
  /** OpenRouter job id, used to resume polling. */
  jobId: string;
  prompt: string;
  model: string;
  modelName: string;
  status: VideoJobStatus;
  at: number;
  duration?: number;
  resolution?: string;
  aspect?: string;
  audio?: boolean;
  /** Set once the MP4 is on disk. */
  bytes?: number;
  cost?: number;
  error?: string;
  /** Shot number within a storyboard, when this clip came from one. */
  shot?: number;
  /** Groups the shots of one storyboard so they can be joined in order. */
  storyboardId?: string;
}

export async function putVideo(rec: VideoRecord): Promise<void> {
  await invokeCmd("video_put", { id: rec.id, record: JSON.stringify(rec) });
}

/** Library metadata, newest first. Never carries video bytes. */
export async function allVideos(): Promise<VideoRecord[]> {
  const rows = await invokeCmd<VideoRecord[]>("video_list");
  return Array.isArray(rows) ? rows : [];
}

export async function getVideo(id: string): Promise<VideoRecord | null> {
  const raw = await invokeCmd<string | null>("video_get", { id });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VideoRecord;
  } catch {
    return null;
  }
}

export async function deleteVideo(id: string): Promise<void> {
  await invokeCmd("video_delete", { id });
}

/**
 * A playable object URL for a stored clip. The bytes come back base64 and are
 * turned into a Blob rather than a `data:` URI, so `<video>` can seek through
 * a 30 MB file and the memory is released by revokeVideoUrl().
 */
export async function videoObjectUrl(id: string): Promise<string> {
  const b64 = await invokeCmd<string>("video_data", { id });
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
}

export function revokeVideoUrl(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}

/** A job that hasn't reached a terminal state — resumed on next launch. */
export function isPending(r: VideoRecord): boolean {
  return r.status === "pending" || r.status === "in_progress";
}
