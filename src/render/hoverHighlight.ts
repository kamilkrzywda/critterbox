/**
 * Species-hover highlight (v0.10): an InstancedMesh of rings — one per live agent of the hovered
 * species — reusing the inspector's selection-ring geometry/look with a distinct tint + lower opacity
 * so "many" reads differently from the single active gold selection ring. Only updates while a species
 * is hovered (a null check otherwise), so steady-state frames pay nothing. Initial capacity sits just
 * above the largest animal popCap (insects, 600); plant populations can exceed it, so the buffer grows
 * on demand like AnimalRenderer's and never shrinks back down.
 */

import * as THREE from 'three';
import type { Agent } from '../sim/types';
import { flightAltFor } from './animalGeometry';

/** Initial capacity: just above the largest animal popCap (insects = 600). Plants can exceed it — see grow(). */
export const HOVER_BASE_CAPACITY = 640;

// Ring geometry matches the inspector's selection ring (main.ts): TorusGeometry(2, 0.15, 8, 32), laid flat.
const RING_RADIUS = 2;
const RING_TUBE = 0.15;
/** Distinct tint + ~60% opacity: reads as "many" vs the single active selection (gold @ 0.9). */
const HOVER_COLOR = 0x59c8ff;
const HOVER_OPACITY = 0.55;

export class HoverHighlight {
  /** The ring InstancedMesh — replaced (not mutated) when the buffer grows, hence not readonly. */
  object: THREE.InstancedMesh;
  private parent: THREE.Object3D;
  private speciesId: string | null = null;
  private capacity: number;
  /** Reused per-species working array (no churn across frames). */
  private work: Agent[] = [];
  private tmpMat = new THREE.Matrix4();

  constructor(parent: THREE.Object3D, capacity: number = HOVER_BASE_CAPACITY) {
    this.parent = parent;
    this.capacity = capacity;
    this.object = this.buildMesh(capacity);
  }

  /** Currently highlighted species id (null when nothing is hovered). */
  get species(): string | null { return this.speciesId; }
  /** Live instance count — the debug surface / e2e assert it equals the hovered population. */
  get count(): number { return this.object.count; }

  private buildMesh(capacity: number): THREE.InstancedMesh {
    const geo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 8, 32);
    geo.rotateX(-Math.PI / 2); // lay flat — the rotation is baked in, instances only need a translation
    const mat = new THREE.MeshBasicMaterial({ color: HOVER_COLOR, transparent: true, opacity: HOVER_OPACITY });
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false; // instances span the whole world — never cull by geometry bounds
    this.parent.add(mesh);
    return mesh;
  }

  /** Set (or clear) the highlighted species. Clearing zeroes the instances immediately. */
  setSpecies(id: string | null): void {
    if (this.speciesId === id) return;
    this.speciesId = id;
    if (!id) {
      this.work.length = 0;
      this.object.count = 0;
    }
  }

  /** Refresh instance positions for the hovered species. Call once per frame — a no-op (one null check)
   *  when nothing is hovered, so only hovering costs anything. */
  sync(agents: Agent[]): void {
    const id = this.speciesId;
    if (!id) return; // not hovering — zero cost
    const alt = flightAltFor(id); // flying agents of the hovered species sit higher — shared lookup (animalGeometry.ts)
    const w = this.work;
    w.length = 0;
    for (const a of agents) if (a.species === id) w.push(a);
    if (w.length > this.capacity) {
      this.grow(Math.ceil(w.length * 1.5)); // plant populations can exceed the animal-cap-sized buffer
    }
    for (let i = 0; i < w.length; i++) {
      const a = w[i];
      this.tmpMat.makeTranslation(a.pos.x, a.pos.y + 0.15 + (a.data?.flying ? alt : 0), a.pos.z); // ground offset (+ flight altitude while airborne)
      this.object.setMatrixAt(i, this.tmpMat);
    }
    this.object.count = w.length;
    this.object.instanceMatrix.needsUpdate = true; // full upload (≤ few thousand instances — fine)
  }

  /** Grow the GPU buffer when the hovered population exceeds capacity (plants). Never shrinks back. */
  private grow(newCap: number): void {
    const old = this.object;
    this.parent.remove(old);
    old.geometry.dispose();
    (old.material as THREE.Material).dispose();
    this.capacity = newCap;
    this.object = this.buildMesh(newCap);
  }

  /** Free GPU resources and detach (teardown). */
  dispose(): void {
    this.setSpecies(null);
    this.parent.remove(this.object);
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}
