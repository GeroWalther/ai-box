// The Screen Assist overlay: a bar you ask into, and marks drawn over the real
// screen underneath.
//
// This renders in its own transparent full-screen window, so everything here is
// floating over whatever app you were actually using. Two consequences shape the
// code:
//
//   * The window must stop taking clicks the moment the answer is on screen,
//     or the circle it just drew around a button would be the one thing
//     stopping you clicking it. `overlaySetClickthrough` flips that per phase.
//
//   * Nothing here may assume it is the focused app. Escape and the hotkey are
//     the only ways out, because the user's next click belongs to the app
//     underneath, not to us.
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadSettings, type Settings } from "../lib/settings";
import { overlayClose, overlaySetClickthrough } from "../lib/api";
import { ask, hush, say, Recorder, type AskResult } from "../lib/screenAssist";
import { logError } from "../lib/log";
import type { Annotation } from "../lib/presets";

type Phase = "idle" | "asking" | "thinking" | "answered";

export default function ScreenAssist() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [withScreen, setWithScreen] = useState(true);

  const recorder = useRef(new Recorder());
  const inputRef = useRef<HTMLInputElement>(null);

  /** Settings live in the main window; re-read them each time we open. */
  const refreshSettings = useCallback(() => {
    const s = loadSettings();
    setSettings(s);
    return s;
  }, []);

  // While the bar is open the window takes clicks; once an answer is up it must
  // not, so the marks are decoration over a fully usable screen.
  useEffect(() => {
    const interactive = phase === "asking" || phase === "thinking";
    overlaySetClickthrough(!interactive).catch(() => {});
  }, [phase]);

  const dismiss = useCallback(() => {
    recorder.current.cancel();
    setRecording(false);
    setPhase("idle");
    setAnswer(null);
    setError("");
    setQuestion("");
    void hush();
    overlayClose().catch(() => {});
  }, []);

  // The hotkey opens us. `withScreen` is true when Shift was held, but the
  // sticky auto-capture setting overrides it — that checkbox exists precisely so
  // the screen comes along without anyone reaching for a modifier.
  useEffect(() => {
    const un = listen<boolean>("screen-assist://open", (e) => {
      const s = refreshSettings();
      setAnswer(null);
      setError("");
      setQuestion("");
      setWithScreen(s.assistAutoCapture || e.payload === true);
      setPhase("asking");
      // The window has only just been shown; focus after the paint or the
      // caret lands nowhere and the first keystrokes are lost.
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refreshSettings]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  async function submit(text: string, clip: Awaited<ReturnType<Recorder["stop"]>>) {
    if (!text.trim() && !clip) return;
    setPhase("thinking");
    setError("");
    try {
      const result = await ask(settings, { text, clip, withScreen });
      setAnswer(result);
      setPhase("answered");
      void say(settings, result.say);
    } catch (e) {
      logError("assist.ask", e);
      setError(String(e));
      setPhase("answered");
    }
  }

  async function toggleRecording() {
    if (recording) {
      setRecording(false);
      const clip = await recorder.current.stop().catch(() => null);
      if (!clip) {
        setError("That was too short to hear — hold the button while you speak.");
        return;
      }
      await submit(question, clip);
      return;
    }
    try {
      await recorder.current.start();
      setRecording(true);
      setError("");
    } catch (e) {
      logError("assist.mic", e);
      setError("No microphone access. Grant it in System Settings → Privacy & Security → Microphone.");
    }
  }

  if (phase === "idle") return null;

  const canHear = true; // enforced by the picker; a deaf model simply ignores audio
  const thinking = phase === "thinking";

  return (
    <div className="sa-root">
      {/* Marks first, so the bar always sits above them. */}
      {answer && <Marks annotations={answer.annotations} />}

      <div className="sa-dock">
        {(phase === "asking" || thinking) && (
          <div className="sa-bar">
            <button
              className={recording ? "sa-mic recording" : "sa-mic"}
              title={recording ? "Stop and send" : "Ask by voice"}
              onClick={() => void toggleRecording()}
              disabled={thinking || !canHear}
            >
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
              </svg>
            </button>

            <input
              ref={inputRef}
              className="sa-input"
              placeholder={recording ? "Listening… click the mic when you're done" : "Ask about this screen, or anything else…"}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !thinking) void submit(question, null);
              }}
              disabled={thinking}
            />

            {/* The sticky toggle: on, and every question carries a fresh
                screenshot without anyone reaching for a modifier key. */}
            <label className="sa-screen" title="Attach a screenshot to every question">
              <input
                type="checkbox"
                checked={withScreen}
                onChange={(e) => setWithScreen(e.target.checked)}
                disabled={thinking}
              />
              <span>See screen</span>
            </label>

            <button className="sa-close" onClick={dismiss} title="Close (Esc)">
              ✕
            </button>
          </div>
        )}

        {thinking && (
          <div className="sa-answer thinking">
            <span className="sa-dots"><i /><i /><i /></span>
            {withScreen ? "Looking at your screen…" : "Thinking…"}
          </div>
        )}

        {phase === "answered" && (
          <div className="sa-answer">
            {error ? (
              <p className="sa-error">{error}</p>
            ) : (
              <>
                <p className="sa-say">{answer?.say}</p>
                {answer?.detail && <pre className="sa-detail">{answer.detail}</pre>}
                <div className="sa-foot">
                  <span className="sa-badge">{answer?.sawScreen ? "saw your screen" : "answered from knowledge"}</span>
                  {/* Click-through is on now, so this row needs its own
                      exception or the buttons would be unclickable. */}
                  <span className="sa-actions">
                    <button onMouseEnter={() => overlaySetClickthrough(false)} onMouseLeave={() => overlaySetClickthrough(true)} onClick={dismiss}>
                      Done
                    </button>
                    <button
                      onMouseEnter={() => overlaySetClickthrough(false)}
                      onMouseLeave={() => overlaySetClickthrough(true)}
                      onClick={() => {
                        void hush();
                        setAnswer(null);
                        setPhase("asking");
                        requestAnimationFrame(() => inputRef.current?.focus());
                      }}
                    >
                      Ask again
                    </button>
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Draw the marks.
 *
 * Coordinates arrive normalised 0–1000 and become percentages, which means the
 * SVG needs no knowledge of the display's real size and stays correct if the
 * window is moved to a different monitor mid-answer.
 */
function Marks({ annotations }: { annotations: Annotation[] }) {
  if (!annotations.length) return null;
  return (
    <svg className="sa-marks" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="sa-head" markerWidth="7" markerHeight="7" refX="5.6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 z" fill="var(--sa-mark)" />
        </marker>
        {/* Drawn twice — a dark casing under the bright stroke — so a mark stays
            visible on a white document and on a dark editor alike. */}
        <filter id="sa-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="rgba(0,0,0,0.75)" floodOpacity="1" />
        </filter>
      </defs>
      {annotations.map((a, i) => (
        <Mark key={i} a={a} />
      ))}
    </svg>
  );
}

function Mark({ a }: { a: Annotation }) {
  const [x1, y1, x2, y2] = a.box;
  const w = x2 - x1;
  const h = y2 - y1;
  const cx = x1 + w / 2;
  const cy = y1 + h / 2;
  const common = {
    fill: "none",
    stroke: "var(--sa-mark)",
    strokeWidth: 3.2,
    filter: "url(#sa-glow)",
    vectorEffect: "non-scaling-stroke" as const,
  };

  return (
    <g className="sa-mark">
      {a.kind === "circle" && (
        <ellipse cx={cx} cy={cy} rx={Math.max(w / 2 + 6, 10)} ry={Math.max(h / 2 + 6, 10)} {...common} />
      )}
      {a.kind === "box" && <rect x={x1} y={y1} width={w} height={h} rx={6} {...common} />}
      {a.kind === "underline" && (
        <path d={`M${x1},${y2 + 5} L${x2},${y2 + 5}`} {...common} strokeLinecap="round" />
      )}
      {a.kind === "arrow" && (
        // Comes in from the upper-left so it doesn't cover what it points at,
        // and shortens near the edge so the tail stays on screen.
        <path
          d={`M${Math.max(cx - 90, 8)},${Math.max(cy - 70, 8)} L${cx - 10},${cy - 10}`}
          {...common}
          markerEnd="url(#sa-head)"
          strokeLinecap="round"
        />
      )}
      {a.label && (
        <text
          className="sa-label"
          x={cx}
          y={y1 - 10 > 16 ? y1 - 10 : y2 + 22}
          textAnchor="middle"
        >
          {a.label}
        </text>
      )}
    </g>
  );
}
