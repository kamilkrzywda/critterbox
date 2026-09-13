/**
 * Environment indicator (Phase 7, PLAN "UI / HUD"): a small overlay showing the day/night phase + weather
 * state (+ temperature), refreshed ~4 Hz from the sim's live environment sample — same pattern as the
 * population panel. Plain DOM, styled to match the other panels (see index.html).
 */

import type { EnvSample } from '../sim/environment';

/** Wire up the environment indicator inside `container`; returns a disposer for teardown. */
export function initEnvPanel(
  container: HTMLElement,
  getEnv: () => EnvSample | null,
): { dispose(): void } {
  const phase = document.createElement('span');
  phase.className = 'env-phase';

  const weather = document.createElement('span');
  weather.className = 'env-weather';

  const temp = document.createElement('span');
  temp.className = 'env-temp';

  container.append(phase, weather, temp);

  function update(): void {
    const env = getEnv();
    if (!env) return;
    phase.textContent = env.phase;
    weather.textContent = env.weather;
    temp.textContent = `${Math.round(env.temperature)}°C`;
  }

  update(); // paint immediately so the indicator is visible before the first interval tick
  const timer = window.setInterval(update, 250); // ~4 Hz

  return {
    dispose(): void {
      window.clearInterval(timer);
      container.innerHTML = '';
    },
  };
}
