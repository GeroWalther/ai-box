// An Agentic Chat conversation that runs as a task on the Mac, drawn as chat.
//
// The task's timeline already interleaves everything — the person's messages,
// each step, the replies — so this only has to give each kind the look it has
// elsewhere in Chat: bubbles for talk, tool lines for work, and a card for
// whatever the task is waiting on.
import { useEffect, useState } from "react";
import { attachmentUrl, type Attached } from "../lib/attachments";
import { isLive, type Task, type TaskStep } from "../lib/tasks";
import Markdown from "./Markdown";

const KIND_ICON: Record<string, string> = {
  browser: "🌐",
  terminal: "⌘",
  file: "📄",
  web: "↓",
  ask: "✋",
  mac: "🖥",
};

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

function Step({ s, renderImages }: { s: TaskStep; renderImages: (a: Attached[]) => React.ReactNode }) {
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
}

export default function TaskThread({ task, onApprove, onReply, renderImages }: Props) {
  const [answer, setAnswer] = useState("");
  const pending = task.status === "waiting" ? task.pending : undefined;
  const live = isLive(task.status);
  const last = task.steps[task.steps.length - 1];
  const thinking = task.status === "running" && (!last || last.ok != null) && last?.kind !== "reply";

  return (
    <>
      {task.steps.map((s, i) => (
        <Step key={`${s.at}-${i}`} s={s} renderImages={renderImages} />
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
