// The single place to get local image models. Each curated model has a one-click
// Download that also installs the local engine (ComfyUI + PyTorch) on first use.
// An advanced section takes any direct .safetensors URL (e.g. a Civitai model with
// your token). Everything lands in the managed install (~/.ai-studio/comfy).
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CURATED_MODELS,
  recommendForRam,
  type CuratedModel,
} from "../lib/presets";
import {
  comfyDownloadModel,
  comfyInstalledModels,
  comfyStart,
  systemInfo,
  type SystemInfo,
} from "../lib/api";
import type { Settings } from "../lib/settings";

interface Props {
  onClose: () => void;
  onChange: (patch: Partial<Settings>) => void;
  /** Re-detect models in the panel after a change. */
  onChanged: () => void;
}

export default function ImageModels({ onClose, onChange, onChanged }: Props) {
  const [installed, setInstalled] = useState<string[]>([]);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // model id being downloaded
  const [stage, setStage] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  // Advanced custom URL install.
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");

  async function refreshInstalled() {
    const list = await comfyInstalledModels().catch(() => [] as string[]);
    setInstalled(list);
  }
  useEffect(() => {
    refreshInstalled();
    systemInfo().then(setSys).catch(() => {});
  }, []);
  const rec = sys ? recommendForRam(sys.ramGb) : null;
  const busy = busyId !== null;
  const runtimeReady = installed.length > 0;

  // Download a model (installs the engine first on first run), then select it.
  async function download(id: string, modelUrl: string, file: string, apply?: Partial<Settings>) {
    if (busy) return;
    setBusyId(id);
    setError("");
    setLog([]);
    setPct(null);
    setStage("");
    try {
      await comfyDownloadModel(modelUrl, file, (p) => {
        setStage(p.stage);
        setPct(typeof p.pct === "number" ? p.pct : null);
        setLog((prev) => [...prev.slice(-120), p.message]);
      });
      await refreshInstalled();
      onChange({ imageBackend: "comfyui", comfyCheckpoint: file, ...apply });
      setStage("done");
      setLog((prev) => [...prev, "Starting ComfyUI…"]);
      await comfyStart();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  function downloadCurated(m: CuratedModel) {
    download(m.id, m.url, m.file, { imageSteps: m.steps, imageCfg: m.cfg });
  }

  // "Use" an already-downloaded model: select it + start the engine.
  async function use(file: string, apply?: Partial<Settings>) {
    onChange({ imageBackend: "comfyui", comfyCheckpoint: file, ...apply });
    setBusyId("__start__");
    setError("");
    setStage("done");
    setLog(["Starting ComfyUI…"]);
    try {
      await comfyStart();
      onChanged();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function installCustom() {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    let file = name.trim();
    if (!file) {
      const guess = trimmed.split("?")[0].split("/").pop() || "model.safetensors";
      file = guess.endsWith(".safetensors") ? guess : "model.safetensors";
    }
    await download("__custom__", trimmed, file);
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Local image models</h2>
          {!busy && (
            <button className="btn ghost" onClick={onClose}>
              ×
            </button>
          )}
        </div>

        <div className="modal-body">
          <p className="hint">
            Runs Stable Diffusion 100% on your Mac — private, unlimited, no cloud
            credits.{" "}
            {!runtimeReady && (
              <>
                Your first download also installs the local engine (~3.5&nbsp;GB,
                one time). No terminal needed.
              </>
            )}
          </p>
          {sys && rec && (
            <div className="machine-panel">
              <div className="machine-head">
                {sys.chip} · {sys.ramGb.toFixed(0)} GB — recommended: {rec.image}
              </div>
            </div>
          )}

          {/* Starting the engine (Use / after a download) */}
          {busyId === "__start__" && (
            <p className="hint">
              Starting ComfyUI… first launch loads PyTorch — up to a minute.
            </p>
          )}

          {/* Download progress (shared) */}
          {(busy || error) && busyId !== "__start__" && (
            <div className="setup-progress">
              {pct != null && (
                <div className="setup-bar">
                  <div className="setup-bar-fill" style={{ width: `${pct}%` }} />
                </div>
              )}
              <div className="hint">
                {stage === "model"
                  ? "Downloading model…"
                  : stage === "done"
                    ? "Finishing…"
                    : "Installing local engine…"}
                {pct != null ? ` ${pct}%` : ""}
              </div>
              {log.length > 0 && (
                <pre className="setup-log">{log.slice(-10).join("\n")}</pre>
              )}
            </div>
          )}
          {error && <p className="hint error">{error}</p>}

          {/* One-click curated models */}
          <h3>Models</h3>
          <div className="model-list">
            {CURATED_MODELS.map((m) => {
              const done = installed.includes(m.file);
              return (
                <div key={m.id} className="curated-row static">
                  <div className="model-meta">
                    <div className="model-name">
                      {m.label}{" "}
                      {m.recommended && <span className="rec-tag">Recommended</span>}
                      {done && <span className="model-installed"> · Installed ✓</span>}
                    </div>
                    <div className="model-sub">
                      {m.base} · {m.sizeGb} GB — {m.note}
                    </div>
                  </div>
                  {done ? (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => use(m.file, { imageSteps: m.steps, imageCfg: m.cfg })}
                    >
                      Use
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => downloadCurated(m)}
                    >
                      {busyId === m.id ? "Downloading…" : "Download"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Advanced: any direct URL (e.g. Civitai with token) */}
          <details className="advanced-models">
            <summary>Add a custom model (advanced)</summary>
            <p className="hint">
              Paste a direct <code>.safetensors</code> URL. For Civitai, copy the
              download link and append <code>?token=YOUR_TOKEN</code> (Account → API
              Keys). It downloads into your local models folder.
            </p>
            <label>Download URL</label>
            <input
              placeholder="https://…/model.safetensors?token=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <label>Save as (optional)</label>
            <input
              placeholder="auto from URL"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              className="btn primary"
              disabled={busy || !url.trim()}
              onClick={installCustom}
            >
              {busyId === "__custom__" ? "Downloading…" : "Download"}
            </button>
            <p className="hint">
              Any SDXL/SD1.5 checkpoint works — browse community models at{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  openUrl("https://civitai.com/models?types=Checkpoint");
                }}
              >
                civitai.com
              </a>{" "}
              and paste the download link above.
            </p>
          </details>
        </div>

        <div className="modal-foot">
          <button className="btn primary" disabled={busy} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
