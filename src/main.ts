/**
 * Critterbox boot (Phase 8): async restore-on-load — a saved world (IndexedDB) is restored BEFORE the
 * first render; only when no save exists does it generate fresh from ?seed= in the URL (else a fixed
 * default), size defaults to 300 m. The canvas is appended at the END of boot, so #scene being visible
 * doubles as the "world ready" gate for e2e and no frame ever renders a world that isn't final. Exposes
 * window.__critterbox — the debug surface e2e uses (Sandfall pattern) — also only once the world is final.
 */

import * as THREE from 'three';
import pkg from '../package.json';
import { generateWorld, parseSeed } from './worldgen/worldgen';
import type { World } from './worldgen/worldgen';
import { buildTerrain, disposeTerrain } from './render/terrain';
import { FreeFlightCamera, isTypingTarget } from './render/camera';
import { initWorldgenPanel } from './ui/panel';
import { Sim } from './sim/sim';
import { seedLife } from './sim/seedLife';
import { PlantRenderer } from './render/plants';
import { AnimalRenderer } from './render/animals';
import { flightAltFor } from './render/animalGeometry';
import { HoverHighlight } from './render/hoverHighlight';
import { initPopulationPanel, type PopRow } from './ui/population';
import { initEnvPanel } from './ui/envPanel';
import { initInspectorPanel } from './ui/inspector';
import { restoreWorld, type RestoreResult } from './save/restore';
import { loadStateInfo, requestStoragePersistence, saveNow, startAutosave } from './save/save';
import { getSpecies } from './sim/registry';
import type { Agent } from './sim/types';

const DEFAULT_SEED = 1337;
const DEFAULT_SIZE = 300;

/** Species shown in the population panel: plants, then an animals section (Phase 4). */
const PLANT_ROWS: PopRow[] = [
  { id: 'grass', name: 'grass' },
  { id: 'clover', name: 'clover' },
  { id: 'cranberry', name: 'cranberry' },
  { id: 'reed', name: 'reed' },
  { id: 'tree', name: 'tree' },
  // v0.12: the aquatic plants (in-water food base)
  { id: 'algae', name: 'algae' },
  { id: 'pondweed', name: 'pondweed' },
  { id: 'waterlily', name: 'water lily' },
];
const ANIMAL_ROWS: PopRow[] = [
  { id: 'mouse', name: 'mouse' },
  { id: 'hare', name: 'hare' },
  { id: 'hamster', name: 'hamster' },
  { id: 'deer', name: 'deer' },
  { id: 'insect', name: 'insect' },
  // Phase 5: frogs + the predator/scavenger layer
  { id: 'frog', name: 'frog' },
  { id: 'fox', name: 'fox' },
  { id: 'stork', name: 'stork' },
  { id: 'owl', name: 'owl' },
  { id: 'crow', name: 'crow' },
  // Phase 6: the aquatic layer — carp + pike in the river volume
  { id: 'carp', name: 'carp' },
  { id: 'pike', name: 'pike' },
  // v0.12: the widened river food chain
  { id: 'roach', name: 'roach' },
  { id: 'trout', name: 'trout' },
  { id: 'duck', name: 'duck' },
];

// --- renderer / scene -------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.domElement.id = 'scene'; // appended at the END of boot — #scene visible ⇒ world ready (e2e gate)

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // sky

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 4000);

// Sun + ambient so the relief reads well (Phase 7 animates these with day/night).
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(120, 200, 80);
scene.add(sun);
const ambient = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambient);

// --- Phase 7: sky + lights follow the day/night light curve -------------------------------------
// Cheap per-frame update (a couple of color lerps): sun intensity tracks light(t), and the sky blends
// night → warm dawn/dusk tint → day as the light level rises. The sample comes from sim.environment, so a
// paused sim freezes the sky too.
const SKY_DAY = new THREE.Color(0x87ceeb);
const SKY_NIGHT = new THREE.Color(0x0d1326);
const SKY_DUSK = new THREE.Color(0xd98e4a); // warm dawn/dusk tint
const skyScratch = new THREE.Color();

