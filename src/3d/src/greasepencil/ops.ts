// Grease Pencil object, layer, keyframe and material operators.
import { app, registerOperators, operators, type OpContext, type PropDef, type Operator } from '../app/app';
import type { DocumentData, ObjectData } from '../data/types';
import { newObject } from '../data/defaults';
import { addObjectToScene, uniqueName } from '../ops/object';
import {
  gpTable,
  gpOf,
  newGreasePencil,
  newLayer,
  newGPMaterial,
  emptyDrawing,
  fromStrokes,
  newStroke,
  newPoint,
  setKeyframe,
  frameAt,
  copyDrawing,
  compactDrawings,
  uniqueLayerName,
  activeLayer,
  sortFrames,
  toStrokes,
} from './data';
import type { GPDrawing, GPKeyframeType, GreasePencilData, GPLayer } from './types';

export const isGP = (ob: ObjectData | null | undefined): ob is ObjectData => !!ob && ob.type === 'GREASEPENCIL' && !!ob.data;
export const activeGP = (): { ob: ObjectData; gp: GreasePencilData } | null => {
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  return gp && ob ? { ob, gp } : null;
};
const pollGP = () => !!activeGP();

const transformProps: PropDef[] = [
  {
    id: 'align',
    label: 'Align',
    type: 'enum',
    default: 'WORLD',
    items: [
      ['WORLD', 'World'],
      ['VIEW', 'View'],
      ['CURSOR', '3D Cursor'],
    ],
  },
  {
    id: 'location',
    label: 'Location',
    type: 'vec3',
    default: null,
    subtype: 'distance',
  },
  {
    id: 'rotation',
    label: 'Rotation',
    type: 'vec3',
    default: null,
    subtype: 'angle',
  },
];

function addMaterial(doc: DocumentData, gp: GreasePencilData, name: string, o: Parameters<typeof newGPMaterial>[1]) {
  const ma = newGPMaterial(uniqueName(doc, name, 'materials'), o);
  doc.materials[ma.id] = ma;
  gp.materials.push(ma.id);
  return ma;
}

/** An original sample: a looping, tapered brush stroke over a soft fill, drawn on the front (X-Z) plane. */
export function sampleStrokes(): { lines: GPDrawing; fills: GPDrawing } {
  const pts = [];
  const N = 160;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = t * Math.PI * 4.2;
    // a drifting loop-de-loop: a wave with two curls
    const x = -1.4 + t * 2.8 + 0.32 * Math.sin(a);
    const z = 0.35 * Math.sin(t * Math.PI * 2) + 0.32 * Math.cos(a) - 0.32;
    const taper = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.6;
    pts.push(newPoint([x, 0, z], 0.004 + 0.022 * taper, 1));
  }
  const ring = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push(newPoint([0.15 + 0.9 * Math.cos(a), 0.01, -0.1 + 0.55 * Math.sin(a)], 0.01, 1));
  }
  const dots = [];
  // a small red flourish above the loop
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    dots.push(newPoint([-0.9 + t * 1.8, 0, 0.72 + 0.09 * Math.sin(t * Math.PI * 3)], 0.003 + 0.011 * Math.sin(Math.PI * t), 1));
  }
  return {
    lines: fromStrokes([newStroke(pts, { material_index: 0 }), newStroke(dots, { material_index: 2 })]),
    fills: fromStrokes([newStroke(ring, { material_index: 5, cyclic: true })]),
  };
}

