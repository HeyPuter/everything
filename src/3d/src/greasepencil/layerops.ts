// Layer operators beyond add / remove / move: isolate, merge modes, material isolation and
// the material specials (lock unused / unselected, copy to selected objects, select by material).
import { Box3, Vector3, Matrix4 } from 'three';
import { app, registerOperators, operators } from '../app/app';
import { frameHooks } from '../ops/view3d';
import { worldBounds } from '../editors/view3d/view3d';
import { layerMatrix, parentWorld } from './render';
import type { ObjectData } from '../data/types';
import { gpOf, frameAt, toStrokes, fromStrokes, setKeyframe, compactDrawings, normalizeDrawing } from './data';
import { activeGP } from './ops';
import { editTargets, inGPEdit } from './edit';
import type { GPDrawing, GPKeyframeType, GPLayer, GreasePencilData } from './types';

const pollGP = () => !!activeGP();

/** Merge `sources` (bottom → top) into one layer's keys: every key frame of any source gets the combined strokes. */
export function mergeLayers(gp: GreasePencilData, sources: GPLayer[]): { n: number; d: GPDrawing; t: GPKeyframeType }[] {
  const frames = new Set(sources.flatMap((l) => l.frames.map((f) => f.frame_number)));
  const out: { n: number; d: GPDrawing; t: GPKeyframeType }[] = [];
  for (const n of [...frames].sort((a, b) => a - b)) {
    const strokes = sources.flatMap((l) => {
      const fr = frameAt(l, n);
      return fr && gp.drawings[fr.drawing] ? toStrokes(normalizeDrawing(gp.drawings[fr.drawing])) : [];
    });
    const key = sources.map((l) => l.frames.find((f) => f.frame_number === n)).find(Boolean);
    out.push({ n, d: fromStrokes(strokes), t: key?.keyframe_type ?? 'KEYFRAME' });
  }
  return out;
}

/** Isolate: lock (and hide) every other layer, or restore them when they already are. */
export function isolateLayer(gp: GreasePencilData, index: number, affectVisibility: boolean) {
  const others = gp.layers.filter((_, i) => i !== index);
  const isolated = others.length > 0 && others.every((l) => l.lock && (!affectVisibility || l.hide));
  for (const l of others) {
    l.lock = !isolated;
    if (affectVisibility) l.hide = !isolated;
  }
  const act = gp.layers[index];
  if (act) {
    act.lock = false;
    if (affectVisibility) act.hide = false;
  }
}

function materialStyle(id: string | null | undefined) {
  return id ? app.doc.materials[id]?.grease_pencil : undefined;
}

/** Material slots used by any stroke of the object. */
function usedSlots(gp: GreasePencilData): Set<number> {
  const used = new Set<number>();
  for (const d of gp.drawings) for (const m of d.material_index ?? []) used.add(m);
  return used;
}

