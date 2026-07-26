// App shell: the sidebar, the four sections, and the wiring between them.
//
// Everything with its own subject matter now lives elsewhere — documents and
// their sync in hooks/useDocuments, AI writing in hooks/useWriting, settings
// hydration in hooks/useAppSettings, the writing surface in features/write.
// What's left here is genuinely about the shell.

import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { listOllamaModels } from "./lib/api";
import { buildImagePromptMessages, type StoryBibleData } from "./lib/presets";
import { resolveTextProvider } from "./lib/settings";
import { chatCompletion } from "./lib/agent";
import { buildExtractionMessages, parseExtraction, type Extraction } from "./lib/extract";
import { useOpenrouterModels } from "./lib/openrouterModels";
import { isTauri, invokeCmd } from "./lib/transport";
import { syncAll } from "./lib/syncBus";
import { useToast } from "./lib/toast";
import { checkForUpdate } from "./lib/updater";
import { logError } from "./lib/log";
import { useAppSettings } from "./hooks/useAppSettings";
import { useDocuments } from "./hooks/useDocuments";
import { useShortcuts } from "./hooks/useShortcuts";
import { useWorkspaceSync } from "./hooks/useWorkspaceSync";
import { useWriting } from "./hooks/useWriting";
import WriteView from "./features/write/WriteView";
import Terminal from "./components/Terminal";
import SettingsModal from "./components/SettingsModal";
import RemoteApprovalListener from "./components/RemoteApprovalListener";
import StorageWarning from "./components/StorageWarning";
import ImagePanel from "./components/ImagePanel";
import Chat from "./components/Chat";
import ModelManager from "./components/ModelManager";
import Onboarding from "./components/Onboarding";
import "./styles/index.css";

const ICON_STROKE = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type ViewKey = "chat" | "write" | "images" | "terminal";

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
  {
    key: "terminal",
    label: "Terminal",
    icon: (
      <svg viewBox="0 0 24 24" {...ICON_STROKE}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9l3 3-3 3" />
        <path d="M13 15h4" />
      </svg>
    ),
  },
];

