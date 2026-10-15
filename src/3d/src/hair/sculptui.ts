// Sculpt Curves mode UI: toolbar brushes, tool settings, header (selection domain, Select and
// Curves menus, symmetry), brush cursor, pointer strokes, radial control and the keymap.
import { Vector3 } from 'three';
import { app, onAppReady, operators, registerOperator, registerOperators } from '../app/app';
import { addKeys } from '../app/keymap';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { modeMenus } from '../editors/view3d/modemenus';
import { extraToolLists, toolSettingsRenderers } from '../editors/view3d/toolbar';
import { toolHeaderRightHooks } from '../editors/view3d/tooloptions';
import { h, type Child, type VNode } from '../ui/h';
import { icon } from '../ui/icons';
import { numberField, checkbox, enumMenu } from '../ui/widgets';
import { openPopover, type MenuItem } from '../ui/menu';
import { activeHair, inSculptCurves, worldOf } from './common';
import { domainButtons } from './editmenus';
import { SCULPT_TOOLS, activeSculptTool, curvesBrush, startCurvesStroke, pixelsToWorld } from './sculpt';
import { curveCount, curveSelection, getAttr, pointSelection, rng, setAttr, setSelection } from './data';
import type { CurvesBrush } from './types';

const refresh = () => app.changed('ui');
const field = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);

// ---------------------------------------------------------------------------
// toolbar & tool settings

extraToolLists.SCULPT_CURVES = () => SCULPT_TOOLS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, description: t.description }));

/** Brush size / strength shared by both hair brush modes (radial control, [ and ]). */
export interface HairBrushAccess {
  size: number;
  strength: number;
  setSize(v: number): void;
  setStrength(v: number): void;
}
export const hairBrushAccess: (() => HairBrushAccess | null)[] = [];

hairBrushAccess.push((): HairBrushAccess | null => {
  if (!inSculptCurves()) return null;
  const b = curvesBrush(app.doc, activeSculptTool());
  return { size: b.size, strength: b.strength, setSize: (v) => (b.size = v), setStrength: (v) => (b.strength = v) };
});

function brushAccess() {
  for (const f of hairBrushAccess) {
    const r = f();
    if (r) return r;
  }
  return null;
}

function num(b: CurvesBrush, key: keyof CurvesBrush, id: string, label: string, o: { min?: number; max?: number; int?: boolean; slider?: boolean; unit?: 'distance'; tip?: string; softMax?: number } = {}) {
  return numberField({
    id,
    label,
    value: (b[key] as number) ?? 0,
    min: o.min,
    max: o.max,
    softMax: o.softMax,
    int: o.int,
    slider: o.slider,
    unit: o.unit,
    precision: o.int ? 0 : 3,
    tip: o.tip,
    set: (x) => {
      (b as unknown as Record<string, number>)[key] = o.int ? Math.round(x) : x;
      refresh();
    },
  });
}

function shapePopover(b: CurvesBrush): VNode {
  return h(
    'div',
    { class: 'popover-body hair-shape' },
    h('div', { class: 'sub-label' }, 'Interpolate'),
    checkbox('hcs-il', 'Length', !!b.use_length_interpolate, (v) => ((b.use_length_interpolate = v), refresh()), { tip: 'Take the length of new curves from their neighbours' }),
    checkbox('hcs-ir', 'Radius', !!b.use_radius_interpolate, (v) => ((b.use_radius_interpolate = v), refresh()), { tip: 'Take the radius of new curves from their neighbours' }),
    checkbox('hcs-is', 'Shape', !!b.use_shape_interpolate, (v) => ((b.use_shape_interpolate = v), refresh()), { tip: 'Bend new curves like their neighbours' }),
    checkbox('hcs-ip', 'Point Count', !!b.use_point_count_interpolate, (v) => ((b.use_point_count_interpolate = v), refresh()), { tip: 'Give new curves as many points as their neighbours' }),
    num(b, 'interpolation_neighbors', 'hcs-nb', 'Neighbors', { min: 1, max: 50, int: true, tip: 'How many nearby curves new curves are interpolated from' }),
    h('div', { class: 'sub-label' }, 'New Curves'),
    num(b, 'curve_length', 'hcs-len', 'Length', { min: 0, unit: 'distance', tip: 'Length of new curves (when not interpolated)' }),
    num(b, 'curve_radius', 'hcs-rad', 'Radius', { min: 0, unit: 'distance', tip: 'Radius of new curves (when not interpolated)' }),
    num(b, 'points_per_curve', 'hcs-pts', 'Points', { min: 2, max: 100, int: true, tip: 'Control points of new curves (when not interpolated)' }),
  );
}

