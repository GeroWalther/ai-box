// Desktop-only: when a phone (over the companion server) asks the agent to run a
// command or change files, the request is emitted here as a `remote-approval`
// event and the human at the Mac approves or denies it. This is the "approve on
// the Mac" security guarantee — remote devices can request, the Mac decides.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/transport";
import DiffPreview from "./DiffPreview";

interface Req {
  id: string;
  title: string;
  body: string;
  diff?: string | null;
}

export default function RemoteApprovalListener({ autoApprove = false }: { autoApprove?: boolean }) {
  // A queue, not a single slot: concurrent requests are shown one at a time so a
  // second request can't silently overwrite (and time out) the first.
  const [queue, setQueue] = useState<Req[]>([]);
  const req = queue[0] || null;
  // Keep the latest value for the event handler without re-subscribing.
  const autoRef = useRef(autoApprove);
  autoRef.current = autoApprove;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<Req>("remote-approval", (e) => {
        // Away mode: auto-approve remote requests instead of waiting for a human
        // at the Mac. This is the opt-in "I'm away" escape hatch.
        if (autoRef.current) {
          invoke("resolve_remote_approval", { id: e.payload.id, approved: true }).catch(() => {});
          return;
        }
        setQueue((q) => [...q, e.payload]);
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!req) return null;

  function answer(approved: boolean) {
    const id = req!.id;
    setQueue((q) => q.slice(1)); // advance to the next pending request
    invoke("resolve_remote_approval", { id, approved }).catch(() => {});
  }

  return (
    <div className="modal-backdrop">
      <div className="modal approve">
        <div className="modal-head">
          <h2>{req.title}</h2>
          {queue.length > 1 && (
            <span className="hint">{queue.length - 1} more pending</span>
          )}
        </div>
        <div className="modal-body">
          <p className="hint">A remote device (your phone) wants to take this action on your Mac:</p>
          <pre className="cmd-preview">{req.body}</pre>
          {req.diff && <DiffPreview diff={req.diff} />}
        </div>
        <div className="modal-foot approve-foot">
          <div className="approve-foot-right">
            <button className="btn" onClick={() => answer(false)}>
              Deny
            </button>
            <button className="btn primary" onClick={() => answer(true)}>
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
