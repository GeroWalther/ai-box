// Selection actions for the Write tab, grouped by what the user is writing.
//
// The editor previously offered eight actions, all of them novel-specific
// (Sensory, Dialogue, Tension…). That is the wrong toolbox for the email, ad or
// paper someone also writes in this app, and every one of those actions was
// prompted as "you are a masterful literary editor" — which produces florid
// nonsense when applied to a support reply.
//
// A mode picks both the visible actions AND the editorial persona used to
// prompt the model, so "more professional" means something different in a
// marketing headline than in a thesis abstract.

export type WritingMode = "fiction" | "business" | "marketing" | "academic";

export interface ModeInfo {
  id: WritingMode;
  label: string;
  /** Replaces the literary-editor persona in the rewrite prompt. */
  persona: string;
}

export const WRITING_MODES: ModeInfo[] = [
  {
    id: "fiction",
    label: "Fiction",
    persona:
      "You are a masterful literary editor revising one passage of a longer story. " +
      "Match the surrounding voice, tense, and point of view.",
  },
  {
    id: "business",
    label: "Business",
    persona:
      "You are an experienced business editor. You write clear, courteous, efficient " +
      "professional prose: plain words, active voice, no filler, no corporate padding. " +
      "Respect the writer's intent and never invent facts, names, dates or commitments.",
  },
  {
    id: "marketing",
    label: "Marketing",
    persona:
      "You are a senior copywriter. You write specific, benefit-led copy with real " +
      "verbs and concrete detail. You avoid hype words, exclamation marks and empty " +
      "superlatives, and you never invent product claims, statistics or testimonials.",
  },
  {
    id: "academic",
    label: "Academic",
    persona:
      "You are an academic editor. You write precise, measured, formally registered " +
      "prose. You preserve hedging and qualification, never overstate a finding, and " +
      "never invent citations, data or sources.",
  },
];

export interface QuickAction {
  id: string;
  label: string;
  /** The instruction handed to the model. */
  how: string;
  /** Modes this action appears in; omitted means every mode. */
  modes?: WritingMode[];
  /**
   * Show the result as an accept/reject diff instead of replacing the text.
   * Used where the user's own words are the point and a silent rewrite would be
   * a violation — proofreading above all.
   */
  review?: boolean;
}

