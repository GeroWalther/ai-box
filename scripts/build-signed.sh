#!/usr/bin/env bash
# Build a signed + notarized macOS .dmg locally.
#
# Prereqs (one-time): an Apple Developer account, a "Developer ID Application"
# certificate installed in your login keychain, and an app-specific password.
# See docs/SIGNING.md. Set these env vars, then run this script:
#
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
#   export APPLE_ID="you@example.com"
#   export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific password
#   export APPLE_TEAM_ID="TEAMID"
#   ./scripts/build-signed.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY (see docs/SIGNING.md)}"
: "${APPLE_ID:?set APPLE_ID}"
: "${APPLE_PASSWORD:?set APPLE_PASSWORD (app-specific password)}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"

echo "==> Installing dependencies"
npm ci

echo "==> Building, signing & notarizing (this can take several minutes)"
npm run tauri build

echo "==> Verifying"
./scripts/verify-signing.sh
echo "==> Done. DMG is in src-tauri/target/release/bundle/dmg/"
