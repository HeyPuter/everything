// Grease Pencil data helpers: factories, drawing (struct-of-arrays) <-> stroke lists, keyframe
// lookup and onion skin ranges. Pure document logic (no DOM / WebGL) so it can be unit tested.
import type { DocumentData, ObjectData, MaterialData, ID, Color } from '../data/types';
import { uid, newMaterial } from '../data/defaults';
import { ensureHandles, deriveHandles } from './curves';
import type { GPDrawing, GPFrame, GPLayer, GreasePencilData, MaterialGPencilStyle, GPToolSettings, GPBrush, GPKeyframeType } from './types';

// ---------------------------------------------------------------------------
// strokes as plain objects (convenient for editing operations)

export interface GPPoint {
  co: [number, number, number];
  radius: number;
  opacity: number;
  /** RGBA, alpha = mix factor */
  vertex_color: [number, number, number, number];
  select?: boolean;
  /** vertex group weights by group name */
  weights?: Record<string, number>;
  /** Bézier handles (layer space) and their types (0 free, 1 auto, 2 vector, 3 align) */
  handle_left?: [number, number, number];
  handle_right?: [number, number, number];
  handle_type_left?: number;
  handle_type_right?: number;
  select_left?: boolean;
  select_right?: boolean;
  /** corner limit angle (radians; 0 = round) */
  miter_angle?: number;
}

export interface GPStroke {
  points: GPPoint[];
  cyclic: boolean;
  material_index: number;
  start_cap: 0 | 1;
  end_cap: 0 | 1;
  fill_color: [number, number, number, number];
  fill_opacity: number;
  fill_id: number;
  /** spline type (0 Catmull-Rom, 1 poly, 2 Bézier, 3 NURBS; default poly) and its settings */
  curve_type?: number;
  resolution?: number;
  nurbs_order?: number;
  knots_mode?: number;
  /** 0 material, 1 stroke only, 2 fill only, 3 stroke and fill */
  stroke_type?: number;
  /** fill texture transform */
  uv_translation?: [number, number];
  uv_rotation?: number;
  uv_scale?: [number, number];
  /** Fill tool helper line */
  is_fill_guide?: boolean;
  /** edge softness 0..1 */
  softness?: number;
  /** line texture mapping: offset, scale, fit to the stroke (0/1), dot rotation */
  uv_stroke?: [number, number, number, number];
}

export function newStroke(points: GPPoint[], o: Partial<Omit<GPStroke, 'points'>> = {}): GPStroke {
  return {
    points,
    cyclic: false,
    material_index: 0,
    start_cap: 0,
    end_cap: 0,
    fill_color: [0, 0, 0, 0],
    fill_opacity: 1,
    fill_id: 0,
    ...o,
  };
}

export function newPoint(co: [number, number, number], radius = 0.01, opacity = 1, vertex_color: [number, number, number, number] = [0, 0, 0, 0]): GPPoint {
  return { co, radius, opacity, vertex_color };
}

export function emptyDrawing(): GPDrawing {
  return {
    position: new Float32Array(0),
    radius: new Float32Array(0),
    opacity: new Float32Array(0),
    vertex_color: new Float32Array(0),
    select: new Uint8Array(0),
    offsets: new Uint32Array([0]),
    cyclic: new Uint8Array(0),
    material_index: new Uint16Array(0),
    start_cap: new Uint8Array(0),
    end_cap: new Uint8Array(0),
    fill_color: new Float32Array(0),
    fill_opacity: new Float32Array(0),
    fill_id: new Int32Array(0),
  };
}

export const strokeCount = (d: GPDrawing) => d.offsets.length - 1;
export const pointCount = (d: GPDrawing) => d.position.length / 3;

