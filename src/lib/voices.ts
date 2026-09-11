// Choosing a voice out of the ~180 macOS ships.
//
// Shared by the Settings panel and the overlay's own little menu, because the
// two must agree: a voice offered in one and missing from the other is a bug
// the user hits by switching panels.
import type { MacVoice } from "./api";

/**
 * The voices worth putting in a menu.
 *
 * Rust has already dropped the novelty synthesisers (Albert, Zarvox, Bubbles)
 * and flagged a shortlist per language. On top of that, any Premium or Enhanced
 * voice the user has gone and downloaded is always offered, shortlist or not —
 * they installed it on purpose, and it sounds better than anything here.
 */
export function worthOffering(voices: MacVoice[]): MacVoice[] {
  return voices.filter((v) => v.classic || v.quality !== "default");
}

/**
 * Voices grouped by language, in the order they arrive — which is best-first.
 *
 * Language names come from the OS rather than a table kept here, so every
 * locale is labelled properly rather than shown as a raw code.
 */
export function byLanguage(voices: MacVoice[]): [string, MacVoice[]][] {
  const names = new Intl.DisplayNames(undefined, { type: "language" });
  const groups = new Map<string, MacVoice[]>();
  for (const v of voices) {
    const code = v.locale.split(/[_-]/)[0];
    let label = code;
    try {
      label = names.of(code) ?? code;
    } catch {
      /* an unknown code is still worth grouping under itself */
    }
    const bucket = groups.get(label);
    if (bucket) bucket.push(v);
    else groups.set(label, [v]);
  }
  // Map preserves insertion order, so the incoming ranking carries through.
  return [...groups.entries()];
}
