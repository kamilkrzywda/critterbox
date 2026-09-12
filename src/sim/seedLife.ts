/**
 * Deterministic life seeding (PLAN "World seeding"): after worldgen, populate the sim with plants from the
 * World using per-biome densities and a single PRNG stream seeded from the world seed. Same seed + size →
 * byte-identical initial population (asserted in scripts/checks/plants.mjs). Trees are placed on a coarse
 * ~10 m lattice inside forest for even spacing; herbs fill dry cells per-biome with reed boosted on riverbanks.
 * Phase 4 adds the animal passes: C mice (~60) on meadow/grassland, D hares (~24) on meadow/grassland,
 * E hamsters (~18) on grassland/forest-edge, F roe deer (~8) on forest/meadow-edge, G insect clusters
 * (~250 in groups of 10 near flowers anywhere on dry land). Phase 5 adds H frogs (~40) on marsh/water-edge
 * cells, I foxes (~6) on meadow/forest-edge, J storks (~4) on marsh, K owls (~4) in forest, L crows (~8)
 * anywhere on dry land. The new passes come AFTER G so the shared PRNG stream — and thus every Phase 3/4
 * agent's position — is byte-identical to before. Sexes mixed via agentRand.
 */

import type { World } from '../worldgen/worldgen';
import { BIOME_FOREST, BIOME_GRASSLAND, BIOME_MARSH, BIOME_MEADOW } from '../worldgen/worldgen';
import { mulberry32 } from '../worldgen/noise';
import { getSpecies } from './registry';
import type { Agent, PlantSpecies } from './types';
import type { Sim } from './sim';
import { TREE_VARIANT_BIRCH, TREE_VARIANT_OAK, TREE_VARIANT_PINE } from './agents/plants/tree';
import { INITIAL_ANIMAL_ENERGY_FRACTION, animalEnergyMax, initialTraits, pickSex } from './agents/animals/base';
import type { AnimalSpecies } from './agents/animals/base';
import { MYSZ } from './agents/animals/mysz';
import { ZAJAC } from './agents/animals/zajac';
import { CHOMIK } from './agents/animals/chomik';
import { SARNA } from './agents/animals/sarna';
import { OWADY } from './agents/animals/owady';
import { ZABA } from './agents/animals/zaba';
import { LIS } from './agents/animals/lis';
import { BOCIAN } from './agents/animals/bocian';
import { SOWA } from './agents/animals/sowa';
import { WRONA } from './agents/animals/wrona';

/** Salt mixed into the world seed for the life-seeding PRNG (keeps it distinct from noise offsets). */
const LIFE_SALT = 0x5eed;
/** Separate salt for the PLANT-AGE stream: ages are drawn on their own PRNG so they never shift the shared
 *  placement stream — every Phase 3/4 agent's position/count stays byte-identical to v0.5.0. */
const AGE_SALT = 0xa9e1;
/** Tree lattice spacing in meters (~10 m between trees in forest). */
const TREE_SPACING = 10;
/** Jitter range (m) applied to tree lattice points so the grid doesn't read as a perfect grid. */
const TREE_JITTER = 6;
/** Per-cell placement probabilities on dry cells (tuned for the default 300 m world's target populations). */
const MOUSE_FAMILIES = 24; // mouse family clusters on meadow/grassland (~72 total — see placeFamily). Clustered
// seeding gives immediate opposite-sex pairs so breeding starts at t≈0 and the population grows BEFORE the
// initial cohort's old-age wave (lifespan min 3600) hits — uniform scattering left mice partner-starved.
// MANY SMALL families (not few big ones): predators can only reach prey within ~45 m (transit cost), so the
// cluster lattice must be fine enough that every fox/owl roost sits near a mouse patch (Phase 5 tuning).
const MOUSE_FAMILY_SIZE = 3;

