/**
 * Clover. A fertile-meadow forage with a modest yield; forms patches among the grass.
 * Self-registers into the species registry at load.
 */

import { registerSpecies } from '../../registry';
import type { PlantSpecies } from '../../types';
import { BIOME_MEADOW } from '../../../worldgen/worldgen';

export const CLOVER: PlantSpecies = {
  id: 'clover',
  kind: 'plant',
  displayName: 'Clover',
  baseGrowthRate: 0.4,
  maxEnergy: 90,
  lifespan: 7200, // ~4 min
  fruitingThreshold: 0.8,
  regrowthFloor: 0.35,
  yieldAmount: 20,
  preferredBiomes: [BIOME_MEADOW],
};

registerSpecies(CLOVER);