function updateSkyAndLights(): void {
  if (!sim) return;
  const l = sim.environment.light;
  sun.intensity = 0.15 + 1.05 * l; // ~0.15 at night, the original 1.2 at noon
  ambient.intensity = 0.3 + 0.25 * l;
  if (l <= 0.4) skyScratch.lerpColors(SKY_NIGHT, SKY_DUSK, l / 0.4);
  else skyScratch.lerpColors(SKY_DUSK, SKY_DAY, (l - 0.4) / 0.6);
  scene.background = skyScratch;
}

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
let sim: Sim | null = null;
let plantRenderer: PlantRenderer | null = null;
let animalRenderer: AnimalRenderer | null = null;
let refreshPanel: ((seed: number, size: number) => void) | null = null;
/** True once boot (restore-or-generate + first world build) has finished — gates New World clicks. */
let booted = false;

/** Build terrain + a fresh EMPTY Sim for (seed, size), disposing the previous world's GPU resources.
 *  Does NOT populate life — the caller seeds fresh (applyWorld) or restores from a save (boot). */
function buildWorld(seed: number, size: number): World {
  if (terrainGroup) disposeTerrain(terrainGroup); // free the old world's GPU resources
  if (plantRenderer) { plantRenderer.dispose(); scene.remove(plantRenderer.object); }
  if (animalRenderer) { animalRenderer.dispose(); scene.remove(animalRenderer.object); }
  world = generateWorld({ seed, size });
  terrainGroup = buildTerrain(world);
  scene.add(terrainGroup);

  sim = new Sim(world);
  plantRenderer = new PlantRenderer();
  scene.add(plantRenderer.object);
  animalRenderer = new AnimalRenderer();
  scene.add(animalRenderer.object);

  selectedId = null; // ids restart at 1 in the new world — a stale selection would highlight an unrelated agent
  stopFollow(); // same for the follow-camera — its target id belongs to the old world
  hoveredAgentId = null; // and the hover preview
  setHoveredSpecies(null); // same for the hover layer — its rings point at the old world's agents
  frameWorld(world.size);
  refreshPanel?.(world.seed, world.size);
  return world;
}

/** Upload the current sim's agents to both instanced renderers (initial full upload after a rebuild). */
function syncRenderers(): void {
  if (!sim || !plantRenderer || !animalRenderer) return;
  plantRenderer.sync(sim.agents); // initial full instance upload
  animalRenderer.sync(sim.agents, sim.stepCount); // step drives the wing-flap phase for flying birds
}

/** Generate a FRESH world: build + deterministic life seeding (same seed+size → identical population). */
function applyWorld(seed: number, size: number): World {
  const w = buildWorld(seed, size);
  seedLife(sim!); // deterministic plant + animal population derived from the world
  syncRenderers();
  return w;
}

function readUrlSeed(): number {
  const q = new URLSearchParams(window.location.search).get('seed');
  if (q !== null) {
    const parsed = parseSeed(q);
    if (parsed !== null) return parsed;
  }
  return DEFAULT_SEED;
}

// "New World" regenerates AND overwrites the save: rebuild fresh, then force-store the new state so a
// reload after an explicit New World resumes THAT world, not whatever was saved before it.
const panel = initWorldgenPanel({ onNewWorld: (seed, size) => { if (!booted) return; applyWorld(seed, size); void saveNow(sim!); } });
refreshPanel = panel.setWorld;

// Population panel — plant rows + an animals section, refreshed ~4 Hz from the sim's live stats.
const popContainer = document.getElementById('population-panel');
if (popContainer) {
  const rows: PopRow[] = [...PLANT_ROWS, { id: '§animals', name: 'animals', header: true }, ...ANIMAL_ROWS];
  initPopulationPanel(popContainer, rows, () => sim?.populations() ?? {}, { onHoverSpecies: setHoveredSpecies });
}

// Environment indicator (Phase 7) — day/night phase + weather + temperature, refreshed ~4 Hz.
const envContainer = document.getElementById('env-panel');
if (envContainer) {
  initEnvPanel(envContainer, () => sim ? sim.environment : null);
}

