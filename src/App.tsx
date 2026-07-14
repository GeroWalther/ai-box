import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, BubbleMenu } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { generateText, listOllamaModels } from "./lib/api";
import {
  buildContinuationMessages,
  buildRewriteMessages,
  buildImagePromptMessages,
  EMPTY_BIBLE,
  LANGUAGES,
  type StoryBibleData,
} from "./lib/presets";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSecrets,
  saveSecrets,
  resolveTextProvider,
  saveSettings,
  type Settings,
} from "./lib/settings";
import { chatCompletion } from "./lib/agent";
import { buildExtractionMessages, parseExtraction, type Extraction } from "./lib/extract";
import { useOpenrouterModels } from "./lib/openrouterModels";
import { isTauri, invokeCmd, cancelStream } from "./lib/transport";
import { remoteStoreMerge } from "./lib/remoteStore";
import { parseSyncList } from "./lib/syncList";
import { useToast } from "./lib/toast";
import PromptBar from "./components/PromptBar";
import SettingsModal from "./components/SettingsModal";
import RemoteApprovalListener from "./components/RemoteApprovalListener";
import ImagePanel from "./components/ImagePanel";
import Chat from "./components/Chat";
import ModelSelect from "./components/ModelSelect";
import WritingPresets from "./components/WritingPresets";
import SidebarList, { SidebarSlot } from "./components/SidebarList";
import StoryBible from "./components/StoryBible";
import ExportMenu from "./components/ExportMenu";
import WritingSettings from "./components/WritingSettings";
import ModelManager from "./components/ModelManager";
import Onboarding from "./components/Onboarding";
import "./App.css";

const DOCS_KEY = "ai-studio.documents";
const DOCS_DEL_KEY = "ai-studio.documents.deleted";
const LEGACY_DOC_KEY = "novel-studio.document";

function loadDeletedDocs(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(DOCS_DEL_KEY) || "null");
    if (v && typeof v === "object") return v;
  } catch {
    /* ignore */
  }
  return {};
}

interface Doc {
  id: string;
  title: string;
  html: string;
  bible?: StoryBibleData;
  /** Last-edit timestamp (ms) used to merge concurrent desktop/phone edits. */
  updatedAt?: number;
}

function docTitle(text: string): string {
  const line = text
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  return line ? line.slice(0, 40) : "Untitled";
}

