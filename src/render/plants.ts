/**
 * Instanced plant rendering (PLAN "render/plants.ts"): one InstancedMesh per species (trees use a second
 * canopy mesh sharing the same slot mapping), procedural geometry only, per-instance colour jitter from
 * agentRand. Incremental updates via a dirty-set / change-feed (Sandfall pattern): an instance's matrix is
 * recomposed and re-uploaded ONLY when its stage/growth bucket changes or it spawns/dies — steady-state
 * frames touch almost nothing, so ~10k+ instances stay smooth. Partial GPU uploads use addUpdateRange.
 */

import * as THREE from 'three';
import type { Agent } from '../sim/types';
import { STAGE_INDEX, STAGE_SENESCENCE } from '../sim/types';
import { getSpecies } from '../sim/registry';
import type { PlantSpecies } from '../sim/types';
import { agentRand } from '../sim/rng';
import { TREE_CANOPY_RADIUS, TREE_WORLD_HEIGHT } from '../sim/agents/plants/tree';

/** Withered brown that senescent plants mix toward. */
const WITHER: [number, number, number] = [0.45, 0.36, 0.19];
/** Per-instance colour jitter amount (fraction of the base channel). */
const JITTER = 0.28;

type RGB = [number, number, number];

interface SpeciesRender {
  id: string;
  meshes: THREE.InstancedMesh[]; // [main] or [trunk, canopy] for trees — share slot mapping
  agents: Agent[]; // slot i → live agent (copy of refs)
  lastKey: Int32Array; // per-slot packed render key (stage*16 + growth bucket)
  capacity: number; // max instances allocated in the GPU buffers
  maxEnergy: number; // species max energy (for the growth fraction)
  colorFns: ((variant: number, stage: string) => RGB)[]; // aligned with meshes
}

// --- procedural geometry (base at y=0 so scaling from origin grows upward) -------------------

function coneGeo(r: number, h: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(0, h / 2, 0);
  return g;
}
function bushGeo(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.55, 7, 5);
  g.scale(1, 0.72, 1);
  g.translate(0, 0.4, 0);
  return g;
}
/** Trunk: the lower half of TREE_WORLD_HEIGHT (y 0 → H/2), tapering from a ~1 m base to a ~0.7 m crown. */
function trunkGeo(): THREE.BufferGeometry {
  const h = TREE_WORLD_HEIGHT / 2;
  const g = new THREE.CylinderGeometry(0.35, 0.55, h, 6);
  g.translate(0, h / 2, 0);
  return g;
}
/** Canopy: a cone from y ≈ H/2 − 1 (overlapping the crown) up to exactly TREE_WORLD_HEIGHT, radius
 *  TREE_CANOPY_RADIUS — at full growth the tree totals TREE_WORLD_HEIGHT meters. */
function canopyGeo(): THREE.BufferGeometry {
  const base = TREE_WORLD_HEIGHT / 2 - 1; // cone base slightly below mid-height so trunk + canopy read as one mass
  const h = TREE_WORLD_HEIGHT - base;
  const g = new THREE.ConeGeometry(TREE_CANOPY_RADIUS, h, 8);
  g.translate(0, base + h / 2, 0);
  return g;
}

// --- palettes ---------------------------------------------------------------------------------

const PAL: Record<string, RGB> = {
  grass: [0.36, 0.62, 0.24],
  clover: [0.45, 0.7, 0.32],
  reed: [0.58, 0.64, 0.3],
  cranberry: [0.34, 0.48, 0.26],
};

