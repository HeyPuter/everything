// Extra 3D View navigation: zoom region, camera frame zoom, view locking, fly & walk navigation.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { prefs } from '../app/prefs';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { keymaps } from '../app/keymap';
import { renderContext } from '../render/context';
import { dragRegion } from './viewregions';
import { raycastScene } from '../editors/view3d/navextra';
import { openPopover } from '../ui/menu';
import { snappingPopover } from '../editors/view3d/header';

const v3d = () => !!activeView3D();

function redraw(v: View3D) {
  renderContext?.engine.requestDraw();
  v.drawSvg();
  v.drawUI();
  app.changed('view');
}

/** Zoom so that the given viewport rectangle fills the view. */
function zoomToRect(v: View3D, x0: number, y0: number, x1: number, y1: number, out = false) {
  const w = Math.abs(x1 - x0),
    hgt = Math.abs(y1 - y0);
  if (w < 4 || hgt < 4) return;
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  // zooming out shows the whole current view inside the rectangle
  const fit = out ? 1 / Math.max(w / v.width, hgt / v.height) : Math.max(w / v.width, hgt / v.height);
  if (v.cameraView && !v.lockCameraToView) {
    // move the rectangle centre to the view centre, then enlarge the frame
    v.panCameraFrame(v.width / 2 - cx, v.height / 2 - cy);
    v.zoomCameraFrame(1 / fit);
  } else {
    v.leaveCamera();
    v.nav.update();
    const center = v.unproject(cx, cy, v.nav.pivot.clone());
    v.nav.pivot.copy(center);
    v.nav.zoom(fit);
    v.afterNav();
  }
  redraw(v);
}

