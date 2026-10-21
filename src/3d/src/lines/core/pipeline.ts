// The line drawing pipeline over a whole scene: feature edges of every object, visibility,
// then per line set selection, chaining, splitting, styling and rasterization. Pure (no app
// state): the render hook gathers the inputs from the evaluated scene.
import type { FreestyleSettings, LineSet, LineStyleData } from '../types';
import { EDGE_TYPES } from '../types';
import { extractFeatures, F, type FeatureEdge, type FeatureMesh } from './features';
import { Occlusion, visibilityPieces, projectPoint, lerp3, type LineCamera, type OccluderInput, type Piece, type VisibilityOptions } from './visibility';
import { chainPieces, splitStrokes, selectAndSort } from './chain';
import { styleStrokes, type MaterialAttrs, type StyledStroke } from './style';
import { StrokeRaster } from './raster';

export interface LineObject {
  id: string;
  /** object-space mesh */
  positions: Float32Array;
  offsets: Uint32Array;
  indices: Uint32Array;
  material_index?: Uint16Array;
  smooth?: Uint8Array;
  edgeMarks?: Uint8Array;
  faceMarks?: Uint8Array;
  looseEdges?: Uint32Array;
  /** object → world, column-major */
  world: ArrayLike<number>;
  /** material id per slot */
  materials: (string | null)[];
  /** per corner: edge marked sharp */
  sharp?: Uint32Array;
  /** vertex group weights per vertex, and the groups' names */
  weights?: Float32Array[];
  groups?: string[];
}

export interface LineRenderInput {
  objects: LineObject[];
  camera: LineCamera;
  settings: FreestyleSettings;
  linestyles: Record<string, LineStyleData>;
  /** pixels per unit of line style thickness */
  thicknessScale: number;
  material?: (id: string) => MaterialAttrs | null;
  objectLocation?: (id: string) => [number, number, number] | null;
  /** does object `id` belong to collection `col` (or its children) */
  inCollection?: (id: string, col: string) => boolean;
  seed?: number;
  /** progress / cancellation (may throw) */
  tick?: () => void;
  /** adjust the finished strokes of a line set (style modules) */
  shade?: (set: LineSet, strokes: StyledStroke[]) => void;
}

const TYPE_FLAG: Record<string, number> = {
  silhouette: F.SILHOUETTE,
  border: F.BORDER,
  crease: F.CREASE,
  ridge_valley: F.RIDGE_VALLEY,
  suggestive_contour: F.SUGGESTIVE,
  material_boundary: F.MATERIAL,
  contour: F.CONTOUR,
  external_contour: F.EXTERNAL_CONTOUR,
  edge_mark: F.EDGE_MARK,
};

