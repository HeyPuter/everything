// Vertex Paint color adjustments and Weight Paint vertex group tools: levels, hue/saturation/value,
// brightness/contrast, color from weight, weight gradient, sample group, mirror, quantize,
// levels, locks and envelope weights.
import { Matrix4, Vector3 } from 'three';
import { app, operators, registerOperators } from '../app/app';
import { own } from '../data/cow';
import type { MeshData, ObjectData } from '../data/types';
import { h, type VNode } from '../ui/h';
import { openMenu } from '../ui/menu';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeMeshData, meshSession } from './session';
import { invalidatePaintAttributes } from './display';
import { paintFilter } from './fsdata';
import { projectVertices } from './vgather';
import { editColors } from './vpaint';
import { armatureOf, deformGroups, ensureActiveGroup } from './wpaint';
import { segmentDistance2 } from './armweights';
import { blendWeight, normalizeVertexWeights, type BlendMode } from './math';
import { activeBrush } from './brushes';
import { adjustColor, mirrorVertexMap, quantize } from './paintmath';

const vpPoll = () => app.doc.mode === 'VERTEX_PAINT' && !!activeMeshData();
const wpPoll = () => app.doc.mode === 'WEIGHT_PAINT' && !!activeMeshData();
/** Weight tools also work from Edit Mode / Object Mode on meshes with vertex groups. */
const groupPoll = () => !!activeMeshData() && (app.doc.mode === 'WEIGHT_PAINT' || app.doc.mode === 'OBJECT' || app.doc.mode === 'EDIT') && !!activeMeshData()!.me.vertex_groups.length;

// ---------------------------------------------------------------------------
// vertex colors

registerOperators([
  {
    idname: 'paint.vertex_color_levels',
    label: 'Vertex Paint Levels',
    description: 'Adjust the levels of the vertex colors',
    props: [
      { id: 'offset', label: 'Offset', type: 'float', default: 0, min: -1, max: 1 },
      { id: 'gain', label: 'Gain', type: 'float', default: 1, min: 0, max: 10, softMax: 4 },
    ],
    poll: vpPoll,
    exec: (_c, p) => editColors((_me, cols) => adjustColor(cols, { offset: p.offset as number, gain: p.gain as number })),
  },
  {
    idname: 'paint.vertex_color_hsv',
    label: 'Vertex Paint Hue/Saturation/Value',
    description: 'Adjust the hue, saturation and value of the vertex colors',
    props: [
      { id: 'h', label: 'Hue', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 's', label: 'Saturation', type: 'float', default: 1, min: 0, max: 2 },
      { id: 'v', label: 'Value', type: 'float', default: 1, min: 0, max: 2 },
    ],
    poll: vpPoll,
    exec: (_c, p) => editColors((_me, cols) => adjustColor(cols, { hue: p.h as number, saturation: p.s as number, value: p.v as number })),
  },
  {
    idname: 'paint.vertex_color_brightness_contrast',
    label: 'Vertex Paint Brightness/Contrast',
    description: 'Adjust the brightness and contrast of the vertex colors',
    props: [
      { id: 'brightness', label: 'Brightness', type: 'float', default: 0, min: -100, max: 100, subtype: 'percentage' },
      { id: 'contrast', label: 'Contrast', type: 'float', default: 0, min: -100, max: 100, subtype: 'percentage' },
    ],
    poll: vpPoll,
    exec: (_c, p) => editColors((_me, cols) => adjustColor(cols, { brightness: (p.brightness as number) / 100, contrast: (p.contrast as number) / 100 })),
  },
  {
    idname: 'paint.vertex_color_from_weight',
    label: 'Vertex Color from Weight',
    description: 'Set the vertex colors from the weights of the active vertex group',
    poll: () => vpPoll() && !!activeMeshData()!.me.vertex_groups.length,
    exec: () => {
      const { ob } = activeMeshData()!;
      editColors((m, cols) => {
        const gi = Math.max(0, Math.min(m.vertex_groups.length - 1, ob.vertex_group_active_index ?? 0));
        const w = m.weights[gi];
        for (let v = 0; v < cols.length / 4; v++) {
          const x = w?.[v] ?? 0;
          cols[v * 4] = cols[v * 4 + 1] = cols[v * 4 + 2] = x;
        }
      });
    },
  },
]);

