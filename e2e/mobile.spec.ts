import { expect, test } from '@playwright/test';

/**
 * Mobile browser support e2e (v0.14): a 390×844 touch viewport verifies the four mobile camera paths —
 * tap-to-select an agent at its projected screen position, one-finger hold flying forward while drag steers
 * (release stops), one-finger drag steering alone, and two-finger pinch to dolly. Camera state is read via
 * window.__critterbox.camera; agents are located with the new
 * agentScreenPos projection (CSS px within the canvas). Touch gestures are dispatched as synthetic
 * TouchEvents on the #scene canvas so they exercise the exact FreeFlightCamera touch handlers a real
 * finger would hit. NOTE: every page.evaluate body must inline window.__critterbox — Node-side helpers
 * can't cross the evaluate boundary (Playwright serializes only self-contained functions). Kept < 15 s.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

interface CameraState { pos: [number, number, number]; yaw: number; pitch: number }

/** The slice of the debug surface this spec uses (mirrors window.__critterbox in main.ts). */
interface Surface {
  camera: CameraState;
  setPaused(p: boolean): void;
  selected: number | null;
  agentCount: number;
  populations: { [species: string]: { count: number; avgEnergy: number } };
  agentPos(id: number): [number, number, number] | null;
  agentScreenPos(id: number): [number, number] | null;
}

function cam(page: import('@playwright/test').Page): Promise<CameraState> {
  return page.evaluate(() => (window as unknown as { __critterbox: Surface }).__critterbox.camera);
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

test('mobile: tap an agent at its projected position selects it + opens the inspector', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible(); // boot done (restore-on-load) — debug surface exists

  // Freeze the sim so positions are stable across the read→tap sequence, then pick the agent CLOSEST TO THE
  // CAMERA within a central panel-free zone. The proximity line-pick returns the NEAREST agent along the tap
  // ray, so an arbitrary animal's pixel can be stolen by nearer overlapping grass/animals — but the closest
  // agent in the region has nothing nearer to steal its own pixel, making `selected === id` deterministic.
  const target = await page.evaluate(() => {
    const c = (window as unknown as { __critterbox: Surface }).__critterbox;
    c.setPaused(true);
    const w = window.innerWidth, h = window.innerHeight;
    const camPos = c.camera.pos;
    // Central band clear of all four HUD panels at this 390×844 viewport (world-panel top-right, population
    // bottom-left, title/env top-left) — a tap here always lands on the canvas.
    const inZone = (x: number, y: number) => x >= w * 0.45 && x <= w * 0.82 && y >= h * 0.4 && y <= h * 0.6;
    let best: { id: number; x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (let id = 1; id <= c.agentCount + 300; id++) {
      const p = c.agentScreenPos(id);
      if (!p || !inZone(p[0], p[1])) continue;
      const wp = c.agentPos(id); // null → dead/unknown, skip
      if (!wp) continue;
      const d = Math.hypot(wp[0] - camPos[0], wp[1] - camPos[1], wp[2] - camPos[2]);
      if (d < bestDist) { bestDist = d; best = { id, x: p[0], y: p[1] }; }
    }
    return best;
  });
  expect(target).not.toBeNull(); // at least one live agent projects into the central zone

  await page.touchscreen.tap((target as NonNullable<typeof target>).x, (target as NonNullable<typeof target>).y);

  const sel = await page.evaluate(() => (window as unknown as { __critterbox: Surface }).__critterbox.selected);
  expect(sel).toBe((target as NonNullable<typeof target>).id); // the tapped agent is selected
  await expect(page.locator('#inspector-panel')).toBeVisible(); // …and its inspector opened
});

test('mobile: one-finger drag steers the camera (yaw)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();
  const c0 = await cam(page);

  // A ~60 px rightward swipe at viewport centre, as synthetic TouchEvents on the canvas. Holding a finger
  // also flies forward (see next spec), but this whole gesture is dispatched synchronously — no frame runs
  // in between — so only the steering deltas land and position is untouched.
  await page.evaluate(() => {
    const canvas = document.getElementById('scene')!;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const mk = (x: number, y: number) => new Touch({ identifier: 1, target: canvas, clientX: x, clientY: y });
    const fire = (type: string, touches: Touch[]) => {
      canvas.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: touches }));
    };
    fire('touchstart', [mk(cx, cy)]);
    for (let i = 1; i <= 3; i++) fire('touchmove', [mk(cx + (60 * i) / 3, cy)]); // 3 × 20 px rightward
    fire('touchend', [mk(cx + 60, cy)]);
  });

  const c1 = await cam(page);
  expect(Math.abs(c1.yaw - c0.yaw)).toBeGreaterThan(0.05); // ~60 px × 0.003 rad/px ≈ 0.18 rad of yaw
});

