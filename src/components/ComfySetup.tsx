// First-run wizard for local image generation. Downloads and configures a
// managed ComfyUI (Python toolchain + PyTorch + a checkpoint) with one click, so
// the user never touches a terminal. Streams live progress from `comfy_setup`.
import { useState } from "react";
import { CURATED_MODELS, type CuratedModel } from "../lib/presets";
import { comfySetup, comfyStart } from "../lib/api";
import type { Settings } from "../lib/settings";

interface Props {
  onClose: () => void;
  /** Apply model-specific generation defaults + selected checkpoint. */
  onChange: (patch: Partial<Settings>) => void;
  /** Called after setup + start succeed, so the panel can detect models. */
  onComplete: () => void;
}

const STAGES: { key: string; label: string }[] = [
  { key: "uv", label: "Python toolchain" },
  { key: "source", label: "ComfyUI" },
  { key: "deps", label: "PyTorch + dependencies" },
  { key: "model", label: "Image model" },
  { key: "done", label: "Done" },
];

export default function ComfySetup({ onClose, onChange, onComplete }: Props) {
  const recommended = CURATED_MODELS.find((m) => m.recommended) ?? CURATED_MODELS[0];
  const [picked, setPicked] = useState<CuratedModel>(recommended);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string>("");
  const [pct, setPct] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);

  const stageIndex = STAGES.findIndex((s) => s.key === stage);

  async function run() {
    setBusy(true);
    setError("");
    setLog([]);
    setPct(null);
    try {
      await comfySetup(picked.url, picked.file, (p) => {
        setStage(p.stage);
        setPct(typeof p.pct === "number" ? p.pct : null);
        setLog((prev) => [...prev.slice(-120), p.message]);
      });
      // Apply this checkpoint + its sensible generation defaults.
      onChange({
        imageBackend: "comfyui",
        comfyCheckpoint: picked.file,
        imageSteps: picked.steps,
        imageCfg: picked.cfg,
      });
      setStage("done");
      setLog((prev) => [...prev, "Starting ComfyUI…"]);
      await comfyStart();
      setFinished(true);
      onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const totalGb = picked.sizeGb + 3.5; // model + PyTorch/deps, rough

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Set up local image generation</h2>
          {!busy && (
            <button className="btn ghost" onClick={onClose}>
              ×
            </button>
          )}
        </div>

        <div className="modal-body">
          {!busy && !finished && (
            <>
              <p className="hint">
                Runs Stable Diffusion 100% on your Mac — private, unlimited, no cloud
                credits. One-time setup downloads a Python runtime, ComfyUI, and your
                chosen model (about <b>{totalGb.toFixed(0)} GB</b> total). Nothing to
                install by hand.
              </p>
              <div className="model-list">
                {CURATED_MODELS.map((m) => (
                  <label
                    key={m.id}
                    className={
                      picked.id === m.id ? "curated-row selected" : "curated-row"
                    }
                  >
                    <input
                      type="radio"
                      name="curated-model"
                      checked={picked.id === m.id}
                      onChange={() => setPicked(m)}
                    />
                    <div className="model-meta">
                      <div className="model-name">
                        {m.label}{" "}
                        {m.recommended && <span className="rec-tag">Recommended</span>}
                      </div>
                      <div className="model-sub">
                        {m.base} · {m.sizeGb} GB — {m.note}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}

          {(busy || finished || error) && (
            <div className="setup-progress">
              <ol className="setup-steps">
                {STAGES.map((s, i) => {
                  const state =
                    finished || (stageIndex >= 0 && i < stageIndex)
                      ? "ok"
                      : i === stageIndex
                        ? "active"
                        : "todo";
                  return (
                    <li key={s.key} className={`setup-step ${state}`}>
                      <span className="setup-dot">
                        {state === "ok" ? "✓" : state === "active" ? "…" : "•"}
                      </span>
                      {s.label}
                    </li>
                  );
                })}
              </ol>

              {pct != null && !finished && (
                <div className="setup-bar">
                  <div className="setup-bar-fill" style={{ width: `${pct}%` }} />
                </div>
              )}

              {log.length > 0 && (
                <pre className="setup-log">{log.slice(-14).join("\n")}</pre>
              )}

              {error && (
                <p className="hint error">
                  {error}
                  <br />
                  You can safely retry — completed steps are skipped.
                </p>
              )}
              {finished && (
                <p className="hint ok">
                  ✓ Ready. ComfyUI is running — close this and hit Generate.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="modal-foot">
          {finished ? (
            <button className="btn primary" onClick={onClose}>
              Start generating
            </button>
          ) : (
            <>
              {!busy && (
                <button className="btn ghost" onClick={onClose}>
                  Cancel
                </button>
              )}
              <button className="btn primary" disabled={busy} onClick={run}>
                {busy
                  ? "Setting up…"
                  : error
                    ? "Retry"
                    : `Download & set up (${(picked.sizeGb + 3.5).toFixed(0)} GB)`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
