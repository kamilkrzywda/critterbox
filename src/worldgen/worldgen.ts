/**
 * Procedural heightmap world generation (Phase 1). Pure TypeScript — no three.js, no DOM:
 * generateWorld() is a pure function of {seed, size}, so the same seed + size always yields the
 * identical world (asserted in scripts/checks/worldgen.mjs).
 *
 * The grid is 1 cell per meter (W = D = size), heights are absolute meters with a fixed amplitude
 * scale — NOT normalized by the world's own min/max — so a 300 m and an 800 m world have comparable
 * relief. Noise is sampled in world coordinates, so feature sizes stay constant across world sizes.
 *
 * Biome rules — per cell, from two independent fBm fields (elevation e after contrast stretch, and
 * moisture m, both in [0,1]):
 *   - |height − waterLevel| ≤ MARSH_BAND          → marsh (low wet land straddling the water line)
 *   - otherwise e ≥ FOREST_E_MIN && m ≥ MOIST_FOREST → forest (higher, moist — trees later)
 *   - otherwise m < DRY_M                          → grassland (open dry land)
 *   - otherwise                                    → meadow (fertile mid land)
 * Water is NOT a biome: any cell with height < waterLevel is water (derived by the sim/render).
 */

import { fbm, mulberry32 } from './noise';

// --- Tunables ---------------------------------------------------------------------------
/** fBm octaves for both noise fields (4 gives large hills + small bumps). */
export const NOISE_OCTAVES = 4;
/** Base wavelength of the first octave in meters — feature scale is absolute, so relief stays
 *  comparable across world sizes (a 300 m and an 800 m world have features of the same size). */
export const FEATURE_SIZE = 96;
/** Contrast stretch applied around 0.5 to the raw fBm elevation — normalized multi-octave value noise is
 *  compressed toward 0.5 (~[0.2, 0.8]); the stretch spreads it across [0,1] so every biome band gets real area. */
export const ELEV_CONTRAST = 2.5;
/** Terrain base height in meters (the field's floor). */
export const BASE_HEIGHT = 0;
/** Fixed absolute relief amplitude in meters — heights span [BASE_HEIGHT, BASE_HEIGHT + AMPLITUDE]. */
export const AMPLITUDE = 42;
/** FIXED water level in meters (same constant for all worlds) — rivers/lakes emerge where fBm dips below it. */
export const WATER_LEVEL = 8;
/** Marsh band: cells within this many meters of the water line (either side) are marsh. */
export const MARSH_BAND = 3;
/** Elevation at/above which moist land becomes forest (after the contrast stretch). */
export const FOREST_E_MIN = 0.52;
/** Moisture threshold for forest. */
export const MOIST_FOREST = 0.55;
/** Moisture below which dry land is grassland. */
export const DRY_M = 0.4;

// --- Biome ids --------------------------------------------------------------------------
export const BIOME_MARSH = 0;
export const BIOME_MEADOW = 1;
export const BIOME_GRASSLAND = 2;
export const BIOME_FOREST = 3;

/** Human-readable biome names, indexed by biome id (for the inspector/HUD). */
export const BIOME_NAMES: readonly string[] = ['marsh', 'meadow', 'grassland', 'forest'];

// --- Seed handling ------------------------------------------------------------------------

/** Parse a user-supplied seed string: numeric → its unsigned integer value; empty/invalid → null. */
export function parseSeed(input: string): number | null {
  const t = input.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return Math.trunc(n) >>> 0; // wrap into u32 — every integer string maps to a valid seed
}

/** Random seed in [0, 2^32) for when no valid user seed is given. */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}

// --- World ------------------------------------------------------------------------------

/** A generated world: heightmap + biome field, with accessors in centered meters (origin at world centre). */
export interface World {
  seed: number;
  /** World edge length in meters (W = D = size); grid is 1 cell per meter. */
  size: number;
  width: number;
  depth: number;
  /** Cell heights in absolute meters, row-major [z * width + x]. */
  heights: Float32Array;
  /** Biome id per cell (see BIOME_*), row-major [z * width + x]; water is derived, not stored. */
  biomes: Uint8Array;
  /** Fixed water level in meters — a cell is water iff its height < waterLevel. */
  waterLevel: number;
  /** Height (m) at world coordinates (x, z) in centered meters, nearest-cell sampling, clamped to bounds. */
  heightAt(x: number, z: number): number;
  /** Biome id at world coordinates (x, z), same convention as heightAt. */
  biomeAt(x: number, z: number): number;
}

