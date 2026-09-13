import { expect, test } from '@playwright/test';

/**
 * Day/night + weather e2e (Phase 7): the debug surface exposes tick/timeOfDay/dayPhase/light/temperature/
 * weather; after a few seconds of unpaused sim the clock has advanced and light stays within [0,1]; the
 * HUD environment indicator is visible in the DOM with a phase + weather reading.
 */

test('environment: clock advances, light tracks the day/night cycle, HUD indicator visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();

  const readEnv = () =>
    page.evaluate(() => {
      const cb = window.__critterbox;
      return { tick: cb.tick, timeOfDay: cb.timeOfDay, dayPhase: cb.dayPhase, light: cb.light, temperature: cb.temperature, weather: cb.weather };
    });

  const before = await readEnv();
  expect(typeof before.tick).toBe('number');
  expect(before.timeOfDay).toBeGreaterThanOrEqual(0);
  expect(before.timeOfDay).toBeLessThan(1);
  expect(['dawn', 'day', 'dusk', 'night']).toContain(before.dayPhase);
  expect(['clear', 'cloudy', 'rain']).toContain(before.weather);
  expect(before.light).toBeGreaterThanOrEqual(0);
  expect(before.light).toBeLessThanOrEqual(1);
  expect(typeof before.temperature).toBe('number');

  await page.waitForTimeout(3000); // ~90 sim ticks at 1× — the clock must have moved
  const after = await readEnv();
  expect(after.tick).toBeGreaterThan(before.tick);
  expect(after.timeOfDay).not.toBe(before.timeOfDay); // light/dayPhase are pure functions of this advancing clock
  expect(after.light).toBeGreaterThanOrEqual(0);
  expect(after.light).toBeLessThanOrEqual(1);

  await expect(page.locator('#env-panel')).toBeVisible();
  const envText = (await page.locator('#env-panel').textContent()) ?? '';
  expect(envText).toMatch(/dawn|day|dusk|night/);
  expect(envText).toMatch(/clear|cloudy|rain/);
});
