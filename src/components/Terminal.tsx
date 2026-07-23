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
import { cancelStream } from "../lib/transport";
import { remoteStoreMerge } from "../lib/remoteStore";
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
  /** For conflict-free cross-device merge (last-writer-wins). */
  updatedAt?: number;
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
function loadDeleted(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(TABS_KEY + ".deleted") || "{}") || {};
  } catch {
    return {};
  }
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
    return t.length ? t : [{ id: uid(), title: "Terminal 1", updatedAt: Date.now() }];
  });
  const [deleted, setDeleted] = useState<Record<string, number>>(loadDeleted);
  const [activeId, setActiveId] = useState<string>(
    () => localStorage.getItem(TABS_KEY + ".active") || ""
  );
  const [fontSize, setFontSize] = useState<number>(defaultFont);
  const tabsRef = useRef(tabs);
  const deletedRef = useRef(deleted);
  tabsRef.current = tabs;
  deletedRef.current = deleted;

  // Persist locally. (Active tab & font size stay per-device.)
  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  }, [tabs]);
  useEffect(() => {
    localStorage.setItem(TABS_KEY + ".deleted", JSON.stringify(deleted));
  }, [deleted]);
  useEffect(() => {
    if (activeId) localStorage.setItem(TABS_KEY + ".active", activeId);
    window.dispatchEvent(new Event("ai-studio-nav")); // cross-device "where you left off"
  }, [activeId]);
  // A workspace sync from another device may pick a different active terminal.
  useEffect(() => {
    const onWs = () => {
      const id = localStorage.getItem(TABS_KEY + ".active");
      if (id && tabsRef.current.find((t) => t.id === id)) setActiveId(id);
    };
    window.addEventListener("ai-studio-ws", onWs);
    return () => window.removeEventListener("ai-studio-ws", onWs);
  }, []);
  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
  }, [fontSize]);

  // Keep a valid active tab.
  useEffect(() => {
    if (!tabs.find((t) => t.id === activeId)) setActiveId(tabs[0]?.id ?? "");
  }, [tabs, activeId]);

  // Terminals are the Mac's shells, so the tab LIST is shared across devices:
  // pull+merge the union, and mirror local changes back (debounced). The live
  // shells (keyed by tab id) are then reachable from whichever device attaches.
  async function syncTabs() {
    try {
      const merged = await remoteStoreMerge(
        TABS_KEY,
        JSON.stringify({ items: tabsRef.current, deleted: deletedRef.current })
      );
      const parsed = JSON.parse(merged);
      const items: Tab[] = Array.isArray(parsed.items) ? parsed.items : [];
      setTabs(items.length ? items : [{ id: uid(), title: "Terminal 1", updatedAt: Date.now() }]);
      setDeleted(parsed.deleted || {});
    } catch {
      /* offline / no server — keep working locally */
    }
  }
  useEffect(() => {
    syncTabs();
    const onSync = () => syncTabs();
    window.addEventListener("ai-studio-sync", onSync);
    return () => window.removeEventListener("ai-studio-sync", onSync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Mirror local edits to the shared store shortly after they happen.
  useEffect(() => {
    const t = setTimeout(() => {
      remoteStoreMerge(TABS_KEY, JSON.stringify({ items: tabs, deleted })).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [tabs, deleted]);

  function newTab() {
    const t = { id: uid(), title: `Terminal ${nextNumber(tabs)}`, updatedAt: Date.now() };
    setTabs((p) => [...p, t]);
    setActiveId(t.id);
  }
  function closeTab(id: string) {
    ptyKill(id).catch(() => {}); // closing a tab really does end its shell
    setDeleted((d) => ({ ...d, [id]: Date.now() })); // tombstone so it stays closed everywhere
    setTabs((p) => {
      const next = p.filter((t) => t.id !== id);
      return next.length ? next : [{ id: uid(), title: "Terminal 1", updatedAt: Date.now() }];
    });
  }
  function renameTab(id: string, title: string) {
    setTabs((p) => p.map((t) => (t.id === id ? { ...t, title, updatedAt: Date.now() } : t)));
  }
  const bumpFont = (d: number) =>
    setFontSize((f) => Math.min(MAX_FONT, Math.max(MIN_FONT, f + d)));
  // The A-/A+ controls live in the sidebar footer (App) so they stay reachable
  // even when the sidebar is collapsed; they reach us via this event.
  useEffect(() => {
    const onFont = (e: Event) => bumpFont((e as CustomEvent).detail || 0);
    window.addEventListener("ai-studio-term-font", onFont);
    return () => window.removeEventListener("ai-studio-term-font", onFont);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          onRename={renameTab}
        />
      </SidebarSlot>

      <div className="xterm-stack">
        {tabs.map((t) => (
          <TermPane key={t.id} ptyId={t.id} active={t.id === activeId} fontSize={fontSize} />
        ))}
      </div>
    </div>
  );
}

/** One live shell: an xterm bound to a persistent PTY session (keyed by the tab id
 *  so it survives disconnects). Stays mounted while its tab exists (hidden when not
 *  active) so the shell keeps running in the background. On a dropped connection it
 *  auto-reconnects and re-attaches — no reload, no lost output. */
function TermPane({
  ptyId,
  active,
  fontSize,
}: {
  ptyId: string;
  active: boolean;
  fontSize: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exited, setExited] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [epoch, setEpoch] = useState(0); // bump to start a brand-new shell in place

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    setExited(false);
    setReconnecting(false);

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

    // Stable PTY id = the tab id, so a reconnect re-attaches to the same shell.
    // (A "Restart shell" bumps `epoch` only to re-run this effect; the previous
    // shell has already exited by then, so attach spawns a fresh one.)
    const id = ptyId;

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

    // Touch scrolling (this is the version that worked): drag scrolls the xterm
    // scrollback by whole rows. Passive listeners — no preventDefault, which was
    // what killed scrolling. Pull-to-refresh is handled by CSS overscroll-behavior.
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? touchY;
      const rowPx = Math.max(8, fontSize * 1.05);
      const lines = Math.trunc((touchY - y) / rowPx);
      if (lines !== 0) {
        term.scrollLines(lines);
        touchY -= lines * rowPx;
      }
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: true });

    // Attach/stream with auto-reconnect. A connection drop just retries the same
    // id; the backend keeps the shell alive and replays recent output on re-attach.
    let firstChunk = true;
    (async function attachLoop() {
      while (!disposed) {
        let cleanExit = false;
        firstChunk = true;
        try {
          await ptyOpen(id, term.rows, term.cols, (ev) => {
            if (disposed) return;
            if (ev.type === "data") {
              // Clear before applying the replay so re-attach doesn't duplicate.
              if (firstChunk) {
                term.reset();
                firstChunk = false;
                setReconnecting(false);
              }
              term.write(fromB64(ev.data));
            } else if (ev.type === "exit") {
              cleanExit = true;
              setExited(true);
              term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
            }
          });
        } catch {
          /* connection dropped — retry below */
        }
        if (cleanExit || disposed) return;
        // Resolved without a real exit → we were detached (connection lost). Retry.
        setReconnecting(true);
        await new Promise((r) => setTimeout(r, 1200));
      }
    })();

    return () => {
      // Note: we do NOT kill the shell here. Unmount happens on navigate/reload/
      // blip too, and the shell must survive those so we can re-attach. Shells are
      // killed only on explicit tab close (below) or app exit. A stale stream is
      // superseded server-side by the next attach (generation check).
      disposed = true;
      cancelStream(id); // detach this stream server-side (shell keeps running)
      timers.forEach(clearTimeout);
      ro.disconnect();
      window.removeEventListener("resize", pushResize);
      vv?.removeEventListener("resize", pushResize);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      dataSub.dispose();
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, ptyId]);

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
      {reconnecting && !exited && (
        <div className="term-status-pill">Reconnecting…</div>
      )}
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
