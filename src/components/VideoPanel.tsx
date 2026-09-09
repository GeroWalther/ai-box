// The Video tab: brief → prompt → clip, or brief → storyboard → a cut film.
//
// Three things make this usable for real work rather than a demo:
//
//  1. Nothing about a model is hardcoded. The catalog comes from OpenRouter at
//     runtime, and every control below (durations, resolutions, aspect ratios,
//     frame slots, audio, seed) is built from the selected model's declared
//     capabilities — so Kling, Veo, Seedance, PixVerse and whatever ships next
//     each get exactly the options they accept, and no invalid combination can
//     be submitted.
//
//  2. A render is a job, not a request. The record is written before the first
//     poll, so quitting mid-render doesn't lose it — pending jobs are picked up
//     again on next launch. Polling is driven here rather than held open in
//     Rust, which is also what lets a phone drive the same job.
//
//  3. An ad is usually several shots. Storyboard mode boards the spot with the
//     text model, queues each shot as its own clip, and joins the finished
//     shots into one MP4.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Settings } from "../lib/settings";
import { resolveTextProvider } from "../lib/settings";
import { chatCompletion } from "../lib/agent";
import {
  AD_TONES,
  buildStoryboardMessages,
  buildVideoPromptMessages,
  parseStoryboard,
  type AdBrief,
  type Shot,
} from "../lib/presets";
import {
  createVideo,
  downloadVideo,
  listVideoModels,
  saveVideo,
  stitchAvailable,
  stitchVideos,
  videoStatus,
  type VideoFrame,
  type VideoModel,
} from "../lib/api";
import {
  allVideos,
  deleteVideo,
  getVideo,
  isPending,
  putVideo,
  revokeVideoUrl,
  videoObjectUrl,
  type VideoRecord,
} from "../lib/videoStore";
import { isTauri } from "../lib/transport";
import { logError } from "../lib/log";
import { useToast } from "../lib/toast";
import { SidebarSlot } from "./SidebarList";
import { registerSyncSource } from "../lib/syncBus";

/** How often a running job is polled, and when to give up on it. */
const POLL_MS = 5000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Sort key for a resolution label. OpenRouter mixes notations — "480p", "768p",
 * "1080p", "2K", "4K" — and returns them in no particular order, so rank has to
 * be computed rather than inferred from position. Anything unrecognised sorts
 * last instead of being dropped, so a new notation still appears in the picker.
 */
export function resRank(label: string): number {
  const p = /^(\d+)p$/i.exec(label.trim());
  if (p) return Number(p[1]);
  const k = /^(\d+(?:\.\d+)?)k$/i.exec(label.trim());
  if (k) return Number(k[1]) * 1000;
  return Number.MAX_SAFE_INTEGER;
}

const EMPTY_BRIEF: AdBrief = {
  product: "",
  audience: "",
  message: "",
  tone: AD_TONES[0],
  notes: "",
};

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** A scene or product line handed over from Write / Images. */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
  sidebarSlot: HTMLElement | null;
  onCloseDrawer?: () => void;
}

