/** Tiny deterministic 32-bit PRNG (Mulberry32), returning values in [0, 1). */
export function mulberry32(seed: number): () => number {
  if (!Number.isInteger(seed) || !Number.isFinite(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("seed must be an integer from 0 through 4294967295");
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
