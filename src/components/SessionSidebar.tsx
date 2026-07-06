// Reusable left rail listing named items (documents, chats…) with new/delete.
interface Item {
  id: string;
  title: string;
}
interface Props {
  items: Item[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  newLabel: string;
}

export default function SessionSidebar({
  items,
  activeId,
  onSelect,
  onNew,
  onDelete,
  newLabel,
}: Props) {
  return (
    <aside className="chat-sessions">
      <button className="btn primary new-chat" onClick={onNew}>
        {newLabel}
      </button>
      <div className="session-list">
        {items.map((it) => (
          <div
            key={it.id}
            className={it.id === activeId ? "session-item active" : "session-item"}
            onClick={() => onSelect(it.id)}
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
    </aside>
  );
}
