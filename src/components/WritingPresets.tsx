// Genre/style picker as a single dropdown (Format + Genre groups). Choosing a
// preset preadjusts how the AI writes and applies its generation nudges.
import { WRITING_PRESETS } from "../lib/presets";
import type { Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export default function WritingPresets({ settings, onChange }: Props) {
  function pick(id: string) {
    if (!id) {
      onChange({ writingPreset: "" });
      return;
    }
    const p = WRITING_PRESETS.find((x) => x.id === id);
    onChange({
      writingPreset: id,
      ...(p?.temperature != null ? { temperature: p.temperature } : {}),
      ...(p?.wordTarget != null ? { wordTarget: p.wordTarget } : {}),
    });
  }

  const formats = WRITING_PRESETS.filter((p) => (p.group ?? "format") === "format");
  const genres = WRITING_PRESETS.filter((p) => p.group === "genre");

  return (
    <select
      className="preset-select"
      title="Writing style / genre"
      value={settings.writingPreset}
      onChange={(e) => pick(e.target.value)}
    >
      <option value="">Freeform</option>
      <optgroup label="Format">
        {formats.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Genre &amp; tone">
        {genres.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </optgroup>
    </select>
  );
}
