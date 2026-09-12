/**
 * The simulation container (PLAN "Life simulation"): owns the agent list, the spatial hash grid, and the
 * step counter; `step()` advances one fixed tick deterministically given the world seed. Pure TS — no
 * three.js, no DOM — so it runs headlessly under Node for the deterministic checks.
 *
 * Phase 4: plants (growth / stage machine / death) are stepped first, then animals (behaviour / eating /
 * breeding / death). Plants and animals share ONE spatial grid — rebuilt once per tick from all live
 * agents — so animal food/partner queries see both kinds in the same structure. `light()` is a hook
 * returning 1.0 now — Phase 7 swaps in the day/night curve without touching this file.
 *
 * Part B adds two cross-kind APIs: `pollinatePlant` (insects boost flowering-plant growth, per-plant
 * cooldown) and `killAgent` (predation — mice eat insects; mid-pass kills are compacted out safely).
 *
 * Phase 5 adds the corpse layer: every animal death funnels through the base.ts death hook into
 * Sim.corpses (see ./corpses.ts), which decay each tick after both passes; `scavengeAt` is the scavenging
 * API fox/crow use from their behaviour state machine. A dense species cache (speciesOf) replaces the
 * registry Map lookups in the per-tick hot paths (~13k plants × several lookups).
 */

import type { World } from '../worldgen/worldgen';
import { BIOME_FERTILITY } from '../worldgen/worldgen';
import type { Agent, PlantSpecies, Sex, Species } from './types';
import { ANIMAL_STATE_IDLE, STAGE_FRUITING, STAGE_GROWING, STAGE_REGROWTH, STAGE_SEEDLING, STAGE_SENESCENCE } from './types';
import { SpatialGrid } from './spatial';
import { getSpecies } from './registry';
import { agentRand } from './rng';
import './agents'; // side effect: register every species before any agent is created or stepped
import { INITIAL_ANIMAL_ENERGY_FRACTION, animalEnergyMax, dropSeedlingNearby, notifyAnimalDeath, updateAnimal } from './agents/animals/base';
import { CORPSE_DECAY_PER_TICK, initCorpseSystem, scavengeCorpse, type Corpse } from './corpses';

/** Spatial grid cell size in meters (≈ interaction radius; Phase 4 animals query against this). */
export const SIM_CELL_SIZE = 8;
// --- Pollination tunables (Phase 4 insects) -------------------------------------------------
// Kept module-private on purpose: updatePlant reads them every tick for every plant, and exported consts
// compile to `exports.X` property lookups in the CJS headless build — a measurable hot-path cost.
/** Ticks between two effective pollinations of the same plant — insects can't farm one flower forever. */
const POLLINATE_COOLDOWN = 300;
/** Ticks during which a pollinated plant grows faster (fruiting plants keep setting fruit). */
const POLLINATE_BOOST_TICKS = 120;
/** Growth multiplier while the pollination boost window is active. */
const POLLINATE_GROWTH_MULT = 1.5;
/** Fraction of maxEnergy a newborn plant starts with (a visible seedling phase before growing). */
const INITIAL_ENERGY_FRACTION = 0.1;
/** Per-tick probability that a FRUITING plant drops a nearby seed (Phase 5 self-seeding, Sandfall canopy-drop
 *  pattern). This is the dispersal pathway independent of grazers — what keeps low-browse species (reed,
 *  tree) alive past old-age death. Bounded by the same-species exclusion radius in dropSeedlingNearby, so
 *  it self-limits at the area carrying capacity instead of stacking agents unboundedly. */
const PLANT_SELF_SEED_PROB = 0.002;
/** Energy fraction at which a seedling becomes a growing plant. */
const SEEDLING_TO_GROWING = 0.3;
/** Fraction of lifespan at which a plant begins to wither (senescence) before dying past lifespan. */
const SENESCE_FRACTION = 0.85;

export interface SimOptions {
  /** Light hook: () => multiplier in [0,1]. Defaults to always-1 (Phase 7 replaces with day/night). */
  light?: () => number;
  /** Spatial grid cell size override (meters). */
  cellSize?: number;
}