function loadDocs(): Doc[] {
  try {
    const arr = JSON.parse(localStorage.getItem(DOCS_KEY) || "null");
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {
    /* fall through to migration */
  }
  const legacy = localStorage.getItem(LEGACY_DOC_KEY) || "";
  return [{ id: crypto.randomUUID(), title: "Untitled", html: legacy }];
}

function escapeText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Desktop only: publish the current settings so a paired phone can adopt them. */
function pushRemoteSettings(s: Settings): void {
  if (!isTauri()) return;
  invokeCmd("set_remote_settings", { settings: JSON.stringify(s) }).catch(() => {});
}

const ICON_STROKE = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type ViewKey = "chat" | "write" | "images";
const SECTIONS: { key: ViewKey; label: string; icon: React.ReactNode }[] = [
  {
    key: "chat",
    label: "Agentic Chat",
    icon: (
      <svg viewBox="0 0 24 24" {...ICON_STROKE}>
        <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
      </svg>
    ),
  },
  {
    key: "write",
    label: "Write",
    icon: (
      <svg viewBox="0 0 24 24" {...ICON_STROKE}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
      </svg>
    ),
  },
  {
    key: "images",
    label: "Images",
    icon: (
      <svg viewBox="0 0 24 24" {...ICON_STROKE}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    ),
  },
];

export default function App() {
  const { error: toastError, success: toastSuccess } = useToast();
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile nav drawer
  const [sidebarSlot, setSidebarSlot] = useState<HTMLDivElement | null>(null); // list portal target
  const [view, setView] = useState<"chat" | "write" | "images">("chat");
  const [imagePrefill, setImagePrefill] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rewriteHow, setRewriteHow] = useState("");
  const [bibleOpen, setBibleOpen] = useState(false);
  const [writeToolsOpen, setWriteToolsOpen] = useState(false); // mobile: collapse the model/preset toolbar
  const [lastGen, setLastGen] = useState<
    { from: number; to: number; instruction: string } | null
  >(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [documents, setDocuments] = useState<Doc[]>(loadDocs);
  const [activeDocId, setActiveDocId] = useState<string>("");
  const stoppedRef = useRef(false);
  const requestIdRef = useRef(""); // id of the in-flight generation, for server-side cancel
  const activeDocIdRef = useRef("");
  const [deletedDocs, setDeletedDocs] = useState<Record<string, number>>(loadDeletedDocs);
  const docsRef = useRef(documents); // latest docs for async saves
  const deletedRef = useRef(deletedDocs); // latest tombstones for async saves
  const docsFetchedRef = useRef(false); // shared docs load kicked off
  const docsLoadedRef = useRef(false); // shared docs loaded — safe to write back
  const didHydrateRef = useRef(false); // one-time init guard (StrictMode double-invoke)
  useEffect(() => {
    docsRef.current = documents;
  }, [documents]);
  useEffect(() => {
    deletedRef.current = deletedDocs;
  }, [deletedDocs]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Begin your story here…",
      }),
    ],
    content: documents[0]?.html || "",
    autofocus: "end",
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      const title = docTitle(editor.getText());
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === activeDocIdRef.current ? { ...d, html, title, updatedAt: Date.now() } : d
        )
      );
    },
  });

  useEffect(() => {
    // React StrictMode invokes effects twice in dev; hydrating (and thus reading
    // secrets) once is enough — the guard also avoids duplicate keychain reads.
    if (didHydrateRef.current) return;
    didHydrateRef.current = true;
    const loaded = loadSettings();
    setSettings(loaded);
    if (!loaded.onboarded) setShowOnboarding(true);
    if (isTauri()) {
      // Desktop: hydrate API keys from the OS keychain (migrating any legacy key
      // still in localStorage), scrub the plaintext copy, then publish settings so
      // a paired phone can adopt them (and the Mac can inject the key server-side).
      (async () => {
        const secrets = await loadSecrets();
        const migrated: Partial<Settings> = {};
        for (const k of ["openrouterKey", "customKey"] as const) {
          if (!secrets[k] && loaded[k]) migrated[k] = loaded[k]; // legacy localStorage → keychain
        }
        const hydrated = { ...loaded, ...secrets, ...migrated };
        if (Object.keys(migrated).length) await saveSecrets(hydrated);
        saveSettings(hydrated); // rewrites localStorage without the keys
        setSettings(hydrated);
        pushRemoteSettings(hydrated);
      })();
    } else {
      // Phone: adopt the desktop's settings (API key, model, options) instead of
      // this device's empty defaults, so it "just works" with what's set up on the Mac.
      invokeCmd<Partial<Settings> | null>("get_remote_settings")
        .then((remote) => {
          if (remote && typeof remote === "object") {
            setSettings((prev) => {
              const merged = { ...prev, ...remote };
              saveSettings(merged);
              return merged;
            });
          }
        })
        .catch(() => {});
    }
  }, []);

  // Apply the light/dark theme to the document root.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  // Keep a valid active document and persist the set.
  useEffect(() => {
    if (!documents.find((d) => d.id === activeDocId)) setActiveDocId(documents[0].id);
  }, [documents, activeDocId]);
  useEffect(() => {
    activeDocIdRef.current = activeDocId;
  }, [activeDocId]);
  useEffect(() => {
    localStorage.setItem(DOCS_KEY, JSON.stringify(documents));
    localStorage.setItem(DOCS_DEL_KEY, JSON.stringify(deletedDocs));
    // Mirror Write documents to the shared store on the Mac (debounced so typing
    // doesn't hammer the file). A conflict-free MERGE — not an overwrite — so a
    // concurrent edit on the other device is never clobbered.
    if (!docsLoadedRef.current) return;
    const t = setTimeout(() => {
      remoteStoreMerge(
        DOCS_KEY,
        JSON.stringify({ items: docsRef.current, deleted: deletedRef.current })
      ).catch(() => {});
    }, 700);
    return () => clearTimeout(t);
  }, [documents, deletedDocs]);

  // Adopt the merged union (from store_merge_list) into local state + the editor.
  function adoptDocs(raw: string) {
    if (!editor) return;
    const { items, deleted } = parseSyncList<Doc>(raw);
    if (!items.length) return;
    setDeletedDocs(deleted);
    setDocuments(items);
    const active = items.find((d) => d.id === activeDocIdRef.current) || items[0];
    setActiveDocId(active.id);
    const html = active.html || "";
    // Only reset the editor if the active doc's content actually differs, so an
    // in-progress edit (newer locally) isn't clobbered by a background sync.
    if (html !== editor.getHTML()) editor.commands.setContent(html, false);
  }

  // Push this device's documents and adopt the merged union back. Used for both the
  // initial load (seeds the store) and manual Sync (pulls the other device's edits)
  // — the same merge guarantees neither direction loses data.
  async function syncDocs() {
    try {
      const merged = await remoteStoreMerge(
        DOCS_KEY,
        JSON.stringify({ items: docsRef.current, deleted: deletedRef.current })
      );
      adoptDocs(merged);
    } catch {
      /* offline / no server — keep working locally */
    }
  }

  // Load + merge shared Write documents once the editor is ready.
  useEffect(() => {
    if (!editor || docsFetchedRef.current) return;
    docsFetchedRef.current = true;
    let cancelled = false;
    syncDocs().finally(() => {
      if (!cancelled) docsLoadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Re-sync shared documents when the user taps Sync (nav rail).
  useEffect(() => {
    function onSync() {
      syncDocs();
    }
    window.addEventListener("ai-studio-sync", onSync);
    return () => window.removeEventListener("ai-studio-sync", onSync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  function switchDoc(id: string) {
    if (id === activeDocId) return;
    const d = documents.find((x) => x.id === id);
    setActiveDocId(id);
    setLastGen(null);
    editor?.commands.setContent(d?.html || "", false); // false = don't emit onUpdate
    editor?.commands.focus("end");
  }
  function newDoc() {
    const d: Doc = { id: crypto.randomUUID(), title: "Untitled", html: "", updatedAt: Date.now() };
    setDocuments((prev) => [d, ...prev]);
    setActiveDocId(d.id);
    setLastGen(null);
    editor?.commands.setContent("", false);
    editor?.commands.focus("end");
  }
  function deleteDoc(id: string) {
    // Record a tombstone so the delete propagates and isn't resurrected on sync.
    setDeletedDocs((prev) => ({ ...prev, [id]: Date.now() }));
    const next = documents.filter((d) => d.id !== id);
    const docs = next.length
      ? next
      : [{ id: crypto.randomUUID(), title: "Untitled", html: "", updatedAt: Date.now() }];
    setDocuments(docs);
    if (id === activeDocId) {
      setActiveDocId(docs[0].id);
      editor?.commands.setContent(docs[0].html || "", false);
    }
  }

  const updateSettings = (patch: Partial<Settings>) =>
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      pushRemoteSettings(next);
      // Persist API keys to the keychain only when they actually change.
      if ("openrouterKey" in patch || "customKey" in patch) saveSecrets(next);
      return next;
    });

  // Pull the latest shared state (chat history + desktop settings) from the Mac.
  // Tabs listen for the "ai-studio-sync" event to re-read their own data.
  async function syncNow() {
    if (syncing) return;
    setSyncing(true);
    try {
      if (!isTauri()) {
        const remote = await invokeCmd<Partial<Settings> | null>("get_remote_settings").catch(
          () => null
        );
        if (remote && typeof remote === "object") {
          setSettings((prev) => {
            const merged = { ...prev, ...remote };
            saveSettings(merged);
            return merged;
          });
        }
      }
      window.dispatchEvent(new Event("ai-studio-sync"));
      toastSuccess("Synced with your other devices");
    } finally {
      setSyncing(false);
    }
  }

  const activeDoc = documents.find((d) => d.id === activeDocId) || documents[0];
  const activeBible = activeDoc?.bible || EMPTY_BIBLE;
  function updateBible(b: StoryBibleData) {
    setDocuments((prev) =>
      prev.map((d) => (d.id === activeDocId ? { ...d, bible: b, updatedAt: Date.now() } : d))
    );
  }

  const refreshOllama = () =>
    listOllamaModels(settings.ollamaUrl)
      .then(setOllamaModels)
      .catch(() => setOllamaModels([]));
  useEffect(() => {
    refreshOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ollamaUrl]);

  const provider = useMemo(() => resolveTextProvider(settings), [settings]);
  const {
    models: orModels,
    refresh: refreshOR,
  } = useOpenrouterModels(settings.openrouterKey);

  const canGenerate = useMemo(() => {
    if (!provider.model) return false;
    if (settings.provider === "openrouter" && !settings.openrouterKey) return false;
    return true;
  }, [provider, settings]);

  // Insert a streamed chunk, turning newlines into real paragraph blocks.
  function insertChunk(token: string, nlRef: { current: boolean }) {
    if (!editor) return;
    token.split("\n").forEach((seg, i) => {
      if (i > 0) {
        if (!nlRef.current) editor.commands.splitBlock();
        nlRef.current = true;
      }
      if (seg.length) {
        editor.commands.insertContent(escapeText(seg));
        nlRef.current = false;
      }
    });
  }

  function ensureModel(): boolean {
    if (canGenerate) return true;
    setStatus(
      settings.provider === "openrouter" && !settings.openrouterKey
        ? "Add your OpenRouter API key in Settings first."
        : "Pick a model in Settings first."
    );
    setShowSettings(true);
    return false;
  }

  // Story Bible auto-fill: ask the model for new characters + canon facts in the
  // current manuscript. Returns null if there's no model/text or the call fails.
  async function extractBible(): Promise<Extraction | null> {
    if (!editor || !ensureModel()) return null;
    const text = editor.getText();
    if (!text.trim()) return null;
    try {
      const msg = await chatCompletion({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        messages: buildExtractionMessages(text, activeBible),
        tools: [],
        temperature: 0.2,
      });
      return parseExtraction(msg.content ?? null);
    } catch {
      return null;
    }
  }

  // Core continuation: append a passage from `instruction` (empty = free
  // continue), recording its inserted range so it can be regenerated.
  async function generateContinuation(instruction: string) {
    if (!editor) return;
    stoppedRef.current = false;
    setGenerating(true);
    setStatus(instruction ? "Writing…" : "Continuing…");

    const storyText = editor.getText();
    const messages = buildContinuationMessages(
      storyText,
      settings,
      { wordTarget: settings.wordTarget, instruction },
      activeBible
    );

    editor.commands.focus("end");
    const nlRef = { current: false };
    if (instruction && storyText.trim().length) {
      editor.commands.splitBlock(); // new passage starts its own paragraph
      nlRef.current = true;
    } else if (!/\s$/.test(storyText) && storyText.length) {
      editor.commands.insertContent(" ");
    }

    const startPos = editor.state.selection.to;
    await stream(messages, settings.maxTokens, nlRef, provider);
    const endPos = editor.state.selection.to;
    if (endPos > startPos) setLastGen({ from: startPos, to: endPos, instruction });
  }

  // Prompt bar: write a passage from the instruction (empty = continue).
  async function handleGenerate() {
    if (!editor || generating || !ensureModel()) return;
    await generateContinuation(prompt.trim());
    setPrompt("");
  }

  // Delete the last AI passage and write a fresh one from the same instruction.
  async function handleRegenerate() {
    if (!editor || generating || !lastGen || !ensureModel()) return;
    const size = editor.state.doc.content.size;
    const to = Math.min(lastGen.to, size);
    editor.chain().focus().setTextSelection({ from: lastGen.from, to }).deleteSelection().run();
    await generateContinuation(lastGen.instruction);
  }

  // Bubble menu: rewrite the current selection in place. howOverride lets
  // quick-action buttons (Expand, Shorten, …) reuse this path.
  async function handleRewrite(howOverride?: string) {
    if (!editor || generating || !ensureModel()) return;
    const { from, to } = editor.state.selection;
    if (to <= from) return;

    const how = howOverride ?? rewriteHow;
    const passage = editor.state.doc.textBetween(from, to, "\n");
    const before = editor.state.doc.textBetween(0, from, "\n");
    const messages = buildRewriteMessages(before, passage, how, settings, activeBible);

    stoppedRef.current = false;
    setGenerating(true);
    setStatus("Rewriting…");
    editor.chain().focus().deleteSelection().run();
    const nlRef = { current: false };
    await stream(messages, Math.max(settings.maxTokens, 600), nlRef, provider);
    setRewriteHow("");
  }

  // Quick selection actions map to preset rewrite directions.
  const QUICK_ACTIONS: { label: string; how: string }[] = [
    { label: "Expand", how: "Expand this passage with more detail, sensory texture, and beats, staying in the same voice — roughly double the length." },
    { label: "Shorten", how: "Tighten this passage — cut redundancy and keep only the strongest lines, preserving meaning and voice." },
    { label: "Rephrase", how: "Rephrase this passage in fresh words while keeping the same meaning, length, and voice." },
    { label: "Describe", how: "Make this passage more vivid — heighten imagery, sensory detail, and atmosphere without changing events." },
    { label: "To dialogue", how: "Rework this passage to foreground natural, character-revealing dialogue with light beats." },
  ];

  // Shared streaming runner. Pass the resolved provider to route the request.
  async function stream(
    messages: ReturnType<typeof buildContinuationMessages>,
    maxTokens: number,
    nlRef: { current: boolean },
    which: { baseUrl: string; apiKey: string; model: string } = provider
  ) {
    const requestId = crypto.randomUUID();
    requestIdRef.current = requestId;
    try {
      await generateText(
        {
          baseUrl: which.baseUrl,
          apiKey: which.apiKey,
          model: which.model,
          messages,
          temperature: settings.temperature,
          maxTokens,
        },
        {
          onToken: (t) => {
            if (!stoppedRef.current) insertChunk(t, nlRef);
          },
          onDone: () => {
            setGenerating(false);
            setStatus("");
          },
          onError: (msg) => {
            setGenerating(false);
            setStatus("");
            toastError(msg);
          },
        },
        requestId
      );
    } catch (e) {
      setGenerating(false);
      setStatus("");
      toastError(String(e));
    }
  }

  function handleStop() {
    stoppedRef.current = true;
    // Abort server-side so the model stops generating (and billing), not just the UI.
    if (requestIdRef.current) cancelStream(requestIdRef.current);
    setGenerating(false);
    setStatus("");
  }

  // Write → Images: compose a scene-aware image prompt from the selected passage
  // (or recent text) plus the Story Bible, so illustrations match the prose and
  // recurring characters stay visually consistent. Falls back to raw prose if no
  // model is configured.
  async function handleIllustrate() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const passage =
      to > from ? editor.state.doc.textBetween(from, to, " ") : editor.getText().slice(-1200);
    if (!passage.trim()) {
      setStatus("Write or select a scene to illustrate first.");
      return;
    }
    setView("images");
    if (!canGenerate) {
      setImagePrefill(passage.slice(0, 800));
      return;
    }
    setImagePrefill(null);
    try {
      const msg = await chatCompletion({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        messages: buildImagePromptMessages(passage, activeBible),
        tools: [],
        temperature: 0.5,
      });
      const composed = (msg.content || "").trim();
      setImagePrefill(composed || passage.slice(0, 800));
    } catch {
      setImagePrefill(passage.slice(0, 800));
    }
  }

  // Chat agent → Write: append generated prose to the active manuscript.
  function insertIntoManuscript(text: string) {
    if (!editor || !text.trim()) return;
    const end = editor.state.doc.content.size;
    const html = text
      .split(/\n\n+/)
      .map((p) => `<p>${escapeText(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
    editor.commands.insertContentAt(end, html);
  }

  // Global keyboard shortcuts. A ref holds the latest handlers so the listener
  // (bound once) never fires a stale closure.
  const viewRef = useRef(view);
  viewRef.current = view;
  const kbdRef = useRef({ generate: () => {}, stop: () => {}, newDoc: () => {} });
  kbdRef.current = { generate: handleGenerate, stop: handleStop, newDoc };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "1") { e.preventDefault(); setView("chat"); return; }
      if (mod && e.key === "2") { e.preventDefault(); setView("write"); return; }
      if (mod && e.key === "3") { e.preventDefault(); setView("images"); return; }
      if (mod && e.key === ",") { e.preventDefault(); setShowSettings(true); return; }
      if (viewRef.current === "write") {
        if (mod && e.key === "Enter") { e.preventDefault(); kbdRef.current.generate(); }
        else if (e.key === "Escape") { kbdRef.current.stop(); }
        else if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); kbdRef.current.newDoc(); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const wordCount = editor
    ? editor.getText().trim().split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div className="app">
      {/* Mobile top bar: hamburger opens the sidebar */}
      <header className="mobiletopbar">
        <button className="mtb-btn" aria-label="Menu" onClick={() => setDrawerOpen(true)}>
          <svg viewBox="0 0 24 24" {...ICON_STROKE} width="22" height="22">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <span className="mtb-title">{SECTIONS.find((s) => s.key === view)?.label}</span>
        <button className="mtb-btn" aria-label="Sync" onClick={syncNow} disabled={syncing}>
          <span className={syncing ? "sync-spin" : ""} style={{ fontSize: 18 }}>↻</span>
        </button>
      </header>

      {/* Backdrop behind the mobile drawer */}
      {drawerOpen && <div className="sidebar-backdrop" onClick={() => setDrawerOpen(false)} />}

      {/* Unified sidebar: sections + the active view's list + footer.
          Persistent on desktop, an overlay drawer on mobile. */}
      <aside
        className={`sidebar${settings.sidebarCollapsed ? " collapsed" : ""}${drawerOpen ? " open" : ""}`}
      >
        <div className="sidebar-head">
          <span className="sidebar-brand">AI Studio</span>
          <button
            className="sidebar-collapse"
            title={settings.sidebarCollapsed ? "Expand" : "Collapse"}
            onClick={() => updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed })}
          >
            {settings.sidebarCollapsed ? "»" : "«"}
          </button>
        </div>
        <div className="sidebar-sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={view === s.key ? "sidebar-sec active" : "sidebar-sec"}
              title={s.label}
              onClick={() => {
                setView(s.key);
                setDrawerOpen(false);
              }}
            >
              <span className="sidebar-sec-icon">{s.icon}</span>
              <span className="sidebar-sec-label">{s.label}</span>
            </button>
          ))}
        </div>
        {/* Active view portals its list (chats / docs / images) in here. */}
        <div className="sidebar-list" ref={setSidebarSlot} />
        <div className="sidebar-foot">
          {view === "write" && <span className="navrail-count">{wordCount} words</span>}
          <button
            className="sidebar-sec"
            title="Sync chats, docs & settings with your other devices"
            onClick={syncNow}
            disabled={syncing}
          >
            <span className={`sidebar-sec-icon ${syncing ? "sync-spin" : ""}`}>↻</span>
            <span className="sidebar-sec-label">Sync devices</span>
          </button>
          <button className="sidebar-sec" onClick={() => setShowSettings(true)}>
            <span className="sidebar-sec-icon">⚙</span>
            <span className="sidebar-sec-label">Settings</span>
          </button>
        </div>
      </aside>

      <main className="main">
      {view === "chat" ? (
        <Chat
          settings={settings}
          onChange={updateSettings}
          onOpenSettings={() => setShowSettings(true)}
          onInsertManuscript={insertIntoManuscript}
          sidebarSlot={sidebarSlot}
          onCloseDrawer={() => setDrawerOpen(false)}
        />
      ) : view === "write" ? (
        <div className="write-layout">
          <SidebarSlot slot={sidebarSlot}>
            <SidebarList
              items={documents}
              activeId={activeDocId}
              onSelect={switchDoc}
              onNew={newDoc}
              onDelete={deleteDoc}
              newLabel="+ New document"
              onAfterAction={() => setDrawerOpen(false)}
            />
          </SidebarSlot>
          <div className="write-view">
          <div className="write-topbar">
            {/* Mobile-only: collapse the controls behind a single toggle so the
                canvas isn't crowded. Hidden on desktop (CSS). */}
            <button
              className="write-tools-toggle"
              onClick={() => setWriteToolsOpen((v) => !v)}
              aria-expanded={writeToolsOpen}
              title="Model, preset, language & export"
            >
              Model &amp; options {writeToolsOpen ? "▲" : "▾"}
            </button>
            <div className={writeToolsOpen ? "write-tools open" : "write-tools"}>
              <ModelSelect
                settings={settings}
                ollamaModels={ollamaModels}
                orModels={orModels}
                onChange={updateSettings}
                onRefresh={() => {
                  refreshOR();
                  refreshOllama();
                }}
                onManageModels={() => setShowModels(true)}
              />
              <WritingPresets settings={settings} onChange={updateSettings} />
              <select
                className="lang-select"
                title="Output language"
                value={settings.language}
                onChange={(e) => updateSettings({ language: e.target.value })}
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l === "auto" ? "Auto" : l}
                  </option>
                ))}
              </select>
              <div className="topbar-spacer" />
              {lastGen && !generating && (
                <button className="btn ghost" title="Regenerate the last AI passage" onClick={handleRegenerate}>
                  Regenerate
                </button>
              )}
              <button
                className={bibleOpen ? "btn ghost active" : "btn ghost"}
                title="Story Bible — characters, world & canon for this document"
                onClick={() => setBibleOpen((v) => !v)}
              >
                Story Bible
              </button>
              <WritingSettings settings={settings} onChange={updateSettings} />
              <ExportMenu
                title={activeDoc?.title || "manuscript"}
                getText={() => editor?.getText() ?? ""}
                getHTML={() => editor?.getHTML() ?? ""}
              />
            </div>
          </div>
          <div className="editor-scroll">
            <EditorContent editor={editor} className="prose" />
            {editor && (
              <BubbleMenu
                editor={editor}
                shouldShow={({ from, to }) => to > from && !generating}
                tippyOptions={{ duration: 100, placement: "top" }}
              >
                <div className="bubble">
                  <div className="bubble-actions">
                    {QUICK_ACTIONS.map((a) => (
                      <button
                        key={a.label}
                        className="bubble-quick"
                        title={a.how}
                        onClick={() => handleRewrite(a.how)}
                      >
                        {a.label}
                      </button>
                    ))}
                    <button
                      className="bubble-quick"
                      title="Generate an image from this scene in the Images tab"
                      onClick={handleIllustrate}
                    >
                      🎨 Illustrate
                    </button>
                  </div>
                  <div className="bubble-row">
                    <input
                      className="bubble-input"
                      placeholder="rewrite how…"
                      value={rewriteHow}
                      onChange={(e) => setRewriteHow(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleRewrite();
                        }
                      }}
                    />
                    <button className="btn primary bubble-btn" onClick={() => handleRewrite()}>
                      Rewrite
                    </button>
                  </div>
                </div>
              </BubbleMenu>
            )}
          </div>

          <PromptBar
            value={prompt}
            onChange={setPrompt}
            onSubmit={handleGenerate}
            onStop={handleStop}
            generating={generating}
            status={status}
          />
          </div>
          <StoryBible
            bible={activeBible}
            onChange={updateBible}
            open={bibleOpen}
            onToggle={() => setBibleOpen((v) => !v)}
            storyText={editor?.getText() ?? ""}
            onExtract={extractBible}
          />
        </div>
      ) : (
        <ImagePanel
          settings={settings}
          onChange={updateSettings}
          orModels={orModels}
          prefill={imagePrefill}
          onPrefillConsumed={() => setImagePrefill(null)}
          sidebarSlot={sidebarSlot}
          onCloseDrawer={() => setDrawerOpen(false)}
        />
      )}
      </main>

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showModels && (
        <ModelManager
          settings={settings}
          installed={ollamaModels}
          onClose={() => setShowModels(false)}
          onChanged={refreshOllama}
        />
      )}

      {showOnboarding && (
        <Onboarding
          settings={settings}
          onChange={updateSettings}
          onOpenModels={() => {
            setView("chat");
            setShowOnboarding(false);
          }}
          onClose={() => setShowOnboarding(false)}
        />
      )}

      <RemoteApprovalListener autoApprove={settings.autoApproveTools} />
    </div>
  );
}
