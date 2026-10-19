// The Video tab: motion-graphics videos made on this Mac, set up like the
// Images tab — the choices on the left, the video on the right.
//
// Left: the models, the voice, format, length and type, what the video is
// about, and the person's own images (logos, product photos — kept as they
// are). "Write script" drafts a script to edit; "Make video" makes it, redoing
// only what changed since the last version (motion.rs). Right: the video, its
// versions, progress while it is made, and "Change something" — a note like
// "make the logo bigger" costs one animation pass, not a new voice and images.
//
// Each video is a project in the sidebar; every version lands in the library.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Settings } from "../lib/settings";
import { resolveTextProvider } from "../lib/settings";
import { listOllamaModels, saveVideo } from "../lib/api";
import { attachFile, attachPath, isImageFile, isImagePath } from "../lib/attachments";
import {
  motionAddAsset,
  motionAsset,
  motionDelete,
  motionGet,
  motionList,
  motionMake,
  motionNew,
  motionOptions,
  motionRemoveAsset,
  motionRevise,
  motionSample,
  motionSave,
  motionScript,
  motionStop,
  type MotionForm,
  type MotionOptions,
  type MotionProject,
  type MotionSummary,
} from "../lib/motion";
import { allVideos, deleteVideo, revokeVideoUrl, videoObjectUrl, type VideoRecord } from "../lib/videoStore";
import { isTauri } from "../lib/transport";
import { logError } from "../lib/log";
import { useToast } from "../lib/toast";
import { useFileDrop } from "../hooks/useFileDrop";
import { useOpenrouterModels } from "../lib/openrouterModels";
import { useDirectModels } from "../hooks/useDirectModels";
import { registerSyncSource } from "../lib/syncBus";
import { SidebarSlot } from "./SidebarList";
import ModelSelect from "./ModelSelect";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** A scene or product line handed over from Write / Images. */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
  sidebarSlot: HTMLElement | null;
  onCloseDrawer?: () => void;
}

const LANGUAGES = ["English", "Deutsch", "Español", "Français", "Italiano", "Português", "Nederlands", "日本語", "中文", "한국어"];
const FORMATS: [string, string][] = [
  ["9:16", "9:16 · Reels"],
  ["16:9", "16:9 · YouTube"],
  ["1:1", "1:1 · Feed"],
];
/** The length slider's range, in seconds. Longer would need the animation
 *  split into scenes; one document holds up to about two minutes. */
