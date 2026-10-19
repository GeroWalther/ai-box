// The browser panel beside the Assistant chat: the assistant's own Chrome,
// seen and used from inside AI Box.
//
// The Chrome itself is parked just past the corner of the screen (browser.rs),
// so it never covers what the person is doing. This shows a live picture of
// the page and plays what the person does here — clicks, scrolling, typing,
// pasting, the toolbar — back into it. So they can watch a task, log in when
// it hands over, or sign in to sites before a task, all without leaving the
// app. With no task tab to show, it shows the person's own window in the same
// browser (same profile, so whatever they sign into, the assistant can use).
import { useEffect, useRef, useState } from "react";
import { invokeCmd } from "../lib/transport";
import { logError } from "../lib/log";

interface View {
  target: string;
  frame: string;
  width: number;
  height: number;
  url: string;
  title: string;
  shown: boolean;
}

interface Props {
  /** The task's tab; without one, the person's own window. */
  target?: string;
  /** The assistant is working in it right now. */
  working: boolean;
  /** What the assistant handed over, if it is waiting on the person. */
  handover?: { id: string; body: string };
  onHandoverDone: (pendingId: string) => void;
  onClose: () => void;
  /** Wide: the panel takes most of the window. */
  wide: boolean;
  onToggleWide: () => void;
}

// Keys that are not text: Chrome needs their DOM key, code and Windows key code.
const KEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

// Line icons in the style of the rest of the app.
function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const ICONS = {
  back: "M19 12H5M11 18l-6-6 6-6",
  forward: "M5 12h14M13 6l6 6-6 6",
  reload: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  close: "M18 6 6 18M6 6l12 12",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3",
};

/** What the address pill shows when not being edited: just the site. */
function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return u.protocol.startsWith("http") ? u.host : url;
  } catch {
    return url;
  }
}

