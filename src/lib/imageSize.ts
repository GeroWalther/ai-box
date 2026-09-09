// Turning "I want 2400 × 2400" into a request a model will actually accept.
//
// No image model outputs arbitrary pixel sizes. Every one offers a fixed set of
// tiers — 512, 1K, 2K, 4K — and a set of aspect ratios, and many offer no tier
// control at all. So an exact size is met in two steps: ask for the smallest
// tier that COVERS the request at the nearest available ratio, then resample the
// result on the Mac (Rust does that half).
//
// Asking for a tier at or above the target keeps it a downscale, which stays
// sharp. Upscaling past the largest tier can't add detail, so that case is
// reported rather than silently softened.

/** Pixels along the long edge for a tier label. */
export function tierPixels(tier: string): number {
  const plain = /^(\d+)$/.exec(tier.trim());
  if (plain) return Number(plain[1]);
  const k = /^(\d+(?:\.\d+)?)\s*k$/i.exec(tier.trim());
  if (k) return Math.round(Number(k[1]) * 1024);
  return 0;
}

/** Tiers smallest-first. The catalog's order is not dependable. */
export function sortTiers(tiers: string[]): string[] {
  return [...tiers].sort((a, b) => tierPixels(a) - tierPixels(b));
}

/** "16:9" → 1.777…; "9:19.5" and other odd ones parse too. `auto` has no ratio. */
export function ratioOf(aspect: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(aspect.trim());
  if (!m) return null;
  const [w, h] = [Number(m[1]), Number(m[2])];
  return h > 0 ? w / h : null;
}

/**
 * The aspect ratio to ask for, given the shape actually wanted. Picks the
 * closest available by log-ratio, so being 20% too wide and 20% too tall are
 * treated as equally wrong. "auto" is never chosen deliberately — it hands the
 * decision back to the model, which is the opposite of what an exact size wants.
 */
export function nearestAspect(available: string[], width: number, height: number): string | null {
  const want = width > 0 && height > 0 ? width / height : null;
  if (!available.length || want === null) return null;
  let best: { aspect: string; distance: number } | null = null;
  for (const aspect of available) {
    const r = ratioOf(aspect);
    if (r === null) continue; // skips "auto"
    const distance = Math.abs(Math.log(r / want));
    if (!best || distance < best.distance) best = { aspect, distance };
  }
  return best?.aspect ?? null;
}

export interface SizePlan {
  /** Tier to request, or null when the model has no tier control. */
  resolution: string | null;
  /** Aspect to request, or null when the model declares none. */
  aspect: string | null;
  /** What the model is expected to return along its long edge, if known. */
  tierPixels: number;
  /** True when even the largest tier is smaller than the requested size. */
  upscaling: boolean;
  /** One line for the UI explaining what will happen. */
  explanation: string;
}

/**
 * Plan a request for an exact `width` × `height` against one model's declared
 * capabilities.
 */
export function planSize(
  tiers: string[],
  aspects: string[],
  width: number,
  height: number
): SizePlan {
  const aspect = nearestAspect(aspects, width, height);
  const sorted = sortTiers(tiers).filter((t) => tierPixels(t) > 0);
  const longEdge = Math.max(width, height);

  if (!sorted.length) {
    return {
      resolution: null,
      aspect,
      tierPixels: 0,
      upscaling: false,
      explanation: aspect
        ? `Generates at ${aspect}, then resamples to ${width}×${height}.`
        : `Resamples the result to ${width}×${height}.`,
    };
  }

  // Smallest tier that covers the request; the largest if none does.
  const covering = sorted.find((t) => tierPixels(t) >= longEdge);
  const chosen = covering ?? sorted[sorted.length - 1];
  const px = tierPixels(chosen);
  const upscaling = !covering;

  return {
    resolution: chosen,
    aspect,
    tierPixels: px,
    upscaling,
    explanation: upscaling
      ? `This model tops out at ${chosen} (~${px}px). ${width}×${height} means scaling up, which won't add detail — pick a model with a bigger tier for a sharp result.`
      : `Generates at ${chosen} (~${px}px${aspect ? `, ${aspect}` : ""}), then resamples to ${width}×${height}.`,
  };
}
