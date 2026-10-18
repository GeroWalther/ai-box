// Motion graphics: brief → script (approved by the person) → a voiced, scored,
// animated MP4, made on the Mac by motion.rs.
//
// The paid part — voice and images — runs only after the script is approved,
// so the first button never costs more than one text-model call. The job runs
// on the Mac and survives this tab closing; on return, the newest unfinished
// project is picked back up.
import { useEffect, useRef, useState } from "react";
import type { Settings } from "../lib/settings";
import { resolveTextProvider } from "../lib/settings";
import { AD_TONES } from "../lib/presets";
import {
  isWorking,
  motionGet,
  motionImageModels,
  motionList,
  motionMake,
  motionScript,
  motionStop,
  motionVoices,
  spokenSeconds,
  type MotionBrief,
  type MotionImageModel,
  type MotionProject,
  type MotionVoice,
} from "../lib/motion";
import { isTauri } from "../lib/transport";
import { useToast } from "../lib/toast";

const LANGUAGES = ["English", "Deutsch", "Español", "Français", "Italiano", "Português", "日本語"];

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** A finished video is in the library: show it. */
  onFinished: (videoId: string) => void;
}

export default function MotionPanel({ settings, onChange, onFinished }: Props) {
  const { error: toastError } = useToast();
  const [brief, setBrief] = useState<MotionBrief>({
    kind: "ad",
    product: "",
    audience: "",
    message: "",
    tone: AD_TONES[2],
    notes: "",
    appStore: "",
    website: "",
    format: settings.motionFormat,
    seconds: settings.motionSeconds,
    language: settings.motionLanguage,
  });
  const [images, setImages] = useState<{ name: string; base64: string }[]>([]);
  const [project, setProject] = useState<MotionProject | null>(null);
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);
  const [voices, setVoices] = useState<MotionVoice[]>([]);
  const [voiceError, setVoiceError] = useState("");
  const [imageModels, setImageModels] = useState<MotionImageModel[]>([]);
  const preview = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState("");

  // Pick up the newest project that is still waiting on the person or working.
  useEffect(() => {
    motionList()
      .then(async (rows) => {
        const open = rows.find((r) => r.status === "running" || r.status === "script");
        if (!open) return;
        const p = await motionGet(open.id);
        if (p) adopt(p);
      })
      .catch(() => {});
    motionVoices()
      .then(setVoices)
      .catch((e) => setVoiceError(String(e)));
    motionImageModels()
      .then(setImageModels)
      .catch(() => {});
    return () => preview.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function adopt(p: MotionProject) {
    setProject(p);
    setTitle(p.title);
    setScript(p.script);
  }

  // Watch a working job. Polling with `since` is cheap — nothing comes back
  // unless something changed — and works the same from the phone.
  const rev = project?.rev;
  const working = isWorking(project);
  useEffect(() => {
    if (!project || !working) return;
    const id = project.id;
    const timer = setInterval(async () => {
      const next = await motionGet(id, rev).catch(() => null);
      if (!next) return;
      setProject(next);
      if (next.status === "done" && next.videoId) onFinished(next.videoId);
    }, 1500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, rev, working]);

  const voice = voices.find((v) => v.id === settings.motionVoice) ?? null;
  const imageModel =
    imageModels.find((m) => m.id === settings.motionImageModel) ?? imageModels[0] ?? null;

  function setB(patch: Partial<MotionBrief>) {
    setBrief((b) => ({ ...b, ...patch }));
    if (patch.format) onChange({ motionFormat: patch.format });
    if (patch.seconds) onChange({ motionSeconds: patch.seconds });
    if (patch.language) onChange({ motionLanguage: patch.language });
  }

  function addImages(e: React.ChangeEvent<HTMLInputElement>) {
    for (const file of Array.from(e.target.files ?? [])) {
      const reader = new FileReader();
      reader.onload = () =>
        setImages((list) => [...list, { name: file.name, base64: String(reader.result) }]);
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  }

  function playPreview(v: MotionVoice) {
    preview.current?.pause();
    if (playing === v.id || !v.previewUrl) {
      setPlaying("");
      return;
    }
    const a = new Audio(v.previewUrl);
    a.onended = () => setPlaying("");
    void a.play();
    preview.current = a;
    setPlaying(v.id);
  }

  async function writeScript() {
    const provider = resolveTextProvider(settings);
    if (!provider.model) {
      toastError("Pick a text model in Settings first — it writes the script and the animation.");
      return;
    }
    setBusy(true);
    try {
      adopt(
        await motionScript({ brief, images, baseUrl: provider.baseUrl, model: provider.model })
      );
    } catch (e) {
      toastError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function make() {
    if (!project || !voice || !imageModel) return;
    setBusy(true);
    try {
      await motionMake({
        id: project.id,
        title,
        script,
        voiceId: voice.id,
        voiceName: voice.name,
        imageModel: imageModel.id,
      });
      const p = await motionGet(project.id);
      if (p) setProject(p);
    } catch (e) {
      toastError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setProject(null);
    setTitle("");
    setScript("");
  }

  // ---- working / finished -----------------------------------------------------

  if (project && (working || project.status === "done")) {
    return (
      <div className="motion">
        <div className="field">
          <label>{project.title}</label>
          <ol className="motion-steps">
            {project.steps.map((s, i) => (
              <li key={i} className={s.ok === null ? "run" : s.ok ? "ok" : "bad"}>
                <span className="motion-mark" aria-hidden="true">
                  {s.ok === null ? "◌" : s.ok ? "✓" : "✗"}
                </span>
                <span>
                  {s.title}
                  {s.detail && <span className="hint">{s.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
        {working ? (
          <>
            <p className="hint">
              It's made on the Mac — you can leave this tab, or watch from your phone. A 30-second
              spot takes about four minutes.
            </p>
            <button className="btn" onClick={() => void motionStop(project.id)}>
              Stop
            </button>
          </>
        ) : (
          <>
            <p className="hint">
              Done — it's in your library. Images ${project.cost.toFixed(2)} ·{" "}
              {project.voiceChars} characters of ElevenLabs voice.
            </p>
            <div className="row-inline">
              {project.videoId && (
                <button className="btn" onClick={() => onFinished(project.videoId!)}>
                  Show it
                </button>
              )}
              <button className="btn" onClick={() => setProject({ ...project, status: "script" })}>
                Change the script
              </button>
              <button className="btn primary" onClick={startOver}>
                New video
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ---- script approval ---------------------------------------------------------------

  if (project) {
    const secs = spokenSeconds(script, project.brief.language);
    return (
      <div className="motion">
        {project.status === "failed" && <p className="hint error">{project.error}</p>}
        {project.status === "stopped" && (
          <p className="hint">Stopped. Approve again to make it from the start.</p>
        )}
        <div className="field">
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label>
            Script{" "}
            <span className="muted">
              · ≈{Math.round(secs)} s of {project.brief.seconds} s — edit it, every word is spoken
            </span>
          </label>
          <textarea rows={8} value={script} onChange={(e) => setScript(e.target.value)} />
        </div>
        {project.assets.length > 0 && (
          <p className="hint">
            Using {project.assets.length} real{" "}
            {project.assets.length === 1 ? "image" : "images"}:{" "}
            {project.assets.map((a) => a.note.split(" — ")[0]).join(", ")}.
          </p>
        )}

        <div className="field">
          <label>Voice · ElevenLabs</label>
          {voiceError ? (
            <p className="hint error">{voiceError}</p>
          ) : (
            <div className="motion-voices">
              {voices.map((v) => (
                <div
                  key={v.id}
                  className={v.id === settings.motionVoice ? "motion-voice active" : "motion-voice"}
                  onClick={() => onChange({ motionVoice: v.id })}
                  title={v.description ?? ""}
                >
                  <button
                    className="motion-play"
                    title="Free preview"
                    onClick={(e) => {
                      e.stopPropagation();
                      playPreview(v);
                    }}
                    disabled={!v.previewUrl}
                  >
                    {playing === v.id ? "■" : "▶"}
                  </button>
                  <span>
                    <b>{v.name.split(" - ")[0]}</b>
                    <span className="hint">{v.tags}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="field">
          <label>Images · transparent cut-outs</label>
          <select
            value={imageModel?.id ?? ""}
            onChange={(e) => onChange({ motionImageModel: e.target.value })}
          >
            {imageModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </select>
        </div>

        <p className="hint">
          Costs: up to 6 images on OpenRouter (a few cents each) and {script.length} characters of
          your ElevenLabs quota. Music, effects, animation and rendering run on this Mac for free.
        </p>
        <div className="row-inline">
          <button className="btn" onClick={startOver} disabled={busy}>
            Back
          </button>
          <button
            className="btn primary big"
            disabled={busy || !voice || !imageModel || !script.trim()}
            onClick={() => void make()}
          >
            {busy ? "Starting…" : !voice ? "Pick a voice" : "Approve script & make video"}
          </button>
        </div>
      </div>
    );
  }

  // ---- brief ------------------------------------------------------------------------------

  return (
    <div className="motion">
      <p className="hint">
        An animated explainer or ad: your text model writes the script and animates it as a web
        page, ElevenLabs speaks it, and every movement lands on its word. Rendered on this Mac.
      </p>
      <div className="field">
        <div className="segmented">
          <button
            className={brief.kind === "ad" ? "seg active" : "seg"}
            onClick={() => setB({ kind: "ad" })}
          >
            Ad / promo
          </button>
          <button
            className={brief.kind === "explainer" ? "seg active" : "seg"}
            onClick={() => setB({ kind: "explainer" })}
          >
            Explainer
          </button>
        </div>
      </div>
      <div className="video-brief">
        <input
          placeholder="What it's about — e.g. Green Reader, an AR golf putting app"
          value={brief.product}
          onChange={(e) => setB({ product: e.target.value })}
        />
        <input
          placeholder="App Store link or app name (optional) — real icon & screenshots"
          value={brief.appStore}
          onChange={(e) => setB({ appStore: e.target.value })}
        />
        <input
          placeholder="Website (optional)"
          value={brief.website}
          onChange={(e) => setB({ website: e.target.value })}
        />
        <input
          placeholder="Audience — e.g. weekend golfers"
          value={brief.audience}
          onChange={(e) => setB({ audience: e.target.value })}
        />
        <input
          placeholder="Message to land — e.g. see the break before you putt"
          value={brief.message}
          onChange={(e) => setB({ message: e.target.value })}
        />
        <select value={brief.tone} onChange={(e) => setB({ tone: e.target.value })}>
          {AD_TONES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <textarea
          rows={2}
          placeholder="Brand notes — colours, fonts, things to avoid"
          value={brief.notes}
          onChange={(e) => setB({ notes: e.target.value })}
        />
      </div>

      <div className="field">
        <label>
          Your images <span className="muted">· logo, product photos — shown as they are</span>
        </label>
        <div className="motion-images">
          {images.map((img, i) => (
            <div key={i} className="motion-image" title={img.name}>
              <img src={img.base64} alt={img.name} />
              <button
                className="history-del"
                onClick={() => setImages((l) => l.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <label className="motion-add">
            +
            <input type="file" accept="image/*" multiple hidden onChange={addImages} />
          </label>
        </div>
      </div>

      <div className="row-2">
        <div className="field">
          <label>Format</label>
          <select
            value={brief.format}
            onChange={(e) => setB({ format: e.target.value as MotionBrief["format"] })}
          >
            <option value="9:16">9:16 · Reels, TikTok, Shorts</option>
            <option value="16:9">16:9 · YouTube, web</option>
            <option value="1:1">1:1 · feed</option>
          </select>
        </div>
        <div className="field">
          <label>Length</label>
          <select value={brief.seconds} onChange={(e) => setB({ seconds: Number(e.target.value) })}>
            {[15, 20, 30, 45, 60].map((s) => (
              <option key={s} value={s}>
                {s} s
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Language</label>
        <input
          list="motion-languages"
          value={brief.language}
          onChange={(e) => setB({ language: e.target.value })}
        />
        <datalist id="motion-languages">
          {LANGUAGES.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
      </div>

      {isTauri() && !settings.elevenlabsKey && (
        <p className="hint error">
          The voice comes from ElevenLabs — add your key in Settings → General.
        </p>
      )}
      <button
        className="btn primary big"
        disabled={busy || (!brief.product.trim() && !brief.appStore.trim() && !brief.website.trim())}
        onClick={() => void writeScript()}
      >
        {busy ? "Researching & writing…" : "✦ Research & write the script"}
      </button>
      <p className="hint">Nothing is paid for until you approve the script.</p>
    </div>
  );
}
