// Generated-image gallery. Images live as files ON THE MAC (via the backend) so
// the gallery is the SAME on the desktop and any paired phone — the phone is just
// a remote view, it doesn't keep its own copy. list() returns metadata only (no
// image bytes); each thumbnail's data is fetched on demand with getImage().
import { invokeCmd } from "./transport";

export interface ImageRecord {
  id: string;
  prompt: string;
  backend: string;
  model: string;
  dataUrl?: string; // full "data:image/png;base64,…" — omitted in list(), present in getImage()
  at: number;
  seed?: number; // for reproduce (local ComfyUI)
}

export async function addImage(rec: ImageRecord): Promise<void> {
  await invokeCmd("image_put", { id: rec.id, record: JSON.stringify(rec) });
}

/** Gallery metadata, newest first, WITHOUT the heavy image data. */
export async function allImages(): Promise<ImageRecord[]> {
  const rows = await invokeCmd<ImageRecord[]>("image_list");
  return Array.isArray(rows) ? rows : [];
}

/** Full record (with dataUrl) for one image. */
export async function getImage(id: string): Promise<ImageRecord | null> {
  const raw = await invokeCmd<string | null>("image_get", { id });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ImageRecord;
  } catch {
    return null;
  }
}

export async function deleteImage(id: string): Promise<void> {
  await invokeCmd("image_delete", { id });
}

// ---- one-time migration from the old per-device IndexedDB gallery ----------
const DB_NAME = "ai-studio";
const STORE = "images";
const MIGRATED_KEY = "ai-studio.images-migrated";

function openLegacy(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function legacyAll(): Promise<ImageRecord[]> {
  const db = await openLegacy();
  if (!db) return [];
  try {
    return await new Promise<ImageRecord[]>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as ImageRecord[]);
      req.onerror = () => resolve([]);
    });
  } finally {
    db.close();
  }
}

/**
 * Copy this device's old local (IndexedDB) images into the shared Mac store, so
 * images made before this change (including on the phone) still appear. Idempotent
 * (keyed by id); runs once per device.
 */
export async function migrateLegacyImages(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    const legacy = await legacyAll();
    for (const rec of legacy) {
      if (rec && rec.id && rec.dataUrl) await addImage(rec).catch(() => {});
    }
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch {
    /* ignore */
  }
}
