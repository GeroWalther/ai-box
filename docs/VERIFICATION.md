# Live end-to-end verification

The security and merge logic is covered by automated tests (`cargo test`), but a
few things can only be confirmed in the running app + a real phone. This is the
repeatable checklist.

## Run the app
```bash
npm install
npm run tauri dev        # launches the desktop app
```

## 1. Server-side cancel (Stop actually aborts)
1. Pick a cloud model, start a long continuation (⌘↵ on a big word target).
2. Hit **Stop** mid-stream.
3. Expect: text stops immediately AND generation ends server-side (no further
   tokens, no continued billing). *(The abort itself is also covered by the Rust
   integration test `cancel_stops_stream_early`.)*

## 2. API key at rest → Keychain (+ migration)
1. With a key already set (from a previous version), launch the new build.
2. Check migration + scrub:
   ```bash
   # The key should NO LONGER be in the localStorage-backed settings on disk:
   grep -o 'openrouterKey' ~/Library/WebKit/*/WebsiteData/LocalStorage/* 2>/dev/null; echo "---"
   # And it SHOULD be in the keychain:
   security find-generic-password -s com.novelstudio.app -a openrouterKey -w 2>/dev/null | head -c 6; echo "…"
   ```
3. Expect: the real `sk-…` value is in the keychain, not in localStorage. Generation
   still works (key hydrated from keychain on startup).
   *(Unsigned dev builds may show a one-time keychain access prompt — allow it.)*

## 3. Remote security posture (phone can't see the key, fs confined, no SSRF)
1. In the app, enable **Away mode / Remote access**; note the URL + token.
2. Run the automated probe from another machine (or the same one):
   ```bash
   BASE_URL="http://192.168.x.x:8787" TOKEN="<token>" ./scripts/verify-remote.sh
   ```
3. Expect all checks PASS: unauthenticated rejected, **API key not exposed**,
   pairing token not leaked, `fs_read` of `/etc/passwd` and `~/.ssh` blocked, and
   `web_fetch` of the metadata IP / localhost blocked.

## 4. Two-device sync integrity (no lost manuscripts)
1. Open the app on the desktop and the same URL on your phone.
2. On the **desktop**, edit document A. On the **phone**, edit a *different*
   document B (or create a new one). Let both autosave (~1s).
3. Tap **Sync** on each device.
4. Expect: **both** edits survive on both devices — neither clobbers the other.
5. Delete a document on one device, Sync the other → it stays deleted (not
   resurrected). Recovery snapshots accumulate in `~/.ai-studio/backups/`.
