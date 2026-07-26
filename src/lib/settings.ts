// App settings: shape, defaults, persistence, and provider resolution.
import { invokeCmd, isTauri } from "./transport";
import { readWithLegacy, writeJson } from "./storage";
import { logError } from "./log";
import type { WritingMode } from "./writingActions";

export type Provider = "openrouter" | "ollama" | "custom";

export interface Settings {
  provider: Provider;

  // Appearance
  theme: "light" | "dark";

  // First-run onboarding shown until dismissed/completed.
  onboarded: boolean;

  // Left sidebar (chats / documents / image history) collapsed — shared across tabs.
  sidebarCollapsed: boolean;

  // OpenRouter (BYOK)
  openrouterKey: string;
  openrouterModel: string;

  // Local Ollama
  ollamaUrl: string;
  ollamaModel: string;

  // Any other OpenAI-compatible endpoint (LM Studio, a proxy, ...)
  customUrl: string;
  customKey: string;
  customModel: string;

  // Generation controls
  temperature: number;
  maxTokens: number;
  wordTarget: number;
  systemPrompt: string;
  authorsNote: string;
  language: string; // "auto" | "Japanese" | "English" | ...
  /** What kind of writing this is. Picks the selection actions AND the editorial
   *  persona used for rewrites — an email should not be edited by a novelist. */
  writingMode: WritingMode;
  writingPreset: string; // format preset id (Novel, Short Story, …), or "" for freeform
  writingGenre: string; // genre/tone preset id (Romance, Horror, …), or "" — combines with the format

  // Image generation
  imageBackend: "comfyui" | "openrouter" | "a1111";
  imageNegative: string;
  imageSteps: number;
  imageWidth: number;
  imageHeight: number;
  imageCfg: number;

  // Automatic1111 / Forge
  imageUrl: string;
  imageSampler: string;

  // ComfyUI
  comfyUrl: string;
  comfyCheckpoint: string;
  comfySampler: string;
  comfyScheduler: string;

  // OpenRouter cloud images
  openrouterImageModel: string;
  imageResolution: string; // "512" | "1K" | "2K" | "4K"
  imageAspect: string; // "1:1" | "16:9" | "9:16" | "3:4" | "4:3"

  // Phone / remote access (companion server). The token pairs a device; the
  // wake-lock keeps the Mac awake while "Away mode" is on.
  remotePort: number;
  remoteToken: string;
  remoteWakeLock: boolean;
  /** "Away mode" on: auto-start the companion server on launch so the phone can
   *  reach the Mac without toggling it each time. */
  remoteEnabled: boolean;

  // Write tab experience
  /** Hide every panel but the page while writing (⌘⇧F). */
  focusMode: boolean;
  /** Keep the caret vertically centred as you type. */
  typewriterMode: boolean;
  /** Daily/session word target shown in the footer; 0 disables it. */
  wordGoal: number;

  // Agentic Chat: start new chats in Agent mode (can run tools) by default.
  agentMode: boolean;
  /** Directory the agent's file tools are confined to, on the desktop AND for a
   *  paired phone. "~" means the whole home folder. Paths outside it are refused
   *  by the Rust guard, not merely hidden in the UI. */
  agentWorkspace: string;
  /** Opt out of the protected-path denylist (~/.ssh, shell rc files, keychains,
   *  LaunchAgents…). Off by default, and deliberately independent of
   *  autoApproveTools: turning off prompts must never turn off this protection. */
  allowProtectedPaths: boolean;
  // Auto-approve the agent's file writes / commands without prompting. Off by
  // default — a deliberate away-mode escape hatch (skips the "approve on the Mac"
  // safety gate for both the desktop agent and remote/phone requests).
  autoApproveTools: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "openrouter",

  theme: "light",

  onboarded: false,
  sidebarCollapsed: false,

  openrouterKey: "",
  openrouterModel: "anthropic/claude-fable-5",

  ollamaUrl: "http://localhost:11434/v1",
  ollamaModel: "",

  customUrl: "http://localhost:1234/v1",
  customKey: "",
  customModel: "",

  temperature: 0.9,
  maxTokens: 700,
  wordTarget: 220,
  systemPrompt: "",
  authorsNote: "",
  language: "auto",
  writingMode: "fiction",
  writingPreset: "",
  writingGenre: "",

  imageBackend: "comfyui",
  imageNegative:
    "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, watermark",
  imageSteps: 28,
  imageWidth: 768,
  imageHeight: 1024,
  imageCfg: 6,

  imageUrl: "http://localhost:7860",
  imageSampler: "DPM++ 2M Karras",

  comfyUrl: "http://127.0.0.1:8188",
  comfyCheckpoint: "",
  comfySampler: "dpmpp_2m",
  comfyScheduler: "karras",

  openrouterImageModel: "black-forest-labs/flux-1.1-pro",
  imageResolution: "1K",
  imageAspect: "3:4",

  remotePort: 8787,
  remoteToken: "",
  remoteWakeLock: true,
  remoteEnabled: true,

  focusMode: false,
  typewriterMode: false,
  wordGoal: 0,

  agentMode: true,
  agentWorkspace: "~",
  allowProtectedPaths: false,
  autoApproveTools: false,
};

const STORAGE_KEY = "ai-studio.settings";
/** Pre-rename key, read once and migrated forward (see readWithLegacy). */
const LEGACY_STORAGE_KEY = "novel-studio.settings";

// API keys are secrets — kept in the OS keychain at rest (desktop) or injected by
// the Mac (phone), never written to localStorage.
const SECRET_FIELDS = ["openrouterKey", "customKey"] as const;

export function loadSettings(): Settings {
  try {
    const raw = readWithLegacy(STORAGE_KEY, LEGACY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    // Merge so new fields added in updates get their defaults.
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    // Safety net: never leave the app on the custom provider without a model,
    // which would make every send fail the "pick a model" guard.
    if (s.provider === "custom" && !s.customModel) s.provider = "openrouter";
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  // Never persist API keys to localStorage — strip them from the on-disk blob.
  const redacted = { ...s };
  for (const k of SECRET_FIELDS) redacted[k] = "";
  writeJson(STORAGE_KEY, redacted);
}

/** Load API keys from the OS keychain (desktop only; no-op on the phone). */
export async function loadSecrets(): Promise<Partial<Settings>> {
  if (!isTauri()) return {};
  const out: Partial<Settings> = {};
  for (const k of SECRET_FIELDS) {
    try {
      const v = await invokeCmd<string | null>("secret_get", { name: k });
      if (v) out[k] = v;
    } catch (e) {
      logError("keychain.read", e); // non-fatal: the user can re-enter the key
    }
  }
  return out;
}

/** Persist API keys to the OS keychain (desktop only; no-op on the phone). */
export async function saveSecrets(s: Settings): Promise<void> {
  if (!isTauri()) return;
  for (const k of SECRET_FIELDS) {
    try {
      await invokeCmd("secret_set", { name: k, value: s[k] ?? "" });
    } catch (e) {
      logError("keychain.write", e);
    }
  }
}

/** Resolve the active text provider into a concrete endpoint. */
export function resolveTextProvider(s: Settings): {
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  switch (s.provider) {
    case "openrouter":
      return {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: s.openrouterKey,
        model: s.openrouterModel,
      };
    case "ollama":
      return { baseUrl: s.ollamaUrl, apiKey: "", model: s.ollamaModel };
    case "custom":
      return { baseUrl: s.customUrl, apiKey: s.customKey, model: s.customModel };
  }
}