// Version tag in the world-gen overlay — pulled from package.json at build time so it can never go stale,
// and linked to the GitHub CHANGELOG.md. The anchor re-enables pointer events on itself only: #overlay is
// click-through (pointer-events: none) so camera controls work over it.
const subtitle = document.getElementById('subtitle');
if (subtitle) {
  const versionLink = document.createElement('a');
  versionLink.href = 'https://github.com/kamilkrzywda/critterbox/blob/master/CHANGELOG.md';
  versionLink.target = '_blank';
  versionLink.rel = 'noopener noreferrer';
  versionLink.textContent = `v${pkg.version}`;
  subtitle.appendChild(versionLink);
}

// --- pause (Space) + sim-speed slider (Phase 8) ----------------------------------------------
// The sim is frozen when Space-paused OR the speed slider sits at 0× — both show the PAUSED overlay, so
// the two controls stay in sync: dragging to 0 pauses visually, and Space still toggles its own flag.

const pausedOverlay = document.getElementById('paused-overlay');
// v0.14 mobile: a pause/play button next to the speed slider (no keyboard on phones). It mirrors the SAME
// `paused` flag Space toggles, so all three — button label, PAUSED overlay, and the flag — stay in sync.
const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement | null;
let paused = false;

/** The sim is frozen when Space-paused OR the speed slider sits at 0× (see above). */
function frozen(): boolean { return paused || simSpeed === 0; }

function syncPauseOverlay(): void {
  if (pausedOverlay) pausedOverlay.style.display = frozen() ? 'block' : 'none';
}

/** The button shows ▶ while paused, ⏸ while running — refreshed on every setPaused. */
function syncPauseButton(): void {
  if (pauseBtn) pauseBtn.textContent = paused ? '▶' : '⏸';
}

function setPaused(p: boolean): void {
  paused = p;
  syncPauseOverlay();
  syncPauseButton();
}

if (pauseBtn) pauseBtn.addEventListener('click', () => setPaused(!paused));

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') { selectAgentById(null); return; } // Esc closes the inspector / deselects
  if (e.code !== 'Space' || e.repeat) return;
  if (isTypingTarget(document.activeElement)) return; // typing in the seed input is not a pause
  e.preventDefault();
  setPaused(!paused);
});

// --- sim-speed slider (Phase 8): 0–8×, persisted to localStorage (Sandfall convention) --------

const SPEED_KEY = 'critterbox.speed';
let simSpeed = 1;

function loadPersistedSpeed(): number {
  try {
    const raw = localStorage.getItem(SPEED_KEY);
    if (raw !== null) {
      const v = Number(raw);
      if (Number.isFinite(v)) return Math.max(0, Math.min(8, v));
    }
  } catch { /* storage unavailable — non-fatal */ }
  return 1;
}

const speedSlider = document.getElementById('speed-slider') as HTMLInputElement | null;
const speedLabel = document.getElementById('speed-label');

function setSimSpeed(v: number): void {
  simSpeed = Math.max(0, Math.min(8, v));
  if (speedSlider) speedSlider.value = String(simSpeed);
  if (speedLabel) speedLabel.textContent = `${simSpeed}×`;
  try { localStorage.setItem(SPEED_KEY, String(simSpeed)); } catch { /* non-fatal */ }
  syncPauseOverlay(); // slider at 0 freezes the sim → keep the PAUSED overlay in sync with it
}

if (speedSlider) {
  speedSlider.addEventListener('input', () => setSimSpeed(Number(speedSlider.value)));
}
setSimSpeed(loadPersistedSpeed()); // restore the user's last choice before the first frame

// --- fixed-timestep loop (Phase 3 fills stepSim with the agent simulation) ---------------------

const SIM_STEP = 1 / 30; // sim tick rate: 30 steps/s at 1×
const MAX_STEPS_PER_FRAME = 5; // clamp — never spiral after a long frame (Sandfall pattern)

let accumulator = 0;
let lastTime = performance.now();

