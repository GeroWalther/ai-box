// Everything about the document library: state, guarded persistence, conflict-free
// sync with the Mac, and version snapshots.
//
// This was ~180 lines interleaved through App.tsx alongside rendering, keyboard
// handling and provider resolution. Pulled out, the rules are actually visible:
// local writes are guarded, remote writes always MERGE (never overwrite), and no
// destructive operation happens without a snapshot first.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { readJson, writeJson } from "../lib/storage";
import { remoteStoreMerge } from "../lib/remoteStore";
import { parseSyncList } from "../lib/syncList";
import { registerSyncSource } from "../lib/syncBus";
import { logError } from "../lib/log";
import {
  clearVersions,
  maybeAutoSnapshot,
  snapshotNow,
  type VersionReason,
} from "../lib/versionStore";
import { EMPTY_BIBLE, type StoryBibleData } from "../lib/presets";

// NOTE: the "ai-studio." prefix on these keys is deliberate and stays put across
// the rename to AI Box. It is not just a localStorage key — it is also the key
// this list is stored under in the shared store on the Mac, so changing it would
// orphan every existing document and chat rather than rename them. Users never
// see these strings; their data is worth more than the tidiness.
export const DOCS_KEY = "ai-studio.documents";
const DOCS_DEL_KEY = "ai-studio.documents.deleted";
const LEGACY_DOC_KEY = "novel-studio.document";

export interface Doc {
  id: string;
  title: string;
  html: string;
  bible?: StoryBibleData;
  /** Running "story so far" memory of the chapters before the verbatim window,
   *  and how many characters of the manuscript it covers (to detect staleness). */
  summary?: string;
  summaryChars?: number;
  /** True once the user renames the doc, so the title stops auto-deriving. */
  titleManual?: boolean;
  /** Last-edit timestamp (ms) used to merge concurrent desktop/phone edits. */
  updatedAt?: number;
}

/** Derive a title from the first non-empty line of the text. */
export function docTitle(text: string): string {
  const line = text
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  return line ? line.slice(0, 40) : "Untitled";
}

function blankDoc(): Doc {
  return { id: crypto.randomUUID(), title: "Untitled", html: "", updatedAt: Date.now() };
}

function loadDocs(): Doc[] {
  const arr = readJson<Doc[] | null>(DOCS_KEY, null);
  if (Array.isArray(arr) && arr.length) return arr;
  // One-time migration from the single-document original.
  const legacy = readJson<string | null>(LEGACY_DOC_KEY, null);
  return [{ ...blankDoc(), html: typeof legacy === "string" ? legacy : "" }];
}

