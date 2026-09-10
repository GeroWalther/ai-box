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
import { assistToChat, overlayClose, overlayMarks } from "../lib/api";
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
      void say(settings, result.say, result.lang);
      // Filed under a "Screen Assist" chat session, so the overlay needs no
      // history of its own and these turn up in search and device sync.
      const asked = text.trim() || "(spoken question)";
      assistToChat(asked, result.detail ? `${result.say}\n\n${result.detail}` : result.say, result.sawScreen, false).catch(
        () => {}
      );
      setLastAsked(asked);
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
