// The list section of the unified sidebar. Each view (Chat / Write / Images)
// renders its own list INTO the App-level sidebar via SidebarSlot (a portal), so
// there's one sidebar instead of a nav rail + a separate list panel.
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
  /** Called after a pick/new so the mobile drawer can close. */
  onAfterAction?: () => void;
  emptyLabel?: string;
}

/** A titled list (chats, documents) with new + delete, for the sidebar slot. */
export default function SidebarList({
  items,
  activeId,
  newLabel,
  onSelect,
  onNew,
  onDelete,
  onAfterAction,
  emptyLabel,
}: Props) {
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
              onSelect(it.id);
              onAfterAction?.();
            }}
          >
            <span className="session-title">{it.title || "Untitled"}</span>
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