function shapeButton(b: CurvesBrush) {
  return h(
    'button',
    {
      key: 'hcs-shape',
      class: 'hdr-menu',
      'data-tip': 'Shape of new curves',
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        openPopover(e.currentTarget as HTMLElement, () => shapePopover(curvesBrush(app.doc, activeSculptTool())), { width: 240 });
      },
    },
    'Curve Shape',
    icon('down_arrow_hlt', 'tiny'),
  );
}

const FALLOFFS = [
  { value: 'SMOOTH', label: 'Smooth' },
  { value: 'SPHERE', label: 'Sphere' },
  { value: 'ROOT', label: 'Root' },
  { value: 'SHARP', label: 'Sharp' },
  { value: 'LINEAR', label: 'Linear' },
  { value: 'CONSTANT', label: 'Constant' },
];

function commonFields(b: CurvesBrush, withStrength = true): Child[] {
  return [
    field(110, num(b, 'size', 'hcs-size', 'Radius', { min: 1, max: 2000, softMax: 500, int: true, tip: 'Brush radius in pixels (F)' })),
    withStrength ? field(120, num(b, 'strength', 'hcs-str', 'Strength', { min: 0, max: 1, slider: true, tip: 'Brush strength (Shift F)' })) : null,
    field(110, enumMenu('hcs-falloff', FALLOFFS, b.falloff, (v) => ((b.falloff = v as CurvesBrush['falloff']), refresh()), { tip: 'Falloff: how the effect fades toward the brush rim' })),
  ];
}

function settingsFor(tool: string): Child {
  if (!inSculptCurves()) return null;
  const b = curvesBrush(app.doc, tool);
  switch (tool) {
    case 'builtin_brush.Add':
      return [field(110, num(b, 'size', 'hcs-size', 'Radius', { min: 1, max: 2000, int: true, tip: 'Brush radius in pixels (F)' })), field(100, num(b, 'add_amount', 'hcs-count', 'Count', { min: 1, max: 10000, int: true, tip: 'Curves added per step of the stroke' })), shapeButton(b)];
    case 'builtin_brush.Delete':
      return [field(110, num(b, 'size', 'hcs-size', 'Radius', { min: 1, max: 2000, int: true, tip: 'Brush radius in pixels (F)' }))];
    case 'builtin_brush.Density':
      return [
        field(110, num(b, 'size', 'hcs-size', 'Radius', { min: 1, max: 2000, int: true, tip: 'Brush radius in pixels (F)' })),
        field(
          110,
          enumMenu(
            'hcs-dmode',
            [
              { value: 'AUTO', label: 'Auto', description: 'Add or remove depending on the spacing of the curves under the brush' },
              { value: 'ADD', label: 'Add', description: 'Only add curves' },
              { value: 'REMOVE', label: 'Remove', description: 'Only remove curves' },
            ],
            b.density_mode ?? 'AUTO',
            (v) => ((b.density_mode = v as CurvesBrush['density_mode']), refresh()),
            { tip: 'Density mode (Ctrl inverts)' },
          ),
        ),
        field(130, num(b, 'minimum_distance', 'hcs-mind', 'Distance Min', { min: 0, unit: 'distance', tip: 'Smallest distance between curve roots (R to edit in the viewport)' })),
        field(110, num(b, 'density_add_attempts', 'hcs-att', 'Count Max', { min: 1, max: 10000, int: true, tip: 'Attempts to place a new curve per step' })),
        shapeButton(b),
      ];
    case 'builtin_brush.Grow/Shrink':
      return [...commonFields(b), checkbox('hcs-uni', 'Scale Uniform', !!b.use_uniform_scale, (v) => ((b.use_uniform_scale = v), refresh()), { tip: 'Scale the whole curve instead of extending or trimming its tip' }), field(130, num(b, 'minimum_length', 'hcs-minl', 'Length Min', { min: 0, unit: 'distance', tip: 'Curves are not shrunk below this length' }))];
    case 'builtin_brush.Selection Paint':
      return [...commonFields(b), field(110, num(b, 'selection_value', 'hcs-selv', 'Value', { min: 0, max: 1, slider: true, tip: 'Selection painted (Ctrl paints 0)' }))];
    default:
      return commonFields(b);
  }
}

