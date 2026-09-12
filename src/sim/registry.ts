/**
 * Species registry — a plain table keyed by string id (Sandfall behaviour-table pattern: no ECS, no
 * class hierarchy). Each species module self-registers at load time via registerSpecies(); the sim and
 * seedLife read from this single shared map. Pure TS, headlessly testable.
 */

import type { Species } from './types';

/** All registered species, keyed by id. Insertion order = registration (import) order — deterministic. */
export const speciesRegistry: Map<string, Species> = new Map();

/** Register a species at module load. Throws on duplicate ids so typos fail loudly. */
export function registerSpecies(species: Species): void {
  if (speciesRegistry.has(species.id)) throw new Error(`duplicate species id: ${species.id}`);
  speciesRegistry.set(species.id, species);
}

/** Look up a registered species by id (undefined when unknown). */
export function getSpecies(id: string): Species | undefined {
  return speciesRegistry.get(id);
}
