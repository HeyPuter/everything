// Navigation gizmo (axis bubbles) and the zoom / pan / camera / projection buttons.
import { Vector3 } from 'three';
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import type { View3D } from './view3d';
import type { ViewName } from '../../render/navcam';

const AX = [
  { v: new Vector3(1, 0, 0), label: 'X', color: '#ff3352', view: 'RIGHT' as ViewName },
  { v: new Vector3(0, 1, 0), label: 'Y', color: '#8bdc00', view: 'BACK' as ViewName },
  { v: new Vector3(0, 0, 1), label: 'Z', color: '#2890ff', view: 'TOP' as ViewName },
  { v: new Vector3(-1, 0, 0), label: '', color: '#ff3352', view: 'LEFT' as ViewName },
  { v: new Vector3(0, -1, 0), label: '', color: '#8bdc00', view: 'FRONT' as ViewName },
  { v: new Vector3(0, 0, -1), label: '', color: '#2890ff', view: 'BOTTOM' as ViewName },
];

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
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!moved && axis >= 0) {
        // clicking the axis that already faces the viewer flips to the opposite view
        const a = AX[axis];
        const cur = v.nav.view;
        v.leaveCamera();
        if (cur === a.view) v.nav.setAxisView(a.view, true);
        else v.nav.setAxisView(a.view);
        v.afterNav();
      }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  return h(
    'div',
    { key: 'navgizmo', class: 'nav-gizmo-wrap' },
    h(
      'svg',
      { class: 'nav-gizmo', width: 80, height: 80, viewBox: '0 0 80 80', onpointerdown: startDrag },
      h('circle', { class: 'ng-bg', cx: 40, cy: 40, r: 38 }),
      items.map((it) =>
        h(
          'g',
          { key: it.i, 'data-axis': it.i, class: 'ng-axis' },
          it.label ? h('line', { x1: 40, y1: 40, x2: it.x, y2: it.y, stroke: it.color, 'stroke-width': 2, opacity: it.z < 0 ? 0.55 : 1 }) : null,
          h('circle', { cx: it.x, cy: it.y, r: it.label ? 8 : 7, fill: it.label ? it.color : 'none', stroke: it.color, 'stroke-width': it.label ? 0 : 1.6, opacity: it.z < 0 ? (it.label ? 0.75 : 0.6) : 1, class: it.label ? '' : 'neg' }),
          it.label ? h('text', { x: it.x, y: it.y + 3.6, 'text-anchor': 'middle', class: 'ng-label' }, it.label) : null,
        ),
      ),
    ),
    h(
      'div',
      { class: 'nav-buttons' },
      h('button', { class: 'nav-btn', 'data-tip': 'Zoom\nZoom in/out in the view (drag)', onpointerdown: (e: PointerEvent) => v.navDrag(e, 'zoom') }, icon('view_zoom')),
      h('button', { class: 'nav-btn', 'data-tip': 'Move\nPan the view (drag)', onpointerdown: (e: PointerEvent) => v.navDrag(e, 'pan') }, icon('view_pan')),
      h('button', { class: { 'nav-btn': true, on: v.cameraView }, 'data-tip': 'Toggle the camera view (Numpad 0)', onclick: () => app.run('view3d.view_camera') }, icon('view_camera')),
      h('button', { class: 'nav-btn', 'data-tip': 'Switch the current view from perspective/orthographic projection (Numpad 5)', onclick: () => app.run('view3d.view_persportho') }, icon(v.nav.ortho ? 'view_ortho' : 'view_persp')),
    ),
  );
}