function stepSim(): void {
  if (!sim || !plantRenderer || !animalRenderer) return;
  sim.step(); // advance agents one fixed tick (plants: growth/stages/death; animals: behaviour/eating/breeding)
  plantRenderer.sync(sim.agents); // incremental instance updates from the change-feed
  animalRenderer.sync(sim.agents, sim.stepCount); // full matrix rewrite each frame (low counts — fine); step drives wing flap
}

// --- entity inspector selection (Phase 8) ------------------------------------------------------
// Click an agent → raycast against both instanced renderers, nearest hit wins; click empty space or Esc
// deselects. The selected agent is highlighted by a small ring marker that follows it each frame, and its
// live parameters show in the side panel (~10 Hz). Selection is just an id — when the agent dies (or the
// world is rebuilt) the id stops resolving and everything clears itself.

let selectedId: number | null = null;

/** Select a live agent by id (null → deselect). Dead/unknown ids deselect instead of erroring.
 *  Selecting an ANIMAL also starts the follow-camera (plants are stationary — nothing to follow);
 *  selecting a plant or deselecting stops it. */
function selectAgentById(id: number | null): void {
  if (id !== null && !(sim?.agentById(id))) id = null; // dead/absent — or no world yet
  selectedId = id;
  if (id === null) { stopFollow(); return; }
  const a = sim!.agentById(id);
  if (a && getSpecies(a.species)?.kind === 'animal') startFollow(id);
  else stopFollow(); // plants are stationary — nothing to follow
}

// --- follow-camera: clicking an animal makes the camera track it ----------------------------------
// The camera keeps a FIXED view offset from a SMOOTHED copy of the agent's position: each frame the
// smoothed target lerps toward the live position with an exponential time constant (~0.3 s), so the
// jerky wander/seek behaviour reads as a gentle glide instead of a jitter. Any user POSITION input
// (WASD/wheel) cancels follow — look/orbit stays free, so you can circle around a followed animal.
// The selection itself is untouched: Esc / empty-click deselect AND stop following; the agent dying or
// a world rebuild clears it too.
const FOLLOW_LAMBDA = 3; // smoothing rate (1/s) — higher = tighter follow, lower = lazier glide
let followId: number | null = null;
const followTarget = new THREE.Vector3(); // smoothed copy of the followed agent's position
const followOffset = new THREE.Vector3(); // fixed camera-minus-target view vector for this session

function startFollow(id: number): void {
  const a = sim?.agentById(id);
  if (!a) return;
  const camPos = flight.pos;
  if (followId === null) {
    // Fresh session: capture the current view offset so the camera doesn't jump on the first frame.
    followTarget.set(a.pos.x, a.pos.y, a.pos.z);
    followOffset.set(camPos[0] - a.pos.x, camPos[1] - a.pos.y, camPos[2] - a.pos.z);
  } else {
    // Re-target mid-session: keep the offset, but re-seat the smoothed target so desired == current
    // camera position (no jump) and it glides over to the new agent.
    followTarget.set(camPos[0] - followOffset.x, camPos[1] - followOffset.y, camPos[2] - followOffset.z);
  }
  followId = id;
}

function stopFollow(): void {
  followId = null;
}

/** Per-frame: glide the camera to (smoothed target + fixed offset), or clear when the agent dies. */
const followScratch = new THREE.Vector3();
function updateFollow(dt: number): void {
  if (followId === null) return;
  const a = sim?.agentById(followId);
  if (!a) { stopFollow(); return; } // died or world rebuilt — the selection marker clears selectedId too
  followScratch.set(a.pos.x, a.pos.y, a.pos.z);
  followTarget.lerp(followScratch, 1 - Math.exp(-FOLLOW_LAMBDA * dt)); // frame-rate independent damping
  flight.setPos(
    followTarget.x + followOffset.x,
    followTarget.y + followOffset.y,
    followTarget.z + followOffset.z,
  );
}

// The user taking over POSITION control cancels follow; look/orbit is allowed (see camera.onUserInput).
flight.onUserInput = (kind) => { if (kind === 'move') stopFollow(); };