/** An original cartoon monkey head on the front (X-Z) plane: fills on one layer, lines on another. */
export function monkeyStrokes(): { lines: GPDrawing; fills: GPDrawing } {
  const ellipse = (cx: number, cz: number, rx: number, rz: number, n = 48, r = 0.012, a0 = 0, a1 = Math.PI * 2) => {
    const pts = [];
    const closed = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
    const m = closed ? n : n + 1;
    for (let i = 0; i < m; i++) {
      const t = a0 + ((a1 - a0) * i) / n;
      pts.push(newPoint([cx + rx * Math.cos(t), 0, cz + rz * Math.sin(t)], r, 1));
    }
    return pts;
  };
  // fills: ears (slot 2), head (slot 1), face mask (slot 3), eyes (slot 4)
  const fills = [
    newStroke(ellipse(-0.82, 0.12, 0.26, 0.24), { cyclic: true, material_index: 1 }),
    newStroke(ellipse(0.82, 0.12, 0.26, 0.24), { cyclic: true, material_index: 1 }),
    newStroke(ellipse(-0.82, 0.12, 0.15, 0.14), { cyclic: true, material_index: 2 }),
    newStroke(ellipse(0.82, 0.12, 0.15, 0.14), { cyclic: true, material_index: 2 }),
    newStroke(ellipse(0, 0.1, 0.72, 0.68, 64), { cyclic: true, material_index: 1 }),
    // the face: two upper lobes and a muzzle, filled together
    newStroke(ellipse(-0.24, 0.18, 0.27, 0.3), { cyclic: true, material_index: 2, fill_id: 1 }),
    newStroke(ellipse(0.24, 0.18, 0.27, 0.3), { cyclic: true, material_index: 2, fill_id: 2 }),
    newStroke(ellipse(0, -0.2, 0.46, 0.3), { cyclic: true, material_index: 2 }),
    newStroke(ellipse(-0.22, 0.2, 0.09, 0.12), { cyclic: true, material_index: 3 }),
    newStroke(ellipse(0.22, 0.2, 0.09, 0.12), { cyclic: true, material_index: 3 }),
  ];
  const lines = [
    // outlines
    newStroke(ellipse(0, 0.1, 0.72, 0.68, 64, 0.016), { cyclic: true }),
    newStroke(ellipse(-0.82, 0.12, 0.26, 0.24, 40, 0.014, Math.PI * 0.32, Math.PI * 1.68)),
    newStroke(ellipse(0.82, 0.12, 0.26, 0.24, 40, 0.014, -Math.PI * 0.68, Math.PI * 0.68)),
    // pupils with a highlight
    newStroke(ellipse(-0.2, 0.17, 0.035, 0.05, 16, 0.02), { cyclic: true }),
    newStroke(ellipse(0.2, 0.17, 0.035, 0.05, 16, 0.02), { cyclic: true }),
    newStroke([newPoint([-0.19, 0, 0.215], 0.012)], { material_index: 4 }),
    newStroke([newPoint([0.21, 0, 0.215], 0.012)], { material_index: 4 }),
    // nostrils and smile
    newStroke(ellipse(-0.07, -0.08, 0.025, 0.02, 10, 0.012), { cyclic: true }),
    newStroke(ellipse(0.07, -0.08, 0.025, 0.02, 10, 0.012), { cyclic: true }),
    newStroke(ellipse(0, -0.12, 0.26, 0.2, 24, 0.012, Math.PI * 1.15, Math.PI * 1.85)),
  ];
  // tapered ends on the open lines
  for (const st of lines)
    if (!st.cyclic && st.points.length > 4)
      st.points.forEach((p, i) => {
        const t = i / (st.points.length - 1);
        p.radius *= 0.35 + 0.65 * Math.sin(Math.PI * t);
      });
  return { lines: fromStrokes(lines), fills: fromStrokes(fills) };
}

