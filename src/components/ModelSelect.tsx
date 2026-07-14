// Model picker: local Ollama models + a small Featured pin list + the full
// catalog derived LIVE from OpenRouter (so new models appear on their own).
import type { OpenrouterModel } from "../lib/api";
import type { Settings } from "../lib/settings";
import { FEATURED_MODELS } from "../lib/presets";

interface Props {
  settings: Settings;
  ollamaModels: string[];
  orModels: OpenrouterModel[];
  onChange: (patch: Partial<Settings>) => void;
  onRefresh: () => void;
  loading: boolean;
  /** Opens the local (Ollama) model installer. Shown as a "Local models" button. */
  onManageModels?: () => void;
}

export default function ModelSelect({
  settings,
  ollamaModels,
  orModels,
  onChange,
  onRefresh,
  loading,
  onManageModels,
}: Props) {
  const value =
    settings.provider === "ollama"
      ? `ollama|${settings.ollamaModel}`
      : settings.provider === "custom"
        ? `custom|${settings.customModel}`
        : `openrouter|${settings.openrouterModel}`;

  function select(v: string) {
    const kind = v.slice(0, v.indexOf("|"));
    const id = v.slice(v.indexOf("|") + 1);
    if (kind === "ollama") onChange({ provider: "ollama", ollamaModel: id });
    else if (kind === "custom") onChange({ provider: "custom", customModel: id });
    else onChange({ provider: "openrouter", openrouterModel: id });
  }

  const featuredIds = new Set(FEATURED_MODELS.map((m) => m.id));
  // Text models only (drop pure image generators). All non-featured models live
  // in one plain list — no special spotlighting of any category.
  const textModels = orModels.filter((m) => m.outputText);
  const rest = textModels.filter((m) => !featuredIds.has(m.id));
  const known = new Set([...featuredIds, ...orModels.map((m) => m.id)]);
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
        {(settings.customUrl || settings.customModel) && (
          <optgroup label="Custom (OpenAI-compatible)">
            <option value={`custom|${settings.customModel}`} title={settings.customUrl}>
              {settings.customModel
                ? `Custom · ${settings.customModel}`
                : "— set a model in Settings —"}
            </option>
          </optgroup>
        )}
        <optgroup label="OpenRouter · Featured">
          {FEATURED_MODELS.map((m) => (
            <option key={m.id} value={`openrouter|${m.id}`} title={m.note}>
              {m.label} — {m.note}
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
      {onManageModels && (
        <button className="btn ghost" title="Install / manage local (Ollama) models" onClick={onManageModels}>
          Local models
        </button>
      )}
    </div>
  );
}