registerOperators([
  {
    idname: 'grease_pencil.layer_isolate',
    label: 'Isolate Layers',
    description: 'Lock every layer but the active one (toggle to unlock them again)',
    props: [{ id: 'affect_visibility', label: 'Affect Visibility', type: 'bool', default: false }],
    poll: () => (activeGP()?.gp.layers.length ?? 0) > 0,
    exec: (_c, p) => {
      const { gp } = activeGP()!;
      isolateLayer(gp, gp.active_layer_index, !!p.affect_visibility);
    },
  },
  {
    idname: 'grease_pencil.material_isolate',
    label: 'Isolate Material',
    description: 'Lock every material but the active one (toggle to unlock them again)',
    props: [{ id: 'affect_visibility', label: 'Affect Visibility', type: 'bool', default: false }],
    poll: () => (activeGP()?.gp.materials.length ?? 0) > 0,
    exec: (_c, p) => {
      const { ob, gp } = activeGP()!;
      const others = gp.materials.filter((_, i) => i !== ob.active_material_index).map(materialStyle).filter((s): s is NonNullable<typeof s> => !!s);
      const isolated = others.length > 0 && others.every((s) => s.lock && (!p.affect_visibility || s.hide));
      for (const s of others) {
        s.lock = !isolated;
        if (p.affect_visibility) s.hide = !isolated;
      }
      const act = materialStyle(gp.materials[ob.active_material_index]);
      if (act) {
        act.lock = false;
        if (p.affect_visibility) act.hide = false;
      }
    },
  },
  {
    idname: 'grease_pencil.material_lock_unused',
    label: 'Lock Unused Materials',
    description: 'Lock the materials no stroke uses',
    poll: pollGP,
    exec: () => {
      const { gp } = activeGP()!;
      const used = usedSlots(gp);
      let n = 0;
      gp.materials.forEach((id, i) => {
        const st = materialStyle(id);
        if (st && !used.has(i)) {
          st.lock = true;
          n++;
        }
      });
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.material_lock_unselected',
    label: 'Lock Unselected Materials',
    description: 'Lock the materials not used by any selected stroke',
    poll: () => inGPEdit(),
    exec: () => {
      const { gp } = activeGP()!;
      const used = new Set<number>();
      for (const t of editTargets()) {
        const d = normalizeDrawing(gp.drawings[t.idx]);
        for (let s = 0; s + 1 < d.offsets.length; s++) for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) if (d.select![i]) used.add(d.material_index[s]);
      }
      if (!used.size) return 'CANCELLED';
      gp.materials.forEach((id, i) => {
        const st = materialStyle(id);
        if (st && !used.has(i)) st.lock = true;
      });
    },
  },
  {
    idname: 'grease_pencil.material_select',
    label: 'Select Material',
    description: 'Select (or deselect) the strokes that use the active material',
    props: [{ id: 'deselect', label: 'Deselect', type: 'bool', default: false }],
    poll: () => inGPEdit(),
    exec: (_c, p) => {
      const { ob, gp } = activeGP()!;
      const slot = ob.active_material_index;
      for (const t of editTargets()) {
        const d = normalizeDrawing(gp.drawings[t.idx]);
        const sel = d.select!.slice();
        for (let s = 0; s + 1 < d.offsets.length; s++) if (d.material_index[s] === slot) sel.fill(p.deselect ? 0 : 1, d.offsets[s], d.offsets[s + 1]);
        gp.drawings[t.idx] = { ...d, select: sel };
      }
      app.changed('select');
    },
  },
  {
    idname: 'grease_pencil.material_copy_to_object',
    label: 'Copy Materials to Selected Object',
    description: 'Give the other selected Grease Pencil objects the active material (or all materials)',
    props: [{ id: 'only_active', label: 'Only Active', type: 'bool', default: true }],
    poll: () => !!activeGP() && app.selectedObjects().some((o) => o !== app.activeObject && !!gpOf(app.doc, o)),
    exec: (_c, p) => {
      const { ob, gp } = activeGP()!;
      const ids = (p.only_active ? [gp.materials[ob.active_material_index]] : gp.materials).filter((x): x is string => !!x);
      if (!ids.length) return 'CANCELLED';
      for (const o of app.selectedObjects()) {
        const g = o === ob ? null : gpOf(app.doc, o);
        if (!g) continue;
        for (const id of ids) if (!g.materials.includes(id)) g.materials.push(id);
      }
    },
  },
]);

// Merge: Active (down), Group / All
const merge = operators.get('grease_pencil.layer_merge');
if (merge) {
  merge.props = [
    {
      id: 'mode',
      label: 'Mode',
      type: 'enum',
      default: 'ACTIVE',
      items: [
        ['ACTIVE', 'Active', 'Combine the active layer with the layer below it'],
        ['ALL', 'All', 'Combine every layer into the active one'],
      ],
    },
  ];
  merge.poll = () => {
    const g = activeGP()?.gp;
    return !!g && g.layers.length > 1;
  };
  merge.exec = (_c, p) => {
    const { gp } = activeGP()!;
    const i = gp.active_layer_index;
    if (p.mode === 'ALL') {
      const target = gp.layers[i];
      const merged = mergeLayers(gp, gp.layers);
      target.frames = [];
      for (const m of merged) setKeyframe(gp, target, m.n, m.d, m.t);
      gp.layers = [target];
      gp.active_layer_index = 0;
    } else {
      if (i < 1) return 'CANCELLED';
      const below = gp.layers[i - 1];
      const merged = mergeLayers(gp, [below, gp.layers[i]]);
      below.frames = [];
      for (const m of merged) setKeyframe(gp, below, m.n, m.d, m.t);
      gp.layers.splice(i, 1);
      gp.active_layer_index = i - 1;
    }
    compactDrawings(gp);
  };
}

/** Grease pencil objects among the selection (for multi-object helpers). */
export function selectedGP(): { ob: ObjectData; gp: GreasePencilData }[] {
  return app
    .selectedObjects()
    .map((ob) => ({ ob, gp: gpOf(app.doc, ob) }))
    .filter((x): x is { ob: ObjectData; gp: GreasePencilData } => !!x.gp);
}

// ---------------------------------------------------------------------------
// framing: grease pencil objects are framed by their strokes (Frame Selected, Numpad .)

/** World bounds of the strokes shown at the current frame. */
export function gpWorldBounds(ob: ObjectData, out = new Box3()): Box3 {
  const gp = gpOf(app.doc, ob);
  const ev = app.graph.get(ob.id);
  if (!gp || !ev) return out;
  const v = new Vector3();
  const frame = app.doc.scene.frame_current;
  for (const l of gp.layers) {
    if (l.hide) continue;
    const fr = frameAt(l, frame);
    const d = fr ? gp.drawings[fr.drawing] : null;
    if (!d) continue;
    const m = ev.world.clone().multiply(layerMatrix(l));
    const P = d.position;
    const step = Math.max(1, Math.floor(P.length / 3 / 20000));
    for (let i = 0; i < P.length / 3; i += step) out.expandByPoint(v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(m));
  }
  return out;
}