const HARE_FAMILIES = 12; // hare family clusters on meadow/grassland (~48 total — see placeFamily)
const HARE_FAMILY_SIZE = 4;
const CHOMIK_FAMILIES = 4; // hamster family clusters on grassland/forest-edge (~16 total)
const CHOMIK_FAMILY_SIZE = 4;
const SARNA_DENSITY = 0.00053; // ~8 roe deer on forest/meadow-edge
/** Insects seed in small clusters (near flowers, so they find nectar + mates quickly). */
const INSECT_CLUSTER_DENSITY = 0.0003; // per dry cell → ~21 clusters of 10 ≈ 250 insects on the default world
const INSECT_CLUSTER_SIZE = 10; // insects per cluster (~250 total)
// Phase 5 densities (per eligible cell, tuned for the default 300 m world's target populations).
const FROG_DENSITY = 0.008; // ~42 frogs on marsh/water-edge cells (~5250 on the default world)
const FOX_TARGET = 8; // foxes placed near mouse/hare clusters (see placeNearPrey); lifespan min 14400 < the 20k gate, so the cohort needs headroom
const STORK_TARGET = 4; // storks placed next to frogs in the marsh
const OWL_TARGET = 6; // owls placed near mouse/hare clusters (lifespan min 14400 < the 20k gate, so the cohort needs headroom)
const CROW_FAMILIES = 4; // crow family clusters anywhere on dry land (~12 total — lifespan min 9000 needs breeding headroom)
const CROW_FAMILY_SIZE = 3;
/** Jitter range (m) for insects inside a cluster. */
const INSECT_CLUSTER_SPREAD = 5;
/** Age (ticks) of seeded insects — young adults (> maturityAge 120, < lifespan min 900). */
const INSECT_SEED_AGE = 300;

export interface SeedStats {
  total: number;
  perSpecies: Record<string, number>;
}

