/**
 * Entity inspector (Phase 8, PLAN "Inspector"): a side panel showing ALL live parameters of the selected
 * agent — species, sex (animals), age, energy, every trait value, current state, position — refreshed at
 * ~10 Hz while open. Plain DOM, styled to match the other panels (see index.html). The selection itself
 * lives in main.ts (raycast click / debug surface); this module only renders whatever `getAgent` returns
 * and hides when it goes null (deselected, or the agent died — main.ts clears the selection then too).
 */

import type { Agent } from '../sim/types';
import { getSpecies } from '../sim/registry';

export interface InspectorPanelOptions {
  /** Fired when the panel's visibility flips (v0.14 mobile: main.ts hides the population panel behind the
   *  full-width inspector sheet on narrow screens). Called only on a change, not every ~10 Hz refresh. */
  onVisible?: (visible: boolean) => void;
}

/** Wire up the inspector panel inside `container`; returns a disposer for teardown. */
export function initInspectorPanel(
  container: HTMLElement,
  getAgent: () => Agent | null,
  options: InspectorPanelOptions = {},
): { dispose(): void } {
  const title = document.createElement('div');
  title.className = 'insp-title';
  title.textContent = 'inspector';
  container.appendChild(title);

  const body = document.createElement('div');
  container.appendChild(body);

  /** label → value element, in display order (rebuilt when the row set changes — e.g. species switch). */
  let rows: { label: string; el: HTMLElement }[] = [];
  let lastKey = '';

  function render(a: Agent): void {
    const sp = getSpecies(a.species);
    const data: [string, string][] = [];
    data.push(['species', sp?.displayName ?? a.species]);
    if (a.sex) data.push(['sex', a.sex === 'm' ? 'male' : 'female']); // animals only — plants have no sex
    data.push(['age', `${Math.floor(a.age)} ticks`]);
    data.push(['energy', a.energy.toFixed(1)]);
    data.push(['state', a.state]);
    if (a.traits) {
      for (const k of Object.keys(a.traits).sort()) data.push([k, a.traits[k].toFixed(2)]); // every trait value
    }
    data.push(['position', `${a.pos.x.toFixed(1)}, ${a.pos.y.toFixed(1)}, ${a.pos.z.toFixed(1)}`]);

    const key = data.map((d) => d[0]).join('\n');
    if (key !== lastKey) { // row set changed → rebuild the DOM rows once
      body.innerHTML = '';
      rows = [];
      for (const [label] of data) {
        const row = document.createElement('div');
        row.className = 'insp-row';
        const lab = document.createElement('span');
        lab.className = 'insp-label';
        lab.textContent = label;
        const val = document.createElement('span');
        val.className = 'insp-value';
        row.append(lab, val);
        body.appendChild(row);
        rows.push({ label, el: val });
      }
      lastKey = key;
    }
    for (let i = 0; i < data.length; i++) rows[i].el.textContent = data[i][1]; // live values at ~10 Hz
  }

  let visible = false; // last known visibility — onVisible fires only on a flip, not every ~10 Hz refresh
  function update(): void {
    const a = getAgent();
    if (!a) {
      container.style.display = 'none';
      if (visible) { visible = false; options.onVisible?.(false); }
      return;
    }
    container.style.display = 'block';
    render(a);
    if (!visible) { visible = true; options.onVisible?.(true); }
  }

  update(); // paint immediately (hidden when nothing is selected yet)
  const timer = window.setInterval(update, 100); // ~10 Hz while open

  return {
    dispose(): void {
      window.clearInterval(timer);
      if (visible) { visible = false; options.onVisible?.(false); } // a disposed panel can't stay open
      container.innerHTML = '';
    },
  };
}
