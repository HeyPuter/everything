// More Edit Mode operators: selection (random, alternate, ends, similar, fill), copy / paste,
// separate, split, extrude, arrange, set start point, outline, snapping, join / separate fills,
// subdivide and smooth, plus the radius / opacity transform values (Alt S, Shift F).
import { Matrix3, Matrix4, Vector3, Euler } from 'three';
import { app, registerOperators, operators, type PropDef, type OpContext } from '../app/app';
import { newObject } from '../data/defaults';
import { addObjectToScene } from '../ops/object';
import { startTransform, valueProviders, type TElement } from '../ops/transform';
import { activeView3D } from '../editors/view3d/view3d';
import { gpOf, gpTable, newGreasePencil, newLayer, activeLayer, frameAt, setKeyframe, toStrokes, fromStrokes, normalizeDrawing, uniqueLayerName, type GPPoint, type GPStroke } from './data';
import { editTargets, inGPEdit, drawing, setDrawing, mapStrokes, anySel, strokeMode, type EditTarget } from './edit';
import { editableDrawing } from './paint';
import { layerMatrix } from './render';
import { filterPoints, subdivideStroke, smoothPoints, simplifyPoints } from './strokeops';
import { resamplePoints } from './interpolate';
import { mergeByDistance } from './cleanup';
import type { GPDrawing, GreasePencilData, GPLayer } from './types';
import type { ObjectData } from '../data/types';

const poll = () => inGPEdit();

function ctx(): { ob: ObjectData; gp: GreasePencilData } | null {
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  return ob && gp ? { ob, gp } : null;
}

