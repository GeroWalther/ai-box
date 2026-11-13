// The Settings window.
//
// Tabbed rather than one long scroll. The sections here have nothing to do with
// each other — how the app looks, what the screen assistant may do to your Mac,
// which keys it holds, what your phone can reach — and stacking them meant
// scrolling past three unrelated panels to reach the one you came for.
import { useState } from "react";
import { PROVIDERS, activeProvider, type Settings } from "../lib/settings";
import { useDirectModels } from "../hooks/useDirectModels";
import AgentSettings from "./AgentSettings";
import AssistSettings from "./AssistSettings";
import Diagnostics from "./Diagnostics";
import RemoteAccess from "./RemoteAccess";
import { THEMES, SYSTEM_THEME, DEFAULT_THEME, resolveTheme, type Theme } from "../lib/themes";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  /** Models installed on this Mac through Ollama. */
  localModels: string[];
  /** Opens the installer for them. */
  onManageModels: () => void;
}

type Tab = "general" | "assist" | "agent" | "remote" | "about";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "assist", label: "Screen Assist" },
  { id: "agent", label: "Agent" },
  { id: "remote", label: "Devices" },
  { id: "about", label: "Diagnostics" },
];

export default function SettingsModal({ settings, onChange, onClose, localModels, onManageModels }: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const active = activeProvider(settings);
  // Only to report the key's state: how many models it brought back, or that it
  // was refused. A key that types cleanly and then silently does nothing is the
  // failure this prevents.
  const directModels = useDirectModels(settings);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="modal-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "modal-tab active" : "modal-tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === "general" && (
            <>
              <section>
                <h3>Theme</h3>
                <p className="hint">Colours for the whole app and the terminal together.</p>
                <div className="theme-grid" role="radiogroup" aria-label="Theme">
                  {[SYSTEM_THEME, ...THEMES.map((t) => t.id)].map((id) => {
                    const t = resolveTheme(id);
                    const chosen = (settings.themeId || DEFAULT_THEME) === id;
                    const name = id === SYSTEM_THEME ? "System" : t.name;
                    return (
                      <button
                        key={id}
                        role="radio"
                        aria-checked={chosen}
                        className={chosen ? "theme-card active" : "theme-card"}
                        onClick={() => onChange({ themeId: id, theme: t.mode })}
                        title={id === SYSTEM_THEME ? "Follows macOS: AI Box Light or Dark" : name}
                      >
                        <ThemePreview theme={id === SYSTEM_THEME ? null : t} />
                        <span className="theme-name">{name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <h3>Provider</h3>
                <p className="hint">
                  One at a time. Whichever you pick is what every model picker in
                  the app offers — plus anything installed locally, which is always
                  available. Keys for the others stay saved, so switching back is
                  one click.
                </p>
                <div className="provider-picks">
                  {PROVIDERS.map((p) => {
                    const chosen = settings.activeProvider === p.id;
                    const hasKey = String(settings[p.key] ?? "").trim() !== "";
                    return (
                      <button
                        key={p.id}
                        className={chosen ? "provider-pick active" : "provider-pick"}
                        onClick={() => onChange({ activeProvider: p.id })}
                      >
                        <b>{p.label}</b>
                        <span>{p.blurb}</span>
                        {hasKey && !chosen && <i>key saved</i>}
                      </button>
                    );
                  })}
                </div>

                <label>{active.provider.label} API key</label>
                <input
                  type="password"
                  placeholder={`Key from ${active.provider.hint}`}
                  value={String(settings[active.provider.key] ?? "")}
                  onChange={(e) =>
                    onChange({ [active.provider.key]: e.target.value.trim() })
                  }
                />
                {active.apiKey === "" ? (
                  <p className="hint">
                    Get a key at {active.provider.hint}. Kept in the macOS keychain —
                    never in a file, and never sent anywhere but {active.provider.label}.
                  </p>
                ) : active.provider.id === "openrouter" ? (
                  <p className="hint">
                    Kept in the macOS keychain. Get a key at {active.provider.hint}.
                  </p>
                ) : directModels.loading ? (
                  <p className="hint">Checking the key…</p>
                ) : directModels.error ? (
                  <p className="hint error">{directModels.error}</p>
                ) : (
                  <p className="hint">
                    {directModels.models.length} models available on this key.
                  </p>
                )}

              </section>

              <section>
                <h3>Voice for videos</h3>
                <p className="hint">
                  Optional. Videos are voiced through OpenRouter by default; with your own
                  ElevenLabs key you can use your ElevenLabs voices (and their free previews)
                  instead.
                </p>
                <label>ElevenLabs API key</label>
                <input
                  type="password"
                  placeholder="Key from elevenlabs.io → Developers → API keys"
                  value={settings.elevenlabsKey}
                  onChange={(e) => onChange({ elevenlabsKey: e.target.value.trim() })}
                />
                <p className="hint">
                  Kept in the macOS keychain; billed to your ElevenLabs plan.
                </p>
              </section>

              <section>
                <h3>Local models</h3>
                <p className="hint">
                  Models that run on this Mac through Ollama. They appear in every model
                  picker under “On this Mac”, whichever provider is chosen above, and
                  nothing about them is billed.{" "}
                  {localModels.length === 0
                    ? "None installed yet."
                    : `Installed: ${localModels.join(", ")}.`}
                </p>
                <button className="btn" onClick={onManageModels}>
                  {localModels.length === 0 ? "Get local models…" : "Manage local models…"}
                </button>
              </section>

              <p className="hint">
                Model &amp; writing options live in each tab of the app itself (⚙ in
                Write, a model picker in every tab).
              </p>
            </>
          )}

          {tab === "assist" && <AssistSettings settings={settings} onChange={onChange} />}
          {tab === "agent" && <AgentSettings settings={settings} onChange={onChange} />}
          {tab === "remote" && <RemoteAccess settings={settings} onChange={onChange} />}
          {tab === "about" && <Diagnostics />}
        </div>

        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** A miniature of the theme: sidebar, a panel with an accent button, and a
 *  terminal line in its own colours. `null` draws "System" as half light,
 *  half dark. */
function ThemePreview({ theme }: { theme: Theme | null }) {
  if (!theme) {
    return (
      <span className="theme-preview theme-preview-split" aria-hidden="true">
        <ThemePreview theme={resolveTheme("aibox-light")} />
        <ThemePreview theme={resolveTheme("aibox-dark")} />
      </span>
    );
  }
  const u = theme.ui;
  const t = theme.term;
  const dots = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan].filter(Boolean) as string[];
  return (
    <span className="theme-preview" style={{ background: u.bg, borderColor: u.border }} aria-hidden="true">
      <span className="tp-side" style={{ background: u.bg2, borderColor: u.border }}>
        <i style={{ background: u.accent }} />
        <i style={{ background: u.muted }} />
        <i style={{ background: u.muted }} />
      </span>
      <span className="tp-main">
        <span className="tp-term" style={{ background: String(t.background), color: String(t.foreground) }}>
          <span>$ claude</span>
          <span className="tp-dots">
            {(dots.length ? dots : [u.accent, u.accent2, u.danger]).map((c, i) => (
              <i key={i} style={{ background: c }} />
            ))}
          </span>
        </span>
        <span className="tp-btn" style={{ background: u.accent, color: u.onAccent }}>Aa</span>
      </span>
    </span>
  );
}
