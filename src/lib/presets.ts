// Curated suggestions and the prompt assembly for novel continuation.
import type { Settings } from "./settings";

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
  opts: ContinueOpts,
  bible?: StoryBibleData
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

  const system = [
    "You are a masterful literary editor revising one passage of a longer story.",
    presetGuidance(s),
    buildBibleContext(bible, `${before.slice(-4000)}\n${passage}`),
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