const selectionMarker = new THREE.Mesh(
  new THREE.TorusGeometry(2, 0.15, 8, 32),
  new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.9 }), // unlit — reads as a marker
);
selectionMarker.rotation.x = -Math.PI / 2; // lay the ring flat on the ground plane
selectionMarker.visible = false;
scene.add(selectionMarker);

/** Per-frame: park the highlight ring on the selected agent, or clear it when the selection dies. */
function updateSelectionMarker(): void {
  if (selectedId === null) {
    selectionMarker.visible = false;
    return;
  }
  const a = sim?.agentById(selectedId);
  if (!a) {
    selectedId = null; // the agent died (or the world was rebuilt) → deselect
    selectionMarker.visible = false;
    return;
  }
  // Flying birds render at their species' flight altitude above the sim seat — keep the ring with them (shared lookup).
  selectionMarker.position.set(a.pos.x, a.pos.y + 0.15 + (a.data?.flying ? flightAltFor(a.species) : 0), a.pos.z);
  selectionMarker.visible = true;
}

// --- species-hover highlight (v0.10) -----------------------------------------------------------
// Hover a population-panel row → one ring per live agent of that species (see render/hoverHighlight.ts).
// Coexists with the inspector's selection ring — both are just id state, so neither clears the other.
const hoverLayer = new HoverHighlight(scene);
let hoveredSpecies: string | null = null;

function setHoveredSpecies(id: string | null): void {
  if (hoveredSpecies === id) return; // rows re-fire mouseover on every child span — stay idempotent
  hoveredSpecies = id;
  hoverLayer.setSpecies(id); // clearing zeroes the instances immediately, no frame needed
}

// Pick: a pointerup within 5 px of the pointerdown is a CLICK (anything longer is a camera drag). The
// same pick path serves HOVER too (pointermove → inspector preview), throttled to ~20 Hz and ≥4 px of
// pointer travel. Picking is PROXIMITY-based, not a geometry raycast: each agent counts as a vertical
// line at its position with a per-species radius — tiny grass instances are ~10 cm wide, so a single-pixel
// ray misses them ~98% of the time and hover-inspect over a meadow would be a lottery. Nearest along the
// ray wins across ALL agents; O(n) simple math per pick (n ≈ 10⁴–10⁵), trivial at the throttle rate.
const PICK_RADIUS_PLANT = 1.0; // m — hovering the meadow finds grass/clover/reed
const PICK_RADIUS_TREE = 2.5; // m — canopies are big
const PICK_RADIUS_ANIMAL = 0.8; // m — floored so tiny mice stay pickable

const pickRaycaster = new THREE.Raycaster();
const pickNdc = new THREE.Vector2();

// --- screen-projection scratch (v0.14: agentScreenPos for the mobile touch e2e) -------------------
const projM = new THREE.Matrix4(); // fresh view matrix (world → camera space)
const projV = new THREE.Vector4(); // world→view→clip; a Vector4 keeps w for perspective division

/** Nearest agent under the given client coords (null over empty space/water). See the note above for why
 *  this is a proximity test against vertical lines instead of an instanced-mesh raycast. */
function pickAgentAtClient(x: number, y: number): Agent | null {
  if (!sim) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  pickNdc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  pickRaycaster.setFromCamera(pickNdc, camera);
  const O = pickRaycaster.ray.origin;
  const D = pickRaycaster.ray.direction; // normalized by setFromCamera
  let best: Agent | null = null;
  let bestT = Infinity;
  for (const a of sim.agents) {
    const sp = getSpecies(a.species);
    const radius = sp?.kind === 'plant' ? (a.species === 'tree' ? PICK_RADIUS_TREE : PICK_RADIUS_PLANT) : PICK_RADIUS_ANIMAL;
    // Closest approach between the pick ray and the vertical line at the agent's position.
    let t: number; // distance along the ray to the closest point
    let h2: number; // squared horizontal distance from that point to the line
    const ox = O.x - a.pos.x, oz = O.z - a.pos.z;
    const dxy = D.x * D.x + D.z * D.z;
    if (dxy > 1e-4) { // not looking straight down — solve in the XZ plane
      t = -(ox * D.x + oz * D.z) / dxy;
      h2 = (ox + D.x * t) ** 2 + (oz + D.z * t) ** 2;
    } else { // looking straight down — the ray is itself a vertical line at O's XZ position
      t = (a.pos.y - O.y) / D.y;
      h2 = ox * ox + oz * oz;
    }
    if (t < 0.5 || h2 > radius * radius) continue; // behind the camera, or too far from the pointer line
    const hy = O.y + D.y * t; // hit-point height — must be within the agent's body extent (feet at pos.y)
    if (hy < a.pos.y - 0.5 || hy > a.pos.y + 3) continue;
    if (t < bestT) { bestT = t; best = a; } // nearest along the ray wins
  }
  return best;
}

