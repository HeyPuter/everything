// Vertex groups and Weight Paint mode for grease pencil: groups on the data-block, per point
// weights on the drawings; Draw / Blur / Average / Smear weight brushes, the Weights menu
// (normalize, invert, smooth, sample) and the weight display (blue → red).
import { Matrix4, Vector3 } from 'three';
import { app, onAppReady, operators, registerOperators, type OpContext, type Operator } from '../app/app';
import { activeTools } from '../app/prefs';
import { addKeys } from '../app/keymap';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { extraToolLists, toolSettingsRenderers, type ToolDef } from '../editors/view3d/toolbar';
import { modeMenus } from '../editors/view3d/modemenus';
import { runStroke } from '../paint/stroke';
import { h } from '../ui/h';
import { numberField } from '../ui/widgets';
import type { MenuItem } from '../ui/menu';
import type { ObjectData } from '../data/types';
import { uid } from '../data/defaults';
import { newModifier } from '../eval/modifiers';
import { gpOf, gpBrush, frameAt, normalizeDrawing } from './data';
import { editableDrawing } from './paint';
import { layerMatrix, drawingDisplayHooks } from './render';
import { brushFalloff } from './sculpt';
import { editTargets, inGPEdit } from './edit';
import { activeLayerMenu, animationMenu, showHideMenu } from './menus';
import { placementControls, sizeField, strengthField } from './ui';
import type { GPBrush, GPDrawing, GPLayer, GreasePencilData } from './types';

const gpCtx = () => {
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  return ob && gp ? { ob, gp } : null;
};
export const inWeightPaint = () => app.doc.mode === 'WEIGHT_GREASE_PENCIL' && !!gpCtx();

/** Name of the active vertex group (null when the object has none). */
export function activeGroup(ob: ObjectData, gp: GreasePencilData): string | null {
  const g = gp.vertex_groups ?? [];
  return g[Math.min(g.length - 1, Math.max(0, ob.vertex_group_active_index ?? 0))]?.name ?? null;
}

function uniqueGroupName(gp: GreasePencilData, base: string) {
  const names = new Set((gp.vertex_groups ?? []).map((g) => g.name));
  let name = base;
  for (let i = 1; names.has(name); i++) name = `${base}.${String(i).padStart(3, '0')}`;
  return name;
}

/** Add a vertex group (returns its name). */
export function addGroup(ob: ObjectData, gp: GreasePencilData, base = 'Group'): string {
  const name = uniqueGroupName(gp, base);
  (gp.vertex_groups ??= []).push({ name });
  ob.vertex_group_active_index = gp.vertex_groups.length - 1;
  return name;
}

/** Weights of a group in a drawing (a writable copy is stored back). */
function ownWeights(d: GPDrawing, name: string): Float32Array {
  const n = d.position.length / 3;
  d.weights = { ...(d.weights ?? {}) };
  const w = d.weights[name];
  d.weights[name] = w && w.length === n ? w.slice() : new Float32Array(n);
  return d.weights[name];
}

// ---------------------------------------------------------------------------
// weight brushes

export const WEIGHT_TOOLS: ToolDef[] = [
  { id: 'builtin.brush.WeightDraw', label: 'Draw', icon: 'gp_weight_draw', description: 'Paint the brush weight (Ctrl: subtract, D: toggle)' },
  { id: 'builtin.brush.WeightBlur', label: 'Blur', icon: 'gp_vertex_blur', description: 'Smooth the weights under the brush' },
  { id: 'builtin.brush.WeightAverage', label: 'Average', icon: 'gp_vertex_average', description: 'Pull the weights under the brush toward their average' },
  { id: 'builtin.brush.WeightSmear', label: 'Smear', icon: 'gp_vertex_smear', description: 'Drag the weights along the brush stroke' },
];
extraToolLists.WEIGHT_GREASE_PENCIL = () => WEIGHT_TOOLS;