function trunkColor(v: number): RGB {
  return v === 0 ? [0.82, 0.8, 0.74] : [0.42, 0.3, 0.2]; // birch pale vs oak/pine brown
}
function canopyColor(v: number): RGB {
  if (v === 0) return [0.46, 0.63, 0.31]; // birch
  if (v === 1) return [0.25, 0.45, 0.22]; // oak
  return [0.17, 0.34, 0.22]; // pine
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Build the geometry(s) + colour function(s) for a species. */
function buildVisual(spId: string): { geos: THREE.BufferGeometry[]; colorFns: ((v: number, s: string) => RGB)[] } {
  const wither = (base: RGB, t: number) => (stage: string) => mix(base, WITHER, stage === STAGE_SENESCENCE ? t : 0);
  switch (spId) {
    case 'grass': return { geos: [coneGeo(0.28, 1.4, 5)], colorFns: [(_v, s) => wither(PAL.grass, 0.7)(s)] };
    case 'clover': return { geos: [coneGeo(0.35, 0.7, 6)], colorFns: [(_v, s) => wither(PAL.clover, 0.7)(s)] };
    case 'reed': return { geos: [coneGeo(0.12, 2.2, 4)], colorFns: [(_v, s) => wither(PAL.reed, 0.65)(s)] };
    case 'cranberry': return { geos: [bushGeo()], colorFns: [(_v, s) => wither(PAL.cranberry, 0.7)(s)] };
    case 'tree':
      return {
        geos: [trunkGeo(), canopyGeo()],
        colorFns: [
          (v) => trunkColor(v), // trunks keep their bark colour even when senescent
          (v, s) => mix(canopyColor(v), WITHER, s === STAGE_SENESCENCE ? 0.6 : 0),
        ],
      };
    default: return { geos: [coneGeo(0.3, 1, 5)], colorFns: [(_v, s) => wither([0.4, 0.6, 0.3], 0.7)(s)] };
  }
}

// --- renderer ---------------------------------------------------------------------------------

export class PlantRenderer {
  readonly group = new THREE.Group();
  private bySpecies = new Map<string, SpeciesRender>();
  /** Reused per-species working arrays for grouping the flat agent list each sync (no churn). */
  private work = new Map<string, Agent[]>();
  private tmpMat = new THREE.Matrix4();
  private tmpColor = new THREE.Color();

  get object(): THREE.Group { return this.group; }

  /** Species ids currently instanced by this renderer — the debug surface / e2e use it to assert that no
   *  animal species ever leaks into plant rendering (see sync's kind filter). */
  speciesIds(): string[] {
    return [...this.bySpecies.keys()];
  }

  /** Raycast against this renderer's instanced meshes (every species, every sub-mesh — trees' trunk +
   *  canopy share the slot mapping); returns the NEAREST hit as {agent, distance} or null. Used by the
   *  entity inspector click-pick (Phase 8) — a click is rare, so O(instances) per mesh is fine. The
   *  instanced bounding sphere is recomputed first: three.js caches it after the first raycast and never
   *  refreshes it, but instances move every tick (animals) / spawn over time (plants). */
  pickAgent(raycaster: THREE.Raycaster): { agent: Agent; distance: number } | null {
    let best: { agent: Agent; distance: number } | null = null;
    for (const sr of this.bySpecies.values()) {
      if (sr.agents.length === 0) continue;
      for (const m of sr.meshes) {
        m.computeBoundingSphere(); // keep the culling sphere fresh — see above
        const hits = raycaster.intersectObject(m, false);
        for (const h of hits) {
          if (h.instanceId === undefined || h.distance >= (best ? best.distance : Infinity)) continue;
          const a = sr.agents[h.instanceId]; // slot → live agent (see sync's slot mapping)
          if (!a) continue;
          best = { agent: a, distance: h.distance };
        }
      }
    }
    return best;
  }

  /** Sync the rendered instances to the sim's live PLANT agents (flat list). Call once per frame. */
  sync(agents: Agent[]): void {
    for (const arr of this.work.values()) arr.length = 0;
    for (const a of agents) {
      if (getSpecies(a.species)?.kind !== 'plant') continue; // animals have their own renderer — without
        // this filter every animal is ALSO instanced here as a generic cone that follows the animal, which
        // reads as "plants moving" (the mirror image of AnimalRenderer's plant filter)
      let arr = this.work.get(a.species);
      if (!arr) {
        arr = [];
        this.work.set(a.species, arr);
      }
      arr.push(a);
    }

    const seen = new Set<string>();
    for (const [spId, arr] of this.work) {
      seen.add(spId);
      this.syncSpecies(spId, arr);
    }
    // Species that dropped to zero → hide.
    for (const [spId, sr] of this.bySpecies) {
      if (!seen.has(spId)) {
        sr.agents.length = 0;
        for (const m of sr.meshes) m.count = 0;
      }
    }
  }

  private syncSpecies(spId: string, arr: Agent[]): void {
    let sr = this.bySpecies.get(spId);
    if (!sr) {
      sr = this.createSpeciesRender(spId, Math.max(arr.length, 1));
      this.bySpecies.set(spId, sr);
    }

    const popChanged = sr.agents.length !== arr.length || idsDiffer(sr.agents, arr);
    if (popChanged) {
      this.rebuildSpecies(sr, arr); // spawns/deaths → reassign slots + full upload
      return;
    }

    // Incremental: only recompose instances whose stage/growth bucket changed.
    const dirtySlots: number[] = [];
    for (let i = 0; i < arr.length; i++) {
      const key = renderKey(arr[i], sr.maxEnergy);
      if (key === sr.lastKey[i]) continue;
      sr.lastKey[i] = key;
      this.writeInstance(sr, i, arr[i]);
      dirtySlots.push(i);
    }
    if (dirtySlots.length > 0) this.flushRanges(sr, dirtySlots);
  }

  private createSpeciesRender(spId: string, initialCount: number): SpeciesRender {
    const sp = getSpecies(spId) as PlantSpecies;
    const capacity = Math.max(64, Math.ceil(initialCount * 1.3));
    const { geos, colorFns } = buildVisual(spId);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff }); // white base → instanceColor shows through
    const meshes = geos.map((geo) => {
      const mesh = new THREE.InstancedMesh(geo, material, capacity);
      mesh.count = 0;
      mesh.frustumCulled = false; // instances span the whole world — never cull by geometry bounds
      this.group.add(mesh);
      return mesh;
    });
    return { id: spId, meshes, agents: [], lastKey: new Int32Array(capacity), capacity, maxEnergy: sp.maxEnergy, colorFns };
  }

  /** Reassign slots to the current agent list and upload every instance (population changed). */
  private rebuildSpecies(sr: SpeciesRender, arr: Agent[]): void {
    if (arr.length > sr.capacity) this.growCapacity(sr, Math.ceil(arr.length * 1.3));
    sr.agents = arr.slice(); // copy of live refs; sim compacts in place so order is stable
    for (let i = 0; i < arr.length; i++) {
      this.writeInstance(sr, i, arr[i]);
      sr.lastKey[i] = renderKey(arr[i], sr.maxEnergy);
    }
    for (const m of sr.meshes) {
      m.count = arr.length;
      m.instanceMatrix.needsUpdate = true; // full upload (no ranges → whole buffer)
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  /** Grow the GPU buffers when population exceeds capacity (rare — plants don't spawn in Phase 3). */
  private growCapacity(sr: SpeciesRender, newCap: number): void {
    for (const m of sr.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    const { geos, colorFns } = buildVisual(sr.id);
    sr.capacity = newCap;
    sr.lastKey = new Int32Array(newCap);
    sr.colorFns = colorFns; // maxEnergy is unchanged by growth (already stored on sr)
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    sr.meshes = geos.map((geo) => {
      const mesh = new THREE.InstancedMesh(geo, material, newCap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    });
  }

  /** Compose one instance's matrix + colour(s) into the GPU buffers at `slot`. */
  private writeInstance(sr: SpeciesRender, slot: number, a: Agent): void {
    const f = sr.maxEnergy > 0 ? a.energy / sr.maxEnergy : 1;
    let s = 0.2 + 0.8 * f; // scale encodes growth stage (seedlings small → mature full)
    if (a.state === STAGE_SENESCENCE) s *= 0.9; // withered plants shrink a touch
    this.tmpMat.set(s, 0, 0, a.pos.x, 0, s, 0, a.pos.y, 0, 0, s, a.pos.z, 0, 0, 0, 1);
    const variant = a.variant ?? 0;
    for (let mi = 0; mi < sr.meshes.length; mi++) {
      sr.meshes[mi].setMatrixAt(slot, this.tmpMat);
      const base = sr.colorFns[mi](variant, a.state);
      const c = this.jitter(base, a.id, mi);
      sr.meshes[mi].setColorAt(slot, this.tmpColor.setRGB(c[0], c[1], c[2]));
    }
  }

  /** Deterministic per-instance colour jitter within the species palette (agentRand by id). */
  private jitter(base: RGB, id: number, meshIdx: number): RGB {
    const r = clamp01(base[0] * (1 + (agentRand(id, 0x10 + meshIdx) - 0.5) * JITTER));
    const g = clamp01(base[1] * (1 + (agentRand(id, 0x20 + meshIdx) - 0.5) * JITTER));
    const b = clamp01(base[2] * (1 + (agentRand(id, 0x30 + meshIdx) - 0.5) * JITTER));
    return [r, g, b];
  }

  /** Upload only the changed slots' matrix + colour ranges to the GPU. */
  private flushRanges(sr: SpeciesRender, slots: number[]): void {
    for (const m of sr.meshes) {
      const im = m.instanceMatrix;
      im.clearUpdateRanges();
      for (const s of slots) im.addUpdateRange(s * 16, 16);
      im.needsUpdate = true;
      if (m.instanceColor) {
        const ic = m.instanceColor;
        ic.clearUpdateRanges();
        for (const s of slots) ic.addUpdateRange(s * 3, 3);
        ic.needsUpdate = true;
      }
    }
  }

  /** Free all GPU resources and detach the group (world teardown / New World). */
  dispose(): void {
    for (const sr of this.bySpecies.values()) {
      for (const m of sr.meshes) {
        this.group.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    }
    this.bySpecies.clear();
    this.work.clear();
  }
}

/** Packed render key: stage index ×16 + growth bucket (0..7) — changes only on meaningful visual change. */
function renderKey(a: Agent, maxEnergy: number): number {
  const f = maxEnergy > 0 ? a.energy / maxEnergy : 1;
  const bucket = Math.min(7, Math.floor(f * 8));
  return (STAGE_INDEX[a.state] ?? 0) * 16 + bucket;
}

/** True when two same-length agent lists differ in id at any slot. */
function idsDiffer(a: Agent[], b: Agent[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i].id !== b[i].id) return true;
  return false;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