for (const t of SCULPT_TOOLS) toolSettingsRenderers[t.id] = () => settingsFor(t.id);

// symmetry and collision at the right of the tool settings row
toolHeaderRightHooks.push(() => {
  if (!inSculptCurves()) return null;
  const { hc } = activeHair()!;
  const keys = ['use_mirror_x', 'use_mirror_y', 'use_mirror_z'] as const;
  return h(
    'div',
    { key: 'hc-symmetry', class: 'hdr-group mesh-symmetry', 'data-tip': 'Symmetry: brushes also act mirrored across the local axes' },
    icon('mod_mirror'),
    keys.map((k, i) =>
      h(
        'button',
        {
          key: k,
          class: { 'hdr-toggle': true, on: !!hc[k] },
          'data-tip': `Mirror brushes across the local ${'XYZ'[i]} axis`,
          onclick: () => {
            hc[k] = !hc[k];
            app.pushUndo('Symmetry');
            refresh();
          },
        },
        'XYZ'[i],
      ),
    ),
    h(
      'button',
      {
        key: 'collide',
        class: { 'hdr-toggle': true, on: hc.use_sculpt_collision },
        'data-tip': 'Surface Collision\nKeep sculpted curves outside the surface',
        onclick: () => {
          hc.use_sculpt_collision = !hc.use_sculpt_collision;
          app.pushUndo('Surface Collision');
          refresh();
        },
      },
      icon('mod_physics'),
    ),
  );
});

// ---------------------------------------------------------------------------
// header menus

function selectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'curves.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'curves.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'curves.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Random', op: 'sculpt_curves.select_random' },
    { separator: true },
    { label: 'Endpoints', op: 'curves.select_ends' },
    { label: 'Grow Selection', op: 'sculpt_curves.select_grow', shortcut: 'Shift A' },
  ];
}

export function sculptCurvesMenu(): MenuItem[] {
  return [
    { label: 'Snap to Deformed Surface', op: 'curves.snap_curves_to_surface', props: { attach_mode: 'DEFORM' } },
    { label: 'Snap to Nearest Surface', op: 'curves.snap_curves_to_surface', props: { attach_mode: 'NEAREST' } },
    { separator: true },
    { label: 'Convert to Particle System', op: 'curves.convert_to_particle_system' },
  ];
}

modeMenus.SCULPT_CURVES = {
  headerLead: domainButtons,
  select: selectMenu,
  header: () => [['Curves', sculptCurvesMenu]],
};

// ---------------------------------------------------------------------------
// selection operators of the mode

