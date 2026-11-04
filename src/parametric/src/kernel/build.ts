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
  PlaneRef, RevolveFeature, ShellFeature, SketchFeature, SweepFeature,
} from '../model/types';
import { BASE_FRAMES } from '../model/planes';
import { type Region, type Seg2, buildProfiles, segPolyline, sketchPoints } from '../sketch/profiles';
import { SketchIndex, splineBeziers } from '../sketch/geom';
import type {
  BuildRequest, BuildResult, EdgeInfo, FaceInfo, FeatureStatus, MassProperties, MeasureResult, MeasureTarget, MeshData,
  ProjectionRequest, ProjectionResult,
} from './protocol';
import {
  type EdgeDesc, type Sh, type SurfDesc, ShapeIndex, bbox, cut, describeEdge, describeFace, fuse, getOc, gdir,
  hashOf, isEmpty, meshEdgesOf, meshShape, mirrored, planarFaceFrame, pnt, rotated, sameSurface, subShapes, translated,
  vertexPoint, volumeOf, wrap, xyz,
} from './occ';

export { BASE_FRAMES };

export class FeatureError extends Error {}

// Thin (wall) extrudes and revolves are not built yet; failing beats
// silently making a solid where a wall was asked for.
const THIN_UNSUPPORTED = 'Thin features are not supported yet. Sketch the wall as two offset contours instead.';

interface NamedFace {
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
}

interface State {
  body: Sh | null;
  faces: NamedFace[];
  edges: NamedEdge[] | null;
  frames: Map<Id, Frame>;
  sketches: Map<Id, SketchFeature>;
  tools: Map<Id, Tool>;
}

interface Step {
  key: string;
  state: State;
  status: FeatureStatus;
}

const emptyState = (): State => ({ body: null, faces: [], edges: null, frames: new Map(), sketches: new Map(), tools: new Map() });

const cloneState = (s: State): State => ({
  body: s.body,
  faces: s.faces,
  edges: s.edges,
  frames: new Map(s.frames),
  sketches: new Map(s.sketches),
  tools: new Map(s.tools),
});