function brush(tool: string): GPBrush & { weight?: number } {
  const b = gpBrush(app.doc, tool) as GPBrush & { weight?: number };
  b.size ??= 40;
  b.weight ??= 1;
  b.direction ??= 'ADD';
  return b;
}

function startWeightPaint(v: View3D, e: PointerEvent) {
  const { ob, gp } = gpCtx()!;
  const group = activeGroup(ob, gp) ?? addGroup(ob, gp);
  const tool = activeTools[app.doc.mode] ?? 'builtin.brush.WeightDraw';
  const b = brush(tool);
  const R = b.size / 2;
  const frame = app.doc.scene.frame_current;
  const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
  const subtract = (b.direction === 'SUBTRACT') !== e.ctrlKey;
  const targets = gp.layers
    .filter((l) => !l.lock && !l.hide && frameAt(l, frame))
    .map((l) => ({ layer: l, idx: null as number | null, world: obWorld.clone().multiply(layerMatrix(l)) }));
  const p = new Vector3();
  let changed = false;
  let last = v.local(e);
  runStroke(v, e, {
    spacing: () => 15,
    radiusPx: () => R,
    dab: (dab) => {
      const s0 = b.strength * (b.use_pressure_strength ? dab.pressure : 1);
      const dx = dab.x - last.x,
        dy = dab.y - last.y;
      for (const t of targets) {
        const src = normalizeDrawing(gp.drawings[t.idx ?? frameAt(t.layer, frame)!.drawing]);
        const n = src.position.length / 3;
        const hits: { i: number; f: number; sx: number; sy: number }[] = [];
        for (let i = 0; i < n; i++) {
          p.set(src.position[i * 3], src.position[i * 3 + 1], src.position[i * 3 + 2]).applyMatrix4(t.world);
          const s = v.project(p);
          const f = brushFalloff(Math.hypot(s.x - dab.x, s.y - dab.y) / R);
          if (f > 0) hits.push({ i, f, sx: s.x, sy: s.y });
        }
        if (!hits.length) continue;
        if (t.idx === null) {
          t.idx = editableDrawing(gp, t.layer, frame, true);
          gp.drawings[t.idx] = { ...normalizeDrawing(gp.drawings[t.idx]) };
        }
        const d = gp.drawings[t.idx];
        const w = ownWeights(d, group);
        const before = w.slice();
        changed = true;
        let avg = 0,
          ws = 0;
        for (const { i, f } of hits) {
          avg += before[i] * f;
          ws += f;
        }
        avg /= ws || 1;
        for (const { i, f, sx, sy } of hits) {
          const k = Math.min(1, s0 * f * 0.4);
          if (tool === 'builtin.brush.WeightDraw') w[i] += ((subtract ? 0 : (b.weight ?? 1)) - w[i]) * k;
          else if (tool === 'builtin.brush.WeightAverage') w[i] += (avg - w[i]) * k;
          else if (tool === 'builtin.brush.WeightBlur') {
            let s = 0;
            while (s + 1 < d.offsets.length - 1 && d.offsets[s + 1] <= i) s++;
            const a = Math.max(d.offsets[s], i - 1),
              z = Math.min(d.offsets[s + 1] - 1, i + 1);
            w[i] += ((before[a] + before[i] + before[z]) / 3 - w[i]) * k * 2;
          } else {
            let best = -1,
              bd = Infinity;
            for (const o of hits) {
              const dd = Math.hypot(o.sx - (sx - dx), o.sy - (sy - dy));
              if (dd < bd) [bd, best] = [dd, o.i];
            }
            if (best >= 0) w[i] += (before[best] - w[i]) * k * 2;
          }
          w[i] = Math.max(0, Math.min(1, w[i]));
        }
      }
      last = { x: dab.x, y: dab.y };
    },
    update: () => {
      if (changed) app.changed('doc');
    },
    end: () => {
      if (changed) app.pushUndo('Grease Pencil Paint Weight');
    },
  });
}

