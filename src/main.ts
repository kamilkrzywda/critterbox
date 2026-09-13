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
import { HoverHighlight } from './render/hoverHighlight';
import { initPopulationPanel, type PopRow } from './ui/population';
import { initEnvPanel } from './ui/envPanel';
import { initInspectorPanel } from './ui/inspector';
import { restoreWorld, type RestoreResult } from './save/restore';
import { loadStateInfo, requestStoragePersistence, saveNow, startAutosave } from './save/save';
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
  setHoveredSpecies(null); // same for the hover layer — its rings point at the old world's agents
  frameWorld(world.size);
  refreshPanel?.(world.seed, world.size);
  return world;
}

/** Upload the current sim's agents to both instanced renderers (initial full upload after a rebuild). */
function syncRenderers(): void {
  if (!sim || !plantRenderer || !animalRenderer) return;
  plantRenderer.sync(sim.agents); // initial full instance upload
  animalRenderer.sync(sim.agents);
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

// --- pause (Space) + sim-speed slider (Phase 8) ----------------------------------------------
// The sim is frozen when Space-paused OR the speed slider sits at 0× — both show the PAUSED overlay, so
// the two controls stay in sync: dragging to 0 pauses visually, and Space still toggles its own flag.

const pausedOverlay = document.getElementById('paused-overlay');
let paused = false;

/** The sim is frozen when Space-paused OR the speed slider sits at 0× (see above). */
function frozen(): boolean { return paused || simSpeed === 0; }

function syncPauseOverlay(): void {
  if (pausedOverlay) pausedOverlay.style.display = frozen() ? 'block' : 'none';
}

function setPaused(p: boolean): void {
  paused = p;
  syncPauseOverlay();
}

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
  animalRenderer.sync(sim.agents); // full matrix rewrite each frame (low counts — fine)
}

// --- entity inspector selection (Phase 8) ------------------------------------------------------
// Click an agent → raycast against both instanced renderers, nearest hit wins; click empty space or Esc
// deselects. The selected agent is highlighted by a small ring marker that follows it each frame, and its
// live parameters show in the side panel (~10 Hz). Selection is just an id — when the agent dies (or the
// world is rebuilt) the id stops resolving and everything clears itself.

let selectedId: number | null = null;

/** Select a live agent by id (null → deselect). Dead/unknown ids deselect instead of erroring. */
function selectAgentById(id: number | null): void {
  if (id !== null && !(sim?.agentById(id))) id = null; // dead/absent — or no world yet
  selectedId = id;
}

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
  selectionMarker.position.set(a.pos.x, a.pos.y + 0.15, a.pos.z);
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

// Click-pick: a pointerup within 5 px of the pointerdown is a click (anything longer is a camera drag).
const pickRaycaster = new THREE.Raycaster();
const pickNdc = new THREE.Vector2();
let downX = 0;
let downY = 0;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!booted || !sim) return; // no world yet — nothing to pick
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // a drag is camera movement, not a pick
  const rect = renderer.domElement.getBoundingClientRect();
  pickNdc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  pickRaycaster.setFromCamera(pickNdc, camera);
  const pa = plantRenderer?.pickAgent(pickRaycaster) ?? null;
  const aa = animalRenderer?.pickAgent(pickRaycaster) ?? null;
  let hit: { agent: Agent; distance: number } | null = null;
  if (pa && (!aa || pa.distance < aa.distance)) hit = pa; // nearest across BOTH renderers wins
  else if (aa) hit = aa;
  selectAgentById(hit ? hit.agent.id : null); // empty click → deselect
});

// Inspector side panel — renders whatever is selected, ~10 Hz (see ui/inspector.ts).
const inspContainer = document.getElementById('inspector-panel');
if (inspContainer) {
  initInspectorPanel(inspContainer, () => (selectedId !== null && sim ? sim.agentById(selectedId) ?? null : null));
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