registerOperators([
  {
    idname: 'view3d.zoom_border',
    label: 'Zoom to Border',
    description: 'Zoom in the view to the nearest object contained in the border',
    poll: v3d,
    invoke: () => {
      const v = activeView3D()!;
      dragRegion(v, 'Zoom to Border', (x0, y0, x1, y1, info) => zoomToRect(v, x0, y0, x1, y1, info.button === 1), { middle: true, hint: 'drag to zoom in, MMB drag to zoom out' });
      return 'RUNNING_MODAL';
    },
    undo: false,
  },
  {
    idname: 'view3d.zoom_camera_1_to_1',
    label: 'Zoom Camera 1:1',
    description: 'Match the camera to 1:1 to the render output',
    poll: () => !!activeView3D()?.cameraView,
    exec: (ctx) => {
      const v = activeView3D()!;
      const r = ctx.doc.scene.render;
      v.camZoom = 1;
      v.camOffset = { x: 0, y: 0 };
      v.updateSceneCamera();
      const frame = v.cameraFrame();
      if (!frame) return 'CANCELLED';
      const target = (r.resolution_x * r.resolution_percentage) / 100;
      v.zoomCameraFrame(target / frame.w);
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_center_camera',
    label: 'Frame Camera Bounds',
    description: 'Center the camera view, resizing the view to fit its bounds',
    poll: () => !!activeView3D()?.cameraView,
    exec: () => {
      const v = activeView3D()!;
      v.resetCameraFrame();
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_center_cursor',
    label: 'Center View to Cursor',
    description: 'Center the view so that the cursor is in the middle of the view',
    poll: v3d,
    exec: (ctx) => {
      const v = activeView3D()!;
      v.leaveCamera();
      v.nav.pivot.set(...(ctx.doc.scene.cursor.location as [number, number, number]));
      v.afterNav();
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_lock_to_active',
    label: 'View Lock to Active',
    description: 'Lock the view to the active object',
    poll: () => v3d() && !!app.activeObject,
    exec: () => {
      const v = activeView3D()!;
      v.lockObject = app.activeObject!.id;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_lock_clear',
    label: 'View Lock Clear',
    description: 'Clear all view locking',
    poll: () => !!activeView3D()?.lockObject || !!activeView3D()?.lockCursor,
    exec: () => {
      const v = activeView3D()!;
      v.lockObject = null;
      v.lockCursor = false;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.dolly',
    label: 'Dolly View',
    description: 'Move the view forward or backward without changing the pivot distance (drag when no step is given)',
    props: [{ id: 'delta', label: 'Delta', type: 'int', default: 0 }],
    poll: v3d,
    invoke: (ctx, p) => {
      if (p.delta) return dollyStep(p.delta as number);
      const v = activeView3D()!;
      v.leaveCamera();
      const startPivot = v.nav.pivot.clone();
      const y0 = ctx.event?.y ?? app.pointer.y;
      app.startModal({
        label: 'Dolly View',
        header: () => 'Dolly: move the mouse up or down · LMB/Enter confirm · RMB/Esc cancel',
        onPointerMove(e) {
          const step = v.nav.distance * 0.005;
          v.nav.pivot.copy(startPivot).addScaledVector(v.nav.forward, (y0 - e.clientY) * step);
          v.afterNav();
        },
        onPointerDown(e) {
          return e.button === 0 ? 'FINISHED' : 'CANCELLED';
        },
        onKey(e) {
          if (e.type !== 'keydown') return true;
          if (e.key === 'Escape') return 'CANCELLED';
          if (e.key === 'Enter') return 'FINISHED';
          return true;
        },
        cancel() {
          v.nav.pivot.copy(startPivot);
          v.afterNav();
        },
      });
      return 'RUNNING_MODAL';
    },
    exec: (_ctx, p) => dollyStep((p.delta as number) || 1),
    undo: false,
  },
  {
    idname: 'view3d.walk',
    label: 'Walk Navigation',
    description: 'Interactively walk around the scene (WASD, Q/E down/up, mouse to look)',
    poll: v3d,
    invoke: () => startFlight('WALK'),
    undo: false,
  },
  {
    idname: 'view3d.fly',
    label: 'Fly Navigation',
    description: 'Interactively fly around the scene (mouse steers, wheel sets speed, WASD to move)',
    poll: v3d,
    invoke: () => startFlight('FLY'),
    undo: false,
  },
]);

function dollyStep(delta: number) {
  const v = activeView3D()!;
  v.leaveCamera();
  v.nav.pivot.add(v.nav.forward.multiplyScalar(delta * v.nav.distance * 0.2));
  v.afterNav();
  return 'FINISHED' as const;
}

/**
 * Walk / Fly navigation. Both move the eye (the view pivot follows at the same distance); in
 * camera view the scene camera is moved.
 *
 * Walk: WASD / arrows move while held, Q/E go down/up, R/F along the view's up axis, the mouse
 * looks around, Shift runs, Alt walks slowly, Tab or G toggles gravity (with V to jump and
 * . / , to change the jump height), Space or MMB teleports to the surface under the crosshair.
 *
 * Fly: the view steers towards the mouse; W/S and the wheel accelerate forwards/backwards,
 * A/D strafe, E/R rise, Q/F sink, MMB drag pans, Ctrl looks around freely, Z keeps the horizon
 * level, X stops the view from pitching, Shift/Alt slow everything down.
 */
function startFlight(kind: 'WALK' | 'FLY') {
  const v = activeView3D()!;
  const nav = v.nav;
  const camId = v.cameraView ? v.activeCameraId() : null;
  const camOb = camId ? app.doc.objects[camId] : null;
  const camBefore = camOb ? { location: [...camOb.location], rotation_euler: [...camOb.rotation_euler], rotation_quaternion: [...camOb.rotation_quaternion], rotation_axis_angle: [...camOb.rotation_axis_angle] } : null;
  const lockBefore = v.lockCameraToView;
  if (camOb) {
    const ev = app.graph.get(camOb.id);
    if (ev) {
      const dist = nav.distance;
      nav.alignToMatrix(ev.world);
      nav.distance = dist;
    }
    v.lockCameraToView = true;
  } else v.leaveCamera();
  nav.leaveAxisView();
  const orthoBefore = nav.ortho;
  if (nav.ortho) nav.ortho = false;
  const before = { pivot: nav.pivot.clone(), rot: nav.rot.clone(), distance: nav.distance };
  const keys = new Set<string>();
  // base speed scales with the scene/view size
  // walking starts at the speed set in Preferences ▸ Navigation ▸ Walk
  let speed = kind === 'WALK' ? Math.max(0.01, prefs.walk_speed) : 0;
  const flyStep = Math.max(0.05, nav.distance * 0.02);
  const r = v.el.getBoundingClientRect();
  let mouse = { x: r.width / 2, y: r.height / 2 };
  let locked = false;
  // walk: gravity, jumping, teleport
  let gravity = prefs.walk_use_gravity;
  let vz = 0;
  let jumpHeight = Math.max(0.01, prefs.walk_jump_height);
  const viewHeight = Math.max(0.01, prefs.walk_view_height);
  const mouseSpeed = 0.0035 * Math.max(0.01, prefs.walk_mouse_speed);
  const mouseY = prefs.walk_use_mouse_reverse ? -1 : 1;
  let teleport: { from: Vector3; to: Vector3; t0: number } | null = null;
  // fly: pan with MMB, free look with Ctrl, axis locks
  let panning = false;
  let lockZ = true;
  let lockX = false;
  if (kind === 'WALK') {
    try {
      const p = v.el.requestPointerLock?.() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
      locked = true;
    } catch {
      locked = false;
    }
  }
  const eyeOf = () => nav.eye;
  const setEye = (eye: Vector3) => nav.pivot.copy(eye).addScaledVector(nav.forward, nav.distance);
  const look = (dx: number, dy: number) => {
    const eye = eyeOf();
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -dx);
    const pitch = new Quaternion().setFromAxisAngle(nav.right, kind === 'FLY' && lockX ? 0 : -dy);
    const next = nav.rot.clone().premultiply(pitch).premultiply(yaw).normalize();
    // keep the view from flipping over the vertical
    const up = new Vector3(0, 1, 0).applyQuaternion(next);
    if (up.z > 0.02 || (kind === 'FLY' && !lockZ)) nav.rot.copy(next);
    else nav.rot.premultiply(yaw).normalize();
    setEye(eye);
  };
  /** Fly with the Z lock: remove roll so the horizon stays level. */
  const levelHorizon = () => {
    const f = nav.forward;
    if (Math.abs(f.z) > 0.999) return;
    const eye = eyeOf();
    const right = new Vector3().crossVectors(f, new Vector3(0, 0, 1)).normalize();
    const up = new Vector3().crossVectors(right, f).normalize();
    const m = new Matrix4().makeBasis(right, up, f.clone().negate());
    nav.rot.setFromRotationMatrix(m);
    setEye(eye);
  };
  const ground = (eye: Vector3) => raycastScene(eye.clone(), new Vector3(0, 0, -1), 1e4);
  let last = performance.now();
  let raf = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const mult = keys.has('SHIFT') ? (kind === 'WALK' ? Math.max(1, prefs.walk_speed_factor) : 0.2) : keys.has('ALT') ? 1 / Math.max(1, prefs.walk_speed_factor) : 1;
    const eye = eyeOf();
    if (teleport) {
      const tt = Math.max(0, prefs.walk_teleport_time) * 1000;
      const t = tt > 0 ? Math.min(1, (now - teleport.t0) / tt) : 1;
      const e = t * t * (3 - 2 * t);
      setEye(teleport.from.clone().lerp(teleport.to, e));
      if (t >= 1) teleport = null;
      v.afterNav();
      raf = requestAnimationFrame(tick);
      return;
    }
    const fwd = nav.forward;
    if (kind === 'WALK') fwd.z = 0;
    fwd.normalize();
    const right = nav.right;
    const move = new Vector3();
    const has = (...k: string[]) => k.some((x) => keys.has(x));
    if (kind === 'WALK') {
      if (has('W', 'ARROWUP')) move.add(fwd);
      if (has('S', 'ARROWDOWN')) move.sub(fwd);
      if (!gravity) {
        if (has('E')) move.z += 1;
        if (has('Q')) move.z -= 1;
        if (has('R')) move.add(nav.up);
        if (has('F')) move.sub(nav.up);
      }
    } else {
      if (has('E', 'R')) move.z += 1;
      if (has('Q', 'F')) move.z -= 1;
    }
    if (has('D', 'ARROWRIGHT')) move.add(right);
    if (has('A', 'ARROWLEFT')) move.sub(right);
    const base = kind === 'WALK' ? speed : Math.max(flyStep * 10, Math.abs(speed));
    if (move.lengthSq()) eye.addScaledVector(move.normalize(), base * mult * dt);
    if (kind === 'WALK' && gravity) {
      // fall onto the surface below, keeping the eye at the view height
      vz -= 9.81 * dt;
      eye.z += vz * dt;
      const g = ground(eye.clone().add(new Vector3(0, 0, viewHeight * 0.5 - vz * dt)));
      const floor = g ? g.point.z + viewHeight : -Infinity;
      if (eye.z <= floor) {
        eye.z = floor;
        vz = 0;
      }
      setEye(eye);
    } else if (kind === 'FLY') {
      setEye(eye);
      if (!keys.has('CONTROL') && !panning) {
        // steer towards the mouse (dead zone in the middle)
        const nx = (mouse.x - r.width / 2) / (r.width / 2),
          ny = (mouse.y - r.height / 2) / (r.height / 2);
        const dz = (t: number) => (Math.abs(t) < 0.1 ? 0 : t - Math.sign(t) * 0.1);
        look(dz(nx) * dt * 1.5 * mult, dz(ny) * dt * 1.5 * mult);
      }
      if (lockZ) levelHorizon();
      setEye(eyeOf().addScaledVector(nav.forward, speed * mult * dt));
    } else setEye(eye);
    v.afterNav();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const stop = () => {
    cancelAnimationFrame(raf);
    if (locked && document.pointerLockElement) document.exitPointerLock?.();
    v.lockCameraToView = lockBefore;
  };
  const doTeleport = () => {
    const eye = eyeOf();
    const hit = raycastScene(eye, nav.forward, 1e4);
    if (!hit) return;
    // stop a little before the surface (at the view height above it with gravity)
    const to = hit.point.clone().addScaledVector(nav.forward, -Math.min(hit.distance * 0.5, Math.max(0.5, speed * 0.25)));
    if (gravity) to.z = Math.max(to.z, hit.point.z + viewHeight);
    teleport = { from: eye.clone(), to, t0: performance.now() };
  };
  const header = () =>
    kind === 'WALK'
      ? `Walk: speed ${speed.toFixed(2)}${gravity ? ' · gravity on' : ''} · WASD move · Q/E down/up · Tab gravity · V jump · Space teleport · Shift fast · Alt slow`
      : `Fly: speed ${speed.toFixed(2)} · mouse steers · W/S or wheel speed · A/D strafe · E/Q up/down · MMB pan · Ctrl free look${lockZ ? ' · Z level' : ''}${lockX ? ' · X pitch lock' : ''}`;
  app.startModal({
    label: kind === 'WALK' ? 'Walk Navigation' : 'Fly Navigation',
    header,
    status: () =>
      kind === 'WALK'
        ? [
            ['LMB/Enter', 'Confirm'],
            ['RMB/Esc', 'Cancel'],
            ['WASD', 'Move'],
            ['Q E', 'Down / Up'],
            ['Tab', 'Gravity'],
            ['V', 'Jump'],
            ['Space', 'Teleport'],
            ['Wheel', 'Speed'],
          ]
        : [
            ['LMB/Enter', 'Confirm'],
            ['RMB/Esc', 'Cancel'],
            ['W S / Wheel', 'Speed'],
            ['A D', 'Strafe'],
            ['E Q', 'Up / Down'],
            ['MMB', 'Pan'],
            ['Ctrl', 'Free Look'],
            ['X Z', 'Axis Lock'],
          ],
    onPointerMove(e) {
      if (kind === 'WALK') look(e.movementX * mouseSpeed * (keys.has('ALT') ? 0.25 : 1), e.movementY * mouseSpeed * mouseY * (keys.has('ALT') ? 0.25 : 1));
      else if (panning) {
        const eye = eyeOf();
        const s = flyStep * 0.2;
        eye.addScaledVector(nav.right, e.movementX * s).addScaledVector(nav.up, -e.movementY * s);
        setEye(eye);
      } else if (keys.has('CONTROL')) look(e.movementX * 0.0035, e.movementY * 0.0035);
      else mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      v.afterNav();
    },
    onWheel(e) {
      const f = e.deltaY < 0 ? 1.25 : 0.8;
      if (kind === 'FLY') speed = speed === 0 ? (e.deltaY < 0 ? flyStep * 10 : -flyStep * 10) : speed * (Math.sign(e.deltaY) === Math.sign(speed) ? 0.8 : 1.25);
      else speed = Math.max(0.01, speed * f);
      app.changed('ui');
    },
    onPointerDown(e) {
      if (e.button === 1) {
        if (kind === 'WALK') doTeleport();
        else panning = true;
        return undefined;
      }
      return e.button === 0 ? 'FINISHED' : 'CANCELLED';
    },
    onPointerUp(e) {
      if (e.button === 1) panning = false;
      return undefined;
    },
    onKey(e) {
      const k = e.key === ' ' ? 'SPACE' : e.key.toUpperCase();
      if (e.type === 'keyup') {
        keys.delete(k);
        if (e.code.startsWith('Key')) keys.delete(e.code.slice(3));
        return true;
      }
      if (k === 'ESCAPE') return 'CANCELLED';
      if (k === 'ENTER') return 'FINISHED';
      if (e.repeat) return true;
      const code = e.code.startsWith('Key') ? e.code.slice(3) : k;
      if (kind === 'FLY' && k === 'SPACE') return 'FINISHED';
      if (kind === 'WALK') {
        if (k === 'TAB' || code === 'G') {
          e.preventDefault();
          gravity = !gravity;
          vz = 0;
          app.changed('ui');
          return true;
        }
        if (code === 'V' && gravity) {
          const g = ground(eyeOf().add(new Vector3(0, 0, 0.1)));
          if (!g || eyeOf().z - g.point.z <= viewHeight + 0.05) vz = Math.sqrt(2 * 9.81 * jumpHeight);
          return true;
        }
        if (k === '.' || k === ',') {
          jumpHeight = Math.max(0.05, jumpHeight * (k === '.' ? 1.25 : 0.8));
          return true;
        }
        if (k === 'SPACE') {
          doTeleport();
          return true;
        }
      } else {
        // fly: W/S (and arrows) change the forward speed; Z/X toggle the axis locks
        if (code === 'W' || k === 'ARROWUP') {
          speed = speed < 0 ? 0 : speed + flyStep * 5;
          app.changed('ui');
          return true;
        }
        if (code === 'S' || k === 'ARROWDOWN') {
          speed = speed > 0 ? 0 : speed - flyStep * 5;
          app.changed('ui');
          return true;
        }
        if (code === 'Z') {
          lockZ = !lockZ;
          app.changed('ui');
          return true;
        }
        if (code === 'X') {
          lockX = !lockX;
          app.changed('ui');
          return true;
        }
        if (k === '+' || k === '-') {
          speed += (k === '+' ? 1 : -1) * flyStep * 5;
          return true;
        }
      }
      if (kind === 'WALK' && (k === '+' || k === '-')) {
        speed = Math.max(0.01, speed * (k === '+' ? 1.25 : 0.8));
        return true;
      }
      keys.add(code);
      keys.add(k);
      return true;
    },
    cancel() {
      stop();
      nav.pivot.copy(before.pivot);
      nav.rot.copy(before.rot);
      nav.distance = before.distance;
      nav.ortho = orthoBefore;
      if (camOb && camBefore) {
        Object.assign(camOb, structuredClone(camBefore));
        app.changed('doc');
      }
      redraw(v);
    },
    finish() {
      stop();
      redraw(v);
    },
  });
  return 'RUNNING_MODAL' as const;
}

// Home in camera view frames the camera bounds (before the generic Frame All binding)
(keymaps['3D View'] ??= []).unshift({ key: 'HOME', op: 'view3d.view_center_camera', when: () => !!activeView3D()?.cameraView });
(keymaps['3D View'] ??= []).push(
  { key: 'B', shift: true, op: 'view3d.zoom_border' },
  { key: 'ACCENT_GRAVE', shift: true, op: 'view3d.navigate' },
  { key: 'B', alt: true, op: 'view3d.clip_border' },
  { key: 'B', ctrl: true, op: 'view3d.render_border', when: () => !!activeView3D()?.cameraView && app.doc.mode !== 'EDIT' },
  { key: 'B', ctrl: true, alt: true, op: 'view3d.clear_render_border' },
  { key: 'TAB', shift: true, ctrl: true, action: () => openPopover({ x: app.pointer.x - 120, y: app.pointer.y - 20 }, snappingPopover, { width: 240 }) },
);
