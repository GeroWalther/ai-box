import { useEffect, useState } from "react";
import type { Settings } from "../lib/settings";
import {
  COMFY_SAMPLERS,
  COMFY_SCHEDULERS,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_IMAGE_MODEL_INFO,
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
  comfyStatus,
  comfyStart,
  type OpenrouterModel,
} from "../lib/api";
import ComfySetup from "./ComfySetup";
import {
  addImage,
  allImages,
  deleteImage,
  getImage,
  migrateLegacyImages,
  type ImageRecord,
} from "../lib/imageStore";
import { useToast } from "../lib/toast";
import ImageModelManager from "./ImageModelManager";
import { SidebarSlot } from "./SidebarList";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** Live OpenRouter catalog — image models are filtered from it. */
  orModels?: OpenrouterModel[];
  /** Scene text sent over from the Write tab to seed a prompt. */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
  /** DOM node in App's unified sidebar where the image history is portaled. */
  sidebarSlot: HTMLElement | null;
  onCloseDrawer?: () => void;
}

export default function ImagePanel({
  settings,
  onChange,
  orModels = [],
  prefill,
  onPrefillConsumed,
  sidebarSlot,
  onCloseDrawer,
}: Props) {
  const { success: toastOk, error: toastError } = useToast();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [sourceImage, setSourceImage] = useState<string | null>(null); // data URL
  const [strength, setStrength] = useState(0.6);
  const [showImgModels, setShowImgModels] = useState(false);
  const [history, setHistory] = useState<ImageRecord[]>([]); // metadata only (no dataUrl)
  const [activeId, setActiveId] = useState<string | null>(null); // selected image id
  const [seed, setSeed] = useState(-1); // -1 = random each generation
  // Managed ComfyUI: is it installed, and is it up? Drives the setup/start CTAs.
  const [comfy, setComfy] = useState<{ installed: boolean; running: boolean } | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [startingComfy, setStartingComfy] = useState(false);

  // A scene handed over from Write prefills the prompt and focuses this tab.
  useEffect(() => {
    if (prefill && prefill.trim()) {
      setPrompt(prefill.trim().slice(0, 800));
      onPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // Load the shared gallery (lives on the Mac). Migrate any old local images
  // first, then show the newest as the current image.
  async function loadGallery(showNewest: boolean) {
    const rows = await allImages().catch(() => [] as ImageRecord[]);
    setHistory(rows);
    if (showNewest && rows.length) {
      setActiveId(rows[0].id);
      const full = await getImage(rows[0].id).catch(() => null);
      if (full?.dataUrl) setImage(full.dataUrl);
    }
  }
  useEffect(() => {
    migrateLegacyImages().finally(() => loadGallery(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-pull the gallery when the user taps Sync (nav rail).
  useEffect(() => {
    function onSync() {
      loadGallery(!image);
    }
    window.addEventListener("ai-studio-sync", onSync);
    return () => window.removeEventListener("ai-studio-sync", onSync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image]);

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
      setError(list.length ? "" : "No models found — click “Set up local images” to download one.");
    } catch {
      setError(""); // the setup/start CTA below explains what to do
    }
  }

  // Check the managed ComfyUI runtime, auto-starting it if it's installed but
  // idle so the user never has to think about a background process.
  async function refreshComfy(autoStart: boolean) {
    try {
      const st = await comfyStatus();
      setComfy({ installed: st.installed, running: st.running });
      if (st.running) {
        detect();
      } else if (st.installed && autoStart) {
        startComfy();
      }
    } catch {
      // comfyStatus is desktop-only; on the phone just try the configured URL.
      setComfy(null);
      detect();
    }
  }

  async function startComfy() {
    if (startingComfy) return;
    setStartingComfy(true);
    setError("Starting ComfyUI… (first launch loads PyTorch — up to a minute)");
    try {
      await comfyStart();
      setComfy((c) => (c ? { ...c, running: true } : { installed: true, running: true }));
      await detect();
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setStartingComfy(false);
    }
  }

  useEffect(() => {
    refreshComfy(true);
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
    // A concrete seed each run makes local generations reproducible.
    const usedSeed = seed >= 0 ? seed : Math.floor(Math.random() * 1_000_000_000_000);
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
            seed: usedSeed,
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
            seed: usedSeed,
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
        seed: isCloud ? undefined : usedSeed,
      };
      setActiveId(rec.id);
      // Persist to the Mac first so the thumbnail can fetch it, then list it.
      await addImage(rec).catch(() => {});
      const { dataUrl: _omit, ...meta } = rec;
      setHistory((prev) => [meta, ...prev]);
    } catch (e) {
      setError(String(e));
      toastError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openHistory(rec: ImageRecord) {
    setActiveId(rec.id);
    setPrompt(rec.prompt);
    if (rec.seed != null) setSeed(rec.seed);
    const full = rec.dataUrl ? rec : await getImage(rec.id).catch(() => null);
    if (full?.dataUrl) setImage(full.dataUrl);
  }
  async function removeHistory(id: string) {
    setHistory((prev) => prev.filter((r) => r.id !== id));
    await deleteImage(id).catch(() => {});
  }

  function save() {
    if (!image) return;
    const a = document.createElement("a");
    a.href = image;
    a.download = "ai-studio-image.png";
    a.click();
  }

  async function copyImage() {
    if (!image) return;
    try {
      const blob = await (await fetch(image)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toastOk("Image copied to clipboard");
    } catch {
      toastError("Copy failed — your system may not allow image clipboard access.");
    }
  }

  function useAsSource() {
    if (image) setSourceImage(image);
  }

  // Clear the canvas to start a fresh image. History is untouched — the old
  // image stays saved and reachable in the History rail.
  function newImage() {
    setImage(null);
    setActiveId(null);
    setSourceImage(null);
    setError("");
  }

  // Remove the image currently on the canvas (also from saved History), then
  // show the next most recent one.
  async function deleteCurrent() {
    if (!activeId) return;
    const next = history.find((r) => r.id !== activeId);
    const id = activeId;
    if (next) {
      await openHistory(next);
    } else {
      setImage(null);
      setActiveId(null);
    }
    await removeHistory(id);
  }

  function readImageFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setSourceImage(reader.result as string);
    reader.readAsDataURL(file);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) readImageFile(file);
  }

  const isCloud = settings.imageBackend === "openrouter";
  // Live image models from the OpenRouter catalog (beyond the curated set), so
  // new image models appear automatically. Edit-capable = accepts image input.
  const curatedIds = new Set(OPENROUTER_IMAGE_MODELS);
  const liveImageModels = orModels.filter((m) => m.outputImage && !curatedIds.has(m.id));
  const liveEditable = new Set(orModels.filter((m) => m.inputImage).map((m) => m.id));
  const canEditModel = (id: string) =>
    OPENROUTER_IMAGE_EDIT_MODELS.includes(id) || liveEditable.has(id);

  return (
    <div className="image-tab">
      <SidebarSlot slot={sidebarSlot}>
        <button
          className="sidebar-new"
          onClick={() => {
            newImage();
            onCloseDrawer?.();
          }}
        >
          + New image
        </button>
        <div className="image-history-list">
          {history.length === 0 && (
            <div className="image-history-empty">Your generations appear here.</div>
          )}
          {history.map((r) => (
            <HistoryThumb
              key={r.id}
              rec={r}
              active={activeId === r.id}
              onOpen={() => {
                openHistory(r);
                onCloseDrawer?.();
              }}
              onDelete={() => removeHistory(r.id)}
            />
          ))}
        </div>
      </SidebarSlot>

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
                {["Best quality", "Fast & budget", "Editing (input image)", "Design & text"].map(
                  (g) => (
                    <optgroup key={g} label={`Recommended · ${g}`}>
                      {OPENROUTER_IMAGE_MODEL_INFO.filter((m) => m.group === g).map((m) => (
                        <option key={m.id} value={m.id} title={m.note}>
                          {m.label} — {m.note}
                        </option>
                      ))}
                    </optgroup>
                  )
                )}
                {liveImageModels.length > 0 && (
                  <optgroup label={`All image models · live (${liveImageModels.length})`}>
                    {liveImageModels.map((m) => (
                      <option key={m.id} value={m.id} title={m.id}>
                        {m.name || m.id}
                        {m.inputImage ? " · edits" : ""}
                      </option>
                    ))}
                  </optgroup>
                )}
                {!OPENROUTER_IMAGE_MODELS.includes(settings.openrouterImageModel) &&
                  !liveImageModels.some((m) => m.id === settings.openrouterImageModel) &&
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
            {comfy && !comfy.installed && !comfy.running && (
              <div className="comfy-cta">
                <p className="hint">
                  Generate images 100% on your Mac — private and unlimited. One-click
                  setup downloads everything (no terminal needed).
                </p>
                <button className="btn primary" onClick={() => setShowSetup(true)}>
                  ⬇ Set up local images
                </button>
              </div>
            )}
            {comfy && comfy.installed && !comfy.running && (
              <div className="comfy-cta">
                <button
                  className="btn primary"
                  onClick={startComfy}
                  disabled={startingComfy}
                >
                  {startingComfy ? "Starting…" : "▶ Start ComfyUI"}
                </button>
              </div>
            )}
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
            <label
              className="upload-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
            >
              <input type="file" accept="image/*" onChange={onFile} hidden />
              + Upload or drop an image
            </label>
          )}
          {isCloud && sourceImage && !canEditModel(settings.openrouterImageModel) && (
            <p className="hint error">
              This model can't edit images — pick one from the “Editing (input image)” group
              (or a live model marked “· edits”).
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
              <label>Seed <span className="muted">(-1 = random each time)</span></label>
              <div className="row-inline">
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value))}
                />
                <button className="btn" title="Randomize" onClick={() => setSeed(-1)}>
                  🎲
                </button>
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
            <div className="preview-actions">
              <button className="btn" onClick={save}>
                Save PNG
              </button>
              <button className="btn" onClick={copyImage}>
                Copy
              </button>
              <button className="btn" onClick={useAsSource} title="Use this image as an img2img source">
                Use as source
              </button>
              <button className="btn ghost" onClick={newImage} title="Clear the canvas for a new image (keeps this one in History)">
                + New
              </button>
              <button className="btn danger" onClick={deleteCurrent} title="Delete this image (also removes it from History)">
                Delete
              </button>
            </div>
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

      {showSetup && (
        <ComfySetup
          onClose={() => {
            setShowSetup(false);
            refreshComfy(false);
          }}
          onChange={onChange}
          onComplete={() => {
            setComfy({ installed: true, running: true });
            detect();
          }}
        />
      )}
    </div>
  );
}

/** Gallery thumbnail: lazily fetches its own image data (kept on the Mac). */
function HistoryThumb({
  rec,
  active,
  onOpen,
  onDelete,
}: {
  rec: ImageRecord;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [src, setSrc] = useState<string | null>(rec.dataUrl ?? null);
  useEffect(() => {
    if (src) return;
    let alive = true;
    getImage(rec.id)
      .then((full) => {
        if (alive && full?.dataUrl) setSrc(full.dataUrl);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id]);
  return (
    <div
      className={active ? "history-thumb active" : "history-thumb"}
      onClick={onOpen}
      title={rec.prompt}
    >
      {src ? <img src={src} alt={rec.prompt} /> : <div className="history-thumb-ph" />}
      <button
        className="history-del"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        ×
      </button>
    </div>
  );
}
