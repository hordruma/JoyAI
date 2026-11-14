// Small deterministic helpers shared by the performers and the stage.

function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

// Smooth 1-D value noise in [-1, 1]. `seed` decorrelates channels.
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i + seed * 57.31);
  const b = hash1(i + 1 + seed * 57.31);
  return (a + (b - a) * u) * 2 - 1;
}

// Two octaves: slow drift with a little faster life on top.
export function drift(t, seed = 0) {
  return noise1(t, seed) * 0.7 + noise1(t * 2.7 + 13.1, seed + 3.3) * 0.3;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => { const c = clamp01(t); return c * c * (3 - 2 * c); };
export const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// Frame-rate independent exponential approach: `tau` seconds to close
// ~63% of the gap.
export const approach = (current, target, dt, tau) =>
  current + (target - current) * (1 - Math.exp(-dt / tau));

export function pick(weights) {
  let total = 0;
  for (const k in weights) total += weights[k];
  let r = Math.random() * total;
  for (const k in weights) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return Object.keys(weights)[0];
}