function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export default function BrowserPanel({ target, working, handover, onHandoverDone, onClose, wide, onToggleWide }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [focused, setFocused] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const kick = useRef<() => void>(() => {});
  const wheel = useRef({ dx: 0, dy: 0, x: 0, y: 0, timer: 0 as ReturnType<typeof setTimeout> | 0 });
  const resolved = view?.target ?? target;

  // Frames: quick while something is happening, slow when idle, none while
  // the window is hidden. `kick` fetches one right after an input.
  useEffect(() => {
    let stop = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout>;
    let last = Date.now();
    const tick = async () => {
      clearTimeout(timer);
      if (stop) return;
      if (document.hidden || busy) {
        timer = setTimeout(tick, 1000);
        return;
      }
      busy = true;
      try {
        const v = await invokeCmd<View>("browser_view", { target: target ?? null });
        if (!stop) {
          setView(v);
          setError("");
        }
      } catch (e) {
        if (!stop) setError(String(e));
      } finally {
        busy = false;
      }
      const active = working || focused || Date.now() - last < 4000 || !!handover;
      timer = setTimeout(tick, active ? 350 : 1500);
    };
    kick.current = () => {
      last = Date.now();
      timer = setTimeout(tick, 120);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [target, working, focused, handover]);

  useEffect(() => {
    if (!editing) setAddress(view?.url && view.url !== "about:blank" ? view.url : "");
  }, [view?.url, editing]);

  // The page is laid out at exactly the size it is shown at, like a real
  // browser — not a big page shrunk into the panel.
  const sizeFor = view?.target;
  useEffect(() => {
    const el = screenRef.current;
    if (!el || !sizeFor) return;
    let timer: ReturnType<typeof setTimeout>;
    const push = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.height < 50) return;
        void invokeCmd("browser_resize", { target: sizeFor, width: Math.round(r.width), height: Math.round(r.height) })
          .then(() => kick.current())
          .catch((e) => logError("browser.resize", e));
      }, 200);
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [sizeFor]);

  // A handover is the person's cue: put the keyboard in the page.
  useEffect(() => {
    if (handover) keysRef.current?.focus();
  }, [handover?.id]);

  async function send(event: Record<string, unknown>) {
    if (!resolved) return;
    try {
      await invokeCmd("browser_input", { target: resolved, event });
    } catch (e) {
      logError("browser.input", e);
      setError(String(e));
    }
    kick.current();
  }

  /** Where on the page a point over the picture is, in CSS pixels. */
  function pagePoint(clientX: number, clientY: number) {
    const img = imgRef.current;
    if (!img || !view) return null;
    const r = img.getBoundingClientRect();
    return {
      x: Math.round(((clientX - r.left) / r.width) * view.width),
      y: Math.round(((clientY - r.top) / r.height) * view.height),
    };
  }

  async function windowOut(show: boolean) {
    if (!resolved) return;
    await invokeCmd("browser_window", { target: resolved, show }).catch((e) => setError(String(e)));
    kick.current();
  }

  return (
    <aside className="browser-panel" aria-label="Browser">
      <div className="browser-tabs">
        <div className="browser-tab" title={view?.title || view?.url}>
          <span className={working ? "browser-tab-icon working" : "browser-tab-icon"}>
            <Icon d={ICONS.globe} size={14} />
          </span>
          <span className="browser-tab-title">{view?.title || shortUrl(view?.url ?? "") || "New tab"}</span>
        </div>
        <span className="browser-spacer" />
        <button className="browser-icon" title={wide ? "Make the browser narrower" : "Make the browser wider"} onClick={onToggleWide}>
          <Icon d={wide ? ICONS.shrink : ICONS.expand} />
        </button>
        <button className="browser-icon" title="Close the browser" onClick={onClose}>
          <Icon d={ICONS.close} />
        </button>
      </div>

      <div className="browser-nav">
        <button className="browser-icon" title="Back" onClick={() => void send({ type: "back" })}>
          <Icon d={ICONS.back} />
        </button>
        <button className="browser-icon" title="Forward" onClick={() => void send({ type: "forward" })}>
          <Icon d={ICONS.forward} />
        </button>
        <button className="browser-icon" title="Reload" onClick={() => void send({ type: "reload" })}>
          <Icon d={ICONS.reload} />
        </button>
        <div className="browser-address">
          <input
            value={editing ? address : shortUrl(address)}
            placeholder="Search or enter address"
            spellCheck={false}
            onFocus={(e) => {
              setEditing(true);
              const el = e.target;
              setTimeout(() => el.select(), 0);
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && address.trim()) {
                void send({ type: "navigate", url: address.trim() });
                (e.target as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <button
            className="browser-icon small"
            title={view?.shown ? "Put the Chrome window away again" : "Open this page in a real Chrome window"}
            onClick={() => void windowOut(!view?.shown)}
          >
            <Icon d={view?.shown ? ICONS.close : ICONS.external} size={15} />
          </button>
        </div>
      </div>

      {handover && (
        <div className="browser-handover">
          <span>
            <b>Your turn:</b> {handover.body || "do this step yourself"}
          </span>
          <button className="btn primary tiny" onClick={() => onHandoverDone(handover.id)}>
            I&apos;m done — continue
          </button>
        </div>
      )}

      <div
        ref={screenRef}
        className={`browser-screen ${focused ? "focused" : ""}`}
        onMouseDown={(e) => {
          // Keep the keyboard in the page after a click.
          e.preventDefault();
          keysRef.current?.focus();
        }}
        onClick={(e) => {
          const p = pagePoint(e.clientX, e.clientY);
          if (p) void send({ type: "click", ...p, count: e.detail || 1, modifiers: modifiers(e) });
        }}
        onWheel={(e) => {
          const p = pagePoint(e.clientX, e.clientY);
          if (!p) return;
          // Coalesce a trackpad's stream of tiny wheel events.
          const w = wheel.current;
          w.dx += e.deltaX;
          w.dy += e.deltaY;
          w.x = p.x;
          w.y = p.y;
          if (!w.timer) {
            w.timer = setTimeout(() => {
              const { dx, dy, x, y } = w;
              w.dx = w.dy = 0;
              w.timer = 0;
              void send({ type: "scroll", x, y, dx, dy });
            }, 40);
          }
        }}
      >
        {view?.frame ? (
          <img ref={imgRef} src={view.frame} alt={view.title || "The browser"} draggable={false} />
        ) : (
          <div className="browser-empty hint">{error || "Starting the browser…"}</div>
        )}
        {view?.shown && <div className="browser-out hint">Open in a Chrome window — put it away with the button in the address bar.</div>}
        {/* Off-screen but focused: takes the keys, IME and paste for the page. */}
        <textarea
          ref={keysRef}
          className="browser-keys"
          aria-label="Type into the page"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            const mods = modifiers(e);
            const vk = KEYS[e.key];
            if (vk) {
              e.preventDefault();
              void send({
                type: "key",
                key: e.key,
                code: e.code,
                keyCode: vk,
                modifiers: mods,
                text: e.key === "Enter" ? "\r" : "",
              });
            } else if ((e.metaKey || e.ctrlKey) && /^[acxz]$/i.test(e.key)) {
              e.preventDefault();
              void send({ type: "key", key: e.key.toLowerCase(), code: e.code, keyCode: e.key.toUpperCase().charCodeAt(0), modifiers: mods });
            }
            // Everything else arrives as text through onInput or onPaste.
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            if (text) void send({ type: "text", text });
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            if ((e.nativeEvent as InputEvent).isComposing) return;
            if (el.value) void send({ type: "text", text: el.value });
            el.value = "";
          }}
          onCompositionEnd={(e) => {
            const el = e.currentTarget;
            if (el.value) void send({ type: "text", text: el.value });
            el.value = "";
          }}
        />
      </div>
      {error && view?.frame && <div className="browser-error">{error}</div>}
    </aside>
  );
}
