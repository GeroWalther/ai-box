// The models the app may currently offer: the active provider's, and nothing
// from any other. Local Ollama models are listed separately by each picker,
// because they are always available whatever the provider.
//
// One hook, so every picker agrees. Switching provider in Settings changes what
// Agentic Chat, Write and Screen Assist offer at the same moment.
import { useEffect, useState } from "react";
import { listProviderModels, type ProviderModel } from "../lib/api";
import { activeProvider, type Settings } from "../lib/settings";
import { logError } from "../lib/log";

export interface ActiveModels {
  /** The active provider's models, or empty while loading, keyless or failed. */
  models: ProviderModel[];
  /** True while the list is being fetched, so a picker can say so rather than
   *  looking empty — an empty list and a slow one look identical otherwise. */
  loading: boolean;
  /** Set when the provider refused the key, for the panel to show. */
  error: string;
}

export function useDirectModels(settings: Settings): ActiveModels {
  const { provider, apiKey } = activeProvider(settings);
  const [state, setState] = useState<ActiveModels>({
    models: [],
    loading: false,
    error: "",
  });

  useEffect(() => {
    // OpenRouter has its own long-standing listing path with its own cache;
    // this hook covers the direct providers only.
    if (provider.id === "openrouter" || !apiKey) {
      setState({ models: [], loading: false, error: "" });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: "" }));
    listProviderModels(provider.id, apiKey)
      .then((models) => {
        if (!cancelled) setState({ models, loading: false, error: "" });
      })
      .catch((e) => {
        logError(`models.${provider.id}`, e);
        if (!cancelled) {
          setState({ models: [], loading: false, error: String(e).replace(/^Error:\s*/, "") });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [provider.id, apiKey]);

  return state;
}
