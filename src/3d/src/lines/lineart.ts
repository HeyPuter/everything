// Grease Pencil Line Art modifier: feature lines of scene meshes seen from a camera, chained into
// 3D strokes on a target layer (computed live and cached, or baked into keyframes).
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators, onAppReady, operators } from '../app/app';
import { runJob, setProgress } from '../tracking/jobs';
import { layerMatrix } from '../greasepencil/render';
import { registerModifier, newModifier } from '../eval/modifiers';
import { uid } from '../data/defaults';
import { activeCollection } from '../ops/object';
import { createGreasePencilObject, gpAddTypes } from '../greasepencil/ops';
import { gpOf, toStrokes, fromStrokes, setKeyframe, emptyDrawing, compactDrawings } from '../greasepencil/data';
import { uniqueIn } from './defaults';
import type { DocumentData, ModifierBase, ObjectData } from '../data/types';
import { renderCamera } from '../render/final/camera';
import { renderSize } from '../render/final/units';
import { renderVisibleObjects } from '../render/final/renderscene';
import { kernels, kernelKeys, generatorTypes, GP_EXTRA_TYPES, type GPModContext } from '../greasepencil/modifiers';
import { newPoint, newStroke, type GPStroke } from '../greasepencil/data';
import { extractFeatures, F, type FeatureEdge } from './core/features';
import { Occlusion, visibilityPieces, type OccluderInput } from './core/visibility';
import { chainPieces } from './core/chain';
import { intersectionEdges } from './core/intersections';
import { worldPositions, type LineObject } from './core/pipeline';
import { lineCamera, lineObjects, inCollection } from './scene';

type M = ModifierBase & Record<string, unknown>;
const num = (m: M, k: string, d = 0) => (typeof m[k] === 'number' ? (m[k] as number) : d);

export const LINEART_DEFAULTS = {
  source_type: 'SCENE',
  source_object: null,
  source_collection: null,
  use_invert_collection: false,
  use_custom_camera: false,
  source_camera: null,
  target_layer: '',
  target_material: null,
  use_contour: true,
  use_loose: true,
  use_crease: true,
  use_material: false,
  use_edge_mark: true,
  use_intersection: true,
  crease_threshold: (140 * Math.PI) / 180,
  use_crease_on_smooth: false,
  use_crease_on_sharp: true,
  use_multiple_levels: false,
  level_start: 0,
  level_end: 0,
  radius: 0.0025,
  opacity: 1,
  overscan: 0.1,
  stroke_depth_offset: 0.05,
  use_offset_towards_custom_camera: false,
  use_back_face_culling: false,
  use_image_boundary_trimming: false,
  chaining_image_threshold: 0.001,
  source_vertex_group: '',
  vertex_group: '',
  invert_source_vertex_group: false,
  use_output_vertex_group_match_by_name: true,
  use_face_mark: false,
  use_face_mark_invert: false,
  use_face_mark_boundaries: false,
  use_face_mark_keep_contour: true,
  is_baked: false,
};

registerModifier({
  type: 'LINEART',
  label: 'Line Art',
  category: 'GENERATE',
  icon: 'mod_lineart',
  objectTypes: ['GREASEPENCIL'],
  defaults: () => ({ ...LINEART_DEFAULTS }),
  deps: (m) => [m.source_object as string, m.source_camera as string],
  apply: (mesh) => mesh,
});
GP_EXTRA_TYPES.add('LINEART');
generatorTypes.add('LINEART');

/** The camera a Line Art modifier looks through. */
export function lineArtCamera(m: M, doc: DocumentData): string | null {
  const id = m.use_custom_camera ? (m.source_camera as string | null) : doc.scene.camera;
  return id && doc.objects[id]?.type === 'CAMERA' ? id : null;
}

/** Usage of an object for line art (object setting, else its collections'). */
function usage(doc: DocumentData, id: string): string {
  const u = doc.objects[id]?.lineart?.usage;
  if (u && u !== 'INHERIT') return u;
  for (const c of Object.values(doc.collections)) if (c.objects.includes(id) && c.lineart_usage && c.lineart_usage !== 'INCLUDE') return c.lineart_usage;
  return 'INCLUDE';
}

