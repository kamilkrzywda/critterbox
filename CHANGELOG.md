# Changelog

All notable changes to Critterbox are documented here. Dates in YYYY-MM-DD.

## [0.10.0] - 2026-09-13

### Added
- Hover a population-panel row → highlight ALL agents of that species: an InstancedMesh ring layer (`src/render/hoverHighlight.ts`) reusing the inspector's selection-ring geometry (TorusGeometry(2, 0.15, 8, 32), laid flat) with a distinct cyan tint at ~55% opacity so "many" reads differently from the single active gold selection; one instance per live agent, positions refreshed each frame while hovered and zero cost otherwise. Initial capacity 640 (just above the insect popCap of 600 — the largest animal population), growing on demand like AnimalRenderer's for plant populations and never shrinking back. Rows are wired via event delegation on the panel container (one mouseover/mouseout pair — no per-row listeners to leak or duplicate across the ~4 Hz text updates; header dividers can't be hovered); hover coexists with an active inspector selection and clears itself on New World. The panel gains `pointer-events: auto` so rows are actually hoverable
- Debug surface additions: `hoverSpecies(id | null)` / `hoveredSpecies` / `hoverInstanceCount` — e2e drives the layer deterministically without real mouse events; new lean hover spec (sim frozen, ring count === live population, coexists with a selection, null clears synchronously)

### Changed
- Plant display names to English across UI, species modules and docs (Grass/Clover/Cranberry/Reed/Tree) — no Polish tokens remain anywhere in code or documentation

## [0.9.0] - 2026-09-13

### Added
- IndexedDB autosave (Phase 8, the final roadmap phase): the whole sim state is {seed, size, step, agents[], corpses[]} — terrain re-derives from seed+size and the day/night + weather environment is a pure function of seed+step, so nothing else needs storing. Payload = binary header (magic "CRBX" + version u32 + seed/size/step) + JSON tail (`src/save/serialize.ts`, pure TS — runs headlessly); fflate gzip level 6 in a dedicated module worker (`saveWorker.ts`), single IndexedDB key (`storage.ts`). Autosave every 30 s, activity-gated (skipped while paused/settled), plus forced flushes on visibilitychange(hidden) and pagehide(capture); `navigator.storage.persist()` once at boot. Restore-on-load runs BEFORE the first render — a saved world replaces the fresh default one; any failure (no blob, corrupt gzip, version mismatch) falls back to a fresh deterministic world, never crashes. "New World" (dialog button or debug `regenerate`) regenerates AND overwrites the save
- Boot is now async (`main.ts`): restore-on-load settles before the canvas is appended and the render loop starts — so #scene being visible doubles as the "world ready" gate for e2e, and no frame ever renders a world that isn't final. `Sim.loadState(agents, corpses, step)` (pure sim core) restores saved ids verbatim, rebuilds the dense by-id tables + population counts, advances nextId past them and invalidates the environment cache — the deterministic per-agent hash-randomness sequence continues exactly where it left off
- Sim-speed slider 0–8× in the world panel: wired into the fixed-timestep accumulator (the Phase 3 speed hook), persisted to localStorage (`critterbox.speed`, Sandfall convention). 0 = pause, kept in sync with the Space toggle + PAUSED overlay (either one freezes the sim and shows the overlay)
- Entity inspector: click any plant/animal → raycast against both instanced renderers (nearest hit across species/sub-meshes wins; a pointerup within 5 px of the pointerdown is a pick, longer drags stay camera movement) → side panel with ALL live parameters — species, sex (animals), age, energy, every trait value, state, position — refreshed ~10 Hz (`src/ui/inspector.ts`). The selected agent gets a highlight ring that follows it each frame; Esc or an empty click deselects; the selection clears itself when the agent dies
- Debug surface additions: `saveNow()`, `hasSave()`, `loadStateInfo()` (stored seed/size/step/agentCount), `speed` / `setSpeed(x)`, `selectAgent(id)` / `selected` — e2e drives all of it deterministically
- Headless save checks (`scripts/checks/save.mjs`): serialize → deserialize round-trip on a real sim state after 500 steps (header fields verbatim, agent + corpse arrays deep-equal) and the real acceptance — a second Sim restored via `loadState` steps in lockstep with the original for another 300 ticks; corrupt-payload rejection (bad magic / version mismatch / truncation / garbage tail → null, never throws)
- e2e completion: speed spec (0× freezes the tick over ~1 s wall time; 4× runs ≈4× the 1× baseline rate with jitter tolerance; slider element + localStorage persistence), inspector spec (`selectAgent` opens the panel showing species/sex/energy fields for a plant and an animal, Esc deselects), save spec (fresh context has no save → `saveNow()` stores seed+step → reload restores that exact world before first render with populations present → New World with a new seed overwrites the store → reload resumes the NEW world)

### Changed
- README "Current state" refreshed to v0.9.0: all roadmap phases 0–8 implemented; feature bullets gained aquatic, day/night + weather and the polish trio (speed slider / autosave / inspector); the stale "not yet implemented" list is now stretch items only (wolf/beaver/moose, NEAT-style evolution behind a pluggable brain interface)
- `e2e/worldgen.spec.ts` "New World" test now waits for #scene visibility before reading the debug surface — with async boot the canvas is appended at the end of restore-on-load, so that wait IS the readiness gate (the other specs already had it)

## [0.8.0] - 2026-09-13

### Added
- Day/night cycle + weather — the "settings animator" layer (Bibites-inspired): all time-varying sim parameters are sampled per tick from named curves around base values, pure in (world seed, step) with no accumulated state (`src/sim/environment.ts`). One full day = 3600 ticks (~2 min at 1×), night = 1500 ticks (~50 s); light follows a cosine arc over the daylight window (~0 at dawn/dusk, ~1 at noon, exactly 0 through the night) and gates photosynthesis. A "year" spans 3 cycles (15300 ticks, ~8.5 min) and drives a slow seasonal temperature sine (base 15 °C ± 10 °C); weather is a seeded Markov chain over {clear, cloudy, rain} with per-state duration ranges (clear 600–2400, cloudy 450–1800, rain 300–900 ticks) sampled by deterministic hash of (world seed, step at state start) — no Math.random anywhere, reproducible headlessly. Derived multipliers: cold raises animal metabolism (up to ×1.3 hard cap, mild slope so deep winter is a burn increase, not a death spiral), rain boosts plant fertility (×1.35), and breeding is suppressed below 5 °C (the documented cold-snap gate — only deep winter + cool weather dips under it)
- Scene lighting follows the clock: sun intensity tracks light(t) and the sky blends night → warm dawn/dusk tint → day each cycle; a small HUD indicator shows day/night phase + weather + temperature (~4 Hz, matching the population-panel style); `window.__critterbox` exposes `{ tick, timeOfDay, dayPhase, light, temperature, weather }`
- Headless environment checks (`scripts/checks/environment.mjs`) — the Phase 7 acceptance gate: determinism (same seed → identical sampled light/temperature/weather sequences over N ticks at pure-function level AND through two same-seed Sims stepped in lockstep; different seeds → different weather sequences), cycle correctness (light period = day+night length, ~0 midnight / ~1 noon, phase labels, bounded mild metabolism multiplier, rain fertility boost), Markov validity (states only from the set, every observed duration within its state's configured range, all three states occur with real transitions over 60k ticks), and sim effects (plant growth light-gated day vs night, owl nocturnal / fox diurnal activity, breeding suppressed below the temperature threshold in a controlled scenario)
- e2e environment spec: debug surface exposes tick/timeOfDay/dayPhase/light/temperature/weather; after ~3 s unpaused the clock has advanced and light stays within [0,1]; HUD indicator visible with phase + weather reading

### Changed
- Plants grow under the real clock: growth = baseRate × PHOTOSYNTH_COMPENSATION (3.5) × biome fertility × light(day/night) × weather fertility. The constant sits deliberately ABOVE the pure time-average restoration value (2.6): what keeps the food chain stable is not average growth rate but POST-MOW REGROWTH TIME — a grazed plant only grows in daylight, so a mow at dusk waits out the whole night before regrowth resumes, making recovery ~2–3× slower than pre-Phase-7 even at 2.6 (20k-step forensics: fruiting-plant troughs ran 40%+ deeper; in the deepest meadow trough mice switched to eating insects and stripped them to zero, and marsh nectar troughs starved the frogs). At 3.5 grazed patches recover within a day or two; average growth runs ~1.3× pre-Phase-7, harmless because every herbivore is popCap-limited
- Animal metabolism drain uses the temperature multiplier (cold → up to ×1.3); seeded plants now start with energy consistent with their age (mature, not a field of seedlings) so nectar/browse sources exist from tick 1 — the world loads fully grown instead of as 10%-energy seedlings that took ~400 ticks of rising light before any fruiting plant existed
- Predator activity follows the clock: owl nocturnal (`activityLevel = 0.2 + 0.8×(1−light)`), fox & stork diurnal (`0.3 + 0.7×light`); below-full activity reduces the hunting RATE (deterministic per id+tick probability gate on decision ticks) rather than switching it off, and a hungry animal whose gate fails RESTS in place instead of patrolling — the wasted-wander movement drain is what tipped fox/stork energy budgets negative under compressed hunting windows. Resting burn drops accordingly: fox 0.07 → 0.03, stork 0.08 → 0.03, owl 0.06 → 0.015 (20k-step stability tuning)
- Insects also take nectar from REGRGOWTH plants (regrowth shoots flower in-season): with light-gated growth, post-mow regrowth is slower than pre-Phase-7 and marsh nectar sources oscillate deeply — without this, insects abandoned the marsh in every trough (~95% of insects left the frog zone while fruiting cranberries dipped to single digits) and the marsh-bound frogs starved into quasi-extinction (20k-step forensics). Keeps pollinators on grazed patches while they recover
- The weather Markov chain has no self-transitions: every transition is an observable change of state, so each sampled duration is exactly one observed run (the Markov-validity check validates runs against the per-state ranges)
- Foraging hot paths use the sim's dense species cache instead of registry Map lookups (`seekNearestFood`, insect nectar search, carp shore-food search): seasonal foraging pressure made these per-candidate loops ~2× busier than pre-Phase-7, and the lookup was an oversight — the dense cache exists precisely to avoid them (step cost 12.3 → 11.3 ms/tick on this dev box; behavior byte-identical)

### Fixed
- 20k-step stability with the environment enabled across all species (seed 1337, 300×300): frog, fox AND insect went extinct on the initial Phase 7 tuning — frogs starved in deep winter when light-gated regrowth let marsh nectar troughs run deeper than pre-Phase-7 (insects left + berry fallback gone), foxes ran a chronic energy deficit from compressed hunting windows + patrol burn, and insects were stripped to zero by mice switching to insect predation during the deepest meadow plant trough. Fixed via PHOTOSYNTH_COMPENSATION 3.5 (post-mow regrowth timescale), the rest-instead-of-patrol gate, per-species resting-burn cuts and the insect nectar rule above; all core species now hold with margin over the full run (frog min=39/final=90 at cap, fox min=8/final=21, insect min=397/final=600 at cap)

## [0.7.0] - 2026-09-12

### Added
- Aquatic layer — carp (river omnivore) + pike (river predator) live in the river volume: a shared `settlePosition` hook (base.ts) keeps fish over deep-enough underwater cells, clamping back to their last valid position when a move dries out and seating each at its own depth fraction of the water column (`data.depthFrac`). Carp graze shore plants (reed preferred — any plant within reach of the water's edge via `grazePlant`) plus opportunistic waterline insects; pike hunt carp with hunger-gated pursuit + saturating intake and strike frogs at the water's edge (the PLAN frog–pike interaction). Pike foraging is reachability-aware: prey in another connected swim-volume component (behind a land barrier) is never targeted, and directional-foraging steer points are volume-projected (angular search until a candidate sits inside the river) so fish follow channel bends instead of stalling against the clamp
- Deterministic aquatic seeding with basin awareness: ~35 carp in 14 family clusters on deep river cells near shore plants, plus four dense prey clusters (~60 carp total) in the largest connected water body that holds carp — pike families (one pair per cluster, ~6 total, guaranteed mixed sexes) anchor to those clusters. Same seed+size → identical fish populations
- Headless aquatic checks (`scripts/checks/aquatic.mjs`): fish stay underwater over N ticks (position over an underwater cell with y between terrain and water level), carp feed on shore reed + the plant regrows, controlled pike→carp kill, controlled pike→waterline-frog strike, determinism (same seed → identical fish populations/positions)
- 20k-step stability harness now covers carp/pike automatically (all registered species): both survive with per-species min ≥ 1 / max ≤ popCap in the printed report; e2e asserts Carp/Pike rows > 0 on load
- Animals rotate toward their movement direction: a per-animal heading (radians) is tracked in the sim on every move (`data.heading`, kept while idle so animals don't snap to zero), and the animal renderer applies it as instance yaw (+Z is the geometry's front axis — the bodySize depth dimension); new headless check asserts the heading tracks actual displacement
- GitHub Pages deploy workflow (.github/workflows/deploy.yml) auto-publishes dist on push to master as a test mirror at kamilkrzywda.github.io/critterbox; README.md added documenting the repo (stack, layout, commands, both deploy targets)

### Changed
- All animal species renamed to English across code and docs: mouse, hare, hamster, deer, insect, frog, fox, stork, owl, crow (species files, registry ids, palettes, population-panel labels, e2e specs, headless checks, PLAN.md roster and this changelog)
- Long-run aquatic stability tuning (all deterministic, seed 1337): the river splits into disconnected basins a land barrier separates — pike seeded in a small closed basin strip its prey patch and starve, so all pike now anchor to carp inside the largest connected deep-water component that holds carp (deterministic flood fill at seeding). Pike gained `noRelocate` (a new AnimalSpecies flag): they keep their original roost forever instead of adopting wherever they last hunted — with relocation on, the whole population converged on and stripped each surviving carp cluster in turn. Breeding is territorial too (only within 3×wanderRadius of home) so offspring can't leak the lock across generations. Pike hunger gate lowered to 0.5 (longer coast between meals → kill rate drops ~20%) with popCap 8; carp popCap raised 70→120 because the global cap must cover every disconnected basin — at 70 the predator-free western channel filled first and starved the pike's basin of prey slots. Result: pike hold min=5/max=8 over the 20k-step gate (was: extinct by t≈9k)

### Fixed
- Foxes no longer starve in empty home ranges: `scavengerDecide` (corpses.ts) lacked the directional-foraging fallback the generic decide has — a fox whose local patch ran dry wandered blindly within its roost radius and starved even with food beyond sense radius. It now steers toward the nearest corpse/prey up to FORAGE_SEARCH_MULT×sense radius when nothing is in kill range (Phase 6 stability forensics: fox min=0/final=0 on the original Phase 6 tree)
- Plants no longer drift — positions immutable after seeding: the plant renderer was instancing EVERY agent (animals included) because `PlantRenderer.sync` lacked the kind filter its animal-renderer counterpart has, so each animal also rendered as a generic cone that followed it around — reading as "visibly moving plants". Plant instances are now written once per agent (plus on stage/growth-bucket change) and never move; sim-side plant positions were already provably static (new headless check asserts byte-identical positions after 4000 steps, e2e asserts no animal species ever enters the plant renderer)
- Deer/tree and all-species world-space scales corrected with per-species size mapping: the raw size trait was used as a geometry scale multiplier on ~1 m base boxes, making deer (size trait 3.5–5.5) up to ~10 m tall while trees were only ~6 m. Each species now declares `bodySize` in world-space meters at its size-trait midpoint and the renderer maps the full trait range onto a fixed ±25% band (`visualScale`, base.ts); tree geometry rebuilt from explicit constants (12 m total, 4 m canopy radius — within the 8–15 m / 3–6 m sanity bands). The size trait's effect on energy capacity is unchanged. New headless check guards deer-max-height < tree-min-total-height and per-species dimension targets

## [0.6.0] - 2026-09-12

### Added
- Predators & scavengers complete the food chain: fox, stork, owl, crow + frog (marsh insectivore with cranberry fallback). Hunger-gated hunting — a predator only enters hunt state below its `hungerThreshold` fraction of capacity — with saturating intake: each kill raises satiation (scaled by how much of the predator's capacity the meal fills), so quick successive kills pay diminishing returns and prey patches can't be stripped
- Corpses & scavenging: every animal death (starvation, old age, predation) leaves a decaying corpse entity (`Sim.corpses`, not agents — linear scan); fox & crow feed on carcasses via `scavengerDecide` (a corpse in range beats live prey when hungry), closing the nutrient loop
- 20k-step population-stability harness (`scripts/checks/stability.mjs`) — the Phase 5 acceptance gate: every plant and animal must survive with per-species min ≥ 1, max ≤ popCap; prints a per-species min/max/avg stability report (seed 1337, default world)
- Headless predator checks (`scripts/checks/predators.mjs`): predation (kill + energy gain + corpse at death location), hunger gating (a full fox never hunts with prey nearby), corpse decay + crow scavenging, saturating intake (diminishing yield per kill)

### Changed
- Long-run stability tuning (all deterministic, seed 1337): family-cluster seeding for sparse species (guaranteed opposite-sex pairs so breeding starts before the initial cohort's old-age wave hits), roost-anchored wander + relocation for foxes/owls (unanchored random-walk diffusion carried them into "prey deserts" between clusters, past their ~45 m foraging range), directional foraging (a hungry animal with nothing in kill range steers toward the nearest food beyond sense radius instead of wandering blindly), size-scaled satiation so small-meal generalists aren't over-braked
- Plant edibility is now stage/energy-based: unestablished shoots (non-fruiting below 60% of maxEnergy) are inedible — one bite would drop them under the regrowth floor; replaces an earlier age-based grace period. Seed dispersal gained biome fidelity (a seedling only establishes in the parent's biome — without it, marsh cranberries crept ~40 m into dry meadow over long runs and grew unbounded)
- Population caps: frog 90 (the marsh food base can't support more), per-species tuning of hunger gates / breeding cooldowns / mating ranges for a stable 20k-step run — all core species hold with margin (mice/hares/hamsters/frogs/crows at cap, foxes ~8–15, owls ~6–10, storks 4–8)

## [0.5.0] - 2026-09-12

### Added
- Herbivores — mouse/hare/hamster/deer + insect pollinators complete the food chain base: per-species energy budgets, grazing behavior with plant regrowth incl. deer tree-browsing (trees recover, not killed by normal browsing), insect pollination boosting plant yield/growth (per-plant cooldown), mice eat insects
- Sexes, breeding gates (maturity/energy/cooldown/pop-cap) and simplified trait inheritance with mutation on birth for all five species; deterministic per-biome seeding (~60 mice, ~24 hares, ~18 hamsters, ~8 deer, ~250 insect clusters on the default 300×300 world)
- Animal instanced rendering (per-species palette: hare medium brown, hamster tan stocky, deer large reddish-brown, insect tiny dark speck); population panel extended with a row per animal species

### Fixed
- Terrain mesh — restored missing triangle per heightmap cell (the second quad triangle was split along the wrong diagonal, leaving a triangular hole in every land cell); added headless geometry regression check (`scripts/checks/terrain.mjs`)

## [0.4.0] - 2026-09-12

### Added
- Pure-TS sim core — agent schema, deterministic stateless rng (`agentRand` + Gaussian), uniform spatial hash grid (flat counting-sort, no per-cell churn), shared energy model
- Plants as individual agents with a RimWorld-style stage machine (seedling → growing → fruiting → regrowth → senescence) and a `graze()` API; grass/clover/cranberry/reed/trees self-register into the species registry
- Deterministic world seeding per biome (~13k plants on the default 300×300 world); trees on a ~10 m lattice with birch/oak/pine variants
- Instanced rendering (one InstancedMesh per species, tree trunk+canopy share slot mapping) with incremental change-feed updates and per-instance colour jitter from `agentRand`
- Population panel overlay — one row per plant species with live count + average energy, refreshed ~4 Hz
- `window.__critterbox` debug surface extended: `agentCount` + `populations { [species]: {count, avgEnergy} }`; speed-multiplier hook left in the accumulator for Phase 8
- Headless checks (`scripts/checks/plants.mjs`, `spatial.mjs`) — determinism, growth/graze/regrowth cycle, senescence + overgrazing death, population sanity, spatial query vs brute force

## [0.3.0] - 2026-09-12

### Added
- Free-flight camera — WASD move, mouse-drag look (no pointer lock), arrow-key rotation as mouse replacement, Shift ×4 speed, wheel dolly
- Space pause with PAUSED overlay indicator; sim steps gated while paused, rendering continues
- `window.__critterbox` debug surface extended: live `camera {pos,yaw,pitch}` + `paused` / `setPaused(bool)`
- Playwright e2e camera spec (movement, rotation, dolly, pause, input-focus key guard)

## [0.2.0] - 2026-09-12

### Added
- Heightmap worldgen with seeded fBm noise (4 octaves, absolute feature scale — comparable relief across world sizes)
- Biomes meadow/forest/marsh/grassland from elevation × moisture; fixed water level carves rivers/lakes
- Terrain rendering: indexed heightmap mesh with per-biome vertex colors + translucent water plane
- Size-at-gen dialog (100–800 m, default 300) with seed input and live "New World" rebuild
- `window.__critterbox` debug surface (seed/size/waterLevel/heightAt/biomeAt/regenerate)
- Fixed-timestep accumulator skeleton in the render loop (30 steps/s, max-steps clamp) for Phase 3
- Headless determinism checks (`scripts/checks/worldgen.mjs`) + tsc-CJS compile step in sim-check runner
- Playwright e2e worldgen spec (debug surface + New World rebuild)

## [0.1.0] - 2026-09-12

### Added
- Project scaffold: Vite + TypeScript strict + Three.js, mirroring Sandfall house conventions
- PLAN.md — single source of truth (roadmap v0.1.0 → v0.9.0)
- Minimal placeholder scene (ground plane + title overlay); real worldgen lands in v0.2.0
- Headless sim-check runner stub (`scripts/sim-check.mjs`)
- Playwright e2e smoke test (global install convention), webServer on :4173
- Deploy skeleton: local nginx/Traefik docker setup (later retired in favor of GitHub Pages)
