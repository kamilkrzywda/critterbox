/**
 * Base agent schema + species tables (PLAN "Life simulation / Agent model"). Plain objects and plain
 * behaviour tables — no ECS, no class hierarchy (Sandfall pattern). This module is pure TS: it defines
 * shapes only, so it compiles & runs headlessly. `sex`/`traits` are the animal fields used from Phase 4;
 * `data` is shared per-entity memory (animal behaviour state + plant pollination state); plants don't use
 * sex/traits. `variant` is a small plant-specific extension used by trees (the birch/oak/pine form chosen
 * by biome at seeding).
 */

/** Sex — set at birth (50/50 via agentRand); breeding requires opposite-sex pairs. */
export type Sex = 'm' | 'f';

/** World-space position in centered meters; y is the terrain height at spawn. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A living individual — every plant (and, from Phase 4, animal) is one of these. */
export interface Agent {
  /** Unique id, monotonically increasing per sim instance (also the rng key). */
  id: number;
  /** Species registry key (e.g. 'grass', 'tree'). */
  species: string;
  pos: Vec3;
  /** Plants: biomass/health in [0, maxEnergy]. Animals: energy budget on the 0–100 scale (× size trait). */
  energy: number;
  /** Ticks alive. */
  age: number;
  /** Plant stage-machine state (see STAGE_*); animal behaviour state (see ANIMAL_STATE_*). */
  state: string;
  sex?: Sex; // animals only — set at birth, 50/50 via agentRand
  traits?: Record<string, number>; // animals only — heritable numeric traits (mean of parents + mutation)
  /** Per-entity memory (JSON-safe numbers). Animals: lastBreedStep, behaviour target coords. Plants:
   * pollination state (lastPollinateStep, pollinatedUntil — see sim.pollinatePlant). */
  data?: Record<string, number>;
  variant?: number; // tree form chosen by biome at seeding: 0 birch, 1 oak, 2 pine
}

export type SpeciesKind = 'plant' | 'animal';

/** Base species entry — a plain table row keyed by id in the registry. */
export interface Species {
  id: string;
  kind: SpeciesKind;
  /** Human-readable name for the HUD/inspector (Polish fauna theme). */
  displayName: string;
}

/** Plant species parameters (RimWorld-style growth model, PLAN "Plants as agents"). */
export interface PlantSpecies extends Species {
  kind: 'plant';
  /** Biomass gained per tick at fertility=1 and light=1. */
  baseGrowthRate: number;
  /** Max biomass/health (the energy ceiling). */
  maxEnergy: number;
  /** Ticks to senescence death (old age). */
  lifespan: number;
  /** Fraction of maxEnergy at which a growing/regrowing plant enters fruiting. */
  fruitingThreshold: number;
  /** Grazing below this fraction of maxEnergy triggers the regrowth state. */
  regrowthFloor: number;
  /** Biomass removed per graze event (the harvestable yield). */
  yieldAmount: number;
  /** Biome ids where this species seeds (see worldgen BIOME_*). */
  preferredBiomes: readonly number[];
}

// --- Plant stage machine states (RimWorld model) -------------------------------------------
// seedling → growing → fruiting (repeatable harvest) → regrowth → senescence → death
export const STAGE_SEEDLING = 'seedling';
export const STAGE_GROWING = 'growing';
export const STAGE_FRUITING = 'fruiting';
export const STAGE_REGROWTH = 'regrowth';
export const STAGE_SENESCENCE = 'senescence';

/** Stage → small index, used to pack a render key (stage*16 + growth bucket). */
export const STAGE_INDEX: Record<string, number> = {
  [STAGE_SEEDLING]: 0,
  [STAGE_GROWING]: 1,
  [STAGE_FRUITING]: 2,
  [STAGE_REGROWTH]: 3,
  [STAGE_SENESCENCE]: 4,
};

// --- Animal behaviour states (Phase 4) ----------------------------------------------------
// idle/wander → seekFood → eat → mate; decisions are sampled every few ticks (see animals/base.ts).
export const ANIMAL_STATE_IDLE = 'idle';
export const ANIMAL_STATE_WANDER = 'wander';
export const ANIMAL_STATE_SEEK_FOOD = 'seekFood';
export const ANIMAL_STATE_EAT = 'eat';
export const ANIMAL_STATE_MATE = 'mate';
