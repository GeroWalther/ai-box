import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, BubbleMenu } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { generateText, listOllamaModels } from "./lib/api";
import {
  buildContinuationMessages,
  buildRewriteMessages,
} from "./lib/presets";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  resolveTextProvider,
  saveSettings,
  type Settings,
} from "./lib/settings";
import { useOpenrouterModels } from "./lib/openrouterModels";
import PromptBar from "./components/PromptBar";
import SettingsModal from "./components/SettingsModal";
import ImagePanel from "./components/ImagePanel";
import Chat from "./components/Chat";
import ModelSelect from "./components/ModelSelect";
import SessionSidebar from "./components/SessionSidebar";
import "./App.css";

const DOCS_KEY = "ai-studio.documents";
const LEGACY_DOC_KEY = "novel-studio.document";

interface Doc {
  id: string;
  title: string;
  html: string;
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

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<"chat" | "write" | "images">("chat");
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rewriteHow, setRewriteHow] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [documents, setDocuments] = useState<Doc[]>(loadDocs);
  const [activeDocId, setActiveDocId] = useState<string>("");
  const stoppedRef = useRef(false);
  const activeDocIdRef = useRef("");

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder:
          "Write an opening line, or just tell the AI what to write in the bar below…",
      }),
    ],
    content: documents[0]?.html || "",
    autofocus: "end",
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      const title = docTitle(editor.getText());
      setDocuments((prev) =>
        prev.map((d) => (d.id === activeDocIdRef.current ? { ...d, html, title } : d))
      );
    },
  });

  useEffect(() => setSettings(loadSettings()), []);

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
  }, [documents]);

  function switchDoc(id: string) {
    if (id === activeDocId) return;
    const d = documents.find((x) => x.id === id);
    setActiveDocId(id);
    editor?.commands.setContent(d?.html || "", false); // false = don't emit onUpdate
    editor?.commands.focus("end");
  }
  function newDoc() {
    const d: Doc = { id: crypto.randomUUID(), title: "Untitled", html: "" };
    setDocuments((prev) => [d, ...prev]);
    setActiveDocId(d.id);
    editor?.commands.setContent("", false);
    editor?.commands.focus("end");
  }
  function deleteDoc(id: string) {
    const next = documents.filter((d) => d.id !== id);
    const docs = next.length
      ? next
      : [{ id: crypto.randomUUID(), title: "Untitled", html: "" }];
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
      return next;
    });

  useEffect(() => {
    listOllamaModels(settings.ollamaUrl)
      .then(setOllamaModels)
      .catch(() => setOllamaModels([]));
  }, [settings.ollamaUrl]);

  const provider = useMemo(() => resolveTextProvider(settings), [settings]);
  const {
    models: orModels,
    refresh: refreshOR,
    loading: orLoading,
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

  // Prompt bar: write a passage from the instruction (empty = continue).
  async function handleGenerate() {
    if (!editor || generating || !ensureModel()) return;

    const instruction = prompt.trim();
    stoppedRef.current = false;
    setGenerating(true);
    setStatus(instruction ? "Writing…" : "Continuing…");

    const storyText = editor.getText();
    const messages = buildContinuationMessages(storyText, settings, {
      wordTarget: settings.wordTarget,
      instruction,
    });

    editor.commands.focus("end");
    const nlRef = { current: false };
    if (instruction && storyText.trim().length) {
      editor.commands.splitBlock(); // new passage starts its own paragraph
      nlRef.current = true;
    } else if (!/\s$/.test(storyText) && storyText.length) {
      editor.commands.insertContent(" ");
    }

    await stream(messages, settings.maxTokens, nlRef);
    setPrompt("");
  }

  // Bubble menu: rewrite the current selection in place.
  async function handleRewrite() {
    if (!editor || generating || !ensureModel()) return;
    const { from, to } = editor.state.selection;
    if (to <= from) return;

    const passage = editor.state.doc.textBetween(from, to, "\n");
    const before = editor.state.doc.textBetween(0, from, "\n");
    const messages = buildRewriteMessages(before, passage, rewriteHow, settings);

    stoppedRef.current = false;
    setGenerating(true);
    setStatus("Rewriting…");
    editor.chain().focus().deleteSelection().run();
    const nlRef = { current: false };
    await stream(messages, Math.max(settings.maxTokens, 600), nlRef);
    setRewriteHow("");
  }

  // Shared streaming runner.
  async function stream(
    messages: ReturnType<typeof buildContinuationMessages>,
    maxTokens: number,
    nlRef: { current: boolean }
  ) {
    try {
      await generateText(
        {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
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
            setStatus(`Error: ${msg}`);
          },
        }
      );
    } catch (e) {
      setGenerating(false);
      setStatus(`Error: ${String(e)}`);
    }
  }

  function handleStop() {
    stoppedRef.current = true;
    setGenerating(false);
    setStatus("");
  }

  const wordCount = editor
    ? editor.getText().trim().split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">AI Studio</div>
        <div className="tabs">
          <button
            className={view === "chat" ? "tab active" : "tab"}
            onClick={() => setView("chat")}
          >
            Chat
          </button>
          <button
            className={view === "write" ? "tab active" : "tab"}
            onClick={() => setView("write")}
          >
            Write
          </button>
          <button
            className={view === "images" ? "tab active" : "tab"}
            onClick={() => setView("images")}
          >
            Images
          </button>
        </div>
        <div className="topbar-actions">
          {view === "write" && <span className="wordcount">{wordCount} words</span>}
          <button className="btn ghost" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      {view === "chat" ? (
        <Chat
          settings={settings}
          onChange={updateSettings}
          onOpenSettings={() => setShowSettings(true)}
        />
      ) : view === "write" ? (
        <div className="write-layout">
          <SessionSidebar
            items={documents}
            activeId={activeDocId}
            onSelect={switchDoc}
            onNew={newDoc}
            onDelete={deleteDoc}
            newLabel="+ New document"
          />
          <div className="write-view">
          <div className="write-topbar">
            <ModelSelect
              settings={settings}
              ollamaModels={ollamaModels}
              orModels={orModels}
              onChange={updateSettings}
              onRefresh={refreshOR}
              loading={orLoading}
            />
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
                  <input
                    className="bubble-input"
                    placeholder="improve… (or say how)"
                    value={rewriteHow}
                    onChange={(e) => setRewriteHow(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleRewrite();
                      }
                    }}
                  />
                  <button className="btn primary bubble-btn" onClick={handleRewrite}>
                    Rewrite
                  </button>
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
        </div>
      ) : (
        <ImagePanel settings={settings} onChange={updateSettings} />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