frameHooks.push(() => {
  const mode = app.doc.mode;
  if (mode !== 'OBJECT' && mode !== 'PAINT_GREASE_PENCIL' && mode !== 'SCULPT_GREASE_PENCIL' && mode !== 'VERTEX_GREASE_PENCIL' && mode !== 'WEIGHT_GREASE_PENCIL') return null;
  const sel = mode === 'OBJECT' ? app.selectedObjects() : [app.activeObject].filter((o): o is ObjectData => !!o);
  if (!sel.some((o) => gpOf(app.doc, o))) return null;
  const box = worldBounds(sel.filter((o) => !gpOf(app.doc, o)).map((o) => o.id));
  for (const o of sel) if (gpOf(app.doc, o)) gpWorldBounds(o, box);
  return box.isEmpty() ? null : box;
});

// ---------------------------------------------------------------------------
// layer masks

const activeLayerOf = () => {
  const c = activeGP();
  const l = c ? c.gp.layers[c.gp.active_layer_index] : null;
  return c && l ? { ...c, layer: l } : null;
};

registerOperators([
  {
    idname: 'grease_pencil.layer_mask_add',
    label: 'Add New Mask Layer',
    description: 'Mask the active layer with another layer',
    props: [{ id: 'name', label: 'Layer', type: 'string', default: '' }],
    poll: () => (activeGP()?.gp.layers.length ?? 0) > 1,
    exec: (_c, p) => {
      const c = activeLayerOf()!;
      const name = p.name as string;
      if (!name || name === c.layer.name || !c.gp.layers.some((l) => l.name === name)) return 'CANCELLED';
      const list = (c.layer.mask_layers ??= []);
      if (list.some((m) => m.name === name)) {
        app.report('ERROR', 'Layer already added');
        return 'CANCELLED';
      }
      list.push({ name, hide: false, invert: false });
      c.layer.active_mask_index = list.length - 1;
      c.layer.use_masks = true;
    },
  },
  {
    idname: 'grease_pencil.relative_layer_mask_add',
    label: 'Mask with Layer Above/Below',
    description: 'Mask the active layer with the layer above or below it',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'ABOVE',
        items: [
          ['ABOVE', 'Above'],
          ['BELOW', 'Below'],
        ],
      },
    ],
    poll: () => (activeGP()?.gp.layers.length ?? 0) > 1,
    exec: (_c, p) => {
      const c = activeLayerOf()!;
      const other = c.gp.layers[c.gp.active_layer_index + (p.mode === 'ABOVE' ? 1 : -1)];
      if (!other) return 'CANCELLED';
      return app.run('grease_pencil.layer_mask_add', { name: other.name }, { invoke: false }) === 'FINISHED' ? undefined : 'CANCELLED';
    },
    undo: false,
  },
  {
    idname: 'grease_pencil.layer_mask_remove',
    label: 'Remove Mask Layer',
    description: 'Stop masking the active layer with the active mask',
    poll: () => (activeLayerOf()?.layer.mask_layers?.length ?? 0) > 0,
    exec: () => {
      const { layer } = activeLayerOf()!;
      const list = layer.mask_layers!;
      const i = Math.min(list.length - 1, layer.active_mask_index ?? 0);
      list.splice(i, 1);
      layer.active_mask_index = Math.max(0, i - 1);
    },
  },
  {
    idname: 'grease_pencil.layer_mask_reorder',
    label: 'Reorder Grease Pencil Layer Mask',
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
    poll: () => (activeLayerOf()?.layer.mask_layers?.length ?? 0) > 1,
    exec: (_c, p) => {
      const { layer } = activeLayerOf()!;
      const list = layer.mask_layers!;
      const i = layer.active_mask_index ?? 0;
      const j = p.direction === 'UP' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return 'CANCELLED';
      [list[i], list[j]] = [list[j], list[i]];
      layer.active_mask_index = j;
    },
  },
]);

// renaming a layer keeps the masks pointing at it
export function renameLayer(gp: GreasePencilData, layer: GPLayer, name: string) {
  const old = layer.name;
  layer.name = name;
  for (const l of gp.layers) for (const m of l.mask_layers ?? []) if (m.name === old) m.name = name;
}

/** Parent a layer keeping its strokes where they are. */
export function setLayerParent(ob: ObjectData, layer: GPLayer, parent: string | null, type: 'OBJECT' | 'BONE' = 'OBJECT', bone = '') {
  layer.parent = parent;
  layer.parent_type = type;
  layer.parent_bone = bone;
  const pw = parent ? parentWorld(layer) : null;
  const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
  layer.parent_inverse = pw ? pw.invert().multiply(obWorld).toArray() : undefined;
}
