import { expect, test } from '@playwright/test';

/**
 * Species-hover highlight e2e (v0.10): hoverSpecies(id) via the debug surface lights up one ring per
 * live agent of that species — hoverInstanceCount must equal the current population; hoverSpecies(null)
 * clears immediately. Driven without real mouse events so it stays deterministic and fast (< 10 s). The
 * sim is frozen first (setSpeed(0)) so the population can't change between reading the count and the
 * ring layer catching up a frame later. #scene visibility is the boot gate (async restore-on-load).
 */

type Critterbox = {
  populations: { [species: string]: { count: number; avgEnergy: number } };
  setSpeed(x: number): void;
  selectAgent(id?: number | null): void;
  selected: number | null;
  hoverSpecies(id?: string | null): void;
  hoveredSpecies: string | null;
  hoverInstanceCount: number;
};

test('hover highlight: one ring per agent of the hovered species, null clears', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists

  // Freeze the sim so the population can't move under the assertions.
  await page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.setSpeed(0));
  const mouseCount = await page.evaluate(
    () => (window as unknown as { __critterbox: Critterbox }).__critterbox.populations.mouse?.count ?? 0,
  );
  expect(mouseCount).toBeGreaterThan(0); // mice are seeded on every fresh world

  // Hover the mouse row → the ring layer catches up within a frame (poll — one rAF at most in practice).
  await page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.hoverSpecies('mouse'));
  expect(await page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.hoveredSpecies)).toBe('mouse');
  await expect.poll(
    () => page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.hoverInstanceCount),
  ).toBe(mouseCount);

  // Coexists with an active inspector selection — neither clears the other.
  await page.evaluate((id: number) => (window as unknown as { __critterbox: Critterbox }).__critterbox.selectAgent(id), 1);
  expect(await page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.selected)).toBe(1);
  await expect.poll(
    () => page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.hoverInstanceCount),
  ).toBe(mouseCount); // still lit while an agent is selected

  // Clear → zero instances immediately (setSpecies(null) zeroes the count synchronously, no frame needed).
  await page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.hoverSpecies(null));
  const cleared = await page.evaluate(() => {
    const c = (window as unknown as { __critterbox: Critterbox }).__critterbox;
    return { hovered: c.hoveredSpecies, count: c.hoverInstanceCount };
  });
  expect(cleared.hovered).toBe(null);
  expect(cleared.count).toBe(0);
});
