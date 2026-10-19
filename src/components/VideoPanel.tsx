// The Video tab: a conversation with a video director that makes motion-
// graphics videos on this Mac, and the library of finished ones.
//
// A video chat is an assistant task of kind "video" (tasks.rs): it runs on the
// Mac, keeps going when this tab closes, and works the same from the phone.
// Images attached here — a logo, product photos — become the video's own
// images, kept as they are. Voice samples play in the thread; videos play in
// the pane on the right — the chat's newest, or whichever was picked.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "../lib/settings";
import { resolveTextProvider } from "../lib/settings";
import { saveVideo } from "../lib/api";
import {
  attachFile,
  attachPath,
  isImageFile,
  isImagePath,
  type Attached,
} from "../lib/attachments";
import {
  approveTask,
  deleteTask,
  getTask,
  isLive,
  listTasks,
  replyTask,
  sendToTask,
  startTask,
  stopTask,
  type Task,
  type TaskSummary,
} from "../lib/tasks";
import {
  allVideos,
  deleteVideo,
  revokeVideoUrl,
  videoObjectUrl,
  type VideoRecord,
} from "../lib/videoStore";
import { isTauri } from "../lib/transport";
import { logError } from "../lib/log";
import { useToast } from "../lib/toast";
import { useFileDrop } from "../hooks/useFileDrop";
import { SidebarSlot } from "./SidebarList";
import TaskThread, { AttachmentThumb } from "./TaskThread";
import { registerSyncSource } from "../lib/syncBus";

const STARTERS = [
  "A 30-second ad for my app — here's the App Store link: ",
  "A 45-second explainer video about ",
  "A 15-second teaser for my product launch, vertical for Reels",
];

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** A scene or product line handed over from Write / Images. */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
  sidebarSlot: HTMLElement | null;
  onCloseDrawer?: () => void;
}

function shortModel(id: string): string {
  return (id.split(/[/:]/).pop() || id).replace(/-\d{8}$/, "");
}