/** Objects the modifier draws lines of, and the ones that only hide lines. */
function sources(m: M, doc: DocumentData): { lines: LineObject[]; occluders: LineObject[] } {
  const type = String(m.source_type ?? 'SCENE');
  const all = lineObjects(app);
  const inSource = (id: string) => {
    if (type === 'OBJECT') return id === m.source_object;
    if (type === 'COLLECTION') return !!m.source_collection && inCollection(doc, id, m.source_collection as string) !== !!m.use_invert_collection;
    return true;
  };
  const lines: LineObject[] = [],
    occluders: LineObject[] = [];
  for (const o of all) {
    const u = usage(doc, o.id);
    if (u === 'EXCLUDE' || !inSource(o.id)) continue;
    occluders.push(o);
    if (u !== 'OCCLUSION_ONLY' && u !== 'INTERSECTION_ONLY') lines.push(o);
  }
  return { lines, occluders };
}

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object | undefined) => {
  if (!o) return 0;
  let i = ids.get(o);
  if (!i) ids.set(o, (i = nextId++));
  return i;
};

/** Everything the result depends on besides the modifier settings. */
function signature(m: M, doc: DocumentData): string {
  const cam = lineArtCamera(m, doc);
  if (!cam) return 'nocam';
  const cev = app.graph.get(cam);
  const ca = cev?.ob.data ? doc.cameras[cev.ob.data] : undefined;
  const r = doc.scene.render;
  const parts = [cev ? Array.from(cev.world.elements, (x) => x.toFixed(5)).join(',') : '', JSON.stringify(ca ?? null), r.resolution_x, r.resolution_y, r.pixel_aspect_x, r.pixel_aspect_y];
  const visible = renderVisibleObjects(doc);
  for (const ev of app.graph.objects.values()) {
    if (!ev.mesh || ev.ob.type === 'GREASEPENCIL' || !visible.has(ev.id)) continue;
    const me = ev.ob.type === 'MESH' && ev.ob.data ? doc.meshes[ev.ob.data] : undefined;
    parts.push(`${ev.id}:${idOf(ev.mesh.positions)}:${ev.geomVersion}:${Array.from(ev.world.elements, (x) => x.toFixed(5)).join(',')}:${usage(doc, ev.id)}:${idOf(me?.freestyle_edge)}`);
  }
  return parts.join('|');
}

/** Face mark filtering: lines next to marked faces (or their boundaries), optionally inverted. */
function faceMarkKeeps(m: M, o: LineObject, e: FeatureEdge): boolean {
  const fm = o.faceMarks;
  const a = e.f0 >= 0 && !!fm?.[e.f0],
    b = e.f1 >= 0 && !!fm?.[e.f1];
  if (m.use_face_mark_keep_contour !== false && e.flags & (F.SILHOUETTE | F.BORDER)) return true;
  const hit = m.use_face_mark_boundaries ? a !== b : a || b;
  return m.use_face_mark_invert ? !hit : hit;
}

export interface LineArtStroke {
  points: [number, number, number][];
}

const cache = new Map<string, LineArtStroke[]>();

