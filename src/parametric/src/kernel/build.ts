/* eslint-disable @typescript-eslint/no-explicit-any */
// Feature regeneration. Features are applied in order to a single body.
// Every step is cached under a key chained from all previous features, so
// editing feature k rebuilds only k and what follows (like a history-based
// modeler should).
//
// Topological naming: each face is named after the feature (and sketch
// entity) that created its underlying surface. After every operation, faces
// of the new body inherit names from faces of the previous body (or of the
// tool) lying on the same surface. Edges are named by the pair of faces they
// separate. References stored in features (fillet edges, sketch faces...)
// use these names, so they survive dimension edits.

import * as R from 'replicad';
import type { Frame, Vec2, Vec3 } from '../math/vec';
import { add, dist, dot, len, normalize, scale, sub, toLocal, toWorld } from '../math/vec';
import type {
  AxisRef, ChamferFeature, CircularPatternFeature, DraftFeature, EdgeRef, ExtrudeFeature, FaceRef, Feature,
  FilletFeature, HoleFeature, Id, ImportFeature, LinearPatternFeature, LoftFeature, MirrorFeature, PatternDir, PlaneFeature,
  PlaneRef, RevolveFeature, ShellFeature, SkDimension, SketchFeature, SweepFeature,
} from '../model/types';
import { PARAM_FIELDS, dependencies, getPath, refFeatureIds } from '../model/features';
import { BASE_FRAMES } from '../model/planes';
import { type SheetHost, type SheetModel, applySheetMetal, flatPattern } from './sheetmetal';
import { type Region, type Seg2, buildProfiles, hasOverlappingLines, holesMayTouch, inRegion, pointInPoly, reverseLoop, segPolyline, sketchPoints } from '../sketch/profiles';
import { SketchIndex, pointIdsOf, splineBeziers } from '../sketch/geom';
import { hasExternal, resolveExternal } from '../sketch/external';
import { solveSketch } from '../sketch/solver';
import { measureDimension } from '../sketch/ops';
import type {
  BuildRequest, BuildResult, EdgeInfo, FaceInfo, FeatureStatus, FlatPatternResult, MassProperties, MeasureResult, MeasureTarget, MeshData,
  ProjectionRequest, ProjectionResult,
} from './protocol';
import { type WeldCtx, type WeldState, applyEndCap, applyGusset, applyStructuralMember, applyTrimExtend, applyWeldBead } from './weldments';
import { projectSection } from './drawing-section';
import {
  type EdgeDesc, type Sh, type SurfDesc, ShapeIndex, bbox, compound, cut, describeEdge, describeFace, faceMidPoint, fuse, fuseAll, getOc, gdir,
  hashOf, isEmpty, isValid, meshEdgesOf, meshShape, mirrored, planarFaceFrame, plane, pnt, projectShape, rotated, sameSurface, sharesSurface, SurfaceCache, subShapes, translated,
  vertexPoint, volumeOf, wrap, xyz,
} from './occ';
import { SurfaceKit, bodyEdges, type SurfaceBody, type SurfState } from './surfaces';
import { SURFACE_TYPES, type SurfaceFeature } from '../model/surfaces';

export { BASE_FRAMES };

export class FeatureError extends Error {}

// STL holds closed meshes for printing: surface bodies are left out of it.
const STL_SOLIDS_ONLY = 'STL files hold solids only, and this part has only surfaces. Thicken or knit the surfaces into a solid, or export STEP to keep them.';
// Thin (wall) extrudes and revolves are not built yet; failing beats
// silently making a solid where a wall was asked for.
const THIN_UNSUPPORTED = 'Thin features are not supported yet. Sketch the wall as two offset contours instead.';

export interface NamedFace {
  shape: Sh;
  name: string;
  desc: SurfDesc;
  feature: Id;
}

interface NamedEdge {
  shape: Sh;
  name: string;
  desc: EdgeDesc;
  faces: number[];
}

interface Tool {
  shape: Sh;
  cut: boolean;
  faces: NamedFace[];
  /** Patterns and mirrors of bosses and cuts together: the copies of each seed, so a copy of them cuts what was cut. */
  parts?: Tool[];
}

export interface State {
  body: Sh | null;
  faces: NamedFace[];
  edges: NamedEdge[] | null;
  frames: Map<Id, Frame>;
  sketches: Map<Id, SketchFeature>;
  /** Projected sketch entities whose model edge or vertex is gone, by sketch. */
  lostRefs: Map<Id, Id[]>;
  tools: Map<Id, Tool>;
  /** Surface bodies (see surfaces.ts); empty for parts without surface features. */
  surfaces: SurfaceBody[];
  /** Sheet metal model (sheetmetal.ts), from the first Base Flange on. */
  sheet?: SheetModel | null;
  /** Structural members, end caps and gussets built so far (weldment parts only). */
  weld?: WeldState;
}

interface Step {
  key: string;
  state: State;
  status: FeatureStatus;
}

const WELD_TOOL_TYPES = new Set<Feature['type']>(['structuralMember', 'endCap', 'gusset', 'weldBead']);

const emptyState = (): State => ({ body: null, faces: [], edges: null, frames: new Map(), sketches: new Map(), lostRefs: new Map(), tools: new Map(), surfaces: [] });

const cloneState = (s: State): State => ({
  body: s.body,
  faces: s.faces,
  edges: s.edges,
  frames: new Map(s.frames),
  sketches: new Map(s.sketches),
  lostRefs: new Map(s.lostRefs),
  tools: new Map(s.tools),
  surfaces: s.surfaces,
  sheet: s.sheet,
  weld: s.weld,
});

/** A feature's numeric value at a path (dir1.count), named by its label when it is not a number. */
const num = (f: Feature, path: string): number => {
  const p = getPath(f, path);
  const v = typeof p === 'number' ? p : Number(p);
  if (!Number.isFinite(v)) {
    // Only a damaged or hand-edited file gets here; "A parameter" did not say which.
    const label = PARAM_FIELDS[f.type]?.find((x) => x.path === path)?.label ?? path;
    throw new FeatureError(`${label} has an invalid value`);
  }
  return v;
};

/**
 * What a feature's geometry depends on, for the step cache key. Its name,
 * visibility and a sketch's display frame do not change the geometry, so
 * renaming or hiding a feature must not rebuild everything after it.
 */
function stepText(f: Feature): string {
  const { name: _name, hidden: _hidden, ...rest } = f;
  if (rest.type === 'sketch') delete (rest as Partial<SketchFeature>).frame;
  return JSON.stringify(rest);
}

const boxes = new WeakMap<Sh, ReturnType<typeof bbox>>();

/**
 * Bounding box of a shape, computed once per shape: shapes are never changed
 * in place, and an exact box of a filleted body takes hundreds of
 * milliseconds, which every rebuild (even a fully cached one) paid again.
 */
function boxOf(shape: Sh): ReturnType<typeof bbox> {
  let b = boxes.get(shape);
  if (b === undefined) boxes.set(shape, (b = bbox(shape)));
  return b;
}

const volumes = new WeakMap<Sh, number>();

/** Volume of a body, computed once per shape (each body is compared with the next one). */
function volumeOfBody(shape: Sh): number {
  let v = volumes.get(shape);
  if (v === undefined) volumes.set(shape, (v = volumeOf(shape)));
  return v;
}

/** Whether the bounding boxes of two shapes meet (within tol). */
function touching(a: Sh, b: Sh, tol: number): boolean {
  const p = boxOf(a), q = boxOf(b);
  if (!p || !q) return true;
  for (let k = 0; k < 3; k++) if (p.min[k] > q.max[k] + tol || q.min[k] > p.max[k] + tol) return false;
  return true;
}

