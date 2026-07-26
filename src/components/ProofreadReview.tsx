// Proofreading as review, not replacement.
//
// The old Proofread action streamed a corrected passage straight over the
// selection. For grammar fixes that is the wrong interaction twice over: the
// writer can't see what was "wrong", and a model that decides to improve a
// sentence while it's in there has silently rewritten their voice with no trace.
//
// So corrections arrive as a word-level diff the author reads and accepts —
// all at once, or one fix at a time.

import { useMemo, useState } from "react";
import { wordDiff, type DiffPart } from "../lib/diff";

interface Props {
  original: string;
  corrected: string;
  onAccept: (text: string) => void;
  onCancel: () => void;
}

/** A single suggested change: what to remove, what to put in its place. */
interface Change {
  index: number;
  removed: string;
  added: string;
}

/**
 * Group the raw diff into changes. A del immediately followed by an add is one
 * "replace this with that", which is how a reader thinks about a correction —
 * two separate entries would make every fix look like two.
 */
function toChanges(parts: DiffPart[]): { blocks: (DiffPart | Change)[]; changes: Change[] } {
  const blocks: (DiffPart | Change)[] = [];
  const changes: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type === "ctx") {
      blocks.push(p);
      continue;
    }
    const next = parts[i + 1];
    let removed = p.type === "del" ? p.text : "";
    let added = p.type === "add" ? p.text : "";
    if (p.type === "del" && next?.type === "add") {
      added = next.text;
      i++;
    }
    const change: Change = { index: changes.length, removed, added };
    changes.push(change);
    blocks.push(change);
  }
  return { blocks, changes };
}

const isChange = (b: DiffPart | Change): b is Change => "index" in b;

export default function ProofreadReview({ original, corrected, onAccept, onCancel }: Props) {
  const { blocks, changes } = useMemo(
    () => toChanges(wordDiff(original, corrected)),
    [original, corrected]
  );
  // Every suggestion starts accepted; unchecking one keeps the original words.
  const [rejected, setRejected] = useState<Set<number>>(new Set());

  const result = useMemo(
    () =>
      blocks
        .map((b) =>
          !isChange(b) ? b.text : rejected.has(b.index) ? b.removed : b.added
        )
        .join(""),
    [blocks, rejected]
  );

  const accepted = changes.length - rejected.size;

  function toggle(index: number) {
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  if (!changes.length) {
    return (
      <div className="proofread">
        <div className="proofread-head">
          <span className="proofread-title">Nothing to fix</span>
          <button className="btn" onClick={onCancel}>
            Close
          </button>
        </div>
        <p className="hint">No spelling, grammar or punctuation errors found in the selection.</p>
      </div>
    );
  }

  return (
    <div className="proofread" role="region" aria-label="Proofreading suggestions">
      <div className="proofread-head">
        <span className="proofread-title">
          {changes.length} suggestion{changes.length === 1 ? "" : "s"}
          {rejected.size > 0 && <span className="hint"> · {accepted} kept</span>}
        </span>
        <div className="proofread-actions">
          <button className="btn ghost" onClick={onCancel}>
            Discard
          </button>
          <button
            className="btn ghost"
            onClick={() => setRejected(new Set(changes.map((c) => c.index)))}
            disabled={rejected.size === changes.length}
          >
            Reject all
          </button>
          <button className="btn primary" onClick={() => onAccept(result)}>
            Apply {accepted > 0 ? accepted : "none"}
          </button>
        </div>
      </div>

      <p className="hint">
        Click any suggestion to keep your original wording instead.
      </p>

      <div className="proofread-text">
        {blocks.map((b, i) =>
          !isChange(b) ? (
            <span key={i}>{b.text}</span>
          ) : (
            <button
              key={i}
              type="button"
              className={`pf-change${rejected.has(b.index) ? " rejected" : ""}`}
              onClick={() => toggle(b.index)}
              aria-pressed={!rejected.has(b.index)}
              title={
                rejected.has(b.index)
                  ? "Rejected — click to accept this fix"
                  : "Accepted — click to keep your original"
              }
            >
              {b.removed && <span className="pf-del">{b.removed}</span>}
              {b.added && <span className="pf-add">{b.added}</span>}
            </button>
          )
        )}
      </div>
    </div>
  );
}
