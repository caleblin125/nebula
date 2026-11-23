/**
 * Deterministic pseudo-random utilities.
 *
 * Every visual in the renderer is derived from an integer seed that is hashed
 * inside the shader. This module only needs to produce stable integers and
 * human-friendly seed strings.
 */

/** Mulberry32 PRNG — small, fast, and stable across engines. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit avalanche hash. */
export function hashUint(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

export const MAX_SEED = 999_999;

/** A fresh seed that is still readable enough to type back in. */
export function randomSeed(): number {
  const webCrypto = typeof crypto !== 'undefined' ? crypto : undefined;
  if (webCrypto?.getRandomValues) {
    const buffer = new Uint32Array(1);
    webCrypto.getRandomValues(buffer);
    return (buffer[0] % MAX_SEED) + 1;
  }
  return Math.floor(Math.random() * MAX_SEED) + 1;
}

/** Seed from arbitrary text (used by imports / shareable URLs later). */
export function seedFromString(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % MAX_SEED) + 1;
}

/** Clamp a seed into the valid integer range. */
export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 1;
  const rounded = Math.round(seed);
  return Math.min(MAX_SEED, Math.max(1, Math.abs(rounded)));
}
