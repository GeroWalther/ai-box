import { useEffect, useState } from "react";
import { IMAGE_MODEL_RECS, recommendForRam } from "../lib/presets";
import { downloadFile, systemInfo, type SystemInfo } from "../lib/api";

interface Props {
  onClose: () => void;
  onChanged: () => void;
}

const CKPT_DIR = "~/ComfyUI/models/checkpoints";

export default function ImageModelManager({ onClose, onChanged }: Props) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [sys, setSys] = useState<SystemInfo | null>(null);

  useEffect(() => {
    systemInfo().then(setSys).catch(() => {});
  }, []);
  const rec = sys ? recommendForRam(sys.ramGb) : null;

  async function install() {
    if (!url.trim() || busy) return;
    let file = name.trim();
    if (!file) {
      const guess = url.split("?")[0].split("/").pop() || "model.safetensors";
      file = guess.endsWith(".safetensors") ? guess : "model.safetensors";
    }
    setBusy(true);
    setProgress("starting…");
    try {
      await downloadFile(url.trim(), `${CKPT_DIR}/${file}`, (line) => setProgress(line));
      setProgress("done — click Refresh in the model list");
      onChanged();
    } catch (e) {
      setProgress(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Image models</h2>
          <button className="btn ghost" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {sys && rec && (
            <div className="machine-panel">
              <div className="machine-head">
                {sys.chip} · {sys.ramGb.toFixed(0)} GB — recommended: {rec.image}
              </div>
              <div className="hint">
                SDXL-based checkpoints are the sweet spot for your machine.
              </div>
            </div>
          )}

          <h3>Recommended by style</h3>
          <div className="model-list">
            {IMAGE_MODEL_RECS.map((m) => (
              <div key={m.name} className="model-row">
                <div className="model-meta">
                  <div className="model-name">
                    {m.name} {m.nsfw && <span className="nsfw-tag">NSFW</span>}
                  </div>
                  <div className="model-sub">
                    {m.style} · {m.base} — {m.note}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <section>
            <h3>Install a checkpoint</h3>
            <p className="hint">
              Paste a direct <code>.safetensors</code> URL. For Civitai models, copy the
              download link and append <code>?token=YOUR_TOKEN</code> (Account → API Keys).
              Saved to <code>{CKPT_DIR}</code>.
            </p>
            <label>Download URL</label>
            <input
              placeholder="https://civitai.com/api/download/models/…?token=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <label>Save as (optional filename)</label>
            <input
              placeholder="auto from URL"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="row-inline">
              <button className="btn primary" disabled={busy || !url.trim()} onClick={install}>
                {busy ? "Downloading…" : "Install"}
              </button>
              <span className="hint">{progress}</span>
            </div>
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
