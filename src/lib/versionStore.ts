// Document version history.
//
// Snapshots live on the Mac (one JSON file each), so the history is shared with
// a paired phone exactly like documents and images are. The snapshot *policy*
// lives here rather than in the editor component, because "when is a draft worth
// keeping" is a product decision, not a rendering one.

import { invokeCmd } from "./transport";
import { logError } from "./log";

export interface VersionMeta {
  at: number;
  title: string;
  words: number;
  /** What prompted the snapshot — shown in the list so the entries mean something. */
  reason: VersionReason;
}

export interface Version extends VersionMeta {
  html: string;
}

export type VersionReason =
  | "auto" // periodic, while writing
  | "ai-edit" // taken before the AI replaced or rewrote text
  | "restore" // taken before restoring an older version
  | "manual"; // the user asked for it

/** Minimum gap between periodic snapshots. */
const AUTO_INTERVAL_MS = 2 * 60 * 1000;
/** Minimum change (in characters) before a periodic snapshot is worth taking. */
const AUTO_MIN_DELTA = 120;

interface Mark {
  at: number;
  length: number;
}
const lastAuto = new Map<string, Mark>();

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Write a snapshot. Never throws — losing a snapshot must not break an edit. */
export async function saveVersion(
  docId: string,
  version: Version
): Promise<void> {
  if (!docId || !version.html) return;
  try {
    await invokeCmd("doc_version_put", {
      docId,
      at: version.at,
      record: JSON.stringify(version),
    });
    lastAuto.set(docId, { at: version.at, length: version.html.length });
  } catch (e) {
    logError("versions.save", e);
  }
}

/**
 * Take a periodic snapshot if enough time has passed AND enough has changed.
 * Both conditions matter: time alone would snapshot idle documents, size alone
 * would snapshot every burst of fast typing.
 */
export async function maybeAutoSnapshot(
  docId: string,
  title: string,
  html: string,
  text: string
): Promise<void> {
  const now = Date.now();
  const mark = lastAuto.get(docId);
  if (mark) {
    if (now - mark.at < AUTO_INTERVAL_MS) return;
    if (Math.abs(html.length - mark.length) < AUTO_MIN_DELTA) return;
  }
  await saveVersion(docId, {
    at: now,
    title,
    html,
    words: countWords(text),
    reason: "auto",
  });
}

/** Snapshot right now regardless of the cadence (before an AI edit, say). */
export async function snapshotNow(
  docId: string,
  title: string,
  html: string,
  text: string,
  reason: VersionReason
): Promise<void> {
  if (!html.trim()) return; // nothing worth keeping
  await saveVersion(docId, {
    at: Date.now(),
    title,
    html,
    words: countWords(text),
    reason,
  });
}

export async function listVersions(docId: string): Promise<VersionMeta[]> {
  try {
    const rows = await invokeCmd<VersionMeta[]>("doc_version_list", { docId });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    logError("versions.list", e);
    return [];
  }
}

export async function getVersion(docId: string, at: number): Promise<Version | null> {
  try {
    const raw = await invokeCmd<string | null>("doc_version_get", { docId, at });
    return raw ? (JSON.parse(raw) as Version) : null;
  } catch (e) {
    logError("versions.get", e);
    return null;
  }
}

/** Forget a deleted document's history so old drafts don't linger on disk. */
export async function clearVersions(docId: string): Promise<void> {
  try {
    await invokeCmd("doc_versions_clear", { docId });
  } catch (e) {
    logError("versions.clear", e);
  }
}

/** Export every document into a dated folder in ~/Downloads; returns the path. */
export async function exportLibrary(
  files: { name: string; content: string }[]
): Promise<string> {
  return invokeCmd<string>("export_library", { files });
}
