/**
 * Free-flight camera controller (Phase 2): position + yaw/pitch state driven by WASD movement,
 * mouse-drag look (button held — NO pointer lock, touchpad-friendly), arrow-key rotation as a
 * mouse replacement for laptop/touchpad users, Shift ×4 speed boost, and wheel dolly.
 *
 * Conventions: yaw 0 looks down -Z; positive pitch looks UP; view direction is
 * (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch)). All key handling ignores events while
 * an input/textarea/select/contentEditable has focus (the world-gen seed input!), and arrows/space
 * never scroll the page.
 */

import * as THREE from 'three';

/** Base movement speed in m/s at 1× (Shift multiplies by SHIFT_MULT). */
const MOVE_SPEED = 30;
/** Speed multiplier while Shift is held (movement + wheel dolly). */
const SHIFT_MULT = 4;
/** Mouse-drag look sensitivity in radians per pixel. */
const LOOK_SENSITIVITY = 0.003;
/** Arrow-key hold-to-rotate speed in rad/s — ≈ a steady mouse drag at LOOK_SENSITIVITY. */
const ARROW_ROT_SPEED = 1.5;
/** Wheel dolly: meters of travel per 100 units of deltaY (one standard notch ≈ ±100 → ~3 m). */
const DOLLY_METERS_PER_100_DELTA = 3;
/** Pitch clamp in radians (±89°) — never flip over the poles. */
const PITCH_LIMIT = (89 * Math.PI) / 180;
/** Pinch dolly: meters per pixel of pinch-distance change — same ratio as the wheel (3 m / 100 px). */
const PINCH_DOLLY_METERS_PER_PX = DOLLY_METERS_PER_100_DELTA / 100;

function clampPitch(p: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
}

