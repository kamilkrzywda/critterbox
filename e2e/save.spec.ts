import { expect, test } from '@playwright/test';

/**
 * Save/restore e2e (Phase 8): a fresh context has no stored save; saveNow() stores the live world
 * (seed + step); reload restores THAT exact world before first render — same seed, step counter restored
 * verbatim (+ a few ticks since boot), populations present. New World with a new seed overwrites the
 * store, and a subsequent reload resumes the NEW world from it. Each test gets a fresh browser profile,
 * so IndexedDB starts empty. #scene visibility is the boot gate (async restore-on-load appends it last).
 */

type Page = import('@playwright/test').Page;

interface State { seed: number; tick: number; agentCount: number; populations: { [s: string]: { count: number } } }
interface SaveInfo { hasSave: boolean; seed?: number; size?: number; step?: number; agentCount?: number }

const sf = {
  state: (page: Page) =>
    page.evaluate(() => {
      const c = window.__critterbox;
      return { seed: c.seed, tick: c.tick, agentCount: c.agentCount, populations: c.populations };
    }),
  saveNow: (page: Page) => page.evaluate(() => window.__critterbox.saveNow()),
  loadStateInfo: (page: Page) => page.evaluate(async () => await window.__critterbox.loadStateInfo()),
};

test('save/restore round-trip + New World overwrite', async ({ page }) => {
  test.setTimeout(60_000); // generous budget — two reloads + worker gzip round-trips under load

  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists

  // Fresh profile: no stored save yet.
  let info = await sf.loadStateInfo(page);
  expect(info.hasSave).toBe(false);

  // Let the sim tick so step > 0, then force a save and verify the stored blob describes this world.
  await page.waitForTimeout(1500);
  const before: State = await sf.state(page);
  expect(before.seed).toBe(1337);
  expect(before.tick).toBeGreaterThan(0);
  await sf.saveNow(page);
  info = await sf.loadStateInfo(page);
  expect(info.hasSave).toBe(true);
  expect(info.seed).toBe(1337);
  expect((info.step ?? -1)).toBeGreaterThanOrEqual(before.tick);

  // Reload → restore-on-load brings the saved world back before first render: same seed, step counter
  // restored verbatim (+ a few ticks since boot — NOT a fresh world, which would sit at ~0), populations.
  await page.reload();
  await expect(page.locator('#scene')).toBeVisible();
  const restored: State = await sf.state(page);
  expect(restored.seed).toBe(1337);
  expect(restored.tick).toBeGreaterThanOrEqual(info.step ?? 0);
  expect(restored.tick - (info.step ?? 0)).toBeLessThan(400);
  expect(restored.agentCount).toBeGreaterThan(1000); // populations present after restore
  expect((restored.populations.mouse?.count ?? 0)).toBeGreaterThan(0);

  // New World with a new seed overwrites the store…
  await page.fill('#seed-input', '424242');
  await page.click('#new-world-btn');
  const st: State = await sf.state(page);
  expect(st.seed).toBe(424242); // live world rebuilt
  await expect.poll(async () => (await sf.loadStateInfo(page)).seed, { timeout: 10_000 }).toBe(424242); // …and the store follows

  // …and a reload resumes the NEW world from the store.
  await page.waitForTimeout(1500);
  await sf.saveNow(page);
  const info2 = await sf.loadStateInfo(page);
  expect(info2.seed).toBe(424242);
  expect((info2.step ?? -1)).toBeGreaterThan(0);

  await page.reload();
  await expect(page.locator('#scene')).toBeVisible();
  const restored2: State = await sf.state(page);
  expect(restored2.seed).toBe(424242); // from the store — not a fresh default-seed world
  expect(restored2.tick).toBeGreaterThanOrEqual(info2.step ?? 0);
  expect(restored2.tick - (info2.step ?? 0)).toBeLessThan(400);
  expect((restored2.populations.mouse?.count ?? 0)).toBeGreaterThan(0);
});
