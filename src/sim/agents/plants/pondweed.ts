/**
 * Pondweed (v0.12). The bigger bottom plant: anchored on the river/lake floor, growing up through the water
 * column — a submerged bed fish can graze without surfacing. Needs a real bottom (minDepth) and light
 * penetration (maxDepth — no pondweed in the deepest basin centres). Slower-growing and longer-lived than
 * algae; primary fish food alongside it. Self-registers into the species registry at load.
 */

import { registerSpecies } from '../../registry';
import type { PlantSpecies } from '../../types';
import { BIOME_MARSH } from '../../../worldgen/worldgen';

export const PONDWEED: PlantSpecies = {
  id: 'pondweed',
  kind: 'plant',
  displayName: 'pondweed',
  baseGrowthRate: 0.3,
  maxEnergy: 90, // a substantial submerged clump
  lifespan: 7200, // ~4 min at 1× — outlives the algae mats it grows beside
  fruitingThreshold: 0.8,
  regrowthFloor: 0.35,
  yieldAmount: 15,
  preferredBiomes: [BIOME_MARSH], // nominal — aquatic placement comes from the depth window, not biomes
  seedExcludeRadius: 4, // spaced beds, not a continuous mat
  aquatic: { seat: 'bottom', minDepth: 0.6, maxDepth: 3.5 }, // needs floor + light; nothing in the deep centre
};

registerSpecies(PONDWEED);
