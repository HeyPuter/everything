// Text descriptions of the part for the model: feature list with status,
// variables, body summary, faces and edges, selection and mode. Compact and
// exact: every name and id the tools accept appears as written.

import type { EdgeInfo, FaceInfo } from '../kernel/protocol';
import { type Vec3, dist, dot, normalize } from '../math/vec';
import { evaluateVariables } from '../model/expr';
import { consumedSketches } from '../model/features';
import { BASE_PLANE_NAMES } from '../model/planes';
import type { Feature, Id, SketchFeature } from '../model/types';
import { UNIT_SYSTEMS } from '../model/units';
import type { SelItem } from '../app/selection';
import { FeatureCodec } from './features';
import type { AssistantHost } from './host';
import { Refs, planeSpec } from './refs';
import { type Units, num } from './units';

export class Inspector {
  readonly refs: Refs;
  readonly codec: FeatureCodec;

  constructor(readonly host: AssistantHost, readonly u: Units) {
    this.refs = new Refs(host);
    this.codec = new FeatureCodec(u, this.refs);
  }

  private get doc() {
    return this.host.store.doc;
  }

  /** Errors of built features (id → message). */
  errors(): Map<Id, string> {
    const out = new Map<Id, string>();
    const n = this.host.store.builtCount;
    this.doc.features.slice(0, n).forEach((f) => {
      if (f.suppressed) return;
      const s = this.host.featureStatus(f.id);
      if (s && !s.ok) out.set(f.id, s.error ?? 'failed');
    });
    return out;
  }

  status(f: Feature, index: number): string {
    if (f.suppressed) return 'suppressed';
    if (index >= this.host.store.builtCount) return 'rolled back (not built)';
    const s = this.host.featureStatus(f.id);
    if (!s) return 'not built yet';
    if (s.suppressed) return 'suppressed (it depends on a suppressed feature)';
    if (!s.ok) return `ERROR: ${s.error}`;
    return s.warning ? `ok, warning: ${s.warning}` : 'ok';
  }

  /** One line per feature: id, name, type, arguments and status. */
  featureLine(f: Feature, index: number): string {
    let what: string;
    if (f.type === 'sketch') {
      const users = this.doc.features.filter((x) => consumedSketches(x).includes(f.id)).map((x) => x.id);
      what = `sketch on ${this.planeName(planeSpec(f.plane))}, ${f.entities.length} entities, ${f.constraints.length} constraints${users.length ? `, used by ${users.join(', ')}` : ', unused'}`;
    } else {
      const args = this.codec.args(f);
      what = `${f.type} ${JSON.stringify(args, (_k, v) => (v === undefined || v === null || v === false || (Array.isArray(v) && !v.length) ? undefined : v))}`;
      if (what.length > 400) what = `${what.slice(0, 397)}…`;
    }
    return `${f.id} "${f.name}" ${what}${f.hidden ? ' [hidden]' : ''} → ${this.status(f, index)}`;
  }

  planeName(spec: string | null): string {
    if (!spec) return 'no plane';
    if (spec in BASE_PLANE_NAMES) return `${BASE_PLANE_NAMES[spec as keyof typeof BASE_PLANE_NAMES]} (${spec})`;
    const f = this.doc.features.find((x) => x.id === spec);
    return f ? `${f.name} (${f.id})` : `face ${spec}`;
  }

  variablesText(): string {
    const vars = this.doc.variables;
    if (!vars.length) return 'Global variables: none.';
    const { values, errors } = evaluateVariables(vars);
    return `Global variables (values in display units):\n${vars.map((v) => `- ${v.name} = ${v.expr}${errors.has(v.name) ? `  ERROR: ${errors.get(v.name)}` : values.has(v.name) && String(values.get(v.name)) !== v.expr ? `  (= ${num(values.get(v.name)!)})` : ''}`).join('\n')}`;
  }

