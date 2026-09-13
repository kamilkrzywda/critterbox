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
import { MOUSE } from './agents/animals/mouse';
import { HARE } from './agents/animals/hare';
import { HAMSTER } from './agents/animals/hamster';
import { DEER } from './agents/animals/deer';
import { INSECT } from './agents/animals/insect';
import { FROG } from './agents/animals/frog';
import { FOX } from './agents/animals/fox';
import { STORK } from './agents/animals/stork';
import { OWL } from './agents/animals/owl';
import { CROW } from './agents/animals/crow';
import { CARP } from './agents/animals/carp';
import { PIKE } from './agents/animals/pike';
import { AQUATIC_SEED_DEPTH, initAquaticAgent } from './agents/animals/aquatic';

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
const HAMSTER_FAMILIES = 4; // hamster family clusters on grassland/forest-edge (~16 total)
const HAMSTER_FAMILY_SIZE = 4;
const DEER_DENSITY = 0.00053; // ~8 roe deer on forest/meadow-edge
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
// Phase 6 densities (deep river cells: height < waterLevel − AQUATIC_SEED_DEPTH).
const CARP_FAMILIES = 14; // carp family clusters in deep river cells (~35 total — see placeAquaticFamily). Dense enough
// that pike encounter prey on every patrol (Phase 6 stability tuning: at ~24 seeded, pike starved between meals)
const CARP_FAMILY_SIZE = 3;
const PIKE_FAMILIES = 3; // pike family clusters placed near carp in the water (~6 total, guaranteed mixed sexes —
// individually scattered pike drifted apart before breeding and went extinct on old age (Phase 6 stability tuning)
const PIKE_FAMILY_SIZE = 2;
/** Meters above the water line a plant may sit and still be reachable from the swim line (mirrors CARP_SHORE_REACH). */
const AQUATIC_SEED_SHORE_REACH = 3;
/** A carp family must anchor within this of an edible shore plant: a carp seeded in open water far from any
 *  bank starves (its diet is shore plants + waterline insects), and the early strandings thinned the prey
 *  patches until pike stranded too (Phase 6 stability forensics). Directional foraging covers the last stretch. */
const AQUATIC_SEED_FOOD_REACH = 40;
/** Prey clusters seeded in the PIKE'S water body (the largest basin, see pass M2/N): pike relocate their
 *  roost whenever they end up >2×wanderRadius from it, so a scattered prey field gets hunted down patch by
 *  patch — every cluster converges on and strips the last surviving one before it can breed back (Phase 6
 *  stability forensics). The fix is structural: PIKE_PREY_CLUSTERS dense clusters ≥30 m apart, each big
 *  enough that local births outpace even a FULL pike population converging on it (~15 carp ≈ 7 pairs → ~14
 *  births/4k ticks vs ≤8 pikes' ~8 kills/4k ticks), with one pike pair anchored per cluster. */
