/**
 * Multi-part boxy animal geometry (v0.11): merged BufferGeometries built from BoxGeometry pieces via
 * mergeGeometries — quadrupeds (body + head + ears + 4 legs), birds (body + head + 2 legs; wings are
 * SEPARATE parts so each instance can flap them independently), fish (elongated body + tail fin). All
 * proportions are parametric off the species' bodySize [bw,bh,bd] in meters at the mid size trait, and
 * every geometry keeps the single-box convention writeMatrix relies on: base at y=0, front axis +Z,
 * total silhouette ≈ bh. Legs/ears/tail carry a slightly darker vertex tint (multiplies with the
 * per-instance colour — see AnimalRenderer's vertexColors material). Unknown species fall back to the
 * plain box so new animal modules auto-appear exactly as before.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type PartRole = 'body' | 'wingL' | 'wingR';

/** One merged geometry + its role; wings additionally carry the local-frame shoulder offset (the flap
 *  pivot, on the body's side surface) used by AnimalRenderer.writeMatrix. */
export interface AnimalPartGeo {
  role: PartRole;
  geometry: THREE.BufferGeometry;
  /** Wing parts only — local (pre-yaw, pre-scale) offset from the body origin to the wing's inner edge. */
  shoulder?: [number, number, number];
}

type BodyPlan = 'quad-small' | 'quad-long' | 'bird' | 'fish';

/** Per-species body plan; anything absent falls back to a plain box (today's look). */
const BODY_PLAN: Record<string, BodyPlan> = {
  mouse: 'quad-small',
  hamster: 'quad-small',
  deer: 'quad-small',
  frog: 'quad-small',
  insect: 'quad-small',
  hare: 'quad-long',
  stork: 'bird',
  owl: 'bird',
  crow: 'bird',
  duck: 'bird',
  carp: 'fish',
  pike: 'fish',
  roach: 'fish',
  trout: 'fish',
};

/** Flight altitude in meters above the sim seat while airborne (a.data.flying === 1). One source of
 *  truth — shared by AnimalRenderer, HoverHighlight and main.ts' selection ring. */
export const FLIGHT_ALT: Record<string, number> = {
  stork: 3.5,
  owl: 3.0,
  crow: 2.5,
  duck: 2.0,
};

/** Flight altitude for a species (0 when it doesn't fly). */
export function flightAltFor(spId: string): number {
  return FLIGHT_ALT[spId] ?? 0;
}

/** Vertex tint for legs/ears/tail — multiplies with the per-instance colour, so it stays per-geometry. */
const DARK = 0.8;

/** Build the merged part geometries for one species (base at y=0, front +Z). Always ≥1 part. */
export function buildAnimalParts(spId: string, bodySize: [number, number, number]): AnimalPartGeo[] {
  const [bw, bh, bd] = bodySize;
  switch (BODY_PLAN[spId]) {
    case 'quad-small': return quadruped(bw, bh, bd, 'small');
    case 'quad-long': return quadruped(bw, bh, bd, 'long');
    case 'bird': return bird(bw, bh, bd);
    case 'fish': return fish(bw, bh, bd);
    default: {
      const g = new THREE.BoxGeometry(bw, bh, bd);
      g.translate(0, bh / 2, 0); // base at y=0 — the original single-box convention
      tint(g, 1);
      return [{ role: 'body', geometry: g }];
    }
  }
}

/** Quadruped: body + square head at front-top + 2 ears on top of the head + 4 legs under the corners.
 *  Ears: 'small' ≈ ⅓ of the head height; 'long' (hare) ≈ 1.5× it and thin. Total height = bh exactly. */
