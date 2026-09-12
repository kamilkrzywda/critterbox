/**
 * Population panel (PLAN "UI / HUD"): a compact overlay listing one row per species — name + live count
 * (+ average energy/growth) — refreshed ~4 Hz from the sim's population stats. Plain DOM, styled to match
 * the world-gen panel. Animals are added to this same panel in Phase 4 by extending `rows`.
 */

export interface PopRow {
  id: string; // species registry key
  name: string; // display label
}

export interface PopulationData {
  [speciesId: string]: { count: number; avgEnergy: number };
}

/** Wire up the population panel inside `container`; returns a disposer for teardown. */
export function initPopulationPanel(
  container: HTMLElement,
  rows: PopRow[],
  getData: () => PopulationData,
): { dispose(): void } {
  const rowEls = new Map<string, { count: HTMLElement; avg: HTMLElement }>();

  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'pop-row';
    row.dataset.species = r.id;

    const label = document.createElement('span');
    label.className = 'pop-name';
    label.textContent = r.name;

    const count = document.createElement('span');
    count.className = 'pop-count';
    count.textContent = '0';

    const avg = document.createElement('span');
    avg.className = 'pop-avg';
    avg.textContent = '';

    row.append(label, count, avg);
    container.appendChild(row);
    rowEls.set(r.id, { count, avg });
  }

  function update(): void {
    const data = getData();
    for (const r of rows) {
      const els = rowEls.get(r.id)!;
      const entry = data[r.id];
      els.count.textContent = String(entry ? entry.count : 0);
      els.avg.textContent = entry && entry.count > 0 ? `${Math.round(entry.avgEnergy)} e` : '';
    }
  }

  update(); // paint immediately so rows are visible before the first interval tick
  const timer = window.setInterval(update, 250); // ~4 Hz

  return {
    dispose(): void {
      window.clearInterval(timer);
      container.innerHTML = '';
    },
  };
}
