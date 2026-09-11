// Settings for Screen Assist.
//
// Two lists here are read from the machine and from OpenRouter rather than kept
// in this file: the installed macOS voices, and the models that can actually see
// a screenshot. Both change without this app being rebuilt.
import { useEffect, useState } from "react";
import type { Settings } from "../lib/settings";
import {
  controlRequestAccess,
  controlTrusted,
  listAssistModels,
  listVoices,
  setAssistHotkey,
  speak,
  type AssistModel,
  type MacVoice,
} from "../lib/api";
import { logError } from "../lib/log";

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

/**
 * Voices grouped by language.
 *
 * macOS installs about 180 of them. A flat list buries the German voices below
 * a hundred English novelty ones, which is how "where do I set a German voice?"
 * becomes a real question. Language names come from the OS rather than a table
 * kept here, so every locale is labelled properly.
 */
function byLanguage(voices: MacVoice[]): [string, MacVoice[]][] {
  const names = new Intl.DisplayNames(undefined, { type: "language" });
  const groups = new Map<string, MacVoice[]>();
  for (const v of voices) {
    const code = v.locale.split(/[_-]/)[0];
    let label = code;
    try {
      label = names.of(code) ?? code;
    } catch {
      /* an unknown code is still worth grouping under itself */
    }
    const bucket = groups.get(label);
    if (bucket) bucket.push(v);
    else groups.set(label, [v]);
  }
  // listVoices() already puts English and the best-quality voices first, and
  // Map preserves insertion order, so that ordering carries through.
  return [...groups.entries()];
}

export default function AssistSettings({ settings, onChange }: Props) {
  const [voices, setVoices] = useState<MacVoice[]>([]);
  const [models, setModels] = useState<AssistModel[]>([]);
  const [hotkeyError, setHotkeyError] = useState("");
  /** Whether macOS lets AI Box drive the mouse and keyboard. Re-checked on
   *  focus, because the user grants it in System Settings — another app — and
   *  would otherwise come back to a panel still claiming it is missing. */
  const [canControl, setCanControl] = useState(true);

  useEffect(() => {
    const check = () => void controlTrusted().then(setCanControl).catch(() => {});
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  useEffect(() => {
    listVoices().then(setVoices).catch(() => setVoices([]));
  }, []);

  useEffect(() => {
    listAssistModels(settings.openrouterKey)
      .then(setModels)
      .catch(() => setModels([]));
  }, [settings.openrouterKey]);

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
                onChange={(e) => onChange({ assistModel: e.target.value })}
              >
                {!models.length && <option value={settings.assistModel}>{settings.assistModel}</option>}
                {models.slice(0, 60).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                    {m.hears ? " · hears" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {hotkeyError && <p className="hint error">{hotkeyError}</p>}

          <p className="hint">
            {selected ? (
              <>
                ${(selected.promptPrice * 1e6).toFixed(2)} / M input tokens.{" "}
                {selected.hears ? (
                  "Takes your voice directly, so speaking needs no separate transcription."
                ) : (
                  <b>This model can&apos;t hear — voice questions won&apos;t work, only typing.</b>
                )}
              </>
            ) : (
              `${models.length} models can see a screenshot, read live from OpenRouter.`
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
