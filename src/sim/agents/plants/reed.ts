/**
 * Reed. Tall wetland grass lining marshes and riverbanks; the classic waterline plant.
 * Self-registers into the species registry at load.
 */

import { registerSpecies } from '../../registry';
import type { PlantSpecies } from '../../types';
import { BIOME_MARSH } from '../../../worldgen/worldgen';

export const REED: PlantSpecies = {
  id: 'reed',
  kind: 'plant',
  displayName: 'Reed',
  baseGrowthRate: 0.45,
  maxEnergy: 110,
  lifespan: 6000, // ~4 min
  fruitingThreshold: 0.8,
  regrowthFloor: 0.35,
  yieldAmount: 25,
  preferredBiomes: [BIOME_MARSH],
};

registerSpecies(REED);
