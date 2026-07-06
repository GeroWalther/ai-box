// App settings: shape, defaults, persistence, and provider resolution.

export type Provider = "openrouter" | "ollama" | "custom";

export interface Settings {
  provider: Provider;

  // Appearance
  theme: "light" | "dark";

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
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "openrouter",

  theme: "light",

  openrouterKey: "",
  openrouterModel: "deepseek/deepseek-chat",

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
};

const STORAGE_KEY = "novel-studio.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    // Merge so new fields added in updates get their defaults.
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
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
