// Cloth Filter: deform the whole (unmasked) mesh like cloth — gravity, inflate, expand, pinch or
// scale forces with the edge lengths kept by a position-based solver. Masked vertices are pinned.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { cow } from '../data/cow';
import { h, type Child } from '../ui/h';
import { enumMenu, numberField } from '../ui/widgets';
import { toolSettingsRenderers } from '../editors/view3d/toolbar';
import { activeMeshData, beginGeometryStroke, meshSession, reevaluate, type MeshSession } from './session';
import { edgeTopology } from '../mesh/mesh';
import { finishDeform } from './gestureops';
import { sculptPoll } from './facesetops';
import { sculptToolHooks } from './sculpttools';
import { clothSimulate, type ClothInput } from './filters';
export { clothSimulate };

export const CLOTH_FILTERS: [string, string, string][] = [
  ['GRAVITY', 'Gravity', 'Let the cloth fall down'],
  ['INFLATE', 'Inflate', 'Push the cloth along its normals'],
  ['EXPAND', 'Expand', 'Push the cloth away from its center'],
  ['PINCH', 'Pinch', 'Pull the cloth toward its center'],
  ['SCALE', 'Scale', 'Grow or shrink the cloth keeping the folds'],
];

function input(s: MeshSession, orig: Float32Array): ClothInput {
  const { me } = activeMeshData()!;
  const mask = me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : null;
  const free = new Float32Array(s.nv);
  for (let v = 0; v < s.nv; v++) free[v] = s.hiddenV?.[v] ? 0 : 1 - (mask ? mask[v] : 0);
  const inv = new Matrix3().setFromMatrix4(new Matrix4().copy(s.world()).invert());
  const down = new Vector3(0, 0, -1).applyMatrix3(inv).normalize();
  const c = new Vector3();
  for (let v = 0; v < s.nv; v++) c.add(new Vector3(orig[v * 3], orig[v * 3 + 1], orig[v * 3 + 2]));
  c.multiplyScalar(1 / Math.max(1, s.nv));
  return { orig, normals: s.vn.slice(), edges: edgeTopology(me).verts, free, down: [down.x, down.y, down.z], center: [c.x, c.y, c.z] };
}

function preview(s: MeshSession, res: Float32Array) {
  const { me } = activeMeshData()!;
  s.positions.set(res);
  s.recomputeNormals();
  if (s.direct) {
    const all: number[] = [];
    for (let f = 0; f < s.nf; f++) all.push(f);
    s.writeFaces(all, me.smooth);
    s.flush();
  } else reevaluate(s);
}

function start(p: Record<string, unknown>, ev?: PointerEvent): 'RUNNING_MODAL' | 'CANCELLED' {
  const am = activeMeshData();
  const s = meshSession();
  if (!am || !s || app.modal) return 'CANCELLED';
  const { me } = am;
  const old = me.positions;
  beginGeometryStroke(s, me, () => cow(me, 'positions'));
  const orig = old !== me.positions ? old : me.positions.slice();
  const inp = input(s, orig);
  const x0 = ev ? ev.clientX : app.pointer.x;
  const scale = (p.strength as number) || 1;
  let raf = 0;
  app.startModal({
    label: 'Filter Cloth',
    cursor: 'ew-resize',
    onPointerMove: (e) => {
      p.strength = Math.round(((e.clientX - x0) / 200) * scale * 1000) / 1000;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          preview(s, clothSimulate(inp, p.type as string, p.strength as number));
        });
    },
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : ev ? undefined : 'FINISHED'),
    onPointerUp: (e) => (ev && e.button === 0 ? 'FINISHED' : undefined),
    onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
    cancel: () => {
      if (raf) cancelAnimationFrame(raf);
      preview(s, orig);
      s.finishGeometry();
    },
    finish: () => {
      if (raf) cancelAnimationFrame(raf);
      s.positions.set(clothSimulate(inp, p.type as string, p.strength as number));
      finishDeform(s, me, null);
    },
    header: () => `Cloth Filter (${CLOTH_FILTERS.find((f) => f[0] === p.type)?.[1]}): move left / right for the strength ${(p.strength as number).toFixed(3)}, click to apply`,
    redoOp: { idname: 'sculpt.cloth_filter', props: p },
  });
  return 'RUNNING_MODAL';
}

registerOperators([
  {
    idname: 'sculpt.cloth_filter',
    label: 'Filter Cloth',
    description: 'Deform the whole unmasked mesh like cloth (masked vertices stay pinned)',
    props: [
      { id: 'type', label: 'Filter Type', type: 'enum', default: 'GRAVITY', items: CLOTH_FILTERS },
      { id: 'strength', label: 'Strength', type: 'float', default: 1, min: -10, max: 10, softMin: -2, softMax: 2 },
    ],
    poll: sculptPoll,
    invoke: (_c, p) => start(p),
    exec: (_c, p) => {
      const am = activeMeshData();
      const s = meshSession();
      if (!am || !s) return 'CANCELLED';
      beginGeometryStroke(s, am.me, () => cow(am.me, 'positions'));
      s.positions.set(clothSimulate(input(s, am.me.positions.slice()), p.type as string, p.strength as number));
      finishDeform(s, am.me, null);
    },
  },
]);

const settings = { type: 'GRAVITY', strength: 1 };
export const clothFilterToolId = 'builtin.cloth_filter';
sculptToolHooks.pointer.push((_v, e, tool) => {
  if (tool !== clothFilterToolId) return false;
  start({ type: settings.type, strength: settings.strength }, e);
  return true;
});
toolSettingsRenderers[clothFilterToolId] = (): Child => {
  const box = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);
  return [
    box(120, enumMenu('th-clf-type', CLOTH_FILTERS.map(([value, label]) => ({ value, label })), settings.type, (x) => ((settings.type = x), app.changed('ui')), { tip: 'Force applied to the cloth' })),
    box(140, numberField({ id: 'th-clf-str', label: 'Strength', value: settings.strength, min: -10, max: 10, softMin: -2, softMax: 2, tip: 'Multiplier for the drag distance', set: (x) => ((settings.strength = x), app.changed('ui')) })),
    h('span', { class: 'th-label' }, 'Drag left / right · mask pins the cloth'),
  ];
};
