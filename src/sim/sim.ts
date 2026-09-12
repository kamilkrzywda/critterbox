/**
 * The simulation container (PLAN "Life simulation"): owns the agent list, the spatial hash grid, and the
 * step counter; `step()` advances one fixed tick deterministically given the world seed. Pure TS — no
 * three.js, no DOM — so it runs headlessly under Node for the deterministic checks.
 *
 * Phase 3 updates plants only (growth / stage machine / death). The grid is rebuilt every tick to match
 * the PLAN contract and be ready for Phase 4 animals; plant positions are static so it costs little.
 * `light()` is a hook returning 1.0 now — Phase 7 swaps in the day/night curve without touching this file.
 */

import type { World } from '../worldgen/worldgen';
import { BIOME_FERTILITY } from '../worldgen/worldgen';
import type { Agent, PlantSpecies } from './types';
import { STAGE_FRUITING, STAGE_GROWING, STAGE_REGROWTH, STAGE_SEEDLING, STAGE_SENESCENCE } from './types';
import { SpatialGrid } from './spatial';
import { getSpecies } from './registry';
import './agents'; // side effect: register every species before any agent is created or stepped

/** Spatial grid cell size in meters (≈ interaction radius; Phase 4 animals query against this). */
export const SIM_CELL_SIZE = 8;
/** Fraction of maxEnergy a newborn plant starts with (a visible seedling phase before growing). */
const INITIAL_ENERGY_FRACTION = 0.1;
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

  private nextId = 1;
  // Reusable scratch buffers for the per-tick grid rebuild (no allocation churn).
  private bufIds = new Int32Array(0);
  private bufXs = new Float32Array(0);
  private bufZs = new Float32Array(0);

  constructor(world: World, opts?: SimOptions) {
    this.world = world;
    this.light = opts?.light ?? (() => 1);
    this.grid = new SpatialGrid(opts?.cellSize ?? SIM_CELL_SIZE, 8192);
  }

  /** Create an agent of `species` at (x,z), seated on the terrain. Returns the new agent. */
  addAgent(speciesId: string, x: number, z: number, opts?: { variant?: number; age?: number }): Agent {
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
    if (sp.kind === 'plant') a.energy = (sp as PlantSpecies).maxEnergy * INITIAL_ENERGY_FRACTION;
    this.agents.push(a);
    return a;
  }

  /** Advance one fixed tick: rebuild grid → update plants (growth/stages/death) → compact out the dead. */
  step(): void {
    const light = this.light();

    // 1) Rebuild the spatial hash from current agent positions (x,z).
    const n = this.agents.length;
    this.ensureBuf(n);
    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      this.bufIds[i] = a.id;
      this.bufXs[i] = a.pos.x;
      this.bufZs[i] = a.pos.z;
    }
    this.grid.rebuild(this.bufIds, this.bufXs, this.bufZs);

    // 2) Update each plant in stable order (deterministic), compacting out the dead in place.
    let w = 0;
    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      if (updatePlant(this, a, light)) this.agents[w++] = a;
    }
    this.agents.length = w;

    this.stepCount++;
  }

  /** Per-species population stats: count + average energy. */
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
  const sp = getSpecies(a.species);
  if (!sp || sp.kind !== 'plant') return true; // non-plant (Phase 4 animals) — leave untouched for now
  const ps = sp as PlantSpecies;

  a.age += 1;
  if (a.age > ps.lifespan) return false; // old age
  if (a.energy <= 0) return false; // starvation — checked BEFORE regrowth: grazed to nothing is dead

  if (a.state !== STAGE_SENESCENCE && a.age >= ps.lifespan * SENESCE_FRACTION) {
    a.state = STAGE_SENESCENCE;
  }

  const fert = BIOME_FERTILITY[sim.world.biomeAt(a.pos.x, a.pos.z)] ?? 1;
  if (a.state === STAGE_SENESCENCE) {
    // Withering: slowly lose biomass toward death.
    a.energy -= ps.baseGrowthRate * 0.5;
    if (a.energy <= 0) return false; // withered away
  } else if (a.state !== STAGE_FRUITING) {
    // Seedling / growing / regrowth: gain biomass from light toward max.
    a.energy += ps.baseGrowthRate * fert * light;
    if (a.energy > ps.maxEnergy) a.energy = ps.maxEnergy;
  }

  const f = a.energy / ps.maxEnergy;
  // Stage transitions (fruiting is repeatable — only grazing drops it back to regrowth).
  if (a.state === STAGE_SEEDLING && f >= SEEDLING_TO_GROWING) a.state = STAGE_GROWING;
  else if ((a.state === STAGE_GROWING || a.state === STAGE_REGROWTH) && f >= ps.fruitingThreshold) {
    a.state = STAGE_FRUITING;
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
