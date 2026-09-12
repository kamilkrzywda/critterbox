/**
 * Stateless per-agent randomness for the sim — pure integer hash utilities with no dependency on
 * three.js or the DOM, so they unit-test in isolation (headless). Mirrors Sandfall's cellRand: a
 * lowbias32-style scramble of a mix of the agent id and the step seed. The value for a given agent
 * at step t depends ONLY on that agent and t — never on visit order or what other agents did — so
 * behaviour is independent of processing order (determinism + future parallel/WebGPU equivalence).
 * For a fixed seed, `scramble32` is a permutation of the 32-bit integers, so distinct (id, step)
 * pairs get well-distributed values. `salt` distinguishes multiple draws for the same agent/step.
 */

/** lowbias32-style integer scramble — a bijection over 32-bit ints (good avalanche). */
export function scramble32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0xd35a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Uniform random in [0,1) for (agent id, step seed), optionally salted. Order-independent. */
export function agentRand(id: number, stepSeed: number, salt = 0): number {
  const x = (id + Math.imul(stepSeed, 0x9e3779b1) + Math.imul(salt, 0x85ebca6b)) | 0;
  return scramble32(x) / 4294967296;
}

/** Box-Muller: two uniforms in (0,1]×[0,1) → one standard normal (mean 0, sd ~1). */
export function boxMuller(u1: number, u2: number): number {
  const r = Math.sqrt(-2 * Math.log(Math.max(1e-12, u1)));
  return r * Math.cos(2 * Math.PI * u2);
}

/**
 * Deterministic standard normal for (agent id, step seed) — pulls two independent agentRand draws
 * and applies Box-Muller. Reserved for Phase 4 trait mutation; kept here so the helper is tested now.
 */
export function agentGaussian(id: number, stepSeed: number, salt = 0): number {
  const u1 = Math.max(1e-12, agentRand(id, stepSeed, salt));
  const u2 = agentRand(id, stepSeed, salt + 0x9e37);
  return boxMuller(u1, u2);
}
