# Novel Studio — Production-Readiness Plan

Vision: **an OpenHands/Claude-Code-style agent for novelists** — writes and edits
prose, acts as an agent on your Mac, works with **local (Ollama) and cloud
(OpenRouter / any OpenAI-compatible)** models, and is **controllable from your
phone** over the LAN/Tailscale.

Status legend: ✅ done · 🔨 in progress · ⬜ todo

---

## Phase 0 — Done in this pass
- ✅ **Mobile UI**: fixed the first-run onboarding modal overflowing narrow phone
  screens (`src/App.css`).
- ✅ **LAN lockdown** (`src-tauri/src/server.rs`, `lib.rs`):
  - Fail-**closed** auth — the server refuses to start without a token and denies
    requests when no token is configured; constant-time token compare.
  - Remote filesystem tools **confined to a workspace root** (`remoteWorkspace`
    setting, default `~/Documents`) — a phone can no longer read `~/.ssh`,
    `~/.aws`, etc. `~`/`..`/symlink escapes rejected.
  - `download_file` now **approval-gated + confined** (was ungated arbitrary write).
  - `web_fetch` + `download_file` **SSRF-guarded** (block loopback/private/
    link-local/metadata) and **time-bounded**.
  - `run_command` (non-streaming) now has a 120s timeout + kill-on-drop.
  - Request timeouts added to `chat_completion` / `web_fetch`.
- ✅ **Signing scaffolding**: `entitlements.plist` + `tauri.conf.json` macOS bundle
  config; clean bundle identifier. See `docs/SIGNING.md`.

---

## Phase 1 — Remaining ship-blockers (before any public build)

1. ⬜ **Finish signing + notarization** — needs your Apple Developer account; steps
   in `docs/SIGNING.md`. **Hard gate**: nobody can install an unsigned `.dmg`.
2. ⬜ **API-key security**
   - Stop shipping raw keys to the phone. `get_remote_settings` returns the full
     settings incl. `openrouterKey` (`server.rs`). Instead, **proxy all provider
     calls through the Mac** so the key never leaves the desktop, OR strip keys from
     the remote settings payload and have the phone call provider endpoints via the
     Mac's authenticated RPC.
   - Store keys in the **macOS Keychain** (tauri-plugin-stronghold or a keychain
     plugin) instead of plaintext localStorage.
3. ⬜ **Server-side cancel + streaming timeouts** — Stop is currently cosmetic; the
   Mac keeps generating and **burning cloud credits**. Thread an `AbortHandle` /
   cancel token through the request id in `generate_text_core` + the WS request map
   (`server.rs` `handle_ws`), and add a connect timeout to the streaming reqwest
   client. Wire the frontend Stop button and the phone WS `cancel` to it.
4. ⬜ **Sync data integrity** — desktop↔phone sync is last-writer-wins on the whole
   array (`lib.rs` `remote_store_set`, `App.tsx`, `Chat.tsx`); concurrent edits
   silently clobber a manuscript. Add per-item ids + `updatedAt`, merge on write,
   or lock editing to one device at a time.

---

## Phase 2 — Portable / backupable + reliability

5. ⬜ **Portable, backupable projects** (your ask)
   - **Save/Open real project files**: a `.novel` bundle on disk (JSON doc + bible
     + settings ref) via the Tauri dialog + fs plugin — not just download-export
     (`ExportMenu.tsx` is download-only today). Makes work portable and removes the
     "localStorage got cleared → everything gone" risk.
   - **Atomic writes** for `~/.ai-studio/store.json` (temp file + rename) and
     **rolling backups** (keep last N) so one bad/concurrent write can't corrupt
     everything.
   - **Settings to disk**: settings (and thus keys, once in Keychain) currently have
     no disk mirror — mirror non-secret settings to disk so a cleared webview store
     isn't fatal.
   - **Prune the image gallery**: `~/.ai-studio/images` grows unbounded — add a
     size cap / LRU prune.
   - **Export formats**: Markdown / EPUB / DOCX for finished manuscripts.
6. ⬜ **Error UX + retries** — map 401/404/429/5xx to actionable messages (bad key,
   model not found, rate-limited), show empty-response and network-drop states
   explicitly instead of inline `[error]` text; add backoff retry on 429/5xx.
7. ⬜ **Auto-updater + release identity** — add `tauri-plugin-updater` with signed
   artifacts; unify product name; automate the version bump across the 3 manifests.
8. ⬜ **Finish provider coverage** — wire the `custom` OpenAI-compatible provider
   into `ModelSelect`; use the fetched `contextLength` to budget prompt size and set
   sane per-model `max_tokens` (agent steps currently send none).
9. ⬜ **Content-Security-Policy** — replace `csp: null` with a real policy for the
   desktop webview and a CSP header on the served phone bundle (careful: BYOK needs
   a broad `connect-src`).

---

## Phase 3 — Differentiators (make it genuinely better)

10. ⬜ **Local model = local agent** — a **ReAct-style prompt fallback** so Ollama
    models without native tool-calling can still drive the agent. Detect empty
    `tool_calls`, switch to a `Thought/Action/Observation` loop with a JSON/text
    tool-call parser (`src/lib/agent.ts`, `Chat.tsx` dispatch). This is the core
    "works locally" claim and the main differentiator vs cloud-only tools.
11. ⬜ **Diff-preview before writes** — replace the yes/no approval with the actual
    file **diff** rendered on the Mac before applying (`RemoteApprovalListener.tsx`;
    `fs_edit` already returns a diff). Far more trustworthy for phone-driven edits.
    Also serialize concurrent approvals (a 2nd request currently overwrites the 1st).
12. ⬜ **Story Bible → retrieval** — feed `doc.bible` (characters/world/continuity)
    into generation as **structured context** instead of a blind `slice(-8000)`
    (`presets.ts`). Continuity-aware prose is the killer feature for long-form
    fiction. Optionally embed + retrieve the most relevant bible entries per scene.
13. ⬜ **Token / credit meter** — surface OpenRouter usage + cost live (and per
    session), especially important since phone-triggered generation can run
    unattended.
14. ⬜ **Tailscale-first "away mode"** — make Tailscale (real HTTPS, no cleartext)
    the **recommended** remote path; gate plain-LAN HTTP behind an explicit "I'm on
    a trusted network" warning. Tailscale IP is already detected (`server.rs`).
15. ⬜ **Per-device pairing + revoke** — named devices, a revoke button, and token
    TTL / rotation instead of one shared forever-token (`RemoteAccess.tsx`).

---

## Suggested order
Phase 1 (#1–4) is the gate to *installable + safe*. Then #5 (portable/backupable)
and #6 (error UX) for trust, then the differentiators (#10–12) that make the product
worth choosing. #3 (cancel) and #4 (sync) are high-urgency because they cost real
money and real manuscripts.
