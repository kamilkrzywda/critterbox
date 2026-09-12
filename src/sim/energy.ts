/**
 * Shared energy helpers (PLAN "Life simulation / Agent model" — one energy budget per agent). Plain
 * functions, no class hierarchy, structured so Phase 4 animals reuse the same primitives as plants:
 * clamp, metabolism drain, and death checks. Pure TS, headlessly testable.
 */

/** Clamp an energy value into [0, max]. */
export function clampEnergy(energy: number, max: number): number {
  if (energy <= 0) return 0;
  if (energy >= max) return max;
  return energy;
}

/**
 * Metabolism drain for one tick. `baseRate` is the species' resting cost; `tempMod` scales it with
 * temperature (Phase 7 weather — cold snaps raise metabolism). Returns the amount to subtract.
 */
export function metabolismDrain(baseRate: number, tempMod = 1): number {
  return baseRate * tempMod;
}

/** Apply a drain to an energy value, floored at 0. Returns the new energy. */
export function applyDrain(energy: number, amount: number): number {
  const e = energy - amount;
  return e < 0 ? 0 : e;
}

/** True when an agent is dead by starvation (energy exhausted). */
export function isStarved(energy: number): boolean {
  return energy <= 0;
}