registerOperators([
  {
    idname: 'sculpt_curves.select_random',
    label: 'Select Random',
    description: 'Randomize the selection of points or curves',
    props: [
      { id: 'seed', label: 'Seed', type: 'int', default: 0, min: 0 },
      { id: 'partial', label: 'Partial', type: 'bool', default: false },
      { id: 'probability', label: 'Probability', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor', showIf: (p) => !p.partial },
      { id: 'min', label: 'Min', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor', showIf: (p) => !!p.partial },
      { id: 'constant_per_curve', label: 'Constant per Curve', type: 'bool', default: true },
    ],
    poll: inSculptCurves,
    exec: (_c, p) => {
      const { hc } = activeHair()!;
      const r = rng((p.seed as number) + 7);
      const cur = hc.selection_domain === 'CURVE' ? curveSelection(hc) : pointSelection(hc);
      const out = new Float32Array(cur.length);
      const perCurve = hc.selection_domain === 'POINT' && !!p.constant_per_curve;
      const o = hc.curve_offsets;
      const value = () => (p.partial ? (p.min as number) + r() * (1 - (p.min as number)) : r() < (p.probability as number) ? 1 : 0);
      if (perCurve)
        for (let c = 0; c + 1 < o.length; c++) {
          const v = value();
          for (let i = o[c]; i < o[c + 1]; i++) out[i] = cur[i] * v;
        }
      else for (let i = 0; i < out.length; i++) out[i] = cur[i] * value();
      setSelection(hc, out);
    },
  },
  {
    idname: 'sculpt_curves.select_grow',
    label: 'Select Grow',
    description: 'Grow (drag right) or shrink (drag left) the selection by distance',
    props: [{ id: 'distance', label: 'Distance', type: 'float', default: 0.1, subtype: 'distance' }],
    poll: inSculptCurves,
    invoke: (ctx, p) => {
      const { hc } = activeHair()!;
      const start = ctx.event ?? { ...app.pointer };
      const before = getAttr(hc, '.selection');
      const orig = before ? { ...before, data: before.data.slice() } : null;
      const apply = (d: number) => {
        if (orig) setAttr(hcRef(), '.selection', orig.domain, 'FLOAT', orig.data as Float32Array);
        else hcRef().attributes = hcRef().attributes.filter((a) => a.name !== '.selection');
        growByDistance(hcRef(), d);
        app.changed('doc');
      };
      const hcRef = () => activeHair()!.hc;
      let dist = 0;
      app.startModal({
        label: 'Select Grow',
        onPointerMove: (e) => {
          const v = activeView3D();
          const ob = activeHair()!.ob;
          const scale = v ? pixelsToWorld(v, new Vector3().setFromMatrixPosition(worldOf(ob)), 1) : 0.01;
          dist = (e.clientX - start.x) * scale;
          apply(dist);
        },
        onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : 'CANCELLED'),
        onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
        cancel: () => apply(0),
        header: () => `Distance: ${dist.toFixed(3)}`,
        redoOp: { idname: 'sculpt_curves.select_grow', props: p },
        finish: () => (p.distance = dist),
      });
      return 'RUNNING_MODAL';
    },
    exec: (_c, p) => {
      growByDistance(activeHair()!.hc, p.distance as number);
    },
  },
  {
    idname: 'sculpt_curves.min_distance_edit',
    label: 'Edit Minimum Distance',
    description: 'Change the minimum distance of the Density brush interactively',
    poll: () => inSculptCurves() && activeSculptTool() === 'builtin_brush.Density',
    invoke: (ctx) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const b = curvesBrush(app.doc, 'builtin_brush.Density');
      const startDist = b.minimum_distance ?? 0.05;
      const start = ctx.event ?? { ...app.pointer };
      const r = v.el.getBoundingClientRect();
      minDistPreview = { x: start.x - r.left, y: start.y - r.top, view: v };
      const ob = activeHair()!.ob;
      const center = new Vector3().setFromMatrixPosition(worldOf(ob));
      const scale = pixelsToWorld(v, center, 1);
      app.startModal({
        label: 'Edit Minimum Distance',
        onPointerMove: (e) => {
          b.minimum_distance = Math.max(1e-4, startDist + (e.clientX - start.x) * scale * 0.5);
          v.drawSvg();
          refresh();
        },
        onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : 'CANCELLED'),
        onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
        cancel: () => {
          b.minimum_distance = startDist;
          minDistPreview = null;
          v.drawSvg();
        },
        finish: () => {
          minDistPreview = null;
          v.drawSvg();
        },
        header: () => `Minimum Distance: ${(b.minimum_distance ?? 0).toFixed(4)}`,
      });
      return 'RUNNING_MODAL';
    },
    undo: false,
  },
  {
    idname: 'sculpt_curves.brush_stroke',
    label: 'Stroke Curves Sculpt',
    description: 'Sculpt curves with the active brush (drag in the viewport)',
    props: [{ id: 'mode', label: 'Stroke Mode', type: 'enum', default: 'NORMAL', items: [['NORMAL', 'Regular'], ['INVERT', 'Invert'], ['SMOOTH', 'Smooth']] }],
    poll: inSculptCurves,
    internal: true,
    invoke: () => 'CANCELLED',
  },
]);

let minDistPreview: { x: number; y: number; view: View3D } | null = null;

