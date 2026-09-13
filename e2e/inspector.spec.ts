import { expect, test } from '@playwright/test';

/**
 * Entity inspector e2e (Phase 8): selectAgent(id) via the debug surface opens the side panel showing that
 * agent's live parameters — species + energy for any agent, sex for animals; Esc deselects and hides the
 * panel. The first animal id is derivable without a new API: plants are seeded BEFORE any animal (seedLife
 * passes A/B/A2 then C), so (total plant count) + 1 = the first mouse on a fresh world. #scene visibility is
 * the boot gate (async restore-on-load appends it last).
 */

type Critterbox = {
  populations: { [species: string]: { count: number; avgEnergy: number } };
  agentCount: number;
  selectAgent(id?: number | null): void;
  selected: number | null;
};

function selectedId(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.selected);
}

test('inspector: selectAgent opens the panel with live params, Esc deselects', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists

  const ids = await page.evaluate(() => {
    const c = (window as unknown as { __critterbox: Critterbox }).__critterbox;
    const plants = ['grass', 'clover', 'cranberry', 'reed', 'tree', 'algae', 'pondweed', 'waterlily'].reduce(
      (s, sp) => s + (c.populations[sp]?.count ?? 0), 0,
    );
    return { plantId: 1, animalId: plants + 1, agentCount: c.agentCount };
  });
  expect(ids.animalId).toBeLessThan(ids.agentCount); // at least one animal seeded (mice first)

  const panel = page.locator('#inspector-panel');
  await expect(panel).not.toBeVisible(); // nothing selected yet

  // Select a plant (id 1 — the first seeded herb) → panel shows species + energy fields.
  await page.evaluate((id: number) => (window as unknown as { __critterbox: Critterbox }).__critterbox.selectAgent(id), ids.plantId);
  expect(await selectedId(page)).toBe(ids.plantId);
  await expect(panel).toBeVisible();
  let text = (await panel.textContent()) ?? '';
  expect(text).toMatch(/species/);
  expect(text).toMatch(/energy/);

  // Esc closes / deselects.
  await page.keyboard.press('Escape');
  expect(await selectedId(page)).toBe(null);
  await expect(panel).not.toBeVisible();

  // Select the first animal (a mouse) → panel shows species + sex + energy fields.
  await page.evaluate((id: number) => (window as unknown as { __critterbox: Critterbox }).__critterbox.selectAgent(id), ids.animalId);
  expect(await selectedId(page)).toBe(ids.animalId);
  await expect(panel).toBeVisible();
  text = (await panel.textContent()) ?? '';
  expect(text).toMatch(/mouse/);
  expect(text).toMatch(/sex/);
  expect(text).toMatch(/energy/);

  // selectAgent(null) deselects too.
  await page.evaluate(() => (window as unknown as { __critterbox: Critterbox }).__critterbox.selectAgent(null));
  expect(await selectedId(page)).toBe(null);
  await expect(panel).not.toBeVisible();
});
