// The Settings window.
//
// Tabbed rather than one long scroll. The sections here have nothing to do with
// each other — how the app looks, what the screen assistant may do to your Mac,
// which keys it holds, what your phone can reach — and stacking them meant
// scrolling past three unrelated panels to reach the one you came for.
import { useState } from "react";
import type { Settings } from "../lib/settings";
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
                <h3>OpenRouter (bring your own key)</h3>
                <label>API key</label>
                <input
                  type="password"
                  placeholder="sk-or-v1-…"
                  value={settings.openrouterKey}
                  onChange={(e) => onChange({ openrouterKey: e.target.value.trim() })}
                />
                <p className="hint">
                  Stored locally on this machine only. Get a key at openrouter.ai/keys.
                </p>
                <p className="hint">
                  Local models run through Ollama — install them with <b>Local models</b>{" "}
                  next to any model picker. No URLs to configure.
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