/** Optional per stroke / per point arrays: removed when their length does not match. */
const OPT_CURVE: [keyof GPDrawing, number][] = [
  ['curve_type', 1],
  ['resolution', 1],
  ['nurbs_order', 1],
  ['knots_mode', 1],
  ['stroke_type', 1],
  ['uv_translation', 2],
  ['uv_rotation', 1],
  ['uv_scale', 2],
  ['is_fill_guide', 1],
  ['softness', 1],
  ['uv_stroke', 4],
];
const OPT_POINT: [keyof GPDrawing, number][] = [
  ['handle_left', 3],
  ['handle_right', 3],
  ['handle_type_left', 1],
  ['handle_type_right', 1],
  ['select_handle_left', 1],
  ['select_handle_right', 1],
  ['miter_angle', 1],
];

/** Fill in arrays missing from older/foreign data. */
export function normalizeDrawing(d: GPDrawing): GPDrawing {
  const n = d.position.length / 3,
    c = Math.max(0, d.offsets.length - 1);
  if (!d.radius || d.radius.length !== n) d.radius = new Float32Array(n).fill(0.01);
  if (!d.opacity || d.opacity.length !== n) d.opacity = new Float32Array(n).fill(1);
  if (!d.vertex_color || d.vertex_color.length !== n * 4) d.vertex_color = new Float32Array(n * 4);
  if (!d.select || d.select.length !== n) d.select = new Uint8Array(n);
  if (!d.cyclic || d.cyclic.length !== c) d.cyclic = new Uint8Array(c);
  if (!d.material_index || d.material_index.length !== c) d.material_index = new Uint16Array(c);
  if (!d.start_cap || d.start_cap.length !== c) d.start_cap = new Uint8Array(c);
  if (!d.end_cap || d.end_cap.length !== c) d.end_cap = new Uint8Array(c);
  if (!d.fill_color || d.fill_color.length !== c * 4) d.fill_color = new Float32Array(c * 4);
  if (!d.fill_opacity || d.fill_opacity.length !== c) d.fill_opacity = new Float32Array(c).fill(1);
  if (!d.fill_id || d.fill_id.length !== c) d.fill_id = new Int32Array(c);
  for (const [k, w] of OPT_CURVE) {
    const a = d[k] as { length: number } | undefined;
    if (a && a.length !== c * w) delete d[k];
  }
  for (const [k, w] of OPT_POINT) {
    const a = d[k] as { length: number } | undefined;
    if (a && a.length !== n * w) delete d[k];
  }
  if (!d.curve_type) for (const k of ['resolution', 'nurbs_order', 'knots_mode'] as const) delete d[k];
  ensureHandles(d);
  if (d.weights)
    for (const [k, w] of Object.entries(d.weights))
      if (!w || w.length !== n) {
        const nw = new Float32Array(n);
        if (w) nw.set(w.subarray(0, Math.min(n, w.length)));
        d.weights[k] = nw;
      }
  return d;
}

