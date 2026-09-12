/**
 * Instanced animal rendering (Phase 4): one InstancedMesh per registered ANIMAL species — procedural
 * box geometry sized by the species' bodySize (world-space meters at the mid size trait), per-instance
 * scale from visualScale() (size trait mapped onto a ±25% band around it — see base.ts), deterministic
 * colour jitter from agent id + species palette. Animal counts are low hundreds, so every live
 * instance's matrix is rewritten each frame (no dirty-set needed at this scale; colours upload only on
 * population change). Generic over the registry: a new animal species module auto-appears here once
 * registered — its palette falls back to a neutral brown until added to PALETTES.
 */

import * as THREE from 'three';
import type { Agent } from '../sim/types';
import { getSpecies } from '../sim/registry';
import type { AnimalSpecies } from '../sim/agents/animals/base';
import { visualScale } from '../sim/agents/animals/base';
import { agentRand } from '../sim/rng';

type RGB = [number, number, number];

/** Base palette per animal species id; unknown species fall back to a neutral brown. */
const PALETTES: Record<string, RGB> = {
  mysz: [0.52, 0.45, 0.36], // grey-brown
  zajac: [0.55, 0.42, 0.28], // medium brown hare
  chomik: [0.72, 0.6, 0.42], // tan stocky hamster
  sarna: [0.55, 0.33, 0.22], // large reddish-brown roe deer
  owady: [0.16, 0.14, 0.12], // tiny dark speck (insect)
  zaba: [0.3, 0.58, 0.2], // green low body near water (frog)
  lis: [0.78, 0.38, 0.14], // orange-red fox
  bocian: [0.9, 0.87, 0.82], // white stork (the red bill/legs hint is left to the jitter)
  sowa: [0.45, 0.32, 0.2], // brown round owl
  wrona: [0.1, 0.1, 0.12], // small black crow
};
const FALLBACK: RGB = [0.5, 0.42, 0.3];
/** Per-instance colour jitter amount (fraction of the base channel). */
const JITTER = 0.3;

interface SpeciesRender {
  id: string;
  mesh: THREE.InstancedMesh;
  agents: Agent[]; // slot i → live agent (copy of refs)
  capacity: number;
  body: [number, number, number]; // species bodySize in meters at the mid size trait
  sp: AnimalSpecies; // species table — visualScale reads its size-trait bounds per instance
}

export class AnimalRenderer {
  readonly group = new THREE.Group();
  private bySpecies = new Map<string, SpeciesRender>();
  /** Reused per-species working arrays for grouping the flat agent list each sync (no churn). */
  private work = new Map<string, Agent[]>();
  private tmpMat = new THREE.Matrix4();
  private tmpColor = new THREE.Color();
  private tmpPos = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  private tmpEuler = new THREE.Euler();
  private tmpScale = new THREE.Vector3();

  get object(): THREE.Group { return this.group; }

  /** Sync the rendered instances to the sim's live animal agents (flat list). Call once per frame. */
  sync(agents: Agent[]): void {
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
      this.syncSpecies(spId, arr);
    }
    // Species that dropped to zero → hide.
    for (const [spId, sr] of this.bySpecies) {
      if (!seen.has(spId)) {
        sr.agents.length = 0;
        sr.mesh.count = 0;
      }
    }
  }

  private syncSpecies(spId: string, arr: Agent[]): void {
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
      if (sr.mesh.instanceColor) sr.mesh.instanceColor.needsUpdate = true;
    }

    // Every frame: rewrite all live matrices — positions change each tick and counts are low hundreds.
    for (let i = 0; i < arr.length; i++) this.writeMatrix(sr, i, arr[i]);
    sr.mesh.count = arr.length;
    sr.mesh.instanceMatrix.needsUpdate = true; // full upload (no ranges at this scale)
  }

  private createSpeciesRender(spId: string, sp: AnimalSpecies, capacity: number): SpeciesRender {
    const [bw, bh, bd] = sp.bodySize; // meters at the mid size trait — see visualScale for per-instance scaling
    const geo = new THREE.BoxGeometry(bw, bh, bd);
    geo.translate(0, bh / 2, 0); // base at y=0 so the box sits on the terrain and scales upward
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff }); // white base → instanceColor shows through
    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false; // instances span the whole world — never cull by geometry bounds
    this.group.add(mesh);
    return { id: spId, mesh, agents: [], capacity, body: sp.bodySize, sp };
  }

  /** Grow the GPU buffer when population exceeds capacity (mice breed). */
  private growCapacity(sr: SpeciesRender, newCap: number): void {
    this.group.remove(sr.mesh);
    sr.mesh.geometry.dispose();
    (sr.mesh.material as THREE.Material).dispose();
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const [bw, bh, bd] = sr.body;
    const geo = new THREE.BoxGeometry(bw, bh, bd);
    geo.translate(0, bh / 2, 0);
    sr.capacity = newCap;
    sr.mesh = new THREE.InstancedMesh(geo, material, newCap);
    sr.mesh.count = 0;
    sr.mesh.frustumCulled = false;
    this.group.add(sr.mesh);
  }

  /** Compose one instance's matrix: position on terrain × fixed per-id yaw × visual-scale. The size trait is
   *  mapped through visualScale (full trait range → ±25% around the species' bodySize in meters) — never a
   *  raw multiplier, so no individual can render at several-meters scale regardless of trait drift. */
  private writeMatrix(sr: SpeciesRender, slot: number, a: Agent): void {
    const s = visualScale(sr.sp, a.traits?.size ?? (sr.sp.traits.size.min + sr.sp.traits.size.max) / 2);
    this.tmpPos.set(a.pos.x, a.pos.y, a.pos.z);
    this.tmpEuler.set(0, agentRand(a.id, 0x7a11) * Math.PI * 2, 0); // fixed heading per animal (no velocity stored)
    this.tmpQuat.setFromEuler(this.tmpEuler);
    this.tmpScale.set(s, s, s);
    this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
    sr.mesh.setMatrixAt(slot, this.tmpMat);
  }

  /** Deterministic per-instance colour jitter within the species palette (agentRand by id). */
  private writeColor(sr: SpeciesRender, slot: number, a: Agent): void {
    const base = PALETTES[sr.id] ?? FALLBACK;
    const j = (k: number) => clamp01(base[k] * (1 + (agentRand(a.id, 0x40 + k) - 0.5) * JITTER));
    sr.mesh.setColorAt(slot, this.tmpColor.setRGB(j(0), j(1), j(2)));
  }

  /** Free all GPU resources and detach the group (world teardown / New World). */
  dispose(): void {
    for (const sr of this.bySpecies.values()) {
      this.group.remove(sr.mesh);
      sr.mesh.geometry.dispose();
      (sr.mesh.material as THREE.Material).dispose();
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
