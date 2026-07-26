// AI writing operations for the Write tab: continue, rewrite, proofread-review,
// undo and regenerate.
//
// Extracted from App.tsx so the rules around a destructive AI edit live in one
// place. Two of them are load-bearing:
//   • every AI edit that replaces existing text takes a version snapshot first
//   • proofread-style actions never touch the document; they return a proposal
//     the author accepts in ProofreadReview

import { useCallback, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { generateText } from "../lib/api";
import { chatCompletion } from "../lib/agent";
import {
  buildContinuationMessages,
  buildRewriteMessages,
  buildSummaryMessages,
  MAX_CONTEXT_CHARS,
  type StoryBibleData,
} from "../lib/presets";
import type { Settings } from "../lib/settings";
import { cancelStream } from "../lib/transport";
import { logError } from "../lib/log";
import type { QuickAction } from "../lib/writingActions";

/** The most recent AI edit, so it can be undone or regenerated cleanly. */
export interface LastGen {
  from: number;
  to: number;
  instruction: string;
  /** Text to restore on undo ("" for a fresh continuation). */
  original: string;
  kind: "continue" | "rewrite";
}

/** A proofreading proposal awaiting the author's accept/reject. */
export interface Proposal {
  from: number;
  to: number;
  original: string;
  corrected: string;
}

interface Provider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface Params {
  editor: Editor | null;
  settings: Settings;
  provider: Provider;
  bible: StoryBibleData;
  /** Snapshot the document before a destructive edit. */
  snapshot: (reason: "ai-edit") => Promise<void>;
  /** Persist a refreshed rolling summary onto the active document. */
  saveSummary: (summary: string, coverChars: number) => void;
  /** The active document's stored summary, if any. */
  storedSummary?: { summary?: string; summaryChars?: number };
  onError: (msg: string) => void;
  /** Called when the model/key isn't configured yet. */
  onNeedsModel: (message: string) => void;
  canGenerate: boolean;
}

function escapeText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function useWriting({
  editor,
  settings,
  provider,
  bible,
  snapshot,
  saveSummary,
  storedSummary,
  onError,
  onNeedsModel,
  canGenerate,
}: Params) {
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState("");
  const [lastGen, setLastGen] = useState<LastGen | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const stoppedRef = useRef(false);
  const requestIdRef = useRef("");
  const generatingRef = useRef(false);

  const setBusy = (v: boolean) => {
    generatingRef.current = v;
    setGenerating(v);
  };

  const ensureModel = useCallback((): boolean => {
    if (canGenerate) return true;
    onNeedsModel(
      settings.provider === "openrouter" && !settings.openrouterKey
        ? "Add your OpenRouter API key in Settings first."
        : "Pick a model in Settings first."
    );
    return false;
  }, [canGenerate, onNeedsModel, settings.provider, settings.openrouterKey]);

  /** Insert a streamed chunk, turning newlines into real paragraph blocks. */
  const insertChunk = useCallback(
    (token: string, nlRef: { current: boolean }) => {
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
    },
    [editor]
  );

  const stream = useCallback(
    async (
      messages: ReturnType<typeof buildContinuationMessages>,
      maxTokens: number,
      nlRef: { current: boolean }
    ) => {
      const requestId = crypto.randomUUID();
      requestIdRef.current = requestId;
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
              setBusy(false);
              setStatus("");
            },
            onError: (msg) => {
              setBusy(false);
              setStatus("");
              onError(msg);
            },
          },
          requestId
        );
      } catch (e) {
        setBusy(false);
        setStatus("");
        onError(String(e));
      }
    },
    [insertChunk, onError, provider, settings.temperature]
  );

  /**
   * Keep the "story so far" memory current for text that has fallen outside the
   * verbatim window, so a long manuscript stays consistent. Returns "" while the
   * whole thing still fits.
   */
  const ensureSummary = useCallback(
    async (storyText: string): Promise<string> => {
      const coverTo = storyText.length - MAX_CONTEXT_CHARS;
      if (coverTo <= 500) return "";
      if (
        storedSummary?.summary &&
        (storedSummary.summaryChars ?? 0) >= coverTo - 3000
      ) {
        return storedSummary.summary;
      }
      setStatus("Updating story memory…");
      try {
        const msg = await chatCompletion({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          messages: buildSummaryMessages(storyText.slice(0, coverTo), storedSummary?.summary),
          tools: [],
          temperature: 0.3,
        });
        const summary = (msg.content || "").trim();
        if (summary) saveSummary(summary, coverTo);
        return summary;
      } catch (e) {
        logError("write.summary", e);
        return storedSummary?.summary || ""; // fall back to the last known memory
      }
    },
    [provider, saveSummary, storedSummary]
  );

  const generateContinuation = useCallback(
    async (instruction: string) => {
      if (!editor) return;
      stoppedRef.current = false;
      setBusy(true);
      setStatus(instruction ? "Writing…" : "Continuing…");

      const storyText = editor.getText();
      const summary = await ensureSummary(storyText);
      if (stoppedRef.current) {
        setBusy(false);
        return;
      }
      setStatus(instruction ? "Writing…" : "Continuing…");
      const messages = buildContinuationMessages(
        storyText,
        settings,
        { wordTarget: settings.wordTarget, instruction },
        bible,
        summary
      );

      editor.commands.focus("end");
      const nlRef = { current: false };
      if (instruction && storyText.trim().length) {
        editor.commands.splitBlock(); // a new passage starts its own paragraph
        nlRef.current = true;
      } else if (!/\s$/.test(storyText) && storyText.length) {
        editor.commands.insertContent(" ");
      }

      const startPos = editor.state.selection.to;
      await stream(messages, settings.maxTokens, nlRef);
      const endPos = editor.state.selection.to;
      if (endPos > startPos) {
        setLastGen({ from: startPos, to: endPos, instruction, original: "", kind: "continue" });
      }
    },
    [bible, editor, ensureSummary, settings, stream]
  );

  /**
   * Rewrite the selection in place. `action` carries the instruction; actions
   * marked `review` return a proposal instead of editing the document.
   */
  const rewriteSelection = useCallback(
    async (how: string, review = false) => {
      if (!editor || generatingRef.current || !ensureModel()) return;
      const { from, to } = editor.state.selection;
      if (to <= from) return;

      const passage = editor.state.doc.textBetween(from, to, "\n");
      const before = editor.state.doc.textBetween(0, from, "\n");
      const messages = buildRewriteMessages(before, passage, how, settings, bible);

      stoppedRef.current = false;
      setBusy(true);

      // A review action must not touch the document, so it collects the whole
      // reply and hands it to the author rather than streaming over their words.
      if (review) {
        setStatus("Proofreading…");
        try {
          const msg = await chatCompletion({
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.model,
            messages,
            tools: [],
            temperature: 0.1, // corrections should be boring and repeatable
          });
          const corrected = (msg.content || "").trim();
          if (corrected) setProposal({ from, to, original: passage, corrected });
        } catch (e) {
          onError(String(e));
        } finally {
          setBusy(false);
          setStatus("");
        }
        return;
      }

      // Destructive: keep a restore point before the selection disappears.
      await snapshot("ai-edit");

      setStatus("Rewriting…");
      editor.chain().focus().deleteSelection().run();
      const start = editor.state.selection.from;
      const nlRef = { current: false };
      await stream(messages, Math.max(settings.maxTokens, 600), nlRef);
      const end = editor.state.selection.to;
      if (end > start) {
        setLastGen({ from: start, to: end, instruction: how, original: passage, kind: "rewrite" });
      }
    },
    [bible, editor, ensureModel, onError, provider, settings, snapshot, stream]
  );

  /** Run a preset selection action. */
  const runAction = useCallback(
    (action: QuickAction) => rewriteSelection(action.how, action.review),
    [rewriteSelection]
  );

  /** Apply the author's accepted proofreading result. */
  const applyProposal = useCallback(
    async (text: string) => {
      if (!editor || !proposal) return;
      await snapshot("ai-edit");
      editor
        .chain()
        .focus()
        .setTextSelection({ from: proposal.from, to: proposal.to })
        .insertContent(text)
        .run();
      setProposal(null);
    },
    [editor, proposal, snapshot]
  );

  const undoLastEdit = useCallback(() => {
    if (!editor || !lastGen) return;
    const size = editor.state.doc.content.size;
    const to = Math.min(lastGen.to, size);
    editor
      .chain()
      .focus()
      .setTextSelection({ from: lastGen.from, to })
      .deleteSelection()
      .insertContent(lastGen.original)
      .run();
    setLastGen(null);
  }, [editor, lastGen]);

  const regenerate = useCallback(async () => {
    if (!editor || generatingRef.current || !lastGen || !ensureModel()) return;
    const edit = lastGen;
    const size = editor.state.doc.content.size;
    const to = Math.min(edit.to, size);
    if (edit.kind === "rewrite") {
      // Put the original back, reselect it, and rewrite again.
      editor
        .chain()
        .focus()
        .setTextSelection({ from: edit.from, to })
        .insertContent(edit.original)
        .setTextSelection({ from: edit.from, to: edit.from + edit.original.length })
        .run();
      await rewriteSelection(edit.instruction);
    } else {
      editor.chain().focus().setTextSelection({ from: edit.from, to }).deleteSelection().run();
      await generateContinuation(edit.instruction);
    }
  }, [editor, ensureModel, generateContinuation, lastGen, rewriteSelection]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    // Abort server-side so the model stops generating (and billing).
    if (requestIdRef.current) cancelStream(requestIdRef.current);
    setBusy(false);
    setStatus("");
  }, []);

  return {
    generating,
    generatingRef,
    status,
    setStatus,
    lastGen,
    setLastGen,
    proposal,
    setProposal,
    ensureModel,
    generateContinuation,
    rewriteSelection,
    runAction,
    applyProposal,
    undoLastEdit,
    regenerate,
    stop,
  };
}
