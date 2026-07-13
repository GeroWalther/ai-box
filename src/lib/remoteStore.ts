// A shared key/value store that lives on the Mac, reachable from both the desktop
// app (Tauri IPC) and a paired phone (through the companion server) via the same
// transport. Use it for state that should be the SAME across devices — e.g. chat
// history — instead of per-device localStorage.
import { invokeCmd } from "./transport";

export const remoteStoreGet = (key: string) =>
  invokeCmd<string | null>("remote_store_get", { key });

export const remoteStoreSet = (key: string, value: string) =>
  invokeCmd<void>("remote_store_set", { key, value });

// Merge a device's list ({items, deleted} JSON) into the shared store and get the
// merged union back — conflict-free sync for documents and chat sessions, so
// concurrent desktop/phone edits don't clobber each other.
export const remoteStoreMerge = (key: string, payload: string) =>
  invokeCmd<string>("store_merge_list", { key, incoming: payload });
