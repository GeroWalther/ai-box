import { useEffect, useState } from "react";
import type { Settings } from "../lib/settings";
import {
  COMFY_SAMPLERS,
  COMFY_SCHEDULERS,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_IMAGE_EDIT_MODELS,
  IMAGE_RESOLUTIONS,
  IMAGE_ASPECTS,
} from "../lib/presets";
import {
  generateImageComfy,
  generateImg2imgComfy,
  generateImageOpenrouter,
  editImageOpenrouter,
  listComfyCheckpoints,
} from "../lib/api";
import { addImage, allImages, deleteImage, type ImageRecord } from "../lib/imageStore";
import ImageModelManager from "./ImageModelManager";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export default function ImagePanel({ settings, onChange }: Props) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [sourceImage, setSourceImage] = useState<string | null>(null); // data URL
  const [strength, setStrength] = useState(0.6);
  const [showImgModels, setShowImgModels] = useState(false);
  const [history, setHistory] = useState<ImageRecord[]>([]);

  // Load the saved gallery once; show the newest as the current image.
  useEffect(() => {
    allImages()
      .then((rows) => {
        setHistory(rows);
        if (rows.length) setImage(rows[0].dataUrl);
      })
      .catch(() => {});
  }, []);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSourceImage(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = ""; // allow re-selecting the same file later
  }

  // Detect installed models on open, and auto-pick one if none is valid.
  async function detect() {
    try {
      const list = await listComfyCheckpoints(settings.comfyUrl);
      setCheckpoints(list);
      if (list.length && !list.includes(settings.comfyCheckpoint)) {
        onChange({ comfyCheckpoint: list[0] });
      }
      setError(list.length ? "" : "No models found. Drop a .safetensors into ~/ComfyUI/models/checkpoints/");
    } catch {
      setError("ComfyUI isn't running. Start it, then click Refresh.");
    }
  }

  useEffect(() => {
    detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (!prompt.trim() || busy) return;
    const isCloud = settings.imageBackend === "openrouter";
    if (isCloud && !settings.openrouterKey) {
      setError("Add your OpenRouter API key in Settings.");
      return;
    }
    if (!isCloud && !settings.comfyCheckpoint) {
      setError("No model selected — click Refresh to detect one.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const b64 = isCloud
        ? sourceImage
          ? await editImageOpenrouter({
              apiKey: settings.openrouterKey,
              model: settings.openrouterImageModel,
              prompt,
              imageBase64: sourceImage.split(",")[1],
            })
          : await generateImageOpenrouter({
              apiKey: settings.openrouterKey,
              model: settings.openrouterImageModel,
              prompt,
              resolution: settings.imageResolution,
              aspectRatio: settings.imageAspect,
            })
        : sourceImage
        ? await generateImg2imgComfy({
            baseUrl: settings.comfyUrl,
            checkpoint: settings.comfyCheckpoint,
            prompt,
            negativePrompt: settings.imageNegative,
            steps: settings.imageSteps,
            cfgScale: settings.imageCfg,
            samplerName: settings.comfySampler,
            scheduler: settings.comfyScheduler,
            denoise: strength,
            imageBase64: sourceImage.split(",")[1],
          })
        : await generateImageComfy({
            baseUrl: settings.comfyUrl,
            checkpoint: settings.comfyCheckpoint,
            prompt,
            negativePrompt: settings.imageNegative,
            steps: settings.imageSteps,
            width: settings.imageWidth,
            height: settings.imageHeight,
            cfgScale: settings.imageCfg,
            samplerName: settings.comfySampler,
            scheduler: settings.comfyScheduler,
          });
      const dataUrl = `data:image/png;base64,${b64}`;
      setImage(dataUrl);
      const rec: ImageRecord = {
        id: crypto.randomUUID(),
        prompt,
        backend: isCloud ? "openrouter" : "comfyui",
        model: isCloud ? settings.openrouterImageModel : settings.comfyCheckpoint,
        dataUrl,
        at: Date.now(),
      };
      setHistory((prev) => [rec, ...prev]);
      addImage(rec).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function openHistory(rec: ImageRecord) {
    setImage(rec.dataUrl);
    setPrompt(rec.prompt);
  }
  async function removeHistory(id: string) {
    setHistory((prev) => prev.filter((r) => r.id !== id));
    await deleteImage(id).catch(() => {});
  }

  function save() {
    if (!image) return;
    const a = document.createElement("a");
    a.href = image;
    a.download = "novel-studio-image.png";
    a.click();
  }

  const isCloud = settings.imageBackend === "openrouter";

  return (
    <div className="image-tab">
      <aside className="image-history">
        <div className="image-history-head">History</div>
        <div className="image-history-list">
          {history.length === 0 && (
            <div className="image-history-empty">Your generations appear here.</div>
          )}
          {history.map((r) => (
            <div
              key={r.id}
              className={image === r.dataUrl ? "history-thumb active" : "history-thumb"}
              onClick={() => openHistory(r)}
              title={r.prompt}
            >
              <img src={r.dataUrl} alt={r.prompt} />
              <button
                className="history-del"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  removeHistory(r.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="image-controls-col">
        <div className="field">
          <label>Where</label>
          <div className="segmented">
            <button
              className={!isCloud ? "seg active" : "seg"}
              onClick={() => onChange({ imageBackend: "comfyui" })}
            >
              Local (ComfyUI)
            </button>
            <button
              className={isCloud ? "seg active" : "seg"}
              onClick={() => onChange({ imageBackend: "openrouter" })}
            >
              Cloud (OpenRouter)
            </button>
          </div>
        </div>

        {isCloud ? (
          <>
            <div className="field">
              <label>Model</label>
              <select
                value={settings.openrouterImageModel}
                onChange={(e) => onChange({ openrouterImageModel: e.target.value })}
              >
                {OPENROUTER_IMAGE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {!OPENROUTER_IMAGE_MODELS.includes(settings.openrouterImageModel) &&
                  settings.openrouterImageModel && (
                    <option value={settings.openrouterImageModel}>
                      {settings.openrouterImageModel}
                    </option>
                  )}
              </select>
            </div>
            <div className="row-2">
              <div className="field">
                <label>Resolution</label>
                <select
                  value={settings.imageResolution}
                  onChange={(e) => onChange({ imageResolution: e.target.value })}
                >
                  {IMAGE_RESOLUTIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Aspect</label>
                <select
                  value={settings.imageAspect}
                  onChange={(e) => onChange({ imageAspect: e.target.value })}
                >
                  {IMAGE_ASPECTS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="hint">
              Uses your OpenRouter key. Cloud models are high quality but most
              filter explicit content — use Local (ComfyUI) for NSFW.
            </p>
          </>
        ) : (
          <div className="field">
            <label>Model</label>
            <div className="row-inline">
              <select
                value={settings.comfyCheckpoint}
                onChange={(e) => onChange({ comfyCheckpoint: e.target.value })}
              >
                {checkpoints.length === 0 && <option value="">— none detected —</option>}
                {checkpoints.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={detect} title="Detect installed models">
                Refresh
              </button>
              <button
                className="btn"
                onClick={() => setShowImgModels(true)}
                title="Get more models"
              >
                Get models
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <label>Prompt</label>
          <textarea
            rows={5}
            placeholder="masterpiece, best quality, a woman by a rain-streaked Tokyo window at night, soft light…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Reference image <span className="muted">(optional — transform it)</span></label>
          {sourceImage ? (
            <div className="source-row">
              <img className="source-thumb" src={sourceImage} alt="reference" />
              <div className="source-ctrl">
                {!isCloud && (
                  <>
                    <label>
                      Change amount {strength.toFixed(2)}{" "}
                      <span className="muted">(low = keep it, high = reinvent)</span>
                    </label>
                    <input
                      type="range"
                      min={0.2}
                      max={0.95}
                      step={0.05}
                      value={strength}
                      onChange={(e) => setStrength(Number(e.target.value))}
                    />
                  </>
                )}
                <button className="btn" onClick={() => setSourceImage(null)}>
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <label className="upload-drop">
              <input type="file" accept="image/*" onChange={onFile} hidden />
              + Upload an image
            </label>
          )}
          {isCloud && sourceImage &&
            !OPENROUTER_IMAGE_EDIT_MODELS.includes(settings.openrouterImageModel) && (
              <p className="hint error">
                This model can't edit images. Pick an edit-capable model:{" "}
                {OPENROUTER_IMAGE_EDIT_MODELS.join(", ")}.
              </p>
            )}
          {isCloud && (
            <p className="hint">
              Cloud editing works with image-input models (Gemini Flash Image, FLUX
              Kontext, GPT-Image-1). Describe the change in the prompt.
            </p>
          )}
        </div>

        <button className="btn primary big" onClick={run} disabled={busy}>
          {busy ? "Generating…" : sourceImage ? "Transform image" : "Generate"}
        </button>
        {error && <p className="hint error">{error}</p>}

        {!isCloud && (
          <button
            className="advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "▾" : "▸"} Advanced
          </button>
        )}

        {!isCloud && showAdvanced && (
          <div className="advanced">
            <div className="field">
              <label>Negative prompt</label>
              <textarea
                rows={2}
                value={settings.imageNegative}
                onChange={(e) => onChange({ imageNegative: e.target.value })}
              />
            </div>
            <div className="row-2">
              <div className="field">
                <label>Width</label>
                <input
                  type="number"
                  step={64}
                  value={settings.imageWidth}
                  onChange={(e) => onChange({ imageWidth: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>Height</label>
                <input
                  type="number"
                  step={64}
                  value={settings.imageHeight}
                  onChange={(e) => onChange({ imageHeight: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="row-2">
              <div className="field">
                <label>Steps ({settings.imageSteps})</label>
                <input
                  type="range"
                  min={10}
                  max={50}
                  value={settings.imageSteps}
                  onChange={(e) => onChange({ imageSteps: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>CFG ({settings.imageCfg})</label>
                <input
                  type="range"
                  min={1}
                  max={15}
                  step={0.5}
                  value={settings.imageCfg}
                  onChange={(e) => onChange({ imageCfg: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="row-2">
              <div className="field">
                <label>Sampler</label>
                <select
                  value={settings.comfySampler}
                  onChange={(e) => onChange({ comfySampler: e.target.value })}
                >
                  {COMFY_SAMPLERS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Scheduler</label>
                <select
                  value={settings.comfyScheduler}
                  onChange={(e) => onChange({ comfyScheduler: e.target.value })}
                >
                  {COMFY_SCHEDULERS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label>ComfyUI URL</label>
              <input
                value={settings.comfyUrl}
                onChange={(e) => onChange({ comfyUrl: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>

      <div className="image-preview-col">
        {busy ? (
          <div className="image-loading">
            <div className="spinner" />
            <div className="loading-title">
              {sourceImage ? "Transforming…" : "Generating…"}
            </div>
            <div className="loading-sub">
              Running locally on your Mac. The first image after launching (or
              switching models) loads the model into memory — that one takes
              ~30–60&nbsp;s; the rest are ~20–40&nbsp;s each.
            </div>
          </div>
        ) : image ? (
          <>
            <img src={image} alt="generated" />
            <button className="btn" onClick={save}>
              Save PNG
            </button>
          </>
        ) : (
          <div className="image-placeholder">
            Your image appears here.
            <br />
            Runs locally on your Mac — nothing is uploaded.
          </div>
        )}
      </div>

      {showImgModels && (
        <ImageModelManager
          onClose={() => setShowImgModels(false)}
          onChanged={detect}
        />
      )}
    </div>
  );
}
