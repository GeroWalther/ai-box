# In-app auto-updates

The app checks GitHub Releases on launch and installs newer **signed** builds in the
background (a toast says "restart to apply"). See `src/lib/updater.ts` and the
`tauri-plugin-updater` config in `src-tauri/tauri.conf.json`.

## How it works
1. On desktop launch, the app fetches the updater manifest:
   `https://github.com/GeroWalther/ai-studio/releases/latest/download/latest.json`
2. If it advertises a newer version, the app downloads the `.app.tar.gz`, **verifies
   its signature against the public key** baked into `tauri.conf.json`, installs it,
   and toasts. It applies on next restart.
3. Only builds signed with the matching **private** key are accepted — a hijacked
   release can't push a malicious update.

## The updater keypair (already generated)
- **Public key** is in `tauri.conf.json` → `plugins.updater.pubkey`.
- **Private key** is at `~/.tauri/aistudio-updater.key` (password: *empty*).
  **Keep it secret and back it up** — if lost, you can't publish updates that existing
  installs will accept (users would have to re-download manually).

To use it in CI, add two **Actions secrets** (Settings → Secrets and variables →
Actions):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the full contents of `~/.tauri/aistudio-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty (the key has no password) |

```bash
# copy the private key to your clipboard for the GitHub secret:
cat ~/.tauri/aistudio-updater.key | pbcopy
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

## Heads-up: product name
The UI/landing page say **"AI Studio"**, which collides with Google's "AI Studio", and
the repo is `ai-studio`. Pick a final, ownable name before a public launch (it also
sets the bundle identifier, currently `com.gwintech.aistudio`). See `docs/SIGNING.md`.
