// Settings for what the agent is allowed to touch.
//
// Two independent controls, deliberately not collapsed into one "trust the
// agent" switch, because they answer different questions:
//   • Workspace + protected paths = WHERE it may act (enforced in Rust)
//   • Auto-approve = whether it stops to ASK (a convenience for remote use)
//   • Full autonomy = also waives the commit-click gate and the step limit
// Turning off the asking must never widen the where, so the copy here says so.

import type { Settings } from "../lib/settings";
import { isTauri } from "../lib/transport";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export default function AgentSettings({ settings, onChange }: Props) {
  // Approvals are decided on the Mac, from the Mac's settings — a phone's copy is
  // never sent back. So on the phone these show the Mac's choice, read-only.
  const onMac = isTauri();
  const macOnly = onMac ? null : (
    <span className="hint">Set on the Mac — tasks you start from this phone follow it.</span>
  );
  return (
    <section>
      <h3>Agent &amp; Assistant</h3>

      <label htmlFor="assistant-profile">Your details for the Assistant</label>
      <textarea
        id="assistant-profile"
        rows={4}
        placeholder={"Name: …\nPhone: …\nEmail: …\nAddress: …"}
        value={settings.assistantProfile}
        onChange={(e) => onChange({ assistantProfile: e.target.value })}
      />
      <p className="hint">
        What the Assistant may use to fill in forms — a reservation, a delivery address. It never
        invents details; anything missing here, it asks you for. Never put passwords or card
        numbers here: logging in and paying are always handed back to you.
      </p>

      <label htmlFor="agent-workspace">Workspace folder</label>
      <input
        id="agent-workspace"
        type="text"
        placeholder="~"
        value={settings.agentWorkspace}
        onChange={(e) => onChange({ agentWorkspace: e.target.value })}
      />
      <p className="hint">
        The agent's file tools can only read and write inside this folder — on this Mac
        and from your phone. <code>~</code> means your whole home folder. Narrow it to
        something like <code>~/Documents/code</code> if you want a tighter leash.
      </p>

      <label className="remote-inline">
        <input
          type="checkbox"
          checked={settings.autoApproveTools}
          disabled={!onMac}
          onChange={(e) => onChange({ autoApproveTools: e.target.checked })}
        />
        <span>
          Don't ask for approval (away mode)
          <span className="hint">
            Lets the agent write files and run commands without stopping to ask — needed
            when you're driving the Mac from your phone and nobody is there to click
            Approve. Protected paths below stay protected either way.
          </span>
          {macOnly}
        </span>
      </label>

      <label className="remote-inline">
        <input
          type="checkbox"
          checked={settings.fullAutonomy}
          disabled={!onMac}
          onChange={(e) => onChange({ fullAutonomy: e.target.checked })}
        />
        <span>
          ⚠️ Full autonomy (dangerous)
          <span className="remote-danger">
            The Assistant works a task through to the end without ever asking for approval
            — including clicks that pay, book, send or delete, using your mouse and keyboard,
            and quitting apps — and with no step limit. It only stops when it is done, when
            you press Stop, or when it needs information from you (or a login / CAPTCHA).
            Applies to tasks started from your phone too. Includes away mode. Protected paths
            stay protected. Turn it off when you're done.
          </span>
          {macOnly}
        </span>
      </label>

      <label className="remote-inline">
        <input
          type="checkbox"
          checked={settings.allowProtectedPaths}
          onChange={(e) => onChange({ allowProtectedPaths: e.target.checked })}
        />
        <span>
          Allow protected paths
          <span className="remote-danger">
            Off by default. While off, <code>~/.ssh</code>, <code>~/.aws</code>, keychains,
            shell startup files (<code>.zshrc</code>) and LaunchAgents are refused outright
            — even in away mode. Only turn this on if you specifically need the agent to
            edit your dotfiles.
          </span>
        </span>
      </label>

      <p className="hint">
        Shell commands can't be confined to a folder the way file tools can — a shell can
        go anywhere. That's why <b>Run command</b> always asks unless away mode is on.
      </p>
    </section>
  );
}
