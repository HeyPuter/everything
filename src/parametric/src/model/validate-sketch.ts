// Validate sketch structure at the file boundary. Invalid geometric values
// (such as conflicting dimensions) can still be shown as modeling errors;
// missing objects and broken references must not reach the editor or renderer.
import type { SketchFeature } from './types';
import { isDimension } from './types';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const vector = (v: unknown, size: number) => Array.isArray(v) && v.length === size && v.every(Number.isFinite);
const optionalBool = (v: unknown) => v === undefined || typeof v === 'boolean';
const relations = new Set(['coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal', 'concentric', 'midpoint', 'collinear', 'fix', 'symmetric']);

function plane(v: unknown): boolean {
  if (!object(v)) return false;
  if (v.kind === 'base') return ['front', 'top', 'right'].includes(String(v.plane));
  if (v.kind === 'feature') return id(v.id);
  if (v.kind !== 'face' || !object(v.face) || !id(v.face.name) || !object(v.face.sig)) return false;
  const s = v.face.sig;
  return typeof s.type === 'string' && vector(s.c, 3) && Number.isFinite(s.area) && (s.n === undefined || vector(s.n, 3));
}

export function validSketch(sk: SketchFeature): boolean {
  if (!plane(sk.plane) || !Array.isArray(sk.entities) || !Array.isArray(sk.constraints)) return false;
  const frame: unknown = sk.frame;
  if (frame !== undefined && (!object(frame) || !['o', 'x', 'y', 'n'].every((k) => vector(frame[k], 3)))) return false;
  const entities = new Map<string, string>([['O', 'point']]);
  for (const e of sk.entities) {
    if (!object(e) || !id(e.id) || entities.has(e.id) || !optionalBool(e.construction)) return false;
    switch (e.t) {
      case 'point': if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) return false; break;
      case 'line': if (!id(e.a) || !id(e.b)) return false; break;
      case 'arc': if (!id(e.a) || !id(e.b) || !id(e.c)) return false; break;
      case 'circle': if (!id(e.c) || !Number.isFinite(e.r)) return false; break;
      case 'spline': if (!Array.isArray(e.pts) || e.pts.length < 2 || !e.pts.every(id)) return false; break;
      default: return false;
    }
    entities.set(e.id, e.t);
  }
  for (const e of sk.entities) {
    const points = e.t === 'line' ? [e.a, e.b] : e.t === 'arc' ? [e.a, e.b, e.c] : e.t === 'circle' ? [e.c] : e.t === 'spline' ? e.pts : [];
    if (!points.every((p) => entities.get(p) === 'point')) return false;
  }
  const ids = new Set(entities.keys());
  for (const c of sk.constraints) {
    if (!object(c) || !id(c.id) || ids.has(c.id) || !Array.isArray(c.refs) || !c.refs.length || !c.refs.every((r) => id(r) && entities.has(r))) return false;
    ids.add(c.id);
    if (!isDimension(c)) {
      if (!relations.has(c.type) || !optionalBool(c.internal)) return false;
      continue;
    }
    if (!(typeof c.value === 'string' || Number.isFinite(c.value)) || !vector(c.at, 2) || typeof c.name !== 'string' || !optionalBool(c.driven)) return false;
    if (c.sector !== undefined && (!Number.isInteger(c.sector) || c.sector < 0 || c.sector > 3)) return false;
    const kinds = c.refs.map((r) => entities.get(r));
    if (c.type === 'radius' || c.type === 'diameter') {
      if (kinds.length !== 1 || !['circle', 'arc'].includes(kinds[0]!)) return false;
    } else if (c.type === 'angle') {
      if (kinds.length > 2 || !kinds.every((k) => k === 'line')) return false;
    } else if (kinds.length === 1) {
      if (kinds[0] !== 'line') return false;
    } else if (kinds.length !== 2 || !kinds.every((k) => ['point', 'circle', 'arc', ...(c.type === 'distance' ? ['line'] : [])].includes(k!))) return false;
  }
  return true;
}
