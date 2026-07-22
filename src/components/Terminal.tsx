// Interactive terminals: real shells on the Mac rendered with xterm.js over a PTY
// (see src-tauri/src/pty.rs). Multiple named terminals live side by side like chat
// sessions — each keeps its own shell alive across tab switches, so a long-running
// command in one keeps going while you work in another. The tab list persists; the
// shells themselves are fresh each app launch (PTYs don't survive a restart).
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyOpen, ptyWrite, ptyResize, ptyKill } from "../lib/api";
import { isTauri } from "../lib/transport";
import { SidebarSlot } from "./SidebarList";
import SidebarList from "./SidebarList";

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
function uid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(16).slice(2);
}

const FONT_KEY = "ai-studio.term-font";
const TABS_KEY = "ai-studio.terminals";
const MIN_FONT = 9;
const MAX_FONT = 22;

function defaultFont(): number {
  const saved = Number(localStorage.getItem(FONT_KEY));
  if (saved >= MIN_FONT && saved <= MAX_FONT) return saved;
  return typeof window !== "undefined" && window.innerWidth < 640 ? 12 : 13;
}

interface Tab {
  id: string;
  title: string;
}

function loadTabs(): Tab[] {
  try {
    const t = JSON.parse(localStorage.getItem(TABS_KEY) || "[]");
    if (Array.isArray(t)) return t.filter((x) => x && typeof x.id === "string");
  } catch {
    /* ignore */
  }
  return [];
}

/** Next "Terminal N" number that doesn't collide with existing titles. */
function nextNumber(tabs: Tab[]): number {
  const nums = tabs.map((t) => Number(/(\d+)$/.exec(t.title)?.[1] ?? 0));
  return Math.max(0, ...nums) + 1;
}

interface Props {
  sidebarSlot: HTMLElement | null;
  onCloseDrawer?: () => void;
}

export default function Terminal({ sidebarSlot, onCloseDrawer }: Props) {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const t = loadTabs();
    return t.length ? t : [{ id: uid(), title: "Terminal 1" }];
  });
  const [activeId, setActiveId] = useState<string>(
    () => localStorage.getItem(TABS_KEY + ".active") || ""
  );
  const [fontSize, setFontSize] = useState<number>(defaultFont);

  // Persist the tab list, active tab and font size.
  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  }, [tabs]);
  useEffect(() => {
    if (activeId) localStorage.setItem(TABS_KEY + ".active", activeId);
  }, [activeId]);
  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
  }, [fontSize]);

  // Keep a valid active tab.
  useEffect(() => {
    if (!tabs.find((t) => t.id === activeId)) setActiveId(tabs[0]?.id ?? "");
  }, [tabs, activeId]);

  function newTab() {
    const t = { id: uid(), title: `Terminal ${nextNumber(tabs)}` };
    setTabs((p) => [...p, t]);
    setActiveId(t.id);
  }
  function closeTab(id: string) {
    setTabs((p) => {
      const next = p.filter((t) => t.id !== id);
      return next.length ? next : [{ id: uid(), title: "Terminal 1" }];
    });
  }
  const bumpFont = (d: number) =>
    setFontSize((f) => Math.min(MAX_FONT, Math.max(MIN_FONT, f + d)));

  const activeTitle = tabs.find((t) => t.id === activeId)?.title ?? "Terminal";

  return (
    <div className="xterm-view">
      <SidebarSlot slot={sidebarSlot}>
        <SidebarList
          items={tabs}
          activeId={activeId}
          newLabel="+ New terminal"
          emptyLabel="Your terminals appear here."
          onSelect={(id) => {
            setActiveId(id);
            onCloseDrawer?.();
          }}
          onNew={() => {
            newTab();
            onCloseDrawer?.();
          }}
          onDelete={closeTab}
        />
      </SidebarSlot>

      <div className="xterm-topbar">
        <span className="xterm-title">
          {activeTitle}
          {isTauri() ? "" : " · remote"}
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
        </div>
      </div>

      <div className="xterm-stack">
        {tabs.map((t) => (
          <TermPane key={t.id} active={t.id === activeId} fontSize={fontSize} />
        ))}
      </div>
    </div>
  );
}

/** One live shell: an xterm bound to its own PTY session. Stays mounted while its
 *  tab exists (hidden when not active) so the shell keeps running in the background. */
function TermPane({ active, fontSize }: { active: boolean; fontSize: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exited, setExited] = useState(false);
  const [epoch, setEpoch] = useState(0); // bump to restart the shell in place

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
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

    const id = uid();

    const dataSub = term.onData((d) => {
      if (!disposed) ptyWrite(id, toB64(d)).catch(() => {});
    });

    const pushResize = () => {
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
      if (!disposed) ptyResize(id, term.rows, term.cols).catch(() => {});
    };
    const ro = new ResizeObserver(pushResize);
    ro.observe(host);
    window.addEventListener("resize", pushResize);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", pushResize);
    const timers = [60, 250, 600].map((ms) => window.setTimeout(pushResize, ms));

    ptyOpen(id, term.rows, term.cols, (ev) => {
      if (disposed) return;
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
  }, [epoch]);

  // Live font-size changes without restarting the shell.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = fontSize;
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
  }, [fontSize]);

  // When this tab becomes active, refit (size may have drifted) and focus.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    term.focus();
  }, [active]);

  return (
    <div className={active ? "term-pane active" : "term-pane"}>
      <div className="xterm-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
      {exited && (
        <div className="term-ended-overlay">
          <span>Session ended</span>
          <button className="btn primary" onClick={() => setEpoch((e) => e + 1)}>
            Restart shell
          </button>
        </div>
      )}
    </div>
  );
}