let downX = 0;
let downY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!booted || !sim) return; // no world yet — nothing to pick
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // a drag is camera movement, not a pick
  const hit = pickAgentAtClient(e.clientX, e.clientY);
  selectAgentById(hit ? hit.id : null); // empty click → deselect
});

// --- hover-inspect: pointer over an agent previews it in the inspector -----------------------------
let hoveredAgentId: number | null = null;
let lastPickX = -Infinity;
let lastPickY = -Infinity;
let lastPickTime = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!booted || !sim) return; // no world yet — nothing to pick
  const now = performance.now();
  if (now - lastPickTime < 50) return; // ~20 Hz cap — the raycast is O(instances) per species mesh
  if (Math.hypot(e.clientX - lastPickX, e.clientY - lastPickY) < 4) return; // ignore sub-pixel jitter
  lastPickTime = now;
  lastPickX = e.clientX;
  lastPickY = e.clientY;
  const hit = pickAgentAtClient(e.clientX, e.clientY);
  hoveredAgentId = hit ? hit.id : null;
});
// Leaving the canvas (e.g. onto a HUD panel) clears the preview — otherwise it would go stale.
renderer.domElement.addEventListener('pointerleave', () => { hoveredAgentId = null; });

// Inspector side panel — HOVERED agent first (a live preview), else the SELECTED one; ~10 Hz (ui/inspector.ts).
const inspContainer = document.getElementById('inspector-panel');
if (inspContainer) {
  initInspectorPanel(inspContainer, () => {
    const s = sim;
    if (!s) return null;
    if (hoveredAgentId !== null) {
      const a = s.agentById(hoveredAgentId); // dead hover target → fall through to the selection
      if (a) return a;
    }
    return selectedId !== null ? s.agentById(selectedId) ?? null : null;
  }, {
    // v0.14 mobile: on a narrow screen the full-width inspector sheet hides the population panel (CSS rule).
    onVisible: (vis) => document.body.classList.toggle('inspector-open', vis),
  });
}

