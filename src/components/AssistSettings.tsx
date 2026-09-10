// Settings for Screen Assist.
//
// Two lists here are read from the machine and from OpenRouter rather than kept
// in this file: the installed macOS voices, and the models that can actually see
// a screenshot. Both change without this app being rebuilt.
import { useEffect, useState } from "react";
import type { Settings } from "../lib/settings";
import { listAssistModels, listVoices, setAssistHotkey, speak, type AssistModel, type MacVoice } from "../lib/api";
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

export default function AssistSettings({ settings, onChange }: Props) {
  const [voices, setVoices] = useState<MacVoice[]>([]);
  const [models, setModels] = useState<AssistModel[]>([]);
  const [hotkeyError, setHotkeyError] = useState("");

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
    setAssistHotkey(settings.assistHotkey)
      .then(() => setHotkeyError(""))
      .catch((e) => {
        setHotkeyError(String(e));
        logError("assist.hotkey", e);
      });
  }, [settings.assistEnabled, settings.assistHotkey]);

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
                    <option value="">System default</option>
                    {voices.map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.name}
                        {v.quality !== "default" ? ` · ${v.quality}` : ""}
                      </option>
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
