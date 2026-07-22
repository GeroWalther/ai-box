// Interactive terminal: a real shell on the Mac rendered with xterm.js, wired to
// a PTY on the backend (see src-tauri/src/pty.rs). Works in the desktop app and
// from a paired phone — keystrokes stream up, output streams down, so claude,
// vim, top, a REPL, etc. all work. Each mount is one persistent shell session.
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyOpen, ptyWrite, ptyResize, ptyKill } from "../lib/api";
import { isTauri } from "../lib/transport";

// Base64 <-> bytes (keystrokes go up as base64; output comes down as base64).
function toB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export default function Terminal() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [restartN, setRestartN] = useState(0);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setExited(false);

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#0e0e13",
        foreground: "#e6e6ea",
        cursor: "#8b7cf6",
        selectionBackground: "#33335a",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();

    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(16).slice(2);
    let alive = true;

    // Send typed input up to the shell.
    const dataSub = term.onData((d) => {
      if (alive) ptyWrite(id, toB64(d)).catch(() => {});
    });

    // Keep the PTY's size in sync with the rendered viewport.
    const pushResize = () => {
      try {
        fit.fit();
      } catch {
        /* not attached yet */
      }
      if (alive) ptyResize(id, term.rows, term.cols).catch(() => {});
    };
    const ro = new ResizeObserver(() => pushResize());
    ro.observe(host);

    // Open the shell and stream its output into the terminal.
    ptyOpen(id, term.rows, term.cols, (ev) => {
      if (ev.type === "data") term.write(fromB64(ev.data));
      else if (ev.type === "exit") {
        alive = false;
        setExited(true);
        term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
      }
    })
      .catch((e) => {
        term.write(`\r\n\x1b[91m${String(e)}\x1b[0m\r\n`);
        setExited(true);
      })
      .finally(() => {
        alive = false;
      });

    return () => {
      alive = false;
      ro.disconnect();
      dataSub.dispose();
      ptyKill(id).catch(() => {});
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartN]);

  return (
    <div className="xterm-view">
      <div className="xterm-topbar">
        <span className="xterm-title">
          Terminal{isTauri() ? "" : " · remote"}
          {exited && <span className="xterm-ended"> — session ended</span>}
        </span>
        <button className="btn ghost" onClick={() => setRestartN((n) => n + 1)}>
          {exited ? "New session" : "Restart"}
        </button>
      </div>
      <div className="xterm-host" ref={hostRef} />
    </div>
  );
}