/** Noise offsets derived once per seed — a fixed number of RNG draws before any cell work. */
function noiseOffsets(seed: number): { ox: number; oz: number; mx: number; mz: number } {
  const rng = mulberry32(seed);
  return { ox: rng() * 128, oz: rng() * 128, mx: rng() * 128, mz: rng() * 128 };
}

/** Elevation (contrast-stretched fBm in [0,1]) at centered world coordinates — pure in (seed, x, z). */
export function elevationAt(seed: number, x: number, z: number): number {
  const off = noiseOffsets(seed);
  const raw = fbm(x / FEATURE_SIZE + off.ox, z / FEATURE_SIZE + off.oz, seed ^ 0x51f7a3, NOISE_OCTAVES);
  return Math.min(1, Math.max(0, 0.5 + (raw - 0.5) * ELEV_CONTRAST));
}

/** Moisture field (independent fBm in [0,1]) at centered world coordinates — pure in (seed, x, z). */
export function moistureAt(seed: number, x: number, z: number): number {
  const off = noiseOffsets(seed);
  return fbm(x / FEATURE_SIZE + off.mx, z / FEATURE_SIZE + off.mz, seed ^ 0x9e3779b9, NOISE_OCTAVES);
}

/** Biome decision for one cell (see the module header for the rules). */
export function biomeFor(e: number, m: number, height: number): number {
  if (Math.abs(height - WATER_LEVEL) <= MARSH_BAND) return BIOME_MARSH;
  if (e >= FOREST_E_MIN && m >= MOIST_FOREST) return BIOME_FOREST;
  if (m < DRY_M) return BIOME_GRASSLAND;
  return BIOME_MEADOW;
}

/** Generate the full world for {seed, size} — pure: same inputs → byte-identical outputs. */
export function generateWorld(opts: { seed: number; size: number }): World {
  const seed = opts.seed >>> 0;
  const size = Math.round(Math.min(800, Math.max(100, opts.size)));
  const w = size, d = size; // 1 cell per meter
  const n = w * d;
  const heights = new Float32Array(n);
  const biomes = new Uint8Array(n);

  // Offsets derived once (identical to what elevationAt/moistureAt re-derive per call).
  const off = noiseOffsets(seed);
  for (let z = 0; z < d; z++) {
    const wz = z - d / 2 + 0.5; // cell centre in centered meters
    const nz = wz / FEATURE_SIZE;
    for (let x = 0; x < w; x++) {
      const wx = x - w / 2 + 0.5;
      const nx = wx / FEATURE_SIZE;
      const raw = fbm(nx + off.ox, nz + off.oz, seed ^ 0x51f7a3, NOISE_OCTAVES);
      const e = Math.min(1, Math.max(0, 0.5 + (raw - 0.5) * ELEV_CONTRAST));
      const h = BASE_HEIGHT + e * AMPLITUDE;
      const m = fbm(nx + off.mx, nz + off.mz, seed ^ 0x9e3779b9, NOISE_OCTAVES);
      const i = z * w + x;
      heights[i] = h;
      biomes[i] = biomeFor(e, m, h);
    }
  }

  return {
    seed,
    size,
    width: w,
    depth: d,
    heights,
    biomes,
    waterLevel: WATER_LEVEL,
    heightAt(x: number, z: number): number {
      const i = Math.min(w - 1, Math.max(0, Math.floor(x + w / 2)));
      const j = Math.min(d - 1, Math.max(0, Math.floor(z + d / 2)));
      return heights[j * w + i];
    },
    biomeAt(x: number, z: number): number {
      const i = Math.min(w - 1, Math.max(0, Math.floor(x + w / 2)));
      const j = Math.min(d - 1, Math.max(0, Math.floor(z + d / 2)));
      return biomes[j * w + i];
    },
  };
}
