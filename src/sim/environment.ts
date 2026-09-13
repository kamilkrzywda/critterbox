/**
 * Day/night cycle + weather (Phase 7, PLAN "Day/night & weather") — the "settings animator" layer
 * (Bibites-inspired): all time-varying sim parameters are sampled per tick from named curves around base
 * values. Pure TS (no three.js/DOM) so it runs headlessly; every value is a deterministic function of the
 * global step counter and/or the world seed — no accumulated state, no Math.random — so the same world
 * replays identically on any CPU, and `weatherAt` can be evaluated at ANY tick by replaying the seeded
 * Markov chain from t=0 (O(transitions) hash draws; tens even for very long runs).
 *
 * Time base: 30 sim steps/s at 1× (see main.ts). One full day/night cycle = DAY_TICKS + NIGHT_TICKS:
 *   - daylight window [0, DAY_TICKS): light follows a cosine arc — ~0 at dawn/dusk, ~1 at noon
 *   - night window [DAY_TICKS, CYCLE_TICKS): light is exactly 0 (no photosynthesis)
 * The phase label splits the cycle into dawn/day/dusk/night for the HUD. A "year" spans several cycles
 * and drives the slow seasonal temperature sine; weather (a seeded Markov chain over clear/cloudy/rain)
 * adds a small modifier on top.
 */

import { agentRand } from './rng';

// --- day/night clock ---------------------------------------------------------------------------

/** Daylight length in ticks (~2 min at 1×). */
export const DAY_TICKS = 3600;
/** Night length in ticks (~50 s at 1×). */
export const NIGHT_TICKS = 1500;
/** Full day+night period — lightAt/season repeat every CYCLE_TICKS steps. */
export const CYCLE_TICKS = DAY_TICKS + NIGHT_TICKS; // 5100
/** Dawn/dusk transition lengths in ticks (phase labels only — the light curve itself is a smooth cosine). */
const DAWN_TICKS = 300;
const DUSK_TICKS = 300;

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';

/** Position within the day/night cycle: [0,1), 0 = start of dawn. Pure function of the step counter. */
export function timeOfDay(step: number): number {
  return (step % CYCLE_TICKS) / CYCLE_TICKS;
}

/** Coarse phase label for the HUD/debug surface. */
export function dayPhase(step: number): DayPhase {
  const t = step % CYCLE_TICKS;
  if (t < DAWN_TICKS) return 'dawn';
  if (t < DAY_TICKS - DUSK_TICKS) return 'day';
  if (t < DAY_TICKS) return 'dusk';
  return 'night';
}

/**
 * Light level in [0,1]: a cosine arc over the daylight window — ~0 at dawn/dusk, ~1 at noon, exactly 0
 * through the night. Gates photosynthesis (plants), drives animal activity (owl nocturnal / fox+stork
 * diurnal) and the scene lighting. Period = CYCLE_TICKS by construction.
 */
export function lightAt(step: number): number {
  const t = step % CYCLE_TICKS;
  if (t >= DAY_TICKS) return 0; // night — no photosynthesis
  return 0.5 * (1 - Math.cos((2 * Math.PI * t) / DAY_TICKS));
}

// --- season + temperature ------------------------------------------------------------------------

/** One "year" = several day/night cycles (~8.5 min at 1×). */
export const YEAR_TICKS = CYCLE_TICKS * 3; // 15300
const TEMP_BASE = 15; // °C — annual mean
const TEMP_SEASON_AMP = 10; // seasonal swing → [5, 25] before weather modifiers

/** Seasonal component in [-1, 1]: -1 at midwinter (step ≡ 3·YEAR/4), +1 at midsummer. */
export function seasonAt(step: number): number {
  return Math.sin((2 * Math.PI * step) / YEAR_TICKS);
}

// --- weather (seeded Markov chain) -----------------------------------------------------------------

export type WeatherState = 'clear' | 'cloudy' | 'rain';

/** The state set — a sampled duration is always within the range of the state it belongs to. */
export const WEATHER_STATES: readonly WeatherState[] = ['clear', 'cloudy', 'rain'];
/** Per-state duration ranges in ticks, sampled uniformly via a deterministic hash of (world seed, step at
 *  state start). clear ~20–80 s, cloudy ~15–60 s, rain ~10–30 s (shorter showers) at 1×. */
export const DURATION_RANGE: Record<WeatherState, readonly [number, number]> = {
  clear: [600, 2400],
  cloudy: [450, 1800],
  rain: [300, 900],
};

/** Salt base distinguishing weather draws from agent-behaviour draws (see rng.ts). */
const WEATHER_SALT = 0x7ea7;

/** The initial state at t=0 — a uniform draw over all three states. */
function initialState(seed: number): WeatherState {
  return WEATHER_STATES[Math.floor(agentRand(seed, 0, WEATHER_SALT) * WEATHER_STATES.length)];
}

