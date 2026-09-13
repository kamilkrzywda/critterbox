/**
 * Cranberry. A low marsh shrub with a generous berry yield; the main fruiting plant of
 * wet ground near the waterline. Self-registers into the species registry at load.
 */

import { registerSpecies } from '../../registry';
import type { PlantSpecies } from '../../types';
import { BIOME_MARSH } from '../../../worldgen/worldgen';

export const CRANBERRY: PlantSpecies = {
  id: 'cranberry',
  kind: 'plant',
  displayName: 'Cranberry',
  baseGrowthRate: 0.35,
  maxEnergy: 120,
  lifespan: 9000, // ~5 min
  fruitingThreshold: 0.75,
  regrowthFloor: 0.4,
  yieldAmount: 30,
  preferredBiomes: [BIOME_MARSH],
};

registerSpecies(CRANBERRY);
