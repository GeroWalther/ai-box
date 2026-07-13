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

Two ways — both need the four env vars/secrets below.

### Locally (one command)
```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # the app-specific password
export APPLE_TEAM_ID="TEAMID"

./scripts/build-signed.sh        # builds, signs, notarizes, then verifies
# → src-tauri/target/release/bundle/dmg/*.dmg  (signed, stapled)
```
Verify an existing build anytime with `./scripts/verify-signing.sh`.

### In CI (on a version tag)
`.github/workflows/release.yml` builds, signs, notarizes, and drafts a GitHub
Release when you push a tag (`git tag v0.2.0 && git push --tags`). Add these repo
**Actions secrets** (Settings → Secrets and variables → Actions):

| Secret | What |
|---|---|
| `APPLE_CERTIFICATE` | base64 of your exported Developer ID `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | your Team ID |

Without the secrets the workflow still builds, but the artifact is unsigned.

## Decisions still open (see docs/PRODUCTION.md, Phase 1)
- **Bundle identifier** is now `com.novelstudio.app` (was a personal-machine name).
  Change it to a domain you control before first public release — it's the app's
  permanent identity.
- **Product name / trademark**: the UI says "AI Studio" (collides with Google AI
  Studio); the repo/README say "Novel Studio". Pick one before shipping.
