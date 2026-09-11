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
import {
  LOCAL_PREFIX,
  loadSecrets,
  loadSettings,
  mergeBroadcast,
  saveSettings,
  SETTINGS_EVENT,
  type Settings,
} from "../lib/settings";
import {
  assistToChat,
  listAssistModels,
  listLocalAssistModels,
  listVoices,
  controlRequestAccess,
  controlTrusted,
  openSettingsPane,
  overlayBarMoved,
  overlayClose,
  overlayEscape,
  overlayMarks,
} from "../lib/api";
import type { Step } from "../lib/control";
import type { AssistModel, MacVoice } from "../lib/api";
import { byLanguage, worthOffering } from "../lib/voices";
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
  const [steps, setSteps] = useState<Step[]>([]);
  const [voices, setVoices] = useState<MacVoice[]>([]);
  const [models, setModels] = useState<AssistModel[]>([]);
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);

  /** The live phase, for listeners that outlive a render. */
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const [needsAccess, setNeedsAccess] = useState(false);

  // Set while a run is in flight; flipped by Stop and by Esc, and read between
  // steps. A ref rather than state because the loop is already running and would
  // never see a re-render.
  const stop = useRef(false);

  const recorder = useRef(new Recorder());
  const inputRef = useRef<HTMLInputElement>(null);

  // This sitting's earlier exchanges, so a follow-up can say "and now turn it
  // back on". Cleared when the overlay is dismissed, not between questions —
  // closing it is what ends the conversation.
  const history = useRef<{ q: string; a: string }[]>([]);

  /** Make the panel key again and put the caret in the field.
   *
   *  Both halves are needed after a run that acted: the click that drove another
   *  app took key status with it, so focusing the input alone would leave every
   *  keystroke going to that app instead. */
  const focusInput = useCallback(() => {
    void getCurrentWindow().setFocus().catch(() => {});
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  /** Drag the whole overlay by its background, from anywhere on it. */
  const dragFrom = useCallback((e: React.MouseEvent) => {
    // Whatever was clicked, this window wants the keyboard now. The panel is
    // non-activating, so key status can be sitting in another app entirely and
    // the field would take the click and then swallow every keystroke.
    void getCurrentWindow().setFocus().catch(() => {});
    // Starting a window drag from a control would swallow the click that was
    // meant to press it.
    const el = e.target as HTMLElement;
    if (el.closest("input, button, label, textarea, select, a")) return;
    void overlayBarMoved().catch(() => {});
    void getCurrentWindow().startDragging();
  }, []);

  // API keys are deliberately NOT in localStorage — saveSettings strips them and
  // the real value lives in the OS keychain. loadSettings() therefore returns a
  // blank key, which is why this window has to rehydrate secrets the same way
  // the main window does. Without this every request 401s with a key that is
  // sitting right there on disk.
  const secrets = useRef<Partial<Settings>>({});
  // Fetched when the settings panel is first opened rather than on mount: the
  // list costs a request, and most questions never touch it.
  useEffect(() => {
    if (!showSettings || models.length || !settings.openrouterKey) return;
    listAssistModels(settings.openrouterKey)
      .then(setModels)
      .catch(() => setModels([]));
    listLocalAssistModels(settings.ollamaUrl)
      .then(setLocalModels)
      .catch(() => setLocalModels([]));
  }, [showSettings, models.length, settings.openrouterKey, settings.ollamaUrl]);

  useEffect(() => {
    listVoices()
      .then((all) => setVoices(worthOffering(all)))
      .catch(() => setVoices([]));
  }, []);

  useEffect(() => {
    loadSecrets()
      .then((s) => {
        secrets.current = s;
        setSettings((prev) => ({ ...prev, ...s }));
      })
      .catch((e) => logError("assist.secrets", e));
  }, []);

  /**
   * Change one setting from the overlay and keep it.
   *
   * Read-modify-write against what is on disk RIGHT NOW, not against this
   * window's copy: the overlay is long-lived and its snapshot may be minutes
   * stale, so writing the whole object back would quietly undo anything changed
   * in the Settings panel since.
   */
  const persist = useCallback((patch: Partial<Settings>) => {
    saveSettings({ ...loadSettings(), ...patch });
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // The Settings panel changed something while this window was open. Without
  // this the two pickers drift apart and disagree about which model is selected.
  useEffect(() => {
    const un = listen<Partial<Settings>>(SETTINGS_EVENT, (e) => {
      if (e.payload && typeof e.payload === "object") {
        setSettings((prev) => mergeBroadcast(prev, e.payload));
      }
    });
    return () => {
      void un.then((f) => f());
    };
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
    void overlayEscape(false).catch(() => {});
    recorder.current.cancel();
    setRecording(false);
    setPhase("idle");
    setAnswer(null);
    setError("");
    setQuestion("");
    setSteps([]);
    history.current = [];
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
        void overlayEscape(true).catch(() => {});
        if (e.payload?.listening) {
          // Push-to-talk: the key is already down, so start recording now
          // rather than making the user click a mic they did not reach for.
          void startRecording();
        } else {
          // The window has only just been shown; focus after the paint or the
          // caret lands nowhere and the first keystrokes are lost.
          focusInput();
        }
      }
    );
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSettings, focusInput]);

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

  // Escape, pressed anywhere on the Mac. It arrives from the global shortcut
  // rather than a keydown here, because the first click of a run hands focus to
  // the app being driven and this window stops hearing keys at all.
  //
  // One key, two meanings, in the order a person expects: stop what you are
  // doing, and if you are not doing anything, go away.
  useEffect(() => {
    const un = listen("screen-assist://escape", () => {
      if (phaseRef.current === "thinking" && !stop.current) {
        stop.current = true;
        setSteps((prev) =>
          prev.length ? prev : [{ tool: "stop", message: "Stopping…", ok: true }]
        );
        return;
      }
      dismiss();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [dismiss]);

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
        history: history.current,
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
      // A run that clicked took key status to the app it drove. Take it back so
      // the next question can simply be typed.
      focusInput();
      void say(settings, result.say, result.lang);
      // Filed under a "Screen Assist" chat session, so the overlay needs no
      // history of its own and these turn up in search and device sync.
      const asked = text.trim() || "(spoken question)";
      assistToChat(asked, result.detail ? `${result.say}\n\n${result.detail}` : result.say, result.sawScreen, false).catch(
        () => {}
      );
      // Three turns is enough for "now turn it back on" and short enough that
      // an old answer never crowds out the screenshot that matters.
      history.current = [...history.current, { q: asked, a: result.say }].slice(-3);
      // Only worth offering once the user has actually asked for something to
      // be done and been unable to have it done.
      if (settings.assistAct) {
        controlTrusted()
          .then((ok) => setNeedsAccess(!ok))
          .catch(() => {});
      }
    } catch (e) {
      logError("assist.ask", e);
      const message = String(e);
      setError(message);
      setPhase("answered");
      // A model that refuses outright is not a passing failure: it is gated,
      // or blocked by a data policy, and it will refuse every time. Remember it
      // so both pickers stop offering it, rather than letting the user rediscover
      // this on their next question.
      if (/\(HTTP 40[34]\)/.test(message) && !settings.assistModel.startsWith(LOCAL_PREFIX)) {
        persist({
          assistRejected: [
            ...new Set([...(loadSettings().assistRejected ?? []), settings.assistModel]),
          ],
        });
        setError(
          `${message}\n\nI won't offer that model again — pick another one under ⚙.`
        );
      }
    }
  }

  async function startRecording() {
    if (recorder.current.recording) return;
    if (settings.assistModel.startsWith(LOCAL_PREFIX)) {
      setError(
        "This model runs on your Mac and cannot hear — no local model can. Type your " +
          "question, or pick a hosted model under ⚙."
      );
      setPhase("answered");
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

  // Hosted models in the picker all hear; local ones never do. The mic says so
  // rather than letting someone hold a key and get an error for their trouble.
  const canHear = !settings.assistModel.startsWith(LOCAL_PREFIX);
  const thinking = phase === "thinking";
  const rejected = new Set(settings.assistRejected ?? []);
  const usableModels = models.filter((m) => !rejected.has(m.id));

  return (
    <div className="sa-root">
      <div className="sa-dock">
        {/* The bar never goes away while the overlay is open, so a follow-up is
            just typed — "and now turn it back on" — rather than reached for
            through a button first. */}
        {showSettings && (
          <div className="sa-panel" onMouseDown={dragFrom}>
            <label className="sa-opt">
              <input
                type="checkbox"
                checked={withScreen}
                onChange={(e) => {
                  setWithScreen(e.target.checked);
                  // Persisted as well as applied: someone turning this off in
                  // the middle of a sitting means it, and would not thank us
                  // for it coming back on at the next question.
                  persist({ assistAutoCapture: e.target.checked });
                }}
              />
              <span>See my screen</span>
            </label>

            {models.length + localModels.length > 0 && (
              <label className="sa-opt wide">
                <span>Model</span>
                <select
                  value={settings.assistModel}
                  onChange={(e) => persist({ assistModel: e.target.value })}
                  disabled={thinking}
                >
                  {/* The current one is always present, even if it has since
                      been rejected — a picker that cannot show what is selected
                      is worse than one showing a bad choice. */}
                  {!usableModels.some((m) => m.id === settings.assistModel) &&
                    !settings.assistModel.startsWith(LOCAL_PREFIX) && (
                      <option value={settings.assistModel}>{settings.assistModel}</option>
                    )}
                  {localModels.length > 0 && (
                    <optgroup label="On this Mac">
                      {localModels.map((m) => (
                        <option key={m} value={LOCAL_PREFIX + m}>
                          {m}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Hosted">
                    {usableModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
            )}

            <label className="sa-opt">
              <input
                type="checkbox"
                checked={settings.assistAct}
                onChange={(e) => persist({ assistAct: e.target.checked })}
              />
              <span>Let it use my Mac</span>
            </label>

            <label className="sa-opt">
              <input
                type="checkbox"
                checked={settings.assistSpeak}
                onChange={(e) => persist({ assistSpeak: e.target.checked })}
              />
              <span>Speak the answer</span>
            </label>

            {settings.assistSpeak && voices.length > 0 && (
              <label className="sa-opt wide">
                <span>Voice</span>
                <select
                  value={settings.assistVoice}
                  onChange={(e) => persist({ assistVoice: e.target.value })}
                >
                  <option value="">Auto — match the answer</option>
                  {byLanguage(voices).map(([label, list]) => (
                    <optgroup key={label} label={label}>
                      {list.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name.replace(/ \(.*\)$/, "")}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            )}

            {settings.assistAct && (
              <label className="sa-opt wide">
                <span>Stop after</span>
                <select
                  value={String(settings.assistMaxSteps)}
                  onChange={(e) => persist({ assistMaxSteps: Number(e.target.value) })}
                >
                  <option value="6">6 actions</option>
                  <option value="12">12 actions</option>
                  <option value="20">20 actions</option>
                  <option value="40">40 actions</option>
                  <option value="0">Never</option>
                </select>
              </label>
            )}
          </div>
        )}

        <div className="sa-bar" onMouseDown={dragFrom}>
          <button
            className={recording ? "sa-mic recording" : "sa-mic"}
            title={
              canHear
                ? recording
                  ? "Stop and send"
                  : "Ask by voice"
                : "This model runs on your Mac and cannot hear — type instead"
            }
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
            placeholder={
              recording
                ? "Listening… click the mic when you're done"
                : phase === "answered"
                  ? "Ask a follow-up…"
                  : "Ask about this screen, or anything else…"
            }
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !thinking) void submit(question, null);
            }}
            disabled={thinking}
          />

          <button
            className={showSettings ? "sa-gear open" : "sa-gear"}
            title="Screen Assist settings"
            onClick={() => setShowSettings((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 18.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
            </svg>
          </button>

          <button className="sa-close" onClick={dismiss} title="Close (Esc)">
            ✕
          </button>
        </div>

        {thinking && (
          <div className="sa-answer thinking" onMouseDown={dragFrom}>
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
          <div className="sa-answer" onMouseDown={dragFrom}>
            {error ? (
              <p className="sa-error">{error}</p>
            ) : (
              <>
                {steps.length > 0 && <Trail steps={steps} />}
                <p className="sa-say">{answer?.say}</p>
                {/* A failed capture used to vanish: the model answers "I can't
                    see your screen", which reads as the assistant being limited
                    rather than as one switch the user can go and flip. */}
                {answer?.captureError && (
                  <p className="sa-grant">
                    I couldn&apos;t take a screenshot, so that was answered blind.
                    <button onClick={() => void openSettingsPane("screen")}>
                      Open Screen Recording settings
                    </button>
                  </p>
                )}
                {needsAccess && (
                  <p className="sa-grant">
                    To let me click and type, switch AI Box on under Accessibility.
                    <button onClick={() => void controlRequestAccess()}>
                      Open System Settings
                    </button>
                  </p>
                )}
                {answer?.detail && <pre className="sa-detail">{answer.detail}</pre>}
                <div className="sa-foot">
                  <span className="sa-badge">{answer?.sawScreen ? "saw your screen" : "answered from knowledge"}</span>
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