// ---------------------------------------------------------------------------
// vertex groups

function editWeights(fn: (ob: ObjectData, me: MeshData, gi: number, allowed: Uint8Array | null) => void) {
  const { ob, me } = activeMeshData()!;
  const gi = ensureActiveGroup(ob, me);
  me.weights = me.weights.map((w) => own(w.slice()));
  const allowed = app.doc.mode === 'WEIGHT_PAINT' ? paintFilter(me).verts : null;
  fn(ob, me, gi, allowed);
  invalidatePaintAttributes();
}

/** Group indices for the "group_select_mode" style props. */
function targetGroups(ob: ObjectData, me: MeshData, gi: number, mode: string): number[] {
  if (mode === 'ALL') return me.vertex_groups.map((_, i) => i);
  if (mode === 'BONE_DEFORM') return deformGroups(ob, me);
  return [gi];
}
const groupSelectProp = {
  id: 'group_select_mode',
  label: 'Subset',
  type: 'enum' as const,
  default: 'ACTIVE',
  items: [
    ['ACTIVE', 'Active Group', 'The active vertex group'],
    ['BONE_DEFORM', 'Deform Pose Bones', 'All groups deformed by bones'],
    ['ALL', 'All Groups', 'All vertex groups'],
  ] as [string, string, string][],
};

function mirrorName(name: string): string {
  const pairs: [RegExp, string][] = [
    [/([._\- ])L$/, '$1R'],
    [/([._\- ])R$/, '$1L'],
    [/([._\- ])l$/, '$1r'],
    [/([._\- ])r$/, '$1l'],
    [/^L([._\- ])/, 'R$1'],
    [/^R([._\- ])/, 'L$1'],
    [/Left/, 'Right'],
    [/Right/, 'Left'],
    [/left/, 'right'],
    [/right/, 'left'],
  ];
  for (const [re, rep] of pairs) if (re.test(name)) return name.replace(re, rep);
  return name;
}

registerOperators([
]);

/** Bones selected in the armature deforming the object (pose selection, else edit selection). */
function selectedBoneNames(ob: ObjectData): Set<string> {
  const arm = armatureOf(ob);
  const out = new Set<string>();
  if (!arm) return out;
  const ad = arm.data ? app.doc.armatures[arm.data] : undefined;
  for (const b of ad?.bones ?? []) if (arm.pose?.[b.name]?.select || b.select) out.add(b.name);
  return out;
}

// ---------------------------------------------------------------------------
// envelope weights (Assign from Bone Envelopes)

/** Weights from bone envelopes: full inside the bone radius, fading out over the envelope distance. */
export function envelopeWeights(meshOb: ObjectData, armOb: ObjectData) {
  const doc = app.doc;
  const me = meshOb.data ? doc.meshes[meshOb.data] : undefined;
  const arm = armOb.data ? doc.armatures[armOb.data] : undefined;
  if (!me || !arm) return;
  const nv = me.positions.length / 3;
  const mw = app.graph.get(meshOb.id)?.world ?? new Matrix4();
  const aw = app.graph.get(armOb.id)?.world ?? new Matrix4();
  const toArm = aw.clone().invert().multiply(mw);
  const bones = arm.bones.filter((b) => b.use_deform);
  me.weights = me.weights.slice();
  const p = new Vector3();
  for (const b of bones) {
    let gi = me.vertex_groups.findIndex((g) => g.name === b.name);
    if (gi < 0) {
      me.vertex_groups.push({ name: b.name });
      me.weights.push(own(new Float32Array(nv)));
      gi = me.vertex_groups.length - 1;
    }
    if (me.vertex_groups[gi].lock_weight) continue;
    const w = new Float32Array(nv);
    const head = new Vector3(...b.head),
      tail = new Vector3(...b.tail);
    const len = head.distanceTo(tail);
    const hr = b.head_radius || len * 0.1,
      tr = b.tail_radius || len * 0.05,
      dist = b.envelope_distance || len * 0.25;
    for (let v = 0; v < nv; v++) {
      p.set(me.positions[v * 3], me.positions[v * 3 + 1], me.positions[v * 3 + 2]).applyMatrix4(toArm);
      const d = Math.sqrt(segmentDistance2(p.x, p.y, p.z, head, tail));
      // radius along the bone
      const ab = tail.clone().sub(head);
      const t = len > 0 ? Math.max(0, Math.min(1, p.clone().sub(head).dot(ab) / (len * len))) : 0;
      const r = hr + (tr - hr) * t;
      w[v] = d <= r ? 1 : d >= r + dist ? 0 : 1 - (d - r) / dist;
    }
    me.weights[gi] = own(w);
  }
  if (me.vertex_groups.length && (meshOb.vertex_group_active_index ?? -1) < 0) meshOb.vertex_group_active_index = 0;
}

