import type { Settings } from "../lib/settings";
import { LANGUAGES } from "../lib/presets";

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
          <button className="btn ghost" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <p className="hint">
            Keys &amp; endpoints live here. Pick the actual <b>model</b> in each tab
            (Chat, Write, Images) — not here.
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
              placeholder="sk-or-…"
              value={settings.openrouterKey}
              onChange={(e) => onChange({ openrouterKey: e.target.value })}
            />
            <p className="hint">
              Stored locally on this machine only. Get a key at openrouter.ai/keys.
            </p>
          </section>

          <p className="hint">
            Local models run through Ollama automatically — install or switch them
            with the <b>Models</b> button in the Chat tab. No URLs to configure.
          </p>

          <section>
            <h3>Writing defaults</h3>
            <label>Language</label>
            <select
              value={settings.language}
              onChange={(e) => onChange({ language: e.target.value })}
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l === "auto" ? "Auto (match text)" : l}
                </option>
              ))}
            </select>
            <label>Passage length ({settings.wordTarget} words)</label>
            <input
              type="range"
              min={60}
              max={600}
              step={20}
              value={settings.wordTarget}
              onChange={(e) => onChange({ wordTarget: Number(e.target.value) })}
            />
            <label>Creativity ({settings.temperature.toFixed(2)})</label>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={settings.temperature}
              onChange={(e) => onChange({ temperature: Number(e.target.value) })}
            />
            <label>Style note (optional — persistent tone / POV)</label>
            <textarea
              rows={2}
              placeholder="e.g. refined, sensual, literary; first person, present tense…"
              value={settings.authorsNote}
              onChange={(e) => onChange({ authorsNote: e.target.value })}
            />
            <label>Max tokens per passage ({settings.maxTokens})</label>
            <input
              type="range"
              min={100}
              max={2000}
              step={50}
              value={settings.maxTokens}
              onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
            />
          </section>
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
