import { expect, test } from '@playwright/test';

/**
 * Animal ecosystem e2e (Phase 4 Part B): on load the sim is seeded with all five herbivore species and
 * they show up in the live population stats + panel rows; left unpaused for a few seconds the total animal
 * count changes (insects mature fast and breed, some starve). Reads go through window.__critterbox inside
 * page.evaluate (evaluate serializes its return value, so only plain data crosses the boundary — Sandfall
 * lesson C2).
 */

type Pops = { [species: string]: { count: number; avgEnergy: number } };
interface CritterboxSim {
  populations: Pops;
}

const ANIMALS = ['mouse', 'hare', 'hamster', 'deer', 'insect'];
/** Phase 5: frogs + the predator/scavenger layer. */
const PHASE5_ANIMALS = ['frog', 'fox', 'stork', 'owl', 'crow'];
/** Phase 6: the aquatic layer — carp + pike in the river volume. */
const PHASE6_ANIMALS = ['carp', 'pike'];

test('all five herbivore species present on load', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();

  const pops = await page.evaluate(() => {
    return (window as unknown as { __critterbox: CritterboxSim }).__critterbox.populations;
  });
  for (const sp of ANIMALS) {
    expect(pops[sp]?.count ?? 0, `${sp} count`).toBeGreaterThan(0);
  }

  // The population panel shows the animals section with a live row per species.
  const panel = page.locator('#population-panel');
  for (const sp of ANIMALS) {
    await expect(panel.locator(`.pop-row[data-species="${sp}"]`)).toBeVisible();
  }
});

test('sim runs unpaused and the total animal count changes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();

  const readTotal = () =>
    page.evaluate((species: string[]) => {
      const pops = (window as unknown as { __critterbox: CritterboxSim }).__critterbox.populations;
      return species.reduce((s, sp) => s + (pops[sp]?.count ?? 0), 0);
    }, ANIMALS);

  const initial = await readTotal();
  expect(initial).toBeGreaterThan(0);

  // Poll up to ~10 s: insects mature in ~4 s of sim time and breed (and some starve), so the total must
  // change while unpaused. Exits as soon as it does — typically well under the budget.
  let changed = -1;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(400);
    const t = await readTotal();
    if (t !== initial) {
      changed = t;
      break;
    }
  }
  expect(changed, `total animal count after running unpaused (started ${initial})`).toBeGreaterThan(-1);
});

test('Phase 5 species present on load: frog, fox, stork, owl, crow', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();

  const pops = await page.evaluate(() => {
    return (window as unknown as { __critterbox: CritterboxSim }).__critterbox.populations;
  });
  for (const sp of PHASE5_ANIMALS) {
    expect(pops[sp]?.count ?? 0, `${sp} count`).toBeGreaterThan(0);
  }

  // The population panel shows a live row per Phase 5 species.
  const panel = page.locator('#population-panel');
  for (const sp of PHASE5_ANIMALS) {
    await expect(panel.locator(`.pop-row[data-species="${sp}"]`)).toBeVisible();
  }
});

test('Phase 6 species present on load: carp, pike', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();

  const pops = await page.evaluate(() => {
    return (window as unknown as { __critterbox: CritterboxSim }).__critterbox.populations;
  });
  for (const sp of PHASE6_ANIMALS) {
    expect(pops[sp]?.count ?? 0, `${sp} count`).toBeGreaterThan(0);
  }

  // The population panel shows a live row per Phase 6 species.
  const panel = page.locator('#population-panel');
  for (const sp of PHASE6_ANIMALS) {
    await expect(panel.locator(`.pop-row[data-species="${sp}"]`)).toBeVisible();
  }
});
