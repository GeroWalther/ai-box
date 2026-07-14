// "Phone access" panel: turn the desktop app into a server your phone can reach.
// Away mode starts the companion server (src-tauri/src/server.rs), keeps the Mac
// awake, and shows LAN + Tailscale links with QR codes that carry a pairing token.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { QRCodeSVG } from "qrcode.react";
import { isTauri } from "../lib/transport";
import type { Settings } from "../lib/settings";
import { useToast } from "../lib/toast";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

interface Urls {
  running: boolean;
  port: number;
  token: string;
  lan: string | null;
  tailscale: string | null;
}

function newToken(): string {
  // A URL-safe random token used as the bearer credential for the QR link.
  return crypto.randomUUID().replace(/-/g, "");
}

function LinkQR({ label, url, token }: { label: string; url: string; token: string }) {
  const full = `${url}/#token=${token}`;
  return (
    <div className="remote-qr">
      <div className="remote-qr-code">
        <QRCodeSVG value={full} size={148} marginSize={2} />
      </div>
      <div className="remote-qr-meta">
        <div className="remote-qr-label">{label}</div>
        <code className="remote-qr-url">{url}</code>
        <button
          className="btn ghost"
          onClick={() => navigator.clipboard.writeText(full)}
          title="Copy the full paired link (includes the token)"
        >
          Copy link
        </button>
      </div>
    </div>
  );
}

export default function RemoteAccess({ settings, onChange }: Props) {
  const { error: toastError } = useToast();
  const [urls, setUrls] = useState<Urls | null>(null);
  const [busy, setBusy] = useState(false);

  const desktop = isTauri();

  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      setUrls(await invoke<Urls>("remote_urls"));
    } catch {
      /* server not started yet */
    }
  }, [desktop]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function start(wakeLock: boolean) {
    setBusy(true);
    try {
      let token = settings.remoteToken;
      if (!token) {
        token = newToken();
        onChange({ remoteToken: token });
      }
      const result = await invoke<Urls>("start_remote_server", {
        port: settings.remotePort || 8787,
        token,
        wakeLock,
      });
      setUrls(result);
    } catch (e) {
      toastError(`Could not start phone access: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await invoke("stop_remote_server");
      await refresh();
    } catch (e) {
      toastError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    const token = newToken();
    onChange({ remoteToken: token });
    // Restart so the new token takes effect and old links stop working.
    if (urls?.running) {
      setBusy(true);
      try {
        await invoke<Urls>("start_remote_server", {
          port: settings.remotePort || 8787,
          token,
          wakeLock: settings.remoteWakeLock,
        }).then(setUrls);
      } finally {
        setBusy(false);
      }
    }
  }

  if (!desktop) {
    return (
      <section>
        <h3>Phone access</h3>
        <p className="hint">
          You're viewing AI Studio over the network — it's already served from your Mac.
          Manage phone access from the desktop app's Settings.
        </p>
      </section>
    );
  }

  const running = !!urls?.running;

  return (
    <section>
      <h3>Phone access {running && <span className="remote-dot" title="Server running" />}</h3>
      <p className="hint">
        Run a small server on this Mac so your phone can drive it — trigger the agent,
        write, and generate images while the Mac does the work. Scan a QR code to pair.
      </p>

      <label className="remote-away">
        <input
          type="checkbox"
          checked={running}
          disabled={busy}
          onChange={(e) => (e.target.checked ? start(settings.remoteWakeLock) : stop())}
        />
        <span>
          <b>Away mode</b> — serve to phones{settings.remoteWakeLock ? " and keep the Mac awake" : ""}
        </span>
      </label>

      <label className="remote-inline">
        <input
          type="checkbox"
          checked={settings.remoteWakeLock}
          onChange={(e) => onChange({ remoteWakeLock: e.target.checked })}
        />
        Keep the Mac awake while serving (needed for access when you're away)
      </label>

      <label className="remote-inline">
        <input
          type="checkbox"
          checked={settings.autoApproveTools}
          onChange={(e) => onChange({ autoApproveTools: e.target.checked })}
        />
        <span>
          Auto-approve agent actions (no prompt)
          <span className="remote-danger">
            {" "}— for when you're truly away. The agent can run commands and
            change files on this Mac <b>without asking</b>. Only enable on a
            trusted network / device.
          </span>
        </span>
      </label>

      {running && urls && (
        <>
          <div className="remote-links">
            {urls.lan && <LinkQR label="On your Wi‑Fi (LAN)" url={urls.lan} token={urls.token} />}
            {urls.tailscale ? (
              <LinkQR label="Anywhere via Tailscale" url={urls.tailscale} token={urls.token} />
            ) : (
              <div className="remote-qr">
                <div className="remote-qr-meta">
                  <div className="remote-qr-label">Anywhere via Tailscale</div>
                  <p className="hint">
                    Tailscale not detected. Install it on this Mac and your phone
                    (tailscale.com) to reach the app over cellular. For HTTPS, run{" "}
                    <code>tailscale serve --bg localhost:{urls.port}</code>.
                  </p>
                </div>
              </div>
            )}
          </div>
          <div className="remote-actions">
            <button className="btn ghost" onClick={regenerate} disabled={busy}>
              Regenerate token
            </button>
            <span className="hint">Regenerating revokes existing paired links.</span>
          </div>
        </>
      )}

      <p className="hint remote-security">
        🔒 Links carry a secret token and are only reachable on your Wi‑Fi or your
        Tailscale network — never the public internet. Agent commands and file changes
        still ask for approval <b>here on the Mac</b>.
      </p>
    </section>
  );
}
