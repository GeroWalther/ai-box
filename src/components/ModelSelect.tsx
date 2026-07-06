// Shared model picker: local Ollama models + OpenRouter's live catalog
// (a short "Popular" group, then everything else newest-first).
import type { OpenrouterModel } from "../lib/api";
import type { Settings } from "../lib/settings";
import { OPENROUTER_CHAT_SUGGESTIONS } from "../lib/presets";

interface Props {
  settings: Settings;
  ollamaModels: string[];
  orModels: OpenrouterModel[];
  onChange: (patch: Partial<Settings>) => void;
  onRefresh: () => void;
  loading: boolean;
}

export default function ModelSelect({
  settings,
  ollamaModels,
  orModels,
  onChange,
  onRefresh,
  loading,
}: Props) {
  const value =
    settings.provider === "ollama"
      ? `ollama|${settings.ollamaModel}`
      : `openrouter|${settings.openrouterModel}`;

  function select(v: string) {
    const kind = v.slice(0, v.indexOf("|"));
    const id = v.slice(v.indexOf("|") + 1);
    if (kind === "ollama") onChange({ provider: "ollama", ollamaModel: id });
    else onChange({ provider: "openrouter", openrouterModel: id });
  }

  const rest = orModels.filter((m) => !OPENROUTER_CHAT_SUGGESTIONS.includes(m.id));
  const known = new Set([...OPENROUTER_CHAT_SUGGESTIONS, ...orModels.map((m) => m.id)]);
  const selectedOR = settings.openrouterModel;

  return (
    <div className="model-select">
      <select className="chat-model" value={value} onChange={(e) => select(e.target.value)}>
        <optgroup label="Local (Ollama)">
          {ollamaModels.length === 0 && <option value="ollama|">— none installed —</option>}
          {ollamaModels.map((m) => (
            <option key={m} value={`ollama|${m}`}>
              Local · {m}
            </option>
          ))}
        </optgroup>
        <optgroup label="OpenRouter · Popular">
          {OPENROUTER_CHAT_SUGGESTIONS.map((m) => (
            <option key={m} value={`openrouter|${m}`}>
              {m}
            </option>
          ))}
        </optgroup>
        {rest.length > 0 && (
          <optgroup label={`OpenRouter · All ${rest.length} (newest first)`}>
            {rest.map((m) => (
              <option key={m.id} value={`openrouter|${m.id}`}>
                {m.id}
              </option>
            ))}
          </optgroup>
        )}
        {settings.provider === "openrouter" && selectedOR && !known.has(selectedOR) && (
          <optgroup label="Current">
            <option value={`openrouter|${selectedOR}`}>{selectedOR}</option>
          </optgroup>
        )}
      </select>
      <button
        className="btn ghost"
        title="Refresh OpenRouter model list"
        onClick={onRefresh}
        disabled={loading}
      >
        {loading ? "…" : "Refresh"}
      </button>
    </div>
  );
}
