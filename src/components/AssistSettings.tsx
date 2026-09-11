// Settings for Screen Assist.
//
// Two lists here are read from the machine and from OpenRouter rather than kept
// in this file: the installed macOS voices, and the models that can actually see
// a screenshot. Both change without this app being rebuilt.
import { useEffect, useState } from "react";
import { LOCAL_PREFIX, type Settings } from "../lib/settings";
import {
  controlRequestAccess,
  controlTrusted,
  listAssistModels,
  listLocalAssistModels,
  listVoices,
  openSettingsPane,
  probeAssistModel,
  requestScreenAccess,
  screenAccess,
  setAssistHotkey,
  speak,
  type AssistModel,
  type MacVoice,
} from "../lib/api";
import { logError } from "../lib/log";
import { byLanguage, worthOffering } from "../lib/voices";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

/** Modifier combinations worth offering. Anything more exotic clashes. */
const HOTKEYS = [
  { value: "Alt+Space", label: "⌥ Space" },
  { value: "Control+Space", label: "⌃ Space" },
  { value: "Alt+A", label: "⌥ A" },
  { value: "Control+Alt+A", label: "⌃⌥ A" },
  { value: "CommandOrControl+Alt+Space", label: "⌘⌥ Space" },
  { value: "", label: "No shortcut" },
];