const num = (p: unknown): number => {
  const v = typeof p === 'number' ? p : Number(p);
  if (!Number.isFinite(v)) throw new FeatureError('A parameter has an invalid value');
  return v;
};

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
  private meshKey = '';
  private meshCache: { mesh: MeshData | null; faces: FaceInfo[]; edges: EdgeInfo[] } | null = null;

  reset() {
    this.steps = [];
    this.meshKey = '';
    this.meshCache = null;
    this.importCache.clear();
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const t0 = performance.now();
    let state = emptyState();
    let chain = 'root';
    const status: FeatureStatus[] = [];
    const upTo = Math.max(0, Math.min(req.upTo, req.features.length));
    for (let i = 0; i < upTo; i++) {
      const f = req.features[i];
      const key = hashString(chain + '\u0000' + JSON.stringify(f));
      const cached = this.steps[i];
      if (cached && cached.key === key) {
        state = cached.state;
        status.push(cached.status);
        chain = key;
        continue;
      }
      this.steps.length = i;
      const next = cloneState(state);
      let st: FeatureStatus = { id: f.id, ok: true };
      if (!f.suppressed) {
        try {
          this.warning = null;
          await this.apply(f, next, req);
          if (this.warning) st = { id: f.id, ok: true, warning: this.warning };
        } catch (e) {
          st = { id: f.id, ok: false, error: errorText(e) };
          // Keep frames of failed sketches/planes out; keep previous geometry.
          next.body = state.body;
          next.faces = state.faces;
          next.edges = state.edges;
        }
      }
      this.steps[i] = { key, state: next, status: st };
      state = next;
      status.push(st);
      chain = key;
    }
    for (let i = upTo; i < req.features.length; i++) status.push({ id: req.features[i].id, ok: true });
    this.current = state;

    const meshKey = chain + ':' + req.quality;
    if (meshKey !== this.meshKey || !this.meshCache) {
      this.meshCache = this.meshState(state, req.quality);
      this.meshKey = meshKey;
    }
    const frames: Record<Id, Frame> = {};
    for (const [k, v] of state.frames) frames[k] = v;
    // Frames of features beyond the rollback bar that were built before stay
    // useful for display; take them from the deepest cached step.
    const last = this.steps[this.steps.length - 1]?.state;
    if (last) for (const [k, v] of last.frames) if (!(k in frames)) frames[k] = v;

    const result: BuildResult = {
      mesh: this.meshCache.mesh,
      faces: this.meshCache.faces,
      edges: this.meshCache.edges,
      status,
      frames,
      bbox: state.body ? bbox(state.body) : null,
      ms: performance.now() - t0,
      preview: null,
    };

    if (req.preview) {
      const p = cloneState(state);
      try {
        const kind = await this.apply(req.preview, p, req);
        if (kind === 'tool') {
          const tool = p.tools.get(req.preview.id);
          if (tool) result.preview = this.meshBody(tool.shape, req.quality);
          result.previewKind = 'tool';
        } else if (kind === 'body' && p.body) {
          result.preview = this.meshBody(p.body, req.quality);
          result.previewKind = 'body';
        }
        if (req.preview.type === 'sketch' || req.preview.type === 'plane') {
          const fr = p.frames.get(req.preview.id);
          if (fr) result.frames[req.preview.id] = fr;
        }
      } catch (e) {
        result.previewError = errorText(e);
      }
    }
    return result;
  }

  // ---- feature dispatch ----

  /** Applies a feature to the state. Returns what a preview should show. */
  private async apply(f: Feature, st: State, req: BuildRequest): Promise<'tool' | 'body' | 'none'> {
    switch (f.type) {
      case 'sketch': {
        st.frames.set(f.id, this.resolvePlane(f.plane, st));
        st.sketches.set(f.id, f);
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
    }
  }

  // ---- references ----

  resolvePlane(ref: PlaneRef | null, st: State): Frame {
    if (!ref) throw new FeatureError('Select a plane or planar face');
    if (ref.kind === 'base') return BASE_FRAMES[ref.plane];
    if (ref.kind === 'feature') {
      const f = st.frames.get(ref.id);
      if (!f) throw new FeatureError('The reference plane is missing or failed to build');
      return f;
    }
    const i = this.resolveFace(ref.face, st);
    const d = st.faces[i].desc;
    if (d.type !== 'plane') throw new FeatureError('The selected face is not planar');
    return planarFaceFrame(d);
  }

  private tol(st: State): number {
    if (!st.body) return 1e-6;
    const b = bbox(st.body);
    return b ? Math.max(1e-7, dist(b.min, b.max) * 1e-7) : 1e-6;
  }

  resolveFace(ref: FaceRef, st: State): number {
    const cands: number[] = [];
    st.faces.forEach((f, i) => { if (f.name === ref.name) cands.push(i); });
    const near = (list: number[]) =>
      list.reduce((best, i) => (best < 0 || dist(st.faces[i].desc.center, ref.sig.c) < dist(st.faces[best].desc.center, ref.sig.c) ? i : best), -1);
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) return near(cands);
    // Fallback: same type and orientation, nearest centre.
    const b = st.body ? bbox(st.body) : null;
    const lim = b ? dist(b.min, b.max) * 0.05 : 1;
    const alt = st.faces
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.desc.type === ref.sig.type && (!ref.sig.n || dot(f.desc.d, ref.sig.n) > 0.999) && dist(f.desc.center, ref.sig.c) < lim);
    if (alt.length) return near(alt.map((a) => a.i));
    throw new FeatureError('A referenced face no longer exists');
  }

  resolveEdge(ref: EdgeRef, st: State): number {
    const edges = this.edgesOf(st);
    const exact = edges.flatMap((e, i) => (e.name === ref.name ? [i] : []));
    const near = (list: number[]) =>
      list.reduce((best, i) => (best < 0 || dist(edges[i].desc.mid, ref.sig.m) < dist(edges[best].desc.mid, ref.sig.m) ? i : best), -1);
    if (exact.length === 1) return exact[0];
    const base = ref.name.replace(/#\d+$/, '');
    const same = edges.flatMap((e, i) => (e.name.replace(/#\d+$/, '') === base ? [i] : []));
    if (same.length) return near(same);
    const b = st.body ? bbox(st.body) : null;
    const lim = b ? dist(b.min, b.max) * 0.02 : 1;
    const alt = edges.flatMap((e, i) => (e.desc.type === ref.sig.type && dist(e.desc.mid, ref.sig.m) < lim ? [i] : []));
    if (alt.length) return near(alt);
    throw new FeatureError('A referenced edge no longer exists');
  }

  /** Point and unit direction of an axis reference. */
  resolveAxis(ref: AxisRef | null, st: State): { p: Vec3; d: Vec3 } {
    if (!ref) throw new FeatureError('Select a direction or axis');
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
        if (!sk || !fr) throw new FeatureError('The axis sketch is missing');
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

  private nameFaces(featId: Id, body: Sh, st: State, tool: NamedFace[], fallback?: (d: SurfDesc, k: number) => string): NamedFace[] {
    const tol = Math.max(this.tol(st), 1e-6);
    const prev = st.faces;
    let k = 0;
    const score = (d: SurfDesc, c: NamedFace) => dist(d.center, c.desc.center) / Math.sqrt(Math.max(c.desc.area, 1e-12));
    return subShapes(body, 'face').map((shape) => {
      const desc = describeFace(shape);
      let best: NamedFace | null = null, bestS = Infinity;
      for (const c of prev) {
        if (!sameSurface(desc, c.desc, tol)) continue;
        const s = score(desc, c);
        if (s < bestS) { bestS = s; best = c; }
      }
      if (!best) {
        for (const c of tool) {
          if (!sameSurface(desc, c.desc, tol)) continue;
          const s = score(desc, c);
          if (s < bestS) { bestS = s; best = c; }
        }
      }
      if (best) return { shape, desc, name: best.name, feature: best.feature };
      const name = fallback ? fallback(desc, k) : `${featId}:n${k}`;
      k++;
      return { shape, desc, name, feature: featId };
    });
  }

  private nameTool(featId: Id, tool: Sh, classify: (d: SurfDesc, k: number) => string): NamedFace[] {
    return subShapes(tool, 'face').map((shape, k) => {
      const desc = describeFace(shape);
      return { shape, desc, name: `${featId}:${classify(desc, k)}`, feature: featId };
    });
  }

  /** Combines a tool with the body and renames faces. */
  private applyTool(featId: Id, st: State, tool: Sh, toolFaces: NamedFace[], isCut: boolean) {
    let body: Sh;
    if (isCut) {
      if (!st.body) throw new FeatureError('There is no material to cut');
      body = cut(st.body, tool);
      if (isEmpty(body)) throw new FeatureError('The cut removes all material');
    } else {
      body = st.body ? fuse(st.body, tool) : tool;
    }
    st.faces = this.nameFaces(featId, body, st, toolFaces);
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
    if (!sketch || !frame) throw new FeatureError('The profile sketch is missing or failed to build');
    const prof = buildProfiles(sketch.entities, picks);
    if (!prof.regions.length) {
      throw new FeatureError(prof.openEnds.length ? 'The sketch has open contours. Close the profile to use it.' : 'The sketch has no closed profile');
    }
    if (prof.openEnds.length && !picks?.length) this.warning = 'Open contours in the sketch were ignored';
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

  private fuseAll(shapes: Sh[]): Sh {
    let acc = shapes[0];
    for (let i = 1; i < shapes.length; i++) acc = fuse(acc, shapes[i]);
    return acc;
  }

  /** Nearest profile segment to a sketch-plane point: used to name side faces. */
  private nearestSrc(regions: Region[], p: Vec2): string {
    let best = Infinity, src = 'x';
    for (const r of regions) {
      for (const loop of [r.outer, ...r.holes]) {
        for (const s of loop.segs) {
          let d: number;
          if (s.k === 'line') d = segDist(p, s.a, s.b);
          else if (s.k === 'arc' || s.k === 'circle') d = Math.abs(Math.hypot(p[0] - s.c[0], p[1] - s.c[1]) - s.r);
          else {
            const poly = segPolyline(s);
            d = Infinity;
            for (let i = 0; i + 1 < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[i + 1]));
          }
          if (d < best) { best = d; src = s.src ?? 'x'; }
        }
      }
    }
    return src;
  }

  // ---- features ----

  private applyPlane(f: PlaneFeature, st: State) {
    const base = this.resolvePlane(f.ref, st);
    const off = num(f.offset) * (f.flip ? -1 : 1);
    st.frames.set(f.id, { ...base, o: add(base.o, scale(base.n, off)) });
  }

  /** Distance from a plane point along dir to just past the far side of the body. */
  private throughAllDepth(st: State, origin: Vec3, dir: Vec3): number {
    const b = st.body ? bbox(st.body) : null;
    if (!b) return 1000;
    let far = 0;
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
      far = Math.max(far, dot(sub(c, origin), dir));
    }
    // A small margin past the body avoids coincident faces in the boolean.
    return far + Math.max(1e-3, dist(b.min, b.max) * 0.01);
  }

  private applyExtrude(f: ExtrudeFeature, st: State) {
    if (f.thin) throw new FeatureError(THIN_UNSUPPORTED);
    const { regions, frame } = this.sketchRegions(f.sketch, st, f.contours);
    const sign = (f.cut ? -1 : 1) * (f.flip ? -1 : 1);
    const dir = scale(frame.n, sign);
    let d1 = f.end === 'throughAll' ? this.throughAllDepth(st, frame.o, dir) : num(f.depth);
    if (d1 <= 0) throw new FeatureError('Depth must be greater than zero');
    let start = 0;
    let total = d1;
    if (f.end === 'midPlane') { start = -d1 / 2; total = d1; }
    else if (f.dir2) {
      const d2 = f.dir2.end === 'throughAll' ? this.throughAllDepth(st, frame.o, scale(dir, -1)) : num(f.dir2.depth);
      if (d2 > 0) { start = -d2; total = d1 + d2; }
    }
    d1 = total;
    const pieces: Sh[] = [];
    for (const r of regions) {
      const face = this.regionFace(r, frame);
      let solid: Sh = R.basicFaceExtrusion(face, new R.Vector(scale(dir, d1))) as unknown as Sh;
      if (start !== 0) solid = translated(solid, scale(dir, start));
      pieces.push(solid);
    }
    let tool = pieces.length === 1 ? pieces[0] : this.fuseAll(pieces);
    const draft = num(f.draft || 0);
    if (draft > 1e-9) tool = this.draftLateral(tool, frame, dir, start, draft * (f.draftOutward ? -1 : 1));
    const classify = (d: SurfDesc) => {
      if (d.type === 'plane' && Math.abs(dot(d.d, frame.n)) > 1 - 1e-6) {
        const s = dot(sub(d.center, frame.o), dir);
        return Math.abs(s - start) < Math.abs(s - (start + d1)) ? 'cap0' : 'cap1';
      }
      return 'side:' + this.nearestSrc(regions, toLocal(frame, d.center));
    };
    this.applyTool(f.id, st, tool, this.nameTool(f.id, tool, classify), f.cut);
  }

  private draftLateral(tool: Sh, fr: Frame, dir: Vec3, start: number, angleDeg: number): Sh {
    const oc = getOc();
    const origin = add(fr.o, scale(dir, start));
    const builder = new oc.BRepOffsetAPI_DraftAngle(tool.wrapped);
    const pln = new oc.gp_Pln(pnt(origin), gdir(dir));
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
      const cl = sketch.entities.find((e) => e.t === 'line' && e.construction);
      if (!cl || cl.t !== 'line') throw new FeatureError('Select an axis of revolution (or add a centerline to the sketch)');
      const a = toWorld(frame, ix.pt(cl.a)), b = toWorld(frame, ix.pt(cl.b));
      axis = { p: a, d: normalize(sub(b, a)) };
    }
    let angle = num(f.angle);
    if (angle <= 0) throw new FeatureError('Angle must be greater than zero');
    angle = Math.min(angle, 360);
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
      const face = this.regionFace(r, frame);
      let solid = R.revolution(face, axis.p, d, angle) as unknown as Sh;
      if (f.end === 'midPlane' && angle < 360) solid = rotated(solid, axis.p, d, (-angle * Math.PI) / 360);
      pieces.push(solid);
    }
    const tool = pieces.length === 1 ? pieces[0] : this.fuseAll(pieces);
    const s0 = regions[0].sample;
    const side = Math.sign((s0[0] - a2[0]) * perp[0] + (s0[1] - a2[1]) * perp[1]) || 1;
    const classify = (desc: SurfDesc) => {
      if (desc.type === 'plane' && Math.abs(dot(desc.d, axis.d)) < 1e-6) {
        return Math.abs(dot(sub(desc.center, frame.o), frame.n)) < 1e-6 * (1 + len(desc.center)) ? 'cap0' : 'cap1';
      }
      const v = sub(desc.center, axis.p);
      const axial = dot(v, axis.d);
      const rho = len(sub(v, scale(axis.d, axial)));
      const p: Vec2 = [a2[0] + d2[0] * axial + perp[0] * rho * side, a2[1] + d2[1] * axial + perp[1] * rho * side];
      return 'side:' + this.nearestSrc(regions, p);
    };
    this.applyTool(f.id, st, tool, this.nameTool(f.id, tool, classify), f.cut);
  }

  /** Edges selected directly plus every edge of the selected faces. */
  private collectEdges(st: State, edges: EdgeRef[], faces: FaceRef[]): number[] {
    const all = this.edgesOf(st);
    const set = new Set<number>();
    for (const e of edges) set.add(this.resolveEdge(e, st));
    for (const fr of faces) {
      const fi = this.resolveFace(fr, st);
      all.forEach((e, i) => { if (e.faces.includes(fi)) set.add(i); });
    }
    if (!set.size) throw new FeatureError('Select edges or faces');
    return [...set];
  }

  private applyFillet(f: FilletFeature, st: State) {
    if (!st.body) throw new FeatureError('There is no body to fillet');
    const r = num(f.radius);
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
    const d1 = num(f.distance);
    if (d1 <= 0) throw new FeatureError('Distance must be greater than zero');
    const ids = this.collectEdges(st, f.edges, f.faces);
    const all = this.edgesOf(st);
    const oc = getOc();
    const builder = new oc.BRepFilletAPI_MakeChamfer(st.body.wrapped);
    let body: Sh;
    try {
      for (const i of ids) {
        const e = all[i];
        if (f.mode === 'distance') builder.Add(d1, e.shape.wrapped);
        else {
          const fi = e.faces[f.flip ? 1 : 0] ?? e.faces[0];
          const face = st.faces[fi].shape.wrapped;
          if (f.mode === 'twoDistance') builder.Add(d1, num(f.distance2), e.shape.wrapped, face);
          else builder.AddDA(d1, (num(f.angle) * Math.PI) / 180, e.shape.wrapped, face);
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
    const t = num(f.thickness);
    if (t <= 0) throw new FeatureError('Thickness must be greater than zero');
    const oc = getOc();
    const list = new oc.NCollection_List_TopoDS_Shape();
    const removed = f.faces.map((r) => this.resolveFace(r, st));
    for (const i of removed) list.Append(st.faces[i].shape.wrapped);
    const builder = new oc.BRepOffsetAPI_MakeThickSolid();
    let body: Sh;
    try {
      builder.MakeThickSolidByJoin(st.body.wrapped, list, f.outward ? t : -t, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
      builder.Build();
      body = wrap(builder.Shape());
    } catch {
      throw new FeatureError('The shell could not be created. Try a smaller thickness.');
    } finally {
      builder.delete();
      list.delete();
    }
    // A thickness too large for the part can come back as a degenerate or
    // unchanged solid instead of an error. An inward shell always removes
    // material (an outward one is only the new walls, so any size goes).
    const v0 = volumeOf(st.body);
    if (degenerate(body, st.body) || (!f.outward && v0 > 0 && volumeOf(body) >= v0 * (1 - 1e-6))) throw new FeatureError('The shell could not be created. Try a smaller thickness.');
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

  private applyHole(f: HoleFeature, st: State) {
    const sketch = st.sketches.get(f.sketch);
    const frame = st.frames.get(f.sketch);
    if (!sketch || !frame) throw new FeatureError('The hole position sketch is missing');
    const pts = sketchPoints(sketch.entities);
    if (!pts.length) throw new FeatureError('Add sketch points to place holes');
    const r = num(f.diameter) / 2;
    if (r <= 0) throw new FeatureError('Diameter must be greater than zero');
    const depth = f.end === 'throughAll' ? this.throughAllDepth(st, frame.o, scale(frame.n, f.flip ? 1 : -1)) : num(f.depth);
    if (depth <= 0) throw new FeatureError('Depth must be greater than zero');
    // Profile in (radius, depth) coordinates, revolved around the hole axis.
    const prof: [number, number][] = [];
    if (f.kind === 'counterbore') {
      const cr = num(f.cbDiameter) / 2, cd = num(f.cbDepth);
      if (cr <= r || cd <= 0) throw new FeatureError('Counterbore must be larger than the hole');
      prof.push([0, 0], [cr, 0], [cr, cd], [r, cd], [r, depth], [0, depth]);
    } else if (f.kind === 'countersink') {
      const sr = num(f.csDiameter) / 2;
      const half = (num(f.csAngle) * Math.PI) / 360;
      if (sr <= r || half <= 0 || half >= Math.PI / 2) throw new FeatureError('Countersink must be larger than the hole');
      const sd = (sr - r) / Math.tan(half);
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
    const tool = tools.length === 1 ? tools[0] : (R.makeCompound(tools as any) as unknown as Sh);
    this.applyTool(f.id, st, tool, named, true);
  }

  private seedTools(seeds: Id[], st: State): Tool[] {
    if (!seeds.length) throw new FeatureError('Select features to pattern');
    return seeds.map((id) => {
      const t = st.tools.get(id);
      if (!t) throw new FeatureError('A seed feature cannot be patterned (only extrudes, revolves, holes, lofts, sweeps and patterns)');
      return t;
    });
  }

  /** Applies transformed copies of seed tools (in seed order). */
  private applyInstances(featId: Id, st: State, seeds: Tool[], transforms: ((s: Sh) => Sh)[]) {
    if (!transforms.length) throw new FeatureError('The pattern has no instances');
    const allTool: Sh[] = [];
    const allNamed: NamedFace[] = [];
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
      const tool = inst.length === 1 ? inst[0] : (R.makeCompound(inst as any) as unknown as Sh);
      if (seed.cut) {
        if (!body) throw new FeatureError('There is no material to cut');
        body = cut(body, tool);
      } else body = body ? fuse(body, tool) : tool;
      allTool.push(tool);
      allNamed.push(...named);
    }
    if (!body || isEmpty(body)) throw new FeatureError('The pattern removed all material');
    st.faces = this.nameFaces(featId, body, st, allNamed);
    st.body = body;
    st.edges = null;
    const tool = allTool.length === 1 ? allTool[0] : (R.makeCompound(allTool as any) as unknown as Sh);
    st.tools.set(featId, { shape: tool, cut: seeds.every((s) => s.cut), faces: allNamed });
  }

  private dirVector(d: PatternDir, st: State): Vec3 {
    const ax = this.resolveAxis(d.ref, st);
    return scale(ax.d, d.flip ? -1 : 1);
  }

  private applyLinearPattern(f: LinearPatternFeature, st: State) {
    const seeds = this.seedTools(f.seeds, st);
    const n1 = Math.round(num(f.dir1.count));
    if (n1 < 1 || n1 > 1000) throw new FeatureError('Instance count must be between 1 and 1000');
    const v1 = scale(this.dirVector(f.dir1, st), num(f.dir1.spacing));
    let n2 = 1;
    let v2: Vec3 = [0, 0, 0];
    if (f.dir2) {
      n2 = Math.round(num(f.dir2.count));
      if (n2 < 1 || n2 > 1000) throw new FeatureError('Instance count must be between 1 and 1000');
      v2 = scale(this.dirVector(f.dir2, st), num(f.dir2.spacing));
    }
    if (n1 * n2 > 2000) throw new FeatureError('Too many instances (maximum 2000)');
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
    const seeds = this.seedTools(f.seeds, st);
    const ax = this.resolveAxis(f.axis, st);
    const n = Math.round(num(f.count));
    if (n < 2 || n > 1000) throw new FeatureError('Instance count must be between 2 and 1000');
    const total = num(f.angle);
    const step = f.equal ? (Math.abs(total - 360) < 1e-9 ? total / n : total / (n - 1)) : total;
    const d = scale(ax.d, f.flip ? -1 : 1);
    const tfs: ((s: Sh) => Sh)[] = [];
    for (let i = 1; i < n; i++) {
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
      this.applyTool(f.id, st, m, tf, false);
      return;
    }
    this.applyInstances(f.id, st, this.seedTools(f.seeds, st), [(s) => mirrored(s, fr.o, fr.n)]);
  }

  private profileWire(sketchId: Id, st: State): { wire: any; frame: Frame } {
    const { regions, frame } = this.sketchRegions(sketchId, st);
    return { wire: this.loopWire(regions[0].outer.segs, frame), frame };
  }

  private applyLoft(f: LoftFeature, st: State) {
    if (f.profiles.length < 2) throw new FeatureError('Select at least two profiles');
    const wires = f.profiles.map((id) => this.profileWire(id, st).wire);
    let tool: Sh;
    try {
      tool = R.loft(wires, { ruled: f.ruled }) as unknown as Sh;
    } catch {
      throw new FeatureError('The loft could not be created from these profiles');
    }
    this.applyTool(f.id, st, tool, this.nameTool(f.id, tool, (_d, k) => `l${k}`), f.cut);
  }

  private applySweep(f: SweepFeature, st: State) {
    if (!f.profile || !f.path) throw new FeatureError('Select a profile and a path');
    const { wire } = this.profileWire(f.profile, st);
    const pathSk = st.sketches.get(f.path);
    const pathFr = st.frames.get(f.path);
    if (!pathSk || !pathFr) throw new FeatureError('The path sketch is missing');
    const ix = new SketchIndex(pathSk.entities);
    const edges: any[] = [];
    for (const e of pathSk.entities) {
      if (e.construction) continue;
      const w = (id: string) => toWorld(pathFr, ix.pt(id));
      if (e.t === 'line') edges.push(R.makeLine(w(e.a), w(e.b)));
      else if (e.t === 'arc') {
        const c = ix.pt(e.c), a = ix.pt(e.a), b = ix.pt(e.b);
        const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
        const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
        let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
        if (a1 <= a0) a1 += 2 * Math.PI;
        const am = (a0 + a1) / 2;
        edges.push(R.makeThreePointArc(w(e.a), toWorld(pathFr, [c[0] + r * Math.cos(am), c[1] + r * Math.sin(am)]), w(e.b)));
      } else if (e.t === 'spline') {
        for (const bz of splineBeziers(e.pts.map((p) => ix.pt(p)))) edges.push(R.makeBezierCurve(bz.map((p) => toWorld(pathFr, p))));
      } else if (e.t === 'circle') edges.push(R.makeCircle(e.r, toWorld(pathFr, ix.pt(e.c)), pathFr.n));
    }
    if (!edges.length) throw new FeatureError('The path sketch is empty');
    let tool: Sh;
    try {
      const spine = R.assembleWire(edges);
      tool = R.genericSweep(wire, spine, { frenet: true }) as unknown as Sh;
    } catch {
      throw new FeatureError('The sweep could not be created. The profile should start at the path and be roughly perpendicular to it.');
    }
    this.applyTool(f.id, st, tool, this.nameTool(f.id, tool, (_d, k) => `s${k}`), f.cut);
  }

  private applyDraft(f: DraftFeature, st: State) {
    if (!st.body) throw new FeatureError('There is no body to draft');
    if (!f.faces.length) throw new FeatureError('Select faces to draft');
    const fr = this.resolvePlane(f.neutral, st);
    const oc = getOc();
    const dir = scale(fr.n, f.flip ? -1 : 1);
    const builder = new oc.BRepOffsetAPI_DraftAngle(st.body.wrapped);
    const pln = new oc.gp_Pln(pnt(fr.o), gdir(dir));
    const gd = gdir(dir);
    let body: Sh;
    try {
      for (const r of f.faces) {
        builder.Add(st.faces[this.resolveFace(r, st)].shape.wrapped, gd, (num(f.angle) * Math.PI) / 180, pln, true);
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
    st.faces = this.nameFaces(f.id, body, st, [], (_d, k) => `${f.id}:d${k}`);
    st.body = body;
    st.edges = null;
  }

  private importCache = new Map<Id, Sh>();

  private async applyImport(f: ImportFeature, st: State, req: BuildRequest) {
    let shape = this.importCache.get(f.blob);
    if (!shape) {
      const text = req.blobs[f.blob];
      if (!text) throw new FeatureError('The imported file data is missing');
      shape = f.format === 'brep' ? (R.deserializeShape(text) as unknown as Sh) : await readStep(text);
      this.importCache.set(f.blob, shape);
    }
    const named = this.nameTool(f.id, shape, (_d, k) => `i${k}`);
    this.applyTool(f.id, st, shape, named, false);
  }

  // ---- output ----

  private meshParams(shape: Sh, quality: number): { tol: number; ang: number } {
    const b = bbox(shape);
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
    const body = this.current.body;
    return views.map((v) => {
      if (!body) return { id: v.id, visible: [], hidden: [], bounds: null };
      const cam = new R.ProjectionCamera([0, 0, 0], v.dir, v.x);
      try {
        const { visible, hidden } = R.drawProjection(body as unknown as R.AnyShape, cam);
        const flat = (p: string[] | string[][]) => (p as (string | string[])[]).flat();
        let bounds: ProjectionResult['bounds'] = null;
        try {
          const b = visible.boundingBox.bounds;
          // Drawing y is up; SVG paths are emitted with y down.
          bounds = [b[0][0], -b[1][1], b[1][0], -b[0][1]];
        } catch {
          bounds = null;
        }
        return { id: v.id, visible: flat(visible.toSVGPaths()), hidden: flat(hidden.toSVGPaths()), bounds };
      } finally {
        cam.delete();
      }
    });
  }

  // ---- evaluation ----

  massProperties(): MassProperties | null {
    const body = this.current.body;
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
        const ax = new oc.gp_Ax1(pnt(center), gdir(d));
        const v = props.MomentOfInertia(ax);
        ax.delete();
        return v;
      };
      const ixx = moment([1, 0, 0]), iyy = moment([0, 1, 0]), izz = moment([0, 0, 1]);
      const s = Math.SQRT1_2;
      const ixy = moment([s, s, 0]) - (ixx + iyy) / 2;
      const iyz = moment([0, s, s]) - (iyy + izz) / 2;
      const ixz = moment([s, 0, s]) - (ixx + izz) / 2;
      const inertia = [ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz];
      return { volume: props.Mass(), area: sprops.Mass(), center, inertia, principal: eigenSym3(inertia) };
    } finally {
      props.delete();
      sprops.delete();
    }
  }

  measure(a: MeasureTarget, b: MeasureTarget): MeasureResult {
    const oc = getOc();
    const shapeOf = (t: MeasureTarget): Sh => {
      if (t.kind === 'vertex') {
        const mv = new oc.BRepBuilderAPI_MakeVertex(pnt(t.p));
        const v = wrap(mv.Vertex());
        mv.delete();
        return v;
      }
      if (t.kind === 'face') {
        const f = this.current.faces[t.index];
        if (!f) throw new FeatureError('Face not found');
        return f.shape;
      }
      const e = this.edgesOf(this.current)[t.index];
      if (!e) throw new FeatureError('Edge not found');
      return e.shape;
    };
    const s1 = shapeOf(a), s2 = shapeOf(b);
    const ext = new oc.BRepExtrema_DistShapeShape(s1.wrapped, s2.wrapped, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange());
    try {
      if (!ext.IsDone() || ext.NbSolution() < 1) throw new FeatureError('Distance could not be computed');
      const p1 = ext.PointOnShape1(1), p2 = ext.PointOnShape2(1);
      const out = { distance: ext.Value(), p1: xyz(p1), p2: xyz(p2) };
      p1.delete(); p2.delete();
      return out;
    } finally {
      ext.delete();
    }
  }

  exportStep(): Uint8Array {
    const body = this.current.body;
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
      return data;
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

export function errorText(e: unknown): string {
  if (e instanceof FeatureError) return e.message;
  if (e instanceof Error) return e.message || 'The feature could not be built';
  if (typeof e === 'string' && e) return e;
  // OpenCascade exceptions surface as numbers or WebAssembly.Exception objects.
  return 'The geometry kernel could not build this feature';
}

/** True when an operation on a solid left no material (empty, flat or inside-out). */
function degenerate(body: Sh, before: Sh): boolean {
  if (isEmpty(body)) return true;
  // Bodies without volume (imported surfaces) cannot be checked this way.
  const v0 = Math.abs(volumeOf(before));
  return v0 > 0 && !(volumeOf(body) > v0 * 1e-6);
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

