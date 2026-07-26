// Settings for what the agent is allowed to touch.
//
// Two independent controls, deliberately not collapsed into one "trust the
// agent" switch, because they answer different questions:
//   • Workspace + protected paths = WHERE it may act (enforced in Rust)
//   • Auto-approve = whether it stops to ASK (a convenience for remote use)
// Turning off the asking must never widen the where, so the copy here says so.

import type { Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export default function AgentSettings({ settings, onChange }: Props) {
  return (
    <section>
      <h3>Agent permissions</h3>

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
          onChange={(e) => onChange({ autoApproveTools: e.target.checked })}
        />
        <span>
          Don't ask for approval (away mode)
          <span className="hint">
            Lets the agent write files and run commands without stopping to ask — needed
            when you're driving the Mac from your phone and nobody is there to click
            Approve. Protected paths below stay protected either way.
          </span>
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
