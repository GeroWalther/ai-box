// Version history for the active document: browse past drafts, read one, and
// restore it. Restoring snapshots the current text first, so "restore" is itself
// undoable — the one thing that would make this feature scarier than no feature.

import { useEffect, useState } from "react";
import { getVersion, listVersions, type VersionMeta } from "../lib/versionStore";

interface Props {
  docId: string;
  open: boolean;
  onClose: () => void;
  /** Restore this HTML into the editor (the caller snapshots current first). */
  onRestore: (html: string, at: number) => void;
}

const REASON_LABEL: Record<string, string> = {
  auto: "while writing",
  "ai-edit": "before an AI edit",
  restore: "before a restore",
  manual: "saved by you",
};

function when(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** Strip tags for the preview pane — the stored value is editor HTML. */
function toPlainText(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.textContent ?? "";
}

export default function VersionHistory({ docId, open, onClose, onRestore }: Props) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !docId) return;
    let cancelled = false;
    setLoading(true);
    listVersions(docId)
      .then((rows) => {
        if (cancelled) return;
        setVersions(rows);
        setSelected(rows[0]?.at ?? null);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, docId]);

  useEffect(() => {
    if (!open || selected == null) return;
    let cancelled = false;
    getVersion(docId, selected).then((v) => {
      if (!cancelled) setPreview(v ? toPlainText(v.html) : "");
    });
    return () => {
      cancelled = true;
    };
  }, [open, docId, selected]);

  if (!open) return null;

  async function restore() {
    if (selected == null) return;
    const v = await getVersion(docId, selected);
    if (v) onRestore(v.html, v.at);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal versions" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Version history</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close version history">
            ×
          </button>
        </div>

        <div className="modal-body versions-body">
          <div className="versions-list" role="listbox" aria-label="Saved versions">
            {loading && <p className="hint">Loading…</p>}
            {!loading && versions.length === 0 && (
              <p className="hint">
                No saved versions yet. Drafts are snapshotted automatically as you write,
                and always right before the AI changes your text.
              </p>
            )}
            {versions.map((v) => (
              <button
                key={v.at}
                role="option"
                aria-selected={selected === v.at}
                className={selected === v.at ? "version-row active" : "version-row"}
                onClick={() => setSelected(v.at)}
              >
                <span className="version-when">{when(v.at)}</span>
                <span className="version-meta">
                  {v.words.toLocaleString()} words · {REASON_LABEL[v.reason] ?? v.reason}
                </span>
              </button>
            ))}
          </div>

          <div className="versions-preview">
            {selected == null ? (
              <p className="hint">Pick a version to preview it.</p>
            ) : (
              <pre className="version-text">{preview || "(empty)"}</pre>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <span className="hint">
            Restoring keeps your current text as a new version first, so nothing is lost.
          </span>
          <button className="btn primary" disabled={selected == null} onClick={restore}>
            Restore this version
          </button>
        </div>
      </div>
    </div>
  );
}
