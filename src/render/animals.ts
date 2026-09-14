/**
 * Instanced animal rendering (Phase 4, multi-part v0.11): one InstancedMesh PER BODY PART per registered
 * ANIMAL species — merged boxy geometries sized by the species' bodySize (world-space meters at the mid
 * size trait; see animalGeometry.ts), per-instance scale from visualScale() (size trait mapped onto a ±25%
 * band around it — see base.ts), yaw from the sim-tracked movement heading (data.heading — animals face
 * where they're going; +Z is the front axis, see writeMatrix), deterministic colour jitter from agent id +
 * species palette. Birds carry two extra wing parts that flap per instance while a.data.flying is set
 * (flap phase from the sim step threaded through sync); airborne birds also render at their species'
 * flight altitude above the sim seat. Animal counts are low hundreds, so every live instance's matrices
 * are rewritten each frame (no dirty-set needed at this scale; colours upload only on population change).
 * Generic over the registry: a new animal species module auto-appears here once registered — its palette
 * falls back to a neutral brown until added to PALETTES, and its body plan falls back to a plain box.
 */

import * as THREE from 'three';
import type { Agent } from '../sim/types';
import { getSpecies } from '../sim/registry';
import type { AnimalSpecies } from '../sim/agents/animals/base';
import { visualScale } from '../sim/agents/animals/base';
import { agentRand } from '../sim/rng';
import { buildAnimalParts, flightAltFor, type PartRole } from './animalGeometry';

type RGB = [number, number, number];

/** Base palette per animal species id; unknown species fall back to a neutral brown. */
const PALETTES: Record<string, RGB> = {
  mouse: [0.52, 0.45, 0.36], // grey-brown
  hare: [0.55, 0.42, 0.28], // medium brown hare
  hamster: [0.72, 0.6, 0.42], // tan stocky hamster
  deer: [0.55, 0.33, 0.22], // large reddish-brown roe deer
  insect: [0.16, 0.14, 0.12], // tiny dark speck (insect)
  frog: [0.3, 0.58, 0.2], // green low body near water (frog)
  fox: [0.78, 0.38, 0.14], // orange-red fox
  stork: [0.9, 0.87, 0.82], // white stork (the red bill/legs hint is left to the jitter)
  owl: [0.45, 0.32, 0.2], // brown round owl
  crow: [0.1, 0.1, 0.12], // small black crow
  carp: [0.72, 0.58, 0.3], // golden-brown river carp (visible through the translucent water plane)
  pike: [0.42, 0.5, 0.28], // olive-green elongated pike
  roach: [0.56, 0.6, 0.44], // small silvery-olive forage fish (visible through the translucent water plane)
  trout: [0.72, 0.55, 0.45], // silver with reddish flanks (the flank tint is left to the jitter)
  duck: [0.44, 0.46, 0.3], // mallard-like brown-green marsh band dweller
};
const FALLBACK: RGB = [0.5, 0.42, 0.3];
/** Per-instance colour jitter amount (fraction of the base channel). */
const JITTER = 0.3;

// Wing flap while flying: amplitude in radians + angular speed per sim step (~5 flaps/s at 30 steps/s —
// reads as flapping, not vibration), phase salt distinct from heading (0x7a11) and colour (0x40+k).
const FLAP_AMP = 0.9;
const FLAP_OMEGA = 1.1;
const FLAP_PHASE_SALT = 0xf1e2;
/** Unit scale for composing the wing shoulder matrices (shared — never mutated). */
const ONE_SCALE = new THREE.Vector3(1, 1, 1);

/** One rendered body part: an InstancedMesh + its role ('body' | 'wingL' | 'wingR'). Wings carry the
 *  local-frame shoulder offset (flap pivot on the body's side) from animalGeometry.ts. */
interface Part {
  role: PartRole;
  geo: THREE.BufferGeometry; // shared across grows — only the InstancedMesh buffer is rebuilt
  mesh: THREE.InstancedMesh;
  shoulder?: [number, number, number];
}

interface SpeciesRender {
  id: string;
  parts: Part[]; // body first, then wings (birds) — slot i in every part = the same agent
  agents: Agent[]; // slot i → live agent (copy of refs)
  capacity: number;
  body: [number, number, number]; // species bodySize in meters at the mid size trait
  sp: AnimalSpecies; // species table — visualScale reads its size-trait bounds per instance
  material: THREE.Material; // one white vertex-coloured Lambert shared by all parts of this species
}

