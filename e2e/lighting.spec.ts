import { expect, test } from '@playwright/test';

/**
 * Celestial lighting e2e (v0.15 "bling"): the sun/moon arc moves with the sim clock (celestial() via the
 * debug surface), and the cursor ground-light follows the mouse on the terrain — MOUSE ONLY, a touch tap
 * never creates it. #scene visibility is the boot gate; the arc test runs at 8× so ~240 ticks/s pass and
 * most of a full day/night cycle elapses in 6 s (the sun must travel far more than the 5 m threshold).
 * Kept < 20 s total.
 */

interface Surface {
  setSpeed(x: number): void;
  heightAt(x: number, z: number): number;
  celestial(): { sunPos: [number, number, number]; moonPos: [number, number, number] };
  cursorLight(): [number, number, number] | null;
}

function celestial(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as unknown as { __critterbox: Surface }).__critterbox.celestial());
}

function cursorLight(page: import('@playwright/test').Page): Promise<[number, number, number] | null> {
  return page.evaluate(() => (window as unknown as { __critterbox: Surface }).__critterbox.cursorLight());
}

test('celestial: sun/moon positions finite at boot, sun moves with the sim clock', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists
  const c0 = await celestial(page);
  for (const p of [c0.sunPos, c0.moonPos]) {
    for (const v of p) expect(Number.isFinite(v)).toBe(true);
  }

  // 8× speed → ~240 ticks/s; 6 s ≈ most of a full cycle → the sun sphere must travel far.
  await page.evaluate(() => (window as unknown as { __critterbox: Surface }).__critterbox.setSpeed(8));
  await page.waitForTimeout(6000);
  const c1 = await celestial(page);
  const moved = Math.hypot(c1.sunPos[0] - c0.sunPos[0], c1.sunPos[1] - c0.sunPos[1], c1.sunPos[2] - c0.sunPos[2]);
  expect(moved).toBeGreaterThan(5);
});

test('cursor ground-light: follows the mouse on the terrain, hides off-canvas', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists

  // Mouse over the canvas centre → a pool appears where that ray meets the ground.
  await page.mouse.move(640, 360);
  await expect.poll(() => cursorLight(page)).not.toBeNull();
  const hit = await cursorLight(page); // stable — the pointer is stationary, no events in flight
  expect(hit).not.toBeNull();
  // The pool sits ~0.6 m above the terrain at its own xz (the light's resting height).
  const groundY = await page.evaluate((pt: [number, number, number]) => {
    return (window as unknown as { __critterbox: Surface }).__critterbox.heightAt(pt[0], pt[2]);
  }, hit);
  expect(Math.abs(hit[1] - (groundY + 0.6))).toBeLessThan(1);

  // Move onto a HUD panel (the world-gen panel, top-right) → pointerleave hides the pool.
  await page.mouse.move(1150, 80);
  await expect.poll(() => cursorLight(page)).toBeNull();
});

test.describe('touch gate', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true }); // mirrors mobile.spec.ts

  test('a touch tap never creates the cursor ground-light', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists
    await page.touchscreen.tap(195, 420); // canvas centre — may select an agent; either way no pool
    expect(await cursorLight(page)).toBeNull();
  });
});
