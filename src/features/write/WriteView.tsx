// The Write tab.
//
// Previously ~250 lines of JSX inside App.tsx, interleaved with the app shell,
// sync plumbing and provider resolution. Here it owns exactly one thing: the
// writing surface and the tools around it.

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, BubbleMenu, type Editor } from "@tiptap/react";
import ExportMenu from "../../components/ExportMenu";
import FindReplace from "../../components/FindReplace";
import ModelSelect from "../../components/ModelSelect";
import Outline from "../../components/Outline";
import ProofreadReview from "../../components/ProofreadReview";
import PromptBar from "../../components/PromptBar";
import SidebarList, { SidebarSlot } from "../../components/SidebarList";
import StoryBible from "../../components/StoryBible";
import VersionHistory from "../../components/VersionHistory";
import WritingPresets from "../../components/WritingPresets";
import WritingSettings from "../../components/WritingSettings";
import WordGoal from "../../components/WordGoal";
import { LANGUAGES, type StoryBibleData } from "../../lib/presets";
import type { Settings } from "../../lib/settings";
import type { OpenrouterModel } from "../../lib/api";
import { actionsForMode, WRITING_MODES, type WritingMode } from "../../lib/writingActions";
import type { Doc } from "../../hooks/useDocuments";
import type { LastGen, Proposal } from "../../hooks/useWriting";

interface Props {
  editor: Editor | null;
  settings: Settings;
  onChangeSettings: (patch: Partial<Settings>) => void;

  documents: Doc[];
  activeDocId: string;
  activeDoc?: Doc;
  onSelectDoc: (id: string) => void;
  onNewDoc: () => void;
  onDeleteDoc: (id: string) => void;
  onRenameDoc: (id: string, title: string) => void;
  onRestoreVersion: (html: string) => void;

  bible: StoryBibleData;
  onChangeBible: (b: StoryBibleData) => void;
  onExtractBible: () => Promise<any>;

  // Generation
  generating: boolean;
  status: string;
  prompt: string;
  onPromptChange: (v: string) => void;
  onGenerate: () => void;
  onStop: () => void;
  onRewrite: (how: string) => void;
  onRunAction: (how: string, review?: boolean) => void;
  onIllustrate: () => void;
  lastGen: LastGen | null;
  onUndo: () => void;
  onRegenerate: () => void;
  onKeep: () => void;
  proposal: Proposal | null;
  onApplyProposal: (text: string) => void;
  onDiscardProposal: () => void;

  // Models
  ollamaModels: string[];
  orModels: OpenrouterModel[];
  onRefreshModels: () => void;
  onManageModels: () => void;

  sidebarSlot: HTMLElement | null;
  onCloseDrawer: () => void;
  findOpen: boolean;
  onCloseFind: () => void;
}

