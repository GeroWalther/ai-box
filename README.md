# AI Box

**Your Mac's AI workstation — and a remote control for it from your phone.**

A native macOS app that puts five things behind one window: an **agentic chat**
that can actually touch your machine, a **writing studio** for long-form prose and
everyday copy, **image generation** that runs on your own GPU, **video generation**
that boards and renders a whole ad, and a real **terminal**. Then it does the part nobody else does — it hands you all of that on
your phone, over your own network, with your Mac still holding the keys.

Built with **Tauri 2 + React + Rust**. Bring your own model: any OpenRouter model,
a fully local Ollama model, or any OpenAI-compatible endpoint.

![macOS](https://img.shields.io/badge/macOS-11%2B-black)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![React](https://img.shields.io/badge/React-19-61DAFB)

---

## What it does

### 🤖 Agentic Chat
A tool-calling agent with real capabilities: read, write, and edit files, search a
codebase, run shell commands, fetch pages. Every destructive action shows you a
**diff and asks first**. Models that don't support native tool calls (most local
ones) fall back to a ReAct text protocol, so an 8B model on your own hardware can
still use every tool.

### ✍️ Write
A prose editor with the AI in the margins rather than in your way:
- **Continue (⌘↵)** streams the next passage straight into the page at your cursor
- **Select any text** for one-click Proofread, Rephrase, Expand, Shorten — plus
  non-fiction modes for ad copy, professional email, and academic tone
- **Proofread shows a diff you accept or reject**, rather than silently rewriting you
- **Story Bible** keeps characters, world rules, and canon consistent across a book
- **Rolling summary memory** so chapter 40 still knows what happened in chapter 2
- **Version history** — drafts snapshotted on disk, previewable and restorable
- Focus mode, typewriter scrolling, find & replace, word-count goals
- Export to `.txt`, `.md`, `.html`, `.docx`

### 🎨 Images
Generate on your own GPU via a **managed ComfyUI** the app installs and runs for
you (no Python setup), or Automatic1111/Forge, or cloud models through OpenRouter.
Local generation never leaves the machine. Illustrate a scene straight from the
manuscript — the prompt is composed from your prose *and* your Story Bible, so
recurring characters stay visually consistent.

### 🎬 Video
Make a finished spot, not a novelty clip. Pick any video model OpenRouter carries
— Kling v3, Veo 3.1, Seedance 2.5, Sora 2 Pro, Wan, Hailuo, Runway — from a
**live catalog**, never a hardcoded list, so a model released tomorrow shows up
today. Every control is built from what that model actually accepts: its
durations, resolutions, aspect ratios, first/last-frame slots, audio and seed
support, so an invalid request can't be assembled.

- **Ad brief → shot language.** Say what the product is, who it's for and the
  tone; your text model writes the prompt in the terms video models respond to —
  shot size, lens, camera move, light, palette.
- **Storyboard mode** boards a spot as *N* continuous shots that hold one look,
  queues each as its own render, and **joins the finished shots into one MP4**
  (needs `ffmpeg`).
- **Renders are jobs, not requests.** Quit mid-render and the job is picked back
  up next launch — a paid render is never lost with the window that started it.
- Clips are stored on the Mac, so the library is the same on your phone.

### 💻 Terminal
A real PTY. `vim`, `top`, `claude`, whatever you like — including from your phone.

### 📱 Remote access — the interesting part
Your Mac runs a small companion server; your phone loads the same UI over your LAN
or Tailscale and drives the machine. The engineering that makes it safe:

- **The API key never leaves the Mac.** The phone receives a sentinel value so its
  UI knows a key exists; the Mac injects the real one server-side.
- **Filesystem access is jailed** to a workspace root you choose, with symlink
  escapes and `..` traversal rejected.
- **Sensitive paths are hard-blocked** — `~/.ssh`, `~/.aws`, keychains, shell rc
  files, LaunchAgents — even when you've turned approvals off.
- **Dangerous actions prompt on the Mac,** not on the phone: the remote can
  *request* a file write, but a human at the desktop sees the diff and approves.
  (Working away from your desk? One toggle turns that into auto-approve.)
- **Conflict-free sync.** Documents and chats merge item-by-item with tombstones,
  so editing the same doc on both devices never loses either side's work.

---

## Install

Download the signed `.dmg` from
[Releases](https://github.com/GeroWalther/ai-box/releases/latest).
Universal binary — Apple Silicon and Intel. The app updates itself from then on.

## Run it from source

```bash
npm install
npm run tauri dev
```

## Build a distributable

```bash
npm run release        # signed, notarized .dmg + updater manifest
```

See [docs/RELEASING.md](docs/RELEASING.md).

---

## Setup

1. **Settings → OpenRouter:** paste your key (`sk-or-…`) and pick a model. Or
   switch the provider to *Local (Ollama)* or any OpenAI-compatible endpoint.
2. **Images:** the Images tab offers to install a managed ComfyUI on first use —
   one click, no Python knowledge needed.
3. **Phone:** Settings → Remote access → scan the QR code. Install Tailscale on
   both devices if you want it to work outside your home network.

| Provider | Base URL | Notes |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | BYOK; the widest model selection |
| Ollama | `http://localhost:11434/v1` | Fully local; "Detect models" in Settings |
| Custom | any | LM Studio, a proxy, any OpenAI-compatible API |

---

## Architecture

```
src/                     React UI (identical on desktop and phone)
  lib/transport.ts       ← the keystone: Tauri IPC or HTTP+WebSocket,
                           chosen at runtime, so no feature is written twice
  hooks/                 documents, device sync, shortcuts
src-tauri/src/
  lib.rs                 Tauri commands: providers, filesystem, images, secrets
  server.rs              companion server — auth, path confinement, approvals
  guard.rs               shared path confinement + protected-path denylist
  pty.rs                 interactive terminal sessions
  comfy.rs               managed ComfyUI runtime
```

The design constraint that shapes everything: **the Mac is the source of truth and
the only holder of secrets; the phone is a view onto it.** Every capability is
written once, against `transport.ts`, and works in both places.

## Security posture

- API keys in the macOS Keychain, never in localStorage, never sent to a paired device
- Bearer-token auth on every remote call, compared in constant time, fails closed
- Path confinement plus a protected-path denylist that approval settings cannot override
- SSRF guards on URL fetching (private ranges blocked)
- Approval prompts with diffs for writes, moves, deletes, and shell commands
- Signed and notarized releases; updates verified against a minisign public key

Bind it to your LAN or a Tailscale network. Never port-forward it to the internet.

## License

A personal project by [Gero Walther](https://gw-intech.com). Bring your own API
keys — the app never hosts content or pays for inference.
