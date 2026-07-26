// A tiny in-memory log ring.
//
// The app used to swallow failures in dozens of `catch {}` blocks: a sync that
// never landed, a keychain read that failed, a store write that hit quota — all
// invisible to the user AND to us. Everything that is deliberately non-fatal now
// reports here instead of vanishing, so Settings → Diagnostics can show what
// actually went wrong, and a bug report can include it.

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  at: number;
  level: LogLevel;
  /** Where it happened, e.g. "sync.docs" or "keychain". */
  scope: string;
  message: string;
}

const MAX_ENTRIES = 300;
const entries: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();

function push(level: LogLevel, scope: string, message: string): void {
  const entry: LogEntry = { at: Date.now(), level, scope, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  for (const fn of listeners) fn(entry);
  // Dev builds also mirror to the console, where a stack trace is clickable.
  if (import.meta.env.DEV) {
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    fn(`[${scope}] ${message}`);
  }
}

/** Turn any thrown value into a readable one-liner. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export const logInfo = (scope: string, message: string) => push("info", scope, message);
export const logWarn = (scope: string, message: string) => push("warn", scope, message);
export const logError = (scope: string, e: unknown) => push("error", scope, describeError(e));

/** Newest first — for the Diagnostics panel. */
export function recentLogs(): LogEntry[] {
  return [...entries].reverse();
}

export function clearLogs(): void {
  entries.length = 0;
}

/** Subscribe to new entries; returns an unsubscribe function. */
export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Copy-pasteable log dump for a bug report. */
export function logsAsText(): string {
  return entries
    .map((e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase()} [${e.scope}] ${e.message}`)
    .join("\n");
}

// Last-resort net: anything that escapes a handler still lands in the ring.
if (typeof window !== "undefined") {
  window.addEventListener("error", (ev) => push("error", "window", ev.message));
  window.addEventListener("unhandledrejection", (ev) =>
    push("error", "unhandled-rejection", describeError(ev.reason))
  );
}