editModeHooks.pointer.unshift((v, e) => {
  if (!inWeightPaint() || e.button !== 0) return false;
  startWeightPaint(v, e);
  return true;
});

// ---------------------------------------------------------------------------
// weight display: points colored by the active group's weight

/** Weight → color ramp (blue, cyan, green, yellow, red). */
export function weightColor(w: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, w)) * 4;
  const stops: [number, number, number][] = [
    [0, 0, 1],
    [0, 1, 1],
    [0, 1, 0],
    [1, 1, 0],
    [1, 0, 0],
  ];
  const i = Math.min(3, Math.floor(t)),
    f = t - i;
  return [0, 1, 2].map((k) => stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f) as [number, number, number];
}

const shown = new WeakMap<GPDrawing, { w: Float32Array | undefined; group: string | null; d: GPDrawing }>();
drawingDisplayHooks.push((ob, gp, d) => {
  if (app.doc.mode !== 'WEIGHT_GREASE_PENCIL' || app.activeObject !== ob) return null;
  const group = activeGroup(ob, gp);
  const w = group ? d.weights?.[group] : undefined;
  const hit = shown.get(d);
  if (hit && hit.w === w && hit.group === group) return hit.d;
  const n = d.position.length / 3;
  const vc = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) vc.set([...weightColor(w ? w[i] : 0), 1], i * 4);
  const out = { ...d, vertex_color: vc, fill_color: new Float32Array(d.fill_color.length) };
  shown.set(d, { w, group, d: out });
  return out;
});

// ---------------------------------------------------------------------------
// operators

const pollGroups = () => {
  const c = gpCtx();
  return !!c && (c.gp.vertex_groups?.length ?? 0) > 0;
};

/** Every drawing weights of a group (editable keys at the current frame, or all keys). */
function eachDrawing(fn: (d: GPDrawing, layer: GPLayer) => void, allKeys = false) {
  const { gp } = gpCtx()!;
  const frame = app.doc.scene.frame_current;
  const seen = new Set<number>();
  for (const l of gp.layers) {
    if (l.lock) continue;
    const frames = allKeys ? l.frames : [frameAt(l, frame)].filter(Boolean);
    for (const f of frames) {
      if (!f || seen.has(f.drawing) || !gp.drawings[f.drawing]) continue;
      seen.add(f.drawing);
      gp.drawings[f.drawing] = { ...normalizeDrawing(gp.drawings[f.drawing]) };
      fn(gp.drawings[f.drawing], l);
    }
  }
}