/** Grow the selection to curves whose roots lie within `d` of a selected root (shrink for negative `d`). */
export function growByDistance(hc: import('./types').HairCurvesData, d: number) {
  if (!d) return;
  const cs = curveSelection(hc);
  const o = hc.curve_offsets;
  const nc = curveCount(hc);
  const P = hc.positions;
  const out = cs.slice();
  const dist2 = d * d;
  for (let c = 0; c < nc; c++) {
    if (d > 0 ? cs[c] > 0 : !(cs[c] > 0)) continue;
    for (let k = 0; k < nc; k++) {
      if (d > 0 ? !(cs[k] > 0) : cs[k] > 0) continue;
      const a = o[c] * 3,
        b = o[k] * 3;
      if ((P[a] - P[b]) ** 2 + (P[a + 1] - P[b + 1]) ** 2 + (P[a + 2] - P[b + 2]) ** 2 <= dist2) {
        out[c] = d > 0 ? 1 : 0;
        break;
      }
    }
  }
  if (hc.selection_domain === 'CURVE') setSelection(hc, out, 'CURVE');
  else {
    const pts = new Float32Array(P.length / 3);
    for (let c = 0; c < nc; c++) pts.fill(out[c], o[c], o[c + 1]);
    setSelection(hc, pts, 'POINT');
  }
}

// ---------------------------------------------------------------------------
// pointer: strokes and the brush cursor

const cursor = { x: 0, y: 0, inside: false, view: null as View3D | null };

editModeHooks.pointer.unshift((v, e) => {
  if (!inSculptCurves() || e.button !== 0 || e.altKey) return false;
  const tool = e.shiftKey ? 'builtin_brush.Smooth' : activeSculptTool();
  startCurvesStroke(v, e, { tool, invert: e.ctrlKey || e.metaKey });
  return true;
});

editModeHooks.hover.push((v, e) => {
  if (!inSculptCurves()) return;
  const p = v.local(e);
  cursor.x = p.x;
  cursor.y = p.y;
  cursor.inside = true;
  cursor.view = v;
  v.drawSvg();
});

editModeHooks.svg.push((v) => {
  if (!inSculptCurves()) return null;
  const parts: VNode[] = [];
  if (minDistPreview && minDistPreview.view === v) {
    const a = activeHair();
    const b = curvesBrush(app.doc, 'builtin_brush.Density');
    if (a) {
      const center = new Vector3().setFromMatrixPosition(worldOf(a.ob));
      const r = (b.minimum_distance ?? 0.05) / Math.max(1e-9, pixelsToWorld(v, center, 1));
      for (let i = -2; i <= 2; i++)
        for (let j = -2; j <= 2; j++) parts.push(h('circle', { cx: minDistPreview.x + i * r, cy: minDistPreview.y + j * r, r: 2, fill: '#fff' }) as VNode);
    }
  }
  if (cursor.inside && cursor.view === v) {
    const b = curvesBrush(app.doc, activeSculptTool());
    parts.push(
      h('circle', { cx: cursor.x, cy: cursor.y, r: b.size, fill: 'none', stroke: 'rgba(0,0,0,0.35)', 'stroke-width': 3 }) as VNode,
      h('circle', { cx: cursor.x, cy: cursor.y, r: b.size, fill: 'none', stroke: 'rgba(255,255,255,0.9)', 'stroke-width': 1.3 }) as VNode,
    );
  }
  return parts.length ? h('g', { class: 'hair-cursor', 'pointer-events': 'none' }, parts) : null;
});

// ---------------------------------------------------------------------------
// radial control (F / Shift F) and brush size steps ([ ]) for the hair brush modes

const radial = { active: false, cx: 0, cy: 0, value: 0, data: 'size' as 'size' | 'strength', view: null as View3D | null };
const FULL = 200;

editModeHooks.svg.push((v) => {
  if (!radial.active || radial.view !== v) return null;
  const r = radial.data === 'size' ? radial.value : radial.value * FULL;
  return h(
    'g',
    { class: 'hair-radial', 'pointer-events': 'none' },
    h('circle', { cx: radial.cx, cy: radial.cy, r: Math.max(1, r), fill: 'rgba(255,255,255,0.08)', stroke: '#fff', 'stroke-width': 1.5 }),
    h('text', { x: radial.cx, y: radial.cy + 4, 'text-anchor': 'middle', fill: '#fff', 'font-size': 12, style: 'paint-order:stroke;stroke:#000;stroke-width:3px' }, radial.data === 'size' ? `${Math.round(radial.value)} px` : radial.value.toFixed(3)),
  );
});

