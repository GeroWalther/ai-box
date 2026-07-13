// Writing-specific settings, opened from a gear in the Write toolbar. These are
// prose-generation controls (length, creativity, tone) — global app settings
// (theme, API key) live in the main Settings modal instead.
import { useEffect, useRef, useState } from "react";
import type { Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export default function WritingSettings({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="write-settings" ref={ref}>
      <button
        className="btn ghost"
        title="Writing settings"
        aria-label="Writing settings"
        onClick={() => setOpen((v) => !v)}
      >
        ⚙
      </button>
      {open && (
        <div className="write-settings-pop">
          <label>Passage length ({settings.wordTarget} words)</label>
          <input
            type="range"
            min={60}
            max={600}
            step={20}
            value={settings.wordTarget}
            onChange={(e) => onChange({ wordTarget: Number(e.target.value) })}
          />

          <label>Creativity ({settings.temperature.toFixed(2)})</label>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={settings.temperature}
            onChange={(e) => onChange({ temperature: Number(e.target.value) })}
          />

          <label>Max tokens per passage ({settings.maxTokens})</label>
          <input
            type="range"
            min={100}
            max={2000}
            step={50}
            value={settings.maxTokens}
            onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
          />

          <label>Style note (persistent tone / POV)</label>
          <textarea
            rows={3}
            placeholder="e.g. refined, sensual, literary; first person, present tense…"
            value={settings.authorsNote}
            onChange={(e) => onChange({ authorsNote: e.target.value })}
          />
          <p className="hint">Applies to every document. Per-book facts go in the Story Bible.</p>
        </div>
      )}
    </div>
  );
}