export default function VideoPanel({ settings, prefill, onPrefillConsumed, sidebarSlot, onCloseDrawer }: Props) {
  const { success: toastOk, error: toastError } = useToast();
  const [chats, setChats] = useState<TaskSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [library, setLibrary] = useState<VideoRecord[]>([]);
  // A video picked from the library or the thread; otherwise the pane shows
  // the open chat's newest.
  const [picked, setPicked] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attached[]>([]);
  const [attaching, setAttaching] = useState(0);
  const [sending, setSending] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const provider = resolveTextProvider(settings);

  const loadChats = useCallback(async () => {
    const rows = await listTasks().catch(() => [] as TaskSummary[]);
    const videos = rows.filter((t) => t.kind === "video");
    setChats(videos);
    return videos;
  }, []);
  const loadLibrary = useCallback(async () => {
    setLibrary(await allVideos().catch(() => [] as VideoRecord[]));
  }, []);

  // Open on the newest video chat.
  useEffect(() => {
    void loadLibrary();
    void loadChats().then((v) => {
      if (v[0]) openChat(v[0].id);
    });
  }, [loadChats, loadLibrary]);

  useEffect(() => registerSyncSource("videos", () => loadLibrary()), [loadLibrary]);

  // Something sent over from Write or Images: a new chat, about that.
  useEffect(() => {
    if (prefill?.trim()) {
      newChat();
      setInput(`A short video about: ${prefill.trim().slice(0, 500)}`);
      onPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // Follow the open chat. `since` makes an unchanged poll nearly free.
  const rev = task?.rev;
  useEffect(() => {
    if (!chatId) {
      setTask(null);
      return;
    }
    let live = true;
    const tick = async () => {
      const t = await getTask(chatId, task?.id === chatId ? rev : undefined).catch(() => null);
      if (!live || !t) return;
      setTask((old) => {
        // A new video in the thread: it is in the library now too.
        const videos = (x: Task | null) => x?.steps.filter((s) => s.kind === "video" && s.ok).length ?? 0;
        if (videos(t) !== videos(old)) {
          void loadLibrary();
          // A new one arrived (not just the chat opening): show it.
          if (old?.id === t.id) setPicked(null);
        }
        if (old?.status !== t.status) void loadChats();
        return t;
      });
    };
    void tick();
    const timer = setInterval(tick, task && isLive(task.status) ? 1000 : 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, rev, task?.status]);

  // Keep the newest message in view.
  const steps = task?.steps.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps, task?.pending?.id]);

  const chatVideos = (task?.steps ?? []).filter((s) => s.kind === "video" && s.ok && s.detail).map((s) => s.detail!);
  const shownId = picked ?? chatVideos[chatVideos.length - 1] ?? null;
  const shown = library.find((r) => r.id === shownId) ?? null;
  const lastStep = task?.steps[task.steps.length - 1];
  const making =
    task && isLive(task.status) && lastStep?.kind === "video" && lastStep.ok == null ? lastStep.title : null;

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
      (e) => {
        logError("video.open", e);
        if (live) setPlayUrl(null);
      }
    );
    return () => {
      live = false;
      revokeVideoUrl(made);
    };
  }, [shownId]);

  function openChat(id: string) {
    setChatId(id);
    setPicked(null);
  }

  function newChat() {
    setChatId(null);
    setTask(null);
    setPicked(null);
    setInput("");
    setAttachments([]);
  }

  async function send() {
    const text = input.trim();
    if ((!text && !attachments.length) || attaching > 0) return;
    if (!provider.model) {
      toastError("Pick a text model in Settings first — it directs the video and writes the animation.");
      return;
    }
    const images = attachments;
    setSending(true);
    setInput("");
    setAttachments([]);
    try {
      if (chatId) {
        await sendToTask(chatId, text, images, provider.baseUrl, provider.model);
        const t = await getTask(chatId);
        if (t) setTask(t);
      } else {
        const t = await startTask(text, images, provider.baseUrl, provider.model, [], "video");
        setTask(t);
        openChat(t.id);
        void loadChats();
      }
    } catch (e) {
      toastError(String(e));
      setInput(text);
      setAttachments(images);
    } finally {
      setSending(false);
    }
  }

  async function addImages(jobs: (() => Promise<Attached>)[]) {
    setAttaching((n) => n + jobs.length);
    await Promise.all(
      jobs.map(async (job) => {
        try {
          const a = await job();
          setAttachments((prev) => [...prev, a]);
        } catch (e) {
          logError("video.attach", e);
          toastError(String(e));
        } finally {
          setAttaching((n) => n - 1);
        }
      })
    );
  }

  const dropHover = useFileDrop({
    target: viewRef,
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

  async function removeVideo(id: string) {
    await deleteVideo(id).catch(() => {});
    setLibrary((rows) => rows.filter((r) => r.id !== id));
    if (picked === id) setPicked(null);
  }

  async function removeChat(id: string) {
    await deleteTask(id).catch(() => {});
    setChats((rows) => rows.filter((r) => r.id !== id));
    if (chatId === id) newChat();
  }

  const live = !!task && isLive(task.status);

  return (
    <div className="video-tab">
      <SidebarSlot slot={sidebarSlot}>
        <button
          className="sidebar-new"
          onClick={() => {
            newChat();
            onCloseDrawer?.();
          }}
        >
          + New video
        </button>
        <div className="video-library">
          {chats.length > 0 && <div className="video-section">Chats</div>}
          {chats.map((c) => (
            <div
              key={c.id}
              className={chatId === c.id ? "video-item active" : "video-item"}
              title={c.goal}
              onClick={() => {
                openChat(c.id);
                onCloseDrawer?.();
              }}
            >
              <div className="video-item-top">
                <span className={`video-dot ${isLive(c.status) ? "in_progress" : "chat"}`} aria-hidden="true" />
                <span className="video-item-title">{c.goal.slice(0, 60) || "Video"}</span>
                <button
                  className="history-del"
                  title="Delete this chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeChat(c.id);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
          <div className="video-section">Videos</div>
          {library.length === 0 && <div className="image-history-empty">Finished videos appear here.</div>}
          {library.map((r) => (
            <div
              key={r.id}
              className={shownId === r.id ? "video-item active" : "video-item"}
              title={r.prompt}
              onClick={() => {
                setPicked(r.id);
                onCloseDrawer?.();
              }}
            >
              <div className="video-item-top">
                <span className={`video-dot ${r.status}`} aria-hidden="true" />
                <span className="video-item-title">{r.prompt.slice(0, 60) || "Untitled"}</span>
                <button
                  className="history-del"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeVideo(r.id);
                  }}
                >
                  ×
                </button>
              </div>
              <div className="video-item-meta">
                {r.duration ? `${r.duration}s` : ""}
                {r.aspect ? ` · ${r.aspect}` : ""}
              </div>
            </div>
          ))}
        </div>
      </SidebarSlot>

      <div className={dropHover ? "chat-view drop-hover" : "chat-view"} ref={viewRef}>
          <div className="chat-scroll" ref={scrollRef}>
            {!task && (
              <div className="chat-empty video-empty">
                <b>What video do you want to make?</b>
                <br />
                Tell me what it's for — an ad, an explainer, a teaser — and drop in your logo or
                product photos. I'll ask what I need, write the script with you, and make it on this
                Mac: voice, music, animation. Usually a few minutes and a few cents.
                <div className="video-starters">
                  {STARTERS.map((s) => (
                    <button key={s} className="btn" onClick={() => setInput(s)}>
                      {s.replace(/: $/, "…")}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {task && (
              <TaskThread
                task={task}
                onApprove={(id, ok) => void approveTask(id, ok).catch((e) => toastError(String(e)))}
                onReply={(id, text) => void replyTask(id, text).catch((e) => toastError(String(e)))}
                onShowVideo={setPicked}
                shownVideo={shownId}
                renderImages={(imgs) => (
                  <div className="msg-images">
                    {imgs.map((a) => (
                      <AttachmentThumb key={a.id} a={a} />
                    ))}
                  </div>
                )}
              />
            )}
          </div>

          <div className="promptbar-wrap">
            <div className="composer">
              {(attachments.length > 0 || attaching > 0) && (
                <div className="attach-strip">
                  {attachments.map((a) => (
                    <AttachmentThumb
                      key={a.id}
                      a={a}
                      onRemove={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    />
                  ))}
                  {Array.from({ length: attaching }, (_, k) => (
                    <div key={`pending-${k}`} className="attach-thumb pending">
                      <span>…</span>
                    </div>
                  ))}
                </div>
              )}
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
              <textarea
                className="composer-input"
                rows={2}
                placeholder={
                  task?.status === "waiting"
                    ? "Answer, or say what to do instead…"
                    : live
                      ? "Working… you can tell it more"
                      : task
                        ? "What should change?"
                        : "Describe the video — and drop in your logo or product photos"
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.items)
                    .filter((i) => i.kind === "file")
                    .map((i) => i.getAsFile())
                    .filter((f): f is File => !!f && isImageFile(f));
                  if (!files.length) return;
                  e.preventDefault();
                  void addImages(files.map((f) => () => attachFile(f)));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-row">
                <button
                  className="btn ghost attach-btn"
                  title="Add your logo, product photos or screenshots (or drop / paste them)"
                  onClick={() => fileRef.current?.click()}
                >
                  📎
                </button>
                <span className="composer-chip" title="The text model — change it in Settings">
                  {shortModel(provider.model || "no model")}
                </span>
                <span className="composer-spacer" />
                {live && (
                  <button className="btn stop promptbar-send" onClick={() => void stopTask(task!.id)} title="Stop">
                    ■
                  </button>
                )}
                {(!live || input.trim() || attachments.length > 0) && (
                  <button
                    className="btn primary promptbar-send"
                    onClick={() => void send()}
                    disabled={sending || attaching > 0 || (!input.trim() && !attachments.length)}
                    title={attaching > 0 ? "Preparing images…" : "Send"}
                  >
                    →
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

      <div className="video-stage">
        {shownId && playUrl ? (
          <>
            <video key={shownId} className="video-player" src={playUrl} controls autoPlay playsInline />
            <div className="preview-actions">
              <button
                className="btn"
                onClick={() =>
                  void saveVideo(shownId, (shown?.prompt ?? "video").slice(0, 40)).then(
                    (p) => toastOk(`Saved to ${p}`),
                    (e) => toastError(String(e))
                  )
                }
              >
                {isTauri() ? "Save MP4" : "Save to Mac"}
              </button>
              <button className="btn danger" onClick={() => void removeVideo(shownId)}>
                Delete
              </button>
            </div>
            {shown && (
              <p className="hint">
                {shown.prompt}
                {shown.duration ? ` · ${shown.duration}s` : ""}
                {shown.resolution ? ` · ${shown.resolution}` : ""}
                {typeof shown.cost === "number" && shown.cost > 0 ? ` · $${shown.cost.toFixed(2)}` : ""}
              </p>
            )}
            {making && <p className="hint video-making">{making}…</p>}
          </>
        ) : making ? (
          <div className="image-placeholder">
            <span className="video-dot in_progress" aria-hidden="true" /> {making}…
            <br />
            <span className="muted">The video appears here when it&apos;s rendered.</span>
          </div>
        ) : (
          <div className="image-placeholder">
            Your video appears here.
            <br />
            <span className="muted">
              Talk it through in the chat, approve the script, and AI Box voices, scores, animates and
              renders it on this Mac.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