export function createGreasePencilObject(doc: DocumentData, type: 'EMPTY' | 'STROKE' | 'MONKEY', props: Record<string, unknown>): ObjectData {
  const frame = doc.scene.frame_current;
  const gp = newGreasePencil(uniqueName(doc, type === 'STROKE' ? 'Stroke' : type === 'MONKEY' ? 'Monkey' : 'GPencil', 'objects'));
  gpTable(doc)[gp.id] = gp;
  if (type === 'MONKEY') {
    addMaterial(doc, gp, 'Black', { color: [0, 0, 0, 1], fill_color: [0, 0, 0, 1] });
    addMaterial(doc, gp, 'Fur', { show_stroke: false, show_fill: true, color: [0.23, 0.11, 0.05, 1], fill_color: [0.23, 0.11, 0.05, 1] });
    addMaterial(doc, gp, 'Face', { show_stroke: false, show_fill: true, color: [0.75, 0.5, 0.33, 1], fill_color: [0.75, 0.5, 0.33, 1] });
    addMaterial(doc, gp, 'Eyes', { show_stroke: false, show_fill: true, color: [1, 1, 1, 1], fill_color: [1, 1, 1, 1] });
    addMaterial(doc, gp, 'White', { color: [1, 1, 1, 1], fill_color: [1, 1, 1, 1] });
    const { lines, fills } = monkeyStrokes();
    const fillsL = newLayer('Fills');
    const linesL = newLayer('Lines');
    gp.layers.push(fillsL, linesL);
    setKeyframe(gp, fillsL, frame, fills);
    setKeyframe(gp, linesL, frame, lines);
    gp.active_layer_index = 1;
  } else if (type === 'STROKE') {
    addMaterial(doc, gp, 'Black', {
      color: [0, 0, 0, 1],
      fill_color: [0, 0, 0, 1],
    });
    addMaterial(doc, gp, 'White', {
      color: [1, 1, 1, 1],
      fill_color: [1, 1, 1, 1],
    });
    addMaterial(doc, gp, 'Red', {
      color: [1, 0, 0, 1],
      fill_color: [1, 0, 0, 1],
    });
    addMaterial(doc, gp, 'Green', {
      color: [0, 1, 0, 1],
      fill_color: [0, 1, 0, 1],
    });
    addMaterial(doc, gp, 'Blue', {
      color: [0, 0, 1, 1],
      fill_color: [0, 0, 1, 1],
    });
    addMaterial(doc, gp, 'Grey', {
      show_stroke: false,
      show_fill: true,
      color: [0.214, 0.214, 0.214, 1],
      fill_color: [0.214, 0.214, 0.214, 1],
    });
    const { lines, fills } = sampleStrokes();
    const color = newLayer('Color');
    const linesL = newLayer('Lines');
    gp.layers.push(color, linesL);
    setKeyframe(gp, color, frame, fills);
    setKeyframe(gp, linesL, frame, lines);
    gp.active_layer_index = 1;
  } else {
    addMaterial(doc, gp, 'Black', {
      color: [0, 0, 0, 1],
      fill_color: [0, 0, 0, 1],
    });
    const l = newLayer('Layer');
    gp.layers.push(l);
    setKeyframe(gp, l, frame, emptyDrawing());
  }
  const ob = newObject(gp.name, 'GREASEPENCIL', gp.id);
  if (props.location === null || props.location === undefined) props.location = [...doc.scene.cursor.location];
  if (props.rotation === null) delete props.rotation;
  addObjectToScene(doc, ob, props);
  return ob;
}

/** Extra kinds of Add ▸ Grease Pencil objects (e.g. line art), by `type`. */
export const gpAddTypes: Record<string, (doc: DocumentData, props: Record<string, unknown>) => ObjectData> = {};

/** Keyframe operations shared by the 3D view menus and the dope sheet. */
export function insertBlankFrame(gp: GreasePencilData, layer: GPLayer, frame: number, type: GPKeyframeType = 'KEYFRAME') {
  // an existing key at this frame is shifted forward
  const at = layer.frames.find((f) => f.frame_number === frame);
  if (at) for (const f of layer.frames) if (f.frame_number >= frame) f.frame_number += 1;
  setKeyframe(gp, layer, frame, emptyDrawing(), type);
  sortFrames(layer);
}

export function duplicateActiveFrame(gp: GreasePencilData, layer: GPLayer, frame: number): boolean {
  const cur = frameAt(layer, frame);
  if (!cur) return false;
  const src = gp.drawings[cur.drawing];
  if (cur.frame_number === frame) {
    // duplicate onto the next frame (shifting later keys)
    for (const f of layer.frames) if (f.frame_number > frame) f.frame_number += 1;
    setKeyframe(gp, layer, frame + 1, copyDrawing(src), cur.keyframe_type);
  } else setKeyframe(gp, layer, frame, copyDrawing(src), cur.keyframe_type);
  return true;
}

export function deleteFrameAt(gp: GreasePencilData, layer: GPLayer, frame: number): boolean {
  const cur = frameAt(layer, frame);
  if (!cur) return false;
  layer.frames.splice(layer.frames.indexOf(cur), 1);
  compactDrawings(gp);
  return true;
}

const editableLayers = (gp: GreasePencilData, all: boolean) => (all ? gp.layers.filter((l) => !l.lock) : [activeLayer(gp)].filter((l): l is GPLayer => !!l && !l.lock));