export function toStrokes(d: GPDrawing): GPStroke[] {
  const out: GPStroke[] = [];
  const sel = d.select;
  const groups = d.weights ? Object.entries(d.weights) : [];
  const nPts = d.position.length / 3,
    nStr = strokeCount(d);
  const at = <T extends { length: number }>(a: T | undefined, len: number) => (a && a.length === len ? a : undefined);
  const ct = at(d.curve_type, nStr),
    res = at(d.resolution, nStr),
    ord = at(d.nurbs_order, nStr),
    km = at(d.knots_mode, nStr),
    sty = at(d.stroke_type, nStr),
    uvt = at(d.uv_translation, nStr * 2),
    uvr = at(d.uv_rotation, nStr),
    uvs = at(d.uv_scale, nStr * 2),
    guide = at(d.is_fill_guide, nStr),
    soft = at(d.softness, nStr),
    uvst = at(d.uv_stroke, nStr * 4);
  const hl = at(d.handle_left, nPts * 3),
    hr = at(d.handle_right, nPts * 3),
    htl = at(d.handle_type_left, nPts),
    htr = at(d.handle_type_right, nPts),
    shl = at(d.select_handle_left, nPts),
    shr = at(d.select_handle_right, nPts),
    miter = at(d.miter_angle, nPts);
  for (let s = 0; s < nStr; s++) {
    const pts: GPPoint[] = [];
    const bez = ct?.[s] === 2 && hl && hr && htl && htr;
    for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) {
      const p: GPPoint = {
        co: [d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]],
        radius: d.radius[i],
        opacity: d.opacity[i],
        vertex_color: [d.vertex_color[i * 4], d.vertex_color[i * 4 + 1], d.vertex_color[i * 4 + 2], d.vertex_color[i * 4 + 3]],
        select: !!sel?.[i],
      };
      if (groups.length) {
        p.weights = {};
        for (const [k, w] of groups) if (w[i]) p.weights[k] = w[i];
      }
      if (bez) {
        p.handle_left = [hl[i * 3], hl[i * 3 + 1], hl[i * 3 + 2]];
        p.handle_right = [hr[i * 3], hr[i * 3 + 1], hr[i * 3 + 2]];
        p.handle_type_left = htl[i];
        p.handle_type_right = htr[i];
        if (shl?.[i]) p.select_left = true;
        if (shr?.[i]) p.select_right = true;
      }
      if (miter?.[i]) p.miter_angle = miter[i];
      pts.push(p);
    }
    const st: GPStroke = {
      points: pts,
      cyclic: !!d.cyclic[s],
      material_index: d.material_index[s],
      start_cap: (d.start_cap[s] ? 1 : 0) as 0 | 1,
      end_cap: (d.end_cap[s] ? 1 : 0) as 0 | 1,
      fill_color: [d.fill_color[s * 4], d.fill_color[s * 4 + 1], d.fill_color[s * 4 + 2], d.fill_color[s * 4 + 3]],
      fill_opacity: d.fill_opacity[s],
      fill_id: d.fill_id[s],
    };
    if (ct && ct[s] !== 1) {
      st.curve_type = ct[s];
      if (res) st.resolution = res[s];
      if (ord) st.nurbs_order = ord[s];
      if (km) st.knots_mode = km[s];
    }
    if (sty?.[s]) st.stroke_type = sty[s];
    if (uvt && (uvt[s * 2] || uvt[s * 2 + 1])) st.uv_translation = [uvt[s * 2], uvt[s * 2 + 1]];
    if (uvr?.[s]) st.uv_rotation = uvr[s];
    if (uvs && (uvs[s * 2] !== 1 || uvs[s * 2 + 1] !== 1)) st.uv_scale = [uvs[s * 2], uvs[s * 2 + 1]];
    if (guide?.[s]) st.is_fill_guide = true;
    if (soft?.[s]) st.softness = soft[s];
    if (uvst && (uvst[s * 4] || uvst[s * 4 + 1] !== 1 || uvst[s * 4 + 2] || uvst[s * 4 + 3])) st.uv_stroke = [uvst[s * 4], uvst[s * 4 + 1], uvst[s * 4 + 2], uvst[s * 4 + 3]];
    out.push(st);
  }
  return out;
}