function quadruped(bw: number, bh: number, bd: number, ears: 'small' | 'long'): AnimalPartGeo[] {
  const legH = 0.3 * bh; // legs ≈ 25–35% of total height
  const hw = 0.45 * bw; // head width — ~40–50% of the body width
  const hd = Math.max(hw, 0.35 * bd); // head depth — deep enough to overlap the torso (no neck gap)
  // Head top sits at bh − earH so ears + head fill exactly up to bh; solve for both:
  //   small: earH = hh/3 → 4·earH = 0.38bh;  long: earH = 1.5hh → 2.5·earH = 0.57bh
  const earH = ears === 'long' ? (0.57 * bh) / 2.5 : (0.38 * bh) / 4;
  const headBottom = 0.62 * bh;
  const headTop = bh - earH;

  return [
    { role: 'body', geometry: merge([
      box(bw, 0.42 * bh, 0.8 * bd, 0, legH + 0.21 * bh, -0.1 * bd), // torso — spans most of the length
      box(hw, headTop - headBottom, hd, 0, (headTop + headBottom) / 2, bd / 2 - hd / 2), // head — front face flush at z = bd/2
      // Ears on top of the head — small ≈ ⅓ head size; long/hare thin and 1.5× it.
      box(ears === 'long' ? 0.18 * hw : 0.3 * hw, earH, ears === 'long' ? 0.3 * hd : 0.35 * hd, -0.26 * hw, bh - earH / 2, bd / 2 - 0.3 * hd, DARK),
      box(ears === 'long' ? 0.18 * hw : 0.3 * hw, earH, ears === 'long' ? 0.3 * hd : 0.35 * hd, 0.26 * hw, bh - earH / 2, bd / 2 - 0.3 * hd, DARK),
      // Four legs under the body corners (front pair +Z, back pair −Z).
      box(0.2 * bw, legH, 0.18 * bd, -0.35 * bw, legH / 2, 0.28 * bd, DARK),
      box(0.2 * bw, legH, 0.18 * bd, 0.35 * bw, legH / 2, 0.28 * bd, DARK),
      box(0.2 * bw, legH, 0.18 * bd, -0.35 * bw, legH / 2, -0.28 * bd, DARK),
      box(0.2 * bw, legH, 0.18 * bd, 0.35 * bw, legH / 2, -0.28 * bd, DARK),
    ]) },
  ];
}

/** Bird: body + square head at front-top + 2 small legs below (wings are separate flap-able parts). */
function bird(bw: number, bh: number, bd: number): AnimalPartGeo[] {
  const legH = 0.35 * bh; // storks stand tall on their legs; ducks get short ones for free
  const hw = 0.45 * bw;
  const hd = Math.max(hw, 0.35 * bd);
  const headBottom = 0.68 * bh;

  return [
    { role: 'body', geometry: merge([
      box(bw, 0.78 * bh - legH, 0.8 * bd, 0, (legH + 0.78 * bh) / 2, -0.1 * bd), // torso
      box(hw, bh - headBottom, hd, 0, (bh + headBottom) / 2, bd / 2 - hd / 2), // head — top flush at bh
      box(0.16 * bw, legH, 0.14 * bd, -0.2 * bw, legH / 2, -0.05 * bd, DARK), // legs
      box(0.16 * bw, legH, 0.14 * bd, 0.2 * bw, legH / 2, -0.05 * bd, DARK),
    ]) },
    { role: 'wingL', geometry: wing(bw, bh, bd, +1), shoulder: [bw / 2, 0.6 * bh, 0.1 * bd] },
    { role: 'wingR', geometry: wing(bw, bh, bd, -1), shoulder: [-bw / 2, 0.6 * bh, 0.1 * bd] },
  ];
}

/** One wing box extending laterally from the shoulder; inner edge at x=0 (flush against the body side)
 *  so a zero-rotation pose reads as folded wings hugging the body. Built on the correct side with
 *  positive dimensions — proper mirror, no negative-scale winding hacks. */
function wing(bw: number, bh: number, bd: number, side: 1 | -1): THREE.BufferGeometry {
  const wl = 0.8 * Math.max(bw, bd); // wingspan ≈ body length
  return merge([box(wl, 0.12 * bh, 0.45 * bd, (side * wl) / 2, 0, 0)]);
}

/** Fish: elongated body + tail-fin box at the rear (fin taller than the body so it reads as a fin). */
function fish(bw: number, bh: number, bd: number): AnimalPartGeo[] {
  return [
    { role: 'body', geometry: merge([
      box(0.8 * bw, 0.75 * bh, 0.8 * bd, 0, 0.375 * bh, 0), // body — base at y=0 like the old single box
      box(0.6 * bw, bh, 0.16 * bd, 0, bh / 2, -0.42 * bd, DARK), // tail fin at the rear (−Z)
    ]) },
  ];
}

/** One tinted BoxGeometry piece, centered at (x,y,z). */
function box(w: number, h: number, d: number, x: number, y: number, z: number, tintV = 1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.max(w, 0.001), Math.max(h, 0.001), Math.max(d, 0.001));
  g.translate(x, y, z);
  tint(g, tintV);
  return g;
}

/** Fill a uniform vertex-colour attribute (mergeGeometries needs it on every piece — the material uses
 *  vertexColors so this multiplies with the per-instance colour). */
function tint(g: THREE.BufferGeometry, v: number): void {
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(v), 3));
}

/** Merge pieces into one geometry (single material — no groups) and free the sources. */
function merge(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(pieces, false)!;
  for (const p of pieces) p.dispose();
  return out;
}