/** The next state after `prev` ends — a uniform draw over the OTHER two states (no self-transitions).
 *  Excluding the current state keeps every transition an observable change of weather, so each sampled
 *  duration is exactly one observed run (the Markov-validity check validates runs against DURATION_RANGE). */
function nextState(seed: number, startStep: number, prev: WeatherState): WeatherState {
  const others = WEATHER_STATES.filter((s) => s !== prev);
  return others[Math.floor(agentRand(seed, startStep, WEATHER_SALT) * others.length)];
}

function nextDuration(state: WeatherState, seed: number, startStep: number): number {
  const [lo, hi] = DURATION_RANGE[state];
  return lo + Math.floor(agentRand(seed, startStep, WEATHER_SALT + 1) * (hi - lo));
}

/**
 * The weather state at `step` — a pure replay of the seeded Markov chain from t=0: each state's duration is
 * hashed from (world seed, step at state start), so the whole sequence is reproducible headlessly and
 * identical across CPU runs. O(number of transitions up to `step`) — cheap enough to call per tick.
 */
export function weatherAt(seed: number, step: number): WeatherState {
  let start = 0;
  let state = initialState(seed);
  for (;;) {
    const end = start + nextDuration(state, seed, start);
    if (step < end) return state;
    start = end;
    state = nextState(seed, start, state);
  }
}

// --- temperature & derived multipliers ---------------------------------------------------------------

/** Weather modifiers in °C: rain cools slightly, clear warms a touch. */
const WEATHER_TEMP_MOD: Record<WeatherState, number> = { clear: 1.5, cloudy: 0, rain: -3 };

/** Readable air temperature (°C) at `step`: seasonal sine + weather modifier. Range ≈ [2, 26.5]. */
export function temperatureAt(seed: number, step: number): number {
  return TEMP_BASE + TEMP_SEASON_AMP * seasonAt(step) + WEATHER_TEMP_MOD[weatherAt(seed, step)];
}

/** Below this (°C), breeding is suppressed — the cold-snap gate in tryBreed. Only deep winter (+rain) dips
 *  below it: seasonal min is exactly 5 °C, so suppression needs rain to push under the threshold. */
export const BREED_TEMP_MIN = 5; // °C

/** Metabolism multiplier from temperature: cold → higher drain, mild by design (capped). At the coldest
 *  possible point (2 °C) the multiplier is 1 + 6×0.025 = 1.15 — a ~15% deep-winter burn increase, not a death
 *  spiral. Phase 7 stability tuning: the original slope (0.04 → max 1.24) tipped the near-break-even pike
 *  population negative over a year of winters; 0.025 keeps the effect visible without destabilizing it. */
const COLD_COMFORT = 8; // °C — metabolism rises only below this
const COLD_SLOPE = 0.025; // per °C below comfort
export const METAB_MULT_MAX = 1.3; // hard cap

export function metabolismMult(temperature: number): number {
  const m = 1 + Math.max(0, COLD_COMFORT - temperature) * COLD_SLOPE;
  return m > METAB_MULT_MAX ? METAB_MULT_MAX : m;
}

// --- fertility (plant-growth weather boost) -------------------------------------------------------------

/** Plant-growth multiplier per weather state: rain boosts growth (+water), cloudy a touch, clear baseline. */
const WEATHER_FERTILITY: Record<WeatherState, number> = { clear: 1.0, cloudy: 1.05, rain: 1.35 };

export function fertilityMult(weather: WeatherState): number {
  return WEATHER_FERTILITY[weather];
}

// --- per-tick sample (one call site per tick) -------------------------------------------------------------

/** Everything the sim needs for one tick — sampled once per stepCount and shared by plants + animals. */
export interface EnvSample {
  step: number;
  timeOfDay: number; // [0,1) position within the day/night cycle
  phase: DayPhase;
  light: number; // [0,1] — photosynthesis gate + activity driver
  weather: WeatherState;
  temperature: number; // °C (seasonal sine + weather modifier)
  metabolismMult: number; // animal drain multiplier (cold → up to METAB_MULT_MAX)
  fertilityMult: number; // plant-growth weather boost
}

/** Sample the full environment for one tick — pure in (seed, step). */
export function sampleEnvironment(seed: number, step: number): EnvSample {
  const light = lightAt(step);
  const weather = weatherAt(seed, step);
  const temperature = TEMP_BASE + TEMP_SEASON_AMP * seasonAt(step) + WEATHER_TEMP_MOD[weather];
  return {
    step,
    timeOfDay: (step % CYCLE_TICKS) / CYCLE_TICKS,
    phase: dayPhase(step),
    light,
    weather,
    temperature,
    metabolismMult: metabolismMult(temperature),
    fertilityMult: WEATHER_FERTILITY[weather],
  };
}
