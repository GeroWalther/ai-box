# In-app auto-updates

The app checks GitHub Releases on launch and installs newer **signed** builds in the
background (a toast says "restart to apply"). See `src/lib/updater.ts` and the
`tauri-plugin-updater` config in `src-tauri/tauri.conf.json`.

## How it works
1. On desktop launch, the app fetches the updater manifest:
   `https://github.com/GeroWalther/ai-box/releases/latest/download/latest.json`
2. If it advertises a newer version, the app downloads the `.app.tar.gz`, **verifies
   its signature against the public key** baked into `tauri.conf.json`, installs it,
   and toasts. It applies on next restart.
3. Only builds signed with the matching **private** key are accepted — a hijacked
   release can't push a malicious update.

## The updater keypair (already generated)
- **Public key** is in `tauri.conf.json` → `plugins.updater.pubkey`.
- **Private key** is at `~/.tauri/aibox-updater.key` (password: *empty*).
  **Keep it secret and back it up** — if lost, you can't publish updates that existing
  installs will accept (users would have to re-download manually).

To use it in CI, add two **Actions secrets** (Settings → Secrets and variables →
Actions):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the full contents of `~/.tauri/aibox-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty (the key has no password) |

```bash
# copy the private key to your clipboard for the GitHub secret:
cat ~/.tauri/aibox-updater.key | pbcopy
```

## Cutting a release (auto-signed + auto-updatable)
Once the Apple secrets (see `docs/SIGNING.md`) **and** the two updater secrets above
are set in the repo:

```bash
# bump version in src-tauri/tauri.conf.json + package.json, then:
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` then, on a Mac runner:
- builds a **universal** binary (Apple Silicon + Intel),
- signs + notarizes the `.dmg`,
- generates the updater artifacts + `latest.json` (signed with the private key),
- drafts a GitHub Release with the `.dmg` and `latest.json` attached.

**Publish the draft release** for the update to go live (the updater endpoint points
at `releases/latest`, which only counts published releases). New users download the
`.dmg`; existing users get the update automatically on next launch.

## Naming
Everything is now consistently **AI Box**: the product, the repo, the crate, and
the bundle identifier `com.gwintech.aibox`.

One thing to keep in mind before charging money for it: "AI Box" is also the name
of a Google product, so it is a weak trademark and hard to own or defend. That does
not matter for a free portfolio release, and it is fixable later — but a rename after
launch costs more than one now, because the bundle identifier is the app's permanent
identity and changing it makes macOS treat the app as brand new. If a paid tier ever
becomes the plan, revisit the name at the same time.
