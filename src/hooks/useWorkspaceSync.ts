// "Where you left off" across devices: which section, and which document / chat /
// terminal was open. A small shared pointer, separate from the data itself.
//
// The ordering problem this solves: a device must ADOPT the shared pointer before
// it PUBLISHES its own, or opening the phone would immediately overwrite the
// Mac's position with the phone's cold-start defaults. That used to be a 1600ms
// timer. It is now a promise: publishing waits for the first sync to complete,
// however long that takes.

import { useCallback, useEffect, useRef } from "react";
import { remoteStoreGet, remoteStoreSet } from "../lib/remoteStore";
import {
  NAV_EVENT,
  notifyWorkspaceAdopted,
  onSynced,
  whenFirstSyncDone,
} from "../lib/syncBus";
import { readLocal, writeLocal } from "../lib/storage";
import { logError } from "../lib/log";

const WORKSPACE_KEY = "ai-studio.workspace";
const CHAT_ACTIVE_KEY = "ai-studio.chat.active";
const TERM_ACTIVE_KEY = "ai-studio.terminals.active";

export interface Workspace {
  view?: string;
  doc?: string;
  chat?: string;
  term?: string;
  at?: number;
}

interface Params {
  view: string;
  activeDocId: string;
  onAdopt: (ws: Workspace) => void;
}

export function useWorkspaceSync({ view, activeDocId, onAdopt }: Params) {
  const viewRef = useRef(view);
  const docRef = useRef(activeDocId);
  const onAdoptRef = useRef(onAdopt);
  viewRef.current = view;
  docRef.current = activeDocId;
  onAdoptRef.current = onAdopt;

  const publish = useCallback(async () => {
    // Never publish before adopting — see the note at the top of this file.
    await whenFirstSyncDone();
    const ws: Workspace = {
      view: viewRef.current,
      doc: docRef.current,
      chat: readLocal(CHAT_ACTIVE_KEY) || "",
      term: readLocal(TERM_ACTIVE_KEY) || "",
      at: Date.now(),
    };
    try {
      await remoteStoreSet(WORKSPACE_KEY, JSON.stringify(ws));
    } catch (e) {
      logError("workspace.publish", e);
    }
  }, []);

  const adopt = useCallback(async () => {
    let raw: string | null = null;
    try {
      raw = await remoteStoreGet(WORKSPACE_KEY);
    } catch (e) {
      logError("workspace.read", e);
      return;
    }
    if (!raw) return;
    let ws: Workspace;
    try {
      ws = JSON.parse(raw);
    } catch {
      return;
    }
    // The active-item keys are read by the child views on the workspace event,
    // so they must be in place before it fires.
    if (ws.chat) writeLocal(CHAT_ACTIVE_KEY, ws.chat);
    if (ws.term) writeLocal(TERM_ACTIVE_KEY, ws.term);
    onAdoptRef.current(ws);
    notifyWorkspaceAdopted();
  }, []);

  // Adopt after every completed sync — including the first one, which is what
  // makes "open the phone, land where the Mac was" work on a cold start. The
  // data has already landed by then, so the pointer always refers to something
  // that exists.
  useEffect(() => onSynced(() => void adopt()), [adopt]);

  // Publish on navigation, debounced so flipping through tabs writes once.
  useEffect(() => {
    const t = setTimeout(() => void publish(), 400);
    const onNav = () => void publish();
    window.addEventListener(NAV_EVENT, onNav);
    return () => {
      clearTimeout(t);
      window.removeEventListener(NAV_EVENT, onNav);
    };
  }, [view, activeDocId, publish]);
}
