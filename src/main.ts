/**
 * Critterbox boot (Phase 1): read seed/size → generate world → build terrain → render loop.
 * Seed comes from ?seed= in the URL if present, else a fixed default; size defaults to 300 m.
 * Exposes window.__critterbox — the debug surface e2e and later phases use (Sandfall pattern).
 */

import * as THREE from 'three';
import pkg from '../package.json';
import { generateWorld, parseSeed } from './worldgen/worldgen';
import type { World } from './worldgen/worldgen';
import { buildTerrain, disposeTerrain, frameCamera } from './render/terrain';
import { initWorldgenPanel } from './ui/panel';

const DEFAULT_SEED = 1337;
const DEFAULT_SIZE = 300;

// --- renderer / scene -------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.domElement.id = 'scene';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // sky

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 4000);

// Sun + ambient so the relief reads well (Phase 7 animates these with day/night).
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(120, 200, 80);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- world state + debug surface ----------------------------------------------------------

let world: World | null = null;
let terrainGroup: THREE.Group | null = null;
let refreshPanel: ((seed: number, size: number) => void) | null = null;

function applyWorld(seed: number, size: number): World {
  if (terrainGroup) disposeTerrain(terrainGroup); // free the old world's GPU resources
  world = generateWorld({ seed, size });
  terrainGroup = buildTerrain(world);
  scene.add(terrainGroup);
  frameCamera(camera, world);
  refreshPanel?.(world.seed, world.size);
  return world;
}

function readUrlSeed(): number {
  const q = new URLSearchParams(window.location.search).get('seed');
  if (q !== null) {
    const parsed = parseSeed(q);
    if (parsed !== null) return parsed;
  }
  return DEFAULT_SEED;
}

const initial = applyWorld(readUrlSeed(), DEFAULT_SIZE);

const panel = initWorldgenPanel({ onNewWorld: (seed, size) => { applyWorld(seed, size); } });
refreshPanel = panel.setWorld;
panel.setWorld(initial.seed, initial.size);

// --- fixed-timestep skeleton (Phase 3 fills stepSim with the agent simulation) --------------

const SIM_STEP = 1 / 30; // sim tick rate: 30 steps/s at 1×
const MAX_STEPS_PER_FRAME = 5; // clamp — never spiral after a long frame (Sandfall pattern)
let accumulator = 0;
let lastTime = performance.now();
let tick = 0;

function stepSim(): void {
  // Phase 3: advance agents on `world`. No-op for now.
}

// --- debug surface --------------------------------------------------------------------------

declare global {
  interface Window {
    __critterbox: {
      version: string;
      seed: number;
      worldSize: number;
      waterLevel: number;
      heightAt(x: number, z: number): number;
      biomeAt(x: number, z: number): number;
      regenerate(seed?: number, size?: number): void;
    };
  }
}

window.__critterbox = {
  version: pkg.version,
  get seed() { return world!.seed; },
  get worldSize() { return world!.size; },
  get waterLevel() { return world!.waterLevel; },
  heightAt(x: number, z: number): number { return world!.heightAt(x, z); },
  biomeAt(x: number, z: number): number { return world!.biomeAt(x, z); },
  regenerate(seed?: number, size?: number): void {
    applyWorld(
      typeof seed === 'number' ? seed >>> 0 : world!.seed,
      typeof size === 'number' ? Math.round(size) : world!.size,
    );
  },
};

// --- render loop -----------------------------------------------------------------------------

function frame(now: number): void {
  requestAnimationFrame(frame);
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.25) dt = 0.25; // clamp after tab switches — no giant catch-up bursts
  accumulator += dt;
  let steps = 0;
  while (accumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
    stepSim();
    tick++;
    accumulator -= SIM_STEP;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // drop backlog — stay smooth
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