export class AnimalRenderer {
  readonly group = new THREE.Group();
  private bySpecies = new Map<string, SpeciesRender>();
  /** Reused per-species working arrays for grouping the flat agent list each sync (no churn). */
  private work = new Map<string, Agent[]>();
  private tmpMat = new THREE.Matrix4();
  private tmpMat2 = new THREE.Matrix4(); // wing: T(shoulder)·Rz(flap), multiplied onto the body matrix
  private tmpColor = new THREE.Color();
  private tmpPos = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  private tmpQuat2 = new THREE.Quaternion(); // wing flap rotation (Z axis)
  private tmpEuler = new THREE.Euler();
  private tmpScale = new THREE.Vector3();

  get object(): THREE.Group { return this.group; }

  /** Raycast against this renderer's instanced meshes (one per body part per species); returns the
   *  NEAREST hit as {agent, distance} or null. Used by the entity inspector click-pick (Phase 8). The
   *  instanced bounding sphere is recomputed first: three.js caches it after the first raycast and never
   *  refreshes it, but animals move every tick — a stale sphere would make clicks on relocated animals miss. */
  pickAgent(raycaster: THREE.Raycaster): { agent: Agent; distance: number } | null {
    let best: { agent: Agent; distance: number } | null = null;
    for (const sr of this.bySpecies.values()) {
      if (sr.agents.length === 0) continue;
      for (const p of sr.parts) {
        p.mesh.computeBoundingSphere(); // keep the culling sphere fresh — see above
        const hits = raycaster.intersectObject(p.mesh, false);
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

  /** Sync the rendered instances to the sim's live animal agents (flat list). Call once per frame.
   *  `step` is the current sim stepCount — drives the wing-flap phase for flying birds. */
  sync(agents: Agent[], step: number): void {
    for (const arr of this.work.values()) arr.length = 0;
    for (const a of agents) {
      if (getSpecies(a.species)?.kind !== 'animal') continue; // plants have their own renderer
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
      this.syncSpecies(spId, arr, step);
    }
    // Species that dropped to zero → hide.
    for (const [spId, sr] of this.bySpecies) {
      if (!seen.has(spId)) {
        sr.agents.length = 0;
        for (const p of sr.parts) p.mesh.count = 0;
      }
    }
  }

  private syncSpecies(spId: string, arr: Agent[], step: number): void {
    let sr = this.bySpecies.get(spId);
    if (!sr) {
      const sp = getSpecies(spId) as AnimalSpecies;
      sr = this.createSpeciesRender(spId, sp, Math.max(arr.length, 16));
      this.bySpecies.set(spId, sr);
    }

    // Population changed → reassign slots + upload colours (static per agent id).
    if (sr.agents.length !== arr.length || idsDiffer(sr.agents, arr)) {
      if (arr.length > sr.capacity) this.growCapacity(sr, Math.ceil(arr.length * 1.5));
      sr.agents = arr.slice(); // copy of live refs; sim compacts in place so order is stable
      for (let i = 0; i < arr.length; i++) this.writeColor(sr, i, arr[i]);
      for (const p of sr.parts) if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }

    // Every frame: rewrite all live matrices — positions change each tick and counts are low hundreds.
    for (let i = 0; i < arr.length; i++) this.writeMatrix(sr, i, arr[i], step);
    for (const p of sr.parts) {
      p.mesh.count = arr.length;
      p.mesh.instanceMatrix.needsUpdate = true; // full upload (no ranges at this scale)
    }
  }

  private createSpeciesRender(spId: string, sp: AnimalSpecies, capacity: number): SpeciesRender {
    const partGeos = buildAnimalParts(spId, sp.bodySize); // merged boxy parts — see animalGeometry.ts
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }); // white base → instanceColor × vertex tint show through
    const parts: Part[] = partGeos.map((pg) => {
      const mesh = this.makePartMesh(pg.geometry, material, capacity);
      return { role: pg.role, geo: pg.geometry, mesh, shoulder: pg.shoulder };
    });
    return { id: spId, parts, agents: [], capacity, body: sp.bodySize, sp, material };
  }

  private makePartMesh(geo: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false; // instances span the whole world — never cull by geometry bounds
    this.group.add(mesh);
    return mesh;
  }

  /** Grow the GPU buffer when population exceeds capacity (mice breed). Geometries + material persist —
   *  only each part's InstancedMesh instance buffers are rebuilt. */
  private growCapacity(sr: SpeciesRender, newCap: number): void {
    for (const p of sr.parts) {
      this.group.remove(p.mesh);
      p.mesh.dispose(); // frees the instance attribute buffers; geo/material stay shared
      p.mesh = this.makePartMesh(p.geo, sr.material, newCap);
    }
    sr.capacity = newCap;
  }

  /** Compose one instance's matrices: position on terrain × yaw from the sim-tracked movement heading ×
   *  visual-scale. The geometry's FRONT axis is +Z — bodySize's depth dimension, the longest horizontal
   *  extent for every species (see each species' bodySize comment), so an unrotated box "faces" +Z. The sim
   *  stores each animal's heading as atan2(dz, dx) of its last actual displacement (data.heading, base.ts
   *  moveToward; kept while idle); yaw = π/2 − heading maps that direction onto the local +Z axis (a three.js
   *  Y-rotation sends +Z to (sin θ, cos θ)). Animals that never moved keep a fixed per-id orientation so the
   *  scene doesn't read as one aligned grid. The size trait is mapped through visualScale (full trait range →
   *  ±25% around the species' bodySize in meters) — never a raw multiplier, so no individual can render at
   *  several-meters scale regardless of trait drift.
   *
   *  Body part: T(pos)·Ry(yaw)·S(s) — exactly the single-box convention; flying birds (a.data.flying set)
   *  additionally sit at their species' flight altitude above the sim seat (the sim keeps pos.y at ground/
   *  water level while airborne). Wing parts: T(pos)·Ry(yaw)·S(s)·T(shoulder)·Rz(flap) — the shoulder offset
   *  is scaled by S so wings stay glued to the body's side surface at any visual scale; flap = A·sin(step·ω +
   *  per-id phase) while flying, 0 (folded pose hugging the body) when grounded. */
  private writeMatrix(sr: SpeciesRender, slot: number, a: Agent, step: number): void {
    const s = visualScale(sr.sp, a.traits?.size ?? (sr.sp.traits.size.min + sr.sp.traits.size.max) / 2);
    const flying = !!a.data?.flying; // sim contract: 1 while airborne, absent/0 otherwise
    this.tmpPos.set(a.pos.x, a.pos.y + (flying ? flightAltFor(sr.id) : 0), a.pos.z);
    const heading = a.data?.heading ?? agentRand(a.id, 0x7a11) * Math.PI * 2; // unmoved animals keep a fixed per-id orientation
    this.tmpEuler.set(0, Math.PI / 2 - heading, 0);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    this.tmpScale.set(s, s, s);
    this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale); // T(pos)·Ry(yaw)·S(s) — the body matrix
    const flap = flying ? FLAP_AMP * Math.sin(step * FLAP_OMEGA + agentRand(a.id, FLAP_PHASE_SALT) * Math.PI * 2) : 0;
    for (const p of sr.parts) {
      if (p.role === 'body') {
        p.mesh.setMatrixAt(slot, this.tmpMat);
        continue;
      }
      // Wing: multiply T(shoulder)·Rz(flap) onto the body matrix. The +X wing raises with a positive Z
      // rotation, the −X wing with a negative one — opposite signs keep both wings flapping in unison.
      const sign = p.role === 'wingL' ? 1 : -1;
      this.tmpPos.set(p.shoulder![0], p.shoulder![1], p.shoulder![2]);
      this.tmpEuler.set(0, 0, sign * flap);
      this.tmpQuat2.setFromEuler(this.tmpEuler);
      this.tmpMat2.compose(this.tmpPos, this.tmpQuat2, ONE_SCALE); // T(shoulder)·Rz(flap)
      this.tmpMat2.premultiply(this.tmpMat); // (T(pos)·Ry(yaw)·S(s)) · (T(shoulder)·Rz(flap))
      p.mesh.setMatrixAt(slot, this.tmpMat2);
    }
  }

  /** Deterministic per-instance colour jitter within the species palette (agentRand by id) — uploaded to
   *  every part so all of one agent's boxes share a single tint. */
  private writeColor(sr: SpeciesRender, slot: number, a: Agent): void {
    const base = PALETTES[sr.id] ?? FALLBACK;
    const j = (k: number) => clamp01(base[k] * (1 + (agentRand(a.id, 0x40 + k) - 0.5) * JITTER));
    this.tmpColor.setRGB(j(0), j(1), j(2));
    for (const p of sr.parts) p.mesh.setColorAt(slot, this.tmpColor);
  }

  /** Free all GPU resources and detach the group (world teardown / New World). */
  dispose(): void {
    for (const sr of this.bySpecies.values()) {
      for (const p of sr.parts) {
        this.group.remove(p.mesh);
        p.mesh.dispose(); // instance attribute buffers
        p.geo.dispose();
      }
      (sr.material as THREE.Material).dispose();
    }
    this.bySpecies.clear();
    this.work.clear();
  }
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