registerOperators([
  {
    idname: 'grease_pencil.vertex_group_normalize',
    label: 'Normalize Vertex Group',
    description: 'Scale the active group so its largest weight is 1',
    poll: pollGroups,
    exec: () => {
      const { ob, gp } = gpCtx()!;
      const g = activeGroup(ob, gp)!;
      let mx = 0;
      eachDrawing((d) => d.weights?.[g]?.forEach((x) => (mx = Math.max(mx, x))), true);
      if (mx <= 0) return 'CANCELLED';
      eachDrawing((d) => {
        if (!d.weights?.[g]) return;
        const w = ownWeights(d, g);
        for (let i = 0; i < w.length; i++) w[i] /= mx;
      }, true);
    },
  },
  {
    idname: 'grease_pencil.vertex_group_normalize_all',
    label: 'Normalize All Vertex Groups',
    description: 'Make the weights of every point add up to 1',
    props: [{ id: 'lock_active', label: 'Lock Active', type: 'bool', default: true }],
    poll: pollGroups,
    exec: (_c, p) => {
      const { ob, gp } = gpCtx()!;
      const active = activeGroup(ob, gp);
      const locked = new Set((gp.vertex_groups ?? []).filter((g) => g.lock_weight || (p.lock_active && g.name === active)).map((g) => g.name));
      eachDrawing((d) => {
        const names = Object.keys(d.weights ?? {});
        if (!names.length) return;
        const n = d.position.length / 3;
        const ws = names.map((k) => ownWeights(d, k));
        for (let i = 0; i < n; i++) {
          const fixed = names.reduce((a, k, j) => a + (locked.has(k) ? ws[j][i] : 0), 0);
          const free = names.reduce((a, k, j) => a + (locked.has(k) ? 0 : ws[j][i]), 0);
          if (free <= 0) continue;
          const f = Math.max(0, 1 - fixed) / free;
          names.forEach((k, j) => !locked.has(k) && (ws[j][i] *= f));
        }
      }, true);
    },
  },
  {
    idname: 'grease_pencil.weight_invert',
    label: 'Invert Weight',
    description: 'Invert the weights of the active group',
    poll: pollGroups,
    exec: () => {
      const { ob, gp } = gpCtx()!;
      const g = activeGroup(ob, gp)!;
      eachDrawing((d) => {
        const w = ownWeights(d, g);
        for (let i = 0; i < w.length; i++) w[i] = 1 - w[i];
      });
    },
  },
  {
    idname: 'grease_pencil.vertex_group_smooth',
    label: 'Smooth Vertex Group',
    description: 'Smooth the weights of the active group along the strokes',
    props: [
      { id: 'factor', label: 'Factor', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'repeat', label: 'Iterations', type: 'int', default: 1, min: 1, max: 100 },
    ],
    poll: pollGroups,
    exec: (_c, p) => {
      const { ob, gp } = gpCtx()!;
      const g = activeGroup(ob, gp)!;
      eachDrawing((d) => {
        if (!d.weights?.[g]) return;
        const w = ownWeights(d, g);
        for (let r = 0; r < (p.repeat as number); r++) {
          const b = w.slice();
          for (let s = 0; s + 1 < d.offsets.length; s++)
            for (let i = d.offsets[s] + 1; i < d.offsets[s + 1] - 1; i++) w[i] = b[i] + ((b[i - 1] + b[i + 1]) / 2 - b[i]) * (p.factor as number);
        }
      });
    },
  },
  {
    idname: 'grease_pencil.weight_sample',
    label: 'Weight Paint Sample Weight',
    description: 'Use the weight of the active group under the cursor as the brush weight',
    poll: () => inWeightPaint() && pollGroups(),
    undo: false,
    exec: (ctx: OpContext) => {
      const v = activeView3D();
      const { ob, gp } = gpCtx()!;
      const g = activeGroup(ob, gp)!;
      if (!v) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const x = (ctx.event?.x ?? app.pointer.x) - r.left,
        y = (ctx.event?.y ?? app.pointer.y) - r.top;
      const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
      let best = 14,
        val: number | null = null;
      const p = new Vector3();
      for (const l of gp.layers) {
        const fr = frameAt(l, app.doc.scene.frame_current);
        const d = fr ? gp.drawings[fr.drawing] : null;
        if (!d || l.hide) continue;
        const m = obWorld.clone().multiply(layerMatrix(l));
        for (let i = 0; i < d.position.length / 3; i++) {
          const s = v.project(p.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(m));
          const dd = Math.hypot(s.x - x, s.y - y);
          if (dd < best) [best, val] = [dd, d.weights?.[g]?.[i] ?? 0];
        }
      }
      if (val === null) return 'CANCELLED';
      brush(activeTools[app.doc.mode] ?? 'builtin.brush.WeightDraw').weight = val;
      app.report('INFO', `Weight: ${val.toFixed(3)}`);
      app.changed('ui');
    },
  },
  {
    idname: 'grease_pencil.weight_toggle_direction',
    label: 'Weight Paint Toggle Direction',
    description: 'Switch the Draw brush between adding and subtracting weight',
    poll: inWeightPaint,
    undo: false,
    exec: () => {
      const b = brush('builtin.brush.WeightDraw');
      b.direction = b.direction === 'SUBTRACT' ? 'ADD' : 'SUBTRACT';
      app.changed('ui');
    },
  },
]);

