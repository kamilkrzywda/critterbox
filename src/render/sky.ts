/**
 * Procedural sky dome (v0.15 "bling"): a big BackSide sphere with a small fragment shader replacing the old
 * flat scene.background lerp. The SKY_DAY / SKY_DUSK / SKY_NIGHT colours are passed as uniforms, but every
 * dawn/dusk transition is keyed on the SUN'S ELEVATION (uSunDir.y), not the sim light level — low light
 * lingers ~700 ticks after sunrise while the sun climbs to ~57°, and a light-level key rusted the whole
 * morning sky. So: the base palette blends night→day over the first 20° of climb (DUSK_ELEVATION_SIN), the
 * warm dusk colour appears only as a glow band LOCALISED around the sun's azimuth plus a faint uniform cast,
 * both gone by ±20° elevation; stars fade out on the same curve. The base is stretched into a zenith→horizon
 * gradient (the horizon keeps the palette colour; the zenith is a darker shade of it), and a gray
 * desaturation driven by the smoothed cloud factor keeps weather flips from popping. The dome follows the
 * camera (see Celestial.group) and is NOT fogged — ShaderMaterial ignores scene.fog by default, and
 * main.ts fades terrain INTO the matching horizon colour instead.
 */

import * as THREE from 'three';
import { DOME_RADIUS } from './celestial';

/** sin(20°) — the sun elevation at which the sky is fully "day" (and the dawn/dusk glow has fully faded).
 *  The GLSL `DUSK_SIN` in FRAG above must match this value. */
export const DUSK_ELEVATION_SIN = Math.sin((20 * Math.PI) / 180);

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // The dome is centred on the camera with no rotation, so local position IS the view direction.
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uNight;      // 1 - light level [0,1] — moon-halo visibility (palette/stars are elevation-keyed)
uniform float uCloud;      // smoothed cloud factor [0,1] — weather desaturation/dimming
uniform vec3 uHorizonDay;
uniform vec3 uHorizonDusk;
uniform vec3 uHorizonNight;

varying vec3 vDir;

// sin(20°) — the sun's ELEVATION drives every dawn/dusk transition (must match DUSK_ELEVATION_SIN in TS).
const float DUSK_SIN = 0.342;

float hash13(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0); // 0 at the horizon → 1 at the zenith (below-horizon stays flat)

  // Elevation-keyed factors from the unit sun direction: dayF is 0 on the horizon → 1 by +20°; duskF peaks
  // at the horizon and is gone by ±20° (a short afterglow below it).
  float sy = uSunDir.y;
  float dayF = clamp(sy / DUSK_SIN, 0.0, 1.0);
  float duskF = clamp(1.0 - abs(sy) / DUSK_SIN, 0.0, 1.0);

  // Base palette: night → day keyed on sun elevation — no light-level lerp through the dusk colour.
  vec3 base = mix(uHorizonNight, uHorizonDay, dayF);

  // Zenith→horizon gradient: same palette colour, darker overhead.
  vec3 col = mix(base, base * 0.72, pow(h, 0.55));

  // Warm glow band LOCALISED around the sun's azimuth — dawn/dusk only (duskF), strongest at the horizon.
  float sd = max(dot(d, uSunDir), 0.0);
  col += uHorizonDusk * duskF * pow(sd, 6.0) * (1.0 - h * 0.5);

  // Faint uniform warm cast while the sun sits at the horizon — keeps dawn pretty without rusting the dome.
  col += uHorizonDusk * duskF * 0.12;

  // Faint cool halo around the moon at night.
  float md = max(dot(d, uMoonDir), 0.0);
  col += vec3(0.45, 0.55, 0.8) * pow(md, 12.0) * uNight * (1.0 - uCloud) * 0.3;

  // Stars: sparse hash cells on the upper sky — fade out as the sun climbs to +20° (not with light level,
  // which lingers low ~700 ticks after sunrise and would leave sparkles in a blue morning sky).
  float starF = clamp(1.0 - max(sy, 0.0) / DUSK_SIN, 0.0, 1.0);
  float star = step(0.9985, hash13(floor(d * 90.0)));
  col += vec3(0.85, 0.9, 1.0) * star * starF * smoothstep(0.12, 0.45, d.y) * (1.0 - uCloud);

  // Weather: desaturate toward gray + dim, scaled by the smoothed cloud factor.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), uCloud * 0.65);
  col *= 1.0 - uCloud * 0.2;

  gl_FragColor = vec4(col, 1.0);
  // ShaderMaterial does NOT get the renderer's output-colour-space conversion automatically (built-in
  // materials do) — without this the dome would display its linear working-space values as-is and read
  // ~40% darker than the palette it was tuned with. The uniforms are linear (THREE.Color from hex), so
  // encoding here round-trips them back to the intended sRGB colours.
  #include <colorspace_fragment>
}
`;

/** The sky dome mesh + its shader material. Call update() once per frame with the current celestial state. */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor(parent: THREE.Object3D, dayColor: THREE.Color, duskColor: THREE.Color, nightColor: THREE.Color) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false, // the dome is the backdrop — never occlude anything in front of it
      uniforms: {
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uMoonDir: { value: new THREE.Vector3(-1, 0, 0) },
        uNight: { value: 0 },
        uCloud: { value: 0.1 },
        uHorizonDay: { value: dayColor.clone() },
        uHorizonDusk: { value: duskColor.clone() },
        uHorizonNight: { value: nightColor.clone() },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 24), this.mat);
    parent.add(this.mesh); // parent follows the camera (Celestial.group) — the dome stays centred on it
  }

  /** Per-frame uniform update. `cloudFactor` is already smoothed on the caller side (weather flips are
   *  discrete). The dawn/dusk factors are derived from `sunDir.y` inside the shader — no CPU glow value. */
  update(sunDir: THREE.Vector3, moonDir: THREE.Vector3, lightLevel: number, cloudFactor: number): void {
    const u = this.mat.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(moonDir);
    u.uNight.value = 1 - lightLevel;
    u.uCloud.value = cloudFactor;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mat.dispose();
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
  }
}