/** True when `el` is a text-entry target — camera keys must stay inert while typing in it. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

const ROTATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

export class FreeFlightCamera {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLElement;
  private readonly pos3 = new THREE.Vector3();
  private readonly rot = { yaw: 0, pitch: 0 };
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  // --- touch (v0.14): active pointers by identifier + pinch-dolly baseline ------------------------
  private touches = new Map<number, { x: number; y: number }>();
  private pinchDist = 0; // baseline distance between the two fingers (px)
  /** True while any finger is down — one-finger contact flies forward on the W-key basis; clears only when all lift. */
  private touchForward = false;

  /** Fired whenever the USER drives the camera (not programmatic setPos): 'move' for WASD/wheel
   *  position changes, 'look' for drag/arrow rotation. The follow-camera uses this to step aside when
   *  the user takes over position control while keeping look free (orbit around a followed animal). */
  onUserInput?: (kind: 'move' | 'look') => void;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLElement) {
    this.camera = camera;
    this.canvas = canvas;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur); // no stuck keys after alt-tab
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // Touch (v0.14): one finger flies forward + steers by drag, two fingers pinch-dolly. preventDefault on
    // start/move stops page scroll/zoom and the compatibility mouse events so the untouched mouse path can't
    // double-drive; pointer events (tap-select) are a separate stream and keep firing for selection.
    canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    canvas.addEventListener('touchend', this.onTouchEnd);
    canvas.addEventListener('touchcancel', this.onTouchCancel);
  }

  /** Remove all event listeners (page teardown). */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('touchstart', this.onTouchStart);
    this.canvas.removeEventListener('touchmove', this.onTouchMove);
    this.canvas.removeEventListener('touchend', this.onTouchEnd);
    this.canvas.removeEventListener('touchcancel', this.onTouchCancel);
  }

  // --- state access (e2e reads these via the debug surface) ---------------------------------

  get pos(): [number, number, number] {
    return [this.pos3.x, this.pos3.y, this.pos3.z];
  }

  setPos(x: number, y: number, z: number): void {
    this.pos3.set(x, y, z);
    this.apply();
  }

  get yaw(): number {
    return this.rot.yaw;
  }

  set yaw(v: number) {
    this.rot.yaw = v;
    this.apply();
  }

  get pitch(): number {
    return this.rot.pitch;
  }

  set pitch(v: number) {
    this.rot.pitch = clampPitch(v);
    this.apply();
  }

  // --- per-frame update (called from the main loop, even while paused) -----------------------

  update(dt: number): void {
    if (isTypingTarget(document.activeElement)) return; // keys are inert while typing in inputs

    let dyaw = 0;
    let dpitch = 0;
    if (this.keys.has('ArrowLeft')) dyaw += ARROW_ROT_SPEED * dt;
    if (this.keys.has('ArrowRight')) dyaw -= ARROW_ROT_SPEED * dt;
    if (this.keys.has('ArrowUp')) dpitch += ARROW_ROT_SPEED * dt;
    if (this.keys.has('ArrowDown')) dpitch -= ARROW_ROT_SPEED * dt;
    this.rot.yaw += dyaw;
    this.rot.pitch = clampPitch(this.rot.pitch + dpitch);
    if ((dyaw !== 0 || dpitch !== 0) && this.onUserInput) this.onUserInput('look');

    const shift = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const step = MOVE_SPEED * (shift ? SHIFT_MULT : 1) * dt;
    const cp = Math.cos(this.rot.pitch), sp = Math.sin(this.rot.pitch);
    const sy = Math.sin(this.rot.yaw), cy = Math.cos(this.rot.yaw);
    let mx = 0, my = 0, mz = 0;
    if (this.keys.has('KeyW') || this.touchForward) { mx += -sy * cp; my += sp; mz += -cy * cp; } // forward (incl. pitch); touch contact flies like W
    if (this.keys.has('KeyS')) { mx += sy * cp; my -= sp; mz += cy * cp; }
    if (this.keys.has('KeyD')) { mx += cy; mz += -sy; } // strafe right, yaw-relative
    if (this.keys.has('KeyA')) { mx -= cy; mz += sy; }
    this.pos3.x += mx * step;
    this.pos3.y += my * step;
    this.pos3.z += mz * step;
    if ((mx !== 0 || my !== 0 || mz !== 0) && this.onUserInput) this.onUserInput('move');

    this.apply();
  }

  // --- event handlers ------------------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingTarget(document.activeElement)) return;
    if (ROTATION_KEYS.has(e.code) || e.code === 'Space') e.preventDefault(); // no page scroll
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.dragging = false;
    this.touchForward = false; // no stuck flight after alt-tab (touchcancel normally covers it)
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return; // left button only — no pointer lock, just drag
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.rot.yaw -= dx * LOOK_SENSITIVITY; // drag right → look right
    this.rot.pitch = clampPitch(this.rot.pitch - dy * LOOK_SENSITIVITY); // drag down → look down
    if ((dx !== 0 || dy !== 0) && this.onUserInput) this.onUserInput('look');
    this.apply();
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.dragging = false;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault(); // the page must never scroll/zoom under the canvas
    let delta = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 32;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= window.innerHeight;
    const shift = e.shiftKey || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    // wheel up (deltaY < 0) → dolly forward along the view direction
    const dist = (-delta * DOLLY_METERS_PER_100_DELTA / 100) * (shift ? SHIFT_MULT : 1);
    const cp = Math.cos(this.rot.pitch), sp = Math.sin(this.rot.pitch);
    this.pos3.x += -Math.sin(this.rot.yaw) * cp * dist;
    this.pos3.y += sp * dist;
    this.pos3.z += -Math.cos(this.rot.yaw) * cp * dist;
    if (dist !== 0 && this.onUserInput) this.onUserInput('move'); // dolly changes the view distance — follow steps aside
    this.apply();
  };

  // --- touch handlers (v0.14 mobile) -------------------------------------------------------------
  // ONE finger → fly forward continuously on the W-key basis (MOVE_SPEED, incl. pitch — applied in update()
  // while `touchForward` is set) WHILE steering by drag: pointer deltas rotate yaw/pitch with the same
  // LOOK_SENSITIVITY + pitch clamp as the mouse drag. TWO fingers → pinch to dolly along the view direction
  // only (no pan). Lifting one of two leaves the remaining finger in `touches`, so forward+steer resumes
  // automatically. The mouse path above is untouched; touch and mouse never share state (`touches` map vs
  // `dragging`).

  private onTouchStart = (e: TouchEvent): void => {
    e.preventDefault(); // kill scroll/zoom + compat mouse events; pointer events still fire for tap-select
    for (const t of Array.from(e.changedTouches)) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    if (this.touches.size === 2) this.resetPinchBaseline(); // second finger landed — re-baseline so no jump
    this.touchForward = true; // any contact flies forward until every pointer lifts
  };

  private onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    const changed = Array.from(e.changedTouches);
    if (this.touches.size === 1 && changed.length === 1) {
      // Single finger → steer (forward flight runs in update() while the finger is down), delta from this
      // pointer's last stored position.
      const t = changed[0];
      const prev = this.touches.get(t.identifier);
      this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      if (!prev) return; // move before start — just record the position
      const dx = t.clientX - prev.x;
      const dy = t.clientY - prev.y;
      if (dx !== 0 || dy !== 0) {
        this.rot.yaw -= dx * LOOK_SENSITIVITY; // drag right → look right (same as mouse)
        this.rot.pitch = clampPitch(this.rot.pitch - dy * LOOK_SENSITIVITY); // drag down → look down
        if (this.onUserInput) this.onUserInput('look');
        this.apply();
      }
      return;
    }
    // Two or more fingers: record all, then pinch-dolly from the pair (no pan).
    for (const t of changed) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    if (this.touches.size < 2) return;
    const [a, b] = [...this.touches.values()]; // exactly two in practice — first two otherwise
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const dDolly = (dist - this.pinchDist) * PINCH_DOLLY_METERS_PER_PX; // pinch out (>0) → forward
    this.pinchDist = dist;
    if (dDolly !== 0) {
      const cp = Math.cos(this.rot.pitch), sp = Math.sin(this.rot.pitch);
      // forward (incl. pitch) — the same basis as WASD in update()
      this.pos3.x += -Math.sin(this.rot.yaw) * cp * dDolly;
      this.pos3.y += sp * dDolly;
      this.pos3.z += -Math.cos(this.rot.yaw) * cp * dDolly;
      if (this.onUserInput) this.onUserInput('move'); // pinch changes position — follow steps aside
      this.apply();
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) this.touches.delete(t.identifier);
    if (this.touches.size === 0) this.touchForward = false; // flag clears only when NO pointers remain
  };

  private onTouchCancel = (): void => {
    // A system gesture aborts the whole touch sequence — drop every tracked pointer, not just changed ones.
    this.touches.clear();
    this.touchForward = false;
  };

  /** Re-baseline pinch distance from the two current pointers (called when a pair forms). */
  private resetPinchBaseline(): void {
    const [a, b] = [...this.touches.values()];
    this.pinchDist = Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** Push pos/yaw/pitch into the three.js camera (YXZ euler: yaw around Y, then pitch). */
  private apply(): void {
    this.camera.position.copy(this.pos3);
    this.camera.rotation.set(this.rot.pitch, this.rot.yaw, 0, 'YXZ');
  }
}