export function useDocuments(editor: Editor | null) {
  const [documents, setDocuments] = useState<Doc[]>(loadDocs);
  const [activeDocId, setActiveDocId] = useState<string>("");
  const [deletedDocs, setDeletedDocs] = useState<Record<string, number>>(() =>
    readJson<Record<string, number>>(DOCS_DEL_KEY, {})
  );

  // Latest values for async work that must not close over stale state.
  const docsRef = useRef(documents);
  const deletedRef = useRef(deletedDocs);
  const activeIdRef = useRef(activeDocId);
  // Writing back to the shared store is disabled until the first load completes,
  // so an empty initial state can't merge over the Mac's real library.
  const loadedRef = useRef(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    docsRef.current = documents;
  }, [documents]);
  useEffect(() => {
    deletedRef.current = deletedDocs;
  }, [deletedDocs]);
  useEffect(() => {
    activeIdRef.current = activeDocId;
  }, [activeDocId]);

  // Keep a valid active document at all times.
  useEffect(() => {
    if (!documents.length) {
      setDocuments([blankDoc()]);
      return;
    }
    if (!documents.find((d) => d.id === activeDocId)) setActiveDocId(documents[0].id);
  }, [documents, activeDocId]);

  // Persist locally (guarded — a full quota logs and warns instead of throwing)
  // and mirror to the Mac, debounced so typing doesn't hammer the file.
  useEffect(() => {
    writeJson(DOCS_KEY, documents);
    writeJson(DOCS_DEL_KEY, deletedDocs);
    if (!loadedRef.current) return;
    const t = setTimeout(() => {
      remoteStoreMerge(
        DOCS_KEY,
        JSON.stringify({ items: docsRef.current, deleted: deletedRef.current })
      ).catch((e) => logError("docs.mirror", e));
    }, 700);
    return () => clearTimeout(t);
  }, [documents, deletedDocs]);

  const activeDoc = documents.find((d) => d.id === activeDocId) || documents[0];

  /** Snapshot the active document before something destructive happens to it. */
  const snapshot = useCallback(
    async (reason: VersionReason) => {
      const doc = docsRef.current.find((d) => d.id === activeIdRef.current);
      if (!doc || !editor) return;
      await snapshotNow(doc.id, doc.title, doc.html, editor.getText(), reason);
    },
    [editor]
  );

  // Adopt the merged union from the Mac into local state and the editor.
  const adoptDocs = useCallback(
    (raw: string) => {
      if (!editor) return;
      const { items, deleted } = parseSyncList<Doc>(raw);
      if (!items.length) return;
      setDeletedDocs(deleted);
      setDocuments(items);
      const active = items.find((d) => d.id === activeIdRef.current) || items[0];
      setActiveDocId(active.id);
      const html = active.html || "";
      // Only reset the editor when the content actually differs, so a sync
      // landing mid-sentence doesn't move the caret or clobber a local edit.
      if (html !== editor.getHTML()) editor.commands.setContent(html, false);
    },
    [editor]
  );

  // Push this device's documents and adopt the merged union back. The same call
  // seeds the store on first load and pulls the other device's edits later —
  // one merge path, so neither direction can lose data.
  const syncDocs = useCallback(async () => {
    try {
      const merged = await remoteStoreMerge(
        DOCS_KEY,
        JSON.stringify({ items: docsRef.current, deleted: deletedRef.current })
      );
      adoptDocs(merged);
    } catch (e) {
      // Offline or no server — local work continues; the next sync reconciles.
      logError("docs.sync", e);
    }
  }, [adoptDocs]);

  // Initial load, and registration as a sync source for every later sync.
  useEffect(() => {
    if (!editor) return;
    const unregister = registerSyncSource("documents", syncDocs);
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      syncDocs().finally(() => {
        loadedRef.current = true;
      });
    }
    return unregister;
  }, [editor, syncDocs]);

  /** Record an edit from the editor, deriving the title and snapshotting on cadence. */
  const recordEdit = useCallback(
    (html: string, text: string) => {
      const id = activeIdRef.current;
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === id
            ? {
                ...d,
                html,
                title: d.titleManual ? d.title : docTitle(text),
                updatedAt: Date.now(),
              }
            : d
        )
      );
      const title = docsRef.current.find((d) => d.id === id)?.title ?? "Untitled";
      void maybeAutoSnapshot(id, title, html, text);
    },
    []
  );

  const switchDoc = useCallback(
    (id: string) => {
      if (id === activeDocId) return;
      const d = documents.find((x) => x.id === id);
      setActiveDocId(id);
      editor?.commands.setContent(d?.html || "", false); // false = don't emit onUpdate
      editor?.commands.focus("end");
    },
    [activeDocId, documents, editor]
  );

  const newDoc = useCallback(() => {
    const d = blankDoc();
    setDocuments((prev) => [d, ...prev]);
    setActiveDocId(d.id);
    editor?.commands.setContent("", false);
    editor?.commands.focus("end");
    return d.id;
  }, [editor]);

  const deleteDoc = useCallback(
    (id: string) => {
      // Tombstone so the delete propagates and isn't resurrected by a sync.
      setDeletedDocs((prev) => ({ ...prev, [id]: Date.now() }));
      void clearVersions(id);
      const next = documents.filter((d) => d.id !== id);
      const docs = next.length ? next : [blankDoc()];
      setDocuments(docs);
      if (id === activeDocId) {
        setActiveDocId(docs[0].id);
        editor?.commands.setContent(docs[0].html || "", false);
      }
    },
    [activeDocId, documents, editor]
  );

  const renameDoc = useCallback((id: string, title: string) => {
    setDocuments((prev) =>
      prev.map((d) =>
        d.id === id ? { ...d, title, titleManual: true, updatedAt: Date.now() } : d
      )
    );
  }, []);

  const updateActive = useCallback((patch: Partial<Doc>) => {
    const id = activeIdRef.current;
    setDocuments((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d))
    );
  }, []);

  /** Replace the active document's text with an older version, keeping the current one. */
  const restoreVersion = useCallback(
    async (html: string) => {
      if (!editor) return;
      await snapshot("restore"); // the restore itself stays undoable
      editor.commands.setContent(html, false);
      updateActive({ html });
      editor.commands.focus("end");
    },
    [editor, snapshot, updateActive]
  );

  return {
    documents,
    activeDoc,
    activeDocId,
    activeBible: activeDoc?.bible || EMPTY_BIBLE,
    activeDocIdRef: activeIdRef,
    docsRef,
    setActiveDocId,
    recordEdit,
    switchDoc,
    newDoc,
    deleteDoc,
    renameDoc,
    updateActive,
    snapshot,
    restoreVersion,
    syncDocs,
  };
}
