// An Agentic Chat conversation that runs as a task on the Mac, drawn as chat.
//
// The task's timeline already interleaves everything — the person's messages,
// each step, the replies — so this only has to give each kind the look it has
// elsewhere in Chat: bubbles for talk, tool lines for work, and a card for
// whatever the task is waiting on.
import { useEffect, useState } from "react";
import { attachmentUrl, type Attached } from "../lib/attachments";
import { isLive, type Task, type TaskStep } from "../lib/tasks";
import { invokeCmd } from "../lib/transport";
import { revokeVideoUrl, videoObjectUrl } from "../lib/videoStore";
import { saveVideo } from "../lib/api";
import Markdown from "./Markdown";

const KIND_ICON: Record<string, string> = {
  browser: "🌐",
  terminal: "⌘",
  file: "📄",
  web: "↓",
  ask: "✋",
  mac: "🖥",
  video: "🎬",
  audio: "♪",
};

export function AttachmentThumb({ a, onRemove }: { a: Attached; onRemove?: () => void }) {
  const [url, setUrl] = useState("");
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    attachmentUrl(a.id).then(
      (u) => live && setUrl(u),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [a.id]);
  return (
    <div className="attach-thumb" title={a.source || a.name}>
      {url ? <img src={url} alt={a.name} /> : <span>{missing ? "missing" : "…"}</span>}
      {onRemove && (
        <button className="attach-thumb-x" onClick={onRemove} title="Remove image" aria-label="Remove image">
          ×
        </button>
      )}
    </div>
  );
}

/** A finished video, in the chat: plays in place, saves to Downloads. */
function InlineVideo({ id, title }: { id: string; title: string }) {
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    let live = true;
    let made = "";
    videoObjectUrl(id).then(
      (u) => {
        made = u;
        if (live) setUrl(u);
        else revokeVideoUrl(u);
      },
      () => {}
    );
    return () => {
      live = false;
      revokeVideoUrl(made);
    };
  }, [id]);
  return (
    <div className="task-video">
      {url ? <video src={url} controls playsInline /> : <div className="task-shot loading" />}
      <div className="task-video-actions">
        <button
          className="btn"
          onClick={() =>
            void saveVideo(id, title).then(
              (p) => setSaved(p),
              (e) => setSaved(String(e))
            )
          }
        >
          Save MP4
        </button>
        {saved && <span className="hint">{saved}</span>}
      </div>
    </div>
  );
}

/** A voice sample the director made: "<project>/<file>". */
function InlineAudio({ where }: { where: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const [id, file] = where.split("/");
    invokeCmd<string>("motion_audio", { id, file }).then(setUrl, () => {});
  }, [where]);
  return url ? <audio className="task-audio" src={url} controls /> : null;
}

/** A picture stored on the Mac, fetched on demand. */
export function StoredImage({ id, className, alt }: { id: string; className?: string; alt?: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    attachmentUrl(id).then(
      (u) => live && setUrl(u),
      () => {}
    );
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <div className={`task-shot ${url ? "" : "loading"} ${className ?? ""}`}>
      {url && <img src={url} alt={alt ?? ""} />}
    </div>
  );
}

interface StepProps {
  s: TaskStep;
  renderImages: (a: Attached[]) => React.ReactNode;
  onShowVideo?: (id: string) => void;
  shownVideo?: string | null;
}

