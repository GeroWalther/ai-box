# Novel Studio

A private, desktop AI **novel-writing studio**. Write and edit freely in a real
prose editor; press **Continue (⌘↵)** to have an AI continue the passage,
streaming into the page at your cursor. Bring your own model — any OpenRouter
model, a fully local Ollama model, or any OpenAI-compatible endpoint — and
optionally illustrate scenes with a local Stable Diffusion server.

Built with **Tauri 2 + React + TipTap** (Rust backend, tiny native app).

## Why this design
- **Text → API or local.** Frontier-quality multilingual prose (e.g. Japanese)
  really needs big models, so text runs through a provider *you* choose. Your
  API key is stored locally and only ever sent to the provider you pick.
- **Images → 100% local.** Explicit/creative images are generated on your own
  machine via Automatic1111 / Forge — nothing is uploaded.
- **BYOK.** The app is a tool; it never hosts content or pays for inference.

## Run it (development)
```bash
npm install
npm run tauri dev
```

## Build a distributable .app / .dmg
```bash
npm run tauri build
# output in src-tauri/target/release/bundle/
```

## Using it
1. **Settings ⚙ → OpenRouter:** paste your key (`sk-or-…`) and pick a model
   (e.g. `deepseek/deepseek-chat`). Or switch the sidebar **Provider** to
   *Local (Ollama)* / *Custom*.
2. Set **Language** (e.g. Japanese), **Length**, and **Creativity** in the sidebar.
3. Type an opening line (or nothing) and press **⌘↵** — the AI continues,
   streaming into the page. Edit anywhere, anytime; press **⌘↵** again to keep going.
4. **Author's note** steers just the next passage (POV, mood, setting).

### Images (optional)
Run Automatic1111 or Forge with the API enabled:
```bash
./webui.sh --api        # A1111/Forge; serves http://localhost:7860
```
Then click **🎨 Images**, describe the scene, and Generate. Point the base URL
at your server in Settings if it differs.

## Providers
| Provider | Base URL | Notes |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | BYOK; best for Japanese (DeepSeek V4, Qwen3) |
| Ollama | `http://localhost:11434/v1` | Fully local text; "Detect models" in Settings |
| Custom | any | LM Studio, a proxy, etc. (OpenAI-compatible) |

## Roadmap ideas
- Streaming cancel that aborts the request server-side
- Real paragraph nodes during streaming (currently `<br>` line breaks)
- Save/load documents to disk (dialog + fs plugin)
- License-key activation (Lemon Squeezy) for a paid tier
- ComfyUI image backend option