// --- debug surface (assigned at the END of boot — its presence means "world ready") -----------

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
      agentCount: number;
      populations: { [species: string]: { count: number; avgEnergy: number } };
      /** Species ids instanced by the PLANT renderer — e2e asserts this never contains an animal species. */
      plantRendererSpecies(): string[];
      // Phase 7: day/night + weather clock (live sample of the sim's current tick)
      tick: number;
      timeOfDay: number; // [0,1) position within the day/night cycle
      dayPhase: 'dawn' | 'day' | 'dusk' | 'night';
      light: number; // [0,1]
      temperature: number; // °C
      weather: 'clear' | 'cloudy' | 'rain';
      // Phase 8: save/load surface (IndexedDB + gzip worker — see src/save/)
      /** Force an immediate save regardless of the autosave activity gate. Resolves once stored. */
      saveNow(): Promise<void>;
      hasSave(): Promise<boolean>;
      /** Describe the stored save without restoring it (seed/size/step when a valid save exists). */
      loadStateInfo(): Promise<{ hasSave: boolean; seed?: number; size?: number; step?: number; agentCount?: number }>;
      // Phase 8: sim speed + entity inspector surface
      /** Current sim-speed multiplier (0–8×); the slider and this stay in sync. */
      speed: number;
      setSpeed(x: number): void;
      /** Select an agent for the inspector by id (null/undefined → deselect). Dead ids deselect. */
      selectAgent(id?: number | null): void;
      /** Currently selected agent id, or null when nothing is selected. */
      selected: number | null;
      /** Agent id under the pointer (hover-inspect), or null when nothing is hovered. */
      hoveredAgent: number | null;
      /** Agent id the camera is currently following (an animal selection), or null. */
      following: number | null;
      /** World position of a live agent — e2e uses it to verify the follow-camera tracks its target. */
      agentPos(id: number): [number, number, number] | null;
      /** Projected screen position (CSS px within the canvas) of a live agent — v0.14 mobile touch e2e taps
       *  agents at their projected pixel. Null when dead/unknown or behind the camera. */
      agentScreenPos(id: number): [number, number] | null;
      // v0.10: species-hover highlight surface (population-row hover without real mouse events)
      /** Set the hovered population-row species (null/undefined → clear). Drives the ring layer directly. */
      hoverSpecies(id?: string | null): void;
      /** Currently hovered species id, or null when nothing is hovered. */
      hoveredSpecies: string | null;
      /** Live instance count of the hover ring layer — e2e asserts it equals the hovered population. */
      hoverInstanceCount: number;
    };
  }
}

// --- boot (Phase 8): restore-on-load BEFORE the first render ----------------------------------
// A saved world replaces the fresh default one before any frame renders. Any failure — no save, corrupt
// blob, version mismatch — simply generates a fresh deterministic world from the URL seed (never crashes).

