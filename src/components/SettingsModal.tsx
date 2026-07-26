import type { Settings } from "../lib/settings";
import AgentSettings from "./AgentSettings";
import Diagnostics from "./Diagnostics";
import RemoteAccess from "./RemoteAccess";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

export default function SettingsModal({ settings, onChange, onClose }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="modal-body">
          <p className="hint">
            Global settings. Model &amp; writing options live in each tab (⚙ in Write,
            model picker in every tab).
          </p>

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
          </section>

          <p className="hint">
            Local models run through Ollama — install them with <b>Local models</b> next
            to any model picker. No URLs to configure.
          </p>

          <AgentSettings settings={settings} onChange={onChange} />

          <RemoteAccess settings={settings} onChange={onChange} />

          <Diagnostics />
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