export default function VideoPanel({
  settings,
  onChange,
  prefill,
  onPrefillConsumed,
  sidebarSlot,
  onCloseDrawer,
}: Props) {
  const { success: toastOk, error: toastError } = useToast();

  const [models, setModels] = useState<VideoModel[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  const [mode, setMode] = useState<"single" | "storyboard">("single");
  const [prompt, setPrompt] = useState("");
  const [brief, setBrief] = useState<AdBrief>(EMPTY_BRIEF);
  const [briefOpen, setBriefOpen] = useState(true);
  const [writingPrompt, setWritingPrompt] = useState(false);
  const [shots, setShots] = useState<Shot[]>([]);

  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [lastFrame, setLastFrame] = useState<string | null>(null);
  const [seed, setSeed] = useState(-1);

  const [library, setLibrary] = useState<VideoRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [canStitch, setCanStitch] = useState(false);
  const [stitching, setStitching] = useState(false);

  // Jobs this panel is polling, so a re-render (or reopening the tab) never
  // starts a second poll loop for the same clip.
  const polling = useRef<Set<string>>(new Set());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apiKey = settings.openrouterKey;

  /**
   * The picker, grouped by family. The grouping is DERIVED from the catalog
   * ("Kling: Video v3.0 Pro" → Kling), never a list of families kept in this
   * file — so a new vendor gets its own heading the day it appears. Families
   * are ordered by their newest model, and so are the models inside each.
   */
  const families = useMemo(() => {
    const groups = new Map<string, VideoModel[]>();
    for (const m of models) {
      const label = m.name.includes(":")
        ? m.name.split(":")[0].trim()
        : m.id.split("/")[0];
      const bucket = groups.get(label);
      if (bucket) bucket.push(m);
      else groups.set(label, [m]);
    }
    return [...groups.entries()]
      .map(([label, list]) => ({ label, list }))
      .sort((a, b) => b.list[0].created - a.list[0].created);
  }, [models]);
  const model = useMemo(
    () => models.find((m) => m.id === settings.videoModel) ?? models[0] ?? null,
    [models, settings.videoModel]
  );

  // ---- catalog ------------------------------------------------------------

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const list = await listVideoModels(apiKey);
      if (!alive.current) return;
      setModels(list);
      setCatalogError("");
      // Keep the saved choice if it still exists; otherwise fall to the newest.
      if (list.length && !list.some((m) => m.id === settings.videoModel)) {
        onChange({ videoModel: list[0].id });
      }
    } catch (e) {
      if (!alive.current) return;
      setCatalogError(String(e));
      logError("video.catalog", e);
    } finally {
      if (alive.current) setLoadingCatalog(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    stitchAvailable().then(setCanStitch).catch(() => setCanStitch(false));
  }, []);

  /**
   * The options a model offers, in an order a person expects.
   *
   * OpenRouter's arrays are NOT sorted — veo-3.1-lite reports durations
   * [8, 4, 6] and hailuo-3-max reports resolutions ['768p', '480p'] — so
   * anything that treats position as rank ("the last one is the highest") is
   * wrong. Everything below sorts explicitly instead.
   */
  const caps = useMemo(() => {
    if (!model) return null;
    return {
      durations: [...model.durations].sort((a, b) => a - b),
      resolutions: [...model.resolutions].sort((a, b) => resRank(a) - resRank(b)),
      aspects: model.aspectRatios,
    };
  }, [model]);

  /**
   * The values this render will actually submit.
   *
   * These are DERIVED, not read straight from settings, because a stored choice
   * can be one this model doesn't offer — pick Hailuo 3 (2K only), then switch
   * to Kling (720p only), and "2K" is still sitting in settings. Reconciling
   * that through an effect left a window where the dropdown showed one thing
   * and the request carried another. Deriving it here means what you see is
   * always what gets sent, and an unsupported value can never reach the API.
   */
  const chosen = useMemo(() => {
    if (!caps || !model) return null;
    return {
      duration: caps.durations.includes(settings.videoDuration)
        ? settings.videoDuration
        : // Default to the shortest take of at least 4s — long enough to read
          // as a shot, and the cheapest way to see what a model does.
          (caps.durations.find((d) => d >= 4) ?? caps.durations[0] ?? 0),
      resolution: caps.resolutions.includes(settings.videoResolution)
        ? settings.videoResolution
        : // 720p when offered: the quality/price sweet spot, and never a
          // silent jump to the model's priciest tier.
          (caps.resolutions.find((r) => r === "720p") ?? caps.resolutions[0] ?? ""),
      aspect: caps.aspects.includes(settings.videoAspect)
        ? settings.videoAspect
        : (caps.aspects.find((a) => a === "16:9") ?? caps.aspects[0] ?? ""),
      audio: model.generateAudio ? settings.videoAudio : false,
    };
  }, [caps, model, settings.videoDuration, settings.videoResolution, settings.videoAspect, settings.videoAudio]);

  // A prompt handed over from another tab.
  useEffect(() => {
    if (prefill?.trim()) {
      setPrompt(prefill.trim().slice(0, 1500));
      onPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // ---- library ------------------------------------------------------------

  const loadLibrary = useCallback(async (selectNewest: boolean) => {
    const rows = await allVideos().catch(() => [] as VideoRecord[]);
    if (!alive.current) return rows;
    setLibrary(rows);
    if (selectNewest) {
      const playable = rows.find((r) => r.status === "completed");
      if (playable) void openClip(playable.id);
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount: show the library, then pick up anything still rendering. This is
  // the resume path — a job left running when the app quit continues here.
  useEffect(() => {
    loadLibrary(true).then((rows) => {
      for (const r of rows) if (isPending(r)) void trackJob(r);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => registerSyncSource("videos", () => loadLibrary(false).then(() => undefined)),
    [loadLibrary]
  );

  // Free the Blob when the selection changes or the tab unmounts — these are
  // tens of megabytes each, so leaking them is not a rounding error.
  useEffect(() => () => revokeVideoUrl(playUrl), [playUrl]);

  async function openClip(id: string) {
    setActiveId(id);
    const rec = await getVideo(id).catch(() => null);
    if (!rec || rec.status !== "completed") {
      setPlayUrl((old) => {
        revokeVideoUrl(old);
        return null;
      });
      return;
    }
    try {
      const url = await videoObjectUrl(id);
      if (!alive.current) {
        revokeVideoUrl(url);
        return;
      }
      setPlayUrl((old) => {
        revokeVideoUrl(old);
        return url;
      });
    } catch (e) {
      logError("video.open", e);
      toastError("That clip's file is missing.");
    }
  }

  /** Write a record and refresh the library in one step. */
  async function saveRecord(rec: VideoRecord) {
    await putVideo(rec).catch((e) => logError("video.put", e));
    if (!alive.current) return;
    setLibrary((rows) => {
      const next = rows.filter((r) => r.id !== rec.id);
      next.unshift(rec);
      next.sort((a, b) => b.at - a.at);
      return next;
    });
  }

  // ---- the job loop -------------------------------------------------------

  /**
   * Poll one submitted job to a terminal state, then fetch its MP4. Safe to
   * call twice for the same clip — the second call returns immediately.
   */
  async function trackJob(rec: VideoRecord) {
    if (polling.current.has(rec.id)) return;
    polling.current.add(rec.id);
    const started = Date.now();
    try {
      for (;;) {
        if (!alive.current) return;
        if (Date.now() - started > JOB_TIMEOUT_MS) {
          await saveRecord({
            ...rec,
            status: "failed",
            error: "Gave up waiting after 30 minutes. The job may still finish on OpenRouter.",
          });
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!alive.current) return;

        let job;
        try {
          job = await videoStatus(apiKey, rec.jobId);
        } catch (e) {
          // A transient network blip must not kill a paid render — keep polling
          // and let the timeout above be the only thing that gives up.
          logError("video.poll", e);
          continue;
        }

        if (job.status === "pending" || job.status === "in_progress") {
          if (rec.status !== job.status) {
            rec = { ...rec, status: job.status };
            await saveRecord(rec);
          }
          continue;
        }

        if (job.status !== "completed" || !job.url) {
          await saveRecord({
            ...rec,
            status: job.status === "completed" ? "failed" : job.status,
            error: job.error || `Generation ${job.status}.`,
          });
          toastError(job.error || `That shot ${job.status}.`);
          return;
        }

        const { bytes } = await downloadVideo(apiKey, rec.id, job.url);
        const done: VideoRecord = {
          ...rec,
          status: "completed",
          bytes,
          cost: job.cost ?? undefined,
        };
        await saveRecord(done);
        if (alive.current && !activeIdRef.current) void openClip(done.id);
        toastOk(rec.shot ? `Shot ${rec.shot} is ready.` : "Your clip is ready.");
        return;
      }
    } catch (e) {
      logError("video.job", e);
      await saveRecord({ ...rec, status: "failed", error: String(e) });
      toastError(String(e));
    } finally {
      polling.current.delete(rec.id);
    }
  }

  // trackJob runs outside React's render, so it reads the selection via a ref.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  /**
   * The frame slots apply to a single clip only. Pinning the same still as the
   * first frame of every storyboard shot would make all of them open on the
   * identical image, which is the opposite of a cut sequence.
   */
  function frames(): VideoFrame[] {
    const out: VideoFrame[] = [];
    if (mode !== "single") return out;
    if (firstFrame && model?.frameImages.includes("first_frame")) {
      out.push({ url: firstFrame, frameType: "first_frame" });
    }
    if (lastFrame && model?.frameImages.includes("last_frame")) {
      out.push({ url: lastFrame, frameType: "last_frame" });
    }
    return out;
  }

  /** Submit one shot and start tracking it. Returns the new record's id. */
  async function submit(text: string, shot?: { index: number; boardId: string }) {
    if (!model) throw new Error("Pick a video model first.");
    const { id: jobId } = await createVideo({
      apiKey,
      model: model.id,
      prompt: text,
      duration: chosen?.duration || undefined,
      resolution: chosen?.resolution || undefined,
      aspectRatio: chosen?.aspect || undefined,
      generateAudio: model.generateAudio ? chosen?.audio : undefined,
      seed: model.seed && seed >= 0 ? seed : undefined,
      frameImages: frames(),
    });
    const rec: VideoRecord = {
      id: crypto.randomUUID(),
      jobId,
      prompt: text,
      model: model.id,
      modelName: model.name || model.id,
      status: "pending",
      at: Date.now(),
      duration: chosen?.duration || undefined,
      resolution: chosen?.resolution || undefined,
      aspect: chosen?.aspect || undefined,
      audio: chosen?.audio ?? false,
      shot: shot?.index,
      storyboardId: shot?.boardId,
    };
    await saveRecord(rec);
    void trackJob(rec);
    return rec.id;
  }

  async function generateSingle() {
    if (!prompt.trim()) {
      toastError("Write a prompt, or fill in the brief and let the model write one.");
      return;
    }
    setSubmitting(true);
    try {
      const id = await submit(prompt.trim());
      setActiveId(id);
      setPlayUrl((old) => {
        revokeVideoUrl(old);
        return null;
      });
    } catch (e) {
      toastError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function generateStoryboard() {
    if (!shots.length) {
      toastError("Board the shots first.");
      return;
    }
    setSubmitting(true);
    const boardId = crypto.randomUUID();
    try {
      // Submitted in order and one at a time: providers rate-limit hard, and a
      // rejected shot four should not orphan shots one to three.
      for (let i = 0; i < shots.length; i++) {
        await submit(shots[i].prompt, { index: i + 1, boardId });
      }
      toastOk(`${shots.length} shots queued. They render in the background.`);
    } catch (e) {
      toastError(`Queued what I could — ${e}`);
    } finally {
      setSubmitting(false);
    }
  }

  // ---- the brief ----------------------------------------------------------

  /** Ask the text model to turn the brief into shot language. */
  async function askTextModel(messages: ReturnType<typeof buildVideoPromptMessages>) {
    const provider = resolveTextProvider(settings);
    if (!provider.model) throw new Error("Pick a text model in Settings first.");
    const msg = await chatCompletion({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages,
      tools: [],
      temperature: 0.7,
    });
    return (msg.content || "").trim();
  }

  async function writePrompt() {
    if (!brief.product.trim()) {
      toastError("At least say what the ad is for.");
      return;
    }
    setWritingPrompt(true);
    try {
      const seconds = chosen?.duration || 5;
      const out = await askTextModel(buildVideoPromptMessages(brief, seconds));
      if (out) {
        setPrompt(out);
        setBriefOpen(false);
      } else toastError("The model returned nothing — try again.");
    } catch (e) {
      toastError(String(e));
    } finally {
      setWritingPrompt(false);
    }
  }

  async function boardShots() {
    if (!brief.product.trim()) {
      toastError("At least say what the ad is for.");
      return;
    }
    setWritingPrompt(true);
    try {
      const seconds = chosen?.duration || 5;
      const raw = await askTextModel(
        buildStoryboardMessages(brief, settings.videoShots, seconds)
      );
      const parsed = parseStoryboard(raw);
      if (!parsed.length) {
        toastError("Couldn't read a shot list back — try again.");
        return;
      }
      setShots(parsed);
      setBriefOpen(false);
    } catch (e) {
      toastError(String(e));
    } finally {
      setWritingPrompt(false);
    }
  }

  // ---- clip actions -------------------------------------------------------

  const active = library.find((r) => r.id === activeId) ?? null;

  async function save() {
    if (!active) return;
    try {
      const path = await saveVideo(active.id, active.prompt.slice(0, 40));
      toastOk(`Saved to ${path}`);
    } catch (e) {
      toastError(String(e));
    }
  }

  async function removeClip(id: string) {
    await deleteVideo(id).catch(() => {});
    setLibrary((rows) => rows.filter((r) => r.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setPlayUrl((old) => {
        revokeVideoUrl(old);
        return null;
      });
    }
  }

  /** The finished shots of the selected clip's storyboard, in shot order. */
  const boardShotsDone = useMemo(() => {
    const boardId = active?.storyboardId;
    if (!boardId) return [];
    return library
      .filter((r) => r.storyboardId === boardId && r.status === "completed")
      .sort((a, b) => (a.shot ?? 0) - (b.shot ?? 0));
  }, [library, active?.storyboardId]);

  async function joinBoard() {
    if (boardShotsDone.length < 2) return;
    setStitching(true);
    try {
      const path = await stitchVideos(
        boardShotsDone.map((r) => r.id),
        brief.product.trim() || "ai-box-film"
      );
      toastOk(`Joined ${boardShotsDone.length} shots → ${path}`);
    } catch (e) {
      toastError(String(e));
    } finally {
      setStitching(false);
    }
  }

  function readFrame(e: React.ChangeEvent<HTMLInputElement>, set: (v: string) => void) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => set(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  const pendingCount = library.filter(isPending).length;
  const needsKey = !apiKey;

  // ---- render -------------------------------------------------------------

  return (
    <div className="video-tab">
      <SidebarSlot slot={sidebarSlot}>
        <button
          className="sidebar-new"
          onClick={() => {
            setActiveId(null);
            setPlayUrl((old) => {
              revokeVideoUrl(old);
              return null;
            });
            onCloseDrawer?.();
          }}
        >
          + New clip
        </button>
        <div className="video-library">
          {library.length === 0 && (
            <div className="image-history-empty">Your clips appear here.</div>
          )}
          {library.map((r) => (
            <div
              key={r.id}
              className={activeId === r.id ? "video-item active" : "video-item"}
              title={r.prompt}
              onClick={() => {
                void openClip(r.id);
                onCloseDrawer?.();
              }}
            >
              <div className="video-item-top">
                <span className={`video-dot ${r.status}`} aria-hidden="true" />
                <span className="video-item-title">
                  {r.shot ? `Shot ${r.shot} · ` : ""}
                  {r.prompt.slice(0, 60) || "Untitled"}
                </span>
                <button
                  className="history-del"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeClip(r.id);
                  }}
                >
                  ×
                </button>
              </div>
              <div className="video-item-meta">
                {r.modelName}
                {r.duration ? ` · ${r.duration}s` : ""}
                {isPending(r) ? " · rendering…" : ""}
                {r.status === "failed" ? " · failed" : ""}
              </div>
            </div>
          ))}
        </div>
      </SidebarSlot>

      <div className="image-controls-col">
        <div className="field">
          <label>What you're making</label>
          <div className="segmented">
            <button
              className={mode === "single" ? "seg active" : "seg"}
              onClick={() => setMode("single")}
            >
              Single clip
            </button>
            <button
              className={mode === "storyboard" ? "seg active" : "seg"}
              onClick={() => setMode("storyboard")}
            >
              Storyboard ad
            </button>
          </div>
        </div>

        {needsKey && (
          <p className="hint error">
            Video generation runs through OpenRouter — add your API key in
            Settings. Your key stays on this Mac; a paired phone never receives it.
          </p>
        )}

        <div className="field">
          <label>
            Model{" "}
            <span className="muted">
              {loadingCatalog ? "· loading…" : `· ${models.length} live`}
            </span>
          </label>
          <div className="row-inline">
            <select
              value={model?.id ?? ""}
              onChange={(e) => onChange({ videoModel: e.target.value })}
              disabled={!models.length}
            >
              {!models.length && <option value="">— no models —</option>}
              {families.map((f) => (
                <optgroup key={f.label} label={f.label}>
                  {f.list.map((m) => (
                    <option key={m.id} value={m.id} title={m.description}>
                      {/* The family is already the heading — don't repeat it. */}
                      {(m.name || m.id).replace(/^[^:]+:\s*/, "")}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button className="btn" onClick={() => void loadCatalog()} title="Refresh the catalog">
              ↻
            </button>
          </div>
          {catalogError && <p className="hint error">{catalogError}</p>}
          {model && <ModelFacts model={model} />}
        </div>

        {model && (
          <>
            <div className="row-2">
              {caps && caps.durations.length > 0 && (
                <div className="field">
                  <label>Length</label>
                  <select
                    value={chosen?.duration ?? caps.durations[0]}
                    onChange={(e) => onChange({ videoDuration: Number(e.target.value) })}
                  >
                    {caps.durations.map((d) => (
                      <option key={d} value={d}>
                        {d}s
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {caps && caps.resolutions.length > 0 && (
                <div className="field">
                  <label>Resolution</label>
                  <select
                    value={chosen?.resolution ?? caps.resolutions[0]}
                    onChange={(e) => onChange({ videoResolution: e.target.value })}
                  >
                    {caps.resolutions.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="row-2">
              {caps && caps.aspects.length > 0 && (
                <div className="field">
                  <label>Aspect</label>
                  <select
                    value={chosen?.aspect ?? caps.aspects[0]}
                    onChange={(e) => onChange({ videoAspect: e.target.value })}
                  >
                    {caps.aspects.map((a) => (
                      <option key={a} value={a}>
                        {a}
                        {a === "9:16" ? " · vertical" : a === "16:9" ? " · wide" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {model.seed && (
                <div className="field">
                  <label>
                    Seed <span className="muted">(−1 = random)</span>
                  </label>
                  <input
                    type="number"
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value))}
                  />
                </div>
              )}
            </div>

            {model.generateAudio && (
              <label className="video-check">
                <input
                  type="checkbox"
                  checked={chosen?.audio ?? false}
                  onChange={(e) => onChange({ videoAudio: e.target.checked })}
                />
                Generate audio with the video
              </label>
            )}

            {model.frameImages.length > 0 && (
              <div className="field">
                <label>
                  Frames <span className="muted">(optional — animate a still)</span>
                </label>
                <div className="video-frames">
                  {model.frameImages.includes("first_frame") && (
                    <FrameSlot
                      label="First frame"
                      value={firstFrame}
                      onPick={(e) => readFrame(e, setFirstFrame)}
                      onClear={() => setFirstFrame(null)}
                    />
                  )}
                  {model.frameImages.includes("last_frame") && (
                    <FrameSlot
                      label="Last frame"
                      value={lastFrame}
                      onPick={(e) => readFrame(e, setLastFrame)}
                      onClear={() => setLastFrame(null)}
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* The brief: what a person actually has, turned into shot language. */}
        <div className="field">
          <button className="video-disclosure" onClick={() => setBriefOpen((v) => !v)}>
            {briefOpen ? "▾" : "▸"} Ad brief
            <span className="muted"> — let the model write the shots</span>
          </button>
          {briefOpen && (
            <div className="video-brief">
              <input
                placeholder="Product or subject — e.g. a matte-black espresso machine"
                value={brief.product}
                onChange={(e) => setBrief({ ...brief, product: e.target.value })}
              />
              <input
                placeholder="Audience — e.g. people who care about their morning"
                value={brief.audience}
                onChange={(e) => setBrief({ ...brief, audience: e.target.value })}
              />
              <input
                placeholder="Message to land — e.g. café quality, thirty seconds"
                value={brief.message}
                onChange={(e) => setBrief({ ...brief, message: e.target.value })}
              />
              <select
                value={brief.tone}
                onChange={(e) => setBrief({ ...brief, tone: e.target.value })}
              >
                {AD_TONES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <textarea
                rows={2}
                placeholder="Brand notes — colours, props that must appear, anything to avoid"
                value={brief.notes}
                onChange={(e) => setBrief({ ...brief, notes: e.target.value })}
              />
              {mode === "storyboard" && (
                <div className="field">
                  <label>Shots</label>
                  <select
                    value={settings.videoShots}
                    onChange={(e) => onChange({ videoShots: Number(e.target.value) })}
                  >
                    {[2, 3, 4, 5, 6, 8].map((n) => (
                      <option key={n} value={n}>
                        {n} shots ·{" "}
                        {n * (chosen?.duration || 5)}s total
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <button
                className="btn"
                disabled={writingPrompt}
                onClick={() => void (mode === "single" ? writePrompt() : boardShots())}
              >
                {writingPrompt
                  ? "Thinking…"
                  : mode === "single"
                    ? "✦ Write the prompt"
                    : "✦ Board the shots"}
              </button>
            </div>
          )}
        </div>

        {mode === "single" ? (
          <div className="field">
            <label>Prompt</label>
            <textarea
              rows={6}
              placeholder="Slow dolly-in on a matte-black espresso machine on a walnut counter, morning light raking through a window, steam curling from the cup, warm amber palette, shallow depth of field…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
        ) : (
          <div className="field">
            <label>
              Shot list <span className="muted">— edit any shot before rendering</span>
            </label>
            {shots.length === 0 ? (
              <p className="hint">Fill in the brief above and board the shots.</p>
            ) : (
              <div className="video-shots">
                {shots.map((s, i) => (
                  <div className="video-shot" key={i}>
                    <div className="video-shot-head">
                      <span>
                        {i + 1}. {s.title}
                      </span>
                      <button
                        className="btn ghost tiny"
                        onClick={() => setShots(shots.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    </div>
                    <textarea
                      rows={3}
                      value={s.prompt}
                      onChange={(e) =>
                        setShots(
                          shots.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x))
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          className="btn primary big"
          disabled={submitting || needsKey || !model}
          onClick={() => void (mode === "single" ? generateSingle() : generateStoryboard())}
        >
          {submitting
            ? "Submitting…"
            : mode === "single"
              ? "Generate clip"
              : `Render ${shots.length || ""} shots`}
        </button>
        {pendingCount > 0 && (
          <p className="hint">
            {pendingCount} {pendingCount === 1 ? "clip is" : "clips are"} rendering. You can
            leave this tab — they keep going, and unfinished ones resume next launch.
          </p>
        )}
      </div>

      <div className="image-preview-col">
        {active && isPending(active) ? (
          <Rendering rec={active} />
        ) : active && active.status === "failed" ? (
          <div className="image-placeholder">
            That render failed.
            <br />
            <span className="muted">{active.error}</span>
          </div>
        ) : playUrl && active ? (
          <>
            <video className="video-player" src={playUrl} controls autoPlay loop playsInline />
            <div className="preview-actions">
              <button className="btn" onClick={() => void save()}>
                {isTauri() ? "Save MP4" : "Save to Mac"}
              </button>
              {boardShotsDone.length >= 2 && (
                <button
                  className="btn"
                  disabled={stitching || !canStitch}
                  title={
                    canStitch
                      ? "Join this storyboard's finished shots into one MP4"
                      : "Needs ffmpeg — install it with `brew install ffmpeg`"
                  }
                  onClick={() => void joinBoard()}
                >
                  {stitching
                    ? "Joining…"
                    : `⧉ Join ${boardShotsDone.length} shots into one film`}
                </button>
              )}
              <button
                className="btn"
                onClick={() => setPrompt(active.prompt)}
                title="Put this clip's prompt back in the box to iterate on it"
              >
                Reuse prompt
              </button>
              <button className="btn danger" onClick={() => void removeClip(active.id)}>
                Delete
              </button>
            </div>
            <p className="hint">
              {active.modelName}
              {active.duration ? ` · ${active.duration}s` : ""}
              {active.resolution ? ` · ${active.resolution}` : ""}
              {active.aspect ? ` · ${active.aspect}` : ""}
              {active.bytes ? ` · ${(active.bytes / 1e6).toFixed(1)} MB` : ""}
              {typeof active.cost === "number" ? ` · $${active.cost.toFixed(2)}` : ""}
            </p>
          </>
        ) : (
          <div className="image-placeholder">
            Your video appears here.
            <br />
            Clips render in the cloud and are stored on this Mac — the same
            library on your phone.
          </div>
        )}
      </div>
    </div>
  );
}

/** What the selected model actually accepts, straight from the live catalog. */
function ModelFacts({ model }: { model: VideoModel }) {
  const durations = [...model.durations].sort((a, b) => a - b);
  const resolutions = [...model.resolutions].sort((a, b) => resRank(a) - resRank(b));
  const price = model.pricing
    ? Object.entries(model.pricing)
        .slice(0, 1)
        .map(([k, v]) => `$${v} / ${k.replace(/_/g, " ")}`)
        .join("")
    : "";
  return (
    <p className="hint">
      {durations.length
        ? `${durations[0]}–${durations[durations.length - 1]}s`
        : "length set by the model"}
      {resolutions.length ? ` · up to ${resolutions[resolutions.length - 1]}` : ""}
      {model.generateAudio ? " · audio" : " · silent"}
      {model.frameImages.length ? " · image-to-video" : " · text-to-video"}
      {price ? ` · ${price}` : ""}
    </p>
  );
}

/** A first/last frame slot. */
function FrameSlot({
  label,
  value,
  onPick,
  onClear,
}: {
  label: string;
  value: string | null;
  onPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
}) {
  return (
    <div className="video-frame">
      {value ? (
        <>
          <img src={value} alt={label} />
          <button className="btn ghost tiny" onClick={onClear}>
            Remove
          </button>
        </>
      ) : (
        <label className="video-frame-drop">
          <input type="file" accept="image/*" onChange={onPick} hidden />
          <span>+ {label}</span>
        </label>
      )}
    </div>
  );
}

/** Rendering state, with an honest elapsed clock — these take minutes. */
function Rendering({ rec }: { rec: VideoRecord }) {
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - rec.at) / 1000));
  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - rec.at) / 1000)), 1000);
    return () => clearInterval(t);
  }, [rec.at]);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className="image-loading">
      <div className="spinner" />
      <div className="loading-title">
        {rec.shot ? `Rendering shot ${rec.shot}…` : "Rendering…"} {mm}:{ss}
      </div>
      <div className="loading-sub">
        {rec.modelName} typically takes 1–5 minutes. You can close AI Box — the job
        keeps running, and this picks it back up next launch.
      </div>
    </div>
  );
}
