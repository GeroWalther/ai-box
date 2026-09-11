// The Screen Assist overlay: a bar you ask into, and marks drawn over the real
// screen underneath.
//
// This renders in its own transparent full-screen window, so everything here is
// floating over whatever app you were actually using. Two consequences shape the
// code:
//
//   * The marks are drawn by a SEPARATE window (ScreenMarks) that never takes
//     a click. This one is small and interactive. Splitting them is what lets
//     you click the very button that was just highlighted — a single window
//     cannot be click-through and typable at once.
//
//   * This is a non-activating NSPanel, so it takes keys WITHOUT activating AI
//     Box. Nothing here may assume it is the focused app; the user's next click
//     belongs to whatever is underneath.
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSecrets, loadSettings, type Settings } from "../lib/settings";
import { assistToChat, controlRequestAccess, controlTrusted, overlayClose, overlayMarks } from "../lib/api";
import type { Step } from "../lib/control";
import { ask, hush, say, Recorder, type AskResult } from "../lib/screenAssist";
import { logError } from "../lib/log";

type Phase = "idle" | "asking" | "thinking" | "answered";

export default function ScreenAssist() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [withScreen, setWithScreen] = useState(true);
  const [lastAsked, setLastAsked] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [needsAccess, setNeedsAccess] = useState(false);

  // Set while a run is in flight; flipped by Stop and by Esc, and read between
  // steps. A ref rather than state because the loop is already running and would
  // never see a re-render.
  const stop = useRef(false);

  const recorder = useRef(new Recorder());
  const inputRef = useRef<HTMLInputElement>(null);

  // API keys are deliberately NOT in localStorage — saveSettings strips them and
  // the real value lives in the OS keychain. loadSettings() therefore returns a
  // blank key, which is why this window has to rehydrate secrets the same way
  // the main window does. Without this every request 401s with a key that is
  // sitting right there on disk.
  const secrets = useRef<Partial<Settings>>({});
  useEffect(() => {
    loadSecrets()
      .then((s) => {
        secrets.current = s;
        setSettings((prev) => ({ ...prev, ...s }));
      })
      .catch((e) => logError("assist.secrets", e));
  }, []);

  /** Settings live in the main window; re-read them each time we open. */
  const refreshSettings = useCallback(() => {
    const s = { ...loadSettings(), ...secrets.current };
    setSettings(s);
    // Re-read the keychain too: a key added since this window was created would
    // otherwise stay invisible to the overlay until the whole app restarted.
    void loadSecrets()
      .then((sec) => {
        secrets.current = sec;
        setSettings((prev) => ({ ...prev, ...sec }));
      })
      .catch(() => {});
    return s;
  }, []);

  // Hand the marks to the drawing layer. Clearing them on every other phase
  // means a stale arrow from the last question never lingers over a new one.
  useEffect(() => {
    overlayMarks(phase === "answered" && answer ? answer.annotations : []).catch(() => {});
  }, [phase, answer]);

  const dismiss = useCallback(() => {
    stop.current = true;
    recorder.current.cancel();
    setRecording(false);
    setPhase("idle");
    setAnswer(null);
    setError("");
    setQuestion("");
    setSteps([]);
    void hush();
    overlayClose().catch(() => {});
  }, []);

  // The hotkey opens us. `withScreen` is true when Shift was held, but the
  // sticky auto-capture setting overrides it — that checkbox exists precisely so
  // the screen comes along without anyone reaching for a modifier.
  useEffect(() => {
    const un = listen<{ withScreen: boolean; listening: boolean }>(
      "screen-assist://open",
      (e) => {
        const s = refreshSettings();
        setAnswer(null);
        setError("");
        setQuestion("");
        setWithScreen(s.assistAutoCapture || e.payload?.withScreen === true);
        setPhase("asking");
        if (e.payload?.listening) {
          // Push-to-talk: the key is already down, so start recording now
          // rather than making the user click a mic they did not reach for.
          void startRecording();
        } else {
          // The window has only just been shown; focus after the paint or the
          // caret lands nowhere and the first keystrokes are lost.
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }
    );
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSettings]);

  // Push-to-talk released: stop and send whatever was said.
  useEffect(() => {
    const un = listen("screen-assist://talk-end", () => {
      void finishRecording();
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withScreen, settings]);

  // Escape pressed anywhere on the Mac while a run is in flight. The overlay's
  // own key handler cannot hear it: the first click hands focus to the app being
  // driven, so this arrives from the global shortcut instead.
  useEffect(() => {
    const un = listen("screen-assist://stop", () => {
      stop.current = true;
      setSteps((prev) =>
        prev.length ? prev : [{ tool: "stop", message: "Stopping…", ok: true }]
      );
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        // Mid-run, Esc is a brake rather than a close: the user is watching
        // their own Mac being driven and the urgent need is to make it stop,
        // not to lose the window that says what happened.
        if (phase === "thinking" && !stop.current) {
          stop.current = true;
          return;
        }
        dismiss();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, phase]);

  async function submit(text: string, clip: Awaited<ReturnType<Recorder["stop"]>>) {
    if (!text.trim() && !clip) return;
    setPhase("thinking");
    setError("");
    setSteps([]);
    setNeedsAccess(false);
    stop.current = false;
    try {
      const result = await ask(settings, {
        text,
        clip,
        withScreen,
        act: settings.assistAct,
        stopped: () => stop.current,
        onStep: (step, done) =>
          setSteps((prev) => {
            // The same step arrives twice: once as "Clicking Send", once with
            // the result. The second replaces the first rather than stacking.
            const next = prev.slice();
            if (done && next.length) next[next.length - 1] = step;
            else next.push(step);
            return next;
          }),
      });
      setAnswer(result);
      setPhase("answered");
      void say(settings, result.say, result.lang);
      // Filed under a "Screen Assist" chat session, so the overlay needs no
      // history of its own and these turn up in search and device sync.
      const asked = text.trim() || "(spoken question)";
      assistToChat(asked, result.detail ? `${result.say}\n\n${result.detail}` : result.say, result.sawScreen, false).catch(
        () => {}
      );
      setLastAsked(asked);
      // Only worth offering once the user has actually asked for something to
      // be done and been unable to have it done.
      if (settings.assistAct) {
        controlTrusted()
          .then((ok) => setNeedsAccess(!ok))
          .catch(() => {});
      }
    } catch (e) {
      logError("assist.ask", e);
      setError(String(e));
      setPhase("answered");
    }
  }

  async function startRecording() {
    if (recorder.current.recording) return;
    try {
      await recorder.current.start();
      setRecording(true);
      setError("");
    } catch (e) {
      logError("assist.mic", e);
      setError("No microphone access. Grant it in System Settings → Privacy & Security → Microphone.");
    }
  }

  async function finishRecording() {
    if (!recorder.current.recording) return;
    setRecording(false);
    const clip = await recorder.current.stop().catch(() => null);
    if (!clip) {
      setError("That was too short to hear — hold the key while you speak.");
      return;
    }
    await submit(question, clip);
  }

  function toggleRecording() {
    void (recording ? finishRecording() : startRecording());
  }

  if (phase === "idle") return null;

  const canHear = true; // enforced by the picker; a deaf model simply ignores audio
  const thinking = phase === "thinking";

  return (
    <div className="sa-root">
      <div className="sa-dock">
        {(phase === "asking" || thinking) && (
          <div
            className="sa-bar"
            onMouseDown={(e) => {
              // Drag by the background only. Starting a window drag from a
              // control would swallow the click that was meant to press it.
              const el = e.target as HTMLElement;
              if (el.closest("input, button, label, textarea, select")) return;
              void getCurrentWindow().startDragging();
            }}
          >
            <button
              className={recording ? "sa-mic recording" : "sa-mic"}
              title={recording ? "Stop and send" : "Ask by voice"}
              onClick={toggleRecording}
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
            <div className="sa-thinking-row">
              <span className="sa-dots"><i /><i /><i /></span>
              <span>
                {steps.length
                  ? steps[steps.length - 1].message
                  : withScreen
                    ? "Looking at your screen…"
                    : "Thinking…"}
              </span>
              {/* Reachable the whole time it is driving the Mac. Esc does the
                  same thing, but a visible button is what someone reaches for
                  when they want it to stop NOW. */}
              <button className="sa-stop" onClick={() => { stop.current = true; }}>
                {stop.current ? "Stopping…" : "Stop"}
              </button>
            </div>
            {steps.length > 1 && <Trail steps={steps.slice(0, -1)} />}
          </div>
        )}

        {phase === "answered" && (
          <div className="sa-answer">
            {error ? (
              <p className="sa-error">{error}</p>
            ) : (
              <>
                {steps.length > 0 && <Trail steps={steps} />}
                <p className="sa-say">{answer?.say}</p>
                {needsAccess && (
                  <p className="sa-grant">
                    To let me click and type, switch AI Box on under Accessibility.
                    <button
                      onClick={() => {
                        void controlRequestAccess();
                      }}
                    >
                      Open System Settings
                    </button>
                  </p>
                )}
                {answer?.detail && <pre className="sa-detail">{answer.detail}</pre>}
                <div className="sa-foot">
                  <span className="sa-badge">{answer?.sawScreen ? "saw your screen" : "answered from knowledge"}</span>
                  <span className="sa-actions">
                    <button
                      title="Open this in Agentic Chat, where the agent can also act on it"
                      onClick={() => {
                        void assistToChat(
                          lastAsked,
                          answer?.detail ? `${answer.say}\n\n${answer.detail}` : (answer?.say ?? ""),
                          answer?.sawScreen ?? false,
                          true
                        );
                        dismiss();
                      }}
                    >
                      Continue in chat
                    </button>
                    <button onClick={dismiss}>Done</button>
                    <button
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
 * What was actually done, in order.
 *
 * This is the part that makes an agent driving your Mac tolerable rather than
 * alarming: every click is named as it happens, and a step that failed says so
 * instead of disappearing into a summary that claims success.
 */
function Trail({ steps }: { steps: Step[] }) {
  return (
    <ol className="sa-trail">
      {steps.map((s, i) => (
        <li key={i} className={s.ok ? undefined : "failed"}>
          <span className="sa-tick">{s.ok ? "✓" : "!"}</span>
          {s.message}
        </li>
      ))}
    </ol>
  );
}
