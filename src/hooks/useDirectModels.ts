// Models from providers the user has given a key to.
//
// One hook shared by every picker, because the pickers must agree: a key added
// in Settings should light up the same models in Agentic Chat, in Write and in
// Screen Assist, and a key removed should take them away everywhere at once.
import { useEffect, useState } from "react";
import { listProviderModels, type ProviderModel } from "../lib/api";
import { DIRECT_PROVIDERS, type Settings } from "../lib/settings";
import { logError } from "../lib/log";

/** Provider id → its models. A provider with no key is simply absent. */
export function useDirectModels(settings: Settings): Record<string, ProviderModel[]> {
  const [models, setModels] = useState<Record<string, ProviderModel[]>>({});

  // Depends on the KEYS, not on the settings object: this fires a network
  // request per provider, and settings change on every keystroke elsewhere.
  const keys = DIRECT_PROVIDERS.map((p) => String(settings[p.key] ?? "").trim());

  useEffect(() => {
    let cancelled = false;
    for (const [i, p] of DIRECT_PROVIDERS.entries()) {
      const key = keys[i];
      if (!key) {
        setModels((prev) => (prev[p.id]?.length ? { ...prev, [p.id]: [] } : prev));
        continue;
      }
      listProviderModels(p.id, key)
        .then((list) => {
          if (!cancelled) setModels((prev) => ({ ...prev, [p.id]: list }));
        })
        .catch((e) => {
          // A bad or expired key must not empty the other providers, and must
          // not be silent either — it is the likeliest reason a group is
          // missing from the picker.
          logError(`models.${p.id}`, e);
          if (!cancelled) setModels((prev) => ({ ...prev, [p.id]: [] }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, keys);

  return models;
}
