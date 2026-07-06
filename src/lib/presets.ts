// Curated suggestions and the prompt assembly for novel continuation.
import type { Settings } from "./settings";

// Editable suggestions — OpenRouter model IDs churn, so these populate a
// datalist but the field stays free-text. Good picks for creative / permissive
// long-form fiction as of 2026.
export const OPENROUTER_MODEL_SUGGESTIONS = [
  "deepseek/deepseek-chat",
  "deepseek/deepseek-r1",
  "qwen/qwen-2.5-72b-instruct",
  "neversleep/llama-3-lumimaid-70b",
  "nothingiisreal/mn-celeste-12b",
  "sao10k/l3.1-euryale-70b",
  "cognitivecomputations/dolphin-mixtral-8x22b",
  "anthropic/claude-sonnet-4",
];

// Curated local models that fit comfortably in 24 GB unified memory (Q4).
export interface LocalModel {
  id: string;
  label: string;
  size: string;
  purpose: string;
}
export const LOCAL_MODEL_SUGGESTIONS: LocalModel[] = [
  { id: "qwen2.5:7b", label: "Qwen 2.5 7B", size: "~4.7 GB", purpose: "General + multilingual" },
  { id: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B", size: "~4.7 GB", purpose: "Code" },
  { id: "llama3.1:8b", label: "Llama 3.1 8B", size: "~4.9 GB", purpose: "General chat" },
  { id: "deepseek-r1:8b", label: "DeepSeek-R1 8B", size: "~5.2 GB", purpose: "Reasoning (shows thinking)" },
  { id: "qwen2.5:14b", label: "Qwen 2.5 14B", size: "~9 GB", purpose: "Stronger general" },
  { id: "qwen2.5-coder:14b", label: "Qwen 2.5 Coder 14B", size: "~9 GB", purpose: "Stronger code" },
  { id: "deepseek-r1:14b", label: "DeepSeek-R1 14B", size: "~9 GB", purpose: "Stronger reasoning" },
  { id: "qwen2.5:32b", label: "Qwen 2.5 32B", size: "~20 GB", purpose: "Best local — tight, no image gen alongside" },
];

// Strong OpenRouter picks for chat / code / reasoning (best performance).
export const OPENROUTER_CHAT_SUGGESTIONS = [
  "anthropic/claude-sonnet-4",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-r1",
  "qwen/qwen-2.5-coder-32b-instruct",
  "google/gemini-2.5-pro",
];

// Recommend the biggest models that fit the detected unified memory.
export function recommendForRam(ramGb: number): {
  text: string;
  textId: string;
  image: string;
} {
  const usable = ramGb - 6; // leave room for macOS + apps
  let text: string, textId: string;
  if (usable >= 19) {
    text = "Qwen 2.5 32B (best local — tight)";
    textId = "qwen2.5:32b";
  } else if (usable >= 11) {
    text = "14B models (Qwen 14B / Coder 14B / R1 14B)";
    textId = "qwen2.5:14b";
  } else if (usable >= 6) {
    text = "7–8B models (Qwen 7B, Llama 3.1 8B)";
    textId = "qwen2.5:7b";
  } else {
    text = "3–4B models";
    textId = "qwen2.5:3b";
  }
  let image: string;
  if (ramGb >= 16) image = "SDXL (Illustrious / Pony) + quantized Flux";
  else if (ramGb >= 12) image = "SDXL checkpoints";
  else if (ramGb >= 8) image = "SD 1.5 checkpoints";
  else image = "small SD 1.5";
  return { text, textId, image };
}

export const LANGUAGES = [
  "auto",
  "Japanese",
  "English",
  "German",
  "French",
  "Spanish",
  "Chinese",
  "Korean",
];

export const SAMPLERS = [
  "DPM++ 2M Karras",
  "DPM++ SDE Karras",
  "Euler a",
  "Euler",
  "DDIM",
  "UniPC",
];

// ComfyUI uses separate sampler + scheduler ids.
export const COMFY_SAMPLERS = [
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_sde",
  "euler",
  "euler_ancestral",
  "ddim",
  "uni_pc",
];

export const COMFY_SCHEDULERS = ["karras", "normal", "exponential", "sgm_uniform", "simple"];

// OpenRouter cloud image models (editable — IDs may change).
export const OPENROUTER_IMAGE_MODELS = [
  "black-forest-labs/flux-1.1-pro",
  "black-forest-labs/flux-1.1-pro-ultra",
  "black-forest-labs/flux-1-dev",
  "black-forest-labs/flux-schnell",
  "black-forest-labs/flux-kontext-pro",
  "bytedance-seed/seedream-4.5",
  "bytedance-seed/seedream-3.0",
  "google/gemini-2.5-flash-image",
  "google/imagen-4",
  "openai/gpt-image-1",
  "recraft-ai/recraft-v3",
  "stability-ai/stable-diffusion-3.5-large",
  "xai/grok-2-image",
];
export const IMAGE_RESOLUTIONS = ["512", "1K", "2K", "4K"];
export const IMAGE_ASPECTS = ["1:1", "3:4", "4:3", "9:16", "16:9"];

// OpenRouter cloud models that accept an INPUT image (image editing / img2img).
// Text-to-image-only models (e.g. flux-1.1-pro) can't transform an upload.
export const OPENROUTER_IMAGE_EDIT_MODELS = [
  "google/gemini-2.5-flash-image",
  "google/gemini-2.5-flash-image-preview",
  "black-forest-labs/flux-kontext-pro",
  "black-forest-labs/flux-kontext-max",
  "openai/gpt-image-1",
];

// Recommended local checkpoints by style. Civitai needs your account token to
// download; paste the model version's download URL into the installer.
export interface ImageModelRec {
  name: string;
  style: string;
  base: string;
  nsfw: boolean;
  note: string;
}
export const IMAGE_MODEL_RECS: ImageModelRec[] = [
  {
    name: "Illustrious XL / NoobAI",
    style: "Anime · illustration",
    base: "SDXL",
    nsfw: true,
    note: "Best anime/ecchi + ukiyo-e. Search Civitai for 'Illustrious' or 'NoobAI'.",
  },
  {
    name: "Pony Diffusion XL",
    style: "Anime · versatile",
    base: "SDXL",
    nsfw: true,
    note: "Very flexible NSFW anime. Search Civitai 'Pony Diffusion XL'.",
  },
  {
    name: "WAI-NSFW-Illustrious",
    style: "Anime · NSFW",
    base: "SDXL",
    nsfw: true,
    note: "Popular explicit anime finetune. Search Civitai 'WAI NSFW'.",
  },
  {
    name: "Lustify SDXL",
    style: "Photoreal · NSFW",
    base: "SDXL",
    nsfw: true,
    note: "Realistic explicit. Search Civitai 'Lustify'.",
  },
  {
    name: "epiCRealism XL",
    style: "Photoreal",
    base: "SDXL",
    nsfw: false,
    note: "Clean photoreal. Search Civitai 'epiCRealism XL'.",
  },
];

// Keep only the trailing window so we stay within context and steer on recent voice.
const MAX_CONTEXT_CHARS = 8000;

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ContinueOpts {
  wordTarget: number;
  /** When set, the AI writes THIS beat next instead of free-continuing. */
  instruction?: string;
  /** When true, bring the scene to a complete, satisfying ending. */
  finish?: boolean;
}

/** Build the system+user messages for a continue / instruct / finish request. */
export function buildContinuationMessages(
  storyText: string,
  s: Settings,
  opts: ContinueOpts
): ChatMsg[] {
  const { wordTarget, instruction, finish } = opts;

  const langLine =
    s.language && s.language !== "auto"
      ? `Write in ${s.language}. Match the language's natural literary style and register.`
      : "Write in the same language as the text so far.";

  // The task line changes with the mode the author chose.
  let task: string;
  if (finish) {
    task = `Bring the scene to a satisfying, deliberate conclusion in roughly ${wordTarget} words. Resolve the emotional and narrative threads, land the intended twist if one is set up, and end on a final, complete sentence. Never stop mid-action or mid-sentence.`;
  } else if (instruction && instruction.trim()) {
    task = `Write what happens next according to this direction from the author, woven naturally into the prose and matching the established voice: "${instruction.trim()}". Write roughly ${wordTarget} words and finish on a complete sentence.`;
  } else {
    task = `Continue the story from exactly where it stops. Write roughly ${wordTarget} words and finish on a complete sentence — do not stop mid-sentence.`;
  }

  const systemParts = [
    "You are a masterful novelist and prose stylist collaborating with an author.",
    "Match the established voice, tense, point of view, and pacing seamlessly; begin mid-flow so it joins onto the last words.",
    langLine,
    task,
    "Output only the story prose — no summaries, headings, notes, or meta commentary. Never repeat text that already exists.",
    s.systemPrompt.trim(),
  ].filter(Boolean);

  const context = storyText.slice(-MAX_CONTEXT_CHARS);

  const userParts = [
    s.authorsNote.trim() ? `[Author's note — keep in mind: ${s.authorsNote.trim()}]` : "",
    "Story so far:",
    "",
    context.length ? context : "(The page is blank — begin the story.)",
    "",
    finish
      ? "Now write the ending:"
      : instruction && instruction.trim()
        ? "Now write that next part:"
        : "Continue from exactly where it leaves off:",
  ].filter(Boolean);

  return [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: userParts.join("\n") },
  ];
}

/** Build messages to rewrite/improve a selected passage in place. */
export function buildRewriteMessages(
  before: string,
  passage: string,
  how: string,
  s: Settings
): ChatMsg[] {
  const langLine =
    s.language && s.language !== "auto"
      ? `Keep it in ${s.language}.`
      : "Keep it in the same language as the passage.";

  const direction = how.trim()
    ? `Revise it as follows: ${how.trim()}.`
    : "Improve it — sharpen the prose, imagery, and flow — while preserving its meaning, length, and events.";

  const system = [
    "You are a masterful literary editor revising one passage of a longer story.",
    direction,
    langLine,
    "Match the surrounding voice, tense, and point of view. Output ONLY the rewritten passage — no quotes, labels, or commentary.",
    s.systemPrompt.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");

  const user = [
    before.trim() ? `Preceding context (do not rewrite this):\n${before.slice(-1500)}` : "",
    "",
    "Passage to rewrite:",
    passage,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
