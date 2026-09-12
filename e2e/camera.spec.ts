import { expect, test } from '@playwright/test';

/**
 * Free-flight camera e2e (Phase 2): reads camera state via window.__critterbox.camera and verifies
 * WASD movement, arrow-key rotation (mouse replacement), wheel dolly, Space pause with the PAUSED
 * overlay, and that keys stay inert while a text input has focus. One consolidated read per step —
 * each round-trip on this host can queue behind main-thread work (Sandfall lesson C2). Kept < 15 s.
 */

type CameraState = { pos: [number, number, number]; yaw: number; pitch: number };

function cam(page: import('@playwright/test').Page): Promise<CameraState> {
  return page.evaluate(() => (window as unknown as { __critterbox: { camera: CameraState } }).__critterbox.camera);
}

function pausedFlag(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __critterbox: { paused: boolean } }).__critterbox.paused);
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

test('free-flight camera: WASD move, arrow rotate, wheel dolly, space pause', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();
  const c0 = await cam(page);
  // Initial framing: above the world centre at ~60% of size altitude, looking down (~45°).
  expect(c0.pos[1]).toBeGreaterThan(0);
  expect(c0.pitch).toBeLessThan(0);

  // Hold W for ~500 ms → moved > 1 m along the view direction.
  await page.keyboard.down('w');
  await page.waitForTimeout(500);
  await page.keyboard.up('w');
  const c1 = await cam(page);
  expect(dist(c0.pos, c1.pos)).toBeGreaterThan(1);

  // Hold ArrowRight briefly → yaw changed (turning right decreases yaw).
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(200);
  await page.keyboard.up('ArrowRight');
  const c2 = await cam(page);
  expect(c2.yaw).not.toBe(c1.yaw);

  // Wheel over the canvas → dollied along the view direction.
  await page.mouse.move(480, 360);
  await page.mouse.wheel(0, -100);
  const c3 = await cam(page);
  expect(dist(c2.pos, c3.pos)).toBeGreaterThan(0.5);

  // Space → paused + PAUSED overlay visible; again → unpaused and hidden.
  await page.keyboard.press('Space');
  expect(await pausedFlag(page)).toBe(true);
  await expect(page.locator('#paused-overlay')).toBeVisible();
  await page.keyboard.press('Space');
  expect(await pausedFlag(page)).toBe(false);
  await expect(page.locator('#paused-overlay')).not.toBeVisible();

  // Keys stay inert while the seed input has focus (typing must not fly the camera).
  const c4 = await cam(page);
  await page.click('#seed-input');
  await page.keyboard.down('w');
  await page.waitForTimeout(150);
  await page.keyboard.up('w');
  const c5 = await cam(page);
  expect(dist(c4.pos, c5.pos)).toBe(0);
});