export class Sim {
  readonly world: World;
  /** Live agents, in stable order (dead ones compacted out each step). */
  agents: Agent[] = [];
  /** Monotonic tick counter — the stepSeed for agentRand. */
  stepCount = 0;
  /** Light hook (Phase 7 day/night curve plugs in here). */
  light: () => number;
  readonly grid: SpatialGrid;
  /** Per-species population counts, maintained incrementally (exact at all times) — breeding cap checks. */
  readonly popCounts = new Map<string, number>;
  /** Decaying carcasses (Phase 5) — NOT agents: outside the grid/population counts/renderers. */
  corpses: Corpse[] = [];

  private nextId = 1;
  /** id → live agent: a DENSE array because ids are assigned sequentially from 1 and never reused.
   *  Maintained incrementally (addAgent fills, death clears) — no per-tick rebuild. */
  private byIdArr: (Agent | undefined)[] = [undefined]; // index 0 unused
  /** id → species table, parallel to byIdArr — hot-path lookups avoid the registry Map (Phase 5 perf). */
  private spByIdArr: (Species | undefined)[] = [undefined];

  /** Live agent for id, or undefined when dead/absent — animal food/partner lookups. */
  agentById(id: number): Agent | undefined {
    return this.byIdArr[id];
  }

  /** Species table for a live id (dense cache; undefined once the agent is removed). */
  speciesOf(id: number): Species | undefined {
    return this.spByIdArr[id];
  }

  /** Scavenging API (Phase 5): feed on the nearest corpse within `radius` of (x,z) — see corpses.ts. */
  scavengeAt(x: number, z: number, radius: number, biteAmount: number, efficiency: number): number {
    return scavengeCorpse(this, x, z, radius, biteAmount, efficiency);
  }

  /** True while the agent is still live (in the by-id table) — guards against acting on a mid-pass kill. */
  isAlive(a: Agent): boolean {
    return this.byIdArr[a.id] === a;
  }

  /**
   * Kill an agent immediately (predation, Phase 4 mice→insects): fires the animal death hooks and drops it
   * from the by-id table + population counts right away. The per-tick compaction skips already-removed
   * agents (see step), so a kill mid-pass is safe; call at most once per agent.
   */
  killAgent(a: Agent): void {
    if (!this.isAlive(a)) return; // already removed this tick
    const sp = getSpecies(a.species);
    if (sp?.kind === 'animal') notifyAnimalDeath(this, a); // death hook → corpse at the victim's position
    this.removeAgent(a);
  }
  // Reusable scratch buffers for the per-tick grid rebuild (no allocation churn).
  private bufIds = new Int32Array(0);
  private bufXs = new Float32Array(0);
  private bufZs = new Float32Array(0);

  constructor(world: World, opts?: SimOptions) {
    initCorpseSystem(); // idempotent — wires the death→corpse hook (see corpses.ts for why not at module load)
    this.world = world;
    this.light = opts?.light ?? (() => 1);
    this.grid = new SpatialGrid(opts?.cellSize ?? SIM_CELL_SIZE, 8192);
  }

  /** Create an agent of `species` at (x,z), seated on the terrain. Returns the new agent. */
  addAgent(speciesId: string, x: number, z: number, opts?: { variant?: number; age?: number; sex?: Sex; traits?: Record<string, number> }): Agent {
    const sp = getSpecies(speciesId);
    if (!sp) throw new Error(`unknown species: ${speciesId}`);
    const a: Agent = {
      id: this.nextId++,
      species: speciesId,
      pos: { x, y: this.world.heightAt(x, z), z },
      energy: 0,
      age: opts?.age ?? 0,
      state: STAGE_SEEDLING,
    };
    if (opts?.variant !== undefined) a.variant = opts.variant;
    if (sp.kind === 'plant') {
      a.energy = (sp as PlantSpecies).maxEnergy * INITIAL_ENERGY_FRACTION;
    } else {
      // Animal defaults — seedLife/birth set sex+traits and recompute energy from the size trait.
      a.sex = opts?.sex ?? 'm';
      a.traits = opts?.traits ?? {};
      a.state = ANIMAL_STATE_IDLE;
      a.energy = animalEnergyMax(a) * INITIAL_ANIMAL_ENERGY_FRACTION;
    }
    this.agents.push(a);
    // Keep the dense by-id tables + population counts fresh for mid-pass births (cap checks, lookups).
    this.byIdArr[a.id] = a; // ids are sequential from 1 → the array grows in lockstep
    this.spByIdArr[a.id] = sp;
    this.popCounts.set(sp.id, (this.popCounts.get(sp.id) ?? 0) + 1);
    return a;
  }