// ---------------------------------------------------------------------------
// object.vertex_group_* for grease pencil objects (registered by the mesh data module)

function selectedPoints(d: GPDrawing): number[] {
  const out: number[] = [];
  d.select?.forEach((s, i) => s && out.push(i));
  return out;
}

const GP_GROUP_OPS: Record<string, { poll: () => boolean; exec: (ctx: OpContext, p: Record<string, unknown>) => 'CANCELLED' | void }> = {
  'object.vertex_group_add': {
    poll: () => true,
    exec: () => {
      const { ob, gp } = gpCtx()!;
      addGroup(ob, gp);
    },
  },
  'object.vertex_group_remove': {
    poll: pollGroups,
    exec: () => {
      const { ob, gp } = gpCtx()!;
      const i = Math.max(0, ob.vertex_group_active_index ?? 0);
      const [g] = gp.vertex_groups!.splice(i, 1);
      for (let k = 0; k < gp.drawings.length; k++) {
        const d = gp.drawings[k];
        if (d.weights?.[g.name]) {
          const { [g.name]: _drop, ...rest } = d.weights;
          gp.drawings[k] = { ...d, weights: rest };
          void _drop;
        }
      }
      ob.vertex_group_active_index = Math.max(0, i - 1);
    },
  },
  'object.vertex_group_assign': {
    poll: () => inGPEdit() && pollGroups(),
    exec: (ctx) => {
      const { ob, gp } = gpCtx()!;
      const g = activeGroup(ob, gp)!;
      const wt = (ctx.doc.scene.tool_settings as { vertex_group_weight?: number }).vertex_group_weight ?? 1;
      for (const t of editTargets()) {
        const d = { ...normalizeDrawing(gp.drawings[t.idx]) };
        const sel = selectedPoints(d);
        if (!sel.length) continue;
        const w = ownWeights(d, g);
        for (const i of sel) w[i] = wt;
        gp.drawings[t.idx] = d;
      }
    },
  },
  'object.vertex_group_remove_from': {
    poll: () => inGPEdit() && pollGroups(),
    exec: () => {
      const { ob, gp } = gpCtx()!;
      const g = activeGroup(ob, gp)!;
      for (const t of editTargets()) {
        const d = { ...normalizeDrawing(gp.drawings[t.idx]) };
        const sel = selectedPoints(d);
        if (!sel.length || !d.weights?.[g]) continue;
        const w = ownWeights(d, g);
        for (const i of sel) w[i] = 0;
        gp.drawings[t.idx] = d;
      }
    },
  },
  'object.vertex_group_select': {
    poll: () => inGPEdit() && pollGroups(),
    exec: () => {
      const { ob, gp } = gpCtx()!;
      const g = activeGroup(ob, gp)!;
      for (const t of editTargets()) {
        const d = normalizeDrawing(gp.drawings[t.idx]);
        const w = d.weights?.[g];
        if (!w) continue;
        const s = d.select!.slice();
        w.forEach((x, i) => x > 0 && (s[i] = 1));
        gp.drawings[t.idx] = { ...d, select: s };
      }
    },
  },
  'object.vertex_group_deselect': {
    poll: () => inGPEdit() && pollGroups(),
    exec: () => {
      const { ob, gp } = gpCtx()!;
      const g = activeGroup(ob, gp)!;
      for (const t of editTargets()) {
        const d = normalizeDrawing(gp.drawings[t.idx]);
        const w = d.weights?.[g];
        if (!w) continue;
        const s = d.select!.slice();
        w.forEach((x, i) => x > 0 && (s[i] = 0));
        gp.drawings[t.idx] = { ...d, select: s };
      }
    },
  },
};

