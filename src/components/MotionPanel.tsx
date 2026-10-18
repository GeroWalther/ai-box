// Motion graphics, in three steps: brief → script & voice (the person approves
// the script before anything is paid for) → the video, made on the Mac by
// motion.rs.
//
// The job runs on the Mac and survives this tab closing; on return, the newest
// unfinished project is picked back up.
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
  motionSpeechModels,
  motionStop,
  motionVoiceSample,
  motionVoices,
  spokenSeconds,
  type MotionBrief,
  type MotionImageModel,
  type MotionProject,
  type MotionSpeechModel,
  type MotionVoice,
} from "../lib/motion";
import { isTauri } from "../lib/transport";
import { useToast } from "../lib/toast";

const LANGUAGES = ["English", "Deutsch", "Español", "Français", "Italiano", "Português", "日本語"];
/** The default OpenRouter voice model: the engine the pipeline was built on. */
const PREFERRED_SPEECH = "elevenlabs/eleven-v4";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** A finished video is in the library: show it. */
  onFinished: (videoId: string) => void;
  /** Pick up an unfinished project (on first open) rather than start empty. */
  resume: boolean;
  /** What the video is about, sent over from Write or Images. */
  topic: string | null;
}

export default function MotionPanel({ settings, onChange, onFinished, resume, topic }: Props) {
  const { error: toastError } = useToast();
  const [brief, setBrief] = useState<MotionBrief>({
    kind: "ad",
    product: topic ?? "",
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [images, setImages] = useState<{ name: string; base64: string }[]>([]);
  const [project, setProject] = useState<MotionProject | null>(null);
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);

  const [speechModels, setSpeechModels] = useState<MotionSpeechModel[]>([]);
  const [elevenVoices, setElevenVoices] = useState<MotionVoice[]>([]);
  const [elevenError, setElevenError] = useState("");
  const [imageModels, setImageModels] = useState<MotionImageModel[]>([]);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState("");

  useEffect(() => {
    if (resume) {
      motionList()
        .then(async (rows) => {
          const open = rows.find((r) => r.status === "running" || r.status === "script");
          if (!open) return;
          const p = await motionGet(open.id);
          if (p) adopt(p);
        })
        .catch(() => {});
    }
    motionSpeechModels()
      .then(setSpeechModels)
      .catch(() => {});
    motionVoices()
      .then(setElevenVoices)
      .catch((e) => setElevenError(String(e)));
    motionImageModels()
      .then(setImageModels)
      .catch(() => {});
    return () => audio.current?.pause();
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

  // ---- the voice ----------------------------------------------------------------

  const source = settings.motionVoiceSource;
  const speechModel =
    speechModels.find((m) => m.id === settings.motionSpeechModel) ??
    speechModels.find((m) => m.id === PREFERRED_SPEECH) ??
    speechModels[0] ??
    null;
  const orVoice =
    speechModel?.voices.find((v) => v === settings.motionOrVoice) ?? speechModel?.voices[0] ?? "";
  const elevenVoice = elevenVoices.find((v) => v.id === settings.motionVoice) ?? null;
  const voiceReady = source === "elevenlabs" ? !!elevenVoice : !!speechModel && !!orVoice;
  const imageModel =
    imageModels.find((m) => m.id === settings.motionImageModel) ?? imageModels[0] ?? null;

  function play(id: string, url: string) {
    audio.current?.pause();
    const a = new Audio(url);
    a.onended = () => setPlaying("");
    void a.play();
    audio.current = a;
    setPlaying(id);
  }

  function stopPlaying() {
    audio.current?.pause();
    setPlaying("");
  }

  async function trySample() {
    if (!speechModel || !orVoice) return;
    if (playing) return stopPlaying();
    setPlaying("loading");
    try {
      const first = script.split(/(?<=[.!?])\s/)[0] ?? "";
      play("sample", await motionVoiceSample(speechModel.id, orVoice, first));
    } catch (e) {
      setPlaying("");
      toastError(String(e));
    }
  }

  // ---- actions ----------------------------------------------------------------------

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

  async function writeScript() {
    const provider = resolveTextProvider(settings);
    if (!provider.model) {
      toastError("Pick a text model in Settings first — it writes the script and the animation.");
      return;
    }
    setBusy(true);
    try {
      adopt(await motionScript({ brief, images, baseUrl: provider.baseUrl, model: provider.model }));
    } catch (e) {
      toastError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function make() {
    if (!project || !imageModel || !voiceReady) return;
    stopPlaying();
    setBusy(true);
    try {
      await motionMake({
        id: project.id,
        title,
        script,
        voiceSource: source,
        speechModel: source === "openrouter" ? speechModel?.id ?? "" : "",
        voiceId: source === "elevenlabs" ? elevenVoice!.id : orVoice,
        voiceName: source === "elevenlabs" ? elevenVoice!.name.split(" - ")[0] : orVoice,
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

  const stage = !project ? 0 : working || project.status === "done" ? 2 : 1;
  const stages = (
    <ol className="motion-stages">
      {["Brief", "Script & voice", "Video"].map((s, i) => (
        <li key={s} className={i === stage ? "now" : i < stage ? "past" : ""}>
          <span>{i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  );

  // ---- 3. making it / made --------------------------------------------------------

  if (project && stage === 2) {
    return (
      <div className="motion">
        {stages}
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
              Made on the Mac — you can leave this tab, or watch from your phone. A 30-second
              video takes about four minutes.
            </p>
            <button className="btn" onClick={() => void motionStop(project.id)}>
              Stop
            </button>
          </>
        ) : (
          <>
            <p className="hint">
              Done — it's in your library. Cost ${project.cost.toFixed(2)} on OpenRouter
              {project.voiceChars > 0 && ` · ${project.voiceChars} ElevenLabs characters`}.
            </p>
            <div className="row-inline">
              <button className="btn" onClick={() => setProject({ ...project, status: "script" })}>
                Edit &amp; remake
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

  // ---- 2. script & voice ---------------------------------------------------------------

  if (project) {
    const secs = spokenSeconds(script, project.brief.language);
    return (
      <div className="motion">
        {stages}
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
              · ≈{Math.round(secs)} of {project.brief.seconds} s · every word is spoken
            </span>
          </label>
          <textarea rows={7} value={script} onChange={(e) => setScript(e.target.value)} />
        </div>
        {project.assets.length > 0 && (
          <p className="hint">
            Shows your real {project.assets.map((a) => a.kind).filter((k, i, all) => all.indexOf(k) === i).join(", ")}{" "}
            ({project.assets.length} {project.assets.length === 1 ? "image" : "images"}).
          </p>
        )}

        <div className="field">
          <label>Voice</label>
          <div className="segmented">
            <button
              className={source === "openrouter" ? "seg active" : "seg"}
              onClick={() => onChange({ motionVoiceSource: "openrouter" })}
            >
              OpenRouter
            </button>
            <button
              className={source === "elevenlabs" ? "seg active" : "seg"}
              onClick={() => onChange({ motionVoiceSource: "elevenlabs" })}
            >
              ElevenLabs key
            </button>
          </div>
          {source === "openrouter" ? (
            <>
              <div className="row-2">
                <select
                  value={speechModel?.id ?? ""}
                  onChange={(e) => onChange({ motionSpeechModel: e.target.value, motionOrVoice: "" })}
                >
                  {speechModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                    </option>
                  ))}
                </select>
                <div className="row-inline">
                  <select value={orVoice} onChange={(e) => onChange({ motionOrVoice: e.target.value })}>
                    {speechModel?.voices.map((v) => (
                      <option key={v} value={v}>
                        {v.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn"
                    title="Hear this voice read your first sentence (a fraction of a cent)"
                    disabled={!orVoice || playing === "loading"}
                    onClick={() => void trySample()}
                  >
                    {playing === "loading" ? "…" : playing === "sample" ? "■" : "▶"}
                  </button>
                </div>
              </div>
              <p className="hint">
                Uses your OpenRouter key — no second account. ▶ reads your first sentence.
              </p>
            </>
          ) : elevenError ? (
            <p className="hint error">{elevenError}</p>
          ) : (
            <div className="motion-voices">
              {elevenVoices.map((v) => (
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
                      if (playing === v.id) stopPlaying();
                      else if (v.previewUrl) play(v.id, v.previewUrl);
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
          <label>Image model</label>
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
          {source === "openrouter"
            ? "Costs a few cents on OpenRouter: up to 6 images and the voice."
            : `Costs a few cents of OpenRouter images, plus ${script.length} characters of your ElevenLabs plan.`}{" "}
          Music, effects, animation and rendering are free, on this Mac.
        </p>
        <div className="row-inline">
          <button className="btn" onClick={startOver} disabled={busy}>
            Back
          </button>
          <button
            className="btn primary big"
            disabled={busy || !voiceReady || !imageModel || !script.trim()}
            onClick={() => void make()}
          >
            {busy ? "Starting…" : !voiceReady ? "Pick a voice" : "Approve & make the video"}
          </button>
        </div>
      </div>
    );
  }

  // ---- 1. brief ------------------------------------------------------------------------------

  const canStart = !!(brief.product.trim() || brief.appStore.trim() || brief.website.trim());
  return (
    <div className="motion">
      {stages}
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

      <div className="field">
        <label>What is it about?</label>
        <textarea
          rows={3}
          placeholder="e.g. Green Reader, an iPhone app that reads golf greens with LiDAR and shows the putt line in AR"
          value={brief.product}
          onChange={(e) => setB({ product: e.target.value })}
        />
      </div>

      <div className="row-2">
        <div className="field">
          <label>Format</label>
          <select
            value={brief.format}
            onChange={(e) => setB({ format: e.target.value as MotionBrief["format"] })}
          >
            <option value="9:16">9:16 · Reels, TikTok</option>
            <option value="16:9">16:9 · YouTube, web</option>
            <option value="1:1">1:1 · feed</option>
          </select>
        </div>
        <div className="field">
          <label>Length</label>
          <select value={brief.seconds} onChange={(e) => setB({ seconds: Number(e.target.value) })}>
            {[15, 20, 30, 45, 60].map((s) => (
              <option key={s} value={s}>
                {s} seconds
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

      <button className="video-disclosure" onClick={() => setMoreOpen((v) => !v)}>
        {moreOpen ? "▾" : "▸"} More details <span className="muted">— optional, for a better video</span>
      </button>
      {moreOpen && (
        <div className="video-brief">
          <input
            placeholder="App Store link or app name — uses the real icon & screenshots"
            value={brief.appStore}
            onChange={(e) => setB({ appStore: e.target.value })}
          />
          <input
            placeholder="Website — the script uses what it says"
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
          <label className="hint">Your images — logo, product photos, shown as they are</label>
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
            <label className="motion-add" title="Add images">
              +
              <input type="file" accept="image/*" multiple hidden onChange={addImages} />
            </label>
          </div>
        </div>
      )}

      {isTauri() && !settings.openrouterKey && (
        <p className="hint error">Videos need an OpenRouter key — add it in Settings → General.</p>
      )}
      <button
        className="btn primary big"
        disabled={busy || !canStart}
        onClick={() => void writeScript()}
      >
        {busy ? "Researching & writing…" : "Write the script"}
      </button>
      <p className="hint">Free until you approve the script.</p>
    </div>
  );
}