export function fromStrokes(strokes: GPStroke[]): GPDrawing {
  const list = strokes.filter((s) => s.points.length > 0);
  const n = list.reduce((a, s) => a + s.points.length, 0);
  const c = list.length;
  const d: GPDrawing = {
    position: new Float32Array(n * 3),
    radius: new Float32Array(n),
    opacity: new Float32Array(n),
    vertex_color: new Float32Array(n * 4),
    select: new Uint8Array(n),
    offsets: new Uint32Array(c + 1),
    cyclic: new Uint8Array(c),
    material_index: new Uint16Array(c),
    start_cap: new Uint8Array(c),
    end_cap: new Uint8Array(c),
    fill_color: new Float32Array(c * 4),
    fill_opacity: new Float32Array(c),
    fill_id: new Int32Array(c),
  };
  // vertex group weights: one array per group used by any point
  const names = new Set<string>();
  for (const s of list) for (const p of s.points) if (p.weights) for (const k of Object.keys(p.weights)) names.add(k);
  if (names.size) {
    d.weights = {};
    for (const k of names) d.weights[k] = new Float32Array(n);
  }
  // optional spline / stroke type / texture data, only allocated when some stroke uses it
  const smooth = list.some((s) => s.curve_type !== undefined && s.curve_type !== 1);
  const bez = list.some((s) => s.curve_type === 2);
  if (smooth) {
    d.curve_type = new Uint8Array(c).fill(1);
    d.resolution = new Uint16Array(c).fill(12);
    if (list.some((s) => s.curve_type === 3)) {
      d.nurbs_order = new Uint8Array(c).fill(4);
      d.knots_mode = new Uint8Array(c).fill(1);
    }
  }
  if (bez) {
    d.handle_left = new Float32Array(n * 3);
    d.handle_right = new Float32Array(n * 3);
    d.handle_type_left = new Uint8Array(n);
    d.handle_type_right = new Uint8Array(n);
    d.select_handle_left = new Uint8Array(n);
    d.select_handle_right = new Uint8Array(n);
  }
  if (list.some((s) => s.stroke_type)) d.stroke_type = new Uint8Array(c);
  if (list.some((s) => s.uv_translation || s.uv_rotation || s.uv_scale)) {
    d.uv_translation = new Float32Array(c * 2);
    d.uv_rotation = new Float32Array(c);
    d.uv_scale = new Float32Array(c * 2).fill(1);
  }
  if (list.some((s) => s.is_fill_guide)) d.is_fill_guide = new Uint8Array(c);
  if (list.some((s) => s.softness)) d.softness = new Float32Array(c);
  if (list.some((s) => s.uv_stroke)) {
    d.uv_stroke = new Float32Array(c * 4);
    for (let k = 0; k < c; k++) d.uv_stroke[k * 4 + 1] = 1;
  }
  if (list.some((s) => s.points.some((p) => p.miter_angle))) d.miter_angle = new Float32Array(n);
  let i = 0;
  list.forEach((s, k) => {
    d.offsets[k] = i;
    const isBez = s.curve_type === 2;
    for (const p of s.points) {
      if (p.weights && d.weights) for (const [g, w] of Object.entries(p.weights)) d.weights[g][i] = w;
      d.position.set(p.co, i * 3);
      d.radius[i] = p.radius;
      d.opacity[i] = p.opacity;
      d.vertex_color.set(p.vertex_color, i * 4);
      d.select![i] = p.select ? 1 : 0;
      if (d.handle_left) {
        // points without handle data (new points of Bézier strokes) get auto handles
        const has = isBez && p.handle_left && p.handle_right;
        d.handle_left.set(has ? p.handle_left! : p.co, i * 3);
        d.handle_right!.set(has ? p.handle_right! : p.co, i * 3);
        d.handle_type_left![i] = has ? (p.handle_type_left ?? 1) : isBez ? 1 : 0;
        d.handle_type_right![i] = has ? (p.handle_type_right ?? 1) : isBez ? 1 : 0;
        d.select_handle_left![i] = isBez && p.select_left ? 1 : 0;
        d.select_handle_right![i] = isBez && p.select_right ? 1 : 0;
      }
      if (d.miter_angle) d.miter_angle[i] = p.miter_angle ?? 0;
      i++;
    }
    d.cyclic[k] = s.cyclic ? 1 : 0;
    d.material_index[k] = s.material_index;
    d.start_cap[k] = s.start_cap;
    d.end_cap[k] = s.end_cap;
    d.fill_color.set(s.fill_color, k * 4);
    d.fill_opacity[k] = s.fill_opacity;
    d.fill_id[k] = s.fill_id;
    if (d.curve_type) {
      d.curve_type[k] = s.curve_type ?? 1;
      d.resolution![k] = s.resolution ?? 12;
      if (d.nurbs_order) {
        d.nurbs_order[k] = s.nurbs_order ?? 4;
        d.knots_mode![k] = s.knots_mode ?? 1;
      }
    }
    if (d.stroke_type) d.stroke_type[k] = s.stroke_type ?? 0;
    if (d.uv_translation) {
      d.uv_translation.set(s.uv_translation ?? [0, 0], k * 2);
      d.uv_rotation![k] = s.uv_rotation ?? 0;
      d.uv_scale!.set(s.uv_scale ?? [1, 1], k * 2);
    }
    if (d.is_fill_guide) d.is_fill_guide[k] = s.is_fill_guide ? 1 : 0;
    if (d.softness) d.softness[k] = s.softness ?? 0;
    if (d.uv_stroke && s.uv_stroke) d.uv_stroke.set(s.uv_stroke, k * 4);
  });
  d.offsets[c] = i;
  if (bez) deriveHandles(d);
  return d;
}

