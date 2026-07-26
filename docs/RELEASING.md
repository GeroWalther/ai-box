# Releasing

One command builds a signed, notarized universal `.dmg`, generates the updater
manifest, and publishes it:

```bash
./scripts/release.sh 0.2.0             # uploads as a draft
./scripts/release.sh 0.2.0 --publish   # goes live immediately
```

It bumps the version in `package.json`, `tauri.conf.json` and `Cargo.toml`,
builds, verifies the signature, commits, tags, and creates the GitHub release
with three assets: the `.dmg`, the updater `.app.tar.gz`, and `latest.json`.

## Why GitHub Releases rather than S3

- **Bandwidth is free.** A universal `.dmg` is ~40 MB. A thousand downloads is
  40 GB — free here, billable on S3.
- **Download counts come for free.** The API reports per-asset totals, so the
  counter on your own site needs no tracking infrastructure (see below).
- **It's CDN-backed and resumable**, and the signed-updater flow works unchanged.

Your site still owns the funnel: the pitch, the screenshots, the feedback link.
GitHub only serves the bytes.

## One-time setup

| What | Where | Doc |
|---|---|---|
| Apple Developer ID certificate | login keychain | [SIGNING.md](SIGNING.md) |
| App-specific password | Apple ID account | [SIGNING.md](SIGNING.md) |
| Updater keypair | `~/.tauri/aibox-updater.key` | [UPDATES.md](UPDATES.md) |

Environment the script requires:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="TEAMID"
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/aibox-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

Put those in a file you don't commit (e.g. `~/.config/ai-box-release.env`)
and `source` it before releasing.

> **Back up the updater private key.** Lose it and you can never ship an update
> that existing installs will accept — every user would have to download the app
> again manually.

## The download page on gw-intech.com

Point the button at the stable "latest" URL, which never changes:

```
https://github.com/GeroWalther/ai-box/releases/latest/download/AI-Box_0.2.0_universal.dmg
```

Since the filename carries the version, resolve it at page load instead of
hard-coding it — the same call gives you the download count:

```js
const res = await fetch("https://api.github.com/repos/GeroWalther/ai-box/releases/latest");
const release = await res.json();
const dmg = release.assets.find((a) => a.name.endsWith(".dmg"));

dmg.browser_download_url;  // the download link
dmg.download_count;        // downloads of this release
release.tag_name;          // e.g. "v0.2.0"
```

For an all-time total, sum `download_count` across every release from
`/releases`. Unauthenticated requests are limited to 60/hour per IP, so cache
the result server-side (or in `localStorage`) rather than calling it on every
page view.

## Checklist before publishing

- [ ] `npm run typecheck` and `cargo test` (in `src-tauri/`) both pass
- [ ] The app launches from the built `.dmg`, not just `tauri dev`
- [ ] Pair a phone once against the release build (the token flow differs from dev)
- [ ] Install the *previous* version and confirm it self-updates to this one —
      this is the only way to catch a broken updater signature before users do
- [ ] Release notes mention anything that changes stored data

## GitHub Actions

`.github/workflows/release.yml` still builds on a `v*` tag if you'd rather have
CI do it. It needs the same values as repository secrets. The local script exists
because it's faster, it notarizes with credentials that never leave your machine,
and it fails in front of you instead of in a log.