export default function WriteView(props: Props) {
  const { editor, settings, onChangeSettings } = props;
  const [bibleOpen, setBibleOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const mode = settings.writingMode || "fiction";
  const actions = useMemo(() => actionsForMode(mode), [mode]);
  const text = editor?.getText() ?? "";
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  // Typewriter scrolling: keep the caret near the vertical middle so the eye
  // stays in one place instead of drifting to the bottom of the window.
  useEffect(() => {
    if (!editor || !settings.typewriterMode) return;
    const recentre = () => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const { from } = editor.state.selection;
      const coords = editor.view.coordsAtPos(from);
      const box = scroller.getBoundingClientRect();
      const target = box.top + box.height / 2;
      const delta = coords.top - target;
      if (Math.abs(delta) > 12) scroller.scrollTop += delta;
    };
    editor.on("selectionUpdate", recentre);
    editor.on("update", recentre);
    return () => {
      editor.off("selectionUpdate", recentre);
      editor.off("update", recentre);
    };
  }, [editor, settings.typewriterMode]);

  return (
    <div className={`write-layout${settings.focusMode ? " focus" : ""}`}>
      <SidebarSlot slot={props.sidebarSlot}>
        <SidebarList
          items={props.documents}
          activeId={props.activeDocId}
          onSelect={props.onSelectDoc}
          onNew={props.onNewDoc}
          onDelete={props.onDeleteDoc}
          onRename={props.onRenameDoc}
          newLabel="+ New document"
          onAfterAction={props.onCloseDrawer}
        />
        <Outline editor={editor} />
      </SidebarSlot>

      <div className="write-view">
        <FindReplace editor={editor} open={props.findOpen} onClose={props.onCloseFind} />

        <div className="editor-scroll" ref={scrollRef}>
          <EditorContent editor={editor} className="prose" />
          {editor && (
            <BubbleMenu
              editor={editor}
              shouldShow={({ from, to }) => to > from && !props.generating && !props.proposal}
              tippyOptions={{ duration: 100, placement: "top" }}
            >
              <div className="bubble">
                <div className="bubble-actions">
                  {actions.map((a) => (
                    <button
                      key={a.id}
                      className={a.review ? "bubble-quick review" : "bubble-quick"}
                      title={a.how}
                      onClick={() => props.onRunAction(a.how, a.review)}
                    >
                      {a.label}
                    </button>
                  ))}
                  <button
                    className="bubble-quick"
                    title="Generate an image from this scene in the Images tab"
                    onClick={props.onIllustrate}
                  >
                    🎨 Illustrate
                  </button>
                </div>
                <div className="bubble-row">
                  <BubbleRewrite onRewrite={props.onRewrite} />
                </div>
              </div>
            </BubbleMenu>
          )}
        </div>

        {/* Proofreading proposal — the document is untouched until it's accepted. */}
        {props.proposal && (
          <ProofreadReview
            original={props.proposal.original}
            corrected={props.proposal.corrected}
            onAccept={props.onApplyProposal}
            onCancel={props.onDiscardProposal}
          />
        )}

        {props.lastGen && !props.generating && !props.proposal && (
          <div className="ai-edit-bar">
            <span className="ai-edit-label">
              {props.lastGen.kind === "rewrite"
                ? "AI rewrote your selection"
                : "AI wrote this passage"}
            </span>
            <button className="btn ghost" onClick={props.onUndo} title="Revert this AI change">
              Undo
            </button>
            <button
              className="btn ghost"
              onClick={props.onRegenerate}
              title="Discard and try again"
            >
              Regenerate
            </button>
            <button className="btn" onClick={props.onKeep} title="Keep it">
              Keep
            </button>
          </div>
        )}

        <WordGoal
          words={wordCount}
          goal={settings.wordGoal}
          onChangeGoal={(wordGoal) => onChangeSettings({ wordGoal })}
        />

        <PromptBar
          value={props.prompt}
          onChange={props.onPromptChange}
          onSubmit={props.onGenerate}
          onStop={props.onStop}
          generating={props.generating}
          status={props.status}
          toolsOpen={toolsOpen}
          onToggleTools={() => setToolsOpen((v) => !v)}
          tools={
            <>
              <select
                className="lang-select"
                title="What are you writing? Changes the editing tools and the AI's editorial voice."
                aria-label="Writing mode"
                value={mode}
                onChange={(e) =>
                  onChangeSettings({ writingMode: e.target.value as WritingMode })
                }
              >
                {WRITING_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <ModelSelect
                settings={settings}
                ollamaModels={props.ollamaModels}
                orModels={props.orModels}
                onChange={onChangeSettings}
                onRefresh={props.onRefreshModels}
                onManageModels={props.onManageModels}
              />
              {mode === "fiction" && (
                <WritingPresets settings={settings} onChange={onChangeSettings} />
              )}
              <select
                className="lang-select"
                title="Output language"
                aria-label="Output language"
                value={settings.language}
                onChange={(e) => onChangeSettings({ language: e.target.value })}
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l === "auto" ? "Auto" : l}
                  </option>
                ))}
              </select>
              {props.lastGen && !props.generating && (
                <button
                  className="btn ghost"
                  title="Regenerate the last AI passage"
                  onClick={props.onRegenerate}
                >
                  Regenerate
                </button>
              )}
              {mode === "fiction" && (
                <button
                  className={bibleOpen ? "btn ghost active" : "btn ghost"}
                  title="Story Bible — characters, world & canon for this document"
                  onClick={() => setBibleOpen((v) => !v)}
                >
                  Story Bible
                </button>
              )}
              <button
                className="btn ghost"
                title="Browse and restore earlier drafts of this document"
                onClick={() => setHistoryOpen(true)}
              >
                History
              </button>
              <button
                className={settings.focusMode ? "btn ghost active" : "btn ghost"}
                title="Focus mode (⌘⇧F) — hide everything but the page"
                onClick={() => onChangeSettings({ focusMode: !settings.focusMode })}
              >
                Focus
              </button>
              <WritingSettings settings={settings} onChange={onChangeSettings} />
              <ExportMenu
                title={props.activeDoc?.title || "manuscript"}
                getText={() => editor?.getText() ?? ""}
                getHTML={() => editor?.getHTML() ?? ""}
                documents={props.documents}
              />
            </>
          }
        />
      </div>

      {mode === "fiction" && (
        <StoryBible
          bible={props.bible}
          onChange={props.onChangeBible}
          open={bibleOpen}
          onToggle={() => setBibleOpen((v) => !v)}
          storyText={text}
          onExtract={props.onExtractBible}
        />
      )}

      <VersionHistory
        docId={props.activeDocId}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestore={(html) => {
          props.onRestoreVersion(html);
          setHistoryOpen(false);
        }}
      />
    </div>
  );
}

/** The free-text "rewrite how…" box, kept local so typing doesn't re-render the tab. */
function BubbleRewrite({ onRewrite }: { onRewrite: (how: string) => void }) {
  const [how, setHow] = useState("");
  const submit = () => {
    onRewrite(how);
    setHow("");
  };
  return (
    <>
      <input
        className="bubble-input"
        placeholder="rewrite how…"
        aria-label="Describe how to rewrite the selection"
        value={how}
        onChange={(e) => setHow(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button className="btn primary bubble-btn" onClick={submit}>
        Rewrite
      </button>
    </>
  );
}
