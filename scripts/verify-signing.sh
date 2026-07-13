#!/usr/bin/env bash
# Verify the built .app is signed with a hardened runtime and notarized/accepted
# by Gatekeeper. Run after a signed build. Exits non-zero if checks fail.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=$(find src-tauri/target/release/bundle/macos -maxdepth 1 -name "*.app" | head -1)
if [ -z "${APP:-}" ]; then
  echo "No .app found — build first (npm run tauri build)." >&2
  exit 1
fi
echo "App: $APP"

echo "== codesign =="
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Authority|Runtime|Identifier" || true
codesign --verify --deep --strict --verbose=2 "$APP"

echo "== Gatekeeper (spctl) =="
# 'accepted' + 'Notarized Developer ID' means a downloaded copy won't be blocked.
spctl -a -vvv "$APP"

echo "== hardened runtime flag =="
codesign -d --verbose=2 "$APP" 2>&1 | grep -q "runtime" \
  && echo "hardened runtime: OK" \
  || { echo "hardened runtime: MISSING" >&2; exit 1; }

echo "All signing checks passed."
