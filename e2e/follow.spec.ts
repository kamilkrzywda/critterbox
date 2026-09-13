import { expect, test } from '@playwright/test';

/**
 * Hover-inspect + follow-camera e2e (v0.11):
 *  - hovering an agent previews it in the inspector (real pointer moves — the world is deterministic,
 *    so whatever sits under a given screen point is stable across runs); leaving the canvas clears it;
 *  - selecting an ANIMAL starts the follow-camera (`following` set, camera tracks with the view offset
 *    preserved within the smoothing lag), plants never follow, Esc stops it.
 */

type Critterbox = {
  populations: { [species: string]: { count: number; avgEnergy: number } };
  selectAgent(id?: number | null): void;
  selected: number | null;
  hoveredAgent: number | null;
  following: number | null;
  agentPos(id: number): [number, number, number] | null;
  camera: { pos: [number, number, number]; yaw: number; pitch: number };
  setSpeed(x: number): void;
};

function cb(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox);
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

test('hovering an agent previews it in the inspector; leaving the canvas clears it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done — debug surface exists

  const panel = page.locator('#inspector-panel');
  await expect(panel).not.toBeVisible(); // nothing hovered or selected yet

  // The default view frames the world centre looking down at ~45°: scan a few screen points until an
  // agent is under the pointer (deterministic world → the first hit point is stable across runs).
  const w = page.viewportSize()!.width;
  const h = page.viewportSize()!.height;
  const candidates: [number, number][] = [
    [w / 2, h * 0.55],
    [w * 0.4, h * 0.6],
    [w * 0.6, h * 0.6],
    [w / 2, h * 0.7],
    [w * 0.35, h * 0.5],
    [w * 0.65, h * 0.5],
  ];
  let hovered: number | null = null;
  for (const [x, y] of candidates) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(80); // hover picks are throttled to ~20 Hz — give one a chance to land
    hovered = await page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.hoveredAgent);
    if (hovered !== null) break;
  }
  expect(hovered).not.toBe(null); // the world is dense — some candidate point always lands on an agent

  await expect(panel).toBeVisible();
  const text = (await panel.textContent()) ?? '';
  expect(text).toMatch(/species/);
  expect(text).toMatch(/energy/);

  // Moving onto a HUD panel leaves the canvas → the preview clears and the panel hides.
  await page.mouse.move(w - 100, 60); // over the world-gen panel (top-right)
  await page.waitForTimeout(80);
  expect(await cb(page).then((c) => c.hoveredAgent)).toBe(null);
  await expect(panel).not.toBeVisible();
});

test('selecting an animal follows it with a smoothed camera; plants never follow', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();

  // First animal id: plants are seeded BEFORE any animal, and mice come first among animals.
  const ids = await page.evaluate(() => {
    const c = (window as unknown as { __critterbox: Critterbox }).__critterbox;
    const plants = ['grass', 'clover', 'cranberry', 'reed', 'tree'].reduce(
      (s, sp) => s + (c.populations[sp]?.count ?? 0), 0,
    );
    return { plantId: 1, animalId: plants + 1 };
  });

  const c = await cb(page);
  expect(c.following).toBe(null); // nothing selected yet

  // Select the first mouse → follow starts immediately.
  await page.evaluate((id: number) => (window as unknown as { __critterbox: Critterbox }).__critterbox.selectAgent(id), ids.animalId);
  expect(await cb(page).then((x) => x.following)).toBe(ids.animalId);

  const before = await page.evaluate((id: number) => {
    const c = (window as unknown as { __critterbox: Critterbox }).__critterbox;
    return { cam: c.camera.pos, p: c.agentPos(id)! };
  }, ids.animalId);

  // Let the mouse wander at 4× until it has ACTUALLY moved (animals can idle between decisions — poll,
  // don't assume a fixed wait is enough), then freeze and let the smoothing converge: with the target
  // stationary the damped camera settles to exactly target + offset.
  await page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.setSpeed(4));
  let p = before.p;
  for (let i = 0; i < 16 && dist(p, before.p) < 1.5; i++) { // up to ~8 s of real time at 4×
    await page.waitForTimeout(500);
    p = (await page.evaluate((id: number) => (window as unknown as { __critterbox: Critterbox }).__critterbox.agentPos(id), ids.animalId))!;
  }
  expect(dist(p, before.p)).toBeGreaterThan(1.5); // premise: the animal really did move

  await page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.setSpeed(0));
  await page.waitForTimeout(2500); // λ = 3 → ~99% converged in well under this
  const afterCam = (await cb(page)).camera.pos;

  // The view offset (camera-to-animal distance) is preserved — the camera tracked, it didn't drift.
  expect(Math.abs(dist(afterCam, p) - dist(before.cam, before.p))).toBeLessThan(0.5);

  // Esc stops following (and deselects).
  await page.keyboard.press('Escape');
  expect(await cb(page).then((x) => x.following)).toBe(null);
  expect(await cb(page).then((x) => x.selected)).toBe(null);

  // Plants select fine but never start a follow.
  await page.evaluate((id: number) => (window as unknown as { __critterbox: Critterbox }).__critterbox.selectAgent(id), ids.plantId);
  expect(await cb(page).then((x) => x.selected)).toBe(ids.plantId);
  expect(await cb(page).then((x) => x.following)).toBe(null);
});