/** 53-bit FNV-1a style hash of a string, as base36. */
export function hashString(s: string, seed = 0): string {
  let h1 = 0x811c9dc5 ^ seed, h2 = 0x1b873593 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 15), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 15), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export class ModelBuilder {
  private steps: Step[] = [];
  private current: State = emptyState();
  /**
   * What the cached mesh was made from. Keyed by the body and its faces, not
   * by the chain of steps: a sketch or plane leaves the body as it was, yet
   * opening or closing it (which builds up to before it, then past it)
   * meshed the whole part again and sent it to the GPU, 0.6 s on a plate of
   * 400 holes.
   */
  private meshKey: { body: Sh | null; faces: NamedFace[]; quality: number; surfaces?: SurfaceBody[] } | null = null;
  private meshCache: { mesh: MeshData | null; faces: FaceInfo[]; edges: EdgeInfo[] } | null = null;

  reset() {
    this.steps = [];
    this.meshKey = null;
    this.meshCache = null;
    this.importCache.clear();
    this.importVersions.clear();
  }

  /** Position and type of every feature of the request being built. */
  private order = new Map<Id, { index: number; type: Feature['type']; name: string }>();

  /** A status with the features its message names under their names in this request. */
  private named(st: FeatureStatus): FeatureStatus {
    const text = (m: string | undefined) => m?.replace(NAME_REF, (_, id: string) => this.order.get(id)?.name ?? id);
    if (!st.error?.includes('\u0001') && !st.warning?.includes('\u0001')) return st;
    return { ...st, ...(st.error ? { error: text(st.error) } : {}), ...(st.warning ? { warning: text(st.warning) } : {}) };
  }
  /** Position of the feature being applied (a preview goes at the build position). */
  private at = 0;

  /**
   * Why a feature or sketch a feature uses is not there, naming it: in a long
   * tree "the profile sketch is missing" did not say which one to look at.
   */
  private missing(id: Id | null | undefined, what: string): FeatureError {
    const at = id ? this.order.get(id) : undefined;
    if (!id) return new FeatureError(`Select the ${what}`);
    if (!at) return new FeatureError(`The ${what} no longer exists`);
    if (at.index >= this.at) return new FeatureError(`The ${what} (${nameOf(id)}) comes after this feature in the tree`);
    return new FeatureError(`The ${what} (${nameOf(id)}) failed to build`);
  }

  /** The feature that made a named face or edge, for messages. */
  private maker(name: string): string {
    for (const part of name.split('|')) {
      // A copy ("f3:cap1@f7.4") was made by its pattern or mirror, not by the seed:
      // a copy gone after its pattern lost instances named the seed feature.
      const ids = refFeatureIds(part);
      const id = ids[ids.length - 1];
      if (id && this.order.has(id)) return ` (made by ${nameOf(id)})`;
    }
    return '';
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const t0 = performance.now();
    this.order = new Map(req.features.map((f, index) => [f.id, { index, type: f.type, name: f.name }]));
    let state = emptyState();
    let chain = 'root';
    const status: FeatureStatus[] = [];
    const upTo = Math.max(0, Math.min(req.upTo, req.features.length));
    // Suppressed features, and features built on them (their children are
    // suppressed with them rather than failing for want of their parent).
    const off = new Set<Id>();
    /** Cache key of feature i after the chain of keys before it; notes whether it is suppressed. */
    const keyOf = (i: number, chain: string) => {
      const f = req.features[i];
      const deps = dependencies(f);
      const suppressed = !!f.suppressed || deps.some((d) => off.has(d));
      if (suppressed) off.add(f.id);
      const imported = f.type === 'import' ? ':' + this.importVersion(f.blob, req.blobs[f.blob]) : '';
      const invalid = suppressed ? undefined : req.invalid?.[f.id];
      // Features it uses that come after it, or are gone, are not in the chain
      // but decide its message: deleting a sketch that came after it left
      // "comes after this feature" in place of "no longer exists".
      const refs = deps.map((d) => { const o = this.order.get(d); return !o ? '-' : o.index < i ? '' : '+' + o.type; }).join(',');
      const key = hashString(chain + '\u0000' + stepText(f) + imported + (invalid ? '\u0000!' + invalid : '') + '\u0000' + refs);
      return { f, key, suppressed, invalid };
    };
    for (let i = 0; i < upTo; i++) {
      const { f, key, suppressed, invalid } = keyOf(i, chain);
      const cached = this.steps[i];
      if (cached && cached.key === key) {
        state = cached.state;
        status.push(this.named(cached.status));
        chain = key;
        continue;
      }
      this.steps.length = i;
      const next = cloneState(state);
      let st: FeatureStatus = suppressed ? { id: f.id, ok: true, suppressed: true } : { id: f.id, ok: true };
      // A value that could not be evaluated stands at zero: building with it
      // gave later features the wrong geometry under a feature marked failed.
      if (invalid) st = { id: f.id, ok: false, error: invalid };
      else if (!suppressed) {
        try {
          this.warning = null;
          this.at = i;
          await this.apply(f, next, req);
          if (this.warning) st = { id: f.id, ok: true, warning: this.warning };
        } catch (e) {
          if (isFatal(e)) throw e;
          st = { id: f.id, ok: false, error: errorText(e) };
          // Keep frames of failed sketches/planes out; keep previous geometry.
          next.body = state.body;
          next.faces = state.faces;
          next.edges = state.edges;
          next.surfaces = state.surfaces;
          next.sheet = state.sheet;
        }
      }
      this.steps[i] = { key, state: next, status: st };
      state = next;
      status.push(this.named(st));
      chain = key;
    }
    for (let i = upTo; i < req.features.length; i++) status.push({ id: req.features[i].id, ok: true });
    this.current = state;
    // Imported shapes of parts no longer open (their file data is gone from
    // the request) would otherwise be kept for the life of the worker.
    for (const blob of [...this.importCache.keys()]) if (!(blob in req.blobs)) this.importCache.delete(blob);
    if (this.importVersions.size) {
      const referenced = new Set(req.features.flatMap((f) => f.type === 'import' ? [f.blob] : []));
      if (req.preview?.type === 'import') referenced.add(req.preview.blob);
      for (const blob of this.importVersions.keys()) if (!(blob in req.blobs) && !referenced.has(blob)) this.importVersions.delete(blob);
    }

    const k = this.meshKey;
    if (!k || k.body !== state.body || k.faces !== state.faces || k.quality !== req.quality || !this.meshCache || k.surfaces !== state.surfaces) {
      this.meshCache = this.meshState(state, req.quality);
      // Surface bodies are drawn and picked with the solid, their faces and edges after its.
      if (state.surfaces.length) this.meshCache = this.surf.mesh(this.meshCache, state, req.quality);
      this.meshKey = { body: state.body, faces: state.faces, quality: req.quality, surfaces: state.surfaces };
    }
    const frames: Record<Id, Frame> = {};
    for (const [k, v] of state.frames) frames[k] = v;
    const sketches: NonNullable<BuildResult['sketches']> = {};
    const linked = (s: State, id: Id, sk: SketchFeature) => { if (hasExternal(sk)) sketches[id] = { entities: sk.entities, lost: s.lostRefs.get(id) ?? [] }; };
    for (const [k, v] of state.sketches) linked(state, k, v);
    // Frames of features beyond the rollback bar that were built before stay
    // useful for display; take them from the deepest cached step that is
    // still this part's. The deepest step whatever it was could be left from
    // another part opened before, with features of the same ids elsewhere.
    let last: State | null = null;
    for (let i = upTo, key = chain; i < Math.min(this.steps.length, req.features.length); i++) {
      key = keyOf(i, key).key;
      if (this.steps[i].key !== key) break;
      last = this.steps[i].state;
    }
    if (last) for (const [k, v] of last.frames) if (!(k in frames)) frames[k] = v;

    const result: BuildResult = {
      mesh: this.meshCache.mesh,
      faces: this.meshCache.faces,
      edges: this.meshCache.edges,
      status,
      frames,
      bbox: state.body ? boxOf(state.body) : null,
      ms: performance.now() - t0,
      preview: null,
      sketches,
    };
    if (state.surfaces.length) {
      result.bbox = this.surf.box(state);
      result.surfaces = { face: state.faces.length, edge: this.edgesOf(state).length };
    }
    if (state.weld) result.weldments = state.weld.members.map((m) => m.info);

    if (req.preview) {
      const p = cloneState(state);
      try {
        this.warning = null;
        this.at = upTo;
        const kind = await this.apply(req.preview, p, req);
        // Shown while the feature is edited, when it can still be fixed.
        if (this.warning) result.previewWarning = this.named({ id: '', ok: true, warning: this.warning }).warning;
        if (kind === 'tool') {
          const tool = p.tools.get(req.preview.id);
          if (tool) result.preview = this.meshBody(tool.shape, req.quality);
          result.previewKind = 'tool';
        } else if (kind === 'body' && p.body) {
          result.preview = this.meshBody(p.body, req.quality);
          result.previewKind = 'body';
        } else if (kind === 'surface') {
          const shape = this.surf.previewShape(p, req.preview.id);
          if (shape) result.preview = this.meshBody(shape, req.quality);
          result.previewKind = 'tool';
        }
        if (req.preview.type === 'sketch' || req.preview.type === 'plane') {
          const fr = p.frames.get(req.preview.id);
          if (fr) result.frames[req.preview.id] = fr;
        }
        if (req.preview.type === 'sketch') {
          const sk = p.sketches.get(req.preview.id);
          if (sk) linked(p, req.preview.id, sk);
        }
      } catch (e) {
        if (isFatal(e)) throw e;
        result.previewError = this.named({ id: '', ok: false, error: errorText(e) }).error;
      }
    }
    return result;
  }

  // ---- feature dispatch ----

  /** Applies a feature to the state. Returns what a preview should show. */
  private async apply(f: Feature, st: State, req: BuildRequest): Promise<'tool' | 'body' | 'none' | 'surface'> {
    switch (f.type) {
      case 'sketch': {
        const frame = this.resolvePlane(f.plane, st);
        st.frames.set(f.id, frame);
        st.sketches.set(f.id, this.linkSketch(f, frame, st));
        return 'none';
      }
      case 'plane': this.applyPlane(f, st); return 'none';
      case 'extrude': this.applyExtrude(f, st); return 'tool';
      case 'revolve': this.applyRevolve(f, st); return 'tool';
      case 'fillet': this.applyFillet(f, st); return 'body';
      case 'chamfer': this.applyChamfer(f, st); return 'body';
      case 'shell': this.applyShell(f, st); return 'body';
      case 'hole': this.applyHole(f, st); return 'tool';
      case 'linearPattern': this.applyLinearPattern(f, st); return 'tool';
      case 'circularPattern': this.applyCircularPattern(f, st); return 'tool';
      case 'mirror': this.applyMirror(f, st); return 'tool';
      case 'loft': this.applyLoft(f, st); return 'tool';
      case 'sweep': this.applySweep(f, st); return 'tool';
      case 'draft': this.applyDraft(f, st); return 'body';
      case 'import': await this.applyImport(f, st, req); return 'body';
      case 'baseFlange':
      case 'edgeFlange':
      case 'sketchedBend':
      case 'hem':
        applySheetMetal(this.sheetHost(), f, st);
        // Its booleans leave a tool that is not the feature (a flange's cut or wall alone): it cannot be a pattern seed.
        st.tools.delete(f.id);
        return 'body';
      case 'structuralMember': applyStructuralMember(this.weldCtx(f.id, st), f); return 'tool';
      case 'trimExtend': applyTrimExtend(this.weldCtx(f.id, st), f); return 'body';
      case 'endCap': applyEndCap(this.weldCtx(f.id, st), f); return 'tool';
      case 'gusset': applyGusset(this.weldCtx(f.id, st), f); return 'tool';
      case 'weldBead': applyWeldBead(this.weldCtx(f.id, st), f); return 'tool';
    }
    if (SURFACE_TYPES.has(f.type)) return this.surf.apply(f as SurfaceFeature, st);
    return 'none';
  }

  /** What the sheet metal features (sheetmetal.ts) use of the builder. */
  private sheetHost(): SheetHost {
    return {
      sketchRegions: (id, st) => this.sketchRegions(id, st as State),
      regionFace: (r, fr) => this.regionFace(r, fr),
      nearestSrc: (regions, p) => this.nearestSrc(regions, p),
      applyTool: (featId, st, tool, faces, isCut, noGain) => this.applyTool(featId, st as State, tool, faces, isCut, noGain),
      nameFaces: (featId, body, st, tool) => this.nameFaces(featId, body, st as State, tool),
      edges: (st) => this.edgesOf(st as State),
      resolveEdge: (ref, st) => this.resolveEdge(ref, st as State),
      missing: (id, what) => this.missing(id, what),
      error: (message) => new FeatureError(message),
      warn: (message) => { this.warning = message; },
    };
  }

  /** The flat pattern of the sheet metal part as last built. */
  flatPattern(quality = 1): FlatPatternResult {
    const r = flatPattern(this.current);
    if ('error' in r) return { pattern: null, error: r.error, mesh: null };
    return { pattern: r.pattern, mesh: this.meshBody(r.solid, quality) };
  }

  /** What the weldment features (weldments.ts) use of the builder. */
  private weldCtx(featId: Id, st: State): WeldCtx {
    return {
      st,
      featureId: featId,
      sketch: (id) => {
        const sk = st.sketches.get(id), frame = st.frames.get(id);
        if (!sk || !frame) throw this.missing(id, 'layout sketch');
        return { entities: sk.entities, frame };
      },
      face: (ref) => { const f = st.faces[this.resolveFace(ref, st)]; return { name: f.name, desc: f.desc }; },
      edge: (ref) => { const e = this.edgesOf(st)[this.resolveEdge(ref, st)]; return { desc: e.desc, faces: e.faces.map((i) => ({ desc: st.faces[i].desc, shape: st.faces[i].shape })) }; },
      nameTool: (prefix, shape, classify) => this.nameTool(prefix, shape, (_d, k) => classify(k)),
      applyTool: (tool, faces, noGain) => this.applyTool(featId, st, tool, faces as NamedFace[], false, noGain),
      setBody: (body, faces) => {
        st.faces = this.nameFaces(featId, body, st, faces as NamedFace[]);
        st.body = body;
        st.edges = null;
      },
      bodyBefore: (id) => {
        const i = this.order.get(id)?.index ?? -1;
        return i > 0 ? this.steps[i - 1]?.state.body ?? null : null;
      },
      toolsAfter: (id) => {
        const from = this.order.get(id)?.index ?? Infinity;
        const out = { adds: [] as Sh[], cuts: [] as Sh[] };
        for (const [fid, t] of st.tools) {
          const o = this.order.get(fid);
          // Members, caps, gussets and beads are in the weld state as they now stand (a trim may have changed them).
          if (!o || o.index <= from || WELD_TOOL_TYPES.has(o.type)) continue;
          for (const p of t.parts ?? [t]) (p.cut ? out.cuts : out.adds).push(p.shape);
        }
        return out;
      },
      warn: (m) => { this.warning = m; },
      err: (m) => new FeatureError(m),
      name: nameOf,
    };
  }

  /**
   * A sketch with geometry projected from the model, its projected entities
   * moved onto their model edges as the model now stands. When they moved,
   * the sketch is solved again so the geometry constrained to them follows.
   */
  private linkSketch(f: SketchFeature, frame: Frame, st: State): SketchFeature {
    if (!hasExternal(f)) return f;
    const sk = structuredClone(f);
    const find = (ref: EdgeRef) => {
      const onSurface = st.surfaces.length ? this.surf.surfaceEdgeDesc(ref, st) : null;
      if (onSurface) return onSurface;
      try {
        return this.edgesOf(st)[this.resolveEdge(ref, st)].desc;
      } catch (e) {
        if (e instanceof FeatureError) return null;
        throw e;
      }
    };
    const { moved, lost } = resolveExternal(sk, frame, find);
    if (lost.length) {
      st.lostRefs.set(f.id, lost);
      this.warning = lost.length === 1
        ? 'A projected sketch entity lost its model edge and stays where it was. Delete it or project the edge again.'
        : `${lost.length} projected sketch entities lost their model edges and stay where they were. Delete them or project the edges again.`;
    } else st.lostRefs.delete(f.id);
    if (moved) {
      // Dimension values arrive evaluated; one that could not be keeps the size it has.
      const ix = new SketchIndex(sk.entities);
      const value = (d: SkDimension) => (typeof d.value === 'number' ? d.value : measureDimension(sk, d, ix));
      solveSketch(sk.entities, sk.constraints, { value, analyze: false });
    }
    return sk;
  }

  // ---- references ----

  resolvePlane(ref: PlaneRef | null, st: State): Frame {
    if (!ref) throw new FeatureError('Select a plane or planar face');
    if (ref.kind === 'base') return BASE_FRAMES[ref.plane];
    if (ref.kind === 'feature') {
      const f = st.frames.get(ref.id);
      if (!f) throw this.missing(ref.id, 'reference plane');
      return f;
    }
    const onSurface = st.surfaces.length ? this.surf.surfacePlane(ref.face, st, ref.x) : null;
    if (onSurface) return onSurface;
    const i = this.resolveFace(ref.face, st);
    const d = st.faces[i].desc;
    if (d.type !== 'plane') throw new FeatureError('The selected face is not planar');
    return planarFaceFrame(d, ref.x);
  }

  private tol(st: State): number {
    if (!st.body) return 1e-6;
    const b = boxOf(st.body);
    return b ? Math.max(1e-7, dist(b.min, b.max) * 1e-7) : 1e-6;
  }

  resolveFace(ref: FaceRef, st: State): number {
    const cands: number[] = [];
    st.faces.forEach((f, i) => { if (f.name === ref.name) cands.push(i); });
    // A copy's face level with its original's used to take the original's name
    // (see nameFaces): a reference saved then to a copy carries the original's
    // name and the copy's place. When the one face of that name is not there,
    // its copies ("name@pattern.n") are candidates too.
    if (cands.length === 1 && !ref.name.includes('@') && dist(st.faces[cands[0]].desc.center, ref.sig.c) > this.tol(st) * 10) {
      st.faces.forEach((f, i) => { if (f.name.startsWith(ref.name + '@')) cands.push(i); });
    }
    const near = (list: number[]) =>
      list.reduce((best, i) => (best < 0 || dist(st.faces[i].desc.center, ref.sig.c) < dist(st.faces[best].desc.center, ref.sig.c) ? i : best), -1);
    const fits = (d: SurfDesc) => d.type === ref.sig.type && (!ref.sig.n || dot(d.d, ref.sig.n) > 0.999);
    // A single face of that name is it, unless it is plainly another kind of
    // face (references saved before a naming fix): then the signature decides.
    if (cands.length === 1 && fits(st.faces[cands[0]].desc)) return cands[0];
    if (cands.length > 1) return near(cands);
    // A face of a surface body is not one of the solid's: say so rather than "no longer exists".
    if (!cands.length && st.surfaces.length && this.surf.findFace(ref, st)) throw new FeatureError(`A selected face${this.maker(ref.name)} is on a surface body, not the solid. Edit the feature and select a face of the solid.`);
    // Fallback: same type and orientation, nearest centre.
    const b = st.body ? boxOf(st.body) : null;
    const lim = b ? dist(b.min, b.max) * 0.05 : 1;
    const alt = st.faces
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => fits(f.desc) && dist(f.desc.center, ref.sig.c) < lim);
    if (alt.length) return near(alt.map((a) => a.i));
    if (cands.length === 1) return cands[0];
    throw new FeatureError(`A referenced face${this.maker(ref.name)} no longer exists. Edit the feature and select it again.`);
  }

  resolveEdge(ref: EdgeRef, st: State): number {
    return this.resolveEdgePieces(ref, st, false)[0];
  }

  /**
   * The edges a reference stands for now. split: an edge an upstream feature
   * cut in two (its name gained #0, #1...) is all its pieces, as a fillet or
   * chamfer on it should round all of it (it rounded the nearest half). An
   * edge found only by its place, its name gone, is said in a warning: the
   * fillet moved onto a neighbouring edge without a word.
   */
  private resolveEdgePieces(ref: EdgeRef, st: State, split: boolean): number[] {
    const edges = this.edgesOf(st);
    const exact = edges.flatMap((e, i) => (e.name === ref.name ? [i] : []));
    const near = (list: number[]) =>
      list.reduce((best, i) => (best < 0 || dist(edges[i].desc.mid, ref.sig.m) < dist(edges[best].desc.mid, ref.sig.m) ? i : best), -1);
    if (exact.length === 1) return exact;
    const base = ref.name.replace(/#\d+$/, '');
    const same = edges.flatMap((e, i) => (e.name.replace(/#\d+$/, '') === base ? [i] : []));
    if (same.length) return split && base === ref.name ? same : [near(same)];
    if (st.surfaces.length && this.surf.findEdge(ref, st)) throw new FeatureError(`A selected edge${this.maker(ref.name)} is on a surface body, not the solid. Edit the feature and select an edge of the solid.`);
    const b = st.body ? boxOf(st.body) : null;
    const lim = b ? dist(b.min, b.max) * 0.02 : 1;
    const alt = edges.flatMap((e, i) => (e.desc.type === ref.sig.type && dist(e.desc.mid, ref.sig.m) < lim ? [i] : []));
    if (alt.length) {
      if (split) this.warning = `A selected edge${this.maker(ref.name)} is gone; the edge nearest its place was used. Check the result, or edit the feature and select the edge again.`;
      return [near(alt)];
    }
    throw new FeatureError(`A referenced edge${this.maker(ref.name)} no longer exists. Edit the feature and select it again.`);
  }

  /** Point and unit direction of an axis reference. */
  resolveAxis(ref: AxisRef | null, st: State): { p: Vec3; d: Vec3 } {
    if (!ref) throw new FeatureError('Select a direction or axis');
    const onSurface = st.surfaces.length ? this.surf.surfaceAxis(ref, st) : null;
    if (onSurface) return onSurface;
    switch (ref.kind) {
      case 'base': return { p: [0, 0, 0], d: ref.axis === 'x' ? [1, 0, 0] : ref.axis === 'y' ? [0, 1, 0] : [0, 0, 1] };
      case 'edge': {
        const e = this.edgesOf(st)[this.resolveEdge(ref.edge, st)].desc;
        if (e.type === 'line') return { p: e.a, d: e.dir! };
        if (e.type === 'circle') return { p: e.center!, d: normalize(e.axis!) };
        throw new FeatureError('The selected edge is not straight or circular');
      }
      case 'face': {
        const f = st.faces[this.resolveFace(ref.face, st)].desc;
        if (f.type === 'plane') return { p: f.center, d: f.d };
        if (f.type === 'cylinder' || f.type === 'sphere') return { p: f.p, d: f.d };
        throw new FeatureError('Select a planar or cylindrical face');
      }
      case 'sketchLine': {
        const sk = st.sketches.get(ref.sketch);
        const fr = st.frames.get(ref.sketch);
        if (!sk || !fr) throw this.missing(ref.sketch, 'axis sketch');
        const ix = new SketchIndex(sk.entities);
        const l = ix.get(ref.entity);
        if (!l || l.t !== 'line') throw new FeatureError('The axis line is missing');
        const a = toWorld(fr, ix.pt(l.a)), b = toWorld(fr, ix.pt(l.b));
        return { p: a, d: normalize(sub(b, a)) };
      }
    }
  }

  edgesOf(st: State): NamedEdge[] {
    if (st.edges) return st.edges;
    if (!st.body) return (st.edges = []);
    const edges = subShapes(st.body, 'edge');
    const index = new ShapeIndex(edges);
    const adj: number[][] = edges.map(() => []);
    st.faces.forEach((f, fi) => {
      for (const e of subShapes(f.shape, 'edge')) {
        const j = index.find(e.wrapped);
        if (j >= 0 && !adj[j].includes(fi)) adj[j].push(fi);
      }
    });
    const named: NamedEdge[] = edges.map((shape, i) => {
      const desc = describeEdge(shape);
      const names = [...new Set(adj[i].map((fi) => st.faces[fi].name))].sort();
      return { shape, desc, faces: adj[i], name: names.join('|') || 'free' };
    });
    // Disambiguate edges sharing the same pair of faces by position.
    const groups = new Map<string, number[]>();
    named.forEach((e, i) => { const g = groups.get(e.name); if (g) g.push(i); else groups.set(e.name, [i]); });
    for (const [, ids] of groups) {
      if (ids.length < 2) continue;
      ids.sort((a, b) => cmpVec(named[a].desc.mid, named[b].desc.mid));
      ids.forEach((id, k) => { named[id].name += `#${k}`; });
    }
    return (st.edges = named);
  }

  // ---- naming ----

  /**
   * copies: the tool faces are copies (pattern or mirror) placed elsewhere. A
   * copy's face lying on the surface of a face of the body (a copy's top face
   * level with its seed's) took the body face's name: two faces of one name,
   * found again only by position (a sketch on a copy went to another copy when
   * the spacing changed) and with no sign of the pattern (suppressing it left
   * that sketch on the seed). Such a face keeps the body face's name only when
   * the two touch.
   */
  private nameFaces(featId: Id, body: Sh, st: State, tool: NamedFace[], fallback?: (d: SurfDesc, k: number) => string, copies = false): NamedFace[] {
    const tol = Math.max(this.tol(st), 1e-6);
    const prev = st.faces;
    const score = (d: SurfDesc, c: NamedFace) => dist(d.center, c.desc.center) / Math.sqrt(Math.max(c.desc.area, 1e-12));
    // Faces without an exact descriptor are compared by centre, which moves
    // when a later feature trims them: then their surface tells.
    const surfaces = new SurfaceCache();
    const same = (shape: Sh, d: SurfDesc, c: NamedFace) =>
      sameSurface(d, c.desc, tol) || (!EXACT_SURFACES.has(d.type) && d.type === c.desc.type && sharesSurface(shape, c.shape, surfaces));
    let k = 0;
    try {
      return subShapes(body, 'face').map((shape) => {
        const desc = describeFace(shape);
        let best: NamedFace | null = null, bestS = Infinity;
        for (const c of prev) {
          if (!same(shape, desc, c)) continue;
          if (copies && !touching(shape, c.shape, tol) && tool.some((t) => same(shape, desc, t))) continue;
          const s = score(desc, c);
          if (s < bestS) { bestS = s; best = c; }
        }
        if (!best) {
          for (const c of tool) {
            if (!same(shape, desc, c)) continue;
            const s = score(desc, c);
            if (s < bestS) { bestS = s; best = c; }
          }
        }
        if (best) return { shape, desc, name: best.name, feature: best.feature };
        const name = fallback ? fallback(desc, k) : `${featId}:n${k}`;
        k++;
        return { shape, desc, name, feature: featId };
      });
    } finally {
      surfaces.dispose();
    }
  }

  private nameTool(featId: Id, tool: Sh, classify: (d: SurfDesc, k: number, shape: Sh) => string): NamedFace[] {
    return subShapes(tool, 'face').map((shape, k) => {
      const desc = describeFace(shape);
      return { shape, desc, name: `${featId}:${classify(desc, k, shape)}`, feature: featId };
    });
  }

  /** Combines a tool with the body and renames faces. */
  private applyTool(featId: Id, st: State, tool: Sh, toolFaces: NamedFace[], isCut: boolean, noGain = 'The feature adds no material: it lies inside the part. Check its direction.', copies = false) {
    let body: Sh;
    if (isCut) {
      if (!st.body) throw new FeatureError('There is no material to cut');
      body = cut(st.body, tool);
      if (isEmpty(body)) throw new FeatureError('The cut removes all material');
      const v0 = volumeOfBody(st.body);
      if (v0 > 0 && volumeOfBody(body) >= v0 * (1 - 1e-9)) this.warning = 'The cut does not remove any material. Check its direction.';
    } else {
      body = st.body ? fuse(st.body, tool) : tool;
      // A boss extruded into the part (Reverse direction by mistake) changed nothing, without a word.
      const v0 = st.body ? volumeOfBody(st.body) : 0;
      if (v0 > 0 && volumeOfBody(body) <= v0 * (1 + 1e-9)) this.warning = noGain;
    }
    st.faces = this.nameFaces(featId, body, st, toolFaces, undefined, copies);
    st.body = body;
    st.edges = null;
    st.tools.set(featId, { shape: tool, cut: isCut, faces: toolFaces });
  }

  // ---- sketches to faces ----

  /** Non-fatal message for the feature being built. */
  private warning: string | null = null;

  private sketchRegions(sketchId: Id, st: State, picks?: Vec2[]): { regions: Region[]; frame: Frame; sketch: SketchFeature } {
    const sketch = st.sketches.get(sketchId);
    const frame = st.frames.get(sketchId);
    if (!sketch || !frame) throw this.missing(sketchId, 'profile sketch');
    const prof = buildProfiles(sketch.entities, picks);
    // Selected regions are kept as points inside them; a sketch edit can
    // move a region off its point.
    const lost = picks?.length ? picks.filter((p) => !prof.all.some((r) => inRegion(p, r))).length : 0;
    if (lost && lost === picks!.length && prof.all.length) throw new FeatureError('The selected regions are no longer in the sketch. Edit the feature and select them again.');
    if (!prof.regions.length) {
      if (prof.openEnds.length) throw new FeatureError('The sketch has open contours. Close the profile to use it.');
      // Contours drawn over each other in part make no faces, which said nothing about why.
      if (hasOverlappingLines(sketch.entities)) throw new FeatureError('Lines in the sketch lie over each other. Trim them where they meet, or delete the copies.');
      throw new FeatureError('The sketch has no closed profile');
    }
    if (lost) this.warning = 'A selected region is no longer in the sketch and was left out. Edit the feature and select the regions again.';
    else if (prof.openEnds.length && !picks?.length) this.warning = 'Open contours in the sketch were ignored';
    else if (prof.crossing && !picks?.length) this.warning = 'Contours that cross each other were combined. Trim them where they cross, or select the regions to use.';
    return { regions: prof.regions, frame, sketch };
  }

  private segEdge(s: Seg2, fr: Frame): any {
    const w = (p: Vec2) => toWorld(fr, p);
    switch (s.k) {
      case 'line': return R.makeLine(w(s.a), w(s.b));
      case 'arc': {
        const poly = segPolyline(s);
        const mid = poly[Math.floor(poly.length / 2)];
        return R.makeThreePointArc(w(s.a), w(mid), w(s.b));
      }
      case 'circle': return R.makeCircle(s.r, w(s.c), s.ccw ? fr.n : scale(fr.n, -1));
      case 'bez': return R.makeBezierCurve(s.p.map(w));
    }
  }

  private loopWire(segs: Seg2[], fr: Frame): any {
    return R.assembleWire(segs.map((s) => this.segEdge(s, fr)));
  }

  private regionFace(r: Region, fr: Frame): any {
    let face = R.makeFace(this.loopWire(r.outer.segs, fr));
    if (r.holes.length) face = R.addHolesInFace(face, r.holes.map((h) => this.loopWire(h.segs, fr)));
    return face;
  }

  /**
   * The solid a region sweeps (make turns a face into it). A hole touching its
   * outline or another hole (a circle tangent to an edge) makes an invalid face
   * and so an invalid solid, which later features fail on: then the holes'
   * solids are cut from the outline's instead, which the boolean keeps valid.
   */
  /** Set when a region's holes were cut out because they touch (see regionSolid). */
  private touchingHoles = false;

  private regionSolid(r: Region, fr: Frame, make: (face: any) => Sh): Sh {
    const face = this.regionFace(r, fr);
    if (!holesMayTouch(r) || isValid(face as Sh)) return make(face);
    this.touchingHoles = true;
    const outer = make(R.makeFace(this.loopWire(r.outer.segs, fr)));
    const holes = r.holes.map((h) => make(R.makeFace(this.loopWire(reverseLoop(h).segs, fr))));
    return cut(outer, fuseAll(holes));
  }

  /** Nearest profile segment to a sketch-plane point: used to name side faces. */
  private nearestSrc(regions: Region[], p: Vec2): string {
    let best = Infinity, src = 'x';
    for (const r of regions) {
      for (const loop of [r.outer, ...r.holes]) {
        for (const s of loop.segs) {
          // Arcs by their own sweep: two arcs of one circle are both at no
          // distance from a point on either if only the circle counts.
          const d = seg2Dist(p, s);
          if (d < best) { best = d; src = s.src ?? 'x'; }
        }
      }
    }
    return src;
  }

  // ---- features ----

  private applyPlane(f: PlaneFeature, st: State) {
    const base = this.resolvePlane(f.ref, st);
    const off = num(f, 'offset') * (f.flip ? -1 : 1);
    st.frames.set(f.id, { ...base, o: add(base.o, scale(base.n, off)) });
  }

  /** Distance from a plane point along dir to just past the far side of the body. */
  private throughAllDepth(st: State, origin: Vec3, dir: Vec3, cut = true): number {
    const b = st.body ? boxOf(st.body) : null;
    if (!b) {
      if (!cut) throw new FeatureError('Through All needs a body to extrude through. Use Blind.');
      return 1000;
    }
    let far = 0;
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
      far = Math.max(far, dot(sub(c, origin), dir));
    }
    // A cut goes a little past the body, which avoids coincident faces in
    // the boolean; a boss stops at the far side of the body.
    return cut ? far + Math.max(1e-3, dist(b.min, b.max) * 0.01) : far;
  }

  private applyExtrude(f: ExtrudeFeature, st: State) {
    if (f.thin) throw new FeatureError(THIN_UNSUPPORTED);
    const { regions, frame } = this.sketchRegions(f.sketch, st, f.contours);
    const sign = (f.cut ? -1 : 1) * (f.flip ? -1 : 1);
    const dir = scale(frame.n, sign);
    let d1 = f.end === 'throughAll' ? this.throughAllDepth(st, frame.o, dir, f.cut) : num(f, 'depth');
    const noBody = 'There is no body to extrude through in this direction. Reverse the direction or use Blind.';
    if (d1 <= 0) throw new FeatureError(f.end === 'throughAll' ? noBody : 'Depth must be greater than zero');
    let start = 0;
    let total = d1;
    if (f.end === 'midPlane') { start = -d1 / 2; total = d1; }
    else if (f.dir2) {
      const d2 = f.dir2.end === 'throughAll' ? this.throughAllDepth(st, frame.o, scale(dir, -1), f.cut) : num(f, 'dir2.depth');
      // Reversing Direction 1 cannot fix Direction 2: say which one has no body.
      if (!(d2 > 0)) throw new FeatureError(f.dir2.end === 'throughAll' ? 'There is no body to extrude through in Direction 2. Use Blind for it, or turn Direction 2 off.' : 'Direction 2 depth must be greater than zero');
      start = -d2; total = d1 + d2;
    }
    d1 = total;
    const draft = f.draft ? num(f, 'draft') : 0;
    if (draft < 0) throw new FeatureError('The draft angle cannot be negative. Use Draft outward to taper the other way.');
    if (draft >= 90) throw new FeatureError('The draft angle must be less than 90 degrees');
    const extrudeAll = (from: number, length: number, d: Vec3): Sh => {
      const pieces: Sh[] = [];
      for (const r of regions) {
        let solid = this.regionSolid(r, frame, (face) => R.basicFaceExtrusion(face, new R.Vector(scale(d, length))) as unknown as Sh);
        if (from !== 0) solid = translated(solid, scale(d, from));
        pieces.push(solid);
      }
      return pieces.length === 1 ? pieces[0] : fuseAll(pieces);
    };
    let tool: Sh;
    if (draft > 1e-9) {
      // A taper that closes the profile (or, outward, one of its holes)
      // before the end would carry on through the apex and widen again: a
      // cone would become an hourglass with no error.
      const inset = Math.max(total + start, -start) * Math.tan((draft * Math.PI) / 180);
      for (const r of regions) {
        const room = f.draftOutward ? Math.min(Infinity, ...r.holes.map((h) => inradius(h.segs, []))) : inradius(r.outer.segs, r.holes.map((h) => h.segs));
        if (inset >= room * (1 - 1e-9)) throw new FeatureError('The draft closes the profile before the end of the extrusion. Use a smaller draft angle or depth.');
      }
      // Both directions taper away from the sketch plane, which keeps the
      // sketched profile (like other CAD systems do).
      const angle = draft * (f.draftOutward ? -1 : 1);
      this.touchingHoles = false;
      try {
        tool = this.draftLateral(extrudeAll(0, total + start, dir), frame, dir, 0, angle);
        if (start < 0) {
          const back = scale(dir, -1);
          tool = fuse(tool, this.draftLateral(extrudeAll(0, -start, back), frame, back, 0, angle));
        }
      } catch (e) {
        // The faces of a hole touching the outline meet at a single line, which cannot be tapered.
        if (this.touchingHoles) throw new FeatureError('The draft cannot taper a hole that touches the outline or another hole. Move the hole off it, or extrude without draft.');
        throw e;
      }
    } else tool = extrudeAll(start, d1, dir);
    const classify = (d: SurfDesc, _k: number, shape: Sh) => {
      if (d.type === 'plane' && Math.abs(dot(d.d, frame.n)) > 1 - 1e-6) {
        const s = dot(sub(d.center, frame.o), dir);
        return Math.abs(s - start) < Math.abs(s - (start + d1)) ? 'cap0' : 'cap1';
      }
      return 'side:' + this.nearestSrc(regions, toLocal(frame, faceMidPoint(shape)));
    };
    this.applyTool(f.id, st, tool, this.nameTool(f.id, tool, classify), f.cut);
  }

  private draftLateral(tool: Sh, fr: Frame, dir: Vec3, start: number, angleDeg: number): Sh {
    const oc = getOc();
    const origin = add(fr.o, scale(dir, start));
    const builder = new oc.BRepOffsetAPI_DraftAngle(tool.wrapped);
    const pln = plane(origin, dir);
    const gd = gdir(dir);
    try {
      for (const face of subShapes(tool, 'face')) {
        const d = describeFace(face);
        if (d.type === 'plane' && Math.abs(dot(d.d, dir)) > 1 - 1e-6) continue;
        builder.Add(face.wrapped, gd, (angleDeg * Math.PI) / 180, pln, true);
        if (!builder.AddDone()) throw new FeatureError('Draft could not be applied to the profile');
      }
      builder.Build();
      return wrap(builder.Shape());
    } catch (e) {
      if (e instanceof FeatureError) throw e;
      throw new FeatureError('Draft could not be applied to the profile');
    } finally {
      builder.delete();
      pln.delete();
      gd.delete();
    }
  }

  private applyRevolve(f: RevolveFeature, st: State) {
    if (f.thin) throw new FeatureError(THIN_UNSUPPORTED);
    const { regions, frame, sketch } = this.sketchRegions(f.sketch, st, f.contours);
    let axis: { p: Vec3; d: Vec3 };
    if (f.axis) axis = this.resolveAxis(f.axis, st);
    else {
      const ix = new SketchIndex(sketch.entities);
      const lines = sketch.entities.filter((e) => e.t === 'line' && e.construction);
      // Construction lines ending on the profile (a center rectangle's
      // diagonals, the full length a sketch fillet keeps) are part of the
      // shape: a centerline standing free of it is the axis, wherever it is listed.
      const onProfile = new Set(sketch.entities.flatMap((e) => (e.t !== 'point' && !e.construction ? pointIdsOf(e) : [])));
      const cl = lines.find((l) => l.t === 'line' && !l.ext && !onProfile.has(l.a) && !onProfile.has(l.b)) ?? lines[0];
      if (!cl || cl.t !== 'line') throw new FeatureError('Select an axis of revolution (or add a centerline to the sketch)');
      const a = toWorld(frame, ix.pt(cl.a)), b = toWorld(frame, ix.pt(cl.b));
      axis = { p: a, d: normalize(sub(b, a)) };
    }
    const angle = num(f, 'angle');
    if (angle <= 0) throw new FeatureError('Angle must be greater than zero');
    // More than a turn used to be cut to one without a word.
    if (angle > 360 + 1e-9) throw new FeatureError('The angle cannot be more than 360 degrees');
    // Map a 3D point back into the sketch plane by undoing the rotation.
    const a2 = toLocal(frame, axis.p);
    const b2 = toLocal(frame, add(axis.p, axis.d));
    const d2: Vec2 = [b2[0] - a2[0], b2[1] - a2[1]];
    const dl = Math.hypot(d2[0], d2[1]) || 1;
    d2[0] /= dl; d2[1] /= dl;
    const perp: Vec2 = [-d2[1], d2[0]];
    if (Math.abs(dot(axis.d, frame.n)) < 1e-6 && Math.abs(dot(sub(axis.p, frame.o), frame.n)) < 1e-6 * (1 + len(axis.p))) {
      // A profile on both sides of an in-plane axis would sweep through itself.
      let lo = 0, hi = 0, size = 0;
      for (const r of regions) {
        for (const q of r.outer.poly) {
          const s = (q[0] - a2[0]) * perp[0] + (q[1] - a2[1]) * perp[1];
          lo = Math.min(lo, s); hi = Math.max(hi, s); size = Math.max(size, Math.abs(s));
        }
      }
      const tol = 1e-6 * (1 + size);
      if (lo < -tol && hi > tol) throw new FeatureError('The profile crosses the axis of revolution. Keep it on one side of the axis.');
    }
    const sgn = f.flip ? -1 : 1;
    const d = scale(axis.d, sgn);
    const pieces: Sh[] = [];
    for (const r of regions) {
      let solid = this.regionSolid(r, frame, (face) => R.revolution(face, axis.p, d, angle) as unknown as Sh);
      if (f.end === 'midPlane' && angle < 360) solid = rotated(solid, axis.p, d, (-angle * Math.PI) / 360);
      pieces.push(solid);
    }
    const tool = pieces.length === 1 ? pieces[0] : fuseAll(pieces);
    const s0 = regions[0].sample;
    const side = Math.sign((s0[0] - a2[0]) * perp[0] + (s0[1] - a2[1]) * perp[1]) || 1;
    // Mid-plane revolves were turned back by half the angle; undo that to
    // compare with the sketch plane.
    const back = f.end === 'midPlane' && angle < 360 ? (angle * Math.PI) / 360 : 0;
    const inPlane = (p: Vec3) => Math.abs(dot(sub(p, frame.o), frame.n)) < 1e-6 * (1 + len(p));
    const classify = (desc: SurfDesc, _k: number, shape: Sh) => {
      if (desc.type === 'plane' && Math.abs(dot(desc.d, axis.d)) < 1e-6) {
        return inPlane(rotatePoint(desc.center, axis.p, d, back)) ? 'cap0' : 'cap1';
      }
      // A full surface of revolution has its centroid on the axis, so locate
      // the face by the profile curve that generated it: its edge in the
      // sketch plane on the profile's side (the middle of that edge, as the
      // middle of its ends can lie on another curve, like the chord of an arc).
      const onSide = (q: Vec2) => side * ((q[0] - a2[0]) * perp[0] + (q[1] - a2[1]) * perp[1]) >= -1e-6 * (1 + Math.hypot(q[0], q[1]));
      for (const e of subShapes(shape, 'edge')) {
        const ed = describeEdge(e);
        const ends = [ed.a, ed.b, ed.mid].map((p) => rotatePoint(p, axis.p, d, back));
        if (!ends.every(inPlane)) continue;
        const mid = toLocal(frame, ends[2]);
        if (onSide(mid)) return 'side:' + this.nearestSrc(regions, mid);
      }
      const pts = subShapes(shape, 'vertex')
        .map((v) => rotatePoint(vertexPoint(v), axis.p, d, back))
        .filter(inPlane)
        .map((p) => toLocal(frame, p))
        .filter((q) => side * ((q[0] - a2[0]) * perp[0] + (q[1] - a2[1]) * perp[1]) >= -1e-6 * (1 + Math.hypot(q[0], q[1])));
      if (pts.length) {
        const c: Vec2 = [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length];
        return 'side:' + this.nearestSrc(regions, c);
      }
      const v = sub(desc.center, axis.p);
      const axial = dot(v, axis.d);
      const rho = len(sub(v, scale(axis.d, axial)));
      const p: Vec2 = [a2[0] + d2[0] * axial + perp[0] * rho * side, a2[1] + d2[1] * axial + perp[1] * rho * side];
      return 'side:' + this.nearestSrc(regions, p);
    };
    this.applyTool(f.id, st, tool, this.nameTool(f.id, tool, classify), f.cut);
  }

  /** Edges selected directly plus every edge of the selected faces (`from`: edge to the selected face it came from). */
  private collectEdges(st: State, edges: EdgeRef[], faces: FaceRef[], from?: Map<number, number>): number[] {
    const all = this.edgesOf(st);
    const set = new Set<number>();
    for (const e of edges) for (const i of this.resolveEdgePieces(e, st, true)) set.add(i);
    for (const fr of faces) {
      const fi = this.resolveFace(fr, st);
      all.forEach((e, i) => { if (e.faces.includes(fi)) { set.add(i); from?.set(i, fi); } });
    }
    if (!set.size) throw new FeatureError('Select edges or faces');
    return [...set];
  }

  private applyFillet(f: FilletFeature, st: State) {
    if (!st.body) throw new FeatureError('There is no body to fillet');
    const r = num(f, 'radius');
    if (r <= 0) throw new FeatureError('Radius must be greater than zero');
    const ids = this.collectEdges(st, f.edges, f.faces);
    const all = this.edgesOf(st);
    const oc = getOc();
    const builder = new oc.BRepFilletAPI_MakeFillet(st.body.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational);
    let body: Sh;
    try {
      for (const i of ids) builder.Add(r, all[i].shape.wrapped);
      builder.Build();
      body = wrap(builder.Shape());
    } catch {
      throw new FeatureError('The fillet could not be created. Try a smaller radius or fewer edges.');
    } finally {
      builder.delete();
    }
    // OpenCascade sometimes returns a degenerate solid instead of failing.
    if (degenerate(body, st.body)) throw new FeatureError('The fillet could not be created. Try a smaller radius.');
    const mids = ids.map((i) => ({ m: all[i].desc.mid, name: all[i].name }));
    st.faces = this.nameFaces(f.id, body, st, [], (d) => `${f.id}:f:${nearestName(mids, d.center)}`);
    st.body = body;
    st.edges = null;
  }

  private applyChamfer(f: ChamferFeature, st: State) {
    if (!st.body) throw new FeatureError('There is no body to chamfer');
    const d1 = num(f, 'distance');
    if (d1 <= 0) throw new FeatureError('Distance must be greater than zero');
    const d2 = f.mode === 'twoDistance' ? num(f, 'distance2') : d1;
    if (d2 <= 0) throw new FeatureError('Distance 2 must be greater than zero');
    const angle = f.mode === 'distanceAngle' ? num(f, 'angle') : 45;
    if (!(angle > 0 && angle < 90)) throw new FeatureError('The chamfer angle must be between 0 and 90 degrees');
    const from = new Map<number, number>();
    const ids = this.collectEdges(st, f.edges, f.faces, from);
    const all = this.edgesOf(st);
    const oc = getOc();
    const builder = new oc.BRepFilletAPI_MakeChamfer(st.body.wrapped);
    let body: Sh;
    try {
      for (const i of ids) {
        const e = all[i];
        if (f.mode === 'distance') builder.Add(d1, e.shape.wrapped);
        else {
          // Distance 1 is measured on this face. Round a selected face it is
          // the neighbour of every edge (Flip: the face itself); it used to
          // depend on the order of the faces, so the chamfer changed sides
          // from one edge to the next.
          const sel = from.get(i);
          const fi = sel === undefined ? (e.faces[f.flip ? 1 : 0] ?? e.faces[0]) : f.flip ? sel : (e.faces.find((x) => x !== sel) ?? sel);
          const face = st.faces[fi].shape.wrapped;
          if (f.mode === 'twoDistance') builder.Add(d1, d2, e.shape.wrapped, face);
          else builder.AddDA(d1, (angle * Math.PI) / 180, e.shape.wrapped, face);
        }
      }
      builder.Build();
      body = wrap(builder.Shape());
    } catch {
      throw new FeatureError('The chamfer could not be created. Try a smaller distance.');
    } finally {
      builder.delete();
    }
    if (degenerate(body, st.body)) throw new FeatureError('The chamfer could not be created. Try a smaller distance.');
    const mids = ids.map((i) => ({ m: all[i].desc.mid, name: all[i].name }));
    st.faces = this.nameFaces(f.id, body, st, [], (d) => `${f.id}:c:${nearestName(mids, d.center)}`);
    st.body = body;
    st.edges = null;
  }

  private applyShell(f: ShellFeature, st: State) {
    if (!st.body) throw new FeatureError('There is no body to shell');
    const t = num(f, 'thickness');
    if (t <= 0) throw new FeatureError('Thickness must be greater than zero');
    const removed = f.faces.map((r) => st.faces[this.resolveFace(r, st)].shape);
    const solids = subShapes(st.body, 'solid');
    let body: Sh;
    if (solids.length <= 1) body = this.shellSolid(st.body, removed, t, f.outward, st);
    else {
      // Separate bodies are shelled one by one: those with a face to open,
      // or every one when the shell opens no face.
      body = compound(solids.map((solid) => {
        const own = subShapes(solid, 'face');
        const mine = removed.filter((r) => own.some((o) => o.wrapped.IsSame(r.wrapped)));
        return removed.length && !mine.length ? solid : this.shellSolid(solid, mine, t, f.outward, st);
      }));
    }
    const prev = st.faces;
    st.faces = this.nameFaces(f.id, body, st, [], (d) => {
      // Offset faces are parallel to an original face: name after it.
      let best = 'x', bd = Infinity;
      for (const p of prev) {
        if (p.desc.type !== d.type) continue;
        const par = d.type === 'plane' ? Math.abs(dot(p.desc.d, d.d)) > 1 - 1e-6 : d.type === 'cylinder' ? Math.abs(dot(p.desc.d, d.d)) > 1 - 1e-6 && dist(p.desc.p, d.p) < 1e-4 : true;
        if (!par) continue;
        const dd = dist(p.desc.center, d.center);
        if (dd < bd) { bd = dd; best = p.name; }
      }
      return `${f.id}:in:${best}`;
    });
    st.body = body;
    st.edges = null;
  }

  /** Shells one solid, opening the given faces of it (none: a closed hollow solid). */
  private shellSolid(solid: Sh, removed: Sh[], t: number, outward: boolean, st: State): Sh {
    const oc = getOc();
    let body: Sh;
    if (!removed.length) {
      // No faces to open: a closed hollow part. The thick-solid builder
      // would return only the offset solid (the cavity), so offset the
      // whole body and take the material between the two surfaces.
      const builder = new oc.BRepOffsetAPI_MakeOffsetShape();
      const progress = new oc.Message_ProgressRange();
      try {
        builder.PerformByJoin(solid.wrapped, outward ? t : -t, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, progress);
        let offset = wrap(builder.Shape());
        // The offset of a body with holes can come back as a closed shell.
        const shells = subShapes(offset, 'solid').length ? [] : subShapes(offset, 'shell');
        if (shells.length === 1) {
          const fix = new oc.ShapeFix_Solid();
          try { offset = wrap(fix.SolidFromShell(shells[0].wrapped)); } finally { fix.delete(); }
        }
        body = outward ? cut(offset, solid) : cut(solid, offset);
      } catch {
        throw shellError(st, t, removed.length);
      } finally {
        builder.delete();
        progress.delete();
      }
    } else {
      const list = new oc.NCollection_List_TopoDS_Shape();
      for (const r of removed) list.Append(r.wrapped);
      const builder = new oc.BRepOffsetAPI_MakeThickSolid();
      try {
        builder.MakeThickSolidByJoin(solid.wrapped, list, outward ? t : -t, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
        builder.Build();
        body = wrap(builder.Shape());
      } catch {
        throw shellError(st, t, removed.length);
      } finally {
        builder.delete();
        list.delete();
      }
    }
    // A thickness too large for the part can come back as a degenerate or
    // unchanged solid instead of an error. An inward shell always removes
    // material (an outward one is only the new walls, so any size goes).
    const v0 = volumeOf(solid);
    if (degenerate(body, solid) || (!outward && v0 > 0 && volumeOf(body) >= v0 * (1 - 1e-6))) throw shellError(st, t, removed.length);
    return body;
  }

  private applyHole(f: HoleFeature, st: State) {
    const sketch = st.sketches.get(f.sketch);
    const frame = st.frames.get(f.sketch);
    if (!sketch || !frame) throw this.missing(f.sketch, 'hole position sketch');
    const pts = sketchPoints(sketch.entities);
    if (!pts.length) throw new FeatureError('Add sketch points to place holes');
    const r = num(f, 'diameter') / 2;
    if (r <= 0) throw new FeatureError('Diameter must be greater than zero');
    const depth = f.end === 'throughAll' ? this.throughAllDepth(st, frame.o, scale(frame.n, f.flip ? 1 : -1)) : num(f, 'depth');
    if (depth <= 0) throw new FeatureError('Depth must be greater than zero');
    // Profile in (radius, depth) coordinates, revolved around the hole axis.
    const prof: [number, number][] = [];
    // A counterbore or countersink as deep as the part leaves no hole below it
    // (a depth typed in the wrong unit): the part's far side along the hole.
    const far = st.body ? this.throughAllDepth(st, frame.o, scale(frame.n, f.flip ? 1 : -1), false) : 0;
    const through = (d: number, what: string) => { if (far > 0 && d >= far * (1 - 1e-9)) this.warning = `The ${what} goes through the part, so no hole of the hole diameter is left. Check its depth.`; };
    if (f.kind === 'counterbore') {
      const cr = num(f, 'cbDiameter') / 2, cd = num(f, 'cbDepth');
      if (cr <= r) throw new FeatureError('The counterbore diameter must be larger than the hole');
      if (cd <= 0) throw new FeatureError('Counterbore depth must be greater than zero');
      // A shallower hole would turn the profile back on itself and leave a
      // ring of material in the counterbore.
      if (f.end !== 'throughAll' && depth <= cd) throw new FeatureError('The hole depth must be greater than the counterbore depth');
      through(cd, 'counterbore');
      const d = Math.max(depth, cd + 1e-3);
      prof.push([0, 0], [cr, 0], [cr, cd], [r, cd], [r, d], [0, d]);
    } else if (f.kind === 'countersink') {
      const sr = num(f, 'csDiameter') / 2;
      const half = (num(f, 'csAngle') * Math.PI) / 360;
      if (sr <= r) throw new FeatureError('The countersink diameter must be larger than the hole');
      if (half <= 0 || half >= Math.PI / 2) throw new FeatureError('The countersink angle must be between 0 and 180 degrees');
      const sd = (sr - r) / Math.tan(half);
      // Like a counterbore: a blind hole ending inside its countersink was
      // silently made deeper than asked.
      if (f.end !== 'throughAll' && depth <= sd) throw new FeatureError('The hole depth must be greater than the countersink depth');
      through(sd, 'countersink');
      prof.push([0, 0], [sr, 0], [r, sd], [r, Math.max(depth, sd + 1e-3)], [0, Math.max(depth, sd + 1e-3)]);
    } else prof.push([0, 0], [r, 0], [r, depth], [0, depth]);
    // Small tip so the top face sits slightly above the surface for a clean cut.
    const dir = scale(frame.n, f.flip ? 1 : -1);
    const tools: Sh[] = [];
    const named: NamedFace[] = [];
    for (const p of pts) {
      const c = toWorld(frame, [p.x, p.y]);
      const xAxis = frame.x;
      const p3 = (q: [number, number]) => add(add(c, scale(xAxis, q[0])), scale(dir, q[1]));
      const edges = prof.map((q, i) => R.makeLine(p3(q), p3(prof[(i + 1) % prof.length])));
      const face = R.makeFace(R.assembleWire(edges));
      const tool = R.revolution(face, c, dir, 360) as unknown as Sh;
      tools.push(tool);
      named.push(...this.nameTool(f.id, tool, (_d, k) => `${p.id}:${k}`));
    }
    const tool = tools.length === 1 ? tools[0] : compound(tools);
    this.applyTool(f.id, st, tool, named, true);
  }

  private seedTools(featId: Id, seeds: Id[], st: State, verb = 'pattern'): Tool[] {
    if (!seeds.length) throw new FeatureError(`Select features to ${verb}`);
    return seeds.flatMap((id) => {
      const t = st.tools.get(id);
      if (t) return t.parts ?? [t];
      // Say why: the seed is gone, later in the tree, failed, or of a kind
      // that adds no tool body.
      const at = this.order.get(id);
      if (at === undefined) throw new FeatureError('A seed feature no longer exists');
      if (at.index > (this.order.get(featId)?.index ?? Infinity)) throw new FeatureError(`The seed feature ${nameOf(id)} comes after this feature in the tree`);
      if (SEED_TYPES.has(at.type)) throw new FeatureError(`The seed feature ${nameOf(id)} failed to build`);
      throw new FeatureError(`${nameOf(id)} cannot be ${verb}ed (only extrudes, revolves, holes, lofts, sweeps and patterns)`);
    });
  }

  /** Applies transformed copies of seed tools (in seed order). */
  private applyInstances(featId: Id, st: State, seeds: Tool[], transforms: ((s: Sh) => Sh)[]) {
    if (!transforms.length) throw new FeatureError('The pattern has no instances');
    const parts: Tool[] = [];
    let body = st.body;
    for (const seed of seeds) {
      const inst: Sh[] = [];
      const named: NamedFace[] = [];
      transforms.forEach((tf, i) => {
        const s = tf(seed.shape);
        inst.push(s);
        const faces = subShapes(s, 'face');
        faces.forEach((shape, k) => {
          const base = seed.faces[k]?.name ?? `${featId}:n${k}`;
          named.push({ shape, desc: describeFace(shape), name: `${base}@${featId}.${i + 1}`, feature: featId });
        });
      });
      const tool = inst.length === 1 ? inst[0] : compound(inst);
      if (seed.cut) {
        if (!body) throw new FeatureError('There is no material to cut');
        const v0 = volumeOfBody(body);
        body = cut(body, tool);
        if (v0 > 0 && !isEmpty(body) && volumeOfBody(body) >= v0 * (1 - 1e-9)) this.warning = 'The copies of a cut do not remove any material. Check the direction and spacing.';
      } else if (body) {
        const v0 = volumeOfBody(body);
        body = fuse(body, tool);
        if (v0 > 0 && volumeOfBody(body) <= v0 * (1 + 1e-9)) this.warning = 'The copies add no material: they lie inside the part. Check the direction and spacing.';
      } else body = fuseAll([tool]);
      parts.push({ shape: tool, cut: seed.cut, faces: named });
    }
    if (!body || isEmpty(body)) throw new FeatureError('The pattern removed all material');
    const allNamed = parts.flatMap((p) => p.faces);
    st.faces = this.nameFaces(featId, body, st, allNamed, undefined, true);
    st.body = body;
    st.edges = null;
    const tool = parts.length === 1 ? parts[0].shape : compound(parts.map((p) => p.shape));
    const mixed = parts.some((p) => p.cut) && parts.some((p) => !p.cut);
    st.tools.set(featId, { shape: tool, cut: parts.every((p) => p.cut), faces: allNamed, ...(mixed ? { parts } : {}) });
  }

  private dirVector(d: PatternDir, st: State, which: string): Vec3 {
    // "Select a direction or axis" did not say which of the two directions lacks one.
    if (!d.ref) throw new FeatureError(`Select a direction for ${which}`);
    const ax = this.resolveAxis(d.ref, st);
    return scale(ax.d, d.flip ? -1 : 1);
  }

  private applyLinearPattern(f: LinearPatternFeature, st: State) {
    const seeds = this.seedTools(f.id, f.seeds, st);
    const n1 = Math.round(num(f, 'dir1.count'));
    if (n1 < 1 || n1 > 1000) throw new FeatureError('Instance count must be between 1 and 1000');
    const v1 = scale(this.dirVector(f.dir1, st, 'Direction 1'), num(f, 'dir1.spacing'));
    // Zero spacing stacks every instance on the seed: nothing would change.
    if (n1 > 1 && len(v1) < 1e-9) throw new FeatureError('Direction 1 spacing must not be zero');
    let n2 = 1;
    let v2: Vec3 = [0, 0, 0];
    if (f.dir2) {
      n2 = Math.round(num(f, 'dir2.count'));
      if (n2 < 1 || n2 > 1000) throw new FeatureError('Instance count must be between 1 and 1000');
      v2 = scale(this.dirVector(f.dir2, st, 'Direction 2'), num(f, 'dir2.spacing'));
      if (n2 > 1 && len(v2) < 1e-9) throw new FeatureError('Direction 2 spacing must not be zero');
    }
    if (n1 * n2 > 2000) throw new FeatureError('Too many instances (maximum 2000)');
    // "Between 1 and 1000" allows 1 in one direction; the pattern needs a copy somewhere.
    if (n1 * n2 === 1) throw new FeatureError('The pattern has only the original. Set 2 or more instances.');
    const tfs: ((s: Sh) => Sh)[] = [];
    for (let i = 0; i < n1; i++) {
      for (let j = 0; j < n2; j++) {
        if (i === 0 && j === 0) continue;
        const v = add(scale(v1, i), scale(v2, j));
        tfs.push((s) => translated(s, v));
      }
    }
    this.applyInstances(f.id, st, seeds, tfs);
  }

  private applyCircularPattern(f: CircularPatternFeature, st: State) {
    const seeds = this.seedTools(f.id, f.seeds, st);
    const ax = this.resolveAxis(f.axis, st);
    const n = Math.round(num(f, 'count'));
    if (n < 2 || n > 1000) throw new FeatureError('Instance count must be between 2 and 1000');
    const total = num(f, 'angle');
    // A full turn either way spaces the instances round the whole circle.
    const step = f.equal ? (Math.abs(Math.abs(total) - 360) < 1e-9 ? total / n : total / (n - 1)) : total;
    const d = scale(ax.d, f.flip ? -1 : 1);
    const tfs: ((s: Sh) => Sh)[] = [];
    for (let i = 1; i < n; i++) {
      // An instance a whole number of turns round lands on the seed (0° or 360° spacing).
      const turns = (step * i) / 360;
      if (Math.abs(turns - Math.round(turns)) < 1e-9) throw new FeatureError('Pattern instances fall on top of each other. Check the angle.');
      const a = (step * i * Math.PI) / 180;
      tfs.push((s) => rotated(s, ax.p, d, a));
    }
    this.applyInstances(f.id, st, seeds, tfs);
  }

  private applyMirror(f: MirrorFeature, st: State) {
    const fr = this.resolvePlane(f.plane, st);
    if (!f.seeds.length) {
      if (!st.body) throw new FeatureError('There is no body to mirror');
      const m = mirrored(st.body, fr.o, fr.n);
      const tf = this.nameTool(f.id, m, (_d, k) => `m${k}`);
      // Name mirrored faces after their originals.
      const orig = st.faces;
      tf.forEach((t, k) => { if (orig[k]) t.name = `${orig[k].name}@${f.id}`; });
      this.applyTool(f.id, st, m, tf, false, 'The mirror adds no material: the part is already symmetric about the mirror plane.', true);
      return;
    }
    this.applyInstances(f.id, st, this.seedTools(f.id, f.seeds, st, 'mirror'), [(s) => mirrored(s, fr.o, fr.n)]);
  }

  /** The first closed region of a profile sketch, as an outer wire and hole wires. */
  private profileLoops(sketchId: Id, st: State): { outer: Seg2[]; holes: Seg2[][]; frame: Frame; extra: boolean } {
    const { regions, frame } = this.sketchRegions(sketchId, st);
    const r = regions[0];
    return { outer: r.outer.segs, holes: r.holes.map((h) => h.segs), frame, extra: regions.length > 1 };
  }

  private static readonly EXTRA_CONTOURS = 'Only the first closed contour of each profile was used; the other contours were ignored';

  private applyLoft(f: LoftFeature, st: State) {
    if (f.profiles.length < 2) throw new FeatureError('Select at least two profiles');
    const profs = f.profiles.map((id) => this.profileLoops(id, st));
    // Profiles drawn in one plane make no solid; "could not be created" did not say why.
    for (let i = 1; i < profs.length; i++) {
      const a = profs[i - 1].frame, b = profs[i].frame;
      const size = Math.max(1, len(a.o), len(b.o));
      if (Math.abs(dot(a.n, b.n)) > 1 - 1e-9 && Math.abs(dot(sub(b.o, a.o), a.n)) < 1e-9 * size) {
        throw new FeatureError(`The profiles ${nameOf(f.profiles[i - 1])} and ${nameOf(f.profiles[i])} lie in the same plane. Sketch each profile on its own plane.`);
      }
    }
    // Inner loops make a hollow loft when every profile has exactly one
    // (more than one cannot be matched between profiles reliably).
    const hollow = profs.every((p) => p.holes.length === 1);
    if (profs.some((p) => p.extra) || (!hollow && profs.some((p) => p.holes.length))) this.warning = ModelBuilder.EXTRA_CONTOURS;
    const failed = 'The loft could not be created from these profiles';
    let tool: Sh;
    try {
      tool = R.loft(profs.map((p) => this.loopWire(p.outer, p.frame)), { ruled: f.ruled }) as unknown as Sh;
    } catch {
      throw new FeatureError(failed);
    }
    if (flat(tool)) throw new FeatureError(failed);
    if (hollow) {
      let core: Sh;
      try {
        core = R.loft(profs.map((p) => this.loopWire(p.holes[0], p.frame)), { ruled: f.ruled }) as unknown as Sh;
      } catch {
        throw new FeatureError(failed);
      }
      tool = cut(tool, core);
      if (isEmpty(tool) || flat(tool)) throw new FeatureError(failed);
    }
    this.applyTool(f.id, st, tool, this.nameTool(f.id, tool, (_d, k) => `l${k}`), f.cut);
  }

  private applySweep(f: SweepFeature, st: State) {
    if (!f.profile || !f.path) throw new FeatureError('Select a profile and a path');
    if (f.profile === f.path) throw new FeatureError('The profile and the path are the same sketch. Draw the path in a sketch of its own.');
    const prof = this.profileLoops(f.profile, st);
    if (prof.extra) this.warning = ModelBuilder.EXTRA_CONTOURS;
    const pathSk = st.sketches.get(f.path);
    const pathFr = st.frames.get(f.path);
    if (!pathSk || !pathFr) throw this.missing(f.path, 'path sketch');
    const ix = new SketchIndex(pathSk.entities);
    // Path pieces with their sketch end points (none for closed curves).
    const pieces: { edges: any[]; a?: Vec2; b?: Vec2 }[] = [];
    for (const e of pathSk.entities) {
      if (e.construction) continue;
      const w = (id: string) => toWorld(pathFr, ix.pt(id));
      if (e.t === 'line') pieces.push({ edges: [R.makeLine(w(e.a), w(e.b))], a: ix.pt(e.a), b: ix.pt(e.b) });
      else if (e.t === 'arc') {
        const c = ix.pt(e.c), a = ix.pt(e.a), b = ix.pt(e.b);
        const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
        const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
        let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
        if (a1 <= a0) a1 += 2 * Math.PI;
        const am = (a0 + a1) / 2;
        pieces.push({ edges: [R.makeThreePointArc(w(e.a), toWorld(pathFr, [c[0] + r * Math.cos(am), c[1] + r * Math.sin(am)]), w(e.b))], a, b });
      } else if (e.t === 'spline') {
        const pts = e.pts.map((p) => ix.pt(p));
        pieces.push({ edges: splineBeziers(pts).map((bz) => R.makeBezierCurve(bz.map((p) => toWorld(pathFr, p)))), a: pts[0], b: pts[pts.length - 1] });
      } else if (e.t === 'circle') pieces.push({ edges: [R.makeCircle(e.r, toWorld(pathFr, ix.pt(e.c)), pathFr.n)] });
    }
    const edges = chainPieces(pieces).flatMap((p) => p.edges);
    if (!edges.length) throw new FeatureError('The path sketch is empty');
    let tool: Sh;
    try {
      const spine = R.assembleWire(edges);
      tool = R.genericSweep(this.loopWire(prof.outer, prof.frame), spine, { frenet: true }) as unknown as Sh;
      // Inner loops of the profile are swept too and removed (a tube profile makes a pipe).
      for (const h of prof.holes) tool = cut(tool, R.genericSweep(this.loopWire(h, prof.frame), R.assembleWire(edges), { frenet: true }) as unknown as Sh);
    } catch {
      throw new FeatureError(SWEEP_FAILED);
    }
    // A path in the profile's plane sweeps a solid without volume.
    if (isEmpty(tool) || flat(tool)) throw new FeatureError(SWEEP_FAILED);
    this.applyTool(f.id, st, tool, this.nameTool(f.id, tool, (_d, k) => `s${k}`), f.cut);
  }

  private applyDraft(f: DraftFeature, st: State) {
    if (!st.body) throw new FeatureError('There is no body to draft');
    if (!f.faces.length) throw new FeatureError('Select faces to draft');
    const fr = this.resolvePlane(f.neutral, st);
    const angle = num(f, 'angle');
    if (!(Math.abs(angle) < 90)) throw new FeatureError('The draft angle must be between -90 and 90 degrees');
    const oc = getOc();
    const dir = scale(fr.n, f.flip ? -1 : 1);
    const selected = f.faces.map((r) => st.faces[this.resolveFace(r, st)]);
    // It built without a word, like other features that change nothing used to.
    if (Math.abs(angle) < 1e-9) { this.warning = 'A draft angle of 0 degrees changes nothing. Enter an angle.'; return; }
    const builder = new oc.BRepOffsetAPI_DraftAngle(st.body.wrapped);
    const pln = plane(fr.o, dir);
    const gd = gdir(dir);
    let body: Sh;
    try {
      for (const sel of selected) {
        builder.Add(sel.shape.wrapped, gd, (angle * Math.PI) / 180, pln, true);
        if (!builder.AddDone()) throw new FeatureError('Draft cannot be applied to one of the faces');
      }
      builder.Build();
      body = wrap(builder.Shape());
    } catch (e) {
      if (e instanceof FeatureError) throw e;
      throw new FeatureError('The draft could not be created');
    } finally {
      builder.delete();
      pln.delete();
      gd.delete();
    }
    if (degenerate(body, st.body)) throw new FeatureError('The draft could not be created');
    // A drafted face is named after the face it was made from, not by its
    // place in the body: drafting one more face must not rename the others
    // (which would move a later fillet on one of their edges to another edge).
    const mids = selected.map((s) => ({ m: s.desc.center, name: s.name }));
    st.faces = this.nameFaces(f.id, body, st, [], (d) => `${f.id}:d:${nearestName(mids, d.center)}`);
    st.body = body;
    st.edges = null;
  }

  private importCache = new Map<Id, Sh>();
  private importVersions = new Map<Id, { text: string | undefined; version: number }>();
  private importSerial = 0;

  /** A file key is local to its document; another part may reuse it for other data. */
  private importVersion(blob: Id, text: string | undefined): number {
    const previous = this.importVersions.get(blob);
    if (previous && previous.text === text) return previous.version;
    const version = ++this.importSerial;
    this.importVersions.set(blob, { text, version });
    this.importCache.delete(blob);
    return version;
  }

  private async applyImport(f: ImportFeature, st: State, req: BuildRequest) {
    // Preview imports do not pass through the main step-cache key.
    this.importVersion(f.blob, req.blobs[f.blob]);
    let shape = this.importCache.get(f.blob);
    if (!shape) {
      const text = req.blobs[f.blob];
      if (!text) throw new FeatureError('The imported file data is missing');
      shape = f.format === 'brep' ? (R.deserializeShape(text) as unknown as Sh) : await readStepCached(text);
      this.importCache.set(f.blob, shape);
    }
    const named = this.nameTool(f.id, shape, (_d, k) => `i${k}`);
    this.applyTool(f.id, st, shape, named, false, 'The imported body adds no material: it lies inside the part.');
  }

  // ---- output ----

  private meshParams(shape: Sh, quality: number): { tol: number; ang: number } {
    const b = boxOf(shape);
    const diag = b ? dist(b.min, b.max) : 1;
    const q = Math.max(0, Math.min(2, quality));
    return { tol: Math.max(diag * [0.002, 0.0006, 0.0002][q], 1e-4), ang: [0.5, 0.25, 0.12][q] };
  }

  private meshBody(shape: Sh, quality: number): MeshData {
    const { tol, ang } = this.meshParams(shape, quality);
    const m = meshShape(shape, tol, ang);
    const e = meshEdgesOf(shape, tol, ang);
    return {
      positions: m.positions,
      normals: m.normals,
      indices: m.indices,
      vertexFace: new Float32Array(m.positions.length / 3),
      edgePositions: e.lines,
      edgeIds: new Float32Array(e.lines.length / 3),
      vertices: new Float32Array(0),
    };
  }

  private meshState(st: State, quality: number): { mesh: MeshData | null; faces: FaceInfo[]; edges: EdgeInfo[] } {
    if (!st.body) return { mesh: null, faces: [], edges: [] };
    const { tol, ang } = this.meshParams(st.body, quality);
    const m = meshShape(st.body, tol, ang);
    const faceIndex = new ShapeIndex(st.faces.map((f) => f.shape));
    const vertexFace = new Float32Array(m.positions.length / 3);
    const claimed = new Set<number>();
    for (let g = 0; g + 2 < m.faceGroups.length; g += 3) {
      const start = m.faceGroups[g], count = m.faceGroups[g + 1], hash = m.faceGroups[g + 2];
      const cands = faceIndex.findHash(hash);
      const fi = cands.find((c) => !claimed.has(c)) ?? cands[0] ?? 0;
      claimed.add(fi);
      for (let t = start; t < start + count; t++) vertexFace[m.indices[t]] = fi;
    }
    const edges = this.edgesOf(st);
    const edgeIndex = new ShapeIndex(edges.map((e) => e.shape));
    const em = meshEdgesOf(st.body, tol, ang);
    // Seam edges (a periodic face meeting itself) are not drawn.
    const periodic = new Set(['cylinder', 'cone', 'sphere', 'torus', 'revolution']);
    const isSeam = (ei: number) => {
      const e = edges[ei];
      return !!e && e.faces.length === 1 && periodic.has(st.faces[e.faces[0]]?.desc.type);
    };
    const keptLines: number[] = [];
    const keptIds: number[] = [];
    const claimedE = new Set<number>();
    for (let g = 0; g + 2 < em.groups.length; g += 3) {
      const start = em.groups[g], count = em.groups[g + 1], hash = em.groups[g + 2];
      const cands = edgeIndex.findHash(hash);
      const ei = cands.find((c) => !claimedE.has(c)) ?? cands[0] ?? 0;
      claimedE.add(ei);
      if (isSeam(ei)) continue;
      for (let k = start; k < start + count; k++) {
        keptLines.push(em.lines[k * 3], em.lines[k * 3 + 1], em.lines[k * 3 + 2]);
        keptIds.push(ei);
      }
    }
    const edgeLines = new Float32Array(keptLines);
    const edgeIds = new Float32Array(keptIds);
    const verts = subShapes(st.body, 'vertex').map(vertexPoint);
    const vertices = new Float32Array(verts.length * 3);
    verts.forEach((p, i) => vertices.set(p, i * 3));
    const faces: FaceInfo[] = st.faces.map((f) => {
      const d = f.desc;
      const info: FaceInfo = { name: f.name, type: d.type, center: d.center, area: d.area, feature: f.feature };
      if (d.type === 'plane') { info.normal = d.d; info.frame = planarFaceFrame(d); }
      if (d.type === 'cylinder' || d.type === 'sphere') { info.axis = { p: d.p, d: d.d }; info.radius = d.r; }
      return info;
    });
    const edgeInfos: EdgeInfo[] = edges.map((e) => ({
      name: e.name,
      type: e.desc.type,
      a: e.desc.a,
      b: e.desc.b,
      mid: e.desc.mid,
      length: e.desc.length,
      faces: e.faces,
      dir: e.desc.dir,
      center: e.desc.center,
      axis: e.desc.axis,
      radius: e.desc.radius,
    }));
    return {
      mesh: { positions: m.positions, normals: m.normals, indices: m.indices, vertexFace, edgePositions: edgeLines, edgeIds, vertices },
      faces,
      edges: edgeInfos,
    };
  }

  // ---- drawings ----

  /** Hidden-line removal projections of the current body. */
  project(views: ProjectionRequest[]): ProjectionResult[] {
    // Hidden surface bodies are not drawn (the views of one request share what is hidden).
    const hidden = new Set(views[0]?.hideSurfaces ?? []);
    const body = this.current.surfaces.length ? this.surf.allShapes(this.current, hidden) : this.current.body;
    const b = body ? boxOf(body) : null;
    // Curves other than lines and arcs are drawn within a thousandth of the part's size.
    const tol = b ? Math.max(dist(b.min, b.max) * 1e-3, 1e-4) : 0.01;
    return views.map((v) => {
      if (!body) return { id: v.id, visible: [], hidden: [], bounds: null };
      if (v.section && b) return { id: v.id, ...projectSection(body, b, v, tol) };
      return { id: v.id, ...projectShape(body, v.dir, v.x, tol, tol / 10, v.hidden !== false, v.smooth !== false) };
    });
  }

  // ---- evaluation ----

  massProperties(): MassProperties | null {
    const body = this.current.body;
    if (!body && this.current.surfaces.length) {
      // Only surfaces: no volume or mass; their area is stated apart.
      return { solid: false, volume: 0, area: 0, center: [0, 0, 0], inertia: [0, 0, 0, 0, 0, 0, 0, 0, 0], principal: eigenSym3([0, 0, 0, 0, 0, 0, 0, 0, 0]), surfaceArea: this.surf.area(this.current) };
    }
    if (!body) return null;
    const oc = getOc();
    const props = new oc.GProp_GProps();
    const sprops = new oc.GProp_GProps();
    try {
      oc.BRepGProp.VolumeProperties(body.wrapped, props, true, false, false);
      oc.BRepGProp.SurfaceProperties(body.wrapped, sprops, true, false);
      const c = props.CentreOfMass();
      const center = xyz(c);
      c.delete();
      const moment = (d: Vec3) => {
        const gp = pnt(center), gd = gdir(d);
        const ax = new oc.gp_Ax1(gp, gd);
        const v = props.MomentOfInertia(ax);
        ax.delete(); gp.delete(); gd.delete();
        return v;
      };
      const ixx = moment([1, 0, 0]), iyy = moment([0, 1, 0]), izz = moment([0, 0, 1]);
      const s = Math.SQRT1_2;
      const ixy = moment([s, s, 0]) - (ixx + iyy) / 2;
      const iyz = moment([0, s, s]) - (iyy + izz) / 2;
      const ixz = moment([s, 0, s]) - (ixx + izz) / 2;
      const inertia = [ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz];
      const volume = props.Mass();
      const b = boxOf(body);
      const solid = volume > (b ? dist(b.min, b.max) : 1) ** 3 * 1e-12;
      const out: MassProperties = { solid, volume, area: sprops.Mass(), center, inertia, principal: eigenSym3(inertia) };
      if (this.current.surfaces.length) out.surfaceArea = this.surf.area(this.current);
      return out;
    } finally {
      props.delete();
      sprops.delete();
    }
  }

  measure(a: MeasureTarget, b: MeasureTarget): MeasureResult {
    const oc = getOc();
    const shapeOf = (t: MeasureTarget): Sh => {
      if (t.kind === 'vertex') {
        const gp = pnt(t.p);
        const mv = new oc.BRepBuilderAPI_MakeVertex(gp);
        const v = wrap(mv.Vertex());
        mv.delete();
        gp.delete();
        return v;
      }
      if (t.kind === 'face') {
        const f = this.current.faces[t.index];
        const s = !f && this.current.surfaces.length ? this.surf.shapeAt(this.current, 'face', t.index, this.current.faces.length) : null;
        if (s) return s;
        if (!f) throw new FeatureError('Face not found');
        return f.shape;
      }
      const se = this.current.surfaces.length ? this.surf.shapeAt(this.current, 'edge', t.index, this.edgesOf(this.current).length) : null;
      if (se) return se;
      const e = this.edgesOf(this.current)[t.index];
      if (!e) throw new FeatureError('Edge not found');
      return e.shape;
    };
    const s1 = shapeOf(a), s2 = shapeOf(b);
    // The bindings do not expose Extrema_ExtFlag, so the long constructor
    // cannot be called: load the shapes and run it explicitly.
    const ext = new oc.BRepExtrema_DistShapeShape();
    const progress = new oc.Message_ProgressRange();
    try {
      ext.LoadS1(s1.wrapped);
      ext.LoadS2(s2.wrapped);
      ext.Perform(progress);
      if (!ext.IsDone() || ext.NbSolution() < 1) throw new FeatureError('Distance could not be computed');
      const p1 = ext.PointOnShape1(1), p2 = ext.PointOnShape2(1);
      const out = { distance: ext.Value(), p1: xyz(p1), p2: xyz(p2) };
      p1.delete(); p2.delete();
      return out;
    } finally {
      ext.delete();
      progress.delete();
    }
  }

  /** A STEP file of the current body; its product (what other CAD systems list the body as) is named `name`. */
  exportStep(name?: string): Uint8Array {
    // Surface bodies go into the file as shells beside the solid.
    const body = this.current.surfaces.length ? this.surf.allShapes(this.current) : this.current.body;
    if (!body) throw new FeatureError('There is no geometry to export');
    const oc = getOc();
    const writer = new oc.STEPControl_Writer();
    oc.Interface_Static.SetIVal('write.step.schema', 5);
    oc.Interface_Static.SetCVal('write.step.unit', 'MM');
    const progress = new oc.Message_ProgressRange();
    try {
      writer.Transfer(body.wrapped, oc.STEPControl_StepModelType.STEPControl_AsIs, true, progress);
      const done = writer.Write('/export.step');
      if (done !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new FeatureError('STEP export failed');
      const data: Uint8Array = oc.FS.readFile('/export.step');
      oc.FS.unlink('/export.step');
      return name ? namedStep(data, name) : data;
    } finally {
      writer.delete();
      progress.delete();
    }
  }

  exportBrep(): string {
    const body = this.current.body;
    if (!body) throw new FeatureError('There is no geometry to export');
    return getOc().BRepToolsWrapper.Write(body.wrapped);
  }

  /** Binary STL of the current body. */
  exportStl(quality: number): Uint8Array {
    const body = this.current.body;
    if (!body && this.current.surfaces.length) throw new FeatureError(STL_SOLIDS_ONLY);
    if (!body) throw new FeatureError('There is no geometry to export');
    const { tol, ang } = this.meshParams(body, Math.max(1, quality));
    const m = meshShape(body, tol * 0.5, ang * 0.5);
    const tris = m.indices.length / 3;
    const buf = new ArrayBuffer(84 + tris * 50);
    const dv = new DataView(buf);
    const header = 'Parametric binary STL';
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
    dv.setUint32(80, tris, true);
    let o = 84;
    const P = m.positions;
    for (let t = 0; t < tris; t++) {
      const i0 = m.indices[t * 3] * 3, i1 = m.indices[t * 3 + 1] * 3, i2 = m.indices[t * 3 + 2] * 3;
      const ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2];
      const vx = P[i2] - P[i0], vy = P[i2 + 1] - P[i0 + 1], vz = P[i2 + 2] - P[i0 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
      o += 12;
      for (const i of [i0, i1, i2]) {
        dv.setFloat32(o, P[i], true); dv.setFloat32(o + 4, P[i + 1], true); dv.setFloat32(o + 8, P[i + 2], true);
        o += 12;
      }
      dv.setUint16(o, 0, true);
      o += 2;
    }
    return new Uint8Array(buf);
  }

  /** The body built last with its faces and edges, in the order the build result lists them (assemblies place and combine these). */
  currentShapes(): {
    body: Sh | null; faces: { shape: Sh; desc: SurfDesc }[]; edges: Sh[];
    /** Surface bodies (shells), and their faces and edges in the order the build result lists them after the solid's. */
    surfaces: Sh[]; surfaceFaces: Sh[]; surfaceEdges: Sh[];
  } {
    const st = this.current;
    return {
      body: st.body, faces: st.faces.map((f) => ({ shape: f.shape, desc: f.desc })), edges: st.body ? this.edgesOf(st).map((e) => e.shape) : [],
      surfaces: st.surfaces.map((b) => b.shape), surfaceFaces: st.surfaces.flatMap((b) => b.faces.map((f) => f.shape)), surfaceEdges: st.surfaces.flatMap((b) => bodyEdges(b).map((e) => e.shape)),
    };
  }

  /** Current body volume (used by tests). */
  get hasBody(): boolean {
    return !!this.current.body;
  }

  faceCount(): number {
    return this.current.faces.length;
  }

  faceNames(): string[] {
    return this.current.faces.map((f) => f.name);
  }

  edgeNames(): string[] {
    return this.edgesOf(this.current).map((e) => e.name);
  }

  /** Hash of the body's topology (for tests). */
  topologyHash(): number {
    return this.current.body ? hashOf(this.current.body.wrapped) : 0;
  }

  // ---- surfaces ----

  /** Surface bodies of the current build (for tests). */
  surfaceBodies(): SurfaceBody[] {
    return this.current.surfaces;
  }

  private surfaceKit: SurfaceKit | null = null;

  /** Surface features (surfaces.ts), with the parts of the builder they use. */
  private get surf(): SurfaceKit {
    const st = (s: SurfState) => s as State;
    return (this.surfaceKit ??= new SurfaceKit({
      fail: (m) => new FeatureError(m),
      missing: (id, what) => this.missing(id, what),
      warn: (m) => { this.warning = m; },
      num: (f, path) => num(f, path),
      sketchRegions: (id, s) => this.sketchRegions(id, st(s)),
      regionFace: (r, fr) => this.regionFace(r, fr),
      resolvePlane: (ref, s) => this.resolvePlane(ref, st(s)),
      resolveAxis: (ref, s) => this.resolveAxis(ref, st(s)),
      resolveFace: (ref, s) => this.resolveFace(ref, st(s)),
      resolveEdge: (ref, s) => this.resolveEdge(ref, st(s)),
      edgesOf: (s) => this.edgesOf(st(s)),
      applyTool: (id, s, tool, faces, isCut, noGain) => this.applyTool(id, st(s), tool, faces, isCut, noGain),
      nameFaces: (id, body, s, tool) => this.nameFaces(id, body, st(s), tool),
    }));
  }
}

/**
 * The writer names the product (and the file) after itself ("Open CASCADE
 * STEP translator 8.0 1"), which other CAD systems then show as the part's
 * name. Only the header and the product entity carry these strings.
 */
function namedStep(data: Uint8Array, name: string): Uint8Array {
  const text = new TextDecoder().decode(data);
  const value = stepString(name);
  const named = text
    .replace(/'Open CASCADE STEP translator [^']*'/g, () => value)
    .replace(/FILE_NAME\('Open CASCADE Shape Model',('[^']*'),\('Author'\)/, (_m, time: string) => `FILE_NAME(${value},${time},('')`);
  return new TextEncoder().encode(named);
}

/** A STEP string literal: quotes and backslashes doubled, other than printable ASCII as \X2\ (UTF-16) hex. */
export function stepString(s: string): string {
  let out = '';
  let wide = '';
  const flush = () => { if (wide) { out += `\\X2\\${wide}\\X0\\`; wide = ''; } };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += c === 0x27 ? "''" : c === 0x5c ? '\\\\' : s[i];
    } else if (c >= 0x20) wide += c.toString(16).toUpperCase().padStart(4, '0');
  }
  flush();
  return `'${out}'`;
}

/**
 * Recently read STEP files by content. Checking an import reads the file,
 * and the build that follows reuses that shape instead of reading it again
 * (seconds for a large file).
 */
const stepCache = new Map<string, Sh>();

async function readStepCached(text: string): Promise<Sh> {
  const key = `${hashString(text)}:${text.length}`;
  let shape = stepCache.get(key);
  if (shape) stepCache.delete(key);
  else shape = await readStep(text);
  stepCache.set(key, shape);
  while (stepCache.size > 3) stepCache.delete(stepCache.keys().next().value!);
  return shape;
}

/** Null when the STEP text reads into geometry, else a readable error. */
export async function checkStep(text: string): Promise<string | null> {
  try {
    await readStepCached(text);
    return null;
  } catch (e) {
    return errorText(e);
  }
}

async function readStep(text: string): Promise<Sh> {
  const oc = getOc();
  const name = `/import-${Date.now()}.step`;
  oc.FS.writeFile(name, text);
  const reader = new oc.STEPControl_Reader();
  const progress = new oc.Message_ProgressRange();
  try {
    if (reader.ReadFile(name) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new FeatureError('The STEP file could not be read');
    reader.TransferRoots(progress);
    const shape = wrap(reader.OneShape());
    if (isEmpty(shape)) throw new FeatureError('The STEP file contains no geometry');
    return shape;
  } finally {
    reader.delete();
    progress.delete();
    try { oc.FS.unlink(name); } catch { /* already removed */ }
  }
}

/** A WebAssembly trap or abort: the OpenCascade module can no longer be used. */
export function isFatal(e: unknown): boolean {
  return typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError;
}

export function errorText(e: unknown): string {
  if (e instanceof FeatureError) return e.message;
  if (e instanceof Error) return e.message || 'The feature could not be built';
  if (typeof e === 'string' && e) return e;
  // OpenCascade exceptions surface as numbers or WebAssembly.Exception objects.
  return 'The geometry kernel could not build this feature';
}

/**
 * Orders path pieces end to end (sketch entities come in drawing order,
 * and a wire is assembled edge by edge, so a piece drawn out of order was
 * silently left out of the path).
 */
function chainPieces<T extends { a?: Vec2; b?: Vec2 }>(pieces: T[]): T[] {
  if (pieces.length < 2) return pieces;
  if (pieces.some((p) => !p.a || !p.b)) throw new FeatureError('A closed path must be a single curve');
  let size = 0;
  for (const p of pieces) size = Math.max(size, Math.abs(p.a![0]), Math.abs(p.a![1]), Math.abs(p.b![0]), Math.abs(p.b![1]));
  const tol = 1e-6 * (1 + size);
  const same = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
  const rest = pieces.slice(1);
  const chain = [pieces[0]];
  let head = pieces[0].a!, tail = pieces[0].b!;
  while (rest.length) {
    const i = rest.findIndex((p) => same(p.a!, tail) || same(p.b!, tail) || same(p.a!, head) || same(p.b!, head));
    if (i < 0) throw new FeatureError('The path must be one connected chain of curves');
    const [p] = rest.splice(i, 1);
    if (same(p.a!, tail)) { chain.push(p); tail = p.b!; }
    else if (same(p.b!, tail)) { chain.push(p); tail = p.a!; }
    else if (same(p.a!, head)) { chain.unshift(p); head = p.b!; }
    else { chain.unshift(p); head = p.a!; }
  }
  return chain;
}

/**
 * Why a shell failed. A wall as thick as a fillet's radius (or any round
 * face's) collapses that face when it is offset, which OpenCascade cannot do.
 */
function shellError(st: State, t: number, opened: number): FeatureError {
  const round = st.faces.some((f) => (f.desc.type === 'cylinder' || f.desc.type === 'sphere') && f.desc.r <= t * (1 + 1e-9));
  // Opening faces that leave walls with nothing between them (all four sides
  // of a box) fails at any thickness, where "a smaller thickness" misled.
  return new FeatureError(round
    ? 'The shell could not be created. Make it thinner than the radius of the fillets and rounded faces.'
    : opened > 1 ? 'The shell could not be created. Try a smaller thickness, or remove fewer faces.' : 'The shell could not be created. Try a smaller thickness.');
}

/**
 * A feature named in a message. Steps are cached by geometry, not by name,
 * so the name is put in when the status is sent: renaming the feature must
 * not leave its old name in a cached message.
 */
const nameOf = (id: Id) => `\u0001${id}\u0002`;
const NAME_REF = /\u0001([^\u0002]*)\u0002/g;

/** Surface types that sameSurface compares exactly. */
const EXACT_SURFACES = new Set(['plane', 'cylinder', 'sphere']);

/** Features whose tool body patterns and mirrors can copy. */
const SEED_TYPES = new Set<Feature['type']>(['extrude', 'revolve', 'hole', 'loft', 'sweep', 'import', 'linearPattern', 'circularPattern', 'mirror']);

const SWEEP_FAILED = 'The sweep could not be created. The profile should start at the path and be roughly perpendicular to it.';

/** True when a generated solid has no volume to speak of. */
function flat(tool: Sh): boolean {
  const b = bbox(tool);
  const size = b ? dist(b.min, b.max) : 0;
  return !(Math.abs(volumeOf(tool)) > size ** 3 * 1e-9);
}

/** True when an operation on a solid left no material (empty, flat or inside-out). */
function degenerate(body: Sh, before: Sh): boolean {
  if (isEmpty(body)) return true;
  // Bodies without volume (imported surfaces) cannot be checked this way.
  const v0 = Math.abs(volumeOf(before));
  return v0 > 0 && !(volumeOf(body) > v0 * 1e-6);
}

/** Rotates a point about an axis through p with unit direction d. */
function rotatePoint(q: Vec3, p: Vec3, d: Vec3, angle: number): Vec3 {
  if (!angle) return q;
  const v = sub(q, p);
  const c = Math.cos(angle), s = Math.sin(angle), k = dot(d, v);
  const x: Vec3 = [d[1] * v[2] - d[2] * v[1], d[2] * v[0] - d[0] * v[2], d[0] * v[1] - d[1] * v[0]];
  return add(p, add(add(scale(v, c), scale(x, s)), scale(d, k * (1 - c))));
}

/** Distance from a point to a profile segment. */
function seg2Dist(p: Vec2, s: Seg2): number {
  if (s.k === 'line') return segDist(p, s.a, s.b);
  if (s.k === 'circle') return Math.abs(Math.hypot(p[0] - s.c[0], p[1] - s.c[1]) - s.r);
  if (s.k === 'arc') {
    // On the arc's sweep: distance to its circle; otherwise to an end.
    const ang = (q: Vec2) => Math.atan2(q[1] - s.c[1], q[0] - s.c[0]);
    const turn = (from: number, to: number) => { let d = (s.ccw ? to - from : from - to) % (2 * Math.PI); if (d < 0) d += 2 * Math.PI; return d; };
    if (turn(ang(s.a), ang(p)) <= turn(ang(s.a), ang(s.b))) return Math.abs(Math.hypot(p[0] - s.c[0], p[1] - s.c[1]) - s.r);
    return Math.min(Math.hypot(p[0] - s.a[0], p[1] - s.a[1]), Math.hypot(p[0] - s.b[0], p[1] - s.b[1]));
  }
  const poly = segPolyline(s);
  let d = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[i + 1]));
  return d;
}

/**
 * Radius of the largest circle inside a loop (and outside its holes): how
 * far the profile can be inset before it vanishes. A grid search refined by
 * pattern search; it can only come out slightly small.
 */
function inradius(outer: Seg2[], holes: Seg2[][]): number {
  const outerPoly = outer.flatMap(segPolyline);
  const holePolys = holes.map((h) => h.flatMap(segPolyline));
  const segs = [...outer, ...holes.flat()];
  const inside = (p: Vec2) => pointInPoly(p, outerPoly) && !holePolys.some((h) => pointInPoly(p, h));
  const room = (p: Vec2) => (inside(p) ? Math.min(...segs.map((s) => seg2Dist(p, s))) : -1);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outerPoly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const n = 32;
  let best: Vec2 = [(x0 + x1) / 2, (y0 + y1) / 2], bestR = room(best);
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const p: Vec2 = [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n];
      const r = room(p);
      if (r > bestR) { best = p; bestR = r; }
    }
  }
  const size = Math.max(x1 - x0, y1 - y0);
  for (let step = size / n; step > size * 1e-9;) {
    let moved = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const p: Vec2 = [best[0] + dx * step, best[1] + dy * step];
      const r = room(p);
      if (r > bestR) { best = p; bestR = r; moved = true; }
    }
    if (!moved) step /= 2;
  }
  return Math.max(0, bestR);
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  let t = l2 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
}

function nearestName(list: { m: Vec3; name: string }[], p: Vec3): string {
  let best = list[0]?.name ?? 'x', bd = Infinity;
  for (const e of list) {
    const d = dist(e.m, p);
    if (d < bd) { bd = d; best = e.name; }
  }
  return best;
}

function cmpVec(a: Vec3, b: Vec3): number {
  for (let i = 0; i < 3; i++) {
    const d = Math.round(a[i] * 1e6) - Math.round(b[i] * 1e6);
    if (d) return d;
  }
  return 0;
}

/** Eigen decomposition of a symmetric 3x3 matrix (Jacobi rotations). */
export function eigenSym3(m: number[]): { moments: Vec3; axes: [Vec3, Vec3, Vec3] } {
  const a = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  const moments = order.map((i) => a[i][i]) as Vec3;
  const axes = order.map((i) => normalize([v[0][i], v[1][i], v[2][i]])) as [Vec3, Vec3, Vec3];
  return { moments, axes };
}

