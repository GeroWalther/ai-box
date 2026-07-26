// Shows what quietly went wrong.
//
// Non-fatal failures (a sync that didn't reach the Mac, a keychain read, a full
// local store) are logged rather than thrown, which is right — but without
// somewhere to read them, "right" becomes "invisible". This panel is that place,
// and gives a one-click copy for bug reports.

import { useEffect, useState } from "react";
import { clearLogs, logsAsText, onLog, recentLogs, type LogEntry } from "../lib/log";

export default function Diagnostics() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>(recentLogs);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEntries(recentLogs());
    return onLog(() => setEntries(recentLogs()));
  }, [open]);

  const problems = entries.filter((e) => e.level !== "info").length;

  async function copy() {
    try {
      await navigator.clipboard.writeText(logsAsText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context on the phone) — the text is on screen */
    }
  }

  return (
    <section>
      <h3>
        Diagnostics
        {problems > 0 && <span className="diag-badge">{problems}</span>}
      </h3>
      <button className="btn ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Hide" : "Show"} recent activity log
      </button>
      {open && (
        <>
          <div className="diag-log" role="log">
            {entries.length === 0 ? (
              <p className="hint">Nothing logged this session.</p>
            ) : (
              entries.map((e, i) => (
                <div key={i} className={`diag-row diag-${e.level}`}>
                  <span className="diag-time">
                    {new Date(e.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="diag-scope">{e.scope}</span>
                  <span className="diag-msg">{e.message}</span>
                </div>
              ))
            )}
          </div>
          <div className="diag-actions">
            <button className="btn ghost" onClick={copy} disabled={!entries.length}>
              {copied ? "Copied" : "Copy for a bug report"}
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                clearLogs();
                setEntries([]);
              }}
              disabled={!entries.length}
            >
              Clear
            </button>
          </div>
        </>
      )}
    </section>
  );
}
