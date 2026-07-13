// Auto-extraction for the Story Bible. Two paths:
//   1. extractProperNouns — instant, deterministic, offline: surfaces capitalized
//      names/places in the prose that aren't in the bible yet (Latin scripts).
//   2. buildExtractionMessages/parseExtraction — an optional LLM pass that pulls
//      real new characters + canon facts (works for any language, incl. Japanese).
// Both feed the same one-click "add to bible" chips so the bible stays effortless.
import type { ChatMsg, StoryBibleData } from "./presets";

// Capitalized words that start sentences or are common enough to be noise, not names.
const STOPWORDS = new Set(
  [
    "The", "A", "An", "And", "But", "Or", "So", "Yet", "For", "Nor",
    "He", "She", "It", "They", "We", "You", "I", "Him", "Her", "Them", "His", "Hers",
    "This", "That", "These", "Those", "There", "Then", "Now", "Here", "When", "Where",
    "What", "Who", "Why", "How", "If", "As", "At", "By", "In", "On", "Of", "To", "Up",
    "No", "Not", "Yes", "Maybe", "Perhaps", "Still", "Even", "Once", "After", "Before",
    "Because", "While", "Though", "Although", "Since", "Until", "Every", "Some", "Any",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December", "Mr", "Mrs", "Ms", "Dr",
  ].map((w) => w.toLowerCase())
);

export interface NounSuggestion {
  name: string;
  count: number;
}

/**
 * Deterministic proper-noun suggestions: capitalized single or multi-word tokens
 * that appear in the prose but aren't already known (bible names + aliases).
 * Latin-script only — case carries no signal in CJK, where the LLM pass is used.
 */
export function extractProperNouns(text: string, known: string[]): NounSuggestion[] {
  const knownLower = new Set(known.map((k) => k.trim().toLowerCase()).filter(Boolean));
  const counts = new Map<string, number>();
  // Capitalized word, optionally followed by more capitalized words ("General Vorne").
  const re = /\b[A-Z][a-zA-Z'’]+(?:\s+[A-Z][a-zA-Z'’]+)*\b/g;
  for (const m of text.matchAll(re)) {
    const phrase = m[0].trim();
    const words = phrase.split(/\s+/);
    // A single word that's a stopword (usually a sentence start) is noise.
    if (words.length === 1 && STOPWORDS.has(phrase.toLowerCase())) continue;
    // Strip a leading stopword from a multi-word phrase ("The Ash Girl" → "Ash Girl").
    let cleaned = phrase;
    if (words.length > 1 && STOPWORDS.has(words[0].toLowerCase())) {
      cleaned = words.slice(1).join(" ");
    }
    if (!cleaned || cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (knownLower.has(key)) continue;
    counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    // Multi-word phrases and repeated names rank first; both signal a real entity.
    .sort((a, b) => {
      const aw = a.name.includes(" ") ? 1 : 0;
      const bw = b.name.includes(" ") ? 1 : 0;
      return b.count - a.count || bw - aw || a.name.localeCompare(b.name);
    });
}

export interface Extraction {
  characters: { name: string; traits: string }[];
  facts: { text: string; who: string }[];
}

/** Prompt the model to extract NEW characters + canon facts from the recent prose. */
export function buildExtractionMessages(text: string, bible: StoryBibleData): ChatMsg[] {
  const knownNames = (bible.characters || [])
    .map((c) => c.name.trim())
    .filter(Boolean)
    .join(", ");
  const knownFacts = (bible.facts || [])
    .map((f) => f.text.trim())
    .filter(Boolean)
    .join(" | ");

  const system = [
    "You maintain a story bible for a novelist. From the prose, extract only NEW,",
    "durable facts worth remembering for continuity — established character details",
    "and permanent world/plot facts. Ignore fleeting actions, weather, and one-off",
    "descriptions. Do NOT repeat anything already known.",
    "Return ONLY minified JSON of this exact shape, nothing else:",
    '{"characters":[{"name":"","traits":"short role/traits"}],"facts":[{"text":"a concrete permanent fact","who":"character name(s) it concerns, or empty"}]}',
    "Empty arrays if there is nothing new.",
  ].join(" ");

  const user = [
    knownNames ? `Known characters: ${knownNames}` : "Known characters: (none)",
    knownFacts ? `Known facts: ${knownFacts}` : "Known facts: (none)",
    "",
    "Prose:",
    text.slice(-6000),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Parse the model's JSON extraction defensively (tolerates code fences / prose). */
export function parseExtraction(raw: string | null): Extraction {
  const empty: Extraction = { characters: [], facts: [] };
  if (!raw) return empty;
  let body = raw.trim();
  // Strip ```json … ``` fences if present.
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  // Otherwise isolate the outermost { … }.
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(first, last + 1));
  } catch {
    return empty;
  }
  const obj = parsed as Record<string, unknown>;
  const characters = Array.isArray(obj.characters)
    ? obj.characters
        .map((c) => {
          const o = (c || {}) as Record<string, unknown>;
          return { name: String(o.name ?? "").trim(), traits: String(o.traits ?? "").trim() };
        })
        .filter((c) => c.name)
    : [];
  const facts = Array.isArray(obj.facts)
    ? obj.facts
        .map((f) => {
          const o = (f || {}) as Record<string, unknown>;
          return { text: String(o.text ?? "").trim(), who: String(o.who ?? "").trim() };
        })
        .filter((f) => f.text)
    : [];
  return { characters, facts };
}