registerOperators([
  {
    idname: 'object.grease_pencil_add',
    label: 'Add Grease Pencil',
    description: 'Add a Grease Pencil object to the scene',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'EMPTY',
        items: [
          ['EMPTY', 'Blank', 'An empty grease pencil object'],
          ['STROKE', 'Stroke', 'A grease pencil object with a sample stroke'],
          ['MONKEY', 'Monkey', 'A grease pencil object with a drawn monkey head'],
          ['LINEART_SCENE', 'Scene Line Art', 'Lines of every object in the scene, seen from the camera'],
          ['LINEART_COLLECTION', 'Collection Line Art', 'Lines of the objects in the active collection, seen from the camera'],
          ['LINEART_OBJECT', 'Object Line Art', 'Lines of the active object, seen from the camera'],
        ],
      },
      ...transformProps,
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const extra = gpAddTypes[p.type as string];
      if (extra) return void extra(ctx.doc, p);
      createGreasePencilObject(ctx.doc, p.type as 'EMPTY' | 'STROKE' | 'MONKEY', p);
    },
  },
  // ------------------------------------------------------------------ layers
  {
    idname: 'grease_pencil.layer_add',
    label: 'Add New Layer',
    props: [{ id: 'new_layer_name', label: 'Name', type: 'string', default: 'Layer' }],
    poll: pollGP,
    exec: (ctx, p) => {
      const { gp } = activeGP()!;
      const l = newLayer(uniqueLayerName(gp, (p.new_layer_name as string) || 'Layer'));
      const at = Math.min(gp.layers.length, gp.active_layer_index + 1);
      gp.layers.splice(at, 0, l);
      gp.active_layer_index = at;
      setKeyframe(gp, l, ctx.doc.scene.frame_current, emptyDrawing());
    },
  },
  {
    idname: 'grease_pencil.layer_remove',
    label: 'Remove Layer',
    poll: () => (activeGP()?.gp.layers.length ?? 0) > 0,
    exec: () => {
      const { gp } = activeGP()!;
      gp.layers.splice(gp.active_layer_index, 1);
      gp.active_layer_index = Math.max(0, Math.min(gp.layers.length - 1, gp.active_layer_index - 1 < 0 ? 0 : gp.active_layer_index - 1));
      compactDrawings(gp);
    },
  },
  {
    idname: 'grease_pencil.layer_move',
    label: 'Reorder Layer',
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
    poll: pollGP,
    exec: (_c, p) => {
      const { gp } = activeGP()!;
      const i = gp.active_layer_index;
      const j = p.direction === 'UP' ? i + 1 : i - 1; // layers are stored bottom → top
      if (j < 0 || j >= gp.layers.length) return 'CANCELLED';
      [gp.layers[i], gp.layers[j]] = [gp.layers[j], gp.layers[i]];
      gp.active_layer_index = j;
    },
  },
  {
    idname: 'grease_pencil.layer_active',
    label: 'Set Active Layer',
    props: [{ id: 'layer', label: 'Layer', type: 'int', default: 0, min: 0 }],
    poll: pollGP,
    exec: (_c, p) => {
      const { gp } = activeGP()!;
      if (!gp.layers[p.layer as number]) return 'CANCELLED';
      gp.active_layer_index = p.layer as number;
    },
    redo: false,
  },
  {
    idname: 'grease_pencil.layer_duplicate',
    label: 'Duplicate Layer',
    props: [
      {
        id: 'empty_keyframes',
        label: 'Empty Keyframes',
        type: 'bool',
        default: false,
      },
    ],
    poll: () => !!activeGP() && !!activeLayer(activeGP()!.gp),
    exec: (_c, p) => {
      const { gp } = activeGP()!;
      const src = activeLayer(gp)!;
      const l: GPLayer = {
        ...structuredClone({ ...src, frames: [] }),
        name: uniqueLayerName(gp, src.name),
        frames: [],
      };
      for (const f of src.frames) setKeyframe(gp, l, f.frame_number, p.empty_keyframes ? emptyDrawing() : copyDrawing(gp.drawings[f.drawing]), f.keyframe_type);
      gp.layers.splice(gp.active_layer_index + 1, 0, l);
      gp.active_layer_index += 1;
    },
  },
  {
    idname: 'grease_pencil.layer_merge',
    label: 'Merge Down',
    description: 'Combine the active layer with the layer below it',
    poll: () => (activeGP()?.gp.active_layer_index ?? 0) > 0,
    exec: () => {
      const { gp } = activeGP()!;
      const i = gp.active_layer_index;
      const top = gp.layers[i],
        below = gp.layers[i - 1];
      const frames = new Set([...top.frames, ...below.frames].map((f) => f.frame_number));
      const merged: { n: number; d: GPDrawing; t: GPKeyframeType }[] = [];
      for (const n of [...frames].sort((a, b) => a - b)) {
        const a = frameAt(below, n),
          b = frameAt(top, n);
        const sa = a ? toStrokes(gp.drawings[a.drawing]) : [],
          sb = b ? toStrokes(gp.drawings[b.drawing]) : [];
        merged.push({
          n,
          d: fromStrokes([...sa, ...sb]),
          t: (below.frames.find((f) => f.frame_number === n) ?? top.frames.find((f) => f.frame_number === n))!.keyframe_type,
        });
      }
      below.frames = [];
      for (const m of merged) setKeyframe(gp, below, m.n, m.d, m.t);
      gp.layers.splice(i, 1);
      gp.active_layer_index = i - 1;
      compactDrawings(gp);
    },
  },
  {
    idname: 'grease_pencil.layer_hide',
    label: 'Hide Layer(s)',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: pollGP,
    exec: (_c, p) => {
      const { gp } = activeGP()!;
      gp.layers.forEach((l, i) => {
        if (p.unselected ? i !== gp.active_layer_index : i === gp.active_layer_index) l.hide = true;
      });
    },
  },
  {
    idname: 'grease_pencil.layer_reveal',
    label: 'Show All Layers',
    poll: pollGP,
    exec: () => {
      for (const l of activeGP()!.gp.layers) l.hide = false;
    },
  },
  {
    idname: 'grease_pencil.layer_lock_all',
    label: 'Lock All Layers',
    props: [{ id: 'lock', label: 'Lock Value', type: 'bool', default: true }],
    poll: pollGP,
    exec: (_c, p) => {
      for (const l of activeGP()!.gp.layers) l.lock = !!p.lock;
    },
  },
  // ------------------------------------------------------------------ keyframes
  {
    idname: 'grease_pencil.insert_blank_frame',
    label: 'Insert Blank Frame',
    description: 'Insert a blank keyframe on the current frame',
    props: [{ id: 'all_layers', label: 'All Layers', type: 'bool', default: false }],
    poll: pollGP,
    exec: (ctx, p) => {
      const { gp } = activeGP()!;
      const layers = editableLayers(gp, !!p.all_layers);
      if (!layers.length) {
        app.report('ERROR', 'No editable layer');
        return 'CANCELLED';
      }
      for (const l of layers) insertBlankFrame(gp, l, ctx.doc.scene.frame_current, ctx.doc.scene.tool_settings.keyframe_type as GPKeyframeType);
    },
  },
  {
    idname: 'grease_pencil.frame_duplicate',
    label: 'Duplicate Active Keyframe',
    description: 'Make a copy of the active keyframe (on the current frame, or the next one when the key is here)',
    props: [{ id: 'all', label: 'All Layers', type: 'bool', default: false }],
    poll: pollGP,
    exec: (ctx, p) => {
      const { gp } = activeGP()!;
      let ok = false;
      for (const l of editableLayers(gp, !!p.all)) ok = duplicateActiveFrame(gp, l, ctx.doc.scene.frame_current) || ok;
      if (!ok) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.delete_frame',
    label: 'Delete Frame',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'ACTIVE_FRAME',
        items: [
          ['ACTIVE_FRAME', 'Active Frame'],
          ['ALL_FRAMES', 'All Active Frames'],
        ],
      },
    ],
    poll: pollGP,
    exec: (ctx, p) => {
      const { gp } = activeGP()!;
      let ok = false;
      for (const l of editableLayers(gp, p.type === 'ALL_FRAMES')) ok = deleteFrameAt(gp, l, ctx.doc.scene.frame_current) || ok;
      if (!ok) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.active_frame_delete',
    label: 'Delete Active Keyframe',
    props: [{ id: 'all', label: 'All Layers', type: 'bool', default: false }],
    poll: pollGP,
    exec: (ctx, p) => {
      const { gp } = activeGP()!;
      let ok = false;
      for (const l of editableLayers(gp, !!p.all)) ok = deleteFrameAt(gp, l, ctx.doc.scene.frame_current) || ok;
      if (!ok) return 'CANCELLED';
    },
  },
  // ------------------------------------------------------------------ materials
  {
    idname: 'grease_pencil.set_active_material',
    label: 'Set Active Material',
    description: 'Make a material slot the active one (by default the material of the first selected stroke)',
    props: [{ id: 'slot', label: 'Slot', type: 'int', default: -1, min: -1 }],
    poll: pollGP,
    exec: (ctx, p) => {
      const { ob, gp } = activeGP()!;
      let slot = p.slot as number;
      if (slot < 0) {
        // from the selection (Edit Mode)
        if (ctx.doc.mode !== 'EDIT') return 'CANCELLED';
        for (const d of gp.drawings) {
          const sel = d.select;
          if (!sel) continue;
          for (let s = 0; s + 1 < d.offsets.length && slot < 0; s++) for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) if (sel[i]) slot = d.material_index[s];
          if (slot >= 0) break;
        }
        if (slot < 0) return 'CANCELLED';
      }
      if (slot >= Math.max(1, gp.materials.length)) return 'CANCELLED';
      ob.active_material_index = slot;
    },
    redo: false,
  },
  {
    idname: 'grease_pencil.set_material',
    label: 'Set Active Material',
    description: 'Make a material slot the active one (new strokes use it)',
    props: [{ id: 'slot', label: 'Slot', type: 'int', default: 0, min: 0 }],
    poll: pollGP,
    exec: (_c, p) => {
      const { ob, gp } = activeGP()!;
      if ((p.slot as number) >= Math.max(1, gp.materials.length)) return 'CANCELLED';
      ob.active_material_index = p.slot as number;
    },
    redo: false,
  },
  {
    idname: 'grease_pencil.material_hide',
    label: 'Hide Materials',
    props: [{ id: 'invert', label: 'Invert', type: 'bool', default: false }],
    poll: pollGP,
    exec: (ctx, p) => {
      const { ob, gp } = activeGP()!;
      gp.materials.forEach((id, i) => {
        const st = id ? ctx.doc.materials[id]?.grease_pencil : undefined;
        if (st && (p.invert ? i !== ob.active_material_index : i === ob.active_material_index)) st.hide = true;
      });
    },
  },
  {
    idname: 'grease_pencil.material_reveal',
    label: 'Show All Materials',
    poll: pollGP,
    exec: (ctx) => {
      for (const id of activeGP()!.gp.materials) {
        const st = id ? ctx.doc.materials[id]?.grease_pencil : undefined;
        if (st) st.hide = false;
      }
    },
  },
  {
    idname: 'grease_pencil.material_lock_all',
    label: 'Lock All Materials',
    poll: pollGP,
    exec: (ctx) => {
      for (const id of activeGP()!.gp.materials) {
        const st = id ? ctx.doc.materials[id]?.grease_pencil : undefined;
        if (st) st.lock = true;
      }
    },
  },
  {
    idname: 'grease_pencil.material_unlock_all',
    label: 'Unlock All Materials',
    poll: pollGP,
    exec: (ctx) => {
      for (const id of activeGP()!.gp.materials) {
        const st = id ? ctx.doc.materials[id]?.grease_pencil : undefined;
        if (st) st.lock = false;
      }
    },
  },
]);

