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

    const shift = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const step = MOVE_SPEED * (shift ? SHIFT_MULT : 1) * dt;
    const cp = Math.cos(this.rot.pitch), sp = Math.sin(this.rot.pitch);
    const sy = Math.sin(this.rot.yaw), cy = Math.cos(this.rot.yaw);
    let mx = 0, my = 0, mz = 0;
    if (this.keys.has('KeyW')) { mx += -sy * cp; my += sp; mz += -cy * cp; } // forward (incl. pitch)
    if (this.keys.has('KeyS')) { mx += sy * cp; my -= sp; mz += cy * cp; }
    if (this.keys.has('KeyD')) { mx += cy; mz += -sy; } // strafe right, yaw-relative
    if (this.keys.has('KeyA')) { mx -= cy; mz += sy; }
    this.pos3.x += mx * step;
    this.pos3.y += my * step;
    this.pos3.z += mz * step;

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
    this.apply();
  };

  /** Push pos/yaw/pitch into the three.js camera (YXZ euler: yaw around Y, then pitch). */
  private apply(): void {
    this.camera.position.copy(this.pos3);
    this.camera.rotation.set(this.rot.pitch, this.rot.yaw, 0, 'YXZ');
  }
}