function Step({ s, renderImages, onShowVideo, shownVideo }: StepProps) {
  if (s.kind === "user") {
    return (
      <div className="msg user">
        <div className="msg-head">
          <div className="msg-role">You</div>
        </div>
        {s.images?.length ? renderImages(s.images as Attached[]) : null}
        {s.title && <div className="msg-body">{s.title}</div>}
      </div>
    );
  }
  if (s.kind === "reply") {
    return (
      <div className="msg assistant">
        <div className="msg-head">
          <div className="msg-role">AI Box</div>
          <button className="msg-copy" title="Copy message" onClick={() => navigator.clipboard.writeText(s.title)}>
            Copy
          </button>
        </div>
        <div className="msg-body">
          <Markdown>{s.title}</Markdown>
        </div>
      </div>
    );
  }
  if (s.kind === "note") {
    return <div className="task-note">{s.title}</div>;
  }
  if (s.kind === "video" && s.ok && s.detail) {
    if (!onShowVideo) return <InlineVideo id={s.detail} title={s.title} />;
    // The host plays it in its own pane; the thread only points at it.
    const id = s.detail;
    return (
      <button
        className={`tool-line task-step task-video-link ${shownVideo === id ? "shown" : ""}`}
        onClick={() => onShowVideo(id)}
        title="Show this video"
      >
        <span className="tool-icon">🎬</span>
        <span className="task-step-title">{s.title}</span>
        <span className="hint">{shownVideo === id ? "shown →" : "show →"}</span>
      </button>
    );
  }
  if (s.kind === "audio" && s.ok && s.detail) {
    return (
      <div className="tool-line task-step">
        <span className="tool-icon">♪</span>
        <span className="task-step-title">{s.title}</span>
        <InlineAudio where={s.detail} />
      </div>
    );
  }
  const running = s.ok == null;
  const failed = s.ok === false || s.kind === "error";
  const icon = running ? "…" : failed ? "✗" : (KIND_ICON[s.kind] ?? "✓");
  const cls = `tool-line task-step ${failed ? "err" : ""} ${running ? "running" : ""}`;
  // One short line per step: a long shell command or script only shows its
  // first line, and the whole of it moves behind the tap with the output.
  const first = s.title.split("\n")[0].trim();
  const short = first.length > 140 ? `${first.slice(0, 140)}…` : s.title.includes("\n") ? `${first} …` : first;
  const more = [short !== s.title ? s.title : "", s.detail?.trim() ?? ""].filter(Boolean).join("\n\n");
  if (more) {
    return (
      <details className={`${cls} has-detail`}>
        <summary>
          <span className="tool-icon">{icon}</span>
          <span className="task-step-title">{short}</span>
        </summary>
        <pre className="tool-detail">{more}</pre>
      </details>
    );
  }
  return (
    <div className={cls}>
      <span className="tool-icon">{icon}</span>
      <span className="task-step-title">{short}</span>
    </div>
  );
}

interface Props {
  task: Task;
  onApprove: (pendingId: string, ok: boolean) => void;
  onReply: (pendingId: string, text: string) => void;
  renderImages: (a: Attached[]) => React.ReactNode;
  /** Given, finished videos show elsewhere and the thread links to them. */
  onShowVideo?: (id: string) => void;
  shownVideo?: string | null;
}

export default function TaskThread({ task, onApprove, onReply, renderImages, onShowVideo, shownVideo }: Props) {
  const [answer, setAnswer] = useState("");
  const pending = task.status === "waiting" ? task.pending : undefined;
  const live = isLive(task.status);
  const last = task.steps[task.steps.length - 1];
  const thinking = task.status === "running" && (!last || last.ok != null) && last?.kind !== "reply";

  return (
    <>
      {task.steps.map((s, i) => (
        <Step key={`${s.at}-${i}`} s={s} renderImages={renderImages} onShowVideo={onShowVideo} shownVideo={shownVideo} />
      ))}

      {live && task.shot && (
        <div className="task-live">
          <div className="hint">The assistant&apos;s browser, now</div>
          <StoredImage id={task.shot} alt="The assistant's browser" />
        </div>
      )}

      {pending && (
        <div className={`task-pending ${pending.kind}`}>
          <div className="task-pending-title">{pending.title}</div>
          {pending.body && <div className="task-pending-body">{pending.body}</div>}
          {pending.shot && <StoredImage id={pending.shot} className="wide" alt="What this is about" />}
          {pending.kind === "approve" ? (
            <div className="task-pending-actions">
              <span className="hint">Or just say / type what to do instead.</span>
              <button className="btn" onClick={() => onApprove(pending.id, false)}>
                Don&apos;t
              </button>
              <button className="btn primary" onClick={() => onApprove(pending.id, true)}>
                Approve
              </button>
            </div>
          ) : pending.kind === "handover" ? (
            <div className="task-pending-actions">
              <span className="hint">The browser is open on your Mac. Do this there, then:</span>
              <button className="btn primary" onClick={() => onReply(pending.id, "done")}>
                I&apos;m done — continue
              </button>
            </div>
          ) : (
            <div className="task-reply">
              <input
                value={answer}
                placeholder="Your answer… (or reply in the chat box)"
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && answer.trim()) {
                    onReply(pending.id, answer.trim());
                    setAnswer("");
                  }
                }}
              />
              <button
                className="btn primary"
                disabled={!answer.trim()}
                onClick={() => {
                  onReply(pending.id, answer.trim());
                  setAnswer("");
                }}
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}

      {thinking && !pending && (
        <div className="msg assistant">
          <div className="msg-role">AI Box</div>
          <div className="typing">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      )}
    </>
  );
}
