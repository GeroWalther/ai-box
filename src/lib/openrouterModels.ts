// Live OpenRouter catalog with a localStorage cache so the picker is instant on
// launch and refreshes in the background. Shared by Chat and Write.
import { useCallback, useEffect, useState } from "react";
import { listOpenrouterModels, type OpenrouterModel } from "./api";

const CACHE_KEY = "ai-studio.openrouter-models";

function readCache(): OpenrouterModel[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

export function useOpenrouterModels(apiKey: string) {
  const [models, setModels] = useState<OpenrouterModel[]>(readCache);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listOpenrouterModels(apiKey);
      if (list.length) {
        setModels(list);
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), models: list }));
      }
    } catch {
      /* keep whatever's cached */
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  // Show cache instantly, refresh once in the background on mount.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { models, refresh, loading };
}