export const QUICK_ACTIONS: QuickAction[] = [
  // --- every mode ---
  {
    id: "proofread",
    label: "Proofread",
    review: true,
    how:
      "Fix ONLY objective errors: spelling, grammar, punctuation, verb agreement, and " +
      "obvious typos. Do NOT change wording, tone, register, style, structure, or " +
      "content, and do not Americanise or Anglicise spelling that is already consistent. " +
      "If a sentence contains no error, reproduce it EXACTLY as written.",
  },
  {
    id: "clarity",
    label: "Grammar & clarity",
    review: true,
    how:
      "Fix grammar, punctuation and spelling, and additionally untangle sentences that " +
      "are genuinely hard to follow — run-ons, misplaced modifiers, ambiguous pronouns. " +
      "Keep the author's voice, vocabulary and meaning. Leave clear sentences untouched.",
  },
  {
    id: "shorten",
    label: "Shorten",
    how:
      "Tighten this — cut redundancy and keep only the strongest lines, preserving " +
      "meaning and voice.",
  },
  {
    id: "rephrase",
    label: "Rephrase",
    how:
      "Rephrase this in fresh words while keeping the same meaning, length, and voice.",
  },

  // --- fiction ---
  {
    id: "expand",
    label: "Expand",
    modes: ["fiction"],
    how:
      "Expand this passage with more detail, sensory texture, and beats, staying in the " +
      "same voice — roughly double the length.",
  },
  {
    id: "sensory",
    label: "Sensory",
    modes: ["fiction"],
    how:
      "Make this passage more vivid — heighten imagery and sensory detail (sight, sound, " +
      "smell, touch) and atmosphere, without changing events.",
  },
  {
    id: "dialogue",
    label: "Dialogue",
    modes: ["fiction"],
    how:
      "Rework this passage to foreground natural, character-revealing dialogue with light " +
      "action beats.",
  },
  {
    id: "show",
    label: "Show, don't tell",
    modes: ["fiction"],
    how:
      "Rewrite to show rather than tell — convey emotion and information through action, " +
      "sensation, subtext and dialogue instead of stating it directly.",
  },
  {
    id: "tension",
    label: "Tension",
    modes: ["fiction"],
    how:
      "Heighten the tension and stakes — tighter sentences, rising unease, sharper " +
      "conflict — without changing what happens.",
  },
  {
    id: "poetic",
    label: "More poetic",
    modes: ["fiction"],
    how:
      "Make this more lyrical and evocative — attend to rhythm, cadence, and image. Earn " +
      "every flourish; do not become purple, and keep the meaning intact.",
  },

  // --- business ---
  {
    id: "professional",
    label: "Professional",
    modes: ["business", "academic"],
    how:
      "Rewrite in a polished professional register suitable for a work email: courteous, " +
      "direct, and free of slang or filler. Keep it warm rather than stiff, and keep every " +
      "fact, name, number and commitment exactly as written.",
  },
  {
    id: "concise",
    label: "Concise",
    modes: ["business", "marketing", "academic"],
    how:
      "Cut this to the shortest version that still says everything it needs to. Remove " +
      "hedging, throat-clearing and repetition. Keep all substantive content.",
  },
  {
    id: "friendly",
    label: "Friendlier",
    modes: ["business", "marketing"],
    how:
      "Warm the tone — approachable and human, still professional. No emoji, no forced " +
      "cheerfulness, no exclamation marks.",
  },
  {
    id: "firm",
    label: "Firmer",
    modes: ["business"],
    how:
      "Make this more direct and assertive without being rude: state the ask plainly, " +
      "remove apologetic hedging (\"just\", \"sorry to bother\", \"I was wondering if maybe\"), " +
      "and keep it respectful.",
  },
  {
    id: "plain",
    label: "Plain English",
    modes: ["business", "academic"],
    how:
      "Rewrite in plain English: short sentences, everyday words, active voice. Replace " +
      "jargon with what it actually means. Preserve all technical accuracy.",
  },
  {
    id: "bullets",
    label: "To bullets",
    modes: ["business"],
    how:
      "Restructure this as a short bulleted list, one idea per bullet, each starting with " +
      "a strong verb. Keep a one-line lead-in sentence if the passage has one.",
  },

  // --- marketing ---
  {
    id: "punchy",
    label: "Punchier",
    modes: ["marketing"],
    how:
      "Make this punchier for advertising: shorter sentences, concrete specifics, a strong " +
      "verb early. No hype adjectives, no exclamation marks, no invented claims.",
  },
  {
    id: "catchy",
    label: "Catchier",
    modes: ["marketing"],
    how:
      "Make this more memorable — a sharper hook, better rhythm, a line worth repeating. " +
      "Stay truthful to what the text actually claims.",
  },
  {
    id: "headlines",
    label: "Headline options",
    modes: ["marketing"],
    how:
      "Replace this with five numbered headline options, each on its own line, each under " +
      "twelve words, each taking a different angle (benefit, curiosity, specificity, " +
      "contrast, plain-spoken). No commentary.",
  },
  {
    id: "benefit",
    label: "Benefit-led",
    modes: ["marketing"],
    how:
      "Rewrite so the reader's benefit leads and the feature supports it, rather than the " +
      "other way round. Stay concrete and truthful.",
  },
  {
    id: "cta",
    label: "Add a CTA",
    modes: ["marketing"],
    how:
      "Keep the passage and add one short, specific call to action at the end. One " +
      "sentence, plain language, no pressure tactics.",
  },

  // --- academic ---
  {
    id: "formal",
    label: "More formal",
    modes: ["academic", "business"],
    how:
      "Raise the register to formal written English: no contractions, no colloquialisms, " +
      "precise word choice. Do not inflate simple statements into jargon.",
  },
  {
    id: "objective",
    label: "Objective tone",
    modes: ["academic"],
    how:
      "Make the tone neutral and objective: remove rhetorical flourish and unsupported " +
      "emphasis, and keep claims proportionate to the evidence stated. Preserve existing " +
      "hedging; do not add citations.",
  },
  {
    id: "dejargon",
    label: "Simplify jargon",
    modes: ["academic", "business"],
    how:
      "Replace unnecessary jargon with clear language while keeping every technical term " +
      "that carries real meaning. Explain nothing the reader of this text would know.",
  },
];

export function actionsForMode(mode: WritingMode): QuickAction[] {
  return QUICK_ACTIONS.filter((a) => !a.modes || a.modes.includes(mode));
}

export function personaForMode(mode: WritingMode): string {
  return (WRITING_MODES.find((m) => m.id === mode) ?? WRITING_MODES[0]).persona;
}