export function copyDrawing(d: GPDrawing): GPDrawing {
  const out = {} as GPDrawing;
  for (const k of Object.keys(d) as (keyof GPDrawing)[]) {
    if (k === 'weights') continue;
    (out as unknown as Record<string, unknown>)[k] = (d[k] as { slice(): unknown } | undefined)?.slice();
  }
  if (d.weights) out.weights = Object.fromEntries(Object.entries(d.weights).map(([k, w]) => [k, w.slice()]));
  return normalizeDrawing(out);
}

// ---------------------------------------------------------------------------
// factories

export function newLayer(name = 'Layer'): GPLayer {
  return {
    name,
    hide: false,
    lock: false,
    opacity: 1,
    blend_mode: 'REGULAR',
    use_lights: true,
    use_onion_skinning: true,
    tint_color: [0, 0, 0],
    tint_factor: 0,
    radius_offset: 0,
    translation: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    frames: [],
  };
}

export function newGreasePencil(name = 'GPencil'): GreasePencilData {
  return {
    id: uid('gp'),
    name,
    layers: [],
    active_layer_index: 0,
    drawings: [],
    materials: [],
    stroke_depth_order: '2D',
    onion_mode: 'RELATIVE',
    onion_keyframe_type: 'ALL',
    ghost_before_range: 1,
    ghost_after_range: 1,
    use_ghost_custom_colors: false,
    before_color: [0.019, 0.15, 0.017],
    after_color: [0.014, 0.007, 0.242],
    onion_factor: 0.5,
    use_onion_fade: true,
    use_onion_loop: false,
  };
}

export function defaultGPStyle(o: Partial<MaterialGPencilStyle> = {}): MaterialGPencilStyle {
  return {
    show_stroke: true,
    show_fill: false,
    color: [0, 0, 0, 1],
    fill_color: [0.5, 0.5, 0.5, 1],
    mode: 'LINE',
    stroke_style: 'SOLID',
    fill_style: 'SOLID',
    alignment_mode: 'PATH',
    // dots / squares: one per diameter along the stroke
    placement_mode: 'RADIUS',
    placement_count: 1,
    placement_radius_spacing: 100,
    placement_density: 10,
    hide: false,
    lock: false,
    ghost: true,
    pass_index: 0,
    ...o,
  };
}

/** A material with Grease Pencil settings (the viewport display color follows the stroke color). */
export function newGPMaterial(name: string, o: Partial<MaterialGPencilStyle> = {}): MaterialData {
  const gs = defaultGPStyle(o);
  const base = gs.show_stroke ? gs.color : gs.fill_color;
  const ma = newMaterial(name, [base[0], base[1], base[2], base[3]]);
  ma.grease_pencil = gs;
  return ma;
}

// ---------------------------------------------------------------------------
// document access

/** Whether a stroke draws its line and its fill: its own stroke type, else its material's switches. */
export function strokeShows(st: MaterialGPencilStyle | null | undefined, strokeType = 0): { stroke: boolean; fill: boolean } {
  if (strokeType) return { stroke: (strokeType & 1) !== 0, fill: (strokeType & 2) !== 0 };
  return { stroke: st ? st.show_stroke : true, fill: !!st?.show_fill };
}

export function gpTable(doc: DocumentData): Record<ID, GreasePencilData> {
  return (doc.grease_pencils ??= {});
}

export function gpOf(doc: DocumentData, ob: ObjectData | null | undefined): GreasePencilData | null {
  if (!ob || ob.type !== 'GREASEPENCIL' || !ob.data) return null;
  return doc.grease_pencils?.[ob.data] ?? null;
}