/** Populate `sim` with a deterministic plant population derived from its world. Returns per-species counts. */
export function seedLife(sim: Sim): SeedStats {
  const world = sim.world;
  const rng = mulberry32((world.seed ^ LIFE_SALT) >>> 0);
  const ageRng = mulberry32((world.seed ^ AGE_SALT) >>> 0); // dedicated stream for plant ages (see place)
  const w = world.width, d = world.depth;
  const halfW = w / 2, halfD = d / 2;
  const perSpecies: Record<string, number> = {};
  let total = 0;

  const place = (speciesId: string, x: number, z: number, variant?: number): void => {
    const a = sim.addAgent(speciesId, x, z, variant !== undefined ? { variant } : undefined);
    // Plants start at a RANDOM age in [0, 0.8×lifespan] (deterministic per placement via the shared rng):
    // if every plant were born at t=0 with an identical lifespan, whole cohorts would die of old age in one
    // synchronized wave that no dispersal rate can replace (Phase 5 stability runs showed grass/reed cohort
    // crashes). Distributed ages spread deaths over time so grazer-dispersed seedlings keep pace.
    const sp = getSpecies(speciesId);
    if (sp?.kind === 'plant') a.age = Math.floor(ageRng() * (sp as PlantSpecies).lifespan * 0.8); // dedicated stream — see AGE_SALT
    perSpecies[speciesId] = (perSpecies[speciesId] ?? 0) + 1;
    total++;
  };

  // Animals: addAgent assigns the id first; sex/traits are then derived from it via agentRand so the
  // initial state is a pure function of seed+size. Energy is recomputed from the size trait capacity.
  const placeAnimal = (sp: AnimalSpecies, x: number, z: number): Agent => {
    const m = sim.addAgent(sp.id, x, z);
    m.sex = pickSex(m.id, 0); // stepSeed 0 — seeding is a one-shot, not a tick
    m.traits = initialTraits(sp, m.id);
    m.energy = animalEnergyMax(m) * INITIAL_ANIMAL_ENERGY_FRACTION;
    perSpecies[sp.id] = (perSpecies[sp.id] ?? 0) + 1;
    total++;
    return m;
  };

  /** Place a small family cluster of `sp` around (cx,cz): n members within ~8 m, guaranteed to include at
   *  least one male AND one female so breeding can start immediately. Uniformly scattered individuals of
   *  sparse species rarely find an opposite-sex mate within matingRange — Phase 5 stability runs showed
   *  hare/hamster/crow cohorts going extinct on partner scarcity alone. */
  const placeFamily = (sp: AnimalSpecies, cx: number, cz: number, n: number): void => {
    const members: Agent[] = [];
    for (let i = 0; i < n; i++) {
      const ang = rng() * Math.PI * 2;
      const dist = rng() * 8;
      const x = cx + Math.cos(ang) * dist;
      const z = cz + Math.sin(ang) * dist;
      if (world.heightAt(x, z) < world.waterLevel) continue; // skip an underwater member
      members.push(placeAnimal(sp, x, z));
    }
    let hasM = false, hasF = false;
    for (const m of members) {
      if (m.sex === 'm') hasM = true;
      else hasF = true;
    }
    if (!hasM && members.length > 0) members[0].sex = 'm';
    if (!hasF && members.length > 1) members[members.length - 1].sex = 'f';
  };

  /** Rejection-sample a dry cell matching `ok` and place one family of `sp` there. */
  const placeFamilyOnBiome = (sp: AnimalSpecies, n: number, ok: (biome: number, x: number, z: number) => boolean): void => {
    for (let guard = 0; guard < 200; guard++) {
      const x = Math.floor(rng() * w);
      const z = Math.floor(rng() * d);
      if (world.heights[z * w + x] < world.waterLevel) continue; // dry land only
      if (!ok(world.biomes[z * w + x], x, z)) continue;
      placeFamily(sp, x - halfW + 0.5, z - halfD + 0.5, n);
      return;
    }
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

  // --- Pass C: mouse FAMILIES on dry meadow/grassland cells (~72 in 24 small family clusters) ----------
  for (let f = 0; f < MOUSE_FAMILIES; f++) {
    placeFamilyOnBiome(MYSZ, MOUSE_FAMILY_SIZE, (biome) => biome === BIOME_MEADOW || biome === BIOME_GRASSLAND);
  }

  // --- Pass D: hare FAMILIES on dry meadow/grassland cells (~48 in 12 family clusters) ---------------------
  for (let f = 0; f < HARE_FAMILIES; f++) {
    placeFamilyOnBiome(ZAJAC, HARE_FAMILY_SIZE, (biome) => biome === BIOME_MEADOW || biome === BIOME_GRASSLAND);
  }

  // --- Pass E: hamster FAMILIES on dry grassland / forest-edge cells (~16 in 4 family clusters) -------
  for (let f = 0; f < CHOMIK_FAMILIES; f++) {
    placeFamilyOnBiome(CHOMIK, CHOMIK_FAMILY_SIZE, (biome, x, z) => biome === BIOME_GRASSLAND || (biome === BIOME_FOREST && isForestEdge(world, x, z)));
  }

  // --- Pass F: roe deer on dry forest / meadow-edge cells (~8) ---------------------------------------
  for (let z = 0; z < d; z++) {
    const wz = z - halfD + 0.5;
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (world.heights[i] < world.waterLevel) continue; // dry land only
      const biome = world.biomes[i];
      const edge = biome === BIOME_MEADOW && touchesBiome(world, x, z, BIOME_FOREST);
      if (biome !== BIOME_FOREST && !edge) continue;
      if (rng() >= SARNA_DENSITY) continue;
      placeAnimal(SARNA, x - halfW + 0.5 + (rng() - 0.5), wz + (rng() - 0.5));
    }
  }

  // --- Pass G: insect clusters of INSECT_CLUSTER_SIZE on dry cells (~250 total) ----------------------
  for (let z = 0; z < d; z++) {
    const wz = z - halfD + 0.5;
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (world.heights[i] < world.waterLevel) continue; // dry land only
      if (rng() >= INSECT_CLUSTER_DENSITY) continue;
      const cx = x - halfW + 0.5;
      for (let k = 0; k < INSECT_CLUSTER_SIZE; k++) {
        const px = cx + (rng() - 0.5) * INSECT_CLUSTER_SPREAD;
        const pz = wz + (rng() - 0.5) * INSECT_CLUSTER_SPREAD;
        if (world.heightAt(px, pz) < world.waterLevel) continue; // cluster near a bank — skip the underwater member
        // Insects are short-lived: seed them as young adults so the population is already dynamic at t=0.
        placeAnimal(OWADY, px, pz).age = INSECT_SEED_AGE;
      }
    }
  }

  // --- Pass H: frogs on dry marsh/water-edge cells (~40) — they live in the marsh band (|h−water|≤3) --
  for (let z = 0; z < d; z++) {
    const wz = z - halfD + 0.5;
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (world.heights[i] < world.waterLevel) continue; // dry land only
      if (world.biomes[i] !== BIOME_MARSH) continue; // marsh cells are exactly the water-edge band
      if (rng() >= FROG_DENSITY) continue;
      placeAnimal(ZABA, x - halfW + 0.5 + (rng() - 0.5), wz + (rng() - 0.5));
    }
  }

  // --- Passes I–K: foxes/storks/owls placed NEAR their prey (~8/~4/~6) ---------------------------------
  // Predators seeded on empty patches starve: prey clusters (mice/hares/frogs) don't reach there and a
  // predator's wander radius never carries it across the biome to find them. Placing each predator 5–15 m
  // from a real prey agent guarantees initial food access (Phase 5 stability tuning). Foxes land in
  // meadow/grassland by construction (that's where mice/hares live); storks next to frogs, i.e. the marsh.
  const preyPools: Record<string, Agent[]> = { mysz: [], zajac: [], zaba: [] };
  for (const a of sim.agents) {
    const pool = preyPools[a.species];
    if (pool) pool.push(a);
  }
  const placeNearPrey = (sp: AnimalSpecies, target: number, pools: string[]): void => {
    let placed = 0;
    for (let guard = 0; placed < target && guard < target * 60; guard++) {
      const pool = preyPools[pools[Math.floor(rng() * pools.length)]];
      if (!pool || pool.length === 0) return; // no prey seeded (tiny world?) — skip the species
      const prey = pool[Math.floor(rng() * pool.length)];
      const ang = rng() * Math.PI * 2;
      const dist = 5 + 10 * rng();
      const x = prey.pos.x + Math.cos(ang) * dist;
      const z = prey.pos.z + Math.sin(ang) * dist;
      if (world.heightAt(x, z) < world.waterLevel) continue; // dry land only
      placeAnimal(sp, x, z);
      placed++;
    }
  };
  placeNearPrey(LIS, FOX_TARGET, ['mysz', 'zajac']);
  placeNearPrey(BOCIAN, STORK_TARGET, ['zaba', 'mysz']);
  placeNearPrey(SOWA, OWL_TARGET, ['mysz', 'zajac']);

  // --- Pass L: crow FAMILIES anywhere on dry land (~12 in 4 family clusters) ----------------------------
  for (let f = 0; f < CROW_FAMILIES; f++) {
    placeFamilyOnBiome(WRONA, CROW_FAMILY_SIZE, () => true);
  }

  return { total, perSpecies };
}

/** True when a FOREST cell touches at least one non-forest neighbour (a forest edge; out-of-bounds counts as non-forest). */
function isForestEdge(world: World, x: number, z: number): boolean {
  const w = world.width;
  const nb = (nx: number, nz: number): number => {
    if (nx < 0 || nx >= w || nz < 0 || nz >= world.depth) return -1;
    return world.biomes[nz * w + nx];
  };
  return nb(x - 1, z) !== BIOME_FOREST || nb(x + 1, z) !== BIOME_FOREST || nb(x, z - 1) !== BIOME_FOREST || nb(x, z + 1) !== BIOME_FOREST;
}

/** True when at least one of the cell's 4 neighbours has biome `biome` (out-of-bounds counts as none). */
function touchesBiome(world: World, x: number, z: number, biome: number): boolean {
  const w = world.width;
  const nb = (nx: number, nz: number): number => {
    if (nx < 0 || nx >= w || nz < 0 || nz >= world.depth) return -1;
    return world.biomes[nz * w + nx];
  };
  return nb(x - 1, z) === biome || nb(x + 1, z) === biome || nb(x, z - 1) === biome || nb(x, z + 1) === biome;
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
