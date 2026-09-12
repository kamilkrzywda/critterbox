/**
 * Deterministic life seeding (PLAN "World seeding"): after worldgen, populate the sim with plants from the
 * World using per-biome densities and a single PRNG stream seeded from the world seed. Same seed + size →
 * byte-identical initial population (asserted in scripts/checks/plants.mjs). Trees are placed on a coarse
 * ~10 m lattice inside forest for even spacing; herbs fill dry cells per-biome with reed boosted on riverbanks.
 * Phase 4 adds pass C: mice (~60 on a 300 m world) on meadow/grassland cells, sexes mixed via agentRand.
 */

import type { World } from '../worldgen/worldgen';
import { BIOME_FOREST, BIOME_GRASSLAND, BIOME_MARSH, BIOME_MEADOW } from '../worldgen/worldgen';
import { mulberry32 } from '../worldgen/noise';
import type { Sim } from './sim';
import { TREE_VARIANT_BIRCH, TREE_VARIANT_OAK, TREE_VARIANT_PINE } from './agents/plants/tree';
import { INITIAL_ANIMAL_ENERGY_FRACTION, animalEnergyMax, initialTraits, pickSex } from './agents/animals/base';
import { MYSZ } from './agents/animals/mysz';

/** Salt mixed into the world seed for the life-seeding PRNG (keeps it distinct from noise offsets). */
const LIFE_SALT = 0x5eed;
/** Tree lattice spacing in meters (~10 m between trees in forest). */
const TREE_SPACING = 10;
/** Jitter range (m) applied to tree lattice points so the grid doesn't read as a perfect grid. */
const TREE_JITTER = 6;
/** Per-cell mouse placement probability on dry meadow/grassland cells (~60 mice on the default 300 m world). */
const MOUSE_DENSITY = 0.001;

export interface SeedStats {
  total: number;
  perSpecies: Record<string, number>;
}

/** Populate `sim` with a deterministic plant population derived from its world. Returns per-species counts. */
export function seedLife(sim: Sim): SeedStats {
  const world = sim.world;
  const rng = mulberry32((world.seed ^ LIFE_SALT) >>> 0);
  const w = world.width, d = world.depth;
  const halfW = w / 2, halfD = d / 2;
  const perSpecies: Record<string, number> = {};
  let total = 0;

  const place = (speciesId: string, x: number, z: number, variant?: number): void => {
    sim.addAgent(speciesId, x, z, variant !== undefined ? { variant } : undefined);
    perSpecies[speciesId] = (perSpecies[speciesId] ?? 0) + 1;
    total++;
  };

  // Animals: addAgent assigns the id first; sex/traits are then derived from it via agentRand so the
  // initial state is a pure function of seed+size. Energy is recomputed from the size trait capacity.
  const placeMysz = (x: number, z: number): void => {
    const m = sim.addAgent('mysz', x, z);
    m.sex = pickSex(m.id, 0); // stepSeed 0 — seeding is a one-shot, not a tick
    m.traits = initialTraits(MYSZ, m.id);
    m.energy = animalEnergyMax(m) * INITIAL_ANIMAL_ENERGY_FRACTION;
    perSpecies['mysz'] = (perSpecies['mysz'] ?? 0) + 1;
    total++;
  };

  // --- Pass A: herbs on every dry-land cell (row-major, fixed order) -------------------------------
  for (let z = 0; z < d; z++) {
    const wz = z - halfD + 0.5; // cell centre in centered meters
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (world.heights[i] < world.waterLevel) continue; // dry land only
      const wx = x - halfW + 0.5;
      const biome = world.biomes[i];

      let species: string | null = null;
      const r = rng();
      if (biome === BIOME_MARSH) {
        if (r < 0.14) species = 'reed';
        else if (r < 0.2) species = 'cranberry';
        else if (r < 0.25) species = 'grass';
      } else if (biome === BIOME_MEADOW) {
        if (r < 0.14) species = 'grass';
        else if (r < 0.22) species = 'clover';
      } else if (biome === BIOME_GRASSLAND) {
        if (r < 0.16) species = 'grass';
      } else if (biome === BIOME_FOREST) {
        if (r < 0.07) species = 'grass'; // understory; trees come in pass B
      }

      // Riverbank boost: dry cells touching water favour reed regardless of biome.
      if (!species && isRiverbank(world, x, z)) {
        if (rng() < 0.12) species = 'reed';
      }

      if (species) place(species, wx + (rng() - 0.5), wz + (rng() - 0.5));
    }
  }

  // --- Pass B: trees on a coarse lattice inside forest --------------------------------------------
  for (let gx = -halfW + TREE_SPACING / 2; gx < halfW - TREE_SPACING / 2; gx += TREE_SPACING) {
    for (let gz = -halfD + TREE_SPACING / 2; gz < halfD - TREE_SPACING / 2; gz += TREE_SPACING) {
      const jx = gx + (rng() - 0.5) * TREE_JITTER;
      const jz = gz + (rng() - 0.5) * TREE_JITTER;
      if (world.biomeAt(jx, jz) !== BIOME_FOREST) continue;
      if (world.heightAt(jx, jz) < world.waterLevel) continue;
      place('tree', jx, jz, pickTreeVariant(rng));
    }
  }

  // --- Pass C: mice on dry meadow/grassland cells (~60 on a 300 m world), sexes mixed --------------
  for (let z = 0; z < d; z++) {
    const wz = z - halfD + 0.5; // cell centre in centered meters
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (world.heights[i] < world.waterLevel) continue; // dry land only
      const biome = world.biomes[i];
      if (biome !== BIOME_MEADOW && biome !== BIOME_GRASSLAND) continue;
      if (rng() >= MOUSE_DENSITY) continue;
      placeMysz(x - halfW + 0.5 + (rng() - 0.5), wz + (rng() - 0.5));
    }
  }

  return { total, perSpecies };
}

/** True when a dry cell has at least one of its 4 neighbours underwater (a riverbank/marsh edge). */
function isRiverbank(world: World, x: number, z: number): boolean {
  const w = world.width;
  const check = (nx: number, nz: number): boolean => {
    if (nx < 0 || nx >= w || nz < 0 || nz >= world.depth) return false;
    return world.heights[nz * w + nx] < world.waterLevel;
  };
  return check(x - 1, z) || check(x + 1, z) || check(x, z - 1) || check(x, z + 1);
}

/** Choose a tree variant (birch/oak/pine) from the PRNG — fixed per plant once seeded. */
function pickTreeVariant(rng: () => number): number {
  const r = rng();
  if (r < 0.4) return TREE_VARIANT_BIRCH;
  if (r < 0.75) return TREE_VARIANT_OAK;
  return TREE_VARIANT_PINE;
}
