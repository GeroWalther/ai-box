// Settings state, plus the asymmetric startup both devices need.
//
// Desktop: load from localStorage, hydrate API keys out of the OS keychain
// (migrating any legacy plaintext key), scrub the plaintext copy, then publish
// the result so a paired phone and the Rust guard both see current settings.
//
// Phone: adopt the Mac's settings wholesale instead of this device's empty
// defaults, so pairing a phone "just works" with whatever the Mac is set up with.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  loadSecrets,
  loadSettings,
  saveSecrets,
  saveSettings,
  type Settings,
} from "../lib/settings";
import { invokeCmd, isTauri } from "../lib/transport";
import { logError } from "../lib/log";

/** Publish settings to the Rust side: read by a paired phone AND by the tool guard. */
function publish(s: Settings): void {
  if (!isTauri()) return;
  invokeCmd("set_remote_settings", { settings: JSON.stringify(s) }).catch((e) =>
    logError("settings.publish", e)
  );
}

export function useAppSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  /** True once saved settings (including the pairing token) have loaded. */
  const [hydrated, setHydrated] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  // React StrictMode double-invokes effects in dev; hydrating once is enough and
  // avoids duplicate keychain reads (each of which can prompt).
  const didInit = useRef(false);

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;

    const loaded = loadSettings();
    setSettings(loaded);
    setHydrated(true);

    if (isTauri()) {
      // Onboarding is a desktop-only concern — the phone adopts the Mac's setup.
      if (!loaded.onboarded) setNeedsOnboarding(true);
      void (async () => {
        const secrets = await loadSecrets();
        const migrated: Partial<Settings> = {};
        for (const k of ["openrouterKey", "customKey"] as const) {
          if (!secrets[k] && loaded[k]) migrated[k] = loaded[k]; // legacy → keychain
        }
        const next = { ...loaded, ...secrets, ...migrated };
        if (Object.keys(migrated).length) await saveSecrets(next);
        saveSettings(next); // rewrites localStorage without the keys
        setSettings(next);
        publish(next);
      })();
      return;
    }

    invokeCmd<Partial<Settings> | null>("get_remote_settings")
      .then((remote) => {
        if (remote && typeof remote === "object") {
          setSettings((prev) => {
            const merged = { ...prev, ...remote };
            saveSettings(merged);
            return merged;
          });
        }
      })
      .catch((e) => logError("settings.adopt", e));
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      publish(next);
      // Only touch the keychain when a key actually changed.
      if ("openrouterKey" in patch || "customKey" in patch) void saveSecrets(next);
      return next;
    });
  }, []);

  /** Re-read the Mac's settings (phone only; the desktop is the source of truth). */
  const adoptRemote = useCallback(async () => {
    if (isTauri()) return;
    try {
      const remote = await invokeCmd<Partial<Settings> | null>("get_remote_settings");
      if (remote && typeof remote === "object") {
        setSettings((prev) => {
          const merged = { ...prev, ...remote };
          saveSettings(merged);
          return merged;
        });
      }
    } catch (e) {
      logError("settings.adopt", e);
    }
  }, []);

  return {
    settings,
    update,
    hydrated,
    needsOnboarding,
    dismissOnboarding: () => setNeedsOnboarding(false),
    adoptRemote,
  };
}