  /**
   * Advance one fixed tick: rebuild grid → single agent pass (dispatch plants vs animals by kind) →
   * compact dead agents. Plants and animals share ONE spatial grid (rebuilt once per tick from all live
   * agents): animals query it for food AND partners, so the cell size (~interaction radius) serves both.
   * Offspring/seedlings spawned mid-pass append to the end and act from next tick.
   *
   * Live agents are normally kind-ordered [plants..., animals...] (seedLife seeds all plants first), but
   * seedlings dropped mid-pass land AFTER the animals — a single dispatching pass steps them too, so no
   * plant is ever left un-stepped. The dense species cache makes the per-agent kind check cheap.
   */
  step(): void {
    const light = this.light();

    // 1) Rebuild the spatial hash from all live agent positions (plants + animals).
    let n = this.agents.length;
    this.ensureBuf(n);
    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      this.bufIds[i] = a.id;
      this.bufXs[i] = a.pos.x;
      this.bufZs[i] = a.pos.z;
    }
    this.grid.rebuild(this.bufIds, this.bufXs, this.bufZs);

    // 2) Single agent pass: dispatch by kind (dense species cache — no registry Map lookups), update +
    //    compact in stable order. The isAlive guard drops prey killed mid-pass before it acts again; only
    //    animals are ever killAgent'd, so for plants it never fires.
    let w = 0;
    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      if (!this.isAlive(a)) continue;
      const alive = this.spByIdArr[a.id]?.kind === 'animal' ? updateAnimal(this, a) : updatePlant(this, a, light);
      if (alive) this.agents[w++] = a;
      else this.removeAgent(a);
    }

    // 3) Offspring/seedlings spawned mid-pass were appended past index n (they act from next tick) — keep
    //    them at the tail of the compacted array instead of truncating them away.
    const born = this.agents.length - n;
    if (born > 0) {
      for (let i = 0; i < born; i++) this.agents[w + i] = this.agents[n + i];
    }
    this.agents.length = w + born;

    // 4) Corpses decay (Phase 5): mass drops per tick, removed at ≤ 0. Deaths this tick were appended
    //    mid-pass by the death hook — they age on their first tick here.
    const cs = this.corpses;
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      c.age++;
      c.mass -= CORPSE_DECAY_PER_TICK;
      if (c.mass <= 0) cs.splice(i, 1);
    }

    this.stepCount++;
  }

  /** Drop an agent from the dense by-id tables + population counts (called on death during compaction). */
  private removeAgent(a: Agent): void {
    if (!this.isAlive(a)) return; // idempotent — already dropped (e.g. killed mid-pass, then compacted)
    this.byIdArr[a.id] = undefined;
    this.spByIdArr[a.id] = undefined;
    const c = this.popCounts.get(a.species);
    if (c === undefined) return; // defensive — shouldn't happen
    if (c <= 1) this.popCounts.delete(a.species);
    else this.popCounts.set(a.species, c - 1);
  }

  /** Per-species population stats (plants AND animals): count + average energy. */
  populations(): Record<string, { count: number; avgEnergy: number }> {
    const acc = new Map<string, { count: number; sum: number }>();
    for (const a of this.agents) {
      let e = acc.get(a.species);
      if (!e) {
        e = { count: 0, sum: 0 };
        acc.set(a.species, e);
      }
      e.count++;
      e.sum += a.energy;
    }
    const out: Record<string, { count: number; avgEnergy: number }> = {};
    for (const [k, v] of acc) out[k] = { count: v.count, avgEnergy: v.count > 0 ? v.sum / v.count : 0 };
    return out;
  }

  private ensureBuf(n: number): void {
    if (this.bufIds.length >= n) return;
    const cap = Math.max(n, this.bufIds.length * 2 || 1024);
    this.bufIds = new Int32Array(cap);
    this.bufXs = new Float32Array(cap);
    this.bufZs = new Float32Array(cap);
  }
}

/**
 * Advance one plant by a tick. Mutates the agent; returns true if it survives, false if it dies (old age
 * or starvation). Growth = baseRate × fertility(biome) × light(); fruiting plants hold their yield until
 * grazed; senescent plants wither toward death.
 */