const MIN_SECONDS = 10;
const MAX_SECONDS = 120;
function clock(seconds: number) {
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} min`;
}
const REDO: [string, string][] = [
  ["animation", "Animation only — quick, about a cent"],
  ["images", "New look, images and music"],
  ["voice", "Everything, voice too"],
];

/** The choices a new video starts with: the last ones used. */
const DEFAULTS_KEY = "aibox.videoDefaults";
type Defaults = Pick<
  MotionForm,
  "kind" | "format" | "seconds" | "language" | "voiceSource" | "speechModel" | "voice" | "voiceName" | "imageModel"
>;
function loadDefaults(): Defaults {
  const base: Defaults = {
    kind: "ad",
    format: "9:16",
    seconds: 30,
    language: "English",
    voiceSource: "openrouter",
    speechModel: "",
    voice: "",
    voiceName: "",
    imageModel: "",
  };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "{}") };
  } catch {
    return base;
  }
}
function saveDefaults(f: MotionForm) {
  try {
    const { kind, format, seconds, language, voiceSource, speechModel, voice, voiceName, imageModel } = f;
    localStorage.setItem(
      DEFAULTS_KEY,
      JSON.stringify({ kind, format, seconds, language, voiceSource, speechModel, voice, voiceName, imageModel })
    );
  } catch {
    /* per-viewer convenience only */
  }
}

function emptyForm(): MotionForm {
  return { brief: "", title: "", script: "", baseUrl: "", model: "", ...loadDefaults() };
}

function formOf(p: MotionProject): MotionForm {
  const d = loadDefaults();
  return {
    brief: p.brief.product,
    kind: p.brief.kind || d.kind,
    format: p.brief.format || d.format,
    seconds: p.brief.seconds || d.seconds,
    language: p.brief.language || d.language,
    title: p.title === "New video" ? "" : p.title,
    script: p.script,
    voiceSource: p.voiceId ? p.voiceSource : d.voiceSource,
    speechModel: p.voiceId ? p.speechModel : d.speechModel,
    voice: p.voiceId || d.voice,
    voiceName: p.voiceId ? p.voiceName : d.voiceName,
    imageModel: p.imageModel || d.imageModel,
    baseUrl: "",
    model: "",
  };
}

/** One of the project's images, fetched from the Mac. */
function AssetThumb({ id, file, note, onRemove }: { id: string; file: string; note: string; onRemove: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    motionAsset(id, file).then(
      (u) => live && setUrl(u),
      () => {}
    );
    return () => {
      live = false;
    };
  }, [id, file]);
  return (
    <div className="video-asset" title={note}>
      {url ? <img src={url} alt={note} /> : <span>…</span>}
      <button className="attach-thumb-x" onClick={onRemove} title="Remove" aria-label="Remove image">
        ×
      </button>
    </div>
  );
}

export default function VideoPanel({ settings, onChange, prefill, onPrefillConsumed, sidebarSlot, onCloseDrawer }: Props) {
  const { success: toastOk, error: toastError } = useToast();
  const provider = useMemo(() => resolveTextProvider(settings), [settings]);
  const { models: orModels, refresh: refreshOR } = useOpenrouterModels(settings.openrouterKey);
  const directModels = useDirectModels(settings);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const refreshOllama = useCallback(async () => {
    setOllamaModels(await listOllamaModels(settings.ollamaUrl).catch(() => [] as string[]));
  }, [settings.ollamaUrl]);
  useEffect(() => {
    void refreshOllama();
  }, [refreshOllama]);

  const [options, setOptions] = useState<MotionOptions | null>(null);
  const [projects, setProjects] = useState<MotionSummary[]>([]);
  const [library, setLibrary] = useState<VideoRecord[]>([]);
  const [project, setProject] = useState<MotionProject | null>(null);
  const [form, setForm] = useState<MotionForm>(emptyForm);
  const [busy, setBusy] = useState<"" | "script" | "make" | "revise" | "sample">("");
  const [adding, setAdding] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [redo, setRedo] = useState("animation");
  const [shown, setShown] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [sampleUrl, setSampleUrl] = useState("");
  const leftRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const creating = useRef<Promise<MotionProject> | null>(null);

  const loadProjects = useCallback(async () => {
    setProjects(await motionList().catch(() => [] as MotionSummary[]));
  }, []);
  const loadLibrary = useCallback(async () => {
    setLibrary(await allVideos().catch(() => [] as VideoRecord[]));
  }, []);
  useEffect(() => registerSyncSource("videos", () => loadLibrary()), [loadLibrary]);

  // Open on the most recent video.
  useEffect(() => {
    motionOptions().then(setOptions, (e) => logError("video.options", e));
    void loadLibrary();
    void motionList()
      .catch(() => [] as MotionSummary[])
      .then(async (rows) => {
        setProjects(rows);
        if (rows[0]) await open(rows[0].id);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Something sent over from Write or Images: a new video about that.
  useEffect(() => {
    if (prefill?.trim()) {
      startNew();
      setForm((f) => ({ ...f, brief: prefill.trim().slice(0, 1500) }));
      onPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  async function open(id: string) {
    const p = await motionGet(id).catch(() => null);
    if (!p) return;
    setProject(p);
    setForm(formOf(p));
    setShown(null);
    setFeedback("");
    setSampleUrl("");
  }

  function startNew() {
    setProject(null);
    setForm(emptyForm());
    setShown(null);
    setFeedback("");
    setSampleUrl("");
  }

  const withModel = (f: MotionForm): MotionForm => ({ ...f, baseUrl: provider.baseUrl, model: provider.model });

  /** The project behind the form, made on first need. */
  async function ensure(): Promise<MotionProject> {
    if (project) return project;
    if (!creating.current) {
      const pending = motionNew(provider.baseUrl, provider.model).then(async (p) => {
        const saved = await motionSave(p.id, withModel(form));
        setProject(saved);
        return saved;
      });
      creating.current = pending;
      void pending.finally(() => (creating.current = null)).catch(() => {});
    }
    return creating.current;
  }

  // Follow a project while it is being made; the library gets the new version.
  const running = project?.status === "running";
  useEffect(() => {
    if (!project || !running) return;
    const id = project.id;
    const since = project.rev;
    const timer = setInterval(async () => {
      const p = await motionGet(id, since).catch(() => null);
      if (!p) return;
      setProject(p);
      if (p.status !== "running") {
        void loadLibrary();
        void loadProjects();
        setShown(null);
        if (p.status === "failed" && p.error) toastError(p.error);
      }
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.rev, running]);

  /** Change the form; it is kept on the Mac a moment later. */
  function set(patch: Partial<MotionForm>) {
    setForm((f) => {
      const next = { ...f, ...patch };
      saveDefaults(next);
      clearTimeout(saveTimer.current);
      if (project) {
        const id = project.id;
        saveTimer.current = setTimeout(() => {
          void motionSave(id, withModel(next)).then(
            (p) => setProject((old) => (old?.id === p.id && old.status !== "running" ? p : old)),
            (e) => logError("video.save", e)
          );
        }, 700);
      }
      return next;
    });
  }

  // Voices for the chosen source.
  const speechModels = options?.speechModels ?? [];
  const speechModel = speechModels.find((m) => m.id === form.speechModel) ?? speechModels[0];
  const elevenVoices = options?.elevenVoices ?? [];
  // A source with no voice picked yet gets its first one.
  useEffect(() => {
    if (!options) return;
    if (form.voiceSource === "elevenlabs") {
      if (!elevenVoices.length) return;
      if (!elevenVoices.some((v) => v.id === form.voice))
        set({ voice: elevenVoices[0].id, voiceName: elevenVoices[0].name, speechModel: "" });
    } else if (speechModel) {
      const patch: Partial<MotionForm> = {};
      if (form.speechModel !== speechModel.id) patch.speechModel = speechModel.id;
      if (!speechModel.voices.includes(form.voice)) {
        patch.voice = speechModel.voices[0] ?? "";
        patch.voiceName = patch.voice;
      }
      if (Object.keys(patch).length) set(patch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, form.voiceSource, form.speechModel, project?.id]);

  async function playSample() {
    if (!form.voice) return;
    setBusy("sample");
    try {
      const p = await ensure();
      const line = form.script.split(/(?<=[.!?])\s/)[0] || "Here is how this voice sounds.";
      setSampleUrl(await motionSample(p.id, form.voiceSource, form.speechModel, form.voice, line));
    } catch (e) {
      toastError(String(e));
    } finally {
      setBusy("");
    }
  }

  async function writeScript() {
    if (!form.brief.trim()) {
      toastError("Say what the video is about first.");
      return;
    }
    if (!provider.model) {
      toastError("Pick a model for writing first.");
      return;
    }
    setBusy("script");
    try {
      const p = await ensure();
      const next = await motionScript(p.id, withModel(form));
      setProject(next);
      setForm((f) => ({ ...f, script: next.script, title: next.title }));
      void loadProjects();
    } catch (e) {
      toastError(String(e));
    } finally {
      setBusy("");
    }
  }

  async function make() {
    setBusy("make");
    try {
      clearTimeout(saveTimer.current);
      const p = await ensure();
      const next = await motionMake(p.id, withModel(form));
      setProject({ ...next, status: "running", steps: [] });
      setShown(null);
      void loadProjects();
    } catch (e) {
      toastError(String(e));
    } finally {
      setBusy("");
    }
  }

  async function revise() {
    if (!project || !feedback.trim()) return;
    setBusy("revise");
    try {
      clearTimeout(saveTimer.current);
      await motionSave(project.id, withModel(form));
      await motionRevise(project.id, feedback.trim(), redo);
      setProject({ ...project, status: "running", steps: [] });
      setFeedback("");
      setShown(null);
    } catch (e) {
      toastError(String(e));
    } finally {
      setBusy("");
    }
  }

  async function addImages(jobs: (() => Promise<{ id: string; name: string }>)[]) {
    setAdding((n) => n + jobs.length);
    const p = await ensure().catch((e) => {
      toastError(String(e));
      return null;
    });
    for (const job of jobs) {
      try {
        if (!p) continue;
        const a = await job();
        setProject(await motionAddAsset(p.id, a.id, a.name));
      } catch (e) {
        logError("video.asset", e);
        toastError(String(e));
      } finally {
        setAdding((n) => n - 1);
      }
    }
    void loadProjects();
  }

  const dropHover = useFileDrop({
    target: leftRef,
    enabled: true,
    onPaths: (paths) => {
      const images = paths.filter(isImagePath);
      if (images.length) void addImages(images.map((p) => () => attachPath(p)));
    },
    onFiles: (files) => {
      const images = files.filter(isImageFile);
      if (images.length) void addImages(images.map((f) => () => attachFile(f)));
    },
  });

  async function removeProject(id: string) {
    for (const v of library.filter((r) => r.jobId === `motion:${id}`)) await deleteVideo(v.id).catch(() => {});
    await motionDelete(id).catch(() => {});
    setProjects((rows) => rows.filter((r) => r.id !== id));
    void loadLibrary();
    if (project?.id === id) startNew();
  }

  // The project's versions, newest first, and the one on screen.
  const versions = project ? library.filter((r) => r.jobId === `motion:${project.id}`) : [];
  const fallback = project?.videoId && versions.some((v) => v.id === project.videoId) ? project.videoId : versions[0]?.id;
  const shownId = (shown && versions.some((v) => v.id === shown) ? shown : fallback) ?? null;
  const shownRec = versions.find((r) => r.id === shownId) ?? null;
  useEffect(() => {
    if (!shownId) {
      setPlayUrl(null);
      return;
    }
    let live = true;
    let made: string | null = null;
    videoObjectUrl(shownId).then(
      (u) => {
        made = u;
        if (live) setPlayUrl(u);
        else revokeVideoUrl(u);
      },
      () => live && setPlayUrl(null)
    );
    return () => {
      live = false;
      revokeVideoUrl(made);
    };
  }, [shownId]);

  const imageAssets = (project?.assets ?? []).filter((a) => a.kind !== "ai");
  const current = project?.steps.filter((s) => s.ok == null).pop();
  const eleven = !!options?.elevenVoices;
  const words = form.script.trim() ? form.script.trim().split(/\s+/).length : 0;

  return (
    <div className="video-tab">
      <SidebarSlot slot={sidebarSlot}>
        <button
          className="sidebar-new"
          onClick={() => {
            startNew();
            onCloseDrawer?.();
          }}
        >
          + New video
        </button>
        <div className="video-library">
          {projects.length === 0 && <div className="image-history-empty">Your videos appear here.</div>}
          {projects.map((p) => (
            <div
              key={p.id}
              className={project?.id === p.id ? "video-item active" : "video-item"}
              onClick={() => {
                void open(p.id);
                onCloseDrawer?.();
              }}
            >
              <div className="video-item-top">
                <span
                  className={`video-dot ${
                    p.status === "running" ? "in_progress" : p.status === "failed" ? "failed" : p.versions ? "completed" : "chat"
                  }`}
                  aria-hidden="true"
                />
                <span className="video-item-title">{p.title || "Untitled"}</span>
                <button
                  className="history-del"
                  title="Delete this video and its versions"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeProject(p.id);
                  }}
                >
                  ×
                </button>
              </div>
              <div className="video-item-meta">
                {p.status === "running"
                  ? "Making…"
                  : p.versions
                    ? `${p.versions} version${p.versions > 1 ? "s" : ""}`
                    : "Draft"}
              </div>
            </div>
          ))}
        </div>
      </SidebarSlot>

      <div className={dropHover ? "image-controls-col drop-hover" : "image-controls-col"} ref={leftRef}>
        <div className="field">
          <label>Writing &amp; animation model</label>
          <ModelSelect
            settings={settings}
            ollamaModels={ollamaModels}
            orModels={orModels}
            directModels={directModels.models}
            directLoading={directModels.loading}
            directError={directModels.error}
            onChange={onChange}
            onRefresh={() => {
              refreshOR();
              void refreshOllama();
            }}
          />
        </div>

        <div className="field">
          <label>Image model</label>
          <select value={form.imageModel} onChange={(e) => set({ imageModel: e.target.value })}>
            <option value="">
              Newest that makes cut-outs{options?.imageModels[0] ? ` (${options.imageModels[0].name})` : ""}
            </option>
            {(options?.imageModels ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Voice</label>
          <div className="segmented">
            <button
              className={form.voiceSource !== "elevenlabs" ? "seg active" : "seg"}
              onClick={() => set({ voiceSource: "openrouter" })}
            >
              OpenRouter
            </button>
            <button
              className={form.voiceSource === "elevenlabs" ? "seg active" : "seg"}
              onClick={() => set({ voiceSource: "elevenlabs" })}
              disabled={!eleven}
              title={eleven ? "Your ElevenLabs account" : options?.elevenError || "Add an ElevenLabs key in Settings"}
            >
              ElevenLabs
            </button>
          </div>
          <div className="video-voice-row">
            {form.voiceSource === "elevenlabs" ? (
              <select
                value={form.voice}
                onChange={(e) => {
                  const v = elevenVoices.find((x) => x.id === e.target.value);
                  set({ voice: e.target.value, voiceName: v?.name ?? "" });
                }}
              >
                {elevenVoices.map((v) => (
                  <option key={v.id} value={v.id} title={v.tags}>
                    {v.name}
                    {v.tags ? ` — ${v.tags}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <select value={speechModel?.id ?? ""} onChange={(e) => set({ speechModel: e.target.value })}>
                  {speechModels.length === 0 && <option value="">{options ? "No speech models" : "Loading…"}</option>}
                  {speechModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <select value={form.voice} onChange={(e) => set({ voice: e.target.value, voiceName: e.target.value })}>
                  {(speechModel?.voices ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button
              className="btn"
              onClick={() => void playSample()}
              disabled={!form.voice || busy === "sample"}
              title="Hear this voice (a fraction of a cent)"
            >
              {busy === "sample" ? "…" : "▶"}
            </button>
          </div>
          {sampleUrl && <audio className="video-sample" src={sampleUrl} controls autoPlay />}
          {options?.error && <p className="hint err">{options.error}</p>}
        </div>

        <div className="field">
          <label>Format</label>
          <div className="segmented">
            {FORMATS.map(([v, label]) => (
              <button key={v} className={form.format === v ? "seg active" : "seg"} onClick={() => set({ format: v })}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="video-length-label">
            Length <span>{clock(form.seconds)}</span>
          </label>
          <input
            type="range"
            className="video-length"
            min={MIN_SECONDS}
            max={MAX_SECONDS}
            step={5}
            value={Math.min(Math.max(form.seconds, MIN_SECONDS), MAX_SECONDS)}
            onChange={(e) => set({ seconds: Number(e.target.value) })}
          />
          <div className="video-length-scale">
            {[10, 30, 60, 90, 120].map((n) => (
              <span key={n} style={{ left: `${((n - MIN_SECONDS) / (MAX_SECONDS - MIN_SECONDS)) * 100}%` }}>
                {n < 60 ? `${n} s` : `${n / 60} min`}
              </span>
            ))}
          </div>
        </div>

        <div className="video-row">
          <div className="field">
            <label>Type</label>
            <div className="segmented">
              <button className={form.kind !== "explainer" ? "seg active" : "seg"} onClick={() => set({ kind: "ad" })}>
                Ad
              </button>
              <button
                className={form.kind === "explainer" ? "seg active" : "seg"}
                onClick={() => set({ kind: "explainer" })}
              >
                Explainer
              </button>
            </div>
          </div>
          <div className="field">
            <label>Language</label>
            <select value={form.language} onChange={(e) => set({ language: e.target.value })}>
              {(LANGUAGES.includes(form.language) ? LANGUAGES : [form.language, ...LANGUAGES]).map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>What&apos;s it about?</label>
          <textarea
            rows={4}
            value={form.brief}
            placeholder="What it's for and who should watch it. Paste an App Store link or website and the real icon and screenshots are used."
            onChange={(e) => set({ brief: e.target.value })}
          />
        </div>

        <div className="field">
          <label>Your images</label>
          <div className="video-assets">
            {project &&
              imageAssets.map((a) => (
                <AssetThumb
                  key={a.file}
                  id={project.id}
                  file={a.file}
                  note={a.kind === "user" ? a.note : a.kind === "icon" ? "App icon (App Store)" : "Screenshot (App Store)"}
                  onRemove={() =>
                    void motionRemoveAsset(project.id, a.file).then(setProject, (e) => toastError(String(e)))
                  }
                />
              ))}
            {Array.from({ length: adding }, (_, k) => (
              <div key={`adding-${k}`} className="video-asset pending">
                <span>…</span>
              </div>
            ))}
            <button
              className="video-asset add"
              onClick={() => fileRef.current?.click()}
              title="Add a logo, product photos or screenshots — or drop them here"
            >
              +
            </button>
          </div>
          <p className="hint">Logos and photos are used as they are, transparency included. Drop them anywhere here.</p>
          <input
            type="file"
            ref={fileRef}
            hidden
            multiple
            accept="image/*,.heic"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []).filter(isImageFile);
              if (files.length) void addImages(files.map((f) => () => attachFile(f)));
              e.target.value = "";
            }}
          />
        </div>

        <div className="field">
          <label className="video-script-label">
            Script
            <button className="btn tiny" onClick={() => void writeScript()} disabled={busy !== "" || running}>
              {busy === "script" ? "Writing…" : form.script ? "Write again" : "Write script"}
            </button>
          </label>
          <input value={form.title} placeholder="Title" onChange={(e) => set({ title: e.target.value })} />
          <textarea
            rows={7}
            value={form.script}
            placeholder="What the voice says. Write it yourself, or let “Write script” draft it from what it's about."
            onChange={(e) => set({ script: e.target.value })}
          />
          {words > 0 && (
            <p className="hint">
              {words} words · about {Math.round(words / 2.5)}s spoken
            </p>
          )}
        </div>

        <button
          className="btn primary big"
          onClick={() => void make()}
          disabled={busy !== "" || running || !form.script.trim() || !form.voice}
        >
          {running ? "Making…" : busy === "make" ? "Starting…" : project?.versions ? "Make a new version" : "Make video"}
        </button>
        <p className="hint">Made on this Mac in a few minutes — usually 5–15 cents.</p>
      </div>

      <div className="video-stage">
        {running ? (
          <div className="video-progress">
            <b>{current?.title ?? "Starting"}…</b>
            <ul>
              {(project?.steps ?? []).map((s, i) => (
                <li key={i} className={s.ok === false ? "err" : s.ok ? "ok" : "now"}>
                  <span>{s.ok == null ? "…" : s.ok ? "✓" : "✗"}</span> {s.title}
                </li>
              ))}
            </ul>
            <button className="btn" onClick={() => project && void motionStop(project.id)}>
              Stop
            </button>
          </div>
        ) : shownId && playUrl ? (
          <>
            <video key={shownId} className="video-player" src={playUrl} controls autoPlay playsInline />
            {versions.length > 1 && (
              <div className="video-versions segmented">
                {[...versions].reverse().map((v, i) => (
                  <button
                    key={v.id}
                    className={v.id === shownId ? "seg active" : "seg"}
                    onClick={() => setShown(v.id)}
                    title={v.prompt}
                  >
                    v{i + 1}
                  </button>
                ))}
              </div>
            )}
            <div className="preview-actions">
              <button
                className="btn"
                onClick={() =>
                  void saveVideo(shownId, (shownRec?.prompt ?? project?.title ?? "video").slice(0, 40)).then(
                    (p) => toastOk(`Saved to ${p}`),
                    (e) => toastError(String(e))
                  )
                }
              >
                {isTauri() ? "Save MP4" : "Save to Mac"}
              </button>
              <button
                className="btn danger"
                onClick={() =>
                  void deleteVideo(shownId).then(() => {
                    setShown(null);
                    void loadLibrary();
                  })
                }
              >
                Delete this version
              </button>
            </div>
            {shownRec && (
              <p className="hint">
                {shownRec.duration ? `${shownRec.duration}s` : ""}
                {shownRec.resolution ? ` · ${shownRec.resolution}` : ""}
                {typeof shownRec.cost === "number" && shownRec.cost > 0 ? ` · $${shownRec.cost.toFixed(2)}` : ""}
              </p>
            )}
            <div className="video-change">
              <textarea
                rows={2}
                value={feedback}
                placeholder="Change something — “make the logo bigger”, “calmer colours”, “end on the App Store badge”"
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void revise();
                }}
              />
              <div className="video-change-row">
                <select value={redo} onChange={(e) => setRedo(e.target.value)}>
                  {REDO.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
                <button className="btn primary" onClick={() => void revise()} disabled={!feedback.trim() || busy !== ""}>
                  {busy === "revise" ? "…" : "Change it"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="image-placeholder">
            {project?.status === "failed" && project.error ? (
              <>
                <b>That didn&apos;t work.</b>
                <br />
                <span className="muted">{project.error}</span>
              </>
            ) : (
              <>
                Your video appears here.
                <br />
                <span className="muted">
                  Say what it&apos;s about, add your logo, write the script — then Make video. Voice, images, music and
                  animation are made on this Mac.
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
