import { expect, test } from '@playwright/test';

/**
 * Animal ecosystem e2e (Phase 4): on load the sim is seeded with mice and they show up in the live
 * population stats + panel row. Reads go through window.__critterbox inside page.evaluate (evaluate
 * serializes its return value, so only plain data crosses the boundary — Sandfall lesson C2).
 */

type Pops = { [species: string]: { count: number; avgEnergy: number } };
interface CritterboxSim {
  populations: Pops;
}

test('mouse population present on load', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();

  const pops = await page.evaluate(() => {
    return (window as unknown as { __critterbox: CritterboxSim }).__critterbox.populations;
  });
  expect(pops.mysz?.count ?? 0).toBeGreaterThan(0);

  // The population panel shows the animals section with a live mouse row.
  const panel = page.locator('#population-panel');
  await expect(panel.locator('.pop-row[data-species="mysz"]')).toBeVisible();
});
