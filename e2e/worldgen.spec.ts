import { expect, test } from '@playwright/test';

/**
 * Worldgen e2e (Phase 1): the debug surface reports the generated world, and "New World" with a
 * changed seed rebuilds the terrain live. Methods are called INSIDE page.evaluate — evaluate
 * serializes its return value, so only plain data crosses the boundary. Kept fast: one consolidated
 * read of app state per step (Sandfall lesson C2).
 */

type CritterboxState = { version: string; seed: number; worldSize: number; waterLevel: number };

function critterbox(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = (window as unknown as { __critterbox: CritterboxState }).__critterbox;
    return { version: c.version, seed: c.seed, worldSize: c.worldSize, waterLevel: c.waterLevel };
  });
}

function heightAt(page: import('@playwright/test').Page, x: number, z: number) {
  return page.evaluate(([px, pz]) => (window as unknown as { __critterbox: { heightAt(x: number, z: number): number } }).__critterbox.heightAt(px, pz), [x, z] as const);
}

test('world loads with default size and debug surface', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();
  const cb = await critterbox(page);
  expect(cb.worldSize).toBe(300);
  expect(Number.isFinite(cb.waterLevel)).toBeTruthy();
  expect(await heightAt(page, 10, 10)).not.toBeNaN();
});

test('New World with a changed seed rebuilds the terrain', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists
  const before = await critterbox(page);
  const hBefore = await heightAt(page, 12.5, -34.5);

  await page.fill('#seed-input', '987654');
  await page.click('#new-world-btn');

  const after = await critterbox(page);
  expect(after.seed).toBe(987654);
  expect(after.worldSize).toBe(300);
  // Terrain rebuilt from the new seed — a sampled height differs (continuous values, no ties).
  expect(await heightAt(page, 12.5, -34.5)).not.toBe(hBefore);
});
