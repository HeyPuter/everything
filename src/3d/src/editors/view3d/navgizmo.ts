// Navigation gizmo (axis bubbles) and the zoom / pan / camera / projection buttons.
import { Vector3 } from 'three';
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { prefs } from '../../app/prefs';
import type { View3D } from './view3d';
import type { ViewName } from '../../render/navcam';
import { followPointer } from './hooks';
import { keyInputHooks } from '../../app/keymap';

const ACTIVATE = new Set(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
// keys on a focused gizmo part are its own (Space would otherwise start playback); the parts'
// keydown handlers act on them
keyInputHooks.push((e) => e.type === 'keydown' && ACTIVATE.has(e.key) && !!(e.target as Element | null)?.closest?.('.nav-gizmo-wrap'));
const activates = (e: KeyboardEvent) => e.key === 'Enter' || e.key === ' ';

const VIEW_LABEL: Record<string, string> = { RIGHT: 'Right', BACK: 'Back', TOP: 'Top', LEFT: 'Left', FRONT: 'Front', BOTTOM: 'Bottom' };

/** Look along an axis of the gizmo (again: from the opposite side). */
function axisView(v: View3D, axis: number) {
  const a = AX[axis];
  const cur = v.nav.view;
  v.leaveCamera();
  if (cur === a.view) v.nav.setAxisView(a.view, true);
  else v.nav.setAxisView(a.view);
  v.afterNav();
}

/** Keyboard use: Enter / Space on an axis turns the view; the redrawn gizmo keeps the focus. */
function axisKey(v: View3D, axis: number, e: KeyboardEvent) {
  if (!activates(e)) return;
  if (v.lockRotation) return;
  axisView(v, axis);
  const refocus = () => (v.el.querySelector(`.nav-gizmo [data-axis="${axis}"]`) as SVGElement | null)?.focus();
  refocus();
  setTimeout(refocus, 0);
}

const AX = [
  { v: new Vector3(1, 0, 0), label: 'X', color: '#fc364b', view: 'RIGHT' as ViewName },
  { v: new Vector3(0, 1, 0), label: 'Y', color: '#84e003', view: 'BACK' as ViewName },
  { v: new Vector3(0, 0, 1), label: 'Z', color: '#398efc', view: 'TOP' as ViewName },
  { v: new Vector3(-1, 0, 0), label: '', color: '#fc364b', view: 'LEFT' as ViewName },
  { v: new Vector3(0, -1, 0), label: '', color: '#84e003', view: 'FRONT' as ViewName },
  { v: new Vector3(0, 0, -1), label: '', color: '#398efc', view: 'BOTTOM' as ViewName },
];

/** A darker shade of a #rrggbb colour (the letters on the axis bubbles). */
function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => Math.round(x * k));
  return `rgb(${c.join(',')})`;
}

function keyZoom(v: View3D, f: number) {
  v.leaveCamera();
  v.nav.zoom(f);
  v.afterNav();
}

