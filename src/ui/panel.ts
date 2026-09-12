/**
 * World-gen dialog (Phase 1): size slider (100–800 m), seed input, "New World" button.
 * Plain DOM, no framework — styled to match the scaffold overlay look (see index.html).
 */

import { parseSeed, randomSeed } from '../worldgen/worldgen';

export interface PanelCallbacks {
  /** Called with the parsed seed (random when the input is empty/invalid) and slider size. */
  onNewWorld(seed: number, size: number): void;
}

/** Wire up the #world-panel controls; returns a refresher for the current-world readout. */
export function initWorldgenPanel(cb: PanelCallbacks): { setWorld(seed: number, size: number): void } {
  const slider = document.getElementById('size-slider') as HTMLInputElement | null;
  const seedInput = document.getElementById('seed-input') as HTMLInputElement | null;
  const button = document.getElementById('new-world-btn');
  const info = document.getElementById('world-info');
  const sizeLabel = document.getElementById('size-label');

  if (slider) {
    slider.addEventListener('input', () => {
      if (sizeLabel) sizeLabel.textContent = `${slider.value} m`;
      if (info) info.textContent = `size ${slider.value} m`;
    });
  }
  if (button && slider && seedInput) {
    button.addEventListener('click', () => {
      const size = Number(slider.value);
      const parsed = parseSeed(seedInput.value);
      const seed = parsed !== null ? parsed : randomSeed(); // empty/invalid → randomize (Sandfall convention)
      cb.onNewWorld(seed, size);
    });
  }

  return {
    setWorld(seed: number, size: number): void {
      if (seedInput) seedInput.value = String(seed);
      if (slider) slider.value = String(size);
      if (sizeLabel) sizeLabel.textContent = `${size} m`;
      if (info) info.textContent = `seed ${seed} · ${size} m`;
    },
  };
}
