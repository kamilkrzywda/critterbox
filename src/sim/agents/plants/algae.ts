/**
 * Algae (v0.12). The floating surface mat: grows fast, lives short, and SPREADS across open water — its
 * self-seeding drops land on any water cell within the depth window (see PlantSpecies.aquatic), so a few
 * mats creep into a continuous film over time ("flowing on water and just spreading around"). The small
 * exclusion radius keeps the mat dense; the short lifespan + fast growth keep it turning over. Primary fish
 * food — carp/roach graze it in open water, which is what keeps them out of the shallows where they used to
 * strip the shore reed (Phase 6 forensics: pike starved mid-lake while carp clustered at the bank).
 * Self-registers into the species registry at load.
 */

import { registerSpecies } from '../../registry';
import type { PlantSpecies } from '../../types';
import { BIOME_MARSH } from '../../../worldgen/worldgen';

export const ALGAE: PlantSpecies = {
  id: 'algae',
  kind: 'plant',
  displayName: 'algae',
  baseGrowthRate: 0.7, // fast — a bloom doubles in days, not weeks; also regrows quickly after fish grazing (v0.12 stability tuning)
  maxEnergy: 80, // a substantial mat (v0.12 stability forensics): at 25 e a single carp bite (eatAmount 25) KILLED the
  // patch outright, and with no local parent left to self-seed from, grazed areas stayed bare for thousands of ticks
  // while recolonization crept in ≤3 m hops — roach starved in those permanent food deserts. At 80 e a carp needs
  // three bites to strip a mat, so regrowth keeps pace with grazing and the base never locally collapses.
  lifespan: 3600, // ~2 min at 1× — mats turn over quickly and re-spread
  fruitingThreshold: 0.7,
  regrowthFloor: 0.3,
  yieldAmount: 8, // a fish bite takes a small clump
  preferredBiomes: [BIOME_MARSH], // nominal — aquatic placement comes from the depth window, not biomes
  seedExcludeRadius: 2, // dense mat — ~1 patch per 12 m² of open water
  aquatic: { seat: 'surface', minDepth: 0.15 }, // any open water, however shallow; no max (light is fine at the surface)
};

registerSpecies(ALGAE);
