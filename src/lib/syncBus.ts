// Cross-device sync coordination.
//
// This used to run on guessed delays: dispatch a sync event 500ms after settings
// loaded, allow the workspace pointer to be pushed 1600ms after launch, adopt the
// other device's pointer 350ms after that. On a fast LAN it worked. On a slow
// phone connection the ordering inverted — a device pushed "here's where I am"
// before it had finished reading where the *other* device was, so opening the
// phone could yank the Mac to a different document.
//
// The fix is to make the ordering explicit instead of temporal. Views register a
// pull function; `syncAll()` awaits every one of them; anything that must happen
// strictly after the first pull awaits `whenFirstSyncDone()`. No timers, and it
// is correct whether the round trip takes 20ms or 20 seconds.

import { logError } from "./log";

/** A view's "pull the shared state I own" function. */
type SyncSource = () => Promise<void> | void;

interface Registration {
  name: string;
  pull: SyncSource;
}

const sources = new Set<Registration>();
const afterSync = new Set<() => void>();

let firstSyncResolve: (() => void) | null = null;
const firstSync = new Promise<void>((resolve) => {
  firstSyncResolve = resolve;
});
let firstSyncDone = false;
let inFlight: Promise<void> | null = null;

/**
 * Register a view's pull function for the duration of its mount.
 * Returns an unregister function for the effect cleanup.
 */
export function registerSyncSource(name: string, pull: SyncSource): () => void {
  const reg = { name, pull };
  sources.add(reg);
  return () => sources.delete(reg);
}

/** Run after every registered source has finished pulling (e.g. adopt the workspace). */
export function onSynced(fn: () => void): () => void {
  afterSync.add(fn);
  return () => afterSync.delete(fn);
}

/**
 * Pull every registered source concurrently and wait for all of them.
 *
 * Concurrent calls share one run rather than stacking: tapping Sync twice, or a
 * manual sync landing on top of the automatic one, should not double-merge.
 */
export function syncAll(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const runs = [...sources].map(async (s) => {
      try {
        await s.pull();
      } catch (e) {
        // One failing view must not abort the others — a phone with no terminal
        // history still needs its documents.
        logError(`sync.${s.name}`, e);
      }
    });
    await Promise.all(runs);
    for (const fn of afterSync) {
      try {
        fn();
      } catch (e) {
        logError("sync.after", e);
      }
    }
    if (!firstSyncDone) {
      firstSyncDone = true;
      firstSyncResolve?.();
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Resolves once the first full sync has completed. Anything that would publish
 * this device's state must await it, so a freshly-opened device never overwrites
 * the shared pointer before it has read it.
 */
export function whenFirstSyncDone(): Promise<void> {
  return firstSync;
}

export function hasSynced(): boolean {
  return firstSyncDone;
}

// ---- legacy window events -------------------------------------------------
// Views still signal "I navigated" and listen for "the workspace pointer
// changed" through window events, which is a reasonable fit for those: they are
// notifications, not ordered work. Named here so the strings aren't scattered.

export const NAV_EVENT = "ai-studio-nav";
export const WORKSPACE_EVENT = "ai-studio-ws";

export const notifyNavigated = () => window.dispatchEvent(new Event(NAV_EVENT));
export const notifyWorkspaceAdopted = () => window.dispatchEvent(new Event(WORKSPACE_EVENT));
