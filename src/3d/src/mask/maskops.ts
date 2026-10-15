// Mask operators (clip editor in mask mode) and the Mask Editing keymap.
import { app, registerOperators, onAppReady, type Operator, type ModalHandler } from '../app/app';
import { addKeys } from '../app/keymap';
import { uid } from '../data/defaults';
import type { MaskData, MaskHandleType, MaskLayer, MaskPoint, MaskSpline } from './types';
import { maskTable, newMask, newLayer, activeLayer } from './types';
import { recalcHandles, switchDirection, makeConsistent, circleSpline, squareSpline, insertShapeKey, keyedData, applyData } from './geom';
import { hostMask, selectedPoints, allPoints, deselectAll, aspectOf, m2s, s2m, selectWhere, updateHandles, type MaskHost } from './clipmask';
import { currentClipEditor } from '../tracking/editor';
import { activeTrack, markerAt, sceneToClipFrame } from '../tracking/types';
import { parentResolver } from './parent';
import { pointInPolygon } from '../sequencer/selection';

type V = [number, number];

/** The hovered clip editor when it edits a mask. */
export function maskEditor(): (MaskHost & { mode: string; view: string; area: { drawHeader(): void } }) | null {
  const ed = currentClipEditor() as unknown as (MaskHost & { mode: string; view: string; area: { drawHeader(): void } }) | null;
  return ed && ed.mode === 'MASK' && ed.view === 'CLIP' ? ed : null;
}
const editing = () => !!maskEditor() && !!hostMask(maskEditor()!);
const curMask = () => hostMask(maskEditor()!)!;
const anySel = () => editing() && selectedPoints(curMask()).length > 0;

function done(ed = maskEditor()) {
  if (!ed) return;
  updateHandles(hostMask(ed)!, aspectOf(ed));
  app.changed('doc');
  ed.draw();
  ed.drawUI();
}

/** Splines with selected points (per layer). */
function selectedSplines(m: MaskData): { layer: MaskLayer; spline: MaskSpline }[] {
  const out: { layer: MaskLayer; spline: MaskSpline }[] = [];
  for (const layer of m.layers) if (!layer.hide && !layer.hide_select) for (const spline of layer.splines) if (spline.points.some((p) => p.select && !p.hide)) out.push({ layer, spline });
  return out;
}

let clipboard: MaskSpline[] | null = null;

const SELECT_MODES: [string, string][] = [
  ['SET', 'Set'],
  ['ADD', 'Extend'],
  ['SUB', 'Subtract'],
];

