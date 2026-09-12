/**
 * drzewo — tree. The forest's structure: tall, very long-lived, provides browse/nest habitat (Phase 4+).
 * One species with three visual variants chosen by biome at seeding and stored on agent.variant:
 *   0 = brzoza (birch), 1 = dąb (oak), 2 = świerk (pine) — see render/plants.ts for their look.
 * Self-registers into the species registry at load.
 */

import { registerSpecies } from '../../registry';
import type { PlantSpecies } from '../../types';
import { BIOME_FOREST } from '../../../worldgen/worldgen';

/** Tree variant ids (stored on Agent.variant, chosen by biome/moisture at seeding). */
export const TREE_VARIANT_BIRCH = 0;
export const TREE_VARIANT_OAK = 1;
export const TREE_VARIANT_PINE = 2;

/**
 * World-space size of a FULL-GROWTH tree in meters (trunk + canopy), the single source of truth for the
 * tree geometry in render/plants.ts. Sanity targets: total height 8–15 m and canopy radius 3–6 m — trees
 * must be the dominant vertical feature of forest biomes (a full-growth deer is ~2 m tall). The growth
 * scale (0.2 → 1.0 with energy) means seedlings are ~2.4 m and mature trees exactly TREE_WORLD_HEIGHT.
 */
export const TREE_WORLD_HEIGHT = 12; // trunk + canopy, within the 8–15 m band
export const TREE_CANOPY_RADIUS = 4; // within the 3–6 m band
/** Lower bound of the sanity band — regression checks assert no animal's max body height exceeds this. */
export const TREE_MIN_TOTAL_HEIGHT = 8;

export const TREE: PlantSpecies = {
  id: 'tree',
  kind: 'plant',
  displayName: 'drzewo (tree)',
  baseGrowthRate: 0.25, // slow — trees take their time to reach full canopy
  maxEnergy: 400,
  lifespan: 36000, // ~20 min — the longest-lived agents in Phase 3
  fruitingThreshold: 0.7,
  regrowthFloor: 0.4,
  yieldAmount: 60,
  preferredBiomes: [BIOME_FOREST],
  seedExcludeRadius: 8, // big canopy — wide exclusion keeps self-seeded forest spread bounded (Phase 5)
};

registerSpecies(TREE);
