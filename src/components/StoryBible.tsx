// Per-document Story Bible: a collapsible right-hand panel where the author
// records synopsis, characters, world, canon facts, and voice. Threaded into
// every AI continuation/rewrite for this document so it stays consistent.
//
// Auto-fill: capitalized names/places in the prose surface instantly as chips,
// and an optional "✨ Extract" pass asks the model for new characters + canon
// facts — one click adds each to the bible, so it never becomes manual busywork.
import { useMemo, useState } from "react";
import { EMPTY_BIBLE, type StoryBibleData } from "../lib/presets";
import { extractProperNouns, type Extraction } from "../lib/extract";

interface Props {
  bible: StoryBibleData;
  onChange: (b: StoryBibleData) => void;
  open: boolean;
  onToggle: () => void;
  /** Current manuscript text, for auto-fill suggestions. */
  storyText: string;
  /** Run the model-backed extraction; returns null on error/no model. */
  onExtract: () => Promise<Extraction | null>;
}

export default function StoryBible({ bible, onChange, open, onToggle, storyText, onExtract }: Props) {
  const b = bible || EMPTY_BIBLE;
  const facts = b.facts || [];
  const patch = (p: Partial<StoryBibleData>) => onChange({ ...b, ...p });

  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState<Extraction | null>(null);
  const [aiNote, setAiNote] = useState("");

  function setChar(i: number, key: "name" | "traits" | "aliases", value: string) {
    const characters = b.characters.map((c, idx) => (idx === i ? { ...c, [key]: value } : c));
    patch({ characters });
  }
  function addChar() {
    patch({ characters: [...b.characters, { name: "", traits: "", aliases: "" }] });
  }
  function removeChar(i: number) {
    patch({ characters: b.characters.filter((_, idx) => idx !== i) });
  }

  function setFact(i: number, key: "text" | "who", value: string) {
    patch({ facts: facts.map((f, idx) => (idx === i ? { ...f, [key]: value } : f)) });
  }
  function addFact() {
    patch({ facts: [...facts, { text: "", who: "" }] });
  }
  function removeFact(i: number) {
    patch({ facts: facts.filter((_, idx) => idx !== i) });
  }

  // --- auto-fill -----------------------------------------------------------
  const knownNames = useMemo(
    () => b.characters.flatMap((c) => [c.name, ...(c.aliases ? c.aliases.split(/[,;]/) : [])]),
    [b.characters]
  );
  const nounSuggestions = useMemo(
    () => extractProperNouns(storyText || "", knownNames).slice(0, 10),
    [storyText, knownNames]
  );

  function hasChar(name: string) {
    return b.characters.some((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
  }
  function hasFact(text: string) {
    return facts.some((f) => f.text.trim().toLowerCase() === text.trim().toLowerCase());
  }
  function addCharacter(name: string, traits = "") {
    if (!name.trim() || hasChar(name)) return;
    patch({ characters: [...b.characters, { name: name.trim(), traits, aliases: "" }] });
  }
  function addFactObj(text: string, who = "") {
    if (!text.trim() || hasFact(text)) return;
    patch({ facts: [...facts, { text: text.trim(), who }] });
  }

  async function runAi() {
    setAiBusy(true);
    setAiNote("");
    try {
      const r = await onExtract();
      if (!r) {
        setAiNote("Couldn't extract — check your model in Settings.");
      } else {
        const fresh: Extraction = {
          characters: r.characters.filter((c) => !hasChar(c.name)),
          facts: r.facts.filter((f) => !hasFact(f.text)),
        };
        setAi(fresh);
        if (!fresh.characters.length && !fresh.facts.length) setAiNote("Nothing new found.");
      }
    } catch {
      setAiNote("Extraction failed.");
    } finally {
      setAiBusy(false);
    }
  }

  const aiChars = (ai?.characters || []).filter((c) => !hasChar(c.name));
  const aiFacts = (ai?.facts || []).filter((f) => !hasFact(f.text));

  if (!open) {
    return (
      <button className="bible-tab" onClick={onToggle} title="Open Story Bible" aria-label="Open Story Bible">
        📔
      </button>
    );
  }

  return (
    <aside className="bible-panel">
      <div className="bible-head">
        <span>Story Bible</span>
        <button className="btn ghost" onClick={onToggle} title="Collapse" aria-label="Collapse Story Bible">
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
              className="bible-char-aka"
              placeholder="aka (nicknames)"
              value={c.aliases || ""}
              onChange={(e) => setChar(i, "aliases", e.target.value)}
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

        <div className="bible-chars-head">
          <label>Canon facts</label>
          <button className="btn ghost small" onClick={addFact}>
            + Add
          </button>
        </div>
        {facts.length === 0 && (
          <p className="hint">
            Established facts the AI must never contradict — surfaced automatically when
            the characters they concern appear, even chapters later.
          </p>
        )}
        {facts.map((f, i) => (
          <div key={i} className="bible-char">
            <input
              className="bible-char-traits"
              placeholder="e.g. Kira's brother died in the siege of Vell"
              value={f.text}
              onChange={(e) => setFact(i, "text", e.target.value)}
            />
            <input
              className="bible-char-aka"
              placeholder="who (optional)"
              value={f.who || ""}
              onChange={(e) => setFact(i, "who", e.target.value)}
            />
            <button className="bible-char-del" title="Remove" onClick={() => removeFact(i)}>
              ×
            </button>
          </div>
        ))}

        {/* ---- Auto-fill from your text ---- */}
        <div className="bible-chars-head" style={{ marginTop: 14 }}>
          <label>Auto-fill</label>
          <button className="btn ghost small" onClick={runAi} disabled={aiBusy}>
            {aiBusy ? "Reading…" : "✨ Extract"}
          </button>
        </div>
        {aiNote && <p className="hint">{aiNote}</p>}

        {nounSuggestions.length > 0 && (
          <>
            <p className="hint">Names/places in your text — tap to add as a character:</p>
            <div className="bible-chips">
              {nounSuggestions.map((n) => (
                <button key={n.name} className="bible-chip" onClick={() => addCharacter(n.name)}>
                  + {n.name}
                </button>
              ))}
            </div>
          </>
        )}

        {aiChars.length > 0 && (
          <>
            <p className="hint">Suggested characters:</p>
            <div className="bible-chips">
              {aiChars.map((c) => (
                <button
                  key={c.name}
                  className="bible-chip"
                  title={c.traits}
                  onClick={() => addCharacter(c.name, c.traits)}
                >
                  + {c.name}
                </button>
              ))}
            </div>
          </>
        )}

        {aiFacts.length > 0 && (
          <>
            <p className="hint">Suggested canon facts:</p>
            <div className="bible-chips">
              {aiFacts.map((f) => (
                <button
                  key={f.text}
                  className="bible-chip fact"
                  onClick={() => addFactObj(f.text, f.who)}
                >
                  + {f.text}
                </button>
              ))}
            </div>
          </>
        )}

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