/** Seeded random numbers in [0, 1). */
export function seeded(seed: number) {
  let s = (seed * 2654435761 + 1013904223) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const deselected = (s: GPStroke): GPStroke => ({ ...s, points: s.points.map((p) => ({ ...p, select: false })) });
const allSelected = (s: GPStroke): GPStroke => ({ ...s, points: s.points.map((p) => ({ ...p, select: true })) });
const clonePt = (p: GPPoint, select = p.select): GPPoint => ({ ...p, co: [...p.co] as GPPoint['co'], vertex_color: [...p.vertex_color] as GPPoint['vertex_color'], select });

// ---------------------------------------------------------------------------
// kernels (pure)

/** Every other point of strokes with a selection (`deselectEnds`: start one later and leave the ends out). */
export function selectAlternate(strokes: GPStroke[], deselectEnds: boolean): GPStroke[] {
  return strokes.map((s) => {
    if (!anySel(s)) return s;
    const n = s.points.length;
    return {
      ...s,
      points: s.points.map((p, i) => ({ ...p, select: deselectEnds ? i % 2 === 1 && i !== n - 1 : i % 2 === 0 })),
    };
  });
}

/** Select only the first `start` and last `end` points of every stroke. */
export function selectEnds(strokes: GPStroke[], start: number, end: number): GPStroke[] {
  return strokes.map((s) => ({ ...s, points: s.points.map((p, i) => ({ ...p, select: i < start || i >= s.points.length - end })) }));
}

/** Split selected runs out of strokes: the runs become new (selected) strokes, the rest keeps the unselected segments. */
export function splitStrokes(strokes: GPStroke[]): GPStroke[] {
  const created: GPStroke[] = [];
  const kept: GPStroke[] = [];
  for (const s of strokes) {
    if (!anySel(s) || s.points.every((p) => p.select)) {
      kept.push(s);
      continue;
    }
    for (const run of filterPoints(s, (p) => !!p.select)) created.push({ ...run, points: run.points.map((p) => clonePt(p, true)) });
    // keep every segment that has an unselected end (cut where both ends are selected)
    const n = s.points.length;
    const segs = s.cyclic ? n : n - 1;
    let cur: GPPoint[] = [];
    const pieces: GPPoint[][] = [];
    for (let i = 0; i < segs; i++) {
      const a = s.points[i],
        b = s.points[(i + 1) % n];
      if (a.select && b.select) {
        if (cur.length) pieces.push(cur);
        cur = [];
        continue;
      }
      if (!cur.length) cur.push(clonePt(a, false));
      cur.push(clonePt(b, false));
    }
    if (cur.length) pieces.push(cur);
    // a cyclic stroke's last piece continues into the first
    if (s.cyclic && pieces.length > 1 && !(s.points[0].select && s.points[n - 1].select) && pieces[pieces.length - 1][pieces[pieces.length - 1].length - 1] && pieces[0][0]) {
      const last = pieces.pop()!;
      pieces[0] = [...last.slice(0, -1), ...pieces[0]];
    }
    for (const p of pieces) kept.push({ ...s, points: p, cyclic: false });
  }
  return [...created, ...kept];
}

/** Extrude: selected stroke ends grow by a new point, other selected points start a new two-point stroke. */
export function extrudeStrokes(strokes: GPStroke[]): GPStroke[] {
  const out: GPStroke[] = [];
  const created: GPStroke[] = [];
  for (const s of strokes) {
    if (!anySel(s)) {
      out.push(s);
      continue;
    }
    const n = s.points.length;
    const pts = s.points.map((p) => clonePt(p, false));
    const startSel = !s.cyclic && s.points[0].select;
    const endSel = !s.cyclic && n > 1 && s.points[n - 1].select;
    s.points.forEach((p, i) => {
      if (!p.select) return;
      if ((i === 0 && startSel) || (i === n - 1 && endSel)) return;
      created.push({ ...s, cyclic: false, points: [clonePt(p, false), clonePt(p, true)] });
    });
    if (startSel) pts.unshift(clonePt(s.points[0], true));
    if (endSel) pts.push(clonePt(s.points[n - 1], true));
    if (n === 1 && s.points[0].select) pts.push(clonePt(s.points[0], true));
    out.push({ ...s, points: pts });
  }
  return [...out, ...created];
}

export type ReorderDirection = 'TOP' | 'UP' | 'DOWN' | 'BOTTOM';

/** Change the drawing order of the selected strokes (later strokes draw on top). */
export function reorderStrokes(strokes: GPStroke[], dir: ReorderDirection): GPStroke[] {
  const sel = strokes.map(anySel);
  if (dir === 'TOP') return [...strokes.filter((_, i) => !sel[i]), ...strokes.filter((_, i) => sel[i])];
  if (dir === 'BOTTOM') return [...strokes.filter((_, i) => sel[i]), ...strokes.filter((_, i) => !sel[i])];
  const out = strokes.slice();
  const flags = sel.slice();
  if (dir === 'UP') {
    for (let i = out.length - 2; i >= 0; i--)
      if (flags[i] && !flags[i + 1]) {
        [out[i], out[i + 1]] = [out[i + 1], out[i]];
        [flags[i], flags[i + 1]] = [flags[i + 1], flags[i]];
      }
  } else {
    for (let i = 1; i < out.length; i++)
      if (flags[i] && !flags[i - 1]) {
        [out[i], out[i - 1]] = [out[i - 1], out[i]];
        [flags[i], flags[i - 1]] = [flags[i - 1], flags[i]];
      }
  }
  return out;
}

/** Cyclic strokes start at their first selected point. */
export function setStartPoint(s: GPStroke): GPStroke {
  if (!s.cyclic) return s;
  const i = s.points.findIndex((p) => p.select);
  if (i <= 0) return s;
  return { ...s, points: [...s.points.slice(i), ...s.points.slice(0, i)] };
}

/** Dissolve the points between the first and last selected point of each stroke. */
export function dissolveBetween(s: GPStroke): GPStroke {
  const first = s.points.findIndex((p) => p.select);
  let last = -1;
  s.points.forEach((p, i) => p.select && (last = i));
  if (first < 0 || last - first < 2) return s;
  return { ...s, points: s.points.filter((_, i) => i <= first || i >= last) };
}

/** Points of the stroke outline (a closed loop around the stroke shape), in the stroke's space. */
export function outlinePoints(s: GPStroke, normal: Vector3, offset: number, subdivisions: number): GPPoint[] {
  const pts = s.points;
  const n = pts.length;
  if (!n) return [];
  const P = pts.map((p) => new Vector3(...p.co));
  const tangent = (i: number) => {
    const a = P[Math.max(0, i - 1)],
      b = P[Math.min(n - 1, i + 1)];
    const t = b.clone().sub(a);
    if (s.cyclic && n > 2) t.copy(P[(i + 1) % n].clone().sub(P[(i - 1 + n) % n]));
    return t.lengthSq() > 1e-20 ? t.normalize() : new Vector3(1, 0, 0);
  };
  const side = (i: number) => {
    const sd = new Vector3().crossVectors(normal, tangent(i));
    return sd.lengthSq() > 1e-20 ? sd.normalize() : new Vector3(0, 0, 1);
  };
  const r = (i: number) => Math.max(1e-6, pts[i].radius + offset);
  const mk = (v: Vector3, i: number): GPPoint => ({ ...clonePt(pts[i], false), co: [v.x, v.y, v.z] });
  const left: GPPoint[] = [],
    right: GPPoint[] = [];
  for (let i = 0; i < n; i++) {
    const sd = side(i).multiplyScalar(r(i));
    left.push(mk(P[i].clone().add(sd), i));
    right.push(mk(P[i].clone().sub(sd), i));
  }
  /** round cap around point i: from `sign`·side through the tangent direction to -`sign`·side */
  const cap = (i: number, sign: number): GPPoint[] => {
    const out: GPPoint[] = [];
    const t = tangent(i).multiplyScalar(sign);
    const sd = side(i).multiplyScalar(sign);
    const m = subdivisions + 1;
    for (let k = 1; k <= m; k++) {
      const a = (Math.PI * k) / (m + 1);
      out.push(mk(P[i].clone().addScaledVector(sd, Math.cos(a) * r(i)).addScaledVector(t, Math.sin(a) * r(i)), i));
    }
    return out;
  };
  // a closed stroke gives its outer loop here (the caller adds the inner one with the normal flipped)
  if (s.cyclic) return left;
  return [...left, ...cap(n - 1, 1), ...right.reverse(), ...cap(0, -1)];
}

// ---------------------------------------------------------------------------
// clipboard

interface Clip {
  layer: string;
  strokes: GPStroke[];
  /** layer → world at copy time */
  world: Matrix4;
}
let clipboard: Clip[] = [];

export function hasClipboard() {
  return clipboard.length > 0;
}

function selectedPart(s: GPStroke): GPStroke[] {
  return filterPoints(s, (p) => !!p.select);
}

// ---------------------------------------------------------------------------
// separate helpers

function newGPObjectLike(src: ObjectData, gp: GreasePencilData, name: string): { ob: ObjectData; gp: GreasePencilData } {
  const doc = app.doc;
  const g = newGreasePencil(name);
  Object.assign(g, {
    materials: gp.materials.slice(),
    stroke_depth_order: gp.stroke_depth_order,
    onion_mode: gp.onion_mode,
    onion_keyframe_type: gp.onion_keyframe_type,
    ghost_before_range: gp.ghost_before_range,
    ghost_after_range: gp.ghost_after_range,
  });
  gpTable(doc)[g.id] = g;
  const ob = newObject(name, 'GREASEPENCIL', g.id);
  const sel = Object.values(doc.objects).filter((o) => o.select);
  const active = doc.scene.active_object;
  addObjectToScene(doc, ob, { location: [...src.location], rotation: [...src.rotation_euler] });
  ob.scale = [...src.scale] as ObjectData['scale'];
  ob.rotation_mode = src.rotation_mode;
  ob.parent = src.parent;
  ob.matrix_parent_inverse = [...src.matrix_parent_inverse] as ObjectData['matrix_parent_inverse'];
  // keep the original active & selected
  for (const o of sel) o.select = true;
  doc.scene.active_object = active;
  return { ob, gp: g };
}

function layerLike(dst: GreasePencilData, src: GPLayer): GPLayer {
  let l = dst.layers.find((x) => x.name === src.name);
  if (!l) {
    l = { ...structuredClone({ ...src, frames: [] }), frames: [] };
    dst.layers.push(l);
  }
  return l;
}

/** Move strokes chosen by `take` (per layer key) into new objects grouped by `group`; returns the objects made. */
function separateBy(c: { ob: ObjectData; gp: GreasePencilData }, take: (s: GPStroke, layer: GPLayer) => { moved: GPStroke[]; kept: GPStroke[] }, group: (s: GPStroke, layer: GPLayer) => string): number {
  const targets = new Map<string, { ob: ObjectData; gp: GreasePencilData }>();
  let moved = 0;
  for (const t of editTargets()) {
    const fr = t.layer.frames.find((f) => f.drawing === t.idx);
    if (!fr) continue;
    const ss = toStrokes(drawing(t));
    const keep: GPStroke[] = [];
    const byGroup = new Map<string, GPStroke[]>();
    for (const s of ss) {
      const r = take(s, t.layer);
      keep.push(...r.kept);
      for (const m of r.moved) {
        const g = group(m, t.layer);
        (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(m);
      }
    }
    if (!byGroup.size) continue;
    setDrawing(t, fromStrokes(keep));
    for (const [g, list] of byGroup) {
      let tgt = targets.get(g);
      if (!tgt) {
        tgt = newGPObjectLike(c.ob, c.gp, `${c.ob.name}`);
        targets.set(g, tgt);
      }
      const l = layerLike(tgt.gp, t.layer);
      const existing = l.frames.find((f) => f.frame_number === fr.frame_number);
      const d = existing ? fromStrokes([...toStrokes(tgt.gp.drawings[existing.drawing]), ...list]) : fromStrokes(list);
      setKeyframe(tgt.gp, l, fr.frame_number, d, fr.keyframe_type);
      moved += list.length;
    }
  }
  for (const { gp } of targets.values()) gp.active_layer_index = Math.max(0, gp.layers.length - 1);
  return moved ? targets.size : 0;
}

// ---------------------------------------------------------------------------
// operators

const SIMILAR: [string, string, string?][] = [
  ['LAYER', 'Layer', 'Strokes on the same layers'],
  ['MATERIAL', 'Material', 'Strokes with the same materials'],
  ['VERTEX_COLOR', 'Vertex Color', 'Points with a similar vertex color'],
  ['RADIUS', 'Radius', 'Points with a similar radius'],
  ['OPACITY', 'Opacity', 'Points with a similar opacity'],
];

function updateSelection(fn: (strokes: GPStroke[], t: EditTarget) => GPStroke[] | null) {
  // selection only: the drawing keeps its geometry arrays
  for (const t of editTargets()) {
    const out = fn(toStrokes(drawing(t)), t);
    if (!out) continue;
    const d = drawing(t);
    const sel = new Uint8Array(d.select!.length);
    let i = 0;
    for (const s of out) for (const p of s.points) sel[i++] = p.select ? 1 : 0;
    setDrawing(t, { ...d, select: sel });
  }
  app.changed('select');
}

const subdivideProps: PropDef[] = [
  { id: 'number_cuts', label: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 32 },
  { id: 'only_selected', label: 'Selected Points', type: 'bool', default: true },
];

registerOperators([
  // ------------------------------------------------------------------ select
  {
    idname: 'grease_pencil.select_random',
    label: 'Select Random',
    description: 'Randomly select or deselect points (whole strokes in stroke selection mode)',
    props: [
      { id: 'ratio', label: 'Ratio', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0, max: 100000 },
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'SELECT',
        items: [
          ['SELECT', 'Select'],
          ['DESELECT', 'Deselect'],
        ],
      },
    ],
    poll,
    exec: (_c, p) => {
      const rnd = seeded(p.seed as number);
      const on = p.action === 'SELECT';
      const ratio = p.ratio as number;
      const byStroke = strokeMode();
      updateSelection((ss) =>
        ss.map((s) => {
          if (byStroke) {
            const hit = rnd() < ratio;
            return { ...s, points: s.points.map((q) => ({ ...q, select: hit ? on : q.select })) };
          }
          return { ...s, points: s.points.map((q) => ({ ...q, select: rnd() < ratio ? on : q.select })) };
        }),
      );
    },
  },
  {
    idname: 'grease_pencil.select_alternate',
    label: 'Select Alternate',
    description: 'Select every other point of the strokes that have a selection',
    props: [{ id: 'deselect_ends', label: 'Deselect Ends', type: 'bool', default: false }],
    poll,
    exec: (_c, p) => updateSelection((ss) => selectAlternate(ss, !!p.deselect_ends)),
  },
  {
    idname: 'grease_pencil.select_ends',
    label: 'Select Ends',
    description: 'Select the first and last points of every stroke',
    props: [
      { id: 'amount_start', label: 'Amount Start', type: 'int', default: 0, min: 0, max: 1000 },
      { id: 'amount_end', label: 'Amount End', type: 'int', default: 1, min: 0, max: 1000 },
    ],
    poll,
    exec: (_c, p) => updateSelection((ss) => selectEnds(ss, p.amount_start as number, p.amount_end as number)),
  },
  {
    idname: 'grease_pencil.select_similar',
    label: 'Select Similar',
    description: 'Select strokes or points similar to the selected ones',
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: 'LAYER', items: SIMILAR },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.1, min: 0, max: 100 },
    ],
    poll,
    exec: (_c, p) => {
      const mode = p.mode as string;
      const th = p.threshold as number;
      const targets = editTargets();
      const all = targets.map((t) => ({ t, ss: toStrokes(drawing(t)) }));
      const layers = new Set<GPLayer>(),
        mats = new Set<number>();
      const values: number[][] = [];
      for (const { t, ss } of all)
        for (const s of ss) {
          if (!anySel(s)) continue;
          layers.add(t.layer);
          mats.add(s.material_index);
          for (const q of s.points) if (q.select) values.push(mode === 'VERTEX_COLOR' ? q.vertex_color.slice(0, 3) : mode === 'RADIUS' ? [q.radius] : [q.opacity]);
        }
      if (!layers.size) return 'CANCELLED';
      const near = (v: number[]) => values.some((w) => Math.hypot(...v.map((x, i) => x - w[i])) <= th + 1e-9);
      updateSelection((ss, t) =>
        ss.map((s) => {
          if (mode === 'LAYER') return layers.has(t.layer) ? allSelected(s) : s;
          if (mode === 'MATERIAL') return mats.has(s.material_index) ? allSelected(s) : s;
          return {
            ...s,
            points: s.points.map((q) => ({ ...q, select: q.select || near(mode === 'VERTEX_COLOR' ? q.vertex_color.slice(0, 3) : mode === 'RADIUS' ? [q.radius] : [q.opacity]) })),
          };
        }),
      );
    },
  },
  {
    idname: 'grease_pencil.select_fill',
    label: 'Select Fill',
    description: 'Select every stroke that fills together with a selected stroke',
    poll,
    exec: () =>
      updateSelection((ss) => {
        const ids = new Set(ss.filter((s) => anySel(s) && s.fill_id).map((s) => s.fill_id));
        return ss.map((s) => (anySel(s) || (s.fill_id && ids.has(s.fill_id)) ? allSelected(s) : s));
      }),
  },
  // ------------------------------------------------------------------ clipboard
  {
    idname: 'grease_pencil.copy',
    label: 'Copy Strokes',
    description: 'Copy the selected strokes (or parts of strokes) to the clipboard',
    poll,
    undo: false,
    exec: () => {
      const clips: Clip[] = [];
      for (const t of editTargets()) {
        const parts = toStrokes(drawing(t)).flatMap(selectedPart);
        if (parts.length) clips.push({ layer: t.layer.name, strokes: parts.map(deselected), world: t.world.clone() });
      }
      if (!clips.length) return 'CANCELLED';
      clipboard = clips;
      app.report('INFO', `Copied ${clips.reduce((a, c) => a + c.strokes.length, 0)} stroke(s)`);
    },
  },
  {
    idname: 'grease_pencil.paste',
    label: 'Paste Strokes',
    description: 'Paste the copied strokes into the active layer (or the layers they came from)',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'ACTIVE',
        items: [
          ['ACTIVE', 'Paste to Active', 'Paste into the active layer'],
          ['LAYER', 'Paste by Layer', 'Paste into the layers with the original names'],
        ],
      },
      { id: 'paste_back', label: 'Paste on Back', type: 'bool', default: false },
      { id: 'keep_world_transform', label: 'Keep World Transform', type: 'bool', default: false },
    ],
    poll: () => !!ctx() && (app.doc.mode === 'EDIT' || app.doc.mode === 'PAINT_GREASE_PENCIL' || app.doc.mode === 'SCULPT_GREASE_PENCIL') && hasClipboard(),
    exec: (c, p) => {
      const { ob, gp } = ctx()!;
      const frame = c.doc.scene.frame_current;
      const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
      // deselect everything already there
      if (inGPEdit()) for (const t of editTargets()) setDrawing(t, { ...drawing(t), select: new Uint8Array(drawing(t).select!.length) });
      let n = 0;
      for (const clip of clipboard) {
        let layer = p.type === 'LAYER' ? gp.layers.find((l) => l.name === clip.layer) : null;
        layer ??= activeLayer(gp);
        if (!layer || layer.lock) continue;
        const idx = editableDrawing(gp, layer, frame, false);
        const inv = obWorld.clone().multiply(layerMatrix(layer)).invert();
        const v = new Vector3();
        const strokes = clip.strokes.map((s) => ({
          ...s,
          points: s.points.map((q) => {
            const co = p.keep_world_transform ? v.set(...q.co).applyMatrix4(clip.world).applyMatrix4(inv) : v.set(...q.co);
            return { ...clonePt(q, true), co: [co.x, co.y, co.z] as GPPoint['co'] };
          }),
        }));
        const cur = toStrokes(normalizeDrawing(gp.drawings[idx])).map(deselected);
        gp.drawings[idx] = fromStrokes(p.paste_back ? [...strokes, ...cur] : [...cur, ...strokes]);
        n += strokes.length;
      }
      if (!n) return 'CANCELLED';
    },
  },
  // ------------------------------------------------------------------ structure
  {
    idname: 'grease_pencil.separate',
    label: 'Separate',
    description: 'Move strokes into a new Grease Pencil object',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'SELECTED',
        items: [
          ['SELECTED', 'Selection', 'Separate the selected points'],
          ['MATERIAL', 'By Material', 'One object per material'],
          ['LAYER', 'By Layer', 'One object per layer'],
        ],
      },
    ],
    poll,
    exec: (_c, p) => {
      const c = ctx()!;
      let made = 0;
      if (p.mode === 'SELECTED')
        made = separateBy(
          c,
          (s) => (anySel(s) ? { moved: selectedPart(s).map(deselected), kept: filterPoints(s, (q) => !q.select) } : { moved: [], kept: [s] }),
          () => 'sel',
        );
      else if (p.mode === 'MATERIAL') {
        // the first material used stays on the original object
        const used = [...new Set(editTargets().flatMap((t) => [...drawing(t).material_index]))].sort((a, b) => a - b);
        const stay = used[0];
        made = separateBy(c, (s) => (s.material_index === stay ? { moved: [], kept: [s] } : { moved: [s], kept: [] }), (s) => `m${s.material_index}`);
      } else {
        // every layer but the active one goes to an object of its own
        const stay = activeLayer(c.gp);
        made = separateBy(c, (s, l) => (l === stay ? { moved: [], kept: [s] } : { moved: [s], kept: [] }), (_s, l) => l.name);
      }
      if (!made) {
        app.report('ERROR', 'Nothing to separate');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'grease_pencil.stroke_split',
    label: 'Split Stroke',
    description: 'Split the selected points off into new strokes',
    poll,
    exec: () => {
      if (!mapStrokes((ss) => (ss.some(anySel) ? splitStrokes(ss) : null))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.extrude',
    label: 'Extrude Stroke Points',
    description: 'Extend the strokes from their selected end points (other selected points start new strokes)',
    poll,
    exec: () => {
      if (!mapStrokes((ss) => (ss.some(anySel) ? extrudeStrokes(ss) : null))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.extrude_move',
    label: 'Extrude Stroke Points',
    description: 'Extrude the selected points and move them',
    props: [{ id: 'value', label: 'Move', type: 'vec3', default: [0, 0, 0], subtype: 'distance' }],
    poll,
    invoke: (c) => macroMove('grease_pencil.extrude', 'grease_pencil.extrude_move', 'Extrude Stroke Points', c.event),
    exec: (c, p) => macroExec('grease_pencil.extrude', c, p),
  },
  {
    idname: 'grease_pencil.duplicate_move',
    label: 'Duplicate Strokes',
    description: 'Duplicate the selected points and move them',
    props: [{ id: 'value', label: 'Move', type: 'vec3', default: [0, 0, 0], subtype: 'distance' }],
    poll,
    invoke: (c) => macroMove('grease_pencil.duplicate', 'grease_pencil.duplicate_move', 'Duplicate Strokes', c.event),
    exec: (c, p) => macroExec('grease_pencil.duplicate', c, p),
  },
  {
    idname: 'grease_pencil.reorder',
    label: 'Reorder',
    description: 'Change the drawing order of the selected strokes',
    props: [
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'TOP',
        items: [
          ['TOP', 'Bring to Front'],
          ['UP', 'Bring Forward'],
          ['DOWN', 'Send Backward'],
          ['BOTTOM', 'Send to Back'],
        ],
      },
    ],
    poll,
    exec: (_c, p) => {
      if (!mapStrokes((ss) => (ss.some(anySel) ? reorderStrokes(ss, p.direction as ReorderDirection) : null))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.set_start_point',
    label: 'Set Start Point',
    description: 'Make the selected point the first point of its closed stroke',
    poll,
    exec: () => {
      if (!mapStrokes((ss) => (ss.some((s) => s.cyclic && anySel(s)) ? ss.map((s) => (anySel(s) ? setStartPoint(s) : s)) : null))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.stroke_subdivide_smooth',
    label: 'Subdivide and Smooth',
    description: 'Subdivide the selected strokes and smooth the new points',
    props: [
      ...subdivideProps,
      { id: 'iterations', label: 'Iterations', type: 'int', default: 5, min: 1, max: 100 },
      { id: 'factor', label: 'Factor', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
    ],
    poll,
    exec: (_c, p) => {
      if (
        !mapStrokes((ss) =>
          ss.some(anySel)
            ? ss.map((s) => {
                if (!anySel(s)) return s;
                const sub = subdivideStroke(s, p.number_cuts as number, !!p.only_selected);
                return { ...sub, points: smoothPoints(sub.points, (p.factor as number) * 0.5, p.iterations as number, sub.cyclic, { position: true, radius: true, opacity: false }, (i) => (sub.points[i].select ? 1 : 0)) };
              })
            : null,
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.outline',
    label: 'Outline',
    description: 'Turn the selected strokes into closed strokes following their outline',
    props: [
      {
        id: 'type',
        label: 'Projection Mode',
        type: 'enum',
        default: 'VIEW',
        items: [
          ['VIEW', 'View'],
          ['FRONT', 'Front'],
          ['SIDE', 'Side'],
          ['TOP', 'Top'],
          ['CURSOR', 'Cursor'],
          ['CAMERA', 'Camera'],
        ],
      },
      { id: 'radius', label: 'Radius', type: 'float', default: 0.01, min: 0, max: 10, subtype: 'distance' },
      { id: 'offset_factor', label: 'Offset Factor', type: 'float', default: -1, min: -1, max: 1, subtype: 'factor' },
      { id: 'corner_subdivisions', label: 'Corner Subdivisions', type: 'int', default: 2, min: 0, max: 10 },
    ],
    poll,
    exec: (c, p) => {
      const v = activeView3D();
      const type = p.type as string;
      const camOb = c.doc.scene.camera ? c.doc.objects[c.doc.scene.camera] : null;
      const worldNormal =
        type === 'FRONT'
          ? new Vector3(0, 1, 0)
          : type === 'SIDE'
            ? new Vector3(1, 0, 0)
            : type === 'TOP'
              ? new Vector3(0, 0, 1)
              : type === 'CURSOR'
                ? new Vector3(0, 0, 1).applyEuler(new Euler(...c.doc.scene.cursor.rotation_euler, 'XYZ'))
                : type === 'CAMERA' && camOb
                  ? new Vector3(0, 0, 1).applyMatrix3(new Matrix3().setFromMatrix4(app.graph.get(camOb.id)?.world ?? new Matrix4()))
                  : v
                    ? new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion)
                    : new Vector3(0, 1, 0);
      const radius = p.radius as number;
      if (
        !mapStrokes((ss, t) => {
          if (!ss.some(anySel)) return null;
          const n = worldNormal.clone().applyMatrix3(new Matrix3().setFromMatrix4(t.world.clone().invert())).normalize();
          const off = ((p.offset_factor as number) * radius) as number;
          return ss.flatMap((s) => {
            if (!anySel(s)) return [s];
            const outer = outlinePoints(s, n, off, p.corner_subdivisions as number).map((q) => ({ ...q, radius, select: true }));
            const res: GPStroke[] = [{ ...s, points: outer, cyclic: true }];
            if (s.cyclic) {
              const inner = outlinePoints(s, n.clone().negate(), off, p.corner_subdivisions as number).map((q) => ({ ...q, radius, select: true }));
              res.push({ ...s, points: inner.reverse(), cyclic: true });
            }
            return res;
          });
        })
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.join_fills',
    label: 'Join Fills',
    description: 'Fill the selected strokes together (inner strokes become holes)',
    poll,
    exec: () => {
      const { gp } = ctx()!;
      let next = 1;
      for (const d of gp.drawings) for (const id of d.fill_id ?? []) next = Math.max(next, id + 1);
      if (!mapStrokes((ss) => (ss.filter(anySel).length > 1 ? ss.map((s) => (anySel(s) ? { ...s, fill_id: next } : s)) : null))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.separate_fills',
    label: 'Separate Fills',
    description: 'Fill the selected strokes on their own again',
    props: [{ id: 'individual', label: 'Individual', type: 'bool', default: true }],
    poll,
    exec: () => {
      if (!mapStrokes((ss) => (ss.some((s) => anySel(s) && s.fill_id) ? ss.map((s) => (anySel(s) ? { ...s, fill_id: 0 } : s)) : null))) return 'CANCELLED';
    },
  },
  // ------------------------------------------------------------------ snapping
  {
    idname: 'grease_pencil.snap_to_grid',
    label: 'Snap Selection to Grid',
    description: 'Move the selected points to the nearest grid point',
    poll,
    exec: () => {
      const g = activeView3D()?.overlay.grid_scale || 1;
      if (!snapSelected((w) => w.set(Math.round(w.x / g) * g, Math.round(w.y / g) * g, Math.round(w.z / g) * g))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.snap_to_cursor',
    label: 'Snap Selection to Cursor',
    description: 'Move the selected points to the 3D cursor',
    props: [{ id: 'use_offset', label: 'With Offset', type: 'bool', default: true }],
    poll,
    exec: (c, p) => {
      const cur = new Vector3(...c.doc.scene.cursor.location);
      const center = selectionCenter();
      if (!center) return 'CANCELLED';
      if (!snapSelected((w) => (p.use_offset ? w.add(cur).sub(center) : w.copy(cur)))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.snap_cursor_to_selected',
    label: 'Snap Cursor to Selected Points',
    description: 'Move the 3D cursor to the middle of the selected points',
    poll,
    exec: (c) => {
      const center = selectionCenter();
      if (!center) return 'CANCELLED';
      c.doc.scene.cursor.location = [center.x, center.y, center.z];
    },
  },
]);

/** Run an operator's exec without its own undo step, then move the result (one undo step, like a macro). */
export function macroMove(first: string, idname: string, label: string, event?: { x: number; y: number }) {
  const op = operators.get(first);
  if (!op?.exec || op.exec(app.context(), {}) === 'CANCELLED') return 'CANCELLED' as const;
  app.changed('doc');
  app.flush();
  const ok = startTransform('TRANSLATION', { event, label, redo: (v) => ({ idname, props: { value: v } }) });
  return ok ? ('RUNNING_MODAL' as const) : ('FINISHED' as const);
}

export function macroExec(first: string, c: OpContext, p: Record<string, unknown>) {
  const op = operators.get(first);
  if (!op?.exec || op.exec(c, {}) === 'CANCELLED') return 'CANCELLED' as const;
  const v = new Vector3(...((p.value as number[]) ?? [0, 0, 0]));
  if (v.lengthSq() > 0) snapSelected((w) => w.add(v));
}

function selectionCenter(): Vector3 | null {
  const c = new Vector3();
  let n = 0;
  const w = new Vector3();
  for (const t of editTargets()) {
    const d = drawing(t);
    for (let i = 0; i < d.select!.length; i++)
      if (d.select![i]) {
        c.add(w.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world));
        n++;
      }
  }
  return n ? c.multiplyScalar(1 / n) : null;
}

/** Move every selected point through `fn` (world space). */
function snapSelected(fn: (w: Vector3) => Vector3): boolean {
  let any = false;
  const w = new Vector3();
  for (const t of editTargets()) {
    const d = drawing(t);
    if (!d.select!.some((x) => x)) continue;
    const inv = t.world.clone().invert();
    const pos = d.position.slice();
    for (let i = 0; i < d.select!.length; i++) {
      if (!d.select![i]) continue;
      w.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(t.world);
      fn(w).applyMatrix4(inv);
      pos[i * 3] = w.x;
      pos[i * 3 + 1] = w.y;
      pos[i * 3 + 2] = w.z;
    }
    setDrawing(t, { ...d, position: pos });
    any = true;
  }
  return any;
}

// ---------------------------------------------------------------------------
// existing operators: options matching the full set

function patchOp(idname: string, props: PropDef[], exec: (p: Record<string, unknown>) => 'CANCELLED' | void) {
  const op = operators.get(idname);
  if (!op) return;
  op.props = props;
  op.exec = (_c, p) => exec(p);
}

patchOp(
  'grease_pencil.select_linked',
  [{ id: 'deselect', label: 'Deselect', type: 'bool', default: false }],
  (p) => updateSelection((ss) => ss.map((s) => (anySel(s) ? (p.deselect ? deselected(s) : allSelected(s)) : s))),
);

patchOp(
  'grease_pencil.dissolve',
  [
    {
      id: 'type',
      label: 'Type',
      type: 'enum',
      default: 'POINTS',
      items: [
        ['POINTS', 'Dissolve', 'Dissolve the selected points'],
        ['BETWEEN', 'Dissolve Between', 'Dissolve the points between selected points'],
        ['UNSELECT', 'Dissolve Unselected', 'Dissolve the unselected points of strokes with a selection'],
      ],
    },
  ],
  (p) => {
    const t = p.type as string;
    const ok = mapStrokes((ss) =>
      ss.some(anySel)
        ? ss
            .map((s) => {
              if (!anySel(s)) return s;
              if (t === 'BETWEEN') return dissolveBetween(s);
              return { ...s, points: s.points.filter((q) => (t === 'UNSELECT' ? q.select : !q.select)) };
            })
            .filter((s) => s.points.length > 0)
        : null,
    );
    if (!ok) return 'CANCELLED';
  },
);

patchOp(
  'grease_pencil.join_selection',
  [
    {
      id: 'type',
      label: 'Type',
      type: 'enum',
      default: 'JOINSTROKES',
      items: [
        ['JOINSTROKES', 'Join Strokes', 'Join the selected strokes into one'],
        ['SPLITCOPY', 'Join and Copy', 'Copy the selected points into one new stroke'],
        ['SPLIT', 'Join', 'Move the selected points into one new stroke'],
      ],
    },
  ],
  (p) => {
    const t = p.type as string;
    const ok = mapStrokes((ss) => {
      const sel = ss.filter(anySel);
      if (sel.length < 2) return null;
      if (t === 'JOINSTROKES') {
        const j = joinChain(sel);
        const first = ss.indexOf(sel[0]);
        const out = ss.filter((s) => !sel.includes(s));
        out.splice(first, 0, j);
        return out;
      }
      const parts = sel.flatMap(selectedPart);
      const j = joinChain(parts.map(allSelected));
      const rest = t === 'SPLIT' ? ss.flatMap((s) => (anySel(s) ? filterPoints(s, (q) => !q.select) : [s])) : ss.map(deselected);
      return [...rest, j];
    });
    if (!ok) return 'CANCELLED';
  },
);

function joinChain(strokes: GPStroke[]): GPStroke {
  // chain each next stroke by the nearest end
  const d = (a: GPPoint, b: GPPoint) => Math.hypot(a.co[0] - b.co[0], a.co[1] - b.co[1], a.co[2] - b.co[2]);
  const rest = strokes.slice(1).map((s) => s.points.slice());
  let pts = strokes[0].points.slice();
  while (rest.length) {
    const end = pts[pts.length - 1];
    let bi = 0,
      rev = false,
      bd = Infinity;
    rest.forEach((r, i) => {
      if (d(end, r[0]) < bd) [bd, bi, rev] = [d(end, r[0]), i, false];
      if (d(end, r[r.length - 1]) < bd) [bd, bi, rev] = [d(end, r[r.length - 1]), i, true];
    });
    const nx = rest.splice(bi, 1)[0];
    pts = pts.concat(rev ? nx.reverse() : nx);
  }
  return { ...strokes[0], points: pts, cyclic: false };
}

patchOp(
  'grease_pencil.set_uniform_opacity',
  [
    { id: 'opacity_stroke', label: 'Stroke Opacity', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
    { id: 'opacity_fill', label: 'Fill Opacity', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
  ],
  (p) => {
    const ok = mapStrokes((ss) =>
      ss.some(anySel) ? ss.map((s) => (anySel(s) ? { ...s, fill_opacity: p.opacity_fill as number, points: s.points.map((q) => ({ ...q, opacity: p.opacity_stroke as number })) } : s)) : null,
    );
    if (!ok) return 'CANCELLED';
  },
);

patchOp(
  'grease_pencil.cyclical_set',
  [
    {
      id: 'type',
      label: 'Type',
      type: 'enum',
      default: 'TOGGLE',
      items: [
        ['CLOSE', 'Close All'],
        ['OPEN', 'Open All'],
        ['TOGGLE', 'Toggle'],
      ],
    },
    { id: 'subdivide_cyclic_segment', label: 'Match Point Density', type: 'bool', default: true },
  ],
  (p) => {
    const ok = mapStrokes((ss) =>
      ss.some(anySel)
        ? ss.map((s) => {
            if (!anySel(s)) return s;
            const close = p.type === 'CLOSE' ? true : p.type === 'OPEN' ? false : !s.cyclic;
            if (!close || s.cyclic || !p.subdivide_cyclic_segment || s.points.length < 2) return { ...s, cyclic: close };
            // fill the closing gap with points spaced like the rest of the stroke
            const pts = s.points;
            let len = 0;
            for (let i = 1; i < pts.length; i++) len += Math.hypot(...pts[i].co.map((x, k) => x - pts[i - 1].co[k]));
            const avg = len / (pts.length - 1);
            const a = pts[pts.length - 1],
              b = pts[0];
            const gap = Math.hypot(...a.co.map((x, k) => x - b.co[k]));
            const cuts = avg > 1e-9 ? Math.min(1000, Math.max(0, Math.round(gap / avg) - 1)) : 0;
            const extra: GPPoint[] = [];
            for (let k = 1; k <= cuts; k++) {
              const f = k / (cuts + 1);
              extra.push({
                ...clonePt(a, false),
                co: a.co.map((x, i) => x + (b.co[i] - x) * f) as GPPoint['co'],
                radius: a.radius + (b.radius - a.radius) * f,
                opacity: a.opacity + (b.opacity - a.opacity) * f,
              });
            }
            return { ...s, cyclic: true, points: [...pts, ...extra] };
          })
        : null,
    );
    if (!ok) return 'CANCELLED';
  },
);

patchOp(
  'grease_pencil.move_to_layer',
  [
    { id: 'target_layer_name', label: 'Name', type: 'string', default: '' },
    { id: 'add_new_layer', label: 'New Layer', type: 'bool', default: false },
  ],
  (p) => {
    const { gp } = ctx()!;
    const name = (p.target_layer_name as string) || 'Layer';
    let target = p.add_new_layer ? undefined : gp.layers.find((l) => l.name === name);
    if (!target) {
      target = newLayer(uniqueLayerName(gp, name));
      gp.layers.push(target);
    }
    const frame = app.doc.scene.frame_current;
    const moved: GPStroke[] = [];
    for (const t of editTargets()) {
      if (t.layer === target) continue;
      const ss = toStrokes(drawing(t));
      if (!ss.some(anySel)) continue;
      // selected parts move, the rest stays
      for (const s of ss) if (anySel(s)) moved.push(...selectedPart(s));
      setDrawing(t, fromStrokes(ss.flatMap((s) => (anySel(s) ? filterPoints(s, (q) => !q.select) : [s]))));
    }
    if (!moved.length) return 'CANCELLED';
    const fr = frameAt(target, frame);
    const idx = fr && fr.frame_number === frame ? fr.drawing : setKeyframe(gp, target, frame, fromStrokes([])).drawing;
    gp.drawings[idx] = fromStrokes([...toStrokes(normalizeDrawing(gp.drawings[idx])), ...moved]);
  },
);

// ---------------------------------------------------------------------------
// Alt S (radius) and Shift F (opacity) in Edit Mode: per point values scaled by the transform factor

valueProviders.push({
  collect({ mode }) {
    if (!inGPEdit() || (mode !== 'CURVE_SHRINKFATTEN' && mode !== 'GPENCIL_OPACITY')) return null;
    const elements: TElement[] = [];
    const live: { t: EditTarget; d: GPDrawing; key: 'radius' | 'opacity'; before: Float32Array }[] = [];
    const key = mode === 'CURVE_SHRINKFATTEN' ? 'radius' : 'opacity';
    const w = new Vector3();
    for (const t of editTargets()) {
      const d0 = drawing(t);
      if (!d0.select!.some((x) => x)) continue;
      const before = d0[key];
      const d = { ...d0, [key]: before.slice() } as GPDrawing;
      setDrawing(t, d);
      live.push({ t, d, key, before });
      for (let i = 0; i < d.select!.length; i++) {
        if (!d.select![i]) continue;
        const v0 = before[i];
        elements.push({
          center: w.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world).clone(),
          basis: new Matrix3(),
          weight: 1,
          apply(_m, c) {
            const f = c.value[0] ?? 1;
            d[key][i] = key === 'radius' ? Math.max(0, v0 * f) : Math.max(0, Math.min(1, v0 * f));
          },
          restore() {
            d[key][i] = v0;
          },
        });
      }
    }
    if (!elements.length) return null;
    const bump = () => {
      for (const l of live) setDrawing(l.t, { ...l.d, [l.key]: l.d[l.key].slice() } as GPDrawing);
    };
    return {
      elements,
      label: 'Grease Pencil',
      finish: bump,
      cancel: () => live.forEach((l) => setDrawing(l.t, { ...l.d, [l.key]: l.before } as GPDrawing)),
      onUpdate: () => {
        bump();
        app.changed('doc');
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Simplify modes and shape-keeping smooth

/** Remove every other point `steps` times (stroke ends stay). */
export function simplifyFixed(points: GPPoint[], steps: number): GPPoint[] {
  let pts = points;
  for (let k = 0; k < steps && pts.length > 2; k++) pts = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
  return pts;
}

/** Points every `length` along the stroke (plus the last point of open strokes). */
export function sampleByLength(points: GPPoint[], length: number, cyclic: boolean): GPPoint[] {
  if (points.length < 2 || length <= 0) return points;
  let total = 0;
  const pts = cyclic ? [...points, points[0]] : points;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(...pts[i].co.map((x, k) => x - pts[i - 1].co[k]));
  const n = Math.max(cyclic ? 3 : 2, Math.round(total / length) + (cyclic ? 0 : 1));
  return resamplePoints(points, n, cyclic);
}

patchOp(
  'grease_pencil.stroke_simplify',
  [
    {
      id: 'mode',
      label: 'Mode',
      type: 'enum',
      default: 'FIXED',
      items: [
        ['FIXED', 'Fixed', 'Delete every other point, a number of times'],
        ['ADAPTIVE', 'Adaptive', 'Remove points that hardly change the shape'],
        ['SAMPLE', 'Sample', 'Re-place the points at an even spacing'],
        ['MERGE', 'Merge', 'Merge points closer than a distance'],
      ],
    },
    { id: 'steps', label: 'Steps', type: 'int', default: 1, min: 0, max: 50, showIf: (p) => p.mode === 'FIXED' },
    { id: 'factor', label: 'Factor', type: 'float', default: 0.01, min: 0, max: 100, subtype: 'distance', showIf: (p) => p.mode === 'ADAPTIVE' },
    { id: 'length', label: 'Length', type: 'float', default: 0.05, min: 0.001, max: 100, subtype: 'distance', showIf: (p) => p.mode === 'SAMPLE' },
    { id: 'distance', label: 'Distance', type: 'float', default: 0.01, min: 0, max: 100, subtype: 'distance', showIf: (p) => p.mode === 'MERGE' },
  ],
  (p) => {
    const mode = p.mode as string;
    const ok = mapStrokes((ss) =>
      ss.some(anySel)
        ? ss.map((s) => {
            if (!anySel(s)) return s;
            const pts =
              mode === 'FIXED'
                ? simplifyFixed(s.points, p.steps as number)
                : mode === 'ADAPTIVE'
                  ? simplifyPoints(s.points, p.factor as number)
                  : mode === 'SAMPLE'
                    ? sampleByLength(s.points, p.length as number, s.cyclic).map((q) => ({ ...q, select: true }))
                    : mergeByDistance(s.points, p.distance as number);
            return { ...s, points: pts };
          })
        : null,
    );
    if (!ok) return 'CANCELLED';
  },
);

{
  // Keep Shape: alternate shrinking and inflating passes so the stroke smooths without shrinking
  const op = operators.get('grease_pencil.stroke_smooth');
  const base = op?.exec;
  if (op && base) {
    op.props = [...(op.props ?? []).filter((d) => d.id !== 'keep_shape'), { id: 'keep_shape', label: 'Keep Shape', type: 'bool', default: false }];
    op.exec = (c, p) => {
      if (!p.keep_shape) return base(c, p);
      const what = { position: !!p.smooth_position, radius: !!p.smooth_radius, opacity: !!p.smooth_opacity };
      const f = (p.factor as number) * 0.5;
      const ok = mapStrokes((ss) =>
        ss.some(anySel)
          ? ss.map((s) => {
              if (!anySel(s)) return s;
              const mask = (i: number) => (s.points[i].select ? 1 : 0);
              let pts = s.points;
              for (let k = 0; k < (p.iterations as number); k++) {
                pts = smoothPoints(pts, f, 1, s.cyclic, what, mask);
                pts = smoothPoints(pts, -f * 1.05, 1, s.cyclic, what, mask);
              }
              return { ...s, points: pts };
            })
          : null,
      );
      if (!ok) return 'CANCELLED';
    };
  }
}
