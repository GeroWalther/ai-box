// Curated suggestions and the prompt assembly for AI writing.
import type { Settings } from "./settings";
import { personaForMode } from "./writingActions";

// Editable suggestions — OpenRouter model IDs churn, so these populate a
// datalist but the field stays free-text. Good picks for creative / permissive
// long-form fiction as of 2026.
export const OPENROUTER_MODEL_SUGGESTIONS = [
  "anthropic/claude-fable-5",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-r1",
  "qwen/qwen-2.5-72b-instruct",
  "neversleep/llama-3-lumimaid-70b",
  "nothingiisreal/mn-celeste-12b",
  "sao10k/l3.1-euryale-70b",
  "cognitivecomputations/dolphin-mixtral-8x22b",
  "anthropic/claude-sonnet-4",
];

// Curated local models pullable via Ollama. `category` groups them so writers see
// fiction-strong, unfiltered picks first — those keep prose private AND uncensored.
export interface LocalModel {
  id: string;
  label: string;
  size: string;
  purpose: string;
  category: "fiction" | "general" | "code" | "reasoning";
  /** Rough minimum unified memory (GB) to run comfortably at Q4. */
  ram?: number;
}
export const LOCAL_MODEL_SUGGESTIONS: LocalModel[] = [
  // Fiction — prose-strong and permissive, so drafting stays private and unfiltered.
  { id: "mistral-nemo:12b", label: "Mistral Nemo 12B", size: "~7 GB", purpose: "Great creative prose, very permissive", category: "fiction", ram: 16 },
  { id: "dolphin-llama3:8b", label: "Dolphin Llama 3 8B", size: "~4.7 GB", purpose: "Uncensored, natural prose", category: "fiction", ram: 12 },
  { id: "dolphin-mistral:7b", label: "Dolphin Mistral 7B", size: "~4.1 GB", purpose: "Uncensored, light & fast", category: "fiction", ram: 8 },
  { id: "gemma2:9b", label: "Gemma 2 9B", size: "~5.4 GB", purpose: "Polished prose (more filtered)", category: "fiction", ram: 12 },
  { id: "dolphin-mixtral:8x7b", label: "Dolphin Mixtral 8x7B", size: "~26 GB", purpose: "Uncensored — strongest local prose", category: "fiction", ram: 32 },
  // General
  { id: "qwen2.5:7b", label: "Qwen 2.5 7B", size: "~4.7 GB", purpose: "General + multilingual", category: "general", ram: 8 },
  { id: "llama3.1:8b", label: "Llama 3.1 8B", size: "~4.9 GB", purpose: "General chat", category: "general", ram: 8 },
  { id: "qwen2.5:14b", label: "Qwen 2.5 14B", size: "~9 GB", purpose: "Stronger general", category: "general", ram: 16 },
  { id: "qwen2.5:32b", label: "Qwen 2.5 32B", size: "~20 GB", purpose: "Best general local — tight", category: "general", ram: 32 },
  // Code
  { id: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B", size: "~4.7 GB", purpose: "Code", category: "code", ram: 8 },
  { id: "qwen2.5-coder:14b", label: "Qwen 2.5 Coder 14B", size: "~9 GB", purpose: "Stronger code", category: "code", ram: 16 },
  // Reasoning
  { id: "deepseek-r1:8b", label: "DeepSeek-R1 8B", size: "~5.2 GB", purpose: "Reasoning (shows thinking)", category: "reasoning", ram: 8 },
  { id: "deepseek-r1:14b", label: "DeepSeek-R1 14B", size: "~9 GB", purpose: "Stronger reasoning", category: "reasoning", ram: 16 },
];

/** The best fiction model that fits the detected unified memory (for defaults). */
export function recommendFictionModel(ramGb: number): LocalModel {
  const fits = LOCAL_MODEL_SUGGESTIONS.filter(
    (m) => m.category === "fiction" && (m.ram ?? 8) <= ramGb
  );
  // Prefer the largest that fits; fall back to the smallest fiction model.
  return (
    fits.sort((a, b) => (b.ram ?? 0) - (a.ram ?? 0))[0] ??
    LOCAL_MODEL_SUGGESTIONS.find((m) => m.id === "dolphin-mistral:7b")!
  );
}

// Strong OpenRouter picks for chat / code / reasoning (best performance).
export const OPENROUTER_CHAT_SUGGESTIONS = [
  "anthropic/claude-fable-5",
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
  // Recommend a fiction-strong model for the writing wedge (privacy + no filter).
  const fiction = recommendFictionModel(ramGb);
  const text = `${fiction.label} — ${fiction.purpose}`;
  const textId = fiction.id;
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

// OpenRouter cloud image models with a "best for" note and a group so the
// picker can explain what each is good at (parity with the text model picker).
// `edit: true` means the model can transform an uploaded reference image.
export interface CloudImageModel {
  id: string;
  label: string;
  note: string;
  group: "Best quality" | "Fast & budget" | "Editing (input image)" | "Design & text";
  edit?: boolean;
}
export const OPENROUTER_IMAGE_MODEL_INFO: CloudImageModel[] = [
  { id: "black-forest-labs/flux-1.1-pro-ultra", label: "FLUX 1.1 Pro Ultra", group: "Best quality", note: "Highest-res FLUX, ultra detail" },
  { id: "black-forest-labs/flux-1.1-pro", label: "FLUX 1.1 Pro", group: "Best quality", note: "Top-tier photoreal, sharp detail" },
  { id: "google/imagen-4", label: "Imagen 4", group: "Best quality", note: "Google — photoreal, great lighting" },
  { id: "bytedance-seed/seedream-4.5", label: "Seedream 4.5", group: "Best quality", note: "Strong photoreal & composition" },
  { id: "black-forest-labs/flux-schnell", label: "FLUX Schnell", group: "Fast & budget", note: "Fastest & cheapest — good drafts" },
  { id: "black-forest-labs/flux-1-dev", label: "FLUX.1 Dev", group: "Fast & budget", note: "Open, versatile, balanced" },
  { id: "stability-ai/stable-diffusion-3.5-large", label: "Stable Diffusion 3.5 L", group: "Fast & budget", note: "Open, versatile" },
  { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", group: "Editing (input image)", note: "Fast; edits an uploaded image", edit: true },
  { id: "black-forest-labs/flux-kontext-pro", label: "FLUX Kontext Pro", group: "Editing (input image)", note: "Transform/edit an input image", edit: true },
  { id: "black-forest-labs/flux-kontext-max", label: "FLUX Kontext Max", group: "Editing (input image)", note: "Higher-quality image editing", edit: true },
  { id: "openai/gpt-image-1", label: "GPT-Image-1", group: "Editing (input image)", note: "Best text-in-image; also edits", edit: true },
  { id: "recraft-ai/recraft-v3", label: "Recraft v3", group: "Design & text", note: "Design, logos, vector, text" },
  { id: "xai/grok-2-image", label: "Grok-2 Image", group: "Design & text", note: "General-purpose" },
];
export const OPENROUTER_IMAGE_MODELS = OPENROUTER_IMAGE_MODEL_INFO.map((m) => m.id);
export const IMAGE_RESOLUTIONS = ["512", "1K", "2K", "4K"];
export const IMAGE_ASPECTS = ["1:1", "3:4", "4:3", "9:16", "16:9"];

// OpenRouter cloud models that accept an INPUT image (image editing / img2img),
// derived from the info list above. Text-to-image-only models can't transform an upload.
export const OPENROUTER_IMAGE_EDIT_MODELS = OPENROUTER_IMAGE_MODEL_INFO.filter(
  (m) => m.edit
).map((m) => m.id);

// Recommended local checkpoints by style. Civitai needs your account token to
// download; paste the model version's download URL into the installer.
export interface ImageModelRec {
  name: string;
  style: string;
  base: string;
  nsfw: boolean;
  note: string;
  /** Civitai search query for the "Find on Civitai" button. */
  search: string;
}
export const IMAGE_MODEL_RECS: ImageModelRec[] = [
  {
    name: "Illustrious XL / NoobAI",
    style: "Anime · illustration",
    base: "SDXL",
    nsfw: true,
    note: "Best anime/ecchi + ukiyo-e.",
    search: "Illustrious",
  },
  {
    name: "Pony Diffusion XL",
    style: "Anime · versatile",
    base: "SDXL",
    nsfw: true,
    note: "Very flexible NSFW anime.",
    search: "Pony Diffusion XL",
  },
  {
    name: "WAI-NSFW-Illustrious",
    style: "Anime · NSFW",
    base: "SDXL",
    nsfw: true,
    note: "Popular explicit anime finetune.",
    search: "WAI NSFW Illustrious",
  },
  {
    name: "Lustify SDXL",
    style: "Photoreal · NSFW",
    base: "SDXL",
    nsfw: true,
    note: "Realistic explicit.",
    search: "Lustify",
  },
  {
    name: "epiCRealism XL",
    style: "Photoreal",
    base: "SDXL",
    nsfw: false,
    note: "Clean photoreal.",
    search: "epiCRealism XL",
  },
];

// One-click curated checkpoints for the managed ComfyUI setup wizard. These are
// direct, no-login downloads (Hugging Face `resolve` URLs) verified to work with
// ComfyUI's single-checkpoint graph (CheckpointLoaderSimple). `recommended` is
// the default the wizard preselects.
export interface CuratedModel {
  id: string;
  label: string;
  file: string; // saved filename
  url: string;
  sizeGb: number;
  base: "SDXL" | "SD1.5";
  note: string;
  /** Sensible generation defaults for this checkpoint. */
  steps: number;
  cfg: number;
  recommended?: boolean;
  nsfw?: boolean;
}
export const CURATED_MODELS: CuratedModel[] = [
  {
    id: "dreamshaper-xl-lightning",
    label: "DreamShaper XL Lightning",
    file: "DreamShaperXL_Lightning.safetensors",
    url: "https://huggingface.co/Lykon/dreamshaper-xl-lightning/resolve/main/DreamShaperXL_Lightning.safetensors",
    sizeGb: 6.9,
    base: "SDXL",
    note: "Fast (4–8 steps) SDXL — seconds per image. Best all-round pick for scene art.",
    steps: 6,
    cfg: 2,
    recommended: true,
  },
  {
    id: "dreamshaper-xl-turbo",
    label: "DreamShaper XL Turbo",
    file: "DreamShaperXL_Turbo_V2-SFW.safetensors",
    url: "https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo/resolve/main/DreamShaperXL_Turbo_V2-SFW.safetensors",
    sizeGb: 6.9,
    base: "SDXL",
    note: "Even faster turbo variant. Great for quick iteration.",
    steps: 6,
    cfg: 2,
  },
  {
    id: "sdxl-base",
    label: "Stable Diffusion XL (base)",
    file: "sd_xl_base_1.0.safetensors",
    url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
    sizeGb: 6.9,
    base: "SDXL",
    note: "Highest fidelity, slower (~28 steps, 30–90s/image on Mac).",
    steps: 28,
    cfg: 6,
  },
  {
    id: "sd15",
    label: "Stable Diffusion 1.5 (small)",
    file: "v1-5-pruned-emaonly-fp16.safetensors",
    url: "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors",
    sizeGb: 2.1,
    base: "SD1.5",
    note: "Smallest & fastest download. Best for low-RAM Macs; lower fidelity.",
    steps: 24,
    cfg: 7,
  },
];

// Writing style/genre presets — one click preadjusts how the AI writes by
// injecting a style directive (and sensible generation defaults) into the
// prompt. Free-form writing stays available by picking none.
export interface WritingPreset {
  id: string;
  label: string;
  guidance: string; // injected into the system prompt
  /** Grouping in the picker; defaults to "format". */
  group?: "format" | "genre";
  /** Optional generation nudges applied when the preset is chosen. */
  temperature?: number;
  wordTarget?: number;
}
export const WRITING_PRESETS: WritingPreset[] = [
  // Formats — what you're writing.
  { id: "novel", label: "Novel", temperature: 0.9, wordTarget: 260,
    guidance: "Write immersive long-form literary fiction: a strong, consistent narrative voice, vivid scene-setting, character interiority, and forward momentum. Favor showing over telling." },
  { id: "short", label: "Short Story", temperature: 0.9, wordTarget: 300,
    guidance: "Write a tightly-focused short story: a single arc, economy of detail, and a resonant ending." },
  { id: "screenplay", label: "Screenplay", temperature: 0.8, wordTarget: 240,
    guidance: "Write in screenplay format: scene headings (INT./EXT.), action lines in present tense, and character-cued dialogue. Convey story through action and speech, not prose narration." },
  { id: "poetry", label: "Poetry", temperature: 1.05, wordTarget: 120,
    guidance: "Write poetry: attend to rhythm, line breaks, imagery, and sound. Compression and metaphor over exposition." },
  { id: "nonfiction", label: "Non-Fiction", temperature: 0.6, wordTarget: 240,
    guidance: "Write clear, credible non-fiction: accurate, well-structured, and engaging. Prefer concrete examples over abstraction; avoid fabricating facts." },
  { id: "article", label: "Article", temperature: 0.6, wordTarget: 260,
    guidance: "Write a well-structured article: a clear hook, logical flow, informative body, and a purposeful close. Journalistic clarity." },
  { id: "email", label: "Email", temperature: 0.7, wordTarget: 180,
    guidance: "Write a clear, personable email: a purposeful subject-worthy opener, skimmable body, a specific ask or takeaway, and a natural sign-off. Match the requested tone." },
  { id: "ads", label: "Ads", temperature: 0.85, wordTarget: 90,
    guidance: "Write punchy, persuasive ad copy: benefit-led, concrete, and concise, with a compelling hook and a clear call to action." },
  { id: "social", label: "Social Post", temperature: 0.9, wordTarget: 110,
    guidance: "Write a short-form social post: a scroll-stopping first line, a warm on-brand voice, tight pacing, and a clear hook or call to action for the chosen platform." },
  { id: "academic", label: "Academic", temperature: 0.5, wordTarget: 260,
    guidance: "Write in a formal academic register: precise, evidence-based, and logically structured, with measured claims. Do not invent citations." },

  // Genre & tone — steer voice/mood on top of whatever format you're writing.
  { id: "romance", label: "Romance", group: "genre", temperature: 0.98, wordTarget: 250,
    guidance: "Write romance: emotional interiority, chemistry and yearning, meaningful gestures, and rising tension between the leads. When a scene turns intimate, render physical closeness and desire candidly and sensuously — sensation, breath, and touch — without euphemistic evasion, always between consenting adults, keeping the established literary voice and tense." },
  { id: "fantasy", label: "Fantasy", group: "genre", temperature: 0.9, wordTarget: 260,
    guidance: "Write fantasy: immersive worldbuilding, a sense of wonder, internally consistent magic/lore, and evocative naming." },
  { id: "scifi", label: "Sci-Fi", group: "genre", temperature: 0.85, wordTarget: 260,
    guidance: "Write science fiction: a grounded speculative premise, plausible extrapolation, and ideas that drive the drama." },
  { id: "thriller", label: "Thriller", group: "genre", temperature: 0.85, wordTarget: 240,
    guidance: "Write a thriller: propulsive pacing, high stakes, short punchy beats, and cliff-edge tension that pulls the reader forward." },
  { id: "horror", label: "Horror", group: "genre", temperature: 0.9, wordTarget: 240,
    guidance: "Write horror: build dread and unease, use restraint and implication, escalate tension, and let atmosphere do the work." },
  { id: "mystery", label: "Mystery", group: "genre", temperature: 0.8, wordTarget: 260,
    guidance: "Write mystery: plant fair clues and red herrings, sustain curiosity, and move toward a satisfying reveal." },
];

/** Combined style guidance for the chosen format + genre (either may be empty).
 *  Format sets *what* you're writing; genre steers voice/mood on top of it. */
export function presetGuidance(s: Settings): string {
  const format = WRITING_PRESETS.find((x) => x.id === s.writingPreset && (x.group ?? "format") === "format");
  const genre = WRITING_PRESETS.find((x) => x.id === s.writingGenre && x.group === "genre");
  return [format?.guidance, genre?.guidance].filter(Boolean).join("\n\n");
}

// Per-document Story Bible: persistent facts and voice the AI should honor for
// this manuscript. Threaded into every continuation/rewrite for the active doc.
export interface BibleCharacter {
  name: string;
  traits: string;
  /** Comma/semicolon-separated other names this character is called (for scene detection). */
  aliases?: string;
}
export interface CanonFact {
  /** An established fact the story must not contradict. */
  text: string;
  /** Comma/semicolon-separated character names this fact concerns; empty = global. */
  who?: string;
}
export interface StoryBibleData {
  synopsis: string;
  characters: BibleCharacter[];
  world: string;
  styleNote: string;
  /** Continuity facts kept in the prompt even once they scroll past the text window. */
  facts?: CanonFact[];
}
export const EMPTY_BIBLE: StoryBibleData = {
  synopsis: "",
  characters: [],
  world: "",
  styleNote: "",
  facts: [],
};

/** All the names a character answers to (name + aliases), trimmed and non-empty. */
function characterTerms(c: BibleCharacter): string[] {
  return [c.name, ...(c.aliases ? c.aliases.split(/[,;]/) : [])]
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does `textLower` (already lower-cased) mention `term`? Word-boundary for Latin
 *  terms to avoid substrings like "Al" in "also"; plain substring for CJK/other
 *  scripts where \b doesn't apply (so Japanese names still match). */
function mentions(textLower: string, term: string): boolean {
  const t = term.toLowerCase();
  if (t.length < 2) return false;
  if (/^[\x00-\x7f]+$/.test(t)) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}\\b`, "i").test(textLower);
  }
  return textLower.includes(t);
}

/** Full, unfiltered Story Bible dump (used as a fallback / for short works). */
export function bibleBlock(b?: StoryBibleData): string {
  if (!b) return "";
  const parts: string[] = [];
  if (b.synopsis?.trim()) parts.push(`Synopsis: ${b.synopsis.trim()}`);
  const chars = (b.characters || [])
    .filter((c) => c.name.trim())
    .map((c) => `- ${c.name.trim()}${c.traits.trim() ? `: ${c.traits.trim()}` : ""}`)
    .join("\n");
  if (chars) parts.push(`Characters:\n${chars}`);
  if (b.world?.trim()) parts.push(`World/Setting: ${b.world.trim()}`);
  if (b.styleNote?.trim()) parts.push(`Style: ${b.styleNote.trim()}`);
  return parts.length
    ? `[Story bible — honor these established facts, characters, and voice]\n${parts.join("\n")}`
    : "";
}

/**
 * Continuity-aware Story Bible context. Instead of dumping the whole bible, it
 * surfaces what's relevant to the CURRENT scene (detected from the recent text):
 *   - characters present in the scene get full detail; the rest are a name roster
 *     (so a large cast doesn't blow the budget but the model still knows they exist)
 *   - canon facts concerning a present character (or global facts) are prioritized,
 *     so a fact established 50 pages ago survives even after it scrolls out of the
 *     text window — the core edge for long-form consistency.
 * Synopsis / world / style are always included (they're the through-line).
 */
export function buildBibleContext(b: StoryBibleData | undefined, recentText: string): string {
  if (!b) return "";
  const textLower = (recentText || "").toLowerCase();
  const parts: string[] = [];

  if (b.synopsis?.trim()) parts.push(`Synopsis: ${b.synopsis.trim()}`);

  const chars = (b.characters || []).filter((c) => c.name.trim());
  const present = chars.filter((c) => characterTerms(c).some((t) => mentions(textLower, t)));
  const others = chars.filter((c) => !present.includes(c));

  if (present.length) {
    const lines = present
      .map((c) => {
        const aka = c.aliases?.trim() ? ` (aka ${c.aliases.trim()})` : "";
        return `- ${c.name.trim()}${aka}${c.traits.trim() ? `: ${c.traits.trim()}` : ""}`;
      })
      .join("\n");
    parts.push(`Characters in this scene:\n${lines}`);
  }
  if (others.length) {
    parts.push(
      `Other established characters (keep consistent if they enter): ${others
        .map((c) => c.name.trim())
        .join(", ")}`
    );
  }

  if (b.world?.trim()) parts.push(`World/Setting: ${b.world.trim()}`);

  const facts = (b.facts || []).filter((f) => f.text?.trim());
  if (facts.length) {
    const presentTermsLower = present.flatMap(characterTerms).map((t) => t.toLowerCase());
    const relevant: string[] = [];
    const rest: string[] = [];
    for (const f of facts) {
      const who = (f.who || "")
        .split(/[,;]/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      const isRelevant =
        who.length === 0 ||
        who.some((w) => presentTermsLower.some((t) => t.includes(w)) || textLower.includes(w));
      (isRelevant ? relevant : rest).push(`- ${f.text.trim()}`);
    }
    // Relevant facts first; top up with the rest, capped so a huge canon list
    // can't crowd out the actual prose.
    const MAX_FACTS = 40;
    const chosen = [...relevant, ...rest].slice(0, MAX_FACTS);
    if (chosen.length) parts.push(`Established canon (do not contradict):\n${chosen.join("\n")}`);
  }

  if (b.styleNote?.trim()) parts.push(`Style: ${b.styleNote.trim()}`);

  return parts.length
    ? `[Story bible — honor these established facts, characters, and voice for continuity]\n${parts.join(
        "\n"
      )}`
    : "";
}

// Keep only the trailing window so we stay within context and steer on recent voice.
export const MAX_CONTEXT_CHARS = 8000;

/** Build messages that produce/refresh a compact "story so far" continuity memory
 *  for text beyond the verbatim window — so the model keeps track of the whole book. */
export function buildSummaryMessages(text: string, previous?: string): ChatMsg[] {
  const system =
    "You maintain a running 'story so far' memory for a novelist. From the manuscript " +
    "below, produce a CONCISE, factual continuity digest — not prose: key plot events in " +
    "order; the current situation; each major character's state, location, and relationships; " +
    "established facts and world rules; and unresolved threads. Terse sentences or bullets, " +
    "~200–400 words. This is context for continuing the story, so prioritize what the author " +
    "must not contradict. No preamble or commentary.";
  const user = previous
    ? `Previous memory (update and extend it to cover the whole manuscript):\n${previous}\n\nManuscript:\n${text}`
    : `Manuscript:\n${text}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

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
  opts: ContinueOpts,
  bible?: StoryBibleData,
  summary?: string
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

  // The recent-text window is computed first so the Story Bible can retrieve the
  // characters/facts relevant to what's actually happening right now.
  const context = storyText.slice(-MAX_CONTEXT_CHARS);

  const systemParts = [
    "You are a masterful novelist and prose stylist collaborating with an author.",
    "Match the established voice, tense, point of view, and pacing seamlessly; begin mid-flow so it joins onto the last words.",
    presetGuidance(s),
    summary?.trim()
      ? `Story so far (earlier chapters, condensed — treat as established canon; do not contradict):\n${summary.trim()}`
      : "",
    buildBibleContext(bible, context),
    langLine,
    task,
    "Output only the story prose — no summaries, headings, notes, or meta commentary. Never repeat text that already exists.",
    s.systemPrompt.trim(),
  ].filter(Boolean);

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
  s: Settings,
  bible?: StoryBibleData
): ChatMsg[] {
  const langLine =
    s.language && s.language !== "auto"
      ? `Keep it in ${s.language}.`
      : "Keep it in the same language as the passage.";

  const direction = how.trim()
    ? `Revise it as follows: ${how.trim()}.`
    : "Improve it — sharpen the prose, imagery, and flow — while preserving its meaning, length, and events.";

  // Outside fiction, the literary-editor persona and the Story Bible are noise
  // at best and actively wrong at worst — an email does not have canon, and
  // "heighten the imagery" is not what someone asking for a professional tone
  // wants. Fiction keeps the full novelist context; other modes get an editor
  // suited to the form and no story scaffolding.
  const mode = s.writingMode || "fiction";
  const fiction = mode === "fiction";

  const system = [
    personaForMode(mode),
    fiction ? presetGuidance(s) : "",
    fiction ? buildBibleContext(bible, `${before.slice(-4000)}\n${passage}`) : "",
    direction,
    langLine,
    fiction
      ? "Match the surrounding voice, tense, and point of view."
      : "Preserve the author's voice and every fact, name, number and commitment in the text.",
    "Output ONLY the revised passage — no quotes, labels, or commentary.",
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

/**
 * Turn a scene of prose into a single text-to-image prompt, carrying character
 * appearance + world from the Story Bible so recurring characters stay visually
 * consistent across illustrations. Output is meant to be the raw image prompt.
 */
export function buildImagePromptMessages(passage: string, bible?: StoryBibleData): ChatMsg[] {
  const chars = (bible?.characters || [])
    .filter((c) => c.name.trim())
    .map((c) => `${c.name.trim()}${c.traits.trim() ? `: ${c.traits.trim()}` : ""}`);
  const notes = [
    chars.length ? `Character appearance notes: ${chars.join("; ")}` : "",
    bible?.world?.trim() ? `World/setting: ${bible.world.trim()}` : "",
  ].filter(Boolean);

  const system =
    "You turn a scene of prose into ONE image-generation prompt for a text-to-image model. " +
    "Output ONLY the prompt: a single concise line of comma-separated visual descriptors — " +
    "the subject(s) and their appearance, the setting, time of day, lighting, mood, and a " +
    "fitting art style. Use the character/world notes so recurring characters look consistent. " +
    "No preamble, no quotes, no explanation.";

  const user = [...notes, "", "Scene:", passage.slice(0, 1500)].filter(Boolean).join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// A tiny, editorial "Featured" pin list with a "best for" note. Kept short on
// purpose — these are the few models worth spotlighting and rarely change. The
// full catalog is live from OpenRouter, so everything else stays current on its
// own; update these only when a clearly-better default appears.
export interface FeaturedModel {
  id: string;
  label: string;
  note: string; // what it's best for
}
export const FEATURED_MODELS: FeaturedModel[] = [
  { id: "anthropic/claude-fable-5", label: "Claude Fable 5", note: "Best for literary fiction & long-form prose" },
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", note: "Versatile — writing, reasoning & agent tasks" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Huge context, strong reasoning" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat", note: "Great value for everyday writing" },
];

// Detect uncensored / adult-friendly models by name so the ✦ "Uncensored" group
// is built from the LIVE OpenRouter catalog — new models and versions in these
// families (or explicitly labeled) are picked up automatically, no list to edit.
const UNCENSORED_RE =
  /(euryale|magnum|lumimaid|noromaid|mythomax|mythalion|anubis|rocinante|celeste|cydonia|behemoth|dolphin|pygmalion|mlewd|psyfighter|tiefighter|goliath|airoboros|wizard-vicuna|spicyboros|fimbulvetr|stheno|lunaris|uncensored|unfiltered|nsfw|abliterated)/i;
export function isUncensoredModel(text: string): boolean {
  return UNCENSORED_RE.test(text);
}

// ---- Video: brief → prompt, and brief → storyboard --------------------------
// A video model is directed, not asked. These two builders turn what a person
// actually has — "30s ad for my espresso machine, premium, warm" — into the
// shot language these models respond to: subject, camera, lens, motion,
// lighting, palette, pacing.

/** Fixed vocabulary offered in the Video tab's brief form. */
export const AD_TONES = [
  "Premium & cinematic",
  "Warm & human",
  "Bold & energetic",
  "Clean & minimal",
  "Playful & bright",
  "Moody & dramatic",
  "Documentary & real",
] as const;

export interface AdBrief {
  product: string;
  audience: string;
  message: string;
  tone: string;
  /** Free-form: brand colours, must-appear props, things to avoid. */
  notes: string;
}

function briefLines(b: AdBrief): string[] {
  return [
    b.product.trim() ? `Product / subject: ${b.product.trim()}` : "",
    b.audience.trim() ? `Audience: ${b.audience.trim()}` : "",
    b.message.trim() ? `Message to land: ${b.message.trim()}` : "",
    b.tone.trim() ? `Tone: ${b.tone.trim()}` : "",
    b.notes.trim() ? `Brand notes / constraints: ${b.notes.trim()}` : "",
  ].filter(Boolean);
}

const SHOT_CRAFT =
  "Write in the language video models respond to: name the subject and its material/finish, " +
  "the camera (shot size, lens, angle) and its movement, the light (source, direction, quality), " +
  "the setting, the palette, and the motion happening in frame. Present tense, concrete nouns. " +
  "No brand logos, no on-screen text, no voice-over lines, no cuts inside a single shot.";

/**
 * One continuous shot from an ad brief — for a single-clip spot. Output is the
 * raw prompt, ready to send to the video model.
 */
export function buildVideoPromptMessages(brief: AdBrief, seconds: number): ChatMsg[] {
  const system =
    `You are a commercial director writing ONE prompt for a text-to-video model. ` +
    `The result is a single unbroken ${seconds}-second shot. ${SHOT_CRAFT} ` +
    "Output ONLY the prompt — one paragraph, 40–80 words. No preamble, no quotes, no labels.";
  return [
    { role: "system", content: system },
    { role: "user", content: briefLines(brief).join("\n") },
  ];
}

/**
 * A shot list for a multi-shot spot. Asks for strict JSON so the panel can queue
 * each shot as its own generation; parseStoryboard tolerates a model that wraps
 * it in prose or a code fence anyway.
 */
export function buildStoryboardMessages(
  brief: AdBrief,
  shots: number,
  secondsPerShot: number
): ChatMsg[] {
  const system =
    `You are a commercial director boarding a ${shots * secondsPerShot}-second spot as ` +
    `exactly ${shots} shots of ${secondsPerShot} seconds each. Each shot is one unbroken take. ` +
    "Together they must tell one arc — hook, product, payoff — and stay visually continuous: " +
    "same product, same palette, same light, so the cuts read as one film. " +
    SHOT_CRAFT +
    ' Reply with ONLY a JSON array: [{"title":"3-5 word slug","prompt":"40-70 words"}]. No prose, no code fence.';
  return [
    { role: "system", content: system },
    { role: "user", content: briefLines(brief).join("\n") },
  ];
}

export interface Shot {
  title: string;
  prompt: string;
}

/** Pull the shot list out of a model reply, fence or stray prose and all. */
export function parseStoryboard(raw: string | null): Shot[] {
  if (!raw) return [];
  const text = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s, i) => ({
        title: String(s?.title ?? `Shot ${i + 1}`).trim() || `Shot ${i + 1}`,
        prompt: String(s?.prompt ?? "").trim(),
      }))
      .filter((s) => s.prompt);
  } catch {
    return [];
  }
}

// ---- Screen Assist ---------------------------------------------------------
// Ask about what's on screen, get a spoken answer plus something drawn over the
// real interface.
//
// Coordinates are normalised 0–1000 on both axes because that is the space
// Gemini natively emits, and it is resolution-independent — the same answer maps
// onto a 5K display and a laptop panel without the model knowing either size.

/** One thing to draw over the screen. */
export interface Annotation {
  kind: "circle" | "arrow" | "box" | "underline";
  /** [x, y, x2, y2] in 0–1000 space. A circle/arrow uses the box's centre. */
  box: [number, number, number, number];
  /** Short caption rendered next to the mark. Optional. */
  label?: string;
}

export interface ScreenAnswer {
  /** What gets spoken. Plain prose, no markup. */
  say: string;
  /** Longer text for the overlay, when there is more to show than to say. */
  detail?: string;
  annotations: Annotation[];
}

const ASSIST_RULES =
  "Answer in at most three sentences unless the question truly needs more — this is " +
  "spoken aloud, so write it the way a person would say it, with no markdown, no " +
  "lists and no code fences in `say`. Put anything longer, or anything with code, " +
  "in `detail` instead.";

const POINTING_RULES =
  "When the answer refers to something visible, mark it. Coordinates are 0–1000 on " +
  "both axes: x from the left edge, y from the top edge, INDEPENDENT of the real " +
  "resolution. Give a tight box around the element itself, not the region it sits " +
  "in. Use `circle` for a control to click, `arrow` to point at something small, " +
  "`box` to frame an area, `underline` for a line of text. Mark only what the " +
  "answer actually mentions — two or three marks at most, and none at all if the " +
  "answer is not about anything on screen.";

const SHAPE =
  'Reply with ONLY a JSON object: {"say":"...","detail":"...","annotations":' +
  '[{"kind":"circle","box":[x,y,x2,y2],"label":"..."}]}. No prose around it, no ' +
  "code fence. `detail` and `label` are optional; `annotations` may be empty.";

/**
 * Messages for one question.
 *
 * With a screenshot the model is told to look; without one it is told plainly
 * that it cannot see the screen, which stops it inventing an interface to point
 * at — the failure mode that makes a screen assistant untrustworthy.
 */
export function buildScreenAssistMessages(
  question: string,
  hasScreenshot: boolean
): { system: string; user: string } {
  const system = hasScreenshot
    ? "You are a assistant looking at a screenshot of the user's Mac screen. Answer their " +
      "question about what they can see: explain it, tell them the answer, or walk them " +
      "through the next step. " +
      ASSIST_RULES +
      " " +
      POINTING_RULES +
      " If the question turns out to have nothing to do with the screen, just answer it " +
      "normally and return no annotations. " +
      SHAPE
    : "You are a helpful assistant. The user has NOT shared their screen with you, so you " +
      "cannot see it. Answer from your own knowledge. If the question clearly needs to see " +
      "their screen, say so in one line and suggest they ask again with the screen attached " +
      "— do not guess at what might be on it. " +
      ASSIST_RULES +
      " Return an empty annotations array. " +
      SHAPE;

  return { system, user: question };
}

/**
 * Read the answer back, tolerating a model that wraps its JSON in a fence or a
 * sentence. A model that ignores the format entirely still produces a usable
 * spoken answer: its prose becomes `say` rather than an error.
 */
export function parseScreenAnswer(raw: string | null): ScreenAnswer {
  const text = (raw ?? "").trim();
  if (!text) return { say: "", annotations: [] };

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const o = JSON.parse(text.slice(start, end + 1));
      const say = typeof o.say === "string" ? o.say.trim() : "";
      if (say || Array.isArray(o.annotations)) {
        return {
          say,
          detail: typeof o.detail === "string" && o.detail.trim() ? o.detail.trim() : undefined,
          annotations: cleanAnnotations(o.annotations),
        };
      }
    } catch {
      /* fall through to treating the whole reply as speech */
    }
  }
  // Not JSON at all — strip any fence and speak what came back rather than
  // failing in front of the user.
  return {
    say: text.replace(/```[a-z]*\n?/gi, "").trim(),
    annotations: [],
  };
}

/** Keep only marks that are real, in range, and the right way round. */
function cleanAnnotations(input: unknown): Annotation[] {
  if (!Array.isArray(input)) return [];
  const kinds = ["circle", "arrow", "box", "underline"] as const;
  const out: Annotation[] = [];
  for (const a of input.slice(0, 6)) {
    const box = (a as Annotation)?.box;
    if (!Array.isArray(box) || box.length !== 4) continue;
    const n = box.map(Number);
    if (n.some((v) => !Number.isFinite(v))) continue;
    // Models occasionally emit [x2,y2,x1,y1]; normalise rather than drop it.
    let [x1, y1, x2, y2] = [
      Math.min(n[0], n[2]),
      Math.min(n[1], n[3]),
      Math.max(n[0], n[2]),
      Math.max(n[1], n[3]),
    ];
    x1 = clamp(x1);
    y1 = clamp(y1);
    x2 = clamp(x2);
    y2 = clamp(y2);
    // A zero-area mark is a point, not a mistake — give it something to draw.
    if (x2 - x1 < 4) [x1, x2] = [clamp(x1 - 12), clamp(x2 + 12)];
    if (y2 - y1 < 4) [y1, y2] = [clamp(y1 - 12), clamp(y2 + 12)];
    const kind = kinds.includes((a as Annotation)?.kind) ? (a as Annotation).kind : "circle";
    const label = typeof (a as Annotation)?.label === "string" ? (a as Annotation).label : undefined;
    out.push({ kind, box: [x1, y1, x2, y2], label: label?.slice(0, 60) });
  }
  return out;
}

const clamp = (v: number) => Math.max(0, Math.min(1000, v));