function updatePlant(sim: Sim, a: Agent, light: number): boolean {
  const sp = sim.speciesOf(a.id); // dense cache — avoids the registry Map lookup for ~13k plants per tick
  if (!sp || sp.kind !== 'plant') return true; // defensive — step() routes animals to updateAnimal
  const ps = sp as PlantSpecies;

  a.age += 1;
  if (a.age > ps.lifespan) return false; // old age
  if (a.energy <= 0) return false; // starvation — checked BEFORE regrowth: grazed to nothing is dead

  if (a.state !== STAGE_SENESCENCE && a.age >= ps.lifespan * SENESCE_FRACTION) {
    a.state = STAGE_SENESCENCE;
  }

  const until = a.data?.pollinatedUntil; // pollination boost window active? (see pollinatePlant)
  const boosted = until !== undefined && sim.stepCount < until;
  const fert = BIOME_FERTILITY[sim.world.biomeAt(a.pos.x, a.pos.z)] ?? 1;
  if (a.state === STAGE_SENESCENCE) {
    // Withering: slowly lose biomass toward death.
    a.energy -= ps.baseGrowthRate * 0.5;
    if (a.energy <= 0) return false; // withered away
  } else if (a.state !== STAGE_FRUITING || boosted) {
    // Seedling / growing / regrowth: gain biomass from light toward max. A pollinated FRUITING plant also
    // keeps setting new fruit for the boost window — that extra climb is its yield gain over a control.
    const mult = boosted ? POLLINATE_GROWTH_MULT : 1;
    a.energy += ps.baseGrowthRate * fert * light * mult;
    if (a.energy > ps.maxEnergy) a.energy = ps.maxEnergy;
  }

  const f = a.energy / ps.maxEnergy;
  // Stage transitions (fruiting is repeatable — only grazing drops it back to regrowth).
  if (a.state === STAGE_SEEDLING && f >= SEEDLING_TO_GROWING) a.state = STAGE_GROWING;
  else if ((a.state === STAGE_GROWING || a.state === STAGE_REGROWTH) && f >= ps.fruitingThreshold) {
    a.state = STAGE_FRUITING;
  }

  // Self-seeding (Phase 5): fruiting plants drop a nearby seed — deterministic per (id, tick), bounded by
  // the same-species exclusion radius. Newborns append past the pass boundary and act from next tick.
  if (a.state === STAGE_FRUITING && agentRand(a.id, sim.stepCount, 0x5ef1) < PLANT_SELF_SEED_PROB) {
    dropSeedlingNearby(sim, a);
  }

  return true; // energy > 0 guaranteed here (started positive, only grew or withered-checked above)
}

/**
 * Grazing API (PLAN "Plants as agents"): remove `amount` of biomass from a plant, triggering regrowth when
 * it drops below the species' floor. Returns the yield actually harvested (≤ amount), for the grazer's food.
 */
export function grazePlant(agent: Agent, amount: number): number {
  const sp = getSpecies(agent.species);
  if (!sp || sp.kind !== 'plant') return 0;
  const ps = sp as PlantSpecies;
  const removed = Math.min(amount, agent.energy);
  agent.energy -= removed;
  const f = agent.energy / ps.maxEnergy;
  if ((agent.state === STAGE_FRUITING || agent.state === STAGE_GROWING) && f < ps.regrowthFloor) {
    agent.state = STAGE_REGROWTH;
  }
  return removed;
}

/**
 * Pollination API (PLAN "Plants as agents" — insects pollinate flowering plants): a GROWING or FRUITING
 * plant gets its growth ×POLLINATE_GROWTH_MULT for POLLINATE_BOOST_TICKS ticks, so its yield climbs faster
 * than an unvisited control. A per-plant cooldown (data.lastPollinateStep) prevents one insect from
 * infinitely farming a single flower. Returns true when the boost was applied.
 */
export function pollinatePlant(sim: Sim, agent: Agent): boolean {
  const sp = getSpecies(agent.species);
  if (!sp || sp.kind !== 'plant') return false;
  if (agent.state !== STAGE_GROWING && agent.state !== STAGE_FRUITING) return false; // only flowering/fruiting plants
  if (!agent.data) agent.data = {};
  const last = agent.data.lastPollinateStep;
  if (last !== undefined && sim.stepCount - last < POLLINATE_COOLDOWN) return false; // on cooldown
  agent.data.lastPollinateStep = sim.stepCount;
  agent.data.pollinatedUntil = sim.stepCount + POLLINATE_BOOST_TICKS;
  return true;
}