// ---------------------------------------------------------------------------
// generic material slot / mode operators also work on grease pencil objects

function wrap(
  idname: string,
  o: {
    poll?: (ctx: OpContext, base: Operator) => boolean;
    exec?: (ctx: OpContext, p: Record<string, unknown>) => ReturnType<NonNullable<Operator['exec']>>;
  },
) {
  const base = operators.get(idname);
  if (!base) return;
  const basePoll = base.poll,
    baseExec = base.exec;
  base.poll = (ctx) => (isGP(app.activeObject) && o.poll ? o.poll(ctx, base) : !basePoll || basePoll(ctx));
  if (o.exec) base.exec = (ctx, p) => (isGP(app.activeObject) ? o.exec!(ctx, p) : baseExec?.(ctx, p));
}

wrap('object.material_slot_add', {
  poll: () => true,
  exec: () => {
    const { ob, gp } = activeGP()!;
    gp.materials.push(null);
    ob.active_material_index = gp.materials.length - 1;
  },
});
wrap('object.material_slot_remove', {
  poll: () => (activeGP()?.gp.materials.length ?? 0) > 0,
  exec: (ctx) => {
    const { ob, gp } = activeGP()!;
    const i = ob.active_material_index;
    gp.materials.splice(i, 1);
    // strokes using later slots shift down; strokes of the removed slot fall back to slot 0
    for (const d of gp.drawings) {
      const mi = d.material_index.slice();
      for (let k = 0; k < mi.length; k++)
        if (mi[k] > i) mi[k]--;
        else if (mi[k] === i) mi[k] = 0;
      d.material_index = mi;
    }
    ob.active_material_index = Math.max(0, i - 1);
    void ctx;
  },
});
wrap('material.new', {
  poll: () => true,
  exec: (ctx) => {
    const { ob, gp } = activeGP()!;
    const ma = newGPMaterial(uniqueName(ctx.doc, 'Material', 'materials'));
    ctx.doc.materials[ma.id] = ma;
    if (!gp.materials.length) gp.materials.push(null);
    gp.materials[ob.active_material_index] = ma.id;
  },
});
wrap('object.editmode_toggle', { poll: () => true });