/** Line art strokes in world space for the current scene state. */
export function computeLineArt(m: M, doc: DocumentData): LineArtStroke[] {
  const camId = lineArtCamera(m, doc);
  if (!camId) return [];
  const [W, H] = renderSize(doc.scene.render);
  const camera = renderCamera(app, W, H, camId);
  if (!camera) return [];
  const cam = lineCamera(camera, W, H);
  const { lines, occluders } = sources(m, doc);
  if (!lines.length) return [];
  const mask = (m.use_contour ? F.SILHOUETTE | F.BORDER : 0) | (m.use_loose ? F.LOOSE : 0) | (m.use_crease ? F.CREASE : 0) | (m.use_material ? F.MATERIAL : 0) | (m.use_edge_mark ? F.EDGE_MARK : 0);
  const edges: FeatureEdge[] = [];
  const occ: OccluderInput[] = [];
  occluders.forEach((o, i) => occ.push({ positions: o.positions, offsets: o.offsets, indices: o.indices, world: o.world, object: i }));
  for (const o of lines) {
    const i = occluders.indexOf(o);
    const ob = doc.objects[o.id];
    const crease = ob?.lineart?.use_crease_override ? ob.lineart.crease_threshold : num(m, 'crease_threshold', (140 * Math.PI) / 180);
    const wp = worldPositions(o.positions, o.world);
    for (const e of extractFeatures({ positions: wp, offsets: o.offsets, indices: o.indices, material_index: o.material_index, smooth: o.smooth, edgeMarks: o.edgeMarks, looseEdges: o.looseEdges, object: i, creaseAngle: crease }, cam.view, { creaseAngle: crease, loose: true, materialBoundaries: true })) {
      let flags = e.flags;
      // smooth-shaded surfaces only crease where asked
      if (!m.use_crease_on_smooth && o.smooth && e.f0 >= 0 && e.f1 >= 0 && o.smooth[e.f0] && o.smooth[e.f1]) flags &= ~F.CREASE;
      flags &= mask;
      if (!flags) continue;
      if (m.use_face_mark && !faceMarkKeeps(m, o, e)) continue;
      edges.push({ ...e, flags });
    }
  }
  if (m.use_intersection) {
    const lineIdx = new Set(lines.map((o) => occluders.indexOf(o)));
    const noIx = new Set(occluders.map((o, i) => (usage(doc, o.id) === 'NO_INTERSECTION' ? i : -1)));
    for (const e of intersectionEdges(occ, (a, b) => (lineIdx.has(a) || lineIdx.has(b)) && !noIx.has(a) && !noIx.has(b))) edges.push(e);
  }
  const lo = Math.max(0, Math.round(num(m, 'level_start'))),
    hi = m.use_multiple_levels ? Math.max(lo, Math.round(num(m, 'level_end'))) : lo;
  const pieces = visibilityPieces(edges, cam, new Occlusion(occ), { maxQi: hi, margin: Math.max(0, num(m, 'overscan', 0.1)) }).filter((p) => p.qi >= lo && p.qi <= hi);
  const strokes = chainPieces(pieces, cam, { use_chaining: true, chaining: 'PLAIN', rounds: 1 });
  const off = num(m, 'stroke_depth_offset', 0.05);
  const eye = cam.view.eye,
    dir = cam.view.dir;
  return strokes
    .filter((s) => s.pts.length >= 2)
    .map((s) => ({
      points: s.pts.map((v) => {
        const p = v.p;
        let dx: number, dy: number, dz: number;
        if (cam.view.ortho) [dx, dy, dz] = [-dir[0], -dir[1], -dir[2]];
        else {
          dx = eye[0] - p[0];
          dy = eye[1] - p[1];
          dz = eye[2] - p[2];
          const l = Math.hypot(dx, dy, dz) || 1;
          dx /= l;
          dy /= l;
          dz /= l;
        }
        return [p[0] + dx * off, p[1] + dy * off, p[2] + dz * off] as [number, number, number];
      }),
    }));
}

