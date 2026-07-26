// Find & replace over the manuscript (⌘F).
//
// Works on the ProseMirror document directly rather than the DOM, so matches
// survive the editor re-rendering, and replacements go through the normal
// transaction path — meaning undo, autosave and version snapshots all see them
// as ordinary edits.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";

interface Props {
  editor: Editor | null;
  open: boolean;
  onClose: () => void;
}

interface Match {
  from: number;
  to: number;
}

/** Collect every match of `query` across the document's text nodes. */
function findMatches(editor: Editor | null, query: string, matchCase: boolean): Match[] {
  if (!editor || !query) return [];
  const out: Match[] = [];
  const needle = matchCase ? query : query.toLowerCase();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const hay = matchCase ? node.text : node.text.toLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1) {
      // +1 because a text node's content starts one position inside its parent.
      out.push({ from: pos + at, to: pos + at + query.length });
      at = hay.indexOf(needle, at + Math.max(needle.length, 1));
    }
  });
  return out;
}

export default function FindReplace({ editor, open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped after each replace so the match list recomputes against new text.
  const [revision, setRevision] = useState(0);

  const matches = useMemo(
    () => findMatches(editor, query, matchCase),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, query, matchCase, revision, open]
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setCurrent(0);
  }, [query, matchCase]);

  // Keep the active match selected and scrolled into view.
  useEffect(() => {
    if (!open || !editor || !matches.length) return;
    const m = matches[Math.min(current, matches.length - 1)];
    editor.commands.setTextSelection({ from: m.from, to: m.to });
    editor.commands.scrollIntoView();
  }, [open, editor, matches, current]);

  if (!open) return null;

  const step = (delta: number) => {
    if (!matches.length) return;
    setCurrent((c) => (c + delta + matches.length) % matches.length);
  };

  function replaceOne() {
    if (!editor || !matches.length) return;
    const m = matches[Math.min(current, matches.length - 1)];
    editor
      .chain()
      .focus()
      .setTextSelection({ from: m.from, to: m.to })
      .insertContent(replacement)
      .run();
    setRevision((r) => r + 1);
  }

  function replaceAll() {
    if (!editor || !matches.length) return;
    // Back to front, so replacing one match doesn't shift the positions of the
    // matches still to come.
    const chain = editor.chain().focus();
    for (const m of [...matches].reverse()) {
      chain.setTextSelection({ from: m.from, to: m.to }).insertContent(replacement);
    }
    chain.run();
    setRevision((r) => r + 1);
  }

  return (
    <div className="findbar" role="search">
      <input
        ref={inputRef}
        className="find-input"
        placeholder="Find"
        aria-label="Find in document"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {query ? (matches.length ? `${Math.min(current + 1, matches.length)}/${matches.length}` : "0/0") : ""}
      </span>
      <button className="btn ghost find-btn" onClick={() => step(-1)} aria-label="Previous match">
        ↑
      </button>
      <button className="btn ghost find-btn" onClick={() => step(1)} aria-label="Next match">
        ↓
      </button>

      <input
        className="find-input"
        placeholder="Replace with"
        aria-label="Replace with"
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      <button className="btn ghost" onClick={replaceOne} disabled={!matches.length}>
        Replace
      </button>
      <button className="btn ghost" onClick={replaceAll} disabled={!matches.length}>
        All
      </button>

      <label className="find-case" title="Match case">
        <input
          type="checkbox"
          checked={matchCase}
          onChange={(e) => setMatchCase(e.target.checked)}
        />
        Aa
      </label>
      <button className="btn ghost find-btn" onClick={onClose} aria-label="Close find and replace">
        ×
      </button>
    </div>
  );
}
