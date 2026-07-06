// Persistent gallery for generated images. Images are large, so we use
// IndexedDB (tens/hundreds of MB) instead of localStorage (~5 MB).
export interface ImageRecord {
  id: string;
  prompt: string;
  backend: string;
  model: string;
  dataUrl: string; // full "data:image/png;base64,…"
  at: number;
}

const DB_NAME = "ai-studio";
const STORE = "images";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addImage(rec: ImageRecord): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function allImages(): Promise<ImageRecord[]> {
  const db = await open();
  try {
    const rows = await new Promise<ImageRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as ImageRecord[]);
      req.onerror = () => reject(req.error);
    });
    return rows.sort((a, b) => b.at - a.at); // newest first
  } finally {
    db.close();
  }
}

export async function deleteImage(id: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
