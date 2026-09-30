// Model picker: the models of the provider chosen in Settings, and any model
// installed on this Mac — nothing else.
//
// One provider at a time: showing OpenRouter's catalogue next to Gemini's would
// offer the same model twice at two prices. Local models are listed only when
// there are some; installing them lives in Settings, not next to every picker.
import type { OpenrouterModel, ProviderModel } from "../lib/api";
import { activeProvider, type Settings } from "../lib/settings";
import { FEATURED_MODELS } from "../lib/presets";

interface Props {
  settings: Settings;
  ollamaModels: string[];
  orModels: OpenrouterModel[];
  /** The active provider's models, when that provider is not OpenRouter. */
  directModels?: ProviderModel[];
  /** True while those are being fetched. */
  directLoading?: boolean;
  /** Why they could not be fetched, as the provider put it. */
  directError?: string;
  onChange: (patch: Partial<Settings>) => void;
  onRefresh: () => void;
}

export default function ModelSelect({
  settings,
  ollamaModels,
  orModels,
  directModels = [],
  directLoading,
  directError,
  onChange,
  onRefresh,
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
    if (!id) return; // a status line, not a model
    if (kind === "ollama") onChange({ provider: "ollama", ollamaModel: id });
    else if (kind === "custom") onChange({ provider: "custom", customModel: id });
    else onChange({ provider: "openrouter", openrouterModel: id });
  }

  const { provider } = activeProvider(settings);
  const onOpenRouter = provider.id === "openrouter";
  const featuredIds = new Set(FEATURED_MODELS.map((m) => m.id));
  // Text models only (drop pure image generators).
  const rest = orModels.filter((m) => m.outputText && !featuredIds.has(m.id));
  const listed = new Set(
    onOpenRouter ? [...featuredIds, ...orModels.map((m) => m.id)] : directModels.map((m) => m.id)
  );
  const current = settings.provider === "openrouter" ? settings.openrouterModel : "";
  // The selection stays visible even when the list does not have it (still
  // loading, or picked before a switch) — a picker that cannot show what is
  // selected is worse than one showing an odd choice.
  const orphan = current && !listed.has(current) ? current : "";

  return (
    <div className="model-select">
      <select
        className="chat-model"
        value={value}
        onChange={(e) => select(e.target.value)}
        onMouseDown={() => onRefresh()}
      >
        {!onOpenRouter && (
          // Prefixed ids ("google:…") ride the openrouter branch of `select`
          // to reach `openrouterModel`; the prefix sends the request to the
          // provider itself.
          <optgroup label={provider.label}>
            {orphan && <option value={`openrouter|${orphan}`}>{orphan.replace(/^[a-z]+:/, "")}</option>}
            {directModels.map((m) => (
              <option key={m.id} value={`openrouter|${m.id}`}>
                {m.name}
              </option>
            ))}
            {directModels.length === 0 && (
              <option value="openrouter|" disabled>
                {directLoading
                  ? "Loading models…"
                  : directError
                    ? `Couldn't load models: ${directError}`
                    : `Add a ${provider.label} key in Settings`}
              </option>
            )}
          </optgroup>
        )}
        {onOpenRouter && (
          <optgroup label="OpenRouter · Featured">
            {orphan && <option value={`openrouter|${orphan}`}>{orphan}</option>}
            {FEATURED_MODELS.map((m) => (
              <option key={m.id} value={`openrouter|${m.id}`} title={m.note}>
                {m.label} — {m.note}
              </option>
            ))}
          </optgroup>
        )}
        {onOpenRouter && rest.length > 0 && (
          <optgroup label={`OpenRouter · All ${rest.length} (newest first)`}>
            {rest.map((m) => (
              <option key={m.id} value={`openrouter|${m.id}`}>
                {m.id}
              </option>
            ))}
          </optgroup>
        )}
        {ollamaModels.length > 0 && (
          <optgroup label="On this Mac (Ollama)">
            {ollamaModels.map((m) => (
              <option key={m} value={`ollama|${m}`}>
                {m}
              </option>
            ))}
          </optgroup>
        )}
        {settings.provider === "ollama" && !ollamaModels.includes(settings.ollamaModel) && (
          <option value={`ollama|${settings.ollamaModel}`}>{settings.ollamaModel || "No local model"}</option>
        )}
      </select>
    </div>
  );
}