export function activeLayer(gp: GreasePencilData): GPLayer | null {
  return gp.layers[gp.active_layer_index] ?? null;
}

/** Material style for a material slot (null when the slot is empty or not a GP material). */
export function slotStyle(doc: DocumentData, gp: GreasePencilData, index: number): MaterialGPencilStyle | null {
  const id = gp.materials[index] ?? gp.materials[0];
  const ma = id ? doc.materials[id] : undefined;
  return ma
    ? (ma.grease_pencil ??= defaultGPStyle({
        color: [...ma.diffuse_color] as [number, number, number, number],
      }))
    : null;
}

export const DEFAULT_BRUSHES: Record<string, GPBrush> = {
  'builtin.brush.Draw': {
    size: 25,
    strength: 1,
    use_pressure_size: true,
    use_pressure_strength: true,
    pen_smooth_factor: 0.35,
    pen_smooth_steps: 1,
    color_mode: 'MATERIAL',
    color: [0.5, 0.5, 0.5],
  },
  'builtin.brush.Fill': {
    size: 2,
    strength: 1,
    use_pressure_size: false,
    use_pressure_strength: false,
    fill_layer_mode: 'VISIBLE',
    dilate: 1,
    fill_direction: 'NORMAL',
    color_mode: 'MATERIAL',
    color: [0.5, 0.5, 0.5],
  },
  'builtin.brush.Erase': {
    size: 30,
    strength: 1,
    use_pressure_size: false,
    use_pressure_strength: true,
    eraser_mode: 'HARD',
  },
  'builtin.brush.Tint': {
    size: 40,
    strength: 0.6,
    use_pressure_size: false,
    use_pressure_strength: true,
    vertex_mode: 'BOTH',
    color: [1, 0.25, 0.1],
  },
  'builtin.line': {
    size: 25,
    strength: 1,
    use_pressure_size: false,
    use_pressure_strength: false,
    subdivision: 6,
  },
  'builtin.polyline': {
    size: 25,
    strength: 1,
    use_pressure_size: false,
    use_pressure_strength: false,
    subdivision: 6,
  },
  'builtin.arc': {
    size: 25,
    strength: 1,
    use_pressure_size: false,
    use_pressure_strength: false,
    subdivision: 62,
  },
  'builtin.curve': {
    size: 25,
    strength: 1,
    use_pressure_size: false,
    use_pressure_strength: false,
    subdivision: 62,
  },
  'builtin.box': {
    size: 25,
    strength: 1,
    use_pressure_size: false,
    use_pressure_strength: false,
    subdivision: 3,
  },
  'builtin.circle': {
    size: 25,
    strength: 1,
    use_pressure_size: false,
    use_pressure_strength: false,
    subdivision: 94,
  },
  'builtin.brush.Smooth': {
    size: 50,
    strength: 0.5,
    use_pressure_size: false,
    use_pressure_strength: true,
  },
  'builtin.brush.Thickness': {
    size: 50,
    strength: 0.5,
    use_pressure_size: false,
    use_pressure_strength: true,
    direction: 'ADD',
  },
  'builtin.brush.Strength': {
    size: 50,
    strength: 0.5,
    use_pressure_size: false,
    use_pressure_strength: true,
    direction: 'ADD',
  },
  'builtin.brush.Grab': {
    size: 50,
    strength: 0.6,
    use_pressure_size: false,
    use_pressure_strength: false,
  },
  'builtin.brush.Push': {
    size: 50,
    strength: 0.6,
    use_pressure_size: false,
    use_pressure_strength: true,
  },
  'builtin.brush.Twist': {
    size: 50,
    strength: 0.6,
    use_pressure_size: false,
    use_pressure_strength: true,
    direction: 'ADD',
  },
  'builtin.brush.Pinch': {
    size: 50,
    strength: 0.6,
    use_pressure_size: false,
    use_pressure_strength: true,
    direction: 'ADD',
  },
  'builtin.brush.Clone': {
    size: 50,
    strength: 1,
    use_pressure_size: false,
    use_pressure_strength: false,
  },
  'builtin.brush.Randomize': {
    size: 50,
    strength: 0.5,
    use_pressure_size: false,
    use_pressure_strength: true,
  },
};