onAppReady(() => {
  for (const [idname, o] of Object.entries(GP_GROUP_OPS)) {
    const op = operators.get(idname) as Operator | undefined;
    if (!op) continue;
    const basePoll = op.poll,
      baseExec = op.exec;
    const isGP = () => !!gpCtx();
    op.poll = (ctx) => (isGP() ? o.poll() : !basePoll || basePoll(ctx));
    op.exec = (ctx, p) => (isGP() ? o.exec(ctx, p) : baseExec?.(ctx, p));
  }
});

// ---------------------------------------------------------------------------
// UI

function weightsMenu(): MenuItem[] {
  return [
    { label: 'Normalize All', op: 'grease_pencil.vertex_group_normalize_all' },
    { label: 'Normalize', op: 'grease_pencil.vertex_group_normalize' },
    { separator: true },
    { label: 'Invert', op: 'grease_pencil.weight_invert' },
    { label: 'Smooth', op: 'grease_pencil.vertex_group_smooth' },
    { separator: true },
    { label: 'Sample Weight', op: 'grease_pencil.weight_sample', shortcut: 'Shift X' },
    { separator: true },
    { label: 'Active Layer', submenu: activeLayerMenu, shortcut: 'Y' },
    { label: 'Animation', submenu: animationMenu, shortcut: 'I' },
    { label: 'Show/Hide', submenu: showHideMenu },
  ];
}

/** Ctrl G in Edit Mode. */
export function vertexGroupMenu(): MenuItem[] {
  return [
    { label: 'Add New Group', op: 'object.vertex_group_add' },
    { separator: true },
    { label: 'Assign to Active Group', op: 'object.vertex_group_assign' },
    { label: 'Remove from Active Group', op: 'object.vertex_group_remove_from' },
    { separator: true },
    { label: 'Select Points of Active Group', op: 'object.vertex_group_select' },
    { label: 'Deselect Points of Active Group', op: 'object.vertex_group_deselect' },
  ];
}

modeMenus.WEIGHT_GREASE_PENCIL = {
  header: () => [['Weights', weightsMenu]],
  select: () => [],
  headerExtra: placementControls,
};

for (const t of WEIGHT_TOOLS)
  toolSettingsRenderers[t.id] = () => {
    const b = brush(t.id);
    const c = gpCtx();
    return [
      c ? h('span', { class: 'th-label' }, activeGroup(c.ob, c.gp) ?? 'No vertex group (one is added when painting)') : null,
      t.id === 'builtin.brush.WeightDraw'
        ? h(
            'div',
            { style: { width: '110px', flex: 'none' } },
            numberField({ id: 'gpw-weight', label: 'Weight', value: b.weight ?? 1, min: 0, max: 1, slider: true, precision: 3, tip: 'Weight painted by the brush (Ctrl F)', set: (x) => ((b.weight = x), app.changed('ui')) }),
          )
        : null,
      h('div', { style: { width: '120px', flex: 'none' } }, sizeField(b, `gpw-size-${t.id}`, 'Radius')),
      h('div', { style: { width: '120px', flex: 'none' } }, strengthField(b, `gpw-str-${t.id}`)),
      t.id === 'builtin.brush.WeightDraw'
        ? h(
            'button',
            { class: { 'hdr-toggle': true, on: b.direction === 'SUBTRACT' }, 'data-tip': 'Subtract (D)\nThe brush removes weight', onclick: () => app.run('grease_pencil.weight_toggle_direction') },
            '−',
          )
        : null,
    ];
  };

const wp = () => inWeightPaint();
addKeys('Grease Pencil', [
  { key: 'F', op: 'grease_pencil.radial_control', props: { data: 'size' }, when: wp },
  { key: 'F', shift: true, op: 'grease_pencil.radial_control', props: { data: 'strength' }, when: wp },
  { key: 'D', op: 'grease_pencil.weight_toggle_direction', when: wp },
  { key: 'X', shift: true, op: 'grease_pencil.weight_sample', when: wp },
  { key: 'H', alt: true, op: 'grease_pencil.layer_reveal', when: wp },
  { key: 'H', op: 'grease_pencil.layer_hide', props: { unselected: false }, when: wp },
  { key: 'H', shift: true, op: 'grease_pencil.layer_hide', props: { unselected: true }, when: wp },
  { key: 'G', ctrl: true, menu: vertexGroupMenu, menuTitle: 'Vertex Groups', when: inGPEdit },
]);

