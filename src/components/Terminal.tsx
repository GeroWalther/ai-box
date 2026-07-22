// Interactive terminal: a real shell on the Mac rendered with xterm.js, wired to
// a PTY on the backend (see src-tauri/src/pty.rs). Works in the desktop app and
// from a paired phone — keystrokes stream up, output streams down, so claude,
// vim, top, a REPL, etc. all work. Each mount is one persistent shell session.
import { useCallback, useEffect, useRef, useState } from "react";
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

const FONT_KEY = "ai-studio.term-font";
const MIN_FONT = 9;
const MAX_FONT = 22;

function defaultFont(): number {
  const saved = Number(localStorage.getItem(FONT_KEY));
  if (saved >= MIN_FONT && saved <= MAX_FONT) return saved;
  // Smaller on phones so more columns fit before wrapping.
  return typeof window !== "undefined" && window.innerWidth < 640 ? 12 : 13;
}

export default function Terminal() {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string>("");
  const [restartN, setRestartN] = useState(0);
  const [exited, setExited] = useState(false);
  const [fontSize, setFontSize] = useState<number>(defaultFont);

  // Refit the current grid to the host box and push the new rows/cols to the PTY.
  const refit = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
    } catch {
      /* host not laid out yet */
    }
    if (idRef.current) ptyResize(idRef.current, term.rows, term.cols).catch(() => {});
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // `disposed` is LOCAL to this session so a torn-down session (e.g. StrictMode's
    // throwaway first mount) can never flip the live session's input/exit state.
    let disposed = false;
    setExited(false);

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, "DejaVu Sans Mono", monospace',
      fontSize,
      lineHeight: 1.05,
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
    termRef.current = term;
    fitRef.current = fit;
    fit.fit();
    term.focus();

    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(16).slice(2);
    idRef.current = id;

    // Send typed input up to the shell.
    const dataSub = term.onData((d) => {
      if (!disposed) ptyWrite(id, toB64(d)).catch(() => {});
    });

    // Refit on container resize, window resize, and — crucially on mobile — when
    // the on-screen keyboard opens/closes (visualViewport changes, not the window).
    const pushResize = () => {
      try {
        fit.fit();
      } catch {
        /* not attached yet */
      }
      if (!disposed) ptyResize(id, term.rows, term.cols).catch(() => {});
    };
    const ro = new ResizeObserver(pushResize);
    ro.observe(host);
    window.addEventListener("resize", pushResize);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", pushResize);
    // Fonts load async and layout settles a beat after mount; refit a few times.
    const timers = [60, 250, 600].map((ms) => window.setTimeout(pushResize, ms));

    // Open the shell and stream its output into the terminal.
    ptyOpen(id, term.rows, term.cols, (ev) => {
      if (disposed) return; // ignore events for a superseded session
      if (ev.type === "data") term.write(fromB64(ev.data));
      else if (ev.type === "exit") {
        setExited(true);
        term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
      }
    }).catch((e) => {
      if (!disposed) {
        term.write(`\r\n\x1b[91m${String(e)}\x1b[0m\r\n`);
        setExited(true);
      }
    });

    return () => {
      disposed = true;
      timers.forEach(clearTimeout);
      ro.disconnect();
      window.removeEventListener("resize", pushResize);
      vv?.removeEventListener("resize", pushResize);
      dataSub.dispose();
      ptyKill(id).catch(() => {});
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartN]);

  // Live font-size changes (A− / A+) without tearing down the session.
  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    refit();
  }, [fontSize, refit]);

  const bumpFont = (delta: number) =>
    setFontSize((f) => Math.min(MAX_FONT, Math.max(MIN_FONT, f + delta)));

  return (
    <div className="xterm-view">
      <div className="xterm-topbar">
        <span className="xterm-title">
          Terminal{isTauri() ? "" : " · remote"}
          {exited && <span className="xterm-ended"> — session ended</span>}
        </span>
        <div className="xterm-actions">
          <button
            className="btn ghost xterm-font-btn"
            title="Smaller text"
            onClick={() => bumpFont(-1)}
            disabled={fontSize <= MIN_FONT}
          >
            A−
          </button>
          <button
            className="btn ghost xterm-font-btn"
            title="Larger text"
            onClick={() => bumpFont(1)}
            disabled={fontSize >= MAX_FONT}
          >
            A+
          </button>
          <button className="btn ghost" onClick={() => setRestartN((n) => n + 1)}>
            {exited ? "New session" : "Restart"}
          </button>
        </div>
      </div>
      <div className="xterm-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
    </div>
  );
}