/** Draw brush presets (Draw tool): radius in px, pressure response and smoothing. */
export const DRAW_PRESETS: {
  id: string;
  name: string;
  size: number;
  strength: number;
  use_pressure_size: boolean;
  use_pressure_strength: boolean;
  smooth: number;
  /** edge hardness of the strokes (1 = hard) */
  hardness?: number;
}[] = [
  {
    id: 'Pencil',
    name: 'Pencil',
    size: 14,
    strength: 1,
    use_pressure_size: true,
    use_pressure_strength: true,
    smooth: 0.35,
  },
  {
    id: 'Pen',
    name: 'Pen',
    size: 25,
    strength: 1,
    use_pressure_size: true,
    use_pressure_strength: false,
    smooth: 0.5,
  },
  {
    id: 'Ink Pen',
    name: 'Ink Pen',
    size: 30,
    strength: 1,
    use_pressure_size: true,
    use_pressure_strength: false,
    smooth: 0.8,
  },
  {
    id: 'Marker',
    name: 'Marker',
    size: 60,
    strength: 0.6,
    use_pressure_size: false,
    use_pressure_strength: false,
    smooth: 0.6,
    hardness: 0.85,
  },
  {
    id: 'Airbrush',
    name: 'Airbrush',
    size: 80,
    strength: 0.25,
    use_pressure_size: false,
    use_pressure_strength: true,
    smooth: 0.4,
    hardness: 0.1,
  },
];

/** Grease Pencil tool settings with defaults filled in (stored on scene.tool_settings). */
export function gpTS(doc: DocumentData): GPToolSettings {
  const ts = doc.scene.tool_settings as unknown as Partial<GPToolSettings>;
  ts.gpencil_stroke_placement_view3d ??= 'ORIGIN';
  ts.gpencil_surface_offset ??= 0.15;
  ts.gpencil_lock_axis ??= 'AXIS_Y';
  ts.gpencil_selectmode_edit ??= 'POINT';
  ts.use_gpencil_draw_additive ??= false;
  ts.use_gpencil_draw_onback ??= false;
  ts.use_grease_pencil_multi_frame_editing ??= false;
  ts.gpencil_draw_brush ??= 'Pencil';
  ts.gpencil_brushes ??= {};
  for (const [k, v] of Object.entries(DEFAULT_BRUSHES)) ts.gpencil_brushes[k] ??= structuredClone(v);
  return ts as GPToolSettings;
}

export function gpBrush(doc: DocumentData, tool: string): GPBrush {
  const ts = gpTS(doc);
  return (ts.gpencil_brushes[tool] ??= structuredClone(
    DEFAULT_BRUSHES[tool] ?? {
      size: 30,
      strength: 1,
      use_pressure_size: false,
      use_pressure_strength: false,
    },
  ));
}

// ---------------------------------------------------------------------------
// keyframes

/** The keyframe displayed at `frame` (the last key at or before it), or null. */
export function frameAt(layer: GPLayer, frame: number): GPFrame | null {
  const f = layer.frames;
  let lo = 0,
    hi = f.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid].frame_number <= frame) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 ? f[best] : null;
}

export function frameIndexAt(layer: GPLayer, frame: number): number {
  const fr = frameAt(layer, frame);
  return fr ? layer.frames.indexOf(fr) : -1;
}

export function drawingAt(gp: GreasePencilData, layer: GPLayer, frame: number): GPDrawing | null {
  const fr = frameAt(layer, frame);
  return fr ? (gp.drawings[fr.drawing] ?? null) : null;
}

export function sortFrames(layer: GPLayer) {
  layer.frames.sort((a, b) => a.frame_number - b.frame_number);
}