const ops: Operator[] = [
  {
    idname: 'mask.new',
    label: 'New Mask',
    description: 'Create a new mask and edit it in the clip editor',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'Mask' }],
    poll: () => !!currentClipEditor(),
    exec: (_c, p) => {
      const ed = currentClipEditor() as unknown as MaskHost & { mode: string };
      const id = uid('MA');
      const names = new Set(Object.values(maskTable(app.doc)).map((m) => m.name));
      let name = (p.name as string) || 'Mask';
      for (let i = 1; names.has(name); i++) name = `${p.name || 'Mask'}.${String(i).padStart(3, '0')}`;
      const m = newMask(id, name);
      const sc = app.doc.scene;
      m.frame_start = sc.frame_start;
      m.frame_end = sc.frame_end;
      maskTable(app.doc)[id] = m;
      ed.maskId = id;
      ed.mode = 'MASK';
      ed.draw();
      ed.drawUI();
    },
  },
  {
    idname: 'mask.layer_new',
    label: 'Add Mask Layer',
    description: 'Add a new layer to the mask',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: editing,
    exec: (_c, p) => {
      const m = curMask();
      const names = new Set(m.layers.map((l) => l.name));
      let name = (p.name as string) || 'MaskLayer';
      for (let i = 1; names.has(name); i++) name = `${(p.name as string) || 'MaskLayer'}.${String(i).padStart(3, '0')}`;
      m.layers.push(newLayer(name));
      m.active_layer_index = m.layers.length - 1;
      done();
    },
  },
  {
    idname: 'mask.layer_remove',
    label: 'Remove Mask Layer',
    description: 'Remove the active mask layer',
    poll: () => editing() && !!activeLayer(curMask()),
    exec: () => {
      const m = curMask();
      m.layers.splice(m.active_layer_index, 1);
      m.active_layer_index = Math.max(0, Math.min(m.active_layer_index, m.layers.length - 1));
      done();
    },
  },
  {
    idname: 'mask.layer_move',
    label: 'Move Mask Layer',
    description: 'Move the active mask layer up or down in the stack',
    props: [
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'UP',
        items: [
          ['UP', 'Up'],
          ['DOWN', 'Down'],
        ],
      },
    ],
    poll: () => editing() && curMask().layers.length > 1,
    exec: (_c, p) => {
      const m = curMask();
      const i = m.active_layer_index;
      const j = p.direction === 'UP' ? i - 1 : i + 1;
      if (j < 0 || j >= m.layers.length) return 'CANCELLED';
      [m.layers[i], m.layers[j]] = [m.layers[j], m.layers[i]];
      m.active_layer_index = j;
      done();
    },
  },
  // ------------------------------------------------------------------ selection
  {
    idname: 'mask.select_all',
    label: '(De)select All',
    description: 'Change the selection of all mask points',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['TOGGLE', 'Toggle'],
          ['SELECT', 'Select'],
          ['DESELECT', 'Deselect'],
          ['INVERT', 'Invert'],
        ],
      },
    ],
    poll: editing,
    exec: (_c, p) => {
      const pts = allPoints(curMask());
      let a = p.action as string;
      if (a === 'TOGGLE') a = pts.some((x) => x.point.select) ? 'DESELECT' : 'SELECT';
      for (const { point } of pts) {
        point.select = a === 'SELECT' ? true : a === 'DESELECT' ? false : !point.select;
        if (!point.select) point.select_left_handle = point.select_right_handle = false;
      }
      done();
    },
  },
  {
    idname: 'mask.select_linked',
    label: 'Select Linked All',
    description: 'Select all points of the splines that have a selected point',
    poll: anySel,
    exec: () => {
      for (const { spline } of selectedSplines(curMask())) for (const p of spline.points) p.select = true;
      done();
    },
  },
  {
    idname: 'mask.select_linked_pick',
    label: 'Select Linked',
    description: 'Select (or with Shift deselect) the spline under the pointer',
    props: [{ id: 'deselect', label: 'Deselect', type: 'bool', default: false }],
    poll: editing,
    exec: (_c, p) => {
      const ed = maskEditor()!;
      const m = curMask();
      const q = ed.local({ clientX: app.pointer.x, clientY: app.pointer.y });
      let best: MaskSpline | null = null,
        bd = 12;
      for (const { spline, point } of allPoints(m)) {
        const [x, y] = m2s(ed, point.co);
        const d = Math.hypot(x - q.x, y - q.y);
        if (d < bd) {
          bd = d;
          best = spline;
        }
      }
      if (!best) return 'CANCELLED';
      for (const pt of best.points) pt.select = !p.deselect;
      done();
    },
  },
  {
    idname: 'mask.select_more',
    label: 'Select More',
    description: 'Select the neighbours of selected points along their splines',
    poll: anySel,
    exec: () => moreLess(true),
  },
  {
    idname: 'mask.select_less',
    label: 'Select Less',
    description: 'Deselect points at the ends of selected runs along their splines',
    poll: anySel,
    exec: () => moreLess(false),
  },
  {
    idname: 'mask.select_box',
    label: 'Box Select',
    description: 'Select mask points with a box drawn by dragging',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'SET', items: SELECT_MODES }],
    poll: editing,
    undo: false,
    invoke: (_c, p) => (startShape('box', p.mode as 'SET'), 'CANCELLED'),
  },
  {
    idname: 'mask.select_lasso',
    label: 'Lasso Select',
    description: 'Select mask points inside a freehand shape',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'SET', items: SELECT_MODES }],
    poll: editing,
    undo: false,
    invoke: (_c, p) => (startShape('lasso', p.mode as 'SET'), 'CANCELLED'),
  },
  {
    idname: 'mask.select_circle',
    label: 'Circle Select',
    description: 'Select mask points by painting over them with a circle',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'ADD', items: SELECT_MODES }],
    poll: editing,
    undo: false,
    invoke: (_c, p) => (startCircle(p.mode as 'ADD'), 'RUNNING_MODAL'),
  },
  // ------------------------------------------------------------------ editing
  {
    idname: 'mask.delete',
    label: 'Delete',
    description: 'Delete the selected mask points (splines left without points go too)',
    poll: anySel,
    exec: () => {
      const m = curMask();
      for (const layer of m.layers) {
        for (const sp of layer.splines) sp.points = sp.points.filter((p) => !p.select || p.hide);
        layer.splines = layer.splines.filter((s) => s.points.length > 0);
        if (layer.active_spline >= layer.splines.length) layer.active_spline = layer.splines.length - 1;
        // keys no longer match the points
        layer.shape_keys = [];
      }
      done();
    },
  },
  {
    idname: 'mask.cyclic_toggle',
    label: 'Toggle Cyclic',
    description: 'Open or close the selected splines',
    poll: anySel,
    exec: () => {
      for (const { spline } of selectedSplines(curMask())) spline.use_cyclic = !spline.use_cyclic;
      done();
    },
  },
  {
    idname: 'mask.switch_direction',
    label: 'Switch Direction',
    description: 'Reverse the direction of the selected splines',
    poll: anySel,
    exec: () => {
      for (const { spline } of selectedSplines(curMask())) switchDirection(spline);
      done();
    },
  },
  {
    idname: 'mask.normals_make_consistent',
    label: 'Recalculate Handles',
    description: 'Orient the selected closed splines consistently so feathers point outward',
    poll: anySel,
    exec: () => {
      const a = aspectOf(maskEditor()!);
      for (const { spline } of selectedSplines(curMask())) makeConsistent(spline, a);
      done();
    },
  },
  {
    idname: 'mask.handle_type_set',
    label: 'Set Handle Type',
    description: 'Set the handle type of the selected points',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'AUTO',
        items: [
          ['AUTO', 'Auto'],
          ['VECTOR', 'Vector'],
          ['ALIGNED', 'Aligned'],
          ['FREE', 'Free'],
        ],
      },
    ],
    poll: anySel,
    exec: (_c, p) => {
      for (const { point } of selectedPoints(curMask())) point.handle_type = p.type as MaskHandleType;
      done();
    },
  },
  {
    idname: 'mask.hide_view_set',
    label: 'Hide',
    description: 'Hide the selected (or unselected) mask points',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: editing,
    exec: (_c, p) => {
      for (const { point } of allPoints(curMask()))
        if (point.select !== !!p.unselected) {
          point.hide = true;
          point.select = false;
        }
      done();
    },
  },
  {
    idname: 'mask.hide_view_clear',
    label: 'Reveal',
    description: 'Show hidden mask points (selected)',
    poll: editing,
    exec: () => {
      for (const l of curMask().layers)
        for (const s of l.splines)
          for (const p of s.points)
            if (p.hide) {
              p.hide = false;
              p.select = true;
            }
      done();
    },
  },
  {
    idname: 'mask.copy_splines',
    label: 'Copy Splines',
    description: 'Copy the selected splines to the internal clipboard',
    undo: false,
    poll: anySel,
    exec: () => {
      clipboard = selectedSplines(curMask()).map((x) => structuredClone(x.spline));
      app.report('INFO', `Copied ${clipboard.length} spline${clipboard.length === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'mask.paste_splines',
    label: 'Paste Splines',
    description: 'Paste splines from the internal clipboard into the active layer',
    poll: () => editing() && !!clipboard?.length && !!activeLayer(curMask()),
    exec: () => {
      const m = curMask();
      const layer = activeLayer(m)!;
      deselectAll(m);
      for (const s of clipboard!) {
        const c = structuredClone(s);
        for (const p of c.points) p.select = true;
        layer.splines.push(c);
      }
      layer.shape_keys = [];
      layer.active_spline = layer.splines.length - 1;
      done();
    },
  },
  {
    idname: 'mask.duplicate',
    label: 'Duplicate Mask',
    description: 'Duplicate the selected splines',
    poll: anySel,
    exec: () => {
      const m = curMask();
      const sel = selectedSplines(m);
      deselectAll(m);
      for (const { layer, spline } of sel) {
        const c = structuredClone(spline);
        for (const p of c.points) p.select = true;
        layer.splines.push(c);
        layer.shape_keys = [];
      }
      done();
    },
  },
  {
    idname: 'mask.duplicate_move',
    label: 'Duplicate Mask',
    description: 'Duplicate the selected splines and move them',
    poll: anySel,
    invoke: () => {
      app.run('mask.duplicate', {}, { invoke: false });
      return startTransform('TRANSLATE') ? 'RUNNING_MODAL' : 'CANCELLED';
    },
  },
  {
    idname: 'mask.feather_weight_clear',
    label: 'Clear Feather Weight',
    description: 'Remove the feather of the selected points',
    poll: anySel,
    exec: () => {
      for (const { point } of selectedPoints(curMask())) point.weight = 0;
      done();
    },
  },
  {
    idname: 'mask.primitive_circle_add',
    label: 'Add Circle',
    description: 'Add a closed circular spline to the active layer',
    props: [
      { id: 'size', label: 'Size', type: 'float', default: 0.2, min: 0.001, precision: 3 },
      { id: 'location', label: 'Location', type: 'vec2', default: [0.5, 0.5], precision: 3 },
    ],
    poll: () => editing() && !!activeLayer(curMask()),
    exec: (_c, p) => addPrimitive((x, y, r, a) => circleSpline(x, y, r, a), p),
  },
  {
    idname: 'mask.primitive_square_add',
    label: 'Add Square',
    description: 'Add a closed square spline to the active layer',
    props: [
      { id: 'size', label: 'Size', type: 'float', default: 0.2, min: 0.001, precision: 3 },
      { id: 'location', label: 'Location', type: 'vec2', default: [0.5, 0.5], precision: 3 },
    ],
    poll: () => editing() && !!activeLayer(curMask()),
    exec: (_c, p) => addPrimitive((x, y, r, a) => squareSpline(x, y, r, a), p),
  },
  // ------------------------------------------------------------------ parenting
  {
    idname: 'mask.parent_set',
    label: 'Make Parent',
    description: 'Make the selected points follow the active track of the clip',
    poll: () => {
      if (!anySel()) return false;
      const c = currentClipEditor()?.clip;
      return !!c && !!activeTrack(c);
    },
    exec: (ctx) => {
      const ed = currentClipEditor()!;
      const c = ed.clip!;
      const t = activeTrack(c)!;
      const f = sceneToClipFrame(c, ctx.doc.scene.frame_current);
      const mk = markerAt(t, f);
      if (!mk) {
        app.report('ERROR', 'The active track has no marker at this frame');
        return 'CANCELLED';
      }
      const res = parentResolver(ctx.doc);
      for (const { point } of selectedPoints(curMask())) {
        bakeParent(point, res, ctx.doc.scene.frame_current);
        point.parent = { clip: c.id, track: t.name, frame: f, co: [mk.co[0], mk.co[1]] };
      }
      done();
    },
  },
  {
    idname: 'mask.parent_clear',
    label: 'Clear Parent',
    description: 'Stop the selected points following a track (they stay where they are now)',
    poll: () => anySel() && selectedPoints(curMask()).some((x) => !!x.point.parent),
    exec: (ctx) => {
      const res = parentResolver(ctx.doc);
      for (const { point } of selectedPoints(curMask())) {
        bakeParent(point, res, ctx.doc.scene.frame_current);
        delete point.parent;
      }
      done();
    },
  },
  // ------------------------------------------------------------------ animation
  {
    idname: 'mask.shape_key_insert',
    label: 'Insert Shape Key',
    description: 'Key the point positions of the active (or all visible) layers at the current frame',
    poll: () => editing() && curMask().layers.some((l) => l.splines.length),
    exec: (c) => {
      const m = curMask();
      for (const l of m.layers) if (!l.hide && l.splines.length) insertShapeKey(l, c.doc.scene.frame_current);
      done();
    },
  },
  {
    idname: 'mask.shape_key_clear',
    label: 'Clear Shape Key',
    description: 'Remove the shape key at the current frame',
    poll: () => editing() && curMask().layers.some((l) => l.shape_keys.length),
    exec: (c) => {
      const f = c.doc.scene.frame_current;
      let n = 0;
      for (const l of curMask().layers) {
        const before = l.shape_keys.length;
        l.shape_keys = l.shape_keys.filter((k) => k.frame !== f);
        n += before - l.shape_keys.length;
      }
      if (!n) return 'CANCELLED';
      done();
    },
  },
  // ------------------------------------------------------------------ transform
  {
    idname: 'mask.transform',
    label: 'Transform Mask Points',
    description: 'Move, rotate or scale the selected points, or scale their feather',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'TRANSLATE',
        items: [
          ['TRANSLATE', 'Move'],
          ['ROTATE', 'Rotate'],
          ['RESIZE', 'Scale'],
          ['FEATHER', 'Feather Width'],
        ],
        hidden: true,
      },
      { id: 'value', label: 'Value', type: 'vec3', default: [0, 0, 0], precision: 4 },
    ],
    poll: anySel,
    invoke: (_c, p) => (startTransform(p.mode as Mode) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (_c, p) => {
      const ed = maskEditor();
      const m = ed ? hostMask(ed) : null;
      if (!ed || !m) return 'CANCELLED';
      const pts = selectedPoints(m).map((x) => x.point);
      if (!pts.length) return 'CANCELLED';
      const v = (p.value as number[]) ?? [0, 0, 0];
      const mode = p.mode as Mode;
      const value = mode === 'RESIZE' ? [v[0] || 1, v[1] || v[0] || 1] : mode === 'FEATHER' ? [v[0] || 1] : mode === 'ROTATE' ? [v[0]] : [v[0], v[1]];
      transformPoints(snapPoints(pts), mode, value, aspectOf(ed));
      done(ed);
    },
  },
];

/** Move a parented point's stored position to where it shows now (before changing its parent). */
function bakeParent(p: MaskPoint, res: ReturnType<typeof parentResolver>, frame: number) {
  const d = p.parent ? res(p, frame) : null;
  if (!d) return;
  p.co = [p.co[0] + d[0], p.co[1] + d[1]];
  p.handle_left = [p.handle_left[0] + d[0], p.handle_left[1] + d[1]];
  p.handle_right = [p.handle_right[0] + d[0], p.handle_right[1] + d[1]];
}

function addPrimitive(make: (x: number, y: number, r: number, aspect: number) => MaskSpline, p: Record<string, unknown>) {
  const ed = maskEditor()!;
  const m = curMask();
  const layer = activeLayer(m)!;
  const [x, y] = p.location as V;
  const sp = make(x, y, (p.size as number) / 2, aspectOf(ed));
  deselectAll(m);
  for (const q of sp.points) q.select = true;
  layer.splines.push(sp);
  layer.active_spline = layer.splines.length - 1;
  layer.shape_keys = [];
  done();
}

function moreLess(more: boolean) {
  const m = curMask();
  for (const { spline } of selectedSplines(m)) {
    const pts = spline.points;
    const n = pts.length;
    const sel = pts.map((p) => p.select);
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? sel[i - 1] : spline.use_cyclic ? sel[n - 1] : more ? false : true;
      const next = i < n - 1 ? sel[i + 1] : spline.use_cyclic ? sel[0] : more ? false : true;
      if (more && !sel[i] && (prev || next)) pts[i].select = true;
      if (!more && sel[i] && (!prev || !next)) pts[i].select = false;
    }
  }
  done();
}

// ---------------------------------------------------------------------------
// shapes

function startShape(kind: 'box' | 'lasso', mode: 'SET' | 'ADD' | 'SUB') {
  const ed = maskEditor()!;
  const down = (e: PointerEvent) => {
    removeEventListener('pointerdown', down, true);
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p0 = ed.local(e);
    const pts: V[] = [[p0.x, p0.y]];
    const move = (ev: PointerEvent) => {
      const q = ed.local(ev);
      if (kind === 'box') ed.shapeOverlay = { kind: 'lasso', pts: [[p0.x, p0.y], [q.x, p0.y], [q.x, q.y], [p0.x, q.y]] };
      else {
        pts.push([q.x, q.y]);
        ed.shapeOverlay = { kind: 'lasso', pts };
      }
      ed.draw();
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      const q = ed.local(ev);
      ed.shapeOverlay = null;
      const m = hostMask(ed);
      if (!m) return;
      const m0 = ev.shiftKey ? 'ADD' : ev.ctrlKey || ev.metaKey ? 'SUB' : mode;
      if (kind === 'box') {
        const x0 = Math.min(p0.x, q.x),
          x1 = Math.max(p0.x, q.x),
          y0 = Math.min(p0.y, q.y),
          y1 = Math.max(p0.y, q.y);
        selectWhere(ed, m, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1, m0);
      } else selectWhere(ed, m, (x, y) => pointInPolygon(x, y, pts), m0);
      app.pushUndo(kind === 'box' ? 'Box Select' : 'Lasso Select');
      done(ed);
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  };
  addEventListener('pointerdown', down, true);
}

let circleRadius = 25;

function startCircle(mode: 'SET' | 'ADD' | 'SUB') {
  const ed = maskEditor()!;
  const m = curMask();
  if (mode === 'SET') deselectAll(m);
  const p = ed.local({ clientX: app.pointer.x, clientY: app.pointer.y });
  const c = { kind: 'circle' as const, x: p.x, y: p.y, r: circleRadius };
  let paint: 'ADD' | 'SUB' | null = null;
  const apply = () => {
    if (paint) selectWhere(ed, m, (x, y) => Math.hypot(x - c.x, y - c.y) <= c.r, paint);
    ed.shapeOverlay = c;
    ed.draw();
  };
  apply();
  const end = () => {
    ed.shapeOverlay = null;
    done(ed);
  };
  app.startModal({
    label: 'Circle Select',
    cursor: 'crosshair',
    header: () => 'Circle Select: LMB select, Shift / MMB deselect, wheel resize, RMB / Esc confirm',
    onPointerMove(e) {
      const q = ed.local(e);
      c.x = q.x;
      c.y = q.y;
      apply();
    },
    onPointerDown(e) {
      if (e.button === 2) return 'FINISHED';
      paint = e.button === 1 || e.shiftKey || mode === 'SUB' ? 'SUB' : 'ADD';
      apply();
      return undefined;
    },
    onPointerUp() {
      paint = null;
      return undefined;
    },
    onWheel(e) {
      c.r = circleRadius = Math.max(5, Math.min(300, c.r * (e.deltaY > 0 ? 1 / 1.1 : 1.1)));
      apply();
    },
    onKey(e) {
      if (e.type === 'keydown' && (e.key === 'Escape' || e.key === 'Enter')) return 'FINISHED';
      return true;
    },
    cancel: end,
    finish: end,
  });
}

// ---------------------------------------------------------------------------
// modal transform of mask points

type Mode = 'TRANSLATE' | 'ROTATE' | 'RESIZE' | 'FEATHER';

interface PointSnap {
  p: MaskPoint;
  co: V;
  hl: V;
  hr: V;
  w: number;
}

const snapPoints = (pts: MaskPoint[]): PointSnap[] => pts.map((p) => ({ p, co: [...p.co] as V, hl: [...p.handle_left] as V, hr: [...p.handle_right] as V, w: p.weight }));

/**
 * Transform snapshots of points around their median (aspect-correct): TRANSLATE value = [dx, dy]
 * (frame units), ROTATE value[0] = radians, RESIZE value = [sx, sy], FEATHER value[0] = factor.
 */
export function transformPoints(orig: PointSnap[], mode: Mode, value: number[], aspect: number) {
  const cx = orig.reduce((a, o) => a + o.co[0], 0) / orig.length,
    cy = orig.reduce((a, o) => a + o.co[1], 0) / orig.length;
  const tf = (v: V, f: (x: number, y: number) => V): V => {
    const [x, y] = f((v[0] - cx) * aspect, v[1] - cy);
    return [cx + x / aspect, cy + y];
  };
  for (const o of orig) {
    o.p.co = [...o.co];
    o.p.handle_left = [...o.hl];
    o.p.handle_right = [...o.hr];
    o.p.weight = o.w;
  }
  if (mode === 'TRANSLATE') {
    const [dx, dy] = value;
    for (const o of orig) {
      o.p.co = [o.co[0] + dx, o.co[1] + dy];
      o.p.handle_left = [o.hl[0] + dx, o.hl[1] + dy];
      o.p.handle_right = [o.hr[0] + dx, o.hr[1] + dy];
    }
  } else if (mode === 'ROTATE') {
    const c = Math.cos(value[0]),
      sn = Math.sin(value[0]);
    const rot = (x: number, y: number): V => [x * c - y * sn, x * sn + y * c];
    for (const o of orig) {
      o.p.co = tf(o.co, rot);
      o.p.handle_left = tf(o.hl, rot);
      o.p.handle_right = tf(o.hr, rot);
    }
  } else if (mode === 'FEATHER') for (const o of orig) o.p.weight = Math.max(0, o.w * value[0]);
  else {
    const sc = (x: number, y: number): V => [x * value[0], y * (value[1] ?? value[0])];
    for (const o of orig) {
      o.p.co = tf(o.co, sc);
      o.p.handle_left = tf(o.hl, sc);
      o.p.handle_right = tf(o.hr, sc);
    }
  }
}

export function startTransform(mode: Mode): boolean {
  const ed = maskEditor();
  if (!ed) return false;
  const m = hostMask(ed)!;
  const pts = selectedPoints(m).map((x) => x.point);
  if (!pts.length) return false;
  const aspect = aspectOf(ed);
  const orig = snapPoints(pts);
  const cx = orig.reduce((a, o) => a + o.co[0], 0) / orig.length,
    cy = orig.reduce((a, o) => a + o.co[1], 0) / orig.length;
  const sp0 = ed.local({ clientX: app.pointer.x, clientY: app.pointer.y });
  const start = s2m(ed, sp0.x, sp0.y);
  const st = { text: '', axis: null as 'X' | 'Y' | null, value: [0, 0] as number[] };
  let last: V = start;
  const apply = () => {
    const num = st.text && st.text !== '-' ? Number(st.text) : null;
    let v: number[];
    if (mode === 'TRANSLATE') {
      v = num !== null ? (st.axis === 'Y' ? [0, num] : [num, 0]) : [last[0] - start[0], last[1] - start[1]];
      if (st.axis === 'X') v[1] = 0;
      if (st.axis === 'Y') v[0] = 0;
    } else if (mode === 'ROTATE') {
      const a0 = Math.atan2(start[1] - cy, (start[0] - cx) * aspect),
        a1 = Math.atan2(last[1] - cy, (last[0] - cx) * aspect);
      v = [num !== null ? (num * Math.PI) / 180 : a1 - a0];
    } else {
      const d0 = Math.hypot((start[0] - cx) * aspect, start[1] - cy) || 1e-6;
      const k = num ?? Math.hypot((last[0] - cx) * aspect, last[1] - cy) / d0;
      v = mode === 'FEATHER' ? [k] : [st.axis === 'Y' ? 1 : k, st.axis === 'X' ? 1 : k];
    }
    st.value = v;
    transformPoints(orig, mode, v, aspect);
    updateHandles(m, aspect);
    app.changed('doc');
    ed.draw();
  };
  const handler: ModalHandler = {
    label: mode === 'TRANSLATE' ? 'Move' : mode === 'ROTATE' ? 'Rotate' : mode === 'RESIZE' ? 'Resize' : 'Feather Width',
    cursor: mode === 'TRANSLATE' ? 'move' : 'crosshair',
    header: () => {
      const v = st.value;
      const val = mode === 'TRANSLATE' ? `${v[0].toFixed(4)}, ${v[1].toFixed(4)}` : mode === 'ROTATE' ? `${((v[0] * 180) / Math.PI).toFixed(1)}°` : (st.axis === 'Y' ? v[1] : v[0]).toFixed(3);
      return `${handler.label}: ${st.text ? st.text + '|' : val}${st.axis ? ` along ${st.axis}` : ''}`;
    },
    onPointerMove(e) {
      const q = ed.local(e);
      last = s2m(ed, q.x, q.y);
      apply();
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      const k = e.key.toUpperCase();
      if ((k === 'X' || k === 'Y') && mode !== 'ROTATE' && mode !== 'FEATHER') {
        st.axis = st.axis === k ? null : (k as 'X');
        apply();
        return true;
      }
      if (/^[0-9]$/.test(e.key) || (e.key === '-' && !st.text) || (e.key === '.' && !st.text.includes('.'))) st.text += e.key;
      else if (e.key === 'Backspace') st.text = st.text.slice(0, -1);
      apply();
      return true;
    },
    cancel() {
      for (const o of orig) {
        o.p.co = o.co;
        o.p.handle_left = o.hl;
        o.p.handle_right = o.hr;
        o.p.weight = o.w;
      }
      done(ed);
    },
    finish() {
      done(ed);
      handler.redoOp = { idname: 'mask.transform', props: { mode, value: [st.value[0], st.value[1] ?? 0, 0] } };
    },
  };
  app.startModal(handler);
  apply();
  return true;
}

registerOperators(ops);

// ---------------------------------------------------------------------------
// keymap

addKeys('Mask Editing', [
  { key: 'N', alt: true, op: 'mask.new' },
  { key: 'X', op: 'mask.delete' },
  { key: 'DEL', op: 'mask.delete' },
  { key: 'A', op: 'mask.select_all', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'mask.select_all', props: { action: 'DESELECT' } },
  { key: 'I', ctrl: true, op: 'mask.select_all', props: { action: 'INVERT' } },
  { key: 'L', ctrl: true, op: 'mask.select_linked' },
  { key: 'L', op: 'mask.select_linked_pick', props: { deselect: false } },
  { key: 'L', shift: true, op: 'mask.select_linked_pick', props: { deselect: true } },
  { key: 'B', op: 'mask.select_box' },
  { key: 'C', op: 'mask.select_circle' },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'mask.select_more' },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'mask.select_less' },
  { key: 'H', alt: true, op: 'mask.hide_view_clear' },
  { key: 'H', op: 'mask.hide_view_set', props: { unselected: false } },
  { key: 'H', shift: true, op: 'mask.hide_view_set', props: { unselected: true } },
  { key: 'C', alt: true, op: 'mask.cyclic_toggle' },
  { key: 'N', shift: true, op: 'mask.normals_make_consistent' },
  { key: 'P', ctrl: true, op: 'mask.parent_set' },
  { key: 'P', alt: true, op: 'mask.parent_clear' },
  { key: 'I', op: 'mask.shape_key_insert' },
  { key: 'I', alt: true, op: 'mask.shape_key_clear' },
  { key: 'D', shift: true, op: 'mask.duplicate_move' },
  { key: 'C', ctrl: true, op: 'mask.copy_splines' },
  { key: 'V', ctrl: true, op: 'mask.paste_splines' },
  { key: 'G', op: 'mask.transform', props: { mode: 'TRANSLATE' } },
  { key: 'R', op: 'mask.transform', props: { mode: 'ROTATE' } },
  { key: 'S', op: 'mask.transform', props: { mode: 'RESIZE' } },
  { key: 'S', alt: true, op: 'mask.transform', props: { mode: 'FEATHER' } },
  {
    key: 'V',
    menuTitle: 'Set Handle Type',
    menu: () =>
      [
        ['AUTO', 'Auto'],
        ['VECTOR', 'Vector'],
        ['ALIGNED', 'Aligned'],
        ['FREE', 'Free'],
      ].map(([type, label]) => ({ label, op: 'mask.handle_type_set', props: { type } })),
  },
]);

// shape keys drive the points when the frame changes (edits since the last key are dropped)
let lastFrame = NaN;
onAppReady((a) =>
  a.subscribe((kinds) => {
    if (!kinds.has('frame') || !a.doc.masks) return;
    const f = a.doc.scene.frame_current;
    if (f === lastFrame) return;
    lastFrame = f;
    for (const m of Object.values(a.doc.masks))
      for (const l of m.layers) {
        const d = l.shape_keys.length ? keyedData(l, f) : null;
        if (d) applyData(l, d);
      }
  }),
);

export type { MaskPoint };