// ---------------------------------------------------------------------------
// Parent ▸ With Automatic Weights / With Empty Groups for grease pencil children

/** Distance from point p to segment a-b. */
function segDist(p: Vector3, a: Vector3, b: Vector3) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(1e-12, ab.lengthSq())));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/** One vertex group per deforming bone; with `auto`, weights from the distance to the bones. */
export function armatureWeights(ob: ObjectData, arm: ObjectData, auto: boolean) {
  const gp = gpOf(app.doc, ob);
  const armData = arm.data ? app.doc.armatures[arm.data] : undefined;
  const pose = app.graph.get(arm.id)?.pose;
  if (!gp || !armData || !pose) return;
  const armWorld = app.graph.get(arm.id)!.world;
  const bones = armData.bones
    .filter((b) => b.use_deform !== false)
    .map((b) => {
      const pb = pose.bones.get(b.name);
      const m = armWorld.clone().multiply(pb?.pose ?? new Matrix4());
      return { name: b.name, head: new Vector3().applyMatrix4(m), tail: new Vector3(0, pb?.length ?? 1, 0).applyMatrix4(m) };
    });
  for (const b of bones) if (!(gp.vertex_groups ?? []).some((g) => g.name === b.name)) (gp.vertex_groups ??= []).push({ name: b.name });
  if (!auto || !bones.length) return;
  const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
  const p = new Vector3();
  const done = new Set<number>();
  for (const l of gp.layers) {
    const m = obWorld.clone().multiply(layerMatrix(l));
    for (const f of l.frames) {
      if (done.has(f.drawing) || !gp.drawings[f.drawing]) continue;
      done.add(f.drawing);
      const d = { ...normalizeDrawing(gp.drawings[f.drawing]) };
      const n = d.position.length / 3;
      const ws = bones.map((b) => ownWeights(d, b.name));
      for (let i = 0; i < n; i++) {
        p.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(m);
        const dist = bones.map((b) => segDist(p, b.head, b.tail));
        const near = Math.min(...dist);
        // the nearest bones share the point by inverse squared distance
        const inf = dist.map((x) => (x <= near * 1.5 + 1e-6 ? 1 / Math.max(1e-6, x * x) : 0));
        const sum = inf.reduce((a, x) => a + x, 0) || 1;
        ws.forEach((w, k) => (w[i] = inf[k] / sum));
      }
      gp.drawings[f.drawing] = d;
    }
  }
}

onAppReady(() => {
  const op = operators.get('object.parent_set');
  if (!op?.exec) return;
  const base = op.exec;
  op.exec = (ctx, p) => {
    const parent = app.activeObject;
    const gps = parent?.type === 'ARMATURE' && (p.type === 'ARMATURE_AUTO' || p.type === 'ARMATURE_NAME') ? app.selectedObjects().filter((o) => o !== parent && gpOf(ctx.doc, o)) : [];
    const r = base(ctx, p);
    if (r === 'CANCELLED') return r;
    for (const ob of gps) {
      if (ob.parent !== parent!.id) continue;
      armatureWeights(ob, parent!, p.type === 'ARMATURE_AUTO');
      let m = ob.modifiers.find((x) => x.type === 'GREASE_PENCIL_ARMATURE');
      if (!m) ob.modifiers.push((m = newModifier('GREASE_PENCIL_ARMATURE', uid('md'), ob.modifiers)));
      m.object = parent!.id;
    }
    return r;
  };
});
