/**
 * Terrain rendering (Phase 1): builds a heightmap mesh from a generated World.
 * One vertex per cell, indexed triangles, computed normals, per-vertex biome colours
 * (Minecraft-ish palette; underwater floor desaturated). Water is one translucent plane at the
 * fixed water level spanning the world. Phase 2 replaces the static camera with free-flight.
 */

import * as THREE from 'three';
import { BIOME_FOREST, BIOME_GRASSLAND, BIOME_MARSH, BIOME_MEADOW } from '../worldgen/worldgen';
import type { World } from '../worldgen/worldgen';

/** Minecraft-ish biome palette (linear-ish sRGB values). */
const PALETTE: Record<number, [number, number, number]> = {
  [BIOME_MARSH]: [0.43, 0.41, 0.24], // muddy olive/brown
  [BIOME_MEADOW]: [0.42, 0.66, 0.29], // fresh green
  [BIOME_GRASSLAND]: [0.63, 0.62, 0.33], // dry yellow-green
  [BIOME_FOREST]: [0.18, 0.37, 0.18], // dark green
};
/** Underwater floors are desaturated toward this muddy gray-brown. */
const UNDERWATER_TINT: [number, number, number] = [0.42, 0.44, 0.38];
const UNDERWATER_MIX = 0.5;

/** Build the terrain mesh + water plane for a world as one group (dispose via disposeTerrain). */
export function buildTerrain(world: World): THREE.Group {
  const w = world.width, d = world.depth;
  const n = w * d;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);

  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      positions[i * 3] = x - (w - 1) / 2; // centered on the origin
      positions[i * 3 + 1] = world.heights[i];
      positions[i * 3 + 2] = z - (d - 1) / 2;

      const [r, g, b] = PALETTE[world.biomes[i]] ?? PALETTE[BIOME_MEADOW];
      if (world.heights[i] < world.waterLevel) { // desaturate the underwater floor
        colors[i * 3] = r + (UNDERWATER_TINT[0] - r) * UNDERWATER_MIX;
        colors[i * 3 + 1] = g + (UNDERWATER_TINT[1] - g) * UNDERWATER_MIX;
        colors[i * 3 + 2] = b + (UNDERWATER_TINT[2] - b) * UNDERWATER_MIX;
      } else {
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
    }
  }

  const indices = new Uint32Array((w - 1) * (d - 1) * 6);
  let k = 0;
  for (let z = 0; z < d - 1; z++) {
    for (let x = 0; x < w - 1; x++) {
      const a = z * w + x, b = a + 1, c = a + w, dd = c + 1; // quad corners (x right, z down-grid)
      indices[k++] = a; indices[k++] = c; indices[k++] = b; // CCW from above → up-facing normal
      indices[k++] = a; indices[k++] = c; indices[k++] = dd;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const terrain = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true }),
  );

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(world.size, world.size),
    new THREE.MeshLambertMaterial({ color: 0x3a6fd8, transparent: true, opacity: 0.7 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = world.waterLevel;

  const group = new THREE.Group();
  group.add(terrain);
  group.add(water);
  return group;
}

/** Free the GPU resources of a terrain group built by buildTerrain. */
export function disposeTerrain(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  }
  group.removeFromParent();
}

/** Position the camera to view the whole world from an angle (~35° elevation, 45° azimuth). */
export function frameCamera(camera: THREE.PerspectiveCamera, world: World): void {
  const dist = world.size * 1.15;
  const el = (35 * Math.PI) / 180; // elevation above the horizon
  const az = (45 * Math.PI) / 180; // azimuth
  camera.position.set(dist * Math.cos(az) * Math.cos(el), dist * Math.sin(el), dist * Math.sin(az) * Math.cos(el));
  camera.far = Math.max(4000, world.size * 4);
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
}