  bodyText(): string {
    const b = this.host.bbox;
    if (!b) return 'Body: none yet (nothing solid has been built).';
    const u = this.u;
    const size = [0, 1, 2].map((i) => u.len(b.max[i] - b.min[i]));
    return `Body: ${this.host.faces.length} faces, ${this.host.edges.length} edges; bounding box X ${u.len(b.min[0])}…${u.len(b.max[0])}, Y ${u.len(b.min[1])}…${u.len(b.max[1])}, Z ${u.len(b.min[2])}…${u.len(b.max[2])} (size ${size.join(' × ')} ${u.unit}).`;
  }

  partHeader(): string {
    const d = this.doc;
    const us = UNIT_SYSTEMS[d.units];
    return `Part "${d.name}". Units ${d.units}: lengths in ${us.length}, angles in degrees, mass in ${us.mass}. Material: ${d.material ? `${d.material.name} (${d.material.density} kg/m³)` : 'not set'}. Colour ${d.color}.`;
  }

  featuresText(max = 80): string {
    const fs = this.doc.features;
    if (!fs.length) return 'Features: none (empty part).';
    const lines = fs.map((f, i) => this.featureLine(f, i));
    const r = this.doc.rollback;
    if (r != null && r < fs.length) lines.splice(r, 0, '--- rollback bar: features below are not built ---');
    const shown = lines.length > max ? [...lines.slice(0, 10), `… ${lines.length - max} more (use get_model with feature ids) …`, ...lines.slice(lines.length - (max - 10))] : lines;
    return `Features in build order:\n${shown.map((l) => `- ${l}`).join('\n')}`;
  }

  faceLine(f: FaceInfo): string {
    const u = this.u;
    const parts = [f.name, f.type, `centre ${u.pt(f.center)}`];
    if (f.normal) parts.push(`normal ${u.dir(f.normal)}`);
    if (f.radius != null) parts.push(`radius ${u.len(f.radius)}`);
    if (f.axis) parts.push(`axis ${u.dir(normalize(f.axis.d))} through ${u.pt(f.axis.p)}`);
    parts.push(`area ${u.area(f.area)}`, `from ${f.feature}`);
    return parts.join(' | ');
  }

  edgeLine(e: EdgeInfo): string {
    const u = this.u;
    const parts = [e.name, e.type];
    if (e.type === 'circle' && e.center) {
      const closed = dist(e.a, e.b) < 1e-7;
      parts.push(`${closed ? 'full circle' : 'arc'} centre ${u.pt(e.center)} radius ${u.len(e.radius ?? 0)}${e.axis ? ` axis ${u.dir(normalize(e.axis))}` : ''}`);
      if (!closed) parts.push(`from ${u.pt(e.a)} to ${u.pt(e.b)}`);
    } else {
      parts.push(`from ${u.pt(e.a)} to ${u.pt(e.b)}`);
      if (e.dir) parts.push(`direction ${u.dir(e.dir)}`);
    }
    parts.push(`length ${u.len(e.length)}`);
    return parts.join(' | ');
  }

  /** Faces of a feature (named after it), for reports after adding one. */
  facesOf(id: Id, max = 40): string {
    const faces = this.host.faces.filter((f) => f.feature === id);
    if (!faces.length) return '';
    return `Faces of ${id} (${faces.length}):\n${faces.slice(0, max).map((f) => `- ${this.faceLine(f)}`).join('\n')}${faces.length > max ? `\n- … ${faces.length - max} more (find_geometry)` : ''}`;
  }

  selectionText(items: SelItem[]): string {
    if (!items.length) return 'Selection: nothing.';
    const u = this.u;
    const out = items.slice(0, 30).map((it) => {
      switch (it.kind) {
        case 'face': { const f = this.host.faces[it.index]; return f ? `face ${this.faceLine(f)}` : `face ${it.name}`; }
        case 'edge': { const e = this.host.edges[it.index]; return e ? `edge ${this.edgeLine(e)}` : `edge ${it.name}`; }
        case 'vertex': return `vertex at ${u.pt(it.p)}`;
        case 'plane': return `plane ${it.ref.kind === 'base' ? it.ref.plane : it.ref.id}`;
        case 'origin': return 'the origin';
        case 'axis': return `${it.axis} axis`;
        case 'feature': { const f = this.doc.features.find((x) => x.id === it.id); return `feature ${it.id}${f ? ` "${f.name}" (${f.type})` : ''}`; }
        case 'sk': return `sketch entity ${it.id}`;
        case 'skdim': return `sketch dimension ${it.id}`;
        case 'skrel': return `sketch relation ${it.id}`;
      }
    });
    return `Selection (${items.length}):\n${out.map((l) => `- ${l}`).join('\n')}`;
  }

