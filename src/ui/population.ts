/**
 * Population panel (PLAN "UI / HUD"): a compact overlay listing one row per species — name + live count
 * (+ average energy/growth) — refreshed ~4 Hz from the sim's population stats. Plain DOM, styled to match
 * the world-gen panel. Phase 4 adds an animals section: `header` rows render as dividers above animal rows.
 */

export interface PopRow {
  id: string; // species registry key (or a synthetic id for header rows)
  name: string; // display label
  /** Section divider row (no count/avg) — e.g. the "animals" header above animal rows. */
  header?: boolean;
}

export interface PopulationData {
  [speciesId: string]: { count: number; avgEnergy: number };
}

export interface PopulationPanelOptions {
  /** Called with the species id when a row is hovered, null when the pointer leaves all rows (v0.10 hover highlight). */
  onHoverSpecies?: (id: string | null) => void;
}

/** Wire up the population panel inside `container`; returns a disposer for teardown. */
export function initPopulationPanel(
  container: HTMLElement,
  rows: PopRow[],
  getData: () => PopulationData,
  options: PopulationPanelOptions = {},
): { dispose(): void } {
  const rowEls = new Map<string, { count: HTMLElement; avg: HTMLElement }>();

  for (const r of rows) {
    if (r.header) {
      const header = document.createElement('div');
      header.className = 'pop-section';
      header.textContent = r.name;
      container.appendChild(header);
      continue; // no live stats on dividers
    }

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
      if (r.header) continue; // dividers carry no stats
      const els = rowEls.get(r.id)!;
      const entry = data[r.id];
      els.count.textContent = String(entry ? entry.count : 0);
      els.avg.textContent = entry && entry.count > 0 ? `${Math.round(entry.avgEnergy)} e` : '';
    }
  }

  update(); // paint immediately so rows are visible before the first interval tick
  const timer = window.setInterval(update, 250); // ~4 Hz

  // Hover highlight wiring (v0.10): event DELEGATION on the container instead of per-row listeners —
  // rows are built once and only their text updates at ~4 Hz, but delegation keeps exactly one listener
  // pair no matter how often the row set is ever rebuilt (no leaks/duplicates across panel updates).
  let over: ((e: MouseEvent) => void) | null = null;
  let out: ((e: MouseEvent) => void) | null = null;
  if (options.onHoverSpecies) {
    const onHover = options.onHoverSpecies;
    /** Species id of the row under `el`, or null for headers/dividers/outside. */
    const rowId = (el: EventTarget | null): string | null => {
      const r = el instanceof HTMLElement ? el.closest<HTMLElement>('.pop-row') : null;
      return r?.dataset.species ?? null;
    };
    over = (e) => onHover(rowId(e.target));
    out = (e) => {
      if (rowId(e.relatedTarget)) return; // still inside some row — its mouseover will update the hover
      onHover(null);
    };
    container.addEventListener('mouseover', over);
    container.addEventListener('mouseout', out);
  }

  return {
    dispose(): void {
      window.clearInterval(timer);
      if (over && out) {
        container.removeEventListener('mouseover', over);
        container.removeEventListener('mouseout', out);
      }
      options.onHoverSpecies?.(null); // a disposed panel can't keep a species hovered
      container.innerHTML = '';
    },
  };
}