export default function App() {
  const { error: toastError, success: toastSuccess } = useToast();
  const { settings, update: updateSettings, hydrated, needsOnboarding, dismissOnboarding, adoptRemote } =
    useAppSettings();

  const [view, setView] = useState<ViewKey>(
    () => (localStorage.getItem("ai-studio.view") as ViewKey) || "chat"
  );
  const [showSettings, setShowSettings] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile nav drawer
  const [sidebarSlot, setSidebarSlot] = useState<HTMLDivElement | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [imagePrefill, setImagePrefill] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);

  // The editor is created before the hooks that handle its updates, so the
  // callback goes through a ref rather than capturing them directly.
  const onEditorUpdate = useRef<(html: string, text: string) => void>(() => {});
  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: "Begin writing here…" })],
    autofocus: "end",
    onUpdate: ({ editor }) => onEditorUpdate.current(editor.getHTML(), editor.getText()),
  });

  const docs = useDocuments(editor);

  // Seed the editor once the library has loaded (the editor mounts empty).
  const seeded = useRef(false);
  useEffect(() => {
    if (!editor || seeded.current || !docs.activeDoc) return;
    seeded.current = true;
    editor.commands.setContent(docs.activeDoc.html || "", false);
  }, [editor, docs.activeDoc]);

  const provider = useMemo(() => resolveTextProvider(settings), [settings]);
  const { models: orModels, refresh: refreshOR } = useOpenrouterModels(settings.openrouterKey);

  const canGenerate = useMemo(() => {
    if (!provider.model) return false;
    if (settings.provider === "openrouter" && !settings.openrouterKey) return false;
    return true;
  }, [provider, settings]);

  const writing = useWriting({
    editor,
    settings,
    provider,
    bible: docs.activeBible,
    snapshot: docs.snapshot,
    saveSummary: (summary, summaryChars) => docs.updateActive({ summary, summaryChars }),
    storedSummary: docs.activeDoc,
    onError: toastError,
    onNeedsModel: (message) => {
      writing.setStatus(message);
      setShowSettings(true);
    },
    canGenerate,
  });

  onEditorUpdate.current = (html, text) => {
    docs.recordEdit(html, text);
    // Typing dismisses the AI accept/undo bar. The AI's own edits happen while
    // generating, so they must not clear it.
    if (!writing.generatingRef.current) writing.setLastGen(null);
  };

  // Apply the light/dark theme to the document root.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    localStorage.setItem("ai-studio.view", view);
  }, [view]);

  // Background update check (desktop only).
  useEffect(() => {
    if (!isTauri()) return;
    checkForUpdate((msg, kind) => (kind === "ready" ? toastSuccess(msg) : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pull everything on connect so a freshly-opened device lands where the other
  // one left off. Ordering is handled by the sync bus, not by timers.
  //
  // Waits for the editor because useDocuments only registers itself as a sync
  // source once the editor exists, and useEditor returns null on the first
  // render. Syncing before that would complete with the document source missing
  // — and, worse, would mark the first sync done, letting this device publish
  // its workspace pointer before it had read the other device's.
  const didInitialSync = useRef(false);
  useEffect(() => {
    if (!editor || didInitialSync.current) return;
    didInitialSync.current = true;
    void syncAll();
  }, [editor]);

  useWorkspaceSync({
    view,
    activeDocId: docs.activeDocId,
    onAdopt: (ws) => {
      if (ws.doc) docs.setActiveDocId(ws.doc);
      if (ws.view) setView(ws.view as ViewKey);
    },
  });

  // Away mode: auto-start the companion server on launch when enabled. Waits for
  // hydration so the saved pairing token is used rather than minting a new one
  // (which would silently break an already-paired phone).
  const remoteStarted = useRef(false);
  useEffect(() => {
    if (!hydrated || !isTauri() || remoteStarted.current || !settings.remoteEnabled) return;
    remoteStarted.current = true;
    let token = settings.remoteToken;
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, "");
      updateSettings({ remoteToken: token });
    }
    invokeCmd("start_remote_server", {
      port: settings.remotePort || 8787,
      token,
      wakeLock: settings.remoteWakeLock,
    }).catch((e) => logError("remote.start", e));
  }, [
    hydrated,
    settings.remoteEnabled,
    settings.remoteToken,
    settings.remotePort,
    settings.remoteWakeLock,
    updateSettings,
  ]);

  const refreshOllama = () =>
    listOllamaModels(settings.ollamaUrl)
      .then(setOllamaModels)
      .catch(() => setOllamaModels([]));
  useEffect(() => {
    refreshOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ollamaUrl]);

  async function syncNow() {
    if (syncing) return;
    setSyncing(true);
    try {
      await adoptRemote();
      await syncAll();
      toastSuccess("Synced with your other devices");
    } finally {
      setSyncing(false);
    }
  }

  useShortcuts(view, {
    setView,
    openSettings: () => setShowSettings(true),
    generate: () => void handleGenerate(),
    stop: writing.stop,
    newDoc: docs.newDoc,
    find: () => setFindOpen(true),
    toggleFocusMode: () => updateSettings({ focusMode: !settings.focusMode }),
  });

  async function handleGenerate() {
    if (!editor || writing.generating || !writing.ensureModel()) return;
    await writing.generateContinuation(prompt.trim());
    setPrompt("");
  }

  /** Story Bible auto-fill: ask the model for new characters + canon facts. */
  async function extractBible(): Promise<Extraction | null> {
    if (!editor || !writing.ensureModel()) return null;
    const text = editor.getText();
    if (!text.trim()) return null;
    try {
      const msg = await chatCompletion({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        messages: buildExtractionMessages(text, docs.activeBible),
        tools: [],
        temperature: 0.2,
      });
      return parseExtraction(msg.content ?? null);
    } catch (e) {
      logError("bible.extract", e);
      return null;
    }
  }

  /**
   * Write → Images: compose a scene-aware image prompt from the selection (or
   * recent text) plus the Story Bible, so illustrations match the prose and
   * recurring characters stay visually consistent.
   */
  async function handleIllustrate() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const passage =
      to > from ? editor.state.doc.textBetween(from, to, " ") : editor.getText().slice(-1200);
    if (!passage.trim()) {
      writing.setStatus("Write or select a scene to illustrate first.");
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
        messages: buildImagePromptMessages(passage, docs.activeBible),
        tools: [],
        temperature: 0.5,
      });
      setImagePrefill((msg.content || "").trim() || passage.slice(0, 800));
    } catch (e) {
      logError("illustrate", e);
      setImagePrefill(passage.slice(0, 800));
    }
  }

  /** Chat agent → Write: append generated prose to the active manuscript. */
  function insertIntoManuscript(text: string) {
    if (!editor || !text.trim()) return;
    const escape = (t: string) =>
      t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = text
      .split(/\n\n+/)
      .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
    editor.commands.insertContentAt(editor.state.doc.content.size, html);
  }

  const wordCount = editor ? editor.getText().trim().split(/\s+/).filter(Boolean).length : 0;

  return (
    <div className={`app${settings.focusMode && view === "write" ? " focus-mode" : ""}`}>
      <StorageWarning />

      {/* Mobile top bar: hamburger opens the sidebar */}
      <header className="mobiletopbar">
        <button className="mtb-btn" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
          <svg viewBox="0 0 24 24" {...ICON_STROKE} width="22" height="22">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <span className="mtb-title">{SECTIONS.find((s) => s.key === view)?.label}</span>
        <span className="mtb-btn" aria-hidden="true" />
      </header>

      {drawerOpen && (
        <div className="sidebar-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      )}

      {/* Unified sidebar: sections, the active view's list, and the footer.
          Persistent on desktop, an overlay drawer on mobile. */}
      <aside
        className={`sidebar${settings.sidebarCollapsed ? " collapsed" : ""}${drawerOpen ? " open" : ""}`}
        aria-label="Main navigation"
      >
        <div className="sidebar-head">
          <span className="sidebar-brand">AI Box</span>
          <button
            className="sidebar-collapse"
            title={settings.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={settings.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed })}
          >
            {settings.sidebarCollapsed ? "»" : "«"}
          </button>
        </div>

        <nav className="sidebar-sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={view === s.key ? "sidebar-sec active" : "sidebar-sec"}
              title={s.label}
              aria-current={view === s.key ? "page" : undefined}
              onClick={() => {
                setView(s.key);
                setDrawerOpen(false);
              }}
            >
              <span className="sidebar-sec-icon">{s.icon}</span>
              <span className="sidebar-sec-label">{s.label}</span>
            </button>
          ))}
        </nav>

        {/* The active view portals its list (chats / docs / images) in here. */}
        <div className="sidebar-list" ref={setSidebarSlot} />

        <div className="sidebar-foot">
          {view === "write" && <span className="navrail-count">{wordCount} words</span>}
          {view === "terminal" && (
            <div className="term-font-rail">
              <button
                className="term-font-btn"
                title="Smaller terminal text"
                aria-label="Smaller terminal text"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("ai-studio-term-font", { detail: -1 }))
                }
              >
                A−
              </button>
              <button
                className="term-font-btn"
                title="Larger terminal text"
                aria-label="Larger terminal text"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("ai-studio-term-font", { detail: 1 }))
                }
              >
                A+
              </button>
            </div>
          )}
          <button
            className="sidebar-sec"
            title="Sync chats, docs & settings with your other devices"
            onClick={syncNow}
            disabled={syncing}
          >
            <span className={`sidebar-sec-icon ${syncing ? "sync-spin" : ""}`} aria-hidden="true">
              ↻
            </span>
            <span className="sidebar-sec-label">{syncing ? "Syncing…" : "Sync devices"}</span>
          </button>
          <button className="sidebar-sec" onClick={() => setShowSettings(true)}>
            <span className="sidebar-sec-icon" aria-hidden="true">
              ⚙
            </span>
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
          <WriteView
            editor={editor}
            settings={settings}
            onChangeSettings={updateSettings}
            documents={docs.documents}
            activeDocId={docs.activeDocId}
            activeDoc={docs.activeDoc}
            onSelectDoc={docs.switchDoc}
            onNewDoc={docs.newDoc}
            onDeleteDoc={docs.deleteDoc}
            onRenameDoc={docs.renameDoc}
            onRestoreVersion={docs.restoreVersion}
            bible={docs.activeBible}
            onChangeBible={(b: StoryBibleData) => docs.updateActive({ bible: b })}
            onExtractBible={extractBible}
            generating={writing.generating}
            status={writing.status}
            prompt={prompt}
            onPromptChange={setPrompt}
            onGenerate={handleGenerate}
            onStop={writing.stop}
            onRewrite={(how) => void writing.rewriteSelection(how)}
            onRunAction={(how, review) => void writing.rewriteSelection(how, review)}
            onIllustrate={handleIllustrate}
            lastGen={writing.lastGen}
            onUndo={writing.undoLastEdit}
            onRegenerate={() => void writing.regenerate()}
            onKeep={() => writing.setLastGen(null)}
            proposal={writing.proposal}
            onApplyProposal={(t) => void writing.applyProposal(t)}
            onDiscardProposal={() => writing.setProposal(null)}
            ollamaModels={ollamaModels}
            orModels={orModels}
            onRefreshModels={() => {
              refreshOR();
              refreshOllama();
            }}
            onManageModels={() => setShowModels(true)}
            sidebarSlot={sidebarSlot}
            onCloseDrawer={() => setDrawerOpen(false)}
            findOpen={findOpen}
            onCloseFind={() => setFindOpen(false)}
          />
        ) : view === "images" ? (
          <ImagePanel
            settings={settings}
            onChange={updateSettings}
            orModels={orModels}
            prefill={imagePrefill}
            onPrefillConsumed={() => setImagePrefill(null)}
            sidebarSlot={sidebarSlot}
            onCloseDrawer={() => setDrawerOpen(false)}
          />
        ) : (
          <Terminal sidebarSlot={sidebarSlot} onCloseDrawer={() => setDrawerOpen(false)} />
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

      {needsOnboarding && (
        <Onboarding
          settings={settings}
          onChange={updateSettings}
          onOpenModels={() => {
            setView("chat");
            dismissOnboarding();
          }}
          onClose={dismissOnboarding}
        />
      )}

      <RemoteApprovalListener autoApprove={settings.autoApproveTools} />
    </div>
  );
}
