import { expect, test } from '@playwright/test';

/**
 * Sim-speed slider e2e (Phase 8): setSpeed drives the fixed-timestep accumulator. The assertions are
 * deliberately FPS-INDEPENDENT — this dev box's headless Chromium renders at ~2–4 fps (software GL), where
 * the anti-spiral max-steps clamp caps every speed ≥ ~0.7× at the same ceiling, so an absolute "4× ≈ 4×
 * baseline" ratio is physically unachievable here (the sim simply can't do 120 ticks/s of CPU). Instead:
 *   - 0× freezes the tick over ~0.75 s of wall time (+ PAUSED overlay in sync with the slider);
 *   - proportionality holds in the unclamped regime: rate(0.6×) ≈ 2 × rate(0.3×) at ANY fps (both stay
 *     below the max-steps clamp, so the accumulator is exact and any dt-clamp distortion cancels out);
 *   - monotonicity above it: rate(4×) ≥ rate(0.6×) — clamping can cap a speed, never run it slower;
 *   - the DOM slider drives the same state and persists to localStorage (Sandfall convention).
 * #scene visibility is the boot gate (async restore-on-load appends it last).
 */

type Critterbox = { speed: number; setSpeed(x: number): void; tick: number };

function cb(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = (window as unknown as { __critterbox: Critterbox }).__critterbox;
    return { speed: c.speed, tick: c.tick };
  });
}

function setSpeed(page: import('@playwright/test').Page, v: number) {
  return page.evaluate((x) => (window as unknown as { __critterbox: Critterbox }).__critterbox.setSpeed(x), v);
}

/** Average tick rate (ticks/s) over a fixed wall-time window at the current speed. */
async function rate(page: import('@playwright/test').Page, ms: number): Promise<number> {
  const t0 = (await cb(page)).tick;
  await page.waitForTimeout(ms);
  return ((await cb(page)).tick - t0) / (ms / 1000);
}

test('speed slider: 0 freezes the tick, higher speeds run faster', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists

  // 0× → tick frozen over ~0.75 s of wall time, PAUSED overlay shown in sync with the slider.
  await setSpeed(page, 0);
  const f0 = (await cb(page)).tick;
  await page.waitForTimeout(750);
  expect((await cb(page)).tick - f0).toBeLessThan(2); // frozen — no ticks at all
  await expect(page.locator('#paused-overlay')).toBeVisible();

  // Proportionality in the unclamped regime (both speeds stay below the max-steps clamp at any fps):
  // rate(0.6×) ≈ 2 × rate(0.3×). A broken multiplier (constant rate) would give ratio ≈ 1 and fail.
  // Windows are long relative to a frame so low-fps quantization (±1 frame per window) stays inside the
  // tolerance; on a normal display the ratio is ~2.0 with tiny noise.
  await setSpeed(page, 0.3);
  const r3 = await rate(page, 4000);
  expect(r3).toBeGreaterThan(0); // sanity: the sim actually ticks at 0.3×
  await setSpeed(page, 0.6);
  const r6 = await rate(page, 4000);
  const ratio = r6 / r3;
  expect(ratio).toBeGreaterThan(1.45);
  expect(ratio).toBeLessThan(2.65);

  // Monotonicity above the clamp: 4× runs at least as fast as 0.6× (on a normal display ≈ 4× real-time;
  // on this low-fps box the max-steps clamp caps it, which is exactly what this assertion tolerates —
  // clamping can only cap a speed's rate, never run it slower than an unclamped one).
  await setSpeed(page, 4);
  expect((await cb(page)).speed).toBe(4);
  await expect(page.locator('#paused-overlay')).not.toBeVisible();
  const r4 = await rate(page, 4000);
  expect(r4).toBeGreaterThanOrEqual(r6 * 0.85); // ±1-frame window-alignment slack at very low fps

  // The DOM slider drives the same state and persists to localStorage (Sandfall convention).
  await page.evaluate(() => {
    const el = document.getElementById('speed-slider') as HTMLInputElement;
    el.value = '2';
    el.dispatchEvent(new Event('input'));
  });
  expect((await cb(page)).speed).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem('critterbox.speed'))).toBe('2');
});
