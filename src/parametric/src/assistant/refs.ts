// Names the model uses for things in the part, and the document references
// they stand for. Features are named by id or display name; faces and edges by
// their topological names from the last rebuild (find_geometry lists them);
// planes and axes by short specs:
//   plane: "front" | "top" | "right" | a reference plane feature | a planar face name
//   axis:  "x" | "y" | "z" | an edge name | a face name | { sketch, line }

import type { EdgeInfo, FaceInfo } from '../kernel/protocol';
import type { Frame } from '../math/vec';
import { BASE_FRAMES } from '../model/planes';
import type { AxisRef, BasePlane, EdgeRef, FaceRef, Feature, Id, PlaneRef, SketchFeature } from '../model/types';
import { edgeRef, faceRef } from '../app/selection';
import type { AssistantHost } from './host';
import { ToolError } from './units';

const BASE_ALIASES: Record<string, BasePlane> = {
  front: 'front', 'front plane': 'front', xy: 'front',
  top: 'top', 'top plane': 'top', xz: 'top', zx: 'top',
  right: 'right', 'right plane': 'right', yz: 'right', zy: 'right',
};

const AXIS_ALIASES: Record<string, 'x' | 'y' | 'z'> = { x: 'x', 'x axis': 'x', 'x-axis': 'x', y: 'y', 'y axis': 'y', 'y-axis': 'y', z: 'z', 'z axis': 'z', 'z-axis': 'z' };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Up to n names closest to a wanted one (shared prefix, then edit distance). */
function similar(want: string, names: string[], n = 6): string[] {
  const w = want.toLowerCase();
  const score = (s: string) => {
    const t = s.toLowerCase();
    if (t.includes(w) || w.includes(t)) return 0;
    let p = 0;
    while (p < t.length && p < w.length && t[p] === w[p]) p++;
    return 100 - p;
  };
  return [...new Set(names)].sort((a, b) => score(a) - score(b)).slice(0, n);
}

export class Refs {
  constructor(private host: AssistantHost) {}

  private get features(): Feature[] {
    return this.host.store.doc.features;
  }

  /** A feature by id or display name (case-insensitive). */
  feature(v: unknown, what = 'feature'): Feature {
    const s = str(v);
    if (!s) throw new ToolError(`${what}: give a feature id or name`);
    const f = this.features.find((x) => x.id === s) ?? this.features.find((x) => x.name.toLowerCase() === s.toLowerCase());
    if (!f) {
      const list = this.features.map((x) => `${x.id} (${x.name})`);
      throw new ToolError(`${what}: no feature "${s}". Features: ${list.length ? list.join(', ') : 'none yet'}`);
    }
    return f;
  }

  /**
   * A display name to give a feature (self, when renaming one). A name another
   * feature or a base plane answers to is refused: references by name would
   * find that one instead.
   */
  newName(v: unknown, self?: Feature, what = 'name'): string {
    const s = str(v), low = s.toLowerCase();
    if (self && (low === self.name.toLowerCase() || low === self.id.toLowerCase())) return s;
    if (BASE_ALIASES[low]) throw new ToolError(`${what}: "${s}" names the base plane ${BASE_ALIASES[low]}, so plane arguments would mean that plane. Choose another name.`);
    const id = this.features.find((x) => x.id.toLowerCase() === low);
    if (id) throw new ToolError(`${what}: "${s}" is the id of ${id.id} (${id.name}). Choose another name.`);
    const named = this.features.find((x) => x !== self && x.name.toLowerCase() === low);
    if (named) throw new ToolError(`${what}: "${s}" is already the name of ${named.id}. Choose another name.`);
    return s;
  }

  sketch(v: unknown, what = 'sketch'): SketchFeature {
    const f = this.feature(v, what);
    if (f.type !== 'sketch') throw new ToolError(`${what}: ${f.id} (${f.name}) is a ${f.type}, not a sketch`);
    return f;
  }

  features_(v: unknown, what: string): Feature[] {
    const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
    return list.map((x, i) => this.feature(x, `${what}[${i}]`));
  }

  faceInfo(v: unknown, what = 'face'): FaceInfo {
    const s = str(v);
    const faces = this.host.faces;
    const f = faces.find((x) => x.name === s);
    if (f) return f;
    if (!faces.length) throw new ToolError(`${what}: the part has no faces yet`);
    throw new ToolError(`${what}: no face named "${s}" in the current model. Similar names: ${similar(s, faces.map((x) => x.name)).join(', ')}. Use find_geometry to list faces.`);
  }

  edgeInfo(v: unknown, what = 'edge'): EdgeInfo {
    const s = str(v);
    const edges = this.host.edges;
    const e = edges.find((x) => x.name === s);
    if (e) return e;
    if (!edges.length) throw new ToolError(`${what}: the part has no edges yet`);
    throw new ToolError(`${what}: no edge named "${s}" in the current model. Similar names: ${similar(s, edges.map((x) => x.name)).join(', ')}. Use find_geometry to list edges.`);
  }

