# macOS code signing & notarization

Without this, a downloaded `.dmg` is blocked by Gatekeeper ("damaged / unidentified
developer"). The repo is now **scaffolded** for signing; the remaining steps need
your Apple credentials — they can't be committed.

## What's already in the repo
- `src-tauri/entitlements.plist` — hardened-runtime entitlements for the WKWebView
  app + network client/server.
- `src-tauri/tauri.conf.json` → `bundle.macOS.entitlements` + `minimumSystemVersion`.

## What you must provide (one-time)
1. **Apple Developer Program** membership ($99/yr).
2. A **Developer ID Application** certificate (Xcode → Settings → Accounts → Manage
   Certificates → +, or developer.apple.com). Install it in your login keychain.
3. An **app-specific password** for notarization (appleid.apple.com → Sign-In &
   Security → App-Specific Passwords), and your **Team ID** (membership details).

## Build a signed + notarized DMG
Tauri signs and notarizes automatically during `tauri build` when these env vars
are set:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # the app-specific password
export APPLE_TEAM_ID="TEAMID"

npm run tauri build
# → src-tauri/target/release/bundle/dmg/*.dmg  (signed, stapled)
```

Verify the result:
```bash
spctl -a -vvv "src-tauri/target/release/bundle/macos/AI Studio.app"   # should say: accepted, Notarized Developer ID
codesign -dv --verbose=4 "…/AI Studio.app"                            # runtime flag set
```

## Decisions still open (see docs/PRODUCTION.md, Phase 1)
- **Bundle identifier** is now `com.novelstudio.app` (was a personal-machine name).
  Change it to a domain you control before first public release — it's the app's
  permanent identity.
- **Product name / trademark**: the UI says "AI Studio" (collides with Google AI
  Studio); the repo/README say "Novel Studio". Pick one before shipping.