const PIKE_PREY_CLUSTERS = 4; // the fourth is a reserve (no pike pair) — buffer prey for stragglers
const PIKE_PREY_TARGET = 60; // total carp across the clusters (~15 each)
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
    if (sp?.kind === 'plant') {
      const ps = sp as PlantSpecies;
      a.age = Math.floor(ageRng() * ps.lifespan * 0.8); // dedicated stream — see AGE_SALT
      // Phase 7: energy consistent with age — an old seeded plant is MATURE (fruiting), not a seedling. The
      // world now loads fully grown instead of as a field of 10%-energy seedlings, and nectar/browse sources
      // exist from tick 1: the sim starts at dawn (light ≈ 0), so with all-seedling plants no GROWING/FRUITING
      // nectar source existed until light rose ~400 ticks in — nectar-dependent insects starved before the
      // first fruiting plant appeared, cascading into frog extinction (Phase 7 stability forensics). The map
      // keeps age=0 → seedling fraction and the max drawn age (0.8×lifespan) → just past every species'
      // fruiting threshold (≤ 0.82 vs thresholds 0.7–0.8), so no plant starts senescent (senescence ≥ 0.85).
      a.energy = ps.maxEnergy * (0.1 + 0.9 * (a.age / ps.lifespan));
    }
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

  /** True when a cell is deep enough to SEED an aquatic agent (height < waterLevel − AQUATIC_SEED_DEPTH). */
  const isDeepCell = (x: number, z: number): boolean => world.heightAt(x, z) < world.waterLevel - AQUATIC_SEED_DEPTH;

  /** Shore plants a carp can eat from the swim line (pass A has run — the list is complete by pass M). */
  let shorePlants: { x: number; z: number }[] = [];
  const CARP_SHORE_FOOD = ['reed', 'grass', 'clover', 'cranberry']; // mirrors CARP.foodSpecies
  /** True when (x,z) sits within AQUATIC_SEED_FOOD_REACH of an edible shore plant (see the constant). */
  const nearShoreFood = (x: number, z: number): boolean => {
    const r2 = AQUATIC_SEED_FOOD_REACH * AQUATIC_SEED_FOOD_REACH;
    for (const p of shorePlants) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  };

  /** Place a small family cluster of an aquatic species around a deep river cell: n members within ~8 m,
   *  each over a deep-enough cell (the inverse of placeFamily's dry-land skip), guaranteed to include at
   *  least one male AND one female so breeding starts immediately. Members get their aquatic init
   *  (depth fraction + last-valid position) right away. Returns how many members actually landed. */
  const placeAquaticFamily = (sp: AnimalSpecies, cx: number, cz: number, n: number): number => {
    const members: Agent[] = [];
    for (let i = 0; i < n; i++) {
      const ang = rng() * Math.PI * 2;
      const dist = rng() * 8;
      const x = cx + Math.cos(ang) * dist;
      const z = cz + Math.sin(ang) * dist;
      if (!isDeepCell(x, z)) continue; // skip a member that would dry out
      members.push(placeAnimal(sp, x, z));
    }
    let hasM = false, hasF = false;
    for (const m of members) {
      if (m.sex === 'm') hasM = true;
      else hasF = true;
    }
    if (!hasM && members.length > 0) members[0].sex = 'm';
    if (!hasF && members.length > 1) members[members.length - 1].sex = 'f';
    for (const m of members) initAquaticAgent(sim, m); // depth fraction + last-valid position + seat at depth
    return members.length;
  };

  /** Rejection-sample a DEEP river cell NEAR an edible shore plant and place one aquatic family there. */
  const placeAquaticFamilyInRiver = (sp: AnimalSpecies, n: number): void => {
    for (let guard = 0; guard < 200; guard++) {
      const x = Math.floor(rng() * w);
      const z = Math.floor(rng() * d);
      const cx = x - halfW + 0.5;
      const cz = z - halfD + 0.5;
      if (!isDeepCell(cx, cz)) continue; // deep river cells only
      if (!nearShoreFood(cx, cz)) continue; // a family anchored in open water starves — see AQUATIC_SEED_FOOD_REACH
      placeAquaticFamily(sp, cx, cz, n);
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
    placeFamilyOnBiome(MOUSE, MOUSE_FAMILY_SIZE, (biome) => biome === BIOME_MEADOW || biome === BIOME_GRASSLAND);
  }

  // --- Pass D: hare FAMILIES on dry meadow/grassland cells (~48 in 12 family clusters) ---------------------
  for (let f = 0; f < HARE_FAMILIES; f++) {
    placeFamilyOnBiome(HARE, HARE_FAMILY_SIZE, (biome) => biome === BIOME_MEADOW || biome === BIOME_GRASSLAND);
  }

  // --- Pass E: hamster FAMILIES on dry grassland / forest-edge cells (~16 in 4 family clusters) -------
  for (let f = 0; f < HAMSTER_FAMILIES; f++) {
    placeFamilyOnBiome(HAMSTER, HAMSTER_FAMILY_SIZE, (biome, x, z) => biome === BIOME_GRASSLAND || (biome === BIOME_FOREST && isForestEdge(world, x, z)));
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
      if (rng() >= DEER_DENSITY) continue;
      placeAnimal(DEER, x - halfW + 0.5 + (rng() - 0.5), wz + (rng() - 0.5));
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
        placeAnimal(INSECT, px, pz).age = INSECT_SEED_AGE;
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
      placeAnimal(FROG, x - halfW + 0.5 + (rng() - 0.5), wz + (rng() - 0.5));
    }
  }

  // --- Passes I–K: foxes/storks/owls placed NEAR their prey (~8/~4/~6) ---------------------------------
  // Predators seeded on empty patches starve: prey clusters (mice/hares/frogs) don't reach there and a
  // predator's wander radius never carries it across the biome to find them. Placing each predator 5–15 m
  // from a real prey agent guarantees initial food access (Phase 5 stability tuning). Foxes land in
  // meadow/grassland by construction (that's where mice/hares live); storks next to frogs, i.e. the marsh.
  const preyPools: Record<string, Agent[]> = { mouse: [], hare: [], frog: [] };
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
  placeNearPrey(FOX, FOX_TARGET, ['mouse', 'hare']);
  placeNearPrey(STORK, STORK_TARGET, ['frog', 'mouse']);
  placeNearPrey(OWL, OWL_TARGET, ['mouse', 'hare']);

  // --- Pass L: crow FAMILIES anywhere on dry land (~12 in 4 family clusters) ----------------------------
  for (let f = 0; f < CROW_FAMILIES; f++) {
    placeFamilyOnBiome(CROW, CROW_FAMILY_SIZE, () => true);
  }

  // --- Connected deep-water components (terrain only — before pass M) ----------------------------------
  // The river can split into DISCONNECTED basins (a land barrier between two channels). A pike seeded in a
  // small closed basin strips its prey patch and then starves — it can never swim to the carp boom on the
  // other side of the barrier (Phase 6 stability forensics, seed 1337: all six pikes landed west, the western
  // channel's ~24 carp were over-predated in ~2k ticks, pike extinct by t≈9k while the eastern carp boomed).
  // So pike families only anchor to carp inside the LARGEST connected deep-water component that holds at
  // least one seeded carp (tie → most carp): basin area is the proxy for prey carrying capacity — a big water
  // body with reed-lined banks sustains a carp population through predation, a narrow closed channel doesn't.
  // Deterministic flood fill over the heightmap grid — one-shot seeding cost, no rng involved.
  const compOf = new Int32Array(w * d).fill(-1);
  const compSizes: number[] = [];
  let nComps = 0;
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (compOf[i] !== -1 || world.heights[i] >= world.waterLevel - AQUATIC_SEED_DEPTH) continue;
      compOf[i] = nComps;
      let size = 0;
      const stack: number[] = [i];
      while (stack.length > 0) {
        const c = stack.pop() as number;
        size++;
        const cx = c % w;
        if (cx > 0 && compOf[c - 1] === -1 && world.heights[c - 1] < world.waterLevel - AQUATIC_SEED_DEPTH) { compOf[c - 1] = nComps; stack.push(c - 1); }
        if (cx < w - 1 && compOf[c + 1] === -1 && world.heights[c + 1] < world.waterLevel - AQUATIC_SEED_DEPTH) { compOf[c + 1] = nComps; stack.push(c + 1); }
        if (c >= w && compOf[c - w] === -1 && world.heights[c - w] < world.waterLevel - AQUATIC_SEED_DEPTH) { compOf[c - w] = nComps; stack.push(c - w); }
        if (c < (d - 1) * w && compOf[c + w] === -1 && world.heights[c + w] < world.waterLevel - AQUATIC_SEED_DEPTH) { compOf[c + w] = nComps; stack.push(c + w); }
      }
      compSizes[nComps] = size;
      nComps++;
    }
  }

  // --- Pass M: carp FAMILIES in deep river cells near shore plants (~35 in 14 family clusters) ----------
  // The anchor cell must be deep AND within AQUATIC_SEED_FOOD_REACH of an edible shore plant (reed/grass/
  // clover/cranberry at the waterline): a carp seeded in open water far from any bank has nothing to eat and
  // starves, thinning the prey base until pike strand too (Phase 6 stability forensics).
  shorePlants = [];
  for (const a of sim.agents) {
    if (!CARP_SHORE_FOOD.includes(a.species)) continue;
    if (world.heightAt(a.pos.x, a.pos.z) < world.waterLevel + AQUATIC_SEED_SHORE_REACH) {
      shorePlants.push({ x: a.pos.x, z: a.pos.z });
    }
  }
  for (let f = 0; f < CARP_FAMILIES; f++) {
    placeAquaticFamilyInRiver(CARP, CARP_FAMILY_SIZE);
  }

  // --- Pass M2: top up the pike's basin to PIKE_PREY_TARGET carp -----------------------------------------
  // The global draw above scatters families across every water body — a random ~10 carp in the pike's basin
  // get stripped by six pikes before the first breeding wave (Phase 6 stability forensics). Guarantee the
  // prey base: extra carp families land ONLY inside the chosen component.
  const carpPerComp: number[] = new Array(nComps).fill(0);
  for (const a of sim.agents) {
    if (a.species !== 'carp') continue;
    const ci = compOf[Math.floor(a.pos.z + halfD) * w + Math.floor(a.pos.x + halfW)];
    if (ci >= 0) carpPerComp[ci]++;
  }
  let pikeComponent = -1;
  for (let c = 0; c < nComps; c++) {
    if (carpPerComp[c] === 0) continue; // no prey in this basin — never seed a predator there
    if (pikeComponent === -1 || compSizes[c] > compSizes[pikeComponent] ||
        (compSizes[c] === compSizes[pikeComponent] && carpPerComp[c] > carpPerComp[pikeComponent])) {
      pikeComponent = c;
    }
  }
  const carpClusters: { x: number; z: number }[] = []; // dense prey clusters in the pike's basin — pass N anchors one pike pair per cluster
  if (pikeComponent >= 0) {
    // Pick PIKE_PREY_CLUSTERS anchor points ≥30 m apart, deep + near shore food inside the chosen component.
    for (let guard = 0; carpClusters.length < PIKE_PREY_CLUSTERS && guard < 400; guard++) {
      const x = Math.floor(rng() * w);
      const z = Math.floor(rng() * d);
      const cx = x - halfW + 0.5;
      const cz = z - halfD + 0.5;
      if (!isDeepCell(cx, cz)) continue; // deep river cells only
      if (compOf[Math.floor(cz + halfD) * w + Math.floor(cx + halfW)] !== pikeComponent) continue;
      if (!nearShoreFood(cx, cz)) continue; // a cluster far from any bank starves — see AQUATIC_SEED_FOOD_REACH
      let tooClose = false;
      for (const c of carpClusters) {
        const dx = c.x - cx;
        const dz = c.z - cz;
        if (dx * dx + dz * dz < 30 * 30) { tooClose = true; break; } // ≥30 m apart — one pike pair per cluster, no convergence
      }
      if (tooClose) continue;
      carpClusters.push({ x: cx, z: cz });
    }
    // Fill each cluster to its quota (~PIKE_PREY_TARGET / cluster count ≈ 15). Members land within ~12 m of
    // the anchor — dense enough that opposite-sex pairs fall inside CARP.matingRange (8 m) and the cluster
    // breeds back after predation (scattered singletons never do: Phase 6 stability forensics).
    const perCluster = Math.ceil(PIKE_PREY_TARGET / carpClusters.length);
    for (const c of carpClusters) {
      let placedHere = 0;
      let guard = 0;
      while (placedHere < perCluster && guard++ < 20) {
        const ang = rng() * Math.PI * 2;
        const dist = rng() * 4; // tight around the anchor — keep the cluster dense
        placedHere += placeAquaticFamily(CARP, c.x + Math.cos(ang) * dist, c.z + Math.sin(ang) * dist, CARP_FAMILY_SIZE);
      }
    }
  }

  // --- Pass N: pike FAMILIES — one pair per prey cluster (~6 in 3 pairs) ---------------------------------
  // Like the fox/owl passes but underwater: a pike seeded far from any carp would starve (the river is its
  // whole world). Each pair lands INSIDE a different pass-M2 cluster (≥30 m apart): initial food access at
  // t=0, guaranteed mixed sexes so breeding starts as soon as both mature — and territorial separation,
  // because pike relocate their roost whenever they end up >2×wanderRadius from it, so pairs seeded on the
  // same patch converge there and strip it (Phase 6 stability forensics). Count EVERY placed member toward
  // the cap — a partial family still leaves a hunting pike behind.
  let pikePlaced = 0;
  for (let f = 0; f < PIKE_FAMILIES && f < carpClusters.length && pikePlaced < PIKE_FAMILIES * PIKE_FAMILY_SIZE; f++) {
    const c = carpClusters[f]; // one pair per cluster — the last cluster stays a reserve
    const ang = rng() * Math.PI * 2;
    const dist = rng() * 6; // inside the cluster — first meal within sense radius at t=0
    const toPlace = Math.min(PIKE_FAMILY_SIZE, PIKE_FAMILIES * PIKE_FAMILY_SIZE - pikePlaced); // never overshoot the cap
    pikePlaced += placeAquaticFamily(PIKE, c.x + Math.cos(ang) * dist, c.z + Math.sin(ang) * dist, toPlace);
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
