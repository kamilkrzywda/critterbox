import { expect, test } from '@playwright/test';

/**
 * Plant ecosystem e2e (Phase 3): on load the sim is seeded with a large plant population and the
 * population panel renders one row per species. Reads go through window.__critterbox inside page.evaluate
 * (evaluate serializes its return value, so only plain data crosses the boundary — Sandfall lesson C2).
 */

type Pops = { [species: string]: { count: number; avgEnergy: number } };
interface CritterboxSim {
  agentCount: number;
  populations: Pops;
}

test('plant ecosystem loads with a populated sim and population panel', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();

  const cb = await page.evaluate(() => {
    const c = (window as unknown as { __critterbox: CritterboxSim }).__critterbox;
    return { agentCount: c.agentCount, populations: c.populations };
  });

  // A default world seeds thousands of plants.
  expect(cb.agentCount).toBeGreaterThan(1000);
  expect(cb.populations.grass?.count ?? 0).toBeGreaterThan(0);
  expect(cb.populations.tree?.count ?? 0).toBeGreaterThan(0);

  // The population panel shows a live row for every plant species.
  const panel = page.locator('#population-panel');
  await expect(panel).toBeVisible();
  for (const sp of ['grass', 'clover', 'cranberry', 'reed', 'tree']) {
    await expect(panel.locator(`.pop-row[data-species="${sp}"]`)).toBeVisible();
  }
});