  /** Sketch header: plane and how sketch coordinates map to world space. */
  sketchFrameText(sk: SketchFeature): string {
    const fr = this.refs.sketchFrame(sk);
    const u = this.u;
    const plane = this.planeName(planeSpec(sk.plane));
    if (!fr) return `Sketch ${sk.id} "${sk.name}" on ${plane} (plane not resolved yet).`;
    return `Sketch ${sk.id} "${sk.name}" on ${plane}. Sketch (x, y) maps to world origin ${u.pt(fr.o)} + x·${u.dir(fr.x)} + y·${u.dir(fr.y)}; sketch normal ${u.dir(fr.n)} (bosses extrude along it, cuts against it).`;
  }

  /** Faces or edges matching filters, nearest first when `near` is given. */
  findGeometry(o: {
    kind: 'faces' | 'edges'; feature?: Id; type?: string; normal?: Vec3; direction?: Vec3; ofFace?: string; near?: Vec3; nameContains?: string; limit: number;
  }): string {
    const { faces, edges } = this.host;
    const fi = o.ofFace ? faces.findIndex((f) => f.name === o.ofFace) : -1;
    if (o.kind === 'faces') {
      let list = faces.map((f, i) => ({ f, i }));
      if (o.feature) list = list.filter(({ f }) => f.feature === o.feature || f.name.startsWith(`${o.feature}:`));
      if (o.type) list = list.filter(({ f }) => f.type === o.type);
      if (o.normal) { const n = normalize(o.normal); list = list.filter(({ f }) => f.normal && dot(f.normal, n) > 0.9999); }
      if (o.nameContains) list = list.filter(({ f }) => f.name.includes(o.nameContains!));
      if (o.near) { const p = o.near; list.sort((a, b) => dist(a.f.center, p) - dist(b.f.center, p)); }
      const shown = list.slice(0, o.limit);
      return `${list.length} of ${faces.length} faces match${list.length > shown.length ? ` (showing ${shown.length})` : ''}:\n${shown.map(({ f }) => `- ${this.faceLine(f)}`).join('\n')}`;
    }
    let list = edges.map((e, i) => ({ e, i }));
    if (fi >= 0) list = list.filter(({ e }) => e.faces.includes(fi));
    if (o.feature) {
      const own = new Set(faces.flatMap((f, i) => (f.feature === o.feature || f.name.startsWith(`${o.feature}:`) ? [i] : [])));
      list = list.filter(({ e }) => e.faces.some((x) => own.has(x)));
    }
    if (o.type) list = list.filter(({ e }) => e.type === o.type);
    if (o.direction) { const d = normalize(o.direction); list = list.filter(({ e }) => (e.dir && Math.abs(dot(e.dir, d)) > 0.9999) || (e.type === 'circle' && e.axis && Math.abs(dot(normalize(e.axis), d)) > 0.9999)); }
    if (o.nameContains) list = list.filter(({ e }) => e.name.includes(o.nameContains!));
    if (o.near) { const p = o.near; list.sort((a, b) => dist(a.e.mid, p) - dist(b.e.mid, p)); }
    const shown = list.slice(0, o.limit);
    const head = o.ofFace && fi < 0 ? `No face named ${o.ofFace}. ` : '';
    return `${head}${list.length} of ${edges.length} edges match${list.length > shown.length ? ` (showing ${shown.length})` : ''}:\n${shown.map(({ e }) => `- ${this.edgeLine(e)}`).join('\n')}`;
  }
}