/** World-space copy of an object's positions. */
export function worldPositions(P: Float32Array, m: ArrayLike<number>): Float32Array {
  const out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i],
      y = P[i + 1],
      z = P[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/** Does a piece pass the line set's edge type selection? */
export function edgeTypeSelected(set: LineSet, flags: number): boolean {
  const conds: boolean[] = [];
  for (const [k] of EDGE_TYPES) {
    if (!set[`select_${k}`]) continue;
    const has = !!(flags & TYPE_FLAG[k]);
    conds.push(set[`exclude_${k}`] ? !has : has);
  }
  if (!conds.length) return false;
  const r = set.edge_type_combination === 'AND' ? conds.every(Boolean) : conds.some(Boolean);
  return set.edge_type_negation === 'EXCLUSIVE' ? !r : r;
}

export function visibilitySelected(set: LineSet, qi: number): boolean {
  if (set.visibility === 'HIDDEN') return qi > 0;
  if (set.visibility === 'RANGE') return qi >= set.qi_start && qi <= set.qi_end;
  return qi === 0;
}

function faceMarkSelected(set: LineSet, e: FeatureEdge, objects: LineObject[]): boolean {
  const fm = objects[e.object].faceMarks;
  const a = e.f0 >= 0 && !!fm?.[e.f0],
    b = e.f1 >= 0 && !!fm?.[e.f1];
  const r = set.face_mark_condition === 'BOTH' ? a && (e.f1 < 0 || b) : a || b;
  return set.face_mark_negation === 'EXCLUSIVE' ? !r : r;
}

/** Which feature kinds the enabled line sets need. */
function needs(sets: LineSet[]) {
  let ridges = false,
    suggestive = false,
    contours = false,
    maxQi = 0;
  for (const s of sets) {
    if (s.select_by_edge_types) {
      if (s.select_ridge_valley) ridges = true;
      if (s.select_suggestive_contour) suggestive = true;
      if (s.select_contour || s.select_external_contour) contours = true;
    }
    if (s.select_by_visibility && s.visibility === 'RANGE') maxQi = Math.max(maxQi, s.qi_end);
  }
  return { ridges, suggestive, contours, maxQi };
}

export interface LinePieces {
  pieces: Piece[];
  objects: LineObject[];
  edges: number;
}

export interface PreparedLines {
  edges: FeatureEdge[];
  occlusion: Occlusion;
  visibility: VisibilityOptions;
}

/** Feature edges of all objects and the occlusion structure (the slow part is `visibilityPieces`). */
export function prepareLines(input: Pick<LineRenderInput, 'objects' | 'camera' | 'settings' | 'tick'>, sets: LineSet[]): PreparedLines {
  const { objects, camera, settings } = input;
  const nd = needs(sets);
  const edges: FeatureEdge[] = [];
  const occ: OccluderInput[] = [];
  objects.forEach((o, i) => {
    const wp = worldPositions(o.positions, o.world);
    const fm: FeatureMesh = { positions: wp, offsets: o.offsets, indices: o.indices, material_index: o.material_index, smooth: o.smooth, edgeMarks: o.edgeMarks, faceMarks: o.faceMarks, looseEdges: o.looseEdges, object: i };
    for (const e of extractFeatures(fm, camera.view, {
      creaseAngle: settings.crease_angle,
      ridgesValleys: settings.use_ridges_and_valleys || nd.ridges,
      suggestive: settings.use_suggestive_contours || nd.suggestive,
      materialBoundaries: true,
      smoothness: settings.use_smoothness,
      krEpsilon: settings.kr_derivative_epsilon,
      sphereRadius: settings.sphere_radius,
    }))
      edges.push(e);
    occ.push({ positions: o.positions, offsets: o.offsets, indices: o.indices, world: o.world, object: i });
    input.tick?.();
  });
  return { edges, occlusion: new Occlusion(occ), visibility: { maxQi: nd.maxQi, contours: nd.contours, tick: input.tick, margin: settings.use_culling ? 0.02 : 0.1 } };
}

/** Feature edges of all objects split by visibility. */
export function computePieces(input: Pick<LineRenderInput, 'objects' | 'camera' | 'settings' | 'tick'>, sets: LineSet[]): LinePieces {
  const p = prepareLines(input, sets);
  return { pieces: visibilityPieces(p.edges, input.camera, p.occlusion, p.visibility), objects: input.objects, edges: p.edges.length };
}

/** Line sets that draw: enabled for rendering and with a line style. */
export function drawingSets(input: Pick<LineRenderInput, 'settings' | 'linestyles'>): LineSet[] {
  return input.settings.linesets.filter((s) => s.show_render && s.linestyle && input.linestyles[s.linestyle]);
}

/** Pieces selected by a line set. */
export function selectPieces(set: LineSet, lp: LinePieces, cam: LineCamera, inCollection?: (id: string, col: string) => boolean): Piece[] {
  return lp.pieces.filter((p) => {
    if (set.select_by_visibility && !visibilitySelected(set, p.qi)) return false;
    if (set.select_by_edge_types && !edgeTypeSelected(set, p.flags)) return false;
    if (set.select_by_face_marks && !faceMarkSelected(set, p.edge, lp.objects)) return false;
    if (set.select_by_collection && set.collection) {
      const inside = inCollection ? inCollection(lp.objects[p.edge.object].id, set.collection) : false;
      if (inside === (set.collection_negation === 'EXCLUSIVE')) return false;
    }
    if (set.select_by_image_border) {
      const m = projectPoint(cam, ...lerp3(p.edge.pa, p.edge.pb, (p.t0 + p.t1) / 2));
      if (m[0] < 0 || m[1] < 0 || m[0] > cam.width || m[1] > cam.height) return false;
    }
    return true;
  });
}

/** Render all enabled line sets into a premultiplied RGBA layer (rows top-down). */
export function renderLines(input: LineRenderInput): { layer: Float32Array; strokes: number; edges: number } {
  const { camera } = input;
  const layer = new Float32Array(camera.width * camera.height * 4);
  const sets = drawingSets(input);
  if (!sets.length || !input.objects.length) return { layer, strokes: 0, edges: 0 };
  const lp = computePieces(input, sets);
  const strokes = drawLineSets(input, sets, lp, layer);
  return { layer, strokes, edges: lp.edges };
}

/** Select, chain, style and draw each line set over `layer`; returns the stroke count. */
export function drawLineSets(input: LineRenderInput, sets: LineSet[], lp: LinePieces, layer: Float32Array): number {
  const { camera } = input;
  const W = camera.width,
    H = camera.height;
  // material keys: index into a list of material ids
  const matIds: (string | null)[] = [];
  const matIndex = new Map<string, number>();
  const materialKey = (obj: number, slot: number) => {
    const id = input.objects[obj]?.materials[slot] ?? null;
    const k = id ?? '';
    let i = matIndex.get(k);
    if (i === undefined) {
      i = matIds.length;
      matIds.push(id);
      matIndex.set(k, i);
    }
    return i;
  };
  // a line between two materials takes the one with the higher line priority
  if (input.material) {
    const prio = (obj: number, slot: number) => {
      const id = input.objects[obj]?.materials[slot];
      return id ? input.material!(id)?.priority ?? 0 : 0;
    };
    const seen = new Set<FeatureEdge>();
    for (const p of lp.pieces) {
      const e = p.edge;
      if (seen.has(e) || e.m0 === e.m1) continue;
      seen.add(e);
      if (prio(e.object, e.m1) > prio(e.object, e.m0)) [e.m0, e.m1] = [e.m1, e.m0];
    }
  }
  const raster = new StrokeRaster(W, H);
  let count = 0;
  for (const set of sets) {
    const ls = input.linestyles[set.linestyle!];
    const picked = selectPieces(set, lp, camera, input.inCollection);
    let strokes = chainPieces(picked, camera, { use_chaining: ls.use_chaining, chaining: ls.chaining, rounds: ls.rounds, use_same_object: ls.use_same_object, materialKey });
    strokes = splitStrokes(strokes, {
      material_boundary: ls.material_boundary,
      use_angle_min: ls.use_angle_min,
      angle_min: ls.angle_min,
      use_angle_max: ls.use_angle_max,
      angle_max: ls.angle_max,
      use_split_length: ls.use_split_length,
      split_length: ls.split_length,
      use_split_pattern: ls.use_split_pattern,
      pattern: [ls.split_dash1, ls.split_gap1, ls.split_dash2, ls.split_gap2, ls.split_dash3, ls.split_gap3],
    });
    strokes = selectAndSort(strokes, ls);
    const styled = styleStrokes(strokes, ls, {
      thicknessScale: input.thicknessScale,
      seed: input.seed,
      objectLocation: input.objectLocation,
      material: (k) => {
        const id = matIds[k];
        return id && input.material ? input.material(id) : null;
      },
    });
    input.shade?.(set, styled);
    for (const s of styled) raster.draw(s, layer);
    count += styled.length;
    input.tick?.();
  }
  return count;
}