function cachedLineArt(m: M, doc: DocumentData): LineArtStroke[] {
  const key = `${m.id}|${JSON.stringify({ ...m, show_expanded: 0, name: 0 })}|${signature(m, doc)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = computeLineArt(m, doc);
  if (cache.size > 16) cache.clear();
  cache.set(key, out);
  return out;
}

/** Line art strokes as grease pencil strokes in the space of a layer (`world`: layer → world). */
export function lineArtStrokes(m: M, doc: DocumentData, world: Matrix4, materials: (string | null)[]): GPStroke[] {
  const inv = world.clone().invert();
  const mat = Math.max(0, materials.indexOf((m.target_material as string | null) ?? null));
  const r = num(m, 'radius', 0.0025),
    a = num(m, 'opacity', 1);
  const v = new Vector3();
  return cachedLineArt(m, doc).map((s) =>
    newStroke(
      s.points.map((p) => {
        v.set(p[0], p[1], p[2]).applyMatrix4(inv);
        return newPoint([v.x, v.y, v.z], r, a);
      }),
      { material_index: mat },
    ),
  );
}

kernels.LINEART = (strokes: GPStroke[], m0: Record<string, unknown>, c: GPModContext) => {
  const m = m0 as M;
  if (m.is_baked || !m.target_layer || c.layer.name !== m.target_layer) return strokes;
  return [...strokes, ...lineArtStrokes(m, c.doc, c.world, c.gp.materials)];
};
kernelKeys.LINEART = (m0, c) => {
  const m = m0 as M;
  if (m.is_baked || c.layer.name !== m.target_layer) return '-';
  return signature(m, c.doc);
};

// ---------------------------------------------------------------------------
// Add ▸ Grease Pencil ▸ Scene / Collection / Object Line Art

function addLineArtObject(doc: DocumentData, props: Record<string, unknown>, source: 'SCENE' | 'COLLECTION' | 'OBJECT'): ObjectData {
  // the source is what is active before the new object takes over
  const activeOb = doc.scene.active_object && doc.objects[doc.scene.active_object]?.type !== 'GREASEPENCIL' ? doc.scene.active_object : null;
  const activeCol = activeCollection(doc);
  const ob = createGreasePencilObject(doc, 'EMPTY', props);
  ob.name = uniqueIn(Object.values(doc.objects).filter((o) => o !== ob).map((o) => o.name), 'LineArt');
  ob.show_in_front = true;
  const gp = gpOf(doc, ob)!;
  const m = newModifier('LINEART', uid('md'), ob.modifiers) as M;
  m.source_type = source;
  if (source === 'OBJECT') m.source_object = activeOb;
  if (source === 'COLLECTION') m.source_collection = activeCol;
  m.target_layer = gp.layers[0]?.name ?? 'Layer';
  m.target_material = gp.materials[0] ?? null;
  ob.modifiers.push(m);
  return ob;
}
gpAddTypes.LINEART_SCENE = (doc, p) => addLineArtObject(doc, p, 'SCENE');
gpAddTypes.LINEART_COLLECTION = (doc, p) => addLineArtObject(doc, p, 'COLLECTION');
gpAddTypes.LINEART_OBJECT = (doc, p) => addLineArtObject(doc, p, 'OBJECT');

// ---------------------------------------------------------------------------
// Bake / clear

const lineArtMods = (ob: ObjectData) => ob.modifiers.filter((m) => m.type === 'LINEART') as M[];

function bakeTargets(doc: DocumentData, all: boolean): ObjectData[] {
  const list = all ? Object.values(doc.objects).filter((o) => o.type === 'GREASEPENCIL') : app.activeObject ? [app.activeObject] : [];
  return list.filter((o) => lineArtMods(o).some((m) => !m.is_baked));
}

/** Bake the line art of objects into keyframes of their target layers over the scene range. */
export async function bakeLineArt(all: boolean): Promise<boolean> {
  const doc = app.doc;
  const obs = bakeTargets(doc, all);
  if (!obs.length) {
    app.report('WARNING', 'No line art to bake');
    return false;
  }
  const sc = doc.scene;
  const start = sc.frame_start,
    end = sc.frame_end,
    orig = sc.frame_current;
  return runJob('Bake Line Art', async (job) => {
    let frames = 0;
    for (let f = start; f <= end; f++) {
      if (job.cancelled) break;
      app.setFrame(f);
      app.flush();
      for (const ob of obs) {
        const gp = gpOf(doc, ob);
        const ev = app.graph.get(ob.id);
        if (!gp || !ev) continue;
        for (const m of lineArtMods(ob)) {
          if (m.is_baked) continue;
          const layer = gp.layers.find((l) => l.name === m.target_layer);
          if (!layer) continue;
          const world = ev.world.clone().multiply(layerMatrix(layer));
          const strokes = lineArtStrokes(m, doc, world, gp.materials);
          // strokes already keyed on this frame stay (several modifiers may share a layer)
          const key = layer.frames.find((k) => k.frame_number === f);
          const before = key && gp.drawings[key.drawing] && bakedFrames.get(ob.id)?.has(`${layer.name}:${f}`) ? toStrokes(gp.drawings[key.drawing]) : [];
          setKeyframe(gp, layer, f, fromStrokes([...before, ...strokes]));
          let set = bakedFrames.get(ob.id);
          if (!set) bakedFrames.set(ob.id, (set = new Set()));
          set.add(`${layer.name}:${f}`);
        }
      }
      frames++;
      setProgress(job, (f - start + 1) / Math.max(1, end - start + 1));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    for (const ob of obs) for (const m of lineArtMods(ob)) m.is_baked = true;
    bakedFrames.clear();
    app.setFrame(orig);
    return `Baked line art on ${frames} frame${frames === 1 ? '' : 's'}`;
  });
}

/** Frames written during the running bake (to merge modifiers that share a layer). */
const bakedFrames = new Map<string, Set<string>>();

/** Remove baked strokes: target layers keep one empty keyframe, the modifiers compute live again. */
export function clearLineArt(doc: DocumentData, all: boolean): number {
  const obs = (all ? Object.values(doc.objects).filter((o) => o.type === 'GREASEPENCIL') : app.activeObject ? [app.activeObject] : []).filter((o) => lineArtMods(o).some((m) => m.is_baked));
  let n = 0;
  for (const ob of obs) {
    const gp = gpOf(doc, ob);
    if (!gp) continue;
    for (const m of lineArtMods(ob)) {
      if (!m.is_baked) continue;
      const layer = gp.layers.find((l) => l.name === m.target_layer);
      if (layer) {
        layer.frames = [];
        setKeyframe(gp, layer, doc.scene.frame_start, emptyDrawing());
        compactDrawings(gp);
      }
      m.is_baked = false;
      n++;
    }
  }
  return n;
}

registerOperators([
  {
    idname: 'object.lineart_bake_strokes',
    label: 'Bake Line Art',
    description: 'Write the line art of the frame range into keyframes of the target layers',
    props: [{ id: 'bake_all', label: 'Bake All', type: 'bool', default: false }],
    undo: false,
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && bakeTargets(ctx.doc, false).length + bakeTargets(ctx.doc, true).length > 0,
    exec: (_ctx, p) => {
      void bakeLineArt(!!p.bake_all);
      return 'CANCELLED';
    },
  },
  {
    idname: 'object.lineart_clear',
    label: 'Clear Baked Line Art',
    description: 'Remove baked line art strokes and compute the lines live again',
    props: [{ id: 'clear_all', label: 'Clear All', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      if (!clearLineArt(ctx.doc, !!p.clear_all)) {
        app.report('WARNING', 'No baked line art');
        return 'CANCELLED';
      }
    },
  },
]);

// a Line Art modifier added to an object draws into its active layer with its first material
onAppReady(() => {
  const op = operators.get('object.modifier_add');
  if (!op?.exec) return;
  const base = op.exec;
  op.exec = (ctx, p) => {
    const r = base(ctx, p);
    const ob = app.activeObject;
    if (p.type !== 'LINEART' || !ob || ob.type !== 'GREASEPENCIL') return r;
    const m = ob.modifiers[ob.modifiers.length - 1] as M | undefined;
    const gp = gpOf(ctx.doc, ob);
    if (m?.type === 'LINEART' && gp) {
      if (!m.target_layer) m.target_layer = gp.layers[gp.active_layer_index]?.name ?? gp.layers[0]?.name ?? '';
      if (!m.target_material) m.target_material = gp.materials.find((x) => !!x) ?? null;
    }
    return r;
  };
});
