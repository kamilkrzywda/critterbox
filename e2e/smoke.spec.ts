import { expect, test } from '@playwright/test';

/**
 * Scaffold smoke test (v0.1.0): page loads, the placeholder scene renders into the
 * canvas, and the title overlay is present. Extended as real features land.
 */

test('scaffold scene loads with title overlay', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();
  await expect(page.locator('#title')).toHaveText('Critterbox');
});