/** Add a keyframe at `frame` holding `drawing` (replaces an existing key at that frame). */
export function setKeyframe(gp: GreasePencilData, layer: GPLayer, frame: number, drawing: GPDrawing, type: GPKeyframeType = 'KEYFRAME'): GPFrame {
  gp.drawings.push(drawing);
  const idx = gp.drawings.length - 1;
  const existing = layer.frames.find((f) => f.frame_number === frame);
  if (existing) {
    existing.drawing = idx;
    existing.keyframe_type = type;
    return existing;
  }
  const fr: GPFrame = {
    frame_number: frame,
    drawing: idx,
    keyframe_type: type,
  };
  layer.frames.push(fr);
  sortFrames(layer);
  return fr;
}

/** Remove drawings no keyframe references and remap frame indices. */
export function compactDrawings(gp: GreasePencilData) {
  const used = new Map<number, number>();
  const out: GPDrawing[] = [];
  for (const l of gp.layers)
    for (const f of l.frames) {
      let n = used.get(f.drawing);
      if (n === undefined) {
        const d = gp.drawings[f.drawing];
        if (!d) continue;
        n = out.length;
        out.push(d);
        used.set(f.drawing, n);
      }
      f.drawing = n;
    }
  gp.drawings = out;
}

export interface OnionFrame {
  frame: GPFrame;
  /** -1 before, +1 after the current frame */
  side: -1 | 1;
  /** 1 = nearest */
  distance: number;
}

/**
 * Keyframes shown as onion skins for `layer` at `frame` (RELATIVE counts
 * keyframes, ABSOLUTE counts frames, SELECTED shows selected keyframes), filtered by keyframe type.
 */
export function onionFrames(gp: GreasePencilData, layer: GPLayer, frame: number, range?: { start: number; end: number }): OnionFrame[] {
  const out: OnionFrame[] = [];
  const keys = layer.frames.filter((f) => gp.onion_keyframe_type === 'ALL' || f.keyframe_type === gp.onion_keyframe_type);
  const current = frameAt(layer, frame);
  const curNum = current?.frame_number ?? -Infinity;
  if (gp.onion_mode === 'SELECTED') {
    for (const f of keys) {
      if (!f.select || f === current) continue;
      const side = f.frame_number < curNum ? -1 : 1;
      out.push({ frame: f, side, distance: 1 });
    }
    return out;
  }
  const before = keys.filter((f) => f.frame_number < curNum).reverse();
  const after = keys.filter((f) => f.frame_number > curNum);
  if (gp.onion_mode === 'RELATIVE') {
    before.slice(0, gp.ghost_before_range).forEach((f, i) => out.push({ frame: f, side: -1, distance: i + 1 }));
    after.slice(0, gp.ghost_after_range).forEach((f, i) => out.push({ frame: f, side: 1, distance: i + 1 }));
  } else {
    for (const f of before) if (frame - f.frame_number <= gp.ghost_before_range) out.push({ frame: f, side: -1, distance: frame - f.frame_number });
    for (const f of after) if (f.frame_number - frame <= gp.ghost_after_range) out.push({ frame: f, side: 1, distance: f.frame_number - frame });
  }
  // loop: at the end of the animation show the first keyframe as "after"
  if (gp.use_onion_loop && range && !after.length && keys.length > 1 && keys[0] !== current && frame >= range.start) {
    out.push({ frame: keys[0], side: 1, distance: 1 });
  }
  return out;
}

/** Opacity factor for an onion frame (fade with distance when use_onion_fade). */
export function onionAlpha(gp: GreasePencilData, o: OnionFrame, maxDistance: number): number {
  if (!gp.use_onion_fade) return gp.onion_factor;
  const n = Math.max(1, maxDistance);
  return gp.onion_factor * (1 - ((o.distance - 1) / n) * 0.8);
}

// ---------------------------------------------------------------------------
// misc

export function uniqueLayerName(gp: GreasePencilData, base: string) {
  const names = new Set(gp.layers.map((l) => l.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

export function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function lerpColor(a: Color, b: Color, t: number): Color {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
