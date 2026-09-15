import { expect, test } from '@playwright/test';

/**
 * Celestial lighting e2e (v0.15 "bling"): the sun/moon arc moves with the sim clock (celestial() via the
 * debug surface), and the cursor ground-light follows the mouse on the terrain — MOUSE ONLY, a touch tap
 * never creates it, and NIGHT-ONLY (v0.16): its darkness factor is 1 at boot (dawn, light ≈ 0) and fades to
 * 0 as morning light rises. #scene visibility is the boot gate; the arc test runs at 8× so ~240 ticks/s pass
 * and most of a full day/night cycle elapses in 6 s (the sun must travel far more than the 5 m threshold).
 * Kept < 20 s total.
 */

interface Surface {
  setSpeed(x: number): void;
  advanceTicks(n: number): void;
  tick: number;
  heightAt(x: number, z: number): number;
  celestial(): { sunPos: [number, number, number]; moonPos: [number, number, number] };
  cursorLight(): [number, number, number] | null;
  cursorNightFactor(): number;
}

function celestial(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as unknown as { __critterbox: Surface }).__critterbox.celestial());
}

function cursorLight(page: import('@playwright/test').Page): Promise<[number, number, number] | null> {
  return page.evaluate(() => (window as unknown as { __critterbox: Surface }).__critterbox.cursorLight());
}

function cursorNightFactor(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __critterbox: Surface }).__critterbox.cursorNightFactor());
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

test('cursor ground-light: follows the mouse on the terrain, night-only, hides off-canvas', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists

  // Mouse over the canvas centre → a pool appears where that ray meets the ground.
  await page.mouse.move(640, 360);
  await expect.poll(() => cursorLight(page)).not.toBeNull();
  const hit = await cursorLight(page); // stable — the pointer is stationary, no events in flight
  expect(hit).not.toBeNull();
  // The surface reports the GROUND contact point (the light itself floats ~1.2 m above it).
  const groundY = await page.evaluate((pt: [number, number, number]) => {
    return (window as unknown as { __critterbox: Surface }).__critterbox.heightAt(pt[0], pt[2]);
  }, hit);
  expect(Math.abs(hit[1] - groundY)).toBeLessThan(0.5);

  // Night-only (v0.16): at boot the world is at dawn with light ≈ 0 → full darkness factor...
  expect(await cursorNightFactor(page)).toBeGreaterThan(0.9);
  // ...and it fades out as morning light rises. Headless frames run far slower than 8×, so instead of waiting on
  // wall-clock the clock is jumped deterministically: tick 1200 → light ≈ 0.75 → factor 0 (the fade completes once
  // light ≥ 0.4, ~785 ticks in).
  await page.evaluate(() => {
    const cb = (window as unknown as { __critterbox: Surface }).__critterbox;
    cb.advanceTicks(1200 - cb.tick);
  });
  expect(await cursorNightFactor(page)).toBeLessThan(0.1);
  // The position is still reported while the pointer is over ground — only visibility/intensity are night-gated.
  expect(await cursorLight(page)).not.toBeNull();

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
