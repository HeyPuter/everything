// Layer operators beyond add / remove / move: isolate, merge modes, material isolation and
// the material specials (lock unused / unselected, copy to selected objects, select by material).
import { app, registerOperators, operators } from '../app/app';
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
