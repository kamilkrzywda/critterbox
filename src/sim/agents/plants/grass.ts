/**
 * Grass. The base herb: fast-growing, short-lived, grazed hard by every herbivore. Seeds on
 * nearly every dry biome as the dominant ground cover. Self-registers into the species registry at load.
 */

import { registerSpecies } from '../../registry';
import type { PlantSpecies } from '../../types';
import { BIOME_FOREST, BIOME_GRASSLAND, BIOME_MARSH, BIOME_MEADOW } from '../../../worldgen/worldgen';

export const GRASS: PlantSpecies = {
  id: 'grass',
  kind: 'plant',
  displayName: 'grass',
  baseGrowthRate: 0.5, // ~150 ticks to fruiting at full fertility+light
  maxEnergy: 100,
  lifespan: 5400, // ~3 min of sim time before senescence
  fruitingThreshold: 0.8,
  regrowthFloor: 0.35,
  yieldAmount: 25,
  preferredBiomes: [BIOME_MEADOW, BIOME_GRASSLAND, BIOME_FOREST, BIOME_MARSH],
};

registerSpecies(GRASS);
