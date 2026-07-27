#!/usr/bin/env bash
# Cut a release: build a signed + notarized universal .dmg locally, generate the
# updater manifest, and publish everything to GitHub Releases.
#
# GitHub Releases is the origin on purpose. Bandwidth is free (a universal .dmg
# is ~40 MB, which gets expensive fast on S3), it is CDN-backed and resumable,
# and the API reports exact per-asset download counts — so the download counter
# on gw-intech.com needs no tracking infrastructure of its own. Your site owns
# the pitch and the link; GitHub just serves the bytes.
#
# Usage:
#   ./scripts/release.sh 0.2.0            # build + upload as a DRAFT release
#   ./scripts/release.sh 0.2.0 --publish  # ...and publish it immediately
#
# One-time setup: docs/SIGNING.md (Apple certificate) and docs/UPDATES.md
# (updater keypair). Required environment:
#   APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
#   TAURI_SIGNING_PRIVATE_KEY (contents of ~/.tauri/aibox-updater.key)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD (empty if the key has no password)

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
PUBLISH="${2:-}"
REPO="GeroWalther/ai-box"
OUT="dist-release"

if [[ -z "$VERSION" ]]; then
  echo "usage: ./scripts/release.sh <version> [--publish]" >&2
  echo "   e.g. ./scripts/release.sh 0.2.0" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "version must look like 1.2.3 (got '$VERSION')" >&2
  exit 1
fi

# Fail early on missing credentials rather than 15 minutes into a build.
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY (see docs/SIGNING.md)}"
: "${APPLE_ID:?set APPLE_ID}"
: "${APPLE_PASSWORD:?set APPLE_PASSWORD (an app-specific password)}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"
: "${TAURI_SIGNING_PRIVATE_KEY:?set TAURI_SIGNING_PRIVATE_KEY (see docs/UPDATES.md) — without it the build produces no updater signature and existing installs can never update}"
command -v gh >/dev/null || { echo "GitHub CLI (gh) is required: brew install gh" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run 'gh auth login' first" >&2; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash before releasing." >&2
  exit 1
fi

echo "==> Setting version $VERSION"
node -e "
const fs=require('fs');
for (const f of ['package.json','src-tauri/tauri.conf.json']) {
  const j=JSON.parse(fs.readFileSync(f,'utf8'));
  j.version='$VERSION';
  fs.writeFileSync(f, JSON.stringify(j,null,2)+'\n');
}
"
# Cargo.toml keeps its own copy of the version.
sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml

echo "==> Building, signing & notarizing (several minutes)"
npm run tauri build -- --target universal-apple-darwin

BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle"
DMG=$(find "$BUNDLE/dmg" -name "*.dmg" -maxdepth 1 | head -1)
TARBALL=$(find "$BUNDLE/macos" -name "*.app.tar.gz" -maxdepth 1 | head -1)
SIG=$(find "$BUNDLE/macos" -name "*.app.tar.gz.sig" -maxdepth 1 | head -1)

[[ -f "$DMG" ]] || { echo "no .dmg produced in $BUNDLE/dmg" >&2; exit 1; }
[[ -f "$TARBALL" && -f "$SIG" ]] || {
  echo "no updater artifact produced — check createUpdaterArtifacts in tauri.conf.json" >&2
  exit 1
}

# GitHub rewrites spaces in asset names to dots, which would break the URLs
# baked into latest.json. Give everything explicit, stable, space-free names.
rm -rf "$OUT" && mkdir -p "$OUT"
DMG_NAME="AI-Box_${VERSION}_universal.dmg"
TAR_NAME="AI-Box_${VERSION}_universal.app.tar.gz"
cp "$DMG" "$OUT/$DMG_NAME"
cp "$TARBALL" "$OUT/$TAR_NAME"

echo "==> Writing latest.json"
BASE="https://github.com/$REPO/releases/download/v$VERSION"
SIGNATURE=$(cat "$SIG")
NOTES="See the release page for what changed."
# One universal binary serves both architectures, so every darwin key points at
# the same artifact — the updater looks itself up by arch and must find an entry.
node -e "
const fs=require('fs');
const entry={signature:process.env.SIGNATURE,url:'$BASE/$TAR_NAME'};
fs.writeFileSync('$OUT/latest.json', JSON.stringify({
  version:'$VERSION',
  notes:process.env.NOTES,
  pub_date:new Date().toISOString(),
  platforms:{'darwin-universal':entry,'darwin-aarch64':entry,'darwin-x86_64':entry},
},null,2)+'\n');
" SIGNATURE="$SIGNATURE" NOTES="$NOTES"

echo "==> Verifying signature & notarization"
./scripts/verify-signing.sh "$(find "$BUNDLE/macos" -maxdepth 1 -name '*.app' | head -1)" || {
  echo "signing verification failed — not uploading" >&2
  exit 1
}

echo "==> Committing the version bump and tagging"
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
# The version may already have been bumped by hand, leaving nothing to commit —
# which would abort the whole release under `set -e`. Only commit if it changed.
if git diff --cached --quiet; then
  echo "    (version already committed — nothing to bump)"
else
  git commit -m "Release v$VERSION"
fi
git tag "v$VERSION"
git push origin HEAD --tags

echo "==> Creating the GitHub release"
DRAFT_FLAG="--draft"
[[ "$PUBLISH" == "--publish" ]] && DRAFT_FLAG=""
gh release create "v$VERSION" \
  "$OUT/$DMG_NAME" "$OUT/$TAR_NAME" "$OUT/latest.json" \
  --repo "$REPO" \
  --title "AI Box $VERSION" \
  --generate-notes \
  $DRAFT_FLAG

echo
echo "Done."
echo "  Download:  https://github.com/$REPO/releases/latest"
echo "  Updater:   $BASE/latest.json"
if [[ -n "$DRAFT_FLAG" ]]; then
  echo
  echo "This is a DRAFT. Existing installs will NOT see the update, and the"
  echo "'latest' download link will not move, until you publish it:"
  echo "  gh release edit v$VERSION --draft=false --repo $REPO"
fi
