// Per-document Story Bible: a collapsible right-hand panel where the author
// records synopsis, characters, world, and voice. Threaded into every AI
// continuation/rewrite for this document so it stays consistent.
import { EMPTY_BIBLE, type StoryBibleData } from "../lib/presets";

interface Props {
  bible: StoryBibleData;
  onChange: (b: StoryBibleData) => void;
  open: boolean;
  onToggle: () => void;
}

export default function StoryBible({ bible, onChange, open, onToggle }: Props) {
  const b = bible || EMPTY_BIBLE;
  const patch = (p: Partial<StoryBibleData>) => onChange({ ...b, ...p });

  function setChar(i: number, key: "name" | "traits", value: string) {
    const characters = b.characters.map((c, idx) => (idx === i ? { ...c, [key]: value } : c));
    patch({ characters });
  }
  function addChar() {
    patch({ characters: [...b.characters, { name: "", traits: "" }] });
  }
  function removeChar(i: number) {
    patch({ characters: b.characters.filter((_, idx) => idx !== i) });
  }

  if (!open) {
    return (
      <button className="bible-tab" onClick={onToggle} title="Open Story Bible">
        📔
      </button>
    );
  }

  return (
    <aside className="bible-panel">
      <div className="bible-head">
        <span>Story Bible</span>
        <button className="btn ghost" onClick={onToggle} title="Collapse">
          ›
        </button>
      </div>
      <div className="bible-body">
        <label>Synopsis</label>
        <textarea
          rows={3}
          placeholder="One-paragraph premise the AI should keep in mind…"
          value={b.synopsis}
          onChange={(e) => patch({ synopsis: e.target.value })}
        />

        <div className="bible-chars-head">
          <label>Characters</label>
          <button className="btn ghost small" onClick={addChar}>
            + Add
          </button>
        </div>
        {b.characters.length === 0 && (
          <p className="hint">Name your cast so the AI keeps them consistent.</p>
        )}
        {b.characters.map((c, i) => (
          <div key={i} className="bible-char">
            <input
              className="bible-char-name"
              placeholder="Name"
              value={c.name}
              onChange={(e) => setChar(i, "name", e.target.value)}
            />
            <input
              className="bible-char-traits"
              placeholder="role, traits, voice…"
              value={c.traits}
              onChange={(e) => setChar(i, "traits", e.target.value)}
            />
            <button className="bible-char-del" title="Remove" onClick={() => removeChar(i)}>
              ×
            </button>
          </div>
        ))}

        <label>World / Setting</label>
        <textarea
          rows={3}
          placeholder="Time, place, rules of the world…"
          value={b.world}
          onChange={(e) => patch({ world: e.target.value })}
        />

        <label>Style &amp; voice</label>
        <textarea
          rows={2}
          placeholder="e.g. lyrical, present tense, close third person…"
          value={b.styleNote}
          onChange={(e) => patch({ styleNote: e.target.value })}
        />
      </div>
    </aside>
  );
}
