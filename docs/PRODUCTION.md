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

1. ⬜ **Finish signing + notarization** — needs your Apple Developer account; steps
   in `docs/SIGNING.md`. **Hard gate**: nobody can install an unsigned `.dmg`.
2. 🔨 **API-key security**
   - ✅ **Keys never leave the Mac.** `get_remote_settings` now strips secrets — a
     configured key becomes a non-empty sentinel (so the phone's "key configured?"
     UI still works) but never the real value; the pairing token is removed.
     Provider calls (`chat_completion`, `generate_text`, `list_openrouter_models`,
     OpenRouter image gen) run on the Mac, which injects its own key server-side, so
     the key never traverses the cleartext LAN or lives in phone storage.
     Unit-tested (strip/inject/pick-by-base-url).
   - ⬜ **At rest**: store desktop keys in the **macOS Keychain**
     (tauri-plugin-stronghold or a keychain plugin) instead of plaintext
     localStorage. Larger refactor (settings load becomes async) — separate step.
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
