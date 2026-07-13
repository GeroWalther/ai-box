# Novel Studio — Production-Readiness Plan

Vision: **an OpenHands/Claude-Code-style agent for novelists** — writes and edits
prose, acts as an agent on your Mac, works with **local (Ollama) and cloud
(OpenRouter / any OpenAI-compatible)** models, and is **controllable from your
phone** over the LAN/Tailscale.

Status legend: ✅ done · 🔨 in progress · ⬜ todo

## North star — why this beats "LM Studio + a writing tool"
Running uncensored local models is commodity (LM Studio, Ollama). The reason to
choose Novel Studio is the **combination no runtime offers**, carried by three
pillars:
1. **Continuity-aware Story Bible** — keeps characters/world/canon consistent across
   a whole novel, not just the last few pages. *(v1 shipped — see Phase 0.)*
2. **Tight local text + local image, scene-aware** — illustrate the scene you're
   writing from the same context, 100% on-device.
3. **Phone-controlled agent** — draft and manage the manuscript from the couch.

Everything else (signing, sync, packaging) makes it *shippable*; these three make it
*worth choosing*.

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
- ✅ **Story Bible retrieval v1** (pillar #1) — `src/lib/presets.ts`
  `buildBibleContext()` + Story Bible UI (`aliases`, canon `facts`). Replaces the
  blind full-bible dump: detects which characters are in the current scene (name +
  aliases, CJK-safe), gives them full detail while collapsing the rest to a roster,
  and always surfaces relevant **canon facts** so a fact set chapters ago survives
  after it scrolls out of the text window. Deterministic → works with local models.
  Behaviourally tested (9/9 assertions).

---

## Phase 1 — Remaining ship-blockers (before any public build)

1. 🔨 **Finish signing + notarization** — fully **automated**: `.github/workflows/
   release.yml` (build+sign+notarize on a version tag) and `scripts/build-signed.sh`
   + `scripts/verify-signing.sh` for local builds. **Only remaining action is
   yours**: an Apple Developer account + Developer ID cert, then set the env
   vars/secrets in `docs/SIGNING.md`. **Hard gate**: nobody can install an unsigned
   `.dmg` until this runs with your cert.
2. ✅ **API-key security**
   - ✅ **Keys never leave the Mac.** `get_remote_settings` now strips secrets — a
     configured key becomes a non-empty sentinel (so the phone's "key configured?"
     UI still works) but never the real value; the pairing token is removed.
     Provider calls (`chat_completion`, `generate_text`, `list_openrouter_models`,
     OpenRouter image gen) run on the Mac, which injects its own key server-side, so
     the key never traverses the cleartext LAN or lives in phone storage.
     Unit-tested (strip/inject/pick-by-base-url).
   - ✅ **At rest**: desktop API keys now live in the **macOS Keychain**
     (`keyring` crate; `secret_get`/`secret_set` commands), never plaintext
     localStorage. On startup the app hydrates keys from the keychain, migrating any
     legacy key still in localStorage and scrubbing the plaintext copy; keys are
     re-persisted to the keychain only when they change. Desktop-only commands (not
     exposed over the companion server), so a phone can't read the Mac's keychain.
     Round-trip verified on-device. NOTE: unsigned dev builds may show a keychain
     access prompt; a Developer ID-signed build (Phase 1 #1) makes access stable and
     silent across launches.
3. ✅ **Server-side cancel + streaming timeouts** — Stop now aborts the upstream
   request server-side (no more burning cloud credits). A client `requestId` flows
   into `generate_text`; a `CancelRegistry` flag is polled by the stream loop
   (≤250ms latency) and drops the stream on Stop; `cancel_generation` (Tauri) and a
   WS cancel frame drive it from both transports. Wired into the Write flow
   (`App.tsx`) and Chat (`Chat.tsx`). Connect-timeout added to the streaming client.
   Verified by mock-SSE integration tests (cancel stops early; uncancelled completes).
4. ✅ **Sync data integrity** — was last-writer-wins on the whole array (a
   concurrent desktop/phone edit silently clobbered a manuscript). Now a
   conflict-free item-level merge: docs and chat sessions carry `id` + `updatedAt`;
   `store_merge_list` (lib.rs) merges last-writer-wins per item with **tombstones**
   (a `deleted:{id:ts}` map) so deletes aren't resurrected and an edit newer than a
   delete wins. Both saving and syncing go through the one merge, so neither
   direction loses data; the store is written atomically (temp+rename). Wired into
   `App.tsx` (documents) and `Chat.tsx` (sessions). Verified: Rust merge tests
   (concurrent edits preserved, tombstones, legacy migration) + TS parser tests.

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
6. ✅ **Error UX + retries** — `friendly_http_error` (lib.rs) maps 401/403/404/402/
   429/5xx to actionable messages (bad key, model not found, out of credit,
   rate-limited, provider error); `chat_completion` and the streaming connect retry
   transient failures (429/5xx/network) with backoff (`is_transient`/`backoff`/
   `MAX_ATTEMPTS`), bailing early if cancelled. Verified `cargo test --lib` (10/10).
7. ⬜ **Auto-updater + release identity** — add `tauri-plugin-updater` with signed
   artifacts; unify product name; automate the version bump across the 3 manifests.
8. ✅ **Finish provider coverage** — the `custom` OpenAI-compatible provider (LM
   Studio / proxy) is now selectable directly in `ModelSelect` (a "Custom
   (OpenAI-compatible)" group), not just Settings. ⬜ Still todo: use fetched
   `contextLength` to budget prompt size / per-model `max_tokens`.
9. ✅ **Content-Security-Policy** — replaced `csp: null` with a real policy in
   `tauri.conf.json` (`script-src 'self'`, `img-src 'self' data: blob: asset:`,
   `style-src 'self' 'unsafe-inline'`, `connect-src 'self' ipc:` + Tauri's asset/
   IPC protocols; `object-src 'none'`, `frame-ancestors 'none'`). Desktop provider
   traffic goes through Rust IPC, so no broad `connect-src` is needed. Verified the
   built bundle mounts with zero CSP refusals in headless Chrome.

---

## Phase 3 — Differentiators (make it genuinely better)

10. ✅ **Local model = local agent** — ReAct fallback shipped. When a model returns
    no native `tool_calls`, `parseTextToolCall` (`src/lib/agent.ts`) extracts an
    action from the text (JSON `{"tool","args"}` in several shapes, or
    `Action:/Action Input:`), the agent executes it, and feeds the result back as a
    plain-text `Observation:` — so Ollama models without native tool-calling can
    drive the agent. Native tool-calling path unchanged. Parser tested (9/9).
11. 🔨 **Diff-preview before writes** — ✅ diff rendered on the Mac before applying a
    remote write/edit (`RemoteApprovalListener.tsx` + `preview_diff`). ⬜ Still
    todo: serialize concurrent approvals (a 2nd request overwrites the 1st).
12. 🔨 **Story Bible → retrieval** (pillar #1) — v1 shipped (Phase 0). Next: (a)
    **auto-extract** canon facts from prose as you write (offer "add to bible" chips
    for new names/places/claims); (b) optional **embeddings** retrieval for large
    bibles (rank facts by semantic relevance, not just entity match); (c) a
    **continuity checker** that flags a draft passage contradicting a canon fact.
12b. ⬜ **Tight local text + image, scene-aware** (pillar #2) — generate a scene
    illustration from the *current* passage + Story Bible (character/world) context
    with one click, 100% local (ComfyUI/A1111). Carry character appearance from the
    bible into the image prompt for visual consistency.
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