async function boot(): Promise<void> {
  requestStoragePersistence(); // once at startup — reduces IndexedDB eviction risk
  let restored: RestoreResult | null = null;
  try {
    restored = await restoreWorld();
  } catch (err) {
    console.warn('[critterbox] restore failed — starting fresh:', err instanceof Error ? err.message : String(err));
  }
  if (restored) {
    buildWorld(restored.seed, restored.size); // terrain re-derived from seed+size (not stored)
    sim!.loadState(restored.agents, restored.corpses, restored.step); // agents/corpses/step verbatim
    syncRenderers();
    console.log(`[critterbox] restored world seed ${restored.seed} @ step ${restored.step}, ${restored.agents.length} agents`);
  } else {
    applyWorld(readUrlSeed(), DEFAULT_SIZE); // no save — first visit (or a cleared one)
  }

  window.__critterbox = {
    version: pkg.version,
    get seed() { return world!.seed; },
    get worldSize() { return world!.size; },
    get waterLevel() { return world!.waterLevel; },
    heightAt(x: number, z: number): number { return world!.heightAt(x, z); },
    biomeAt(x: number, z: number): number { return world!.biomeAt(x, z); },
    regenerate(seed?: number, size?: number): void {
      // Programmatic "New World" — same semantics as the dialog button (rebuild + overwrite the save).
      applyWorld(
        typeof seed === 'number' ? seed >>> 0 : world!.seed,
        typeof size === 'number' ? Math.round(size) : world!.size,
      );
      void saveNow(sim!);
    },
    get camera() { return { pos: flight.pos, yaw: flight.yaw, pitch: flight.pitch }; },
    get paused() { return paused; },
    setPaused(p: boolean): void { setPaused(!!p); },
    get agentCount() { return sim ? sim.agents.length : 0; },
    get populations() { return sim ? sim.populations() : {}; },
    plantRendererSpecies(): string[] { return plantRenderer ? plantRenderer.speciesIds() : []; },
    // Phase 7: day/night + weather clock — the sim's step counter itself, so it stays honest across a
    // restore-on-load (sim.stepCount is restored verbatim from the save). Frozen while paused.
    get tick() { return sim ? sim.stepCount : 0; },
    get timeOfDay() { return sim ? sim.environment.timeOfDay : 0; },
    get dayPhase() { return sim ? sim.environment.phase : 'dawn'; },
    get light() { return sim ? sim.environment.light : 0; },
    get temperature() { return sim ? sim.environment.temperature : 15; },
    get weather() { return sim ? sim.environment.weather : 'clear'; },
    // Phase 8: save/load surface.
    saveNow: () => (sim ? saveNow(sim) : Promise.resolve()),
    hasSave: async (): Promise<boolean> => (await loadStateInfo()).hasSave,
    loadStateInfo: () => loadStateInfo(),
    // Phase 8: sim speed + entity inspector surface.
    get speed() { return simSpeed; },
    setSpeed(x: number): void { setSimSpeed(typeof x === 'number' && Number.isFinite(x) ? x : 1); },
    selectAgent(id?: number | null): void { selectAgentById(id ?? null); },
    get selected() { return selectedId; },
    get hoveredAgent() { return hoveredAgentId; },
    get following() { return followId; },
    agentPos(id: number): [number, number, number] | null {
      const a = sim?.agentById(id);
      return a ? [a.pos.x, a.pos.y, a.pos.z] : null;
    },
    // v0.14 mobile e2e: project a live agent into CSS pixel coords of the canvas (null when dead/unknown or
    // behind the camera). Uses a FRESH view matrix (not the last render's) so it is correct even mid-frame.
    agentScreenPos(id: number): [number, number] | null {
      const a = sim?.agentById(id);
      if (!a) return null;
      camera.updateMatrixWorld();
      projM.copy(camera.matrixWorld).invert(); // fresh view matrix — front of the camera is z < 0 in it
      projV.set(a.pos.x, a.pos.y, a.pos.z, 1).applyMatrix4(projM); // world → view space (w stays 1)
      if (projV.z >= -0.1) return null; // at/behind the camera plane
      projV.applyMatrix4(camera.projectionMatrix); // view → clip space (now carries a real w)
      const w = projV.w;
      if (!Number.isFinite(w) || Math.abs(w) < 1e-6) return null;
      const ndcX = projV.x / w, ndcY = projV.y / w; // perspective-divide → NDC in [-1,1]
      const rect = renderer.domElement.getBoundingClientRect();
      return [(ndcX * 0.5 + 0.5) * rect.width, (-ndcY * 0.5 + 0.5) * rect.height];
    },
    // v0.10: species-hover highlight surface.
    hoverSpecies(id?: string | null): void { setHoveredSpecies(typeof id === 'string' ? id : null); },
    get hoveredSpecies() { return hoveredSpecies; },
    get hoverInstanceCount() { return hoverLayer.count; },
  };

  document.body.appendChild(renderer.domElement); // #scene visible ⇒ ready (e2e gate) — after the surface exists
  startAutosave(() => sim); // ~30 s timer (activity-gated) + forced flush on hidden/pagehide(capture)
  booted = true;
  lastTime = performance.now(); // boot took a moment — don't bank that wall time into the first frame
  requestAnimationFrame(frame);
}

void boot();

// --- render loop -----------------------------------------------------------------------------

function frame(now: number): void {
  requestAnimationFrame(frame);
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.25) dt = 0.25; // clamp after tab switches — no giant catch-up bursts

  flight.update(dt); // camera always flies, even while the sim is paused
  updateFollow(dt); // follow-camera glides toward the followed animal (no-op unless following)
  if (!frozen()) {
    accumulator += dt * simSpeed; // Phase 8: speed multiplier (0× = frozen, up to 8×) applied here
    let steps = 0;
    while (accumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
      stepSim(); // sim.stepCount advances inside — the debug-surface tick reads it directly
      accumulator -= SIM_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // drop backlog — stay smooth
  } else {
    accumulator = 0; // don't bank time while frozen — no burst on resume
  }
  updateSelectionMarker(); // Phase 8: the highlight ring follows the selected agent (cheap per-frame)
  if (sim) hoverLayer.sync(sim.agents); // v0.10: refresh hovered-species rings — a no-op unless hovering
  updateSkyAndLights(); // Phase 7: sky + sun follow the day/night light curve (cheap per-frame lerps)
  renderer.render(scene, camera);
}
// (the loop starts at the end of boot() — no frame renders before restore-on-load has settled)
