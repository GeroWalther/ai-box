// Guarded localStorage.
//
// The manuscript list used to be written with a bare `localStorage.setItem`. When
// the 5 MB quota is reached (a long novel plus several drafts gets there), that
// call THROWS — inside a React effect, which meant persistence silently died and
// the writer kept typing into a document that was no longer being saved anywhere.
// Nothing about a writing tool may fail that quietly, so every write goes through
// here: failures are logged, surfaced to the UI, and never propagate as an
// exception into rendering.

import { logError, logWarn } from "./log";

/** Raised to the UI when the browser store is full, so the user can act on it. */
export type StorageFailure = { key: string; reason: "quota" | "unavailable"; message: string };

const listeners = new Set<(f: StorageFailure) => void>();

/** Subscribe to storage failures (the app shows a persistent warning banner). */
export function onStorageFailure(fn: (f: StorageFailure) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function report(failure: StorageFailure): void {
  logError(`storage.${failure.key}`, failure.message);
  for (const fn of listeners) fn(failure);
}

function isQuotaError(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false;
  // Safari reports 22 / QuotaExceededError; Firefox uses NS_ERROR_DOM_QUOTA_REACHED.
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  );
}

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    logWarn(`storage.${key}`, `read failed: ${String(e)}`);
    return null;
  }
}

/** Parse a JSON value from localStorage, returning `fallback` on any problem. */
export function readJson<T>(key: string, fallback: T): T {
  const raw = readLocal(key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    logWarn(`storage.${key}`, "corrupt JSON — falling back to default");
    return fallback;
  }
}

/**
 * Write to localStorage. Returns false (never throws) when the value could not be
 * stored, so callers can decide whether that is worth telling the user about.
 */
export function writeLocal(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (isQuotaError(e)) {
      report({
        key,
        reason: "quota",
        message:
          "This device's local storage is full, so the last change could not be cached here. " +
          "Your work is still saved on the Mac — delete some old documents or images to clear space.",
      });
    } else {
      report({ key, reason: "unavailable", message: `write failed: ${String(e)}` });
    }
    return false;
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    return writeLocal(key, JSON.stringify(value));
  } catch (e) {
    report({ key, reason: "unavailable", message: `serialize failed: ${String(e)}` });
    return false;
  }
}

export function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing useful to do — the key stays until the store recovers */
  }
}

/**
 * Read `key`, falling back to a pre-rename `legacyKey` and migrating it forward.
 * Used by the Novel Studio → AI Studio rename so nobody loses their settings.
 */
export function readWithLegacy(key: string, legacyKey: string): string | null {
  const current = readLocal(key);
  if (current !== null) return current;
  const legacy = readLocal(legacyKey);
  if (legacy !== null) {
    writeLocal(key, legacy);
    removeLocal(legacyKey);
  }
  return legacy;
}
