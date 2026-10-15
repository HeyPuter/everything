// Small axes in the lower-left corner of the 3D Viewport (Preferences ▸ Viewport ▸ Mini Axes).
import { Vector3 } from 'three';
import { h } from '../ui/h';
import { prefs } from '../app/prefs';
import { editModeHooks } from '../editors/view3d/hooks';

const AXES = [
  { v: new Vector3(1, 0, 0), label: 'X', rgb: [255, 51, 82] },
  { v: new Vector3(0, 1, 0), label: 'Y', rgb: [139, 220, 0] },
  { v: new Vector3(0, 0, 1), label: 'Z', rgb: [40, 144, 255] },
];

editModeHooks.svg.push((v) => {
  if (prefs.mini_axis_type !== 'MINIMAL' || !v.showNavGizmo) return null;
  const size = Math.max(10, Math.min(64, prefs.mini_axis_size));
  const k = Math.max(0, Math.min(10, prefs.mini_axis_brightness)) / 10;
  const q = (v.sceneCamera ? v.sceneCamera.quaternion : v.nav.rot).clone().invert();
  const ox = size + 16,
    oy = v.height - size - 16;
  const items = AXES.map((a) => ({ ...a, p: a.v.clone().applyQuaternion(q) })).sort((a, b) => a.p.z - b.p.z);
  return h(
    'g',
    { class: 'mini-axes', 'pointer-events': 'none' },
    items.map((a) => {
      const c = `rgb(${a.rgb.map((x) => Math.round(x * (0.35 + 0.65 * k))).join(',')})`;
      const x = ox + a.p.x * size,
        y = oy - a.p.y * size;
      return h(
        'g',
        { key: a.label },
        h('line', { x1: ox, y1: oy, x2: x, y2: y, stroke: c, 'stroke-width': 2, 'stroke-linecap': 'round', opacity: a.p.z < 0 ? 0.6 : 1 }),
        h('text', { x: ox + a.p.x * (size + 9), y: oy - a.p.y * (size + 9) + 4, fill: c, 'font-size': 11, 'text-anchor': 'middle', 'font-weight': 600 }, a.label),
      );
    }),
  );
});
