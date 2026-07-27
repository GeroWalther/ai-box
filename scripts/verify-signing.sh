#!/usr/bin/env bash
# Verify the built .app is signed with a hardened runtime and notarized/accepted
# by Gatekeeper. Run after a signed build. Exits non-zero if checks fail.
set -euo pipefail
cd "$(dirname "$0")/.."

# Which app to check. Pass a path explicitly, or we look for a universal build
# first and fall back to the plain release bundle.
#
# The explicit argument matters: a leftover ad-hoc-signed app from a local
# `tauri build` sits in target/release/bundle, and this script used to find that
# one and fail a perfectly good universal release with "TeamIdentifier=not set".
# Checking the wrong artifact is worse than not checking — it reports on
# something you are not shipping.
APP="${1:-}"
if [ -z "$APP" ]; then
  for dir in \
    src-tauri/target/universal-apple-darwin/release/bundle/macos \
    src-tauri/target/release/bundle/macos; do
    APP=$(find "$dir" -maxdepth 1 -name "*.app" 2>/dev/null | head -1)
    [ -n "$APP" ] && break
  done
fi
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
# Capture first, then match. Piping into `grep -q` under `set -o pipefail` is a
# trap: grep exits on the first match, codesign takes SIGPIPE, and the pipeline
# reports failure — so a correctly hardened app fails the check. Read the
# authoritative CodeDirectory flags rather than fuzzy-matching the whole output.
CS_INFO=$(codesign -d --verbose=4 "$APP" 2>&1 || true)
if printf '%s' "$CS_INFO" | grep -E "CodeDirectory .*flags=.*runtime" >/dev/null; then
  echo "hardened runtime: OK"
else
  echo "hardened runtime: MISSING" >&2
  exit 1
fi

echo "== Developer ID identity =="
if printf '%s' "$CS_INFO" | grep "Authority=Developer ID Application" >/dev/null; then
  echo "signed with a Developer ID: OK"
else
  echo "NOT signed with a Developer ID (ad-hoc or development signature)" >&2
  exit 1
fi

echo "All signing checks passed."