export default function AssistSettings({ settings, onChange }: Props) {
  const [voices, setVoices] = useState<MacVoice[]>([]);
  const [models, setModels] = useState<AssistModel[]>([]);
  /** Models on this Mac that can see a screen and make tool calls. Ollama
   *  reports both, so this list is filtered on fact rather than on the name. */
  const [local, setLocal] = useState<string[]>([]);
  const [hotkeyError, setHotkeyError] = useState("");
  /** Whether macOS lets AI Box drive the mouse and keyboard. Re-checked on
   *  focus, because the user grants it in System Settings — another app — and
   *  would otherwise come back to a panel still claiming it is missing. */
  const [canControl, setCanControl] = useState(true);
  const [canSeeScreen, setCanSeeScreen] = useState(true);
  /** Set while a newly picked model is being checked, and to its refusal after. */
  const [checking, setChecking] = useState(false);
  const [refusal, setRefusal] = useState("");

  useEffect(() => {
    const check = () => {
      void controlTrusted().then(setCanControl).catch(() => {});
      void screenAccess().then(setCanSeeScreen).catch(() => {});
    };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  useEffect(() => {
    // Only the shortlist: macOS ships about 180 voices and all but a handful of
    // them are jokes, legacy synthesisers, or duplicates of a language nobody
    // here speaks.
    listVoices()
      .then((all) => setVoices(worthOffering(all)))
      .catch(() => setVoices([]));
  }, []);

  useEffect(() => {
    listAssistModels(settings.openrouterKey)
      .then(setModels)
      .catch(() => setModels([]));
  }, [settings.openrouterKey]);

  useEffect(() => {
    listLocalAssistModels(settings.ollamaUrl)
      .then(setLocal)
      .catch(() => setLocal([]));
  }, [settings.ollamaUrl]);

  // Bind the shortcut whenever it changes, and report a clash rather than
  // leaving the user with a key that silently does nothing.
  useEffect(() => {
    if (!settings.assistEnabled) {
      setAssistHotkey("").catch(() => {});
      return;
    }
    setAssistHotkey(settings.assistHotkey, settings.assistPushToTalk)
      .then(() => setHotkeyError(""))
      .catch((e) => {
        setHotkeyError(String(e));
        logError("assist.hotkey", e);
      });
  }, [settings.assistEnabled, settings.assistHotkey, settings.assistPushToTalk]);

  const selected = models.find((m) => m.id === settings.assistModel);
  const isLocal = settings.assistModel.startsWith(LOCAL_PREFIX);

  /**
   * Pick a model, then check it will actually answer.
   *
   * Capabilities are advertised, permission is not: a model can declare image,
   * audio and tools and still refuse everything because it is gated to approved
   * apps or blocked by a data policy. Finding that out here costs one token;
   * finding it out later costs the user a failed question and a wrong guess
   * about their API key.
   */
  async function pick(id: string) {
    const previous = settings.assistModel;
    onChange({ assistModel: id });
    setRefusal("");
    if (id.startsWith(LOCAL_PREFIX) || !settings.openrouterKey.trim()) return;

    setChecking(true);
    try {
      await probeAssistModel(settings.openrouterKey, id);
    } catch (e) {
      // Remembered, so it stops being offered at all — and the previous model,
      // which was working a moment ago, is put back rather than leaving the
      // user on one that cannot answer.
      setRefusal(String(e).replace(/^Error:\s*/, ""));
      onChange({
        assistModel: previous,
        assistRejected: [...new Set([...(settings.assistRejected ?? []), id])],
      });
    } finally {
      setChecking(false);
    }
  }

  const rejected = new Set(settings.assistRejected ?? []);
  // OpenRouter marks its no-charge variants with a :free suffix. Worth their own
  // group: "needs a key" and "costs money" are different questions, and the
  // answer to the second is the one people are actually asking.
  const usable = models.filter((m) => !rejected.has(m.id));
  const free = usable.filter((m) => m.id.endsWith(":free") || m.promptPrice === 0);
  const paid = usable.filter((m) => !(m.id.endsWith(":free") || m.promptPrice === 0));
  const premium = voices.filter((v) => v.quality !== "default");

  return (
    <section>
      <h3>Screen Assist</h3>
      <p className="hint">
        Ask about whatever is on your screen — by voice or typing — and get a
        spoken answer with the answer circled on screen. Works over any app.
      </p>

      <label className="video-check">
        <input
          type="checkbox"
          checked={settings.assistEnabled}
          onChange={(e) => onChange({ assistEnabled: e.target.checked })}
        />
        Enable Screen Assist
      </label>

      {settings.assistEnabled && (
        <>
          <div className="row-2">
            <div className="field">
              <label>Shortcut</label>
              <select
                value={settings.assistHotkey}
                onChange={(e) => onChange({ assistHotkey: e.target.value })}
              >
                {HOTKEYS.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Model</label>
              <select
                value={settings.assistModel}
                onChange={(e) => void pick(e.target.value)}
                disabled={checking}
              >
                {!models.length && !local.length && (
                  <option value={settings.assistModel}>{settings.assistModel}</option>
                )}
                {local.length > 0 && (
                  <optgroup label="On this Mac — free, nothing leaves the machine">
                    {local.map((m) => (
                      <option key={m} value={LOCAL_PREFIX + m}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                )}
                {free.length > 0 && (
                  <optgroup label="Free tier — needs an OpenRouter key">
                    {free.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </optgroup>
                )}
                {paid.length > 0 && (
                  <optgroup label="Paid — needs an OpenRouter key">
                    {paid.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          </div>

          {hotkeyError && <p className="hint error">{hotkeyError}</p>}

          {local.length === 0 && (
            <p className="hint">
              No model on this Mac qualifies. Ollama reports what each one can do, and
              a local model needs vision and tool support — <code>qwen2.5vl</code> has
              both, plain <code>qwen2.5</code> has no eyes. Local models still cannot
              hear, so they mean typed questions.
            </p>
          )}

          {checking && <p className="hint">Checking that model will answer…</p>}
          {refusal && (
            <p className="hint error">
              {refusal} Put back the model you had, and left that one out of the list
              from now on.
            </p>
          )}

          {/* Said once, plainly, rather than as a badge on every row: the list is
              already filtered, so what matters is knowing WHY it is short. */}
          <p className="hint">
            Every model listed can do all three things this needs: <b>see</b> your
            screen, <b>hear</b> a spoken question, and <b>act</b> through tool calls.
            Models missing any one of them are left out — a model with no ears makes
            push-to-talk silently useless, and one without tool calls can describe
            your screen forever but never touch it.
          </p>

          <p className="hint">
            {isLocal ? (
              <>
                Runs on this Mac: free, and the screenshot never leaves it. It can
                see and it can act, but no local model can <i>hear</i> — so this one
                is typed questions only.
              </>
            ) : selected ? (
              <>
                ${(selected.promptPrice * 1e6).toFixed(2)} / M input tokens. Sees the
                screen, takes your voice directly, and can act on what it finds.
              </>
            ) : (
              `${usable.length} hosted models qualify, read live from OpenRouter` +
              `${local.length ? `, plus ${local.length} on this Mac` : ""}.`
            )}
          </p>

          <label className="video-check">
            <input
              type="checkbox"
              checked={settings.assistPushToTalk}
              onChange={(e) => onChange({ assistPushToTalk: e.target.checked })}
            />
            Hold the shortcut to talk
          </label>
          <p className="hint">
            On, {HOTKEYS.find((h) => h.value === settings.assistHotkey)?.label ?? "the shortcut"}{" "}
            is push-to-talk: hold it, speak, let go and it sends — no mouse, no
            second key. Off, it opens the bar for typing and you speak by holding{" "}
            {settings.assistHotkey.split("+")[0]}&nbsp;M instead.
          </p>

          <label className="video-check">
            <input
              type="checkbox"
              checked={settings.assistAutoCapture}
              onChange={(e) => onChange({ assistAutoCapture: e.target.checked })}
            />
            Always attach the screen
          </label>
          <p className="hint">
            On, every question carries a fresh screenshot. Off, the screen is only
            sent when you tick &ldquo;See screen&rdquo; in the bar or hold Shift with
            the shortcut — so ordinary questions never leave your desktop.
          </p>

          <label className="video-check">
            <input
              type="checkbox"
              checked={settings.assistAct}
              onChange={(e) => onChange({ assistAct: e.target.checked })}
            />
            Let it use your Mac
          </label>
          <p className="hint">
            On, asking for something to be <i>done</i> gets it done — &ldquo;turn Bluetooth
            off&rdquo;, &ldquo;open Mail&rdquo;, &ldquo;scroll down and click Accept&rdquo;.
            It clicks and types for real, one step at a time, naming each one as it goes;
            Esc or Stop halts it instantly. It will not buy, send, post or delete things,
            or touch passwords — for those it says so and leaves it to you.
          </p>

          {!canSeeScreen && (
            <p className="hint error">
              macOS hasn&apos;t given AI Box permission to see your screen, so every
              question is answered blind.{" "}
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  void requestScreenAccess();
                  void openSettingsPane("screen");
                }}
              >
                Open Screen Recording settings
              </button>
              , switch AI Box on, and restart it.
            </p>
          )}

          {settings.assistAct && !canControl && (
            <p className="hint error">
              macOS hasn&apos;t given AI Box permission to click or type yet.{" "}
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  void controlRequestAccess();
                }}
              >
                Open Accessibility settings
              </button>
              , switch AI Box on, and it works from the next question.
            </p>
          )}

          {settings.assistAct && (
            <div className="field">
              <label>Stop after</label>
              <select
                value={String(settings.assistMaxSteps)}
                onChange={(e) => onChange({ assistMaxSteps: Number(e.target.value) })}
              >
                <option value="6">6 actions</option>
                <option value="12">12 actions</option>
                <option value="20">20 actions</option>
                <option value="40">40 actions</option>
                <option value="0">Never — until the job is done</option>
              </select>
              <p className="hint">
                {settings.assistMaxSteps > 0 ? (
                  <>
                    A ceiling, not a target — it stops and reports rather than clicking
                    around your Mac indefinitely if it gets lost.
                  </>
                ) : (
                  <>
                    No ceiling: it keeps going until the job is done or you stop it.
                    Escape halts it from anywhere, even once another app has the
                    keyboard — worth staying at the Mac for a long one.
                  </>
                )}
              </p>
            </div>
          )}

          <label className="video-check">
            <input
              type="checkbox"
              checked={settings.assistSpeak}
              onChange={(e) => onChange({ assistSpeak: e.target.checked })}
            />
            Speak the answer
          </label>

          {settings.assistSpeak && (
            <>
              <div className="row-2">
                <div className="field">
                  <label>Voice</label>
                  <select
                    value={settings.assistVoice}
                    onChange={(e) => onChange({ assistVoice: e.target.value })}
                  >
                    <option value="">Auto — match the answer&apos;s language</option>
                    {byLanguage(voices).map(([label, list]) => (
                      <optgroup key={label} label={label}>
                        {list.map((v) => (
                          <option key={v.name} value={v.name}>
                            {v.name}
                            {v.quality !== "default" ? ` · ${v.quality}` : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Speed {settings.assistRate} wpm</label>
                  <input
                    type="range"
                    min={120}
                    max={280}
                    step={10}
                    value={settings.assistRate}
                    onChange={(e) => onChange({ assistRate: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="row-inline">
                <button
                  className="btn"
                  onClick={() =>
                    void speak(
                      "Here's how I'll sound when I answer you.",
                      settings.assistVoice,
                      settings.assistRate
                    )
                  }
                >
                  ▶ Hear it
                </button>
              </div>
              <p className="hint">
                On Auto, a German answer is read by a German voice and an English
                one by an English voice. macOS voices carry their language —
                Samantha reads German with English phonetics — and Siri&apos;s own
                language setting has no effect here, because <code>say</code>{" "}
                never consults it. Picking a specific voice below pins the
                language to that voice.
              </p>
              {premium.length === 0 && (
                <p className="hint">
                  Siri&apos;s voice isn&apos;t available to third-party apps — Apple
                  doesn&apos;t expose it. The closest is a Premium system voice, a free
                  download in System&nbsp;Settings → Accessibility → Spoken Content →
                  System Voice → Manage Voices. Grab Ava or Zoe (Premium) and it stops
                  sounding robotic.
                </p>
              )}
            </>
          )}

          <p className="hint">
            First use asks for <b>Screen Recording</b> permission (and{" "}
            <b>Microphone</b> for voice) in System Settings → Privacy &amp; Security.
            macOS needs AI Box restarted after granting Screen Recording.
          </p>
        </>
      )}
    </section>
  );
}