// replace the existing Assign Automatic op with one that also offers envelopes
{
  const old = operators.get('paint.weight_from_bones');
  if (old)
    registerOperators([
      {
        ...old,
        props: [
          {
            id: 'type',
            label: 'Type',
            type: 'enum',
            default: 'AUTOMATIC',
            items: [
              ['AUTOMATIC', 'Automatic', 'Weights from the distance to the bones, spread over the surface'],
              ['ENVELOPES', 'From Envelopes', 'Weights from the bone envelopes'],
            ],
          },
        ],
        exec: (ctx, p) => {
          if (p.type !== 'ENVELOPES') return old.exec!(ctx, p);
          const ob = app.activeObject!;
          const arm = armatureOf(ob);
          if (!arm) return 'CANCELLED';
          envelopeWeights(ob, arm);
          invalidatePaintAttributes();
        },
      },
    ]);
}

// ---------------------------------------------------------------------------
// sample group (Shift Ctrl X)

registerOperators([
  {
    idname: 'paint.weight_sample_group',
    label: 'Weight Paint Sample Group',
    description: 'Pick the active vertex group from the groups of the vertex under the cursor',
    poll: () => wpPoll() && !!activeView3D(),
    invoke: (ctx) => {
      const v = activeView3D()!;
      const s = meshSession();
      const am = activeMeshData();
      if (!s || !am) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const hit = s.raycast(v, (ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top);
      if (!hit) return 'CANCELLED';
      const groups = new Set<number>();
      for (let c = s.offsets[hit.face]; c < s.offsets[hit.face + 1]; c++) {
        const vi = s.indices[c];
        am.me.weights.forEach((w, gi) => {
          if (w && w[vi] > 0) groups.add(gi);
        });
      }
      if (!groups.size) {
        app.report('INFO', 'No vertex groups under the cursor');
        return 'CANCELLED';
      }
      openMenu(
        [...groups].map((gi) => ({
          label: am.me.vertex_groups[gi].name,
          icon: 'group_vertex',
          active: gi === am.ob.vertex_group_active_index,
          action: () => {
            am.ob.vertex_group_active_index = gi;
            invalidatePaintAttributes();
            app.pushUndo('Sample Group');
            app.changed('doc');
          },
        })),
        { x: ctx.event?.x ?? app.pointer.x, y: ctx.event?.y ?? app.pointer.y },
        { title: 'Vertex Groups' },
      );
      return 'CANCELLED';
    },
  },
]);

// ---------------------------------------------------------------------------
// weight gradient

const grad = { view: null as View3D | null, a: null as { x: number; y: number } | null, b: null as { x: number; y: number } | null, radial: false };

editModeHooks.svg.push((v) => {
  if (!grad.a || !grad.b || grad.view !== v) return null;
  const { a, b } = grad;
  const parts: VNode[] = [
    h('path', { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, stroke: '#000000', 'stroke-width': 3, opacity: 0.5 }) as VNode,
    h('path', { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, stroke: '#ffffff', 'stroke-width': 1.5 }) as VNode,
    h('circle', { cx: a.x, cy: a.y, r: 4, fill: '#ffffff' }) as VNode,
  ];
  if (grad.radial) parts.push(h('circle', { cx: a.x, cy: a.y, r: Math.hypot(b.x - a.x, b.y - a.y), fill: 'none', stroke: '#ffffff', 'stroke-width': 1, 'stroke-dasharray': '4 3' }) as VNode);
  return h('g', { key: 'wgrad' }, ...parts) as VNode;
});

/** Apply a gradient to the active group from screen point a (full weight) to b (zero). */
function applyGradient(p: Record<string, unknown>): 'CANCELLED' | void {
  const v = activeView3D();
  const s = meshSession();
  if (!v || !s) return 'CANCELLED';
  const ax = p.xstart as number,
    ay = p.ystart as number,
    bx = p.xend as number,
    by = p.yend as number;
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return 'CANCELLED';
  const brush = activeBrush('WEIGHT_PAINT');
  const value = app.doc.scene.tool_settings.unified_paint.weight;
  const strength = brush?.strength ?? 1;
  const mode = (brush?.blend ?? 'MIX') as BlendMode;
  const proj = projectVertices(s, v);
  editWeights((ob, me, gi, allowed) => {
    if (me.vertex_groups[gi].lock_weight) return;
    const w = me.weights[gi];
    const groups = deformGroups(ob, me);
    const locked = me.vertex_groups.map((g) => !!g.lock_weight);
    for (let i = 0; i < w.length; i++) {
      if (allowed && !allowed[i]) continue;
      const z = proj[i * 3 + 2];
      if (z < -1 || z > 1) continue;
      const px = proj[i * 3] - ax,
        py = proj[i * 3 + 1] - ay;
      let t = p.type === 'RADIAL' ? Math.sqrt((px * px + py * py) / len2) : (px * dx + py * dy) / len2;
      if (t > 1) continue;
      t = Math.max(0, t);
      const target = value * (1 - t);
      w[i] = blendWeight(mode, w[i], target, strength);
      if (app.doc.scene.tool_settings.use_auto_normalize) normalizeVertexWeights(me.weights, groups, i, gi, locked);
    }
  });
}

registerOperators([
  {
    idname: 'paint.weight_gradient',
    label: 'Weight Gradient',
    description: 'Draw a line to fill the active group with a gradient (from the brush weight to zero)',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'LINEAR',
        items: [
          ['LINEAR', 'Linear', 'A linear gradient along the line'],
          ['RADIAL', 'Radial', 'A circular gradient around the start'],
        ],
      },
      { id: 'xstart', label: 'X Start', type: 'int', default: 0, hidden: true },
      { id: 'xend', label: 'X End', type: 'int', default: 0, hidden: true },
      { id: 'ystart', label: 'Y Start', type: 'int', default: 0, hidden: true },
      { id: 'yend', label: 'Y End', type: 'int', default: 0, hidden: true },
    ],
    poll: () => wpPoll() && !!activeView3D(),
    invoke: (_c, p) => (startGradient(activeView3D()!, p) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (_c, p) => applyGradient(p),
  },
]);