onAppReady(() => {
  const prevRadial = operators.get('wm.radial_control');
  registerOperator({
    ...(prevRadial ?? { idname: 'wm.radial_control', label: 'Radial Control' }),
    poll: (ctx) => !!brushAccess() || (!!prevRadial && (!prevRadial.poll || prevRadial.poll(ctx))),
    invoke: (ctx, p) => {
      const acc = brushAccess();
      if (!acc) return prevRadial?.invoke ? prevRadial.invoke(ctx, p) : 'CANCELLED';
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const data = p.data === 'strength' ? 'strength' : 'size';
      const start = data === 'size' ? acc.size : acc.strength;
      const m = v.local({ clientX: ctx.event?.x ?? app.pointer.x, clientY: ctx.event?.y ?? app.pointer.y });
      Object.assign(radial, { active: true, data, view: v, value: start, cx: m.x - (data === 'size' ? start : start * FULL), cy: m.y });
      v.drawSvg();
      const set = (val: number) => {
        const a = brushAccess();
        if (!a) return;
        if (data === 'size') a.setSize(Math.max(1, Math.min(2000, Math.round(val))));
        else a.setStrength(Math.max(0, Math.min(1, val)));
      };
      app.startModal({
        label: 'Radial Control',
        onPointerMove: (e) => {
          const q = v.local(e);
          const d = Math.hypot(q.x - radial.cx, q.y - radial.cy);
          radial.value = data === 'size' ? Math.max(1, d) : Math.min(1, d / FULL);
          set(radial.value);
          v.drawSvg();
          refresh();
        },
        onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : 'CANCELLED'),
        onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' || e.key === ' ' ? 'FINISHED' : true),
        cancel: () => {
          set(start);
          radial.active = false;
          v.drawSvg();
        },
        finish: () => {
          radial.active = false;
          v.drawSvg();
        },
        header: () => `${data === 'size' ? 'Radius' : 'Strength'}: ${data === 'size' ? Math.round(radial.value) : radial.value.toFixed(3)}`,
      });
      return 'RUNNING_MODAL';
    },
  });
  const prevScale = operators.get('brush.scale_size');
  registerOperator({
    ...(prevScale ?? { idname: 'brush.scale_size', label: 'Scale Sculpt/Paint Brush Size', props: [{ id: 'scalar', label: 'Scalar', type: 'float', default: 1 }] }),
    undo: false,
    poll: (ctx) => !!brushAccess() || (!!prevScale && (!prevScale.poll || prevScale.poll(ctx))),
    exec: (ctx, p) => {
      const acc = brushAccess();
      if (!acc) return prevScale?.exec ? prevScale.exec(ctx, p) : 'CANCELLED';
      const s = p.scalar as number;
      let r = acc.size * s;
      if (Math.round(r) === Math.round(acc.size)) r = acc.size + (s > 1 ? 1 : -1);
      acc.setSize(Math.max(1, Math.min(2000, Math.round(r))));
      refresh();
    },
  });
});

// ---------------------------------------------------------------------------
// keymap

const s = inSculptCurves;
addKeys('Sculpt Curves', [
  { key: 'ONE', op: 'curves.set_selection_domain', props: { domain: 'POINT' }, when: s },
  { key: 'TWO', op: 'curves.set_selection_domain', props: { domain: 'CURVE' }, when: s },
  { key: 'F', op: 'wm.radial_control', props: { data: 'size' }, when: s },
  { key: 'F', shift: true, op: 'wm.radial_control', props: { data: 'strength' }, when: s },
  { key: 'LEFT_BRACKET', op: 'brush.scale_size', props: { scalar: 0.9 }, when: s },
  { key: 'RIGHT_BRACKET', op: 'brush.scale_size', props: { scalar: 1 / 0.9 }, when: s },
  { key: 'A', op: 'curves.select_all', props: { action: 'SELECT' }, when: s },
  { key: 'A', alt: true, op: 'curves.select_all', props: { action: 'DESELECT' }, when: s },
  { key: 'I', ctrl: true, op: 'curves.select_all', props: { action: 'INVERT' }, when: s },
  { key: 'R', op: 'sculpt_curves.min_distance_edit', when: () => s() && activeSculptTool() === 'builtin_brush.Density' },
  { key: 'A', shift: true, op: 'sculpt_curves.select_grow', when: s },
]);

