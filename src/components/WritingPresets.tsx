// Format + Genre are orthogonal, so they're two separate dropdowns that combine:
// e.g. "Novel" + "Horror", or "Short Story" + "Romance". Either can be left blank.
// Picking a preset also applies its generation nudges (temperature / word target).
import { WRITING_PRESETS } from "../lib/presets";
import type { Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export default function WritingPresets({ settings, onChange }: Props) {
  const formats = WRITING_PRESETS.filter((p) => (p.group ?? "format") === "format");
  const genres = WRITING_PRESETS.filter((p) => p.group === "genre");

  function pickFormat(id: string) {
    const p = WRITING_PRESETS.find((x) => x.id === id);
    onChange({
      writingPreset: id,
      ...(p?.temperature != null ? { temperature: p.temperature } : {}),
      ...(p?.wordTarget != null ? { wordTarget: p.wordTarget } : {}),
    });
  }

  function pickGenre(id: string) {
    const p = WRITING_PRESETS.find((x) => x.id === id);
    // Genre nudges (mood/temperature) refine the format; apply them when chosen.
    onChange({
      writingGenre: id,
      ...(p?.temperature != null ? { temperature: p.temperature } : {}),
      ...(p?.wordTarget != null ? { wordTarget: p.wordTarget } : {}),
    });
  }

  return (
    <>
      <select
        className="preset-select"
        title="Format — what you're writing"
        value={settings.writingPreset}
        onChange={(e) => pickFormat(e.target.value)}
      >
        <option value="">Format: Freeform</option>
        {formats.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        className="preset-select"
        title="Genre & tone — layered on top of the format"
        value={settings.writingGenre}
        onChange={(e) => pickGenre(e.target.value)}
      >
        <option value="">Genre: Any</option>
        {genres.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </>
  );
}
