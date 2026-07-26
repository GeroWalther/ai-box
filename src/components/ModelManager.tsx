import { useEffect, useState } from "react";
import type { Settings } from "../lib/settings";
import { LOCAL_MODEL_SUGGESTIONS, recommendForRam } from "../lib/presets";
import { pullOllamaModel, systemInfo, type SystemInfo } from "../lib/api";

interface Props {
  settings: Settings;
  installed: string[];
  onClose: () => void;
  onChanged: () => void;
}

export default function ModelManager({ settings, installed, onClose, onChanged }: Props) {
  const [pulling, setPulling] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [custom, setCustom] = useState("");
  const [sys, setSys] = useState<SystemInfo | null>(null);

  useEffect(() => {
    systemInfo().then(setSys).catch(() => {});
  }, []);
  const rec = sys ? recommendForRam(sys.ramGb) : null;

  async function pull(id: string) {
    if (pulling) return;
    setPulling(id);
    setError("");
    setProgress(`Pulling ${id}: starting…`);
    try {
      await pullOllamaModel(settings.ollamaUrl, id, (line) => setProgress(`Pulling ${id}: ${line}`));
      setProgress(`${id} — done ✓`);
      onChanged();
    } catch (e) {
      const msg = String(e);
      // A connection failure means the Ollama server isn't up. Say so plainly.
      setError(
        /refused|sending request|connect|error trying|dns|failed to fetch/i.test(msg)
          ? "Ollama isn't running. Open the Ollama app (or run “ollama serve” in Terminal), then try again."
          : msg
      );
      setProgress("");
    } finally {
      setPulling(null);
    }
  }

  const isInstalled = (id: string) =>
    installed.some((m) => m === id || m.startsWith(id + ":") || m === id + ":latest");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Local models</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close local models">
            ×
          </button>
        </div>

        <div className="modal-body">
          {sys && rec && (
            <div className="machine-panel">
              <div className="machine-head">
                {sys.chip} · {sys.ramGb.toFixed(0)} GB unified memory
              </div>
              <div className="machine-rec">
                <div>
                  <b>Chat &amp; Writing (local):</b> up to {rec.text}
                </div>
                <div>
                  <b>Images (local):</b> {rec.image}
                </div>
                <div className="hint">
                  For best writing quality (esp. Japanese), use OpenRouter instead — it
                  costs no local memory.
                </div>
              </div>
            </div>
          )}
          <p className="hint">
            Models run fully offline via Ollama. Pulling downloads once. Sizes suit your machine.
          </p>

          {(
            [
              ["fiction", "For writing — private & unfiltered"],
              ["general", "General"],
              ["reasoning", "Reasoning"],
              ["code", "Code"],
            ] as const
          ).map(([cat, heading]) => {
            const models = LOCAL_MODEL_SUGGESTIONS.filter((m) => m.category === cat);
            if (!models.length) return null;
            return (
              <div key={cat} className="model-group">
                <div className="model-group-head">{heading}</div>
                <div className="model-list">
                  {models.map((m) => {
                    const here = isInstalled(m.id);
                    const tooBig = sys ? (m.ram ?? 8) > sys.ramGb : false;
                    return (
                      <div key={m.id} className="model-row">
                        <div className="model-meta">
                          <div className="model-name">
                            {m.label}
                            {tooBig && <span className="model-tag warn"> · needs {m.ram} GB</span>}
                          </div>
                          <div className="model-sub">
                            {m.purpose} · {m.size} · <code>{m.id}</code>
                          </div>
                        </div>
                        {here ? (
                          <span className="model-installed">installed</span>
                        ) : (
                          <button className="btn" disabled={!!pulling} onClick={() => pull(m.id)}>
                            {pulling === m.id ? "…" : "Get"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {progress && <p className="hint">{progress}</p>}
          {error && <p className="hint error">{error}</p>}

          <section>
            <h3>Add any Ollama model</h3>
            <div className="row-inline">
              <input
                placeholder="e.g. gemma2:9b, phi4, mistral-small"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
              <button
                className="btn"
                disabled={!!pulling || !custom.trim()}
                onClick={() => pull(custom.trim())}
              >
                Get
              </button>
            </div>
            <p className="hint">Browse the catalog at ollama.com/library.</p>
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