export function navGizmo(v: View3D): Child {
  // nav.rot is valid before the first draw; the scene camera is only set while looking through it
  const q = (v.sceneCamera ? v.sceneCamera.quaternion : v.nav.rot).clone().invert();
  const R = 32;
  const items = AX.map((a, i) => {
    const p = a.v.clone().applyQuaternion(q);
    return { ...a, i, x: 40 + p.x * R, y: 40 - p.y * R, z: p.z };
  }).sort((a, b) => a.z - b.z);
  const startDrag = (e: PointerEvent) => {
    e.preventDefault();
    // Quad View's fixed views cannot be turned
    if (v.lockRotation) return;
    const target = (e.target as Element).closest('[data-axis]') as Element | null;
    const axis = target ? Number(target.getAttribute('data-axis')) : -1;
    let moved = false;
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - last.x,
        dy = ev.clientY - last.y;
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
      moved = true;
      last = { x: ev.clientX, y: ev.clientY };
      v.leaveCamera();
      v.nav.orbit(dx * 0.01, dy * 0.01);
      v.afterNav();
    };
    followPointer(e, move, (_ev, cancelled) => {
      // clicking the axis that already faces the viewer flips to the opposite view
      if (!moved && axis >= 0 && !cancelled) axisView(v, axis);
    });
  };
  return h(
    'div',
    { key: 'navgizmo', class: 'nav-gizmo-wrap' },
    // Preferences ▸ Viewport ▸ Mini Axes: the interactive gizmo, a small axes corner (drawn elsewhere) or nothing
    prefs.mini_axis_type !== 'GIZMO'
      ? null
      : h(
      'svg',
      { class: 'nav-gizmo', role: 'group', 'aria-label': 'Navigation gizmo', width: prefs.gizmo_size_navigate_v3d, height: prefs.gizmo_size_navigate_v3d, viewBox: '0 0 80 80', onpointerdown: startDrag },
      h('circle', { class: 'ng-bg', cx: 40, cy: 40, r: 38 }),
      items.map((it) =>
        h(
          'g',
          { key: it.i, 'data-axis': it.i, class: 'ng-axis', tabindex: 0, role: 'button', 'aria-label': `${VIEW_LABEL[it.view]} view`, onkeydown: (e: KeyboardEvent) => axisKey(v, it.i, e) },
          it.label ? h('line', { x1: 40, y1: 40, x2: it.x, y2: it.y, stroke: it.color, 'stroke-width': 2, opacity: it.z < 0 ? 0.55 : 1 }) : null,
          // negative axes: a tinted disc inside a coloured ring
          h('circle', { cx: it.x, cy: it.y, r: it.label ? 8 : 7, fill: it.color, 'fill-opacity': it.label ? 1 : 0.28, stroke: it.color, 'stroke-width': it.label ? 0 : 1.6, opacity: it.z < 0 ? (it.label ? 0.75 : 0.6) : 1, class: it.label ? '' : 'neg' }),
          it.label ? h('text', { x: it.x, y: it.y + 3.6, 'text-anchor': 'middle', class: 'ng-label', style: `fill: ${shade(it.color, 0.38)}` }, it.label) : null,
        ),
      ),
    ),
    !prefs.show_navigate_ui
      ? null
      : h(
      'div',
      { class: 'nav-buttons' },
      // drags with the pointer; from the keyboard Enter zooms in (Shift+Enter out) and the arrow keys zoom / pan
      h(
        'button',
        {
          class: 'nav-btn',
          'aria-label': 'Zoom',
          'data-tip': 'Zoom\nZoom in/out in the view (drag)',
          onpointerdown: (e: PointerEvent) => v.navDrag(e, 'zoom'),
          onkeydown: (e: KeyboardEvent) => {
            if (activates(e)) keyZoom(v, e.shiftKey ? 1.2 : 1 / 1.2);
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') keyZoom(v, e.key === 'ArrowUp' ? 1 / 1.2 : 1.2);
          },
        },
        icon('view_zoom'),
      ),
      h(
        'button',
        {
          class: 'nav-btn',
          'aria-label': 'Move',
          'data-tip': 'Move\nPan the view (drag)',
          onpointerdown: (e: PointerEvent) => v.navDrag(e, 'pan'),
          onkeydown: (e: KeyboardEvent) => {
            const d = ({ ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] } as Record<string, [number, number]>)[e.key];
            if (!d) return;
            v.leaveCamera();
            v.nav.pan(d[0], d[1]);
            v.afterNav();
          },
        },
        icon('view_pan'),
      ),
      h('button', { class: { 'nav-btn': true, on: v.cameraView }, 'aria-label': 'Toggle the camera view', 'aria-pressed': v.cameraView ? 'true' : 'false', 'data-tip': 'Toggle the camera view (Numpad 0)', onclick: () => app.run('view3d.view_camera'), onkeydown: (e: KeyboardEvent) => activates(e) && app.run('view3d.view_camera') }, icon('view_camera')),
      h('button', { class: 'nav-btn', 'aria-label': v.nav.ortho ? 'Switch to perspective' : 'Switch to orthographic', 'data-tip': 'Switch the current view from perspective/orthographic projection (Numpad 5)', onclick: () => app.run('view3d.view_persportho'), onkeydown: (e: KeyboardEvent) => activates(e) && app.run('view3d.view_persportho') }, icon(v.nav.ortho ? 'view_ortho' : 'view_persp')),
    ),
  );
}