/** Drag a gradient line; with `start` the drag began with that pointer press (tool). */
export function startGradient(v: View3D, p: Record<string, unknown>, start?: PointerEvent): boolean {
  if (app.modal) return false;
  grad.view = v;
  grad.radial = p.type === 'RADIAL';
  grad.a = start ? v.local(start) : null;
  grad.b = grad.a ? { ...grad.a } : null;
  let done = false;
  app.startModal({
    label: 'Weight Gradient',
    cursor: 'crosshair',
    onPointerDown: (e) => {
      if (e.button === 2) return 'CANCELLED';
      if (e.button === 0 && !grad.a) {
        grad.a = v.local(e);
        grad.b = { ...grad.a };
        v.drawSvg();
      }
    },
    onPointerMove: (e) => {
      if (!grad.a) return;
      grad.b = v.local(e);
      v.drawSvg();
    },
    onPointerUp: () => {
      if (!grad.a) return;
      done = true;
      return 'CANCELLED';
    },
    onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : true),
    cancel: () => {
      const a = grad.a,
        b = grad.b;
      grad.a = grad.b = null;
      v.drawSvg();
      if (!done || !a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 2) return;
      app.run('paint.weight_gradient', { type: p.type, xstart: Math.round(a.x), ystart: Math.round(a.y), xend: Math.round(b.x), yend: Math.round(b.y) }, { invoke: false });
    },
    header: () => `Weight Gradient (${grad.radial ? 'Radial' : 'Linear'}): drag from full weight to zero, Esc cancels`,
  });
  return true;
}
