// The Settings window.
//
// Tabbed rather than one long scroll. The sections here have nothing to do with
// each other — how the app looks, what the screen assistant may do to your Mac,
// which keys it holds, what your phone can reach — and stacking them meant
// scrolling past three unrelated panels to reach the one you came for.
import { useState } from "react";
import { PROVIDERS, activeProvider, type Settings } from "../lib/settings";
import { useDirectModels } from "../hooks/useDirectModels";
import AgentSettings from "./AgentSettings";
import AssistSettings from "./AssistSettings";
import Diagnostics from "./Diagnostics";
import RemoteAccess from "./RemoteAccess";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

type Tab = "general" | "assist" | "agent" | "remote" | "about";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "assist", label: "Screen Assist" },
  { id: "agent", label: "Agent" },
  { id: "remote", label: "Devices" },
  { id: "about", label: "Diagnostics" },
];

export default function SettingsModal({ settings, onChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const active = activeProvider(settings);
  // Only to report the key's state: how many models it brought back, or that it
  // was refused. A key that types cleanly and then silently does nothing is the
  // failure this prevents.
  const directModels = useDirectModels(settings);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="modal-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "modal-tab active" : "modal-tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === "general" && (
            <>
              <section>
                <h3>Appearance</h3>
                <div className="segmented">
                  <button
                    className={settings.theme === "light" ? "seg active" : "seg"}
                    onClick={() => onChange({ theme: "light" })}
                  >
                    Light
                  </button>
                  <button
                    className={settings.theme === "dark" ? "seg active" : "seg"}
                    onClick={() => onChange({ theme: "dark" })}
                  >
                    Dark
                  </button>
                </div>
              </section>

              <section>
                <h3>Provider</h3>
                <p className="hint">
                  One at a time. Whichever you pick is what every model picker in
                  the app offers — plus anything installed locally, which is always
                  available. Keys for the others stay saved, so switching back is
                  one click.
                </p>
                <div className="provider-picks">
                  {PROVIDERS.map((p) => {
                    const chosen = settings.activeProvider === p.id;
                    const hasKey = String(settings[p.key] ?? "").trim() !== "";
                    return (
                      <button
                        key={p.id}
                        className={chosen ? "provider-pick active" : "provider-pick"}
                        onClick={() => onChange({ activeProvider: p.id })}
                      >
                        <b>{p.label}</b>
                        <span>{p.blurb}</span>
                        {hasKey && !chosen && <i>key saved</i>}
                      </button>
                    );
                  })}
                </div>

                <label>{active.provider.label} API key</label>
                <input
                  type="password"
                  placeholder={`Key from ${active.provider.hint}`}
                  value={String(settings[active.provider.key] ?? "")}
                  onChange={(e) =>
                    onChange({ [active.provider.key]: e.target.value.trim() })
                  }
                />
                {active.apiKey === "" ? (
                  <p className="hint">
                    Get a key at {active.provider.hint}. Kept in the macOS keychain —
                    never in a file, and never sent anywhere but {active.provider.label}.
                  </p>
                ) : active.provider.id === "openrouter" ? (
                  <p className="hint">
                    Kept in the macOS keychain. Get a key at {active.provider.hint}.
                  </p>
                ) : directModels.loading ? (
                  <p className="hint">Checking the key…</p>
                ) : directModels.error ? (
                  <p className="hint error">{directModels.error}</p>
                ) : (
                  <p className="hint">
                    {directModels.models.length} models available on this key.
                  </p>
                )}

                <p className="hint">
                  Local models run through Ollama — install them with{" "}
                  <b>Local models</b> next to any model picker. They are offered
                  whichever provider is active, and nothing about them is billed.
                </p>
              </section>

              <p className="hint">
                Model &amp; writing options live in each tab of the app itself (⚙ in
                Write, a model picker in every tab).
              </p>
            </>
          )}

          {tab === "assist" && <AssistSettings settings={settings} onChange={onChange} />}
          {tab === "agent" && <AgentSettings settings={settings} onChange={onChange} />}
          {tab === "remote" && <RemoteAccess settings={settings} onChange={onChange} />}
          {tab === "about" && <Diagnostics />}
        </div>

        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
