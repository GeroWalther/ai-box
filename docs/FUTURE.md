# Future possible improvements

Ideas considered and deliberately deferred. Each records what the problem is, why
the obvious fix does not work, and what it would actually take — so picking one up
later starts from the decision, not from scratch.

---

## Keep terminal processes alive across an app restart

**Status:** deferred. Shipped instead: restoring a rendered picture of the screen
and scrollback (v0.2.5–0.2.7), which brings back what you were looking at and the
directory you were in, but not the process.

### The problem

Quitting AI Box kills every shell, so a `claude` session, a dev server or a long
build is gone on relaunch. What comes back is a photograph. It is honest but it
reads like the session was interrupted — the restored prompt looks live, and a
keystroke aimed at it goes to the new shell instead.

### Why saving harder cannot fix it

The PTY's master file descriptor belongs to the app process. When the app exits
the kernel closes it, the shell receives `SIGHUP`, and the process tree dies. No
amount of snapshotting on our side changes that; the owner has to outlive the app.

Worth knowing: **no terminal emulator solves this.** Warp, iTerm2 and Terminal.app
all restore text and working directory, not processes. What survives a terminal
restart is tmux/screen/zellij, and only because a separate server process owns the
PTYs and the terminal is merely a client attached to it. That is the mechanism, and
adopting it is the only route.

### Option A — our own PTY daemon (preferred)

Move PTY ownership into a small helper binary in the app bundle, started detached,
talking to the app over a unix socket under `~/.ai-box`. `PtyRegistry` moves into
the daemon roughly as-is; `pty_open_core` becomes a socket client.

Why this one: no third-party binary inside a notarized bundle, no key-binding
conflicts, and it fits the architecture — the Mac stays the source of truth. It
also unlocks something new rather than only fixing a defect: with the daemon owning
the shells, **a paired phone could drive terminals while the desktop app is closed**.

Real work, roughly in order:
- Daemon lifecycle: start on demand, single instance, survive app exit, exit when
  it has no sessions and no client for some grace period.
- Versioning: an old daemon must not serve a new app. Version the protocol and have
  the app ask a mismatched daemon to hand over or shut down after an update.
- Socket auth: anything that can reach the socket can run commands as the user.
  Permissions plus a token, and never place it somewhere world-readable.
- Crash recovery on both sides, and reconnect without losing the replay buffer.
- Orphan cleanup, so a stuck daemon is not left holding shells forever.

### Option B — tmux as the backend

Run each tab as `tmux new-session -A -s aibox-<tab-id>`. The tmux server outlives
the app, so reattaching returns the live session. Fastest route to a working proof
— perhaps an hour — and battle-tested.

Costs: tmux is not installed on a stock Mac, so it must be bundled and signed;
its prefix key and copy-mode scrollback can fight with full-screen apps like claude
and vim; and the scrollback restore we already have becomes redundant for those
sessions but not for others, so two paths coexist.

Reasonable as a spike to prove the UX is worth having before committing to A.

### The decision that comes with it, either way

Shells that outlive the app keep running and consuming battery until something
stops them. "Quit the app" would no longer mean "stop my work", which is a change
in what the app promises. It needs a visible list of what is still running and a
deliberate way to stop it — otherwise the feature turns into a background CPU leak
nobody can see. Decide the UI for that alongside the daemon, not after.

---

## Smaller things noticed along the way

- **Restored history is indistinguishable from live at a glance.** Header and
  footer markers help, but a restored `claude` input box still invites a keystroke.
  Dimming the whole restored block to grey would make it inert on sight, at the
  cost of losing colour in the history. Undecided.
- **Alt-screen apps restore only one screenful.** `claude`, `vim` and `top` run in
  the alternate screen, which by design has no scrollback, so there is nothing above
  the visible screen to save. Inherent, not a bug — but it surprises people who
  expect the same scrollback they get from ordinary shell work.
