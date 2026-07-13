// Desktop-only: when a phone (over the companion server) asks the agent to run a
// command or change files, the request is emitted here as a `remote-approval`
// event and the human at the Mac approves or denies it. This is the "approve on
// the Mac" security guarantee — remote devices can request, the Mac decides.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/transport";

interface Req {
  id: string;
  title: string;
  body: string;
}

export default function RemoteApprovalListener() {
  const [req, setReq] = useState<Req | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<Req>("remote-approval", (e) => setReq(e.payload)).then((fn) => {
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
    setReq(null);
    invoke("resolve_remote_approval", { id, approved }).catch(() => {});
  }

  return (
    <div className="modal-backdrop">
      <div className="modal approve">
        <div className="modal-head">
          <h2>{req.title}</h2>
        </div>
        <div className="modal-body">
          <p className="hint">A remote device (your phone) wants to take this action on your Mac:</p>
          <pre className="cmd-preview">{req.body}</pre>
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