  // A name a feature already stores keeps its reference: what it names may be gone
  // from the final body (a fillet's own edges), and the model gives back what get_model said.
  faceRefs(v: unknown, what: string, stored: FaceRef[] = []): FaceRef[] {
    const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
    return list.map((x, i) => stored.find((r) => r.name === str(x)) ?? faceRef(this.faceInfo(x, `${what}[${i}]`)));
  }

  edgeRefs(v: unknown, what: string, stored: EdgeRef[] = []): EdgeRef[] {
    const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
    return list.map((x, i) => stored.find((r) => r.name === str(x)) ?? edgeRef(this.edgeInfo(x, `${what}[${i}]`)));
  }

  plane(v: unknown, what = 'plane', stored: PlaneRef | null = null): PlaneRef {
    const s = str(v);
    if (!s) throw new ToolError(`${what}: give "front", "top", "right", a reference plane feature or a planar face name`);
    if (stored?.kind === 'face' && stored.face.name === s) return stored;
    const base = BASE_ALIASES[s.toLowerCase()];
    if (base) return { kind: 'base', plane: base };
    const feat = this.features.find((x) => x.id === s) ?? this.features.find((x) => x.name.toLowerCase() === s.toLowerCase());
    if (feat) {
      if (feat.type !== 'plane') throw new ToolError(`${what}: ${feat.id} (${feat.name}) is a ${feat.type}; only reference planes (add_plane), base planes and planar faces can be used`);
      return { kind: 'feature', id: feat.id };
    }
    const face = this.host.faces.find((x) => x.name === s);
    if (face) {
      if (face.type !== 'plane') throw new ToolError(`${what}: face ${s} is ${face.type}, not planar`);
      return { kind: 'face', face: faceRef(face) };
    }
    throw new ToolError(`${what}: "${s}" is not a base plane (front, top, right), a reference plane or a face of the current model`);
  }

  axis(v: unknown, what = 'axis', stored: AxisRef | null = null): AxisRef {
    if ((stored?.kind === 'edge' || stored?.kind === 'face') && axisSpec(stored) === str(v)) return stored;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (o.sketch != null && o.line != null) {
        const sk = this.sketch(o.sketch, `${what}.sketch`);
        const id = str(o.line);
        const e = sk.entities.find((x) => x.id === id);
        if (!e || e.t !== 'line') throw new ToolError(`${what}.line: ${sk.id} has no line "${id}"`);
        return { kind: 'sketchLine', sketch: sk.id, entity: id };
      }
      if (o.edge != null) return this.axis(o.edge, what, stored);
      if (o.face != null) return this.axis(o.face, what, stored);
      if (o.base != null) return this.axis(o.base, what);
    }
    const s = str(v);
    if (!s) throw new ToolError(`${what}: give "x", "y", "z", an edge name, a face name or { "sketch": id, "line": id }`);
    const ax = AXIS_ALIASES[s.toLowerCase()];
    if (ax) return { kind: 'base', axis: ax };
    const edge = this.host.edges.find((x) => x.name === s);
    if (edge) {
      if (edge.type !== 'line' && edge.type !== 'circle') throw new ToolError(`${what}: edge ${s} is ${edge.type}; use a straight or circular edge`);
      return { kind: 'edge', edge: edgeRef(edge) };
    }
    const face = this.host.faces.find((x) => x.name === s);
    if (face) {
      if (!['plane', 'cylinder', 'sphere'].includes(face.type)) throw new ToolError(`${what}: face ${s} is ${face.type}; use a planar or cylindrical face`);
      return { kind: 'face', face: faceRef(face) };
    }
    throw new ToolError(`${what}: "${s}" is not x, y, z or an edge or face of the current model`);
  }

  /** The frame a plane reference resolves to now. */
  planeFrame(ref: PlaneRef): Frame | null {
    if (ref.kind === 'base') return BASE_FRAMES[ref.plane];
    if (ref.kind === 'feature') return this.host.frames[ref.id] ?? null;
    return this.host.faces.find((x) => x.name === ref.face.name)?.frame ?? null;
  }

  sketchFrame(sk: SketchFeature): Frame | null {
    return this.host.frames[sk.id] ?? (sk.plane.kind === 'base' ? BASE_FRAMES[sk.plane.plane] : sk.frame ?? null);
  }
}

// ---- references back to the names the model uses ----

export function planeSpec(ref: PlaneRef | null): string | null {
  if (!ref) return null;
  if (ref.kind === 'base') return ref.plane;
  if (ref.kind === 'feature') return ref.id;
  return ref.face.name;
}

export function axisSpec(ref: AxisRef | null): string | { sketch: Id; line: Id } | null {
  if (!ref) return null;
  switch (ref.kind) {
    case 'base': return ref.axis;
    case 'edge': return ref.edge.name;
    case 'face': return ref.face.name;
    case 'sketchLine': return { sketch: ref.sketch, line: ref.entity };
  }
}
