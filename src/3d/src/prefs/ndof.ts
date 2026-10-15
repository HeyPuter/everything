// 3D mice and game controllers (Gamepad API) navigate the 3D Viewport under the pointer.
// A 3D mouse reports six axes (pan X/Y/Z, rotate X/Y/Z); a standard game controller uses
// its sticks (left: pan, right: orbit) and triggers (zoom). Preferences ▸ Input ▸ NDOF.
import { prefs } from '../app/prefs';
import { activeView3D } from '../editors/view3d/view3d';
import { onPrefsApply } from './store';

const SIX_AXIS = /3dconnexion|space ?mouse|space ?navigator|space ?pilot|space ?explorer|cadmouse|256f|046d.?c6/i;

let raf = 0;
let last = 0;

export interface NdofDevice {
  id: string;
  kind: '3D Mouse' | 'Game Controller';
}

/** Connected navigation devices. */
export function ndofDevices(): NdofDevice[] {
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? [...navigator.getGamepads()] : [];
  const out: NdofDevice[] = [];
  for (const g of pads) {
    if (!g || !g.connected) continue;
    if (SIX_AXIS.test(g.id) || (g.axes.length >= 6 && g.mapping !== 'standard')) out.push({ id: g.id, kind: '3D Mouse' });
    else if (g.mapping === 'standard') out.push({ id: g.id, kind: 'Game Controller' });
  }
  return out;
}

const dead = (v: number) => {
  const d = Math.max(0, Math.min(0.95, prefs.ndof_deadzone));
  const a = Math.abs(v);
  return a <= d ? 0 : (Math.sign(v) * (a - d)) / (1 - d);
};

/** Motion of one frame: translation (x right, y up, z towards the viewer) and rotation, both -1..1 per axis. */
export interface NdofMotion {
  t: [number, number, number];
  r: [number, number, number];
}

function readMotion(): NdofMotion | null {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
  const m: NdofMotion = { t: [0, 0, 0], r: [0, 0, 0] };
  let any = false;
  for (const g of pads) {
    if (!g || !g.connected) continue;
    if (SIX_AXIS.test(g.id) || (g.axes.length >= 6 && g.mapping !== 'standard')) {
      // device axes: x, y (towards the user), z (down), rx, ry, rz
      m.t[0] += dead(g.axes[0] ?? 0);
      m.t[1] += -dead(g.axes[2] ?? 0);
      m.t[2] += dead(g.axes[1] ?? 0);
      m.r[0] += dead(g.axes[3] ?? 0);
      m.r[1] += -dead(g.axes[5] ?? 0);
      m.r[2] += dead(g.axes[4] ?? 0);
      any = true;
    } else if (g.mapping === 'standard') {
      m.t[0] += dead(g.axes[0] ?? 0);
      m.t[1] += -dead(g.axes[1] ?? 0);
      m.r[1] += -dead(g.axes[2] ?? 0);
      m.r[0] += -dead(g.axes[3] ?? 0);
      // triggers zoom in / out
      m.t[2] += (g.buttons[7]?.value ?? 0) - (g.buttons[6]?.value ?? 0);
      any = true;
    }
  }
  if (!any) return null;
  const inv = (on: boolean) => (on ? -1 : 1);
  m.t[0] *= inv(prefs.ndof_panx_invert_axis);
  m.t[1] *= inv(prefs.ndof_pany_invert_axis);
  m.t[2] *= inv(prefs.ndof_panz_invert_axis);
  m.r[0] *= inv(prefs.ndof_rotx_invert_axis);
  m.r[1] *= inv(prefs.ndof_roty_invert_axis);
  m.r[2] *= inv(prefs.ndof_rotz_invert_axis);
  if (prefs.ndof_zoom_direction === 'UP') [m.t[1], m.t[2]] = [m.t[2], m.t[1]];
  return m;
}

/** Apply one frame of device motion to the view under the pointer (dt in seconds). */
export function applyNdof(m: NdofMotion, dt: number) {
  const v = activeView3D();
  if (!v || v.lockRotation) return;
  const moving = m.t.some((x) => x !== 0) || m.r.some((x) => x !== 0);
  if (!moving) return;
  const nav = v.nav;
  const pan = prefs.ndof_translation_sensitivity * dt;
  const rot = prefs.ndof_rotation_sensitivity * dt * 0.6;
  if (v.cameraView && !v.lockCameraToView) v.leaveCamera();
  if (prefs.ndof_navigation_mode === 'FLY') {
    // the viewer moves through the scene: translation moves the eye, rotation turns the head
    const eye = nav.eye.clone();
    const speed = Math.max(0.5, nav.distance) * pan;
    eye.addScaledVector(nav.right, m.t[0] * speed).addScaledVector(nav.up, m.t[1] * speed).addScaledVector(nav.forward, -m.t[2] * speed);
    nav.orbit(-m.r[1] * rot, -m.r[0] * rot);
    nav.pivot.copy(eye).addScaledVector(nav.forward, nav.distance);
  } else {
    // the object turns in the hand: rotation orbits, translation pans and zooms
    nav.orbit(m.r[1] * rot, m.r[0] * rot);
    if (!prefs.ndof_lock_horizon && m.r[2]) nav.roll(m.r[2] * rot);
    nav.pan(-m.t[0] * pan * 120, m.t[1] * pan * 120);
    if (m.t[2]) nav.zoom(Math.exp(m.t[2] * pan * 0.8));
  }
  nav.leaveAxisView();
  v.afterNav();
}

/** Read the devices once and apply their motion (returns false when none is connected). */
export function pollNdof(dt: number): boolean {
  const m = readMotion();
  if (!m) return false;
  applyNdof(m, dt);
  return true;
}

function tick(now: number) {
  raf = 0;
  if (!prefs.ndof_enabled) return;
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
  last = now;
  const m = readMotion();
  if (!m) {
    last = 0;
    return;
  }
  applyNdof(m, dt);
  raf = requestAnimationFrame(tick);
}

/** Poll devices while any is connected. */
export function startNdof() {
  if (raf || !prefs.ndof_enabled || !ndofDevices().length) return;
  last = 0;
  raf = requestAnimationFrame(tick);
}

if (typeof window !== 'undefined') {
  addEventListener('gamepadconnected', () => startNdof());
  // some devices only report after an input event: look again now and then
  let lastCheck = 0;
  addEventListener(
    'pointermove',
    () => {
      const t = performance.now();
      if (raf || t - lastCheck < 1000) return;
      lastCheck = t;
      startNdof();
    },
    { passive: true },
  );
}

onPrefsApply((p) => p.ndof_enabled && startNdof());
