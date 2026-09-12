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
