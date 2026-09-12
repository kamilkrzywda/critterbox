/**
 * Critterbox boot (Phase 2): read seed/size → generate world → build terrain → free-flight camera.
 * Seed comes from ?seed= in the URL if present, else a fixed default; size defaults to 300 m.
 * Exposes window.__critterbox — the debug surface e2e and later phases use (Sandfall pattern).
 */

import * as THREE from 'three';
import pkg from '../package.json';
import { generateWorld, parseSeed } from './worldgen/worldgen';
import type { World } from './worldgen/worldgen';
import { buildTerrain, disposeTerrain } from './render/terrain';
import { FreeFlightCamera, isTypingTarget } from './render/camera';
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

// --- free-flight camera (Phase 2) -----------------------------------------------------------

const flight = new FreeFlightCamera(camera, renderer.domElement);

/** Frame a freshly generated world: above its centre at ~60% of the size in altitude, looking
 *  down at ~45° toward the centre — the whole world reads nicely on load. */
function frameWorld(size: number): void {
  const h = size * 0.6; // altitude ≈ horizontal offset → exactly a 45° downward gaze
  flight.setPos(0, h, h);
  flight.yaw = 0;
  flight.pitch = -Math.PI / 4;
  camera.far = Math.max(4000, size * 4); // keep far plane beyond the biggest worlds
  camera.updateProjectionMatrix();
}

// --- world state + debug surface ----------------------------------------------------------

let world: World | null = null;
let terrainGroup: THREE.Group | null = null;
let refreshPanel: ((seed: number, size: number) => void) | null = null;

function applyWorld(seed: number, size: number): World {
  if (terrainGroup) disposeTerrain(terrainGroup); // free the old world's GPU resources
  world = generateWorld({ seed, size });
  terrainGroup = buildTerrain(world);
  scene.add(terrainGroup);
  frameWorld(world.size);
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

// --- pause (Space) ---------------------------------------------------------------------------

const pausedOverlay = document.getElementById('paused-overlay');
let paused = false;

function setPaused(p: boolean): void {
  paused = p;
  if (pausedOverlay) pausedOverlay.style.display = p ? 'block' : 'none';
}

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  if (isTypingTarget(document.activeElement)) return; // typing in the seed input is not a pause
  e.preventDefault();
  setPaused(!paused);
});

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
      camera: { pos: [number, number, number]; yaw: number; pitch: number };
      paused: boolean;
      setPaused(p: boolean): void;
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
  get camera() { return { pos: flight.pos, yaw: flight.yaw, pitch: flight.pitch }; },
  get paused() { return paused; },
  setPaused(p: boolean): void { setPaused(!!p); },
};

// --- render loop -----------------------------------------------------------------------------

function frame(now: number): void {
  requestAnimationFrame(frame);
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.25) dt = 0.25; // clamp after tab switches — no giant catch-up bursts

  flight.update(dt); // camera always flies, even while the sim is paused
  if (!paused) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
      stepSim();
      tick++;
      accumulator -= SIM_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // drop backlog — stay smooth
  } else {
    accumulator = 0; // don't bank time while paused — no burst on resume
  }
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
