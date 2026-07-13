// First-run onboarding: pick a provider and get a model working, then dismiss.
// Cloud (OpenRouter) needs a key; Local (Ollama) points at the Models installer.
import { useState } from "react";
import type { Provider, Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onOpenModels: () => void;
  onClose: () => void;
}

export default function Onboarding({ settings, onChange, onOpenModels, onClose }: Props) {
  const [choice, setChoice] = useState<Provider>("openrouter");

  function finish() {
    onChange({ onboarded: true });
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <div className="modal onboarding" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Welcome to AI Studio</h2>
        </div>
        <div className="modal-body">
          <p className="hint">
            AI Studio writes fiction, chats &amp; acts as an agent on your Mac, and
            generates images. Pick how you want to run models to get started.
          </p>

          <div className="onboard-choices">
            <button
              className={choice === "openrouter" ? "onboard-card active" : "onboard-card"}
              onClick={() => setChoice("openrouter")}
            >
              <div className="onboard-card-title">☁️ Cloud — OpenRouter</div>
              <div className="onboard-card-sub">
                One key, hundreds of models (Fable 5, uncensored models, and more).
                Best quality, pay per token.
              </div>
            </button>
            <button
              className={choice === "ollama" ? "onboard-card active" : "onboard-card"}
              onClick={() => setChoice("ollama")}
            >
              <div className="onboard-card-title">💻 Local — Ollama</div>
              <div className="onboard-card-sub">
                Fully offline &amp; free, no content limits. Runs on your Mac's memory.
              </div>
            </button>
          </div>

          {choice === "openrouter" ? (
            <div className="onboard-step">
              <label>Paste your OpenRouter API key</label>
              <input
                type="password"
                placeholder="sk-or-…"
                value={settings.openrouterKey}
                onChange={(e) => onChange({ openrouterKey: e.target.value, provider: "openrouter" })}
              />
              <p className="hint">
                Get one at openrouter.ai/keys — stored locally on this machine only.
              </p>
            </div>
          ) : (
            <div className="onboard-step">
              <p className="hint">
                Install Ollama from ollama.com, then download a model. The{" "}
                <b>Models</b> installer recommends sizes that fit your Mac.
              </p>
              <button
                className="btn"
                onClick={() => {
                  onChange({ provider: "ollama" });
                  onOpenModels();
                }}
              >
                Open Models installer
              </button>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={finish}>
            Skip
          </button>
          <button
            className="btn primary"
            onClick={finish}
            disabled={choice === "openrouter" && !settings.openrouterKey}
          >
            Start writing
          </button>
        </div>
      </div>
    </div>
  );
}
