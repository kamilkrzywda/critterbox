/**
 * Water lily (v0.12). The floating flower: a surface pad with a bloom, in mid-depth water (too shallow for
 * the deep basin centre, too deep for the shallows). Long-lived and slow — a persistent patchwork of pads.
 * It is FALLBACK food only ("only eaten if nothing else is seen"): carp/roach/duck list it in
 * fallbackFoodSpecies, so it gets grazed just enough to persist without being stripped while algae and
 * pondweed grow in front of the fish. Self-registers into the species registry at load.
 */

import { registerSpecies } from '../../registry';
import type { PlantSpecies } from '../../types';
import { BIOME_MARSH } from '../../../worldgen/worldgen';

export const WATERLILY: PlantSpecies = {
  id: 'waterlily',
  kind: 'plant',
  displayName: 'water lily',
  baseGrowthRate: 0.25,
  maxEnergy: 70,
  lifespan: 9000, // ~5 min at 1× — pads persist for a long time
  fruitingThreshold: 0.8,
  regrowthFloor: 0.4, // grazed pads recover from a higher floor (the bloom is the point)
  yieldAmount: 12,
  preferredBiomes: [BIOME_MARSH], // nominal — aquatic placement comes from the depth window, not biomes
  seedExcludeRadius: 3,
  aquatic: { seat: 'surface', minDepth: 0.5, maxDepth: 2.5 }, // mid-depth open water only
};

registerSpecies(WATERLILY);
