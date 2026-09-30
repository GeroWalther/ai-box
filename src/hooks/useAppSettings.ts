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
  mergeBroadcast,
  saveSecrets,
  touchesSecrets,
  saveSettings,
  SETTINGS_EVENT,
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
        if (Object.keys(migrated).length) await saveSecrets({ ...loaded, ...secrets, ...migrated });
        // Merged onto the CURRENT settings, not the copy loaded before the
        // keychain was read. Anything set in between — the phone pairing token,
        // minted on startup when there is none — used to be overwritten here, so
        // every launch minted a new one and locked every paired phone out.
        setSettings((prev) => {
          const next = { ...prev, ...secrets, ...migrated };
          saveSettings(next); // rewrites localStorage without the keys
          publish(next);
          return next;
        });
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

  // Another window changed something — the overlay's gear, most often. Merged
  // into state but deliberately NOT saved again: the window that changed it has
  // already written to disk, and re-saving here would bounce the broadcast back
  // and forth between the two.
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then((m) =>
        m.listen<Partial<Settings>>(SETTINGS_EVENT, (e) => {
          if (e.payload && typeof e.payload === "object") {
            setSettings((prev) => mergeBroadcast(prev, e.payload));
          }
        })
      )
      .then((un) => {
        stop = un;
      })
      .catch((e) => logError("settings.listen", e));
    return () => stop?.();
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      publish(next);
      // Only touch the keychain when a key actually changed — any of them. This
      // used to name only the OpenRouter and custom keys, so a Google, Anthropic
      // or OpenAI key lived in this window's memory and nowhere else: gone on
      // restart, and never visible to the Screen Assist window at all.
      if (touchesSecrets(patch)) void saveSecrets(next);
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
