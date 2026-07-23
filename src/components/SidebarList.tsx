// The list section of the unified sidebar. Each view (Chat / Write / Images)
// renders its own list INTO the App-level sidebar via SidebarSlot (a portal), so
// there's one sidebar instead of a nav rail + a separate list panel.
import { useState } from "react";
import { createPortal } from "react-dom";

/** Render `children` into the sidebar's list slot (a DOM node in App). */
export function SidebarSlot({
  slot,
  children,
}: {
  slot: HTMLElement | null;
  children: React.ReactNode;
}) {
  return slot ? createPortal(children, slot) : null;
}

interface Item {
  id: string;
  title: string;
}
interface Props {
  items: Item[];
  activeId: string;
  newLabel: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** When provided, double-clicking a title renames it inline. */
  onRename?: (id: string, title: string) => void;
  /** Called after a pick/new so the mobile drawer can close. */
  onAfterAction?: () => void;
  emptyLabel?: string;
}

/** A titled list (chats, documents, terminals) with new + delete (+ optional
 *  double-click rename), for the sidebar slot. */
export default function SidebarList({
  items,
  activeId,
  newLabel,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onAfterAction,
  emptyLabel,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function commitRename(id: string) {
    const t = draft.trim();
    if (t && onRename) onRename(id, t);
    setEditing(null);
  }

  return (
    <>
      <button
        className="sidebar-new"
        onClick={() => {
          onNew();
          onAfterAction?.();
        }}
      >
        {newLabel}
      </button>
      <div className="session-list">
        {items.length === 0 && emptyLabel && <div className="session-empty">{emptyLabel}</div>}
        {items.map((it) => (
          <div
            key={it.id}
            className={it.id === activeId ? "session-item active" : "session-item"}
            onClick={() => {
              if (editing === it.id) return;
              onSelect(it.id);
              onAfterAction?.();
            }}
          >
            {editing === it.id ? (
              <input
                className="session-rename"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => commitRename(it.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(it.id);
                  else if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span
                className="session-title"
                onDoubleClick={(e) => {
                  if (!onRename) return;
                  e.stopPropagation();
                  setDraft(it.title || "");
                  setEditing(it.id);
                }}
                title={onRename ? "Double-click to rename" : it.title}
              >
                {it.title || "Untitled"}
              </span>
            )}
            <button
              className="session-del"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(it.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
