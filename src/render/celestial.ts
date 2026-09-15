/**
 * Celestial bodies (v0.15 "bling"): sun + moon spheres that track the sim's day/night cycle, plus the
 * per-frame placement of the shadow-casting sun light and the dim moonlight. The arc is a PURE function
 * of timeOfDay with boundaries mirrored EXACTLY from sim/environment.ts: the sun is above the horizon
 * (elevation > 0) exactly while lightAt(step) > 0, i.e. for t ∈ [0, DAY_TICKS) of each CYCLE_TICKS cycle —
 * it rises at dawn, crosses zenith at midday, sets at dusk, and continues below the horizon through the
 * night so the antipodal moon is up exactly when the sun is down (and both are continuous across the
 * cycle wrap). The whole group follows the camera each frame, so the bodies stay a fixed distance away
 * no matter where you fly.
 */

import * as THREE from 'three';
import { DAY_TICKS, NIGHT_TICKS, CYCLE_TICKS } from '../sim/environment';

/** Sky dome radius — the shader dome in sky.ts sits at this radius around the camera. */
export const DOME_RADIUS = 800;
/** Sun/moon sphere distance from the camera — inside the dome so they always render against it. */
const BODY_DISTANCE = 700;
/** How far the shadow-casting sun light sits from its focus point (the ground under the camera). */
export const LIGHT_DISTANCE = 300;

/** The arc angle for a cycle position: day sweeps east horizon → zenith → west horizon (θ ∈ [0, π]),
 *  night continues below the horizon (θ ∈ [π, 2π)). Continuous across the wrap by construction. */
function arcAngle(timeOfDay: number): number {
  const t = timeOfDay * CYCLE_TICKS; // ticks within the cycle, [0, CYCLE_TICKS)
  if (t < DAY_TICKS) return Math.PI * t / DAY_TICKS;
  return Math.PI + (Math.PI * (t - DAY_TICKS)) / NIGHT_TICKS;
}

/** A soft radial glow texture (white centre → transparent edge) for additive sprites — procedural, no assets. */
export function makeGlowTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!; // always available in the browser build
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Sun + moon meshes (camera-following group). The DIRECTIONAL LIGHTS themselves stay in main.ts — this
 *  class only owns the visible bodies and reports their directions/positions for lights, sky shader, e2e. */
export class Celestial {
  /** Camera-following anchor: sun/moon spheres live here at BODY_DISTANCE from the origin. */
  readonly group = new THREE.Group();

  private readonly sunDirV = new THREE.Vector3(1, 0, 0);
  private readonly moonDirV = new THREE.Vector3(-1, 0, 0);
  private readonly sunMesh: THREE.Mesh;
  private readonly moonMesh: THREE.Mesh;
  private readonly glowSprite: THREE.Sprite;

  constructor(scene: THREE.Scene) {
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(10, 24, 16),
      // unlit — always a bright warm disc; fog:false because the body sits at BODY_DISTANCE ≈ scene.fog far
      new THREE.MeshBasicMaterial({ color: 0xffe9b0, fog: false }),
    );
    this.moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(7, 24, 16),
      // pale bluish-white, slightly smaller than the sun; fog:false (same distance as the sun)
      new THREE.MeshBasicMaterial({ color: 0xdfe8ff, fog: false }),
    );
    const glowTex = makeGlowTexture(128);
    this.glowSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xffd9a0,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false, // the halo rides on the sun disc — must not be fogged out at BODY_DISTANCE
      }),
    );
    this.glowSprite.scale.setScalar(120); // soft halo around the sun disc
    this.group.add(this.sunMesh, this.moonMesh, this.glowSprite);
    scene.add(this.group);
  }

  /** Unit direction to the visible sun (y > 0 exactly while the sim's light > 0). */
  get sunDir(): THREE.Vector3 { return this.sunDirV; }
  /** Unit direction to the moon — antipodal to the sun, so one of them is always up. */
  get moonDir(): THREE.Vector3 { return this.moonDirV; }

  /** Per-frame: recompute directions from the cycle position, place the bodies around `center` (the camera),
   *  and move the shadow-casting light to focus + sunDir·LIGHT_DISTANCE with its target on `focus`. */
  update(timeOfDay: number, center: THREE.Vector3, focus: THREE.Vector3, sunLight: THREE.DirectionalLight): void {
    const a = arcAngle(timeOfDay);
    this.sunDirV.set(Math.cos(a), Math.sin(a), 0); // unit by construction (cos²+sin²=1)
    this.moonDirV.copy(this.sunDirV).negate();
    this.group.position.copy(center);
    this.sunMesh.position.copy(this.sunDirV).multiplyScalar(BODY_DISTANCE);
    this.glowSprite.position.copy(this.sunMesh.position); // halo centred on the disc
    this.moonMesh.position.copy(this.moonDirV).multiplyScalar(BODY_DISTANCE);
    sunLight.position.copy(focus).addScaledVector(this.sunDirV, LIGHT_DISTANCE);
    sunLight.target.position.copy(focus);
  }

  /** World position of the visible sun sphere (debug/e2e surface). */
  sunPos(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.group.position).addScaledVector(this.sunDirV, BODY_DISTANCE);
  }
  /** World position of the visible moon sphere (debug/e2e surface). */
  moonPos(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.group.position).addScaledVector(this.moonDirV, BODY_DISTANCE);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const child of [...this.group.children]) {
      const obj = child as THREE.Mesh | THREE.Sprite;
      obj.geometry?.dispose();
      const mat = obj.material as THREE.Material & { map?: THREE.Texture | null };
      mat.map?.dispose();
      mat.dispose();
    }
  }
}