test('mobile: holding one finger flies forward; dragging steers; lifting stops', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();
  const c0 = await cam(page);

  // touchstart at viewport centre, held with NO movement → the camera flies forward along its view
  // direction (MOVE_SPEED ≈ 30 m/s — ~600 ms of holding is far more than the 1 m asserted below).
  await page.evaluate(() => {
    const canvas = document.getElementById('scene')!;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const t = new Touch({ identifier: 9, target: canvas, clientX: cx, clientY: cy });
    canvas.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t] }));
  });
  await page.waitForTimeout(600);

  const c1 = await cam(page);
  // Displacement projected onto the initial view direction (yaw/pitch are unchanged while held still).
  const cp = Math.cos(c0.pitch), sp = Math.sin(c0.pitch);
  const dir: [number, number, number] = [-Math.sin(c0.yaw) * cp, sp, -Math.cos(c0.yaw) * cp];
  const along = (c1.pos[0] - c0.pos[0]) * dir[0] + (c1.pos[1] - c0.pos[1]) * dir[1] + (c1.pos[2] - c0.pos[2]) * dir[2];
  expect(along).toBeGreaterThan(1); // forward flight along the view direction

  // Drag while still held → steering lands on top of the ongoing flight.
  await page.evaluate(() => {
    const canvas = document.getElementById('scene')!;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const t = new Touch({ identifier: 9, target: canvas, clientX: cx + 40, clientY: cy });
    canvas.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t] }));
  });
  const c2 = await cam(page);
  expect(Math.abs(c2.yaw - c1.yaw)).toBeGreaterThan(0.05); // ~40 px × 0.003 rad/px ≈ 0.12 rad of yaw

  // Lift → no pointers remain → flight stops; nothing else drives the camera, so it is stationary.
  await page.evaluate(() => {
    const canvas = document.getElementById('scene')!;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const t = new Touch({ identifier: 9, target: canvas, clientX: cx + 40, clientY: cy });
    canvas.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t] }));
  });
  await page.waitForTimeout(400);
  const a = await cam(page);
  await page.waitForTimeout(400);
  const b = await cam(page);
  expect(dist(a.pos, b.pos)).toBeLessThan(0.1); // stationary after release (< 0.1 m drift)
});

test('mobile: two-finger pinch dollies the camera along the view direction', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene')).toBeVisible();
  const c0 = await cam(page);

  // Two fingers ±40 px around centre, spread to ±90 px (pinch out 100 px) → dolly forward ~3 m.
  await page.evaluate(() => {
    const canvas = document.getElementById('scene')!;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const mk = (id: number, x: number, y: number) => new Touch({ identifier: id, target: canvas, clientX: x, clientY: y });
    const fire = (type: string, touches: Touch[]) => {
      canvas.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: touches }));
    };
    fire('touchstart', [mk(1, cx - 40, cy)]);
    fire('touchstart', [mk(2, cx + 40, cy)]); // pair forms → pinch baseline (80 px) set here
    fire('touchmove', [mk(1, cx - 90, cy), mk(2, cx + 90, cy)]); // spread to 180 px → +3 m dolly
    fire('touchend', [mk(1, cx - 90, cy)]);
    fire('touchend', [mk(2, cx + 90, cy)]);
  });

  const c1 = await cam(page);
  expect(dist(c0.pos, c1.pos)).toBeGreaterThan(1); // ~100 px × 0.03 m/px ≈ 3 m of travel
});
