// Validate the references of features other than sketches at the file
// boundary. The feature tree, delete checks and the rebuild walk these lists
// and references, so a missing list or a reference without a name broke the
// app after the file had replaced the open document.
import type { Feature } from './types';
import { isSurfaceFeature, validSurfaceFeature } from './surfaces';
import { validSheetMetalFeature } from './sheetmetal';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const named = (v: unknown) => object(v) && typeof v.name === 'string';
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
// Face and edge references: a name, and a geometric signature that panels show
// ("Edge (line)") and the rebuild falls back on to tell split faces apart. A
// reference whose signature is missing or partly damaged still opens: the
// missing values are filled with neutral ones (no type, no position), so the
// panel says "Edge" and the rebuild finds the reference by its name, or says it
// is gone. Only a reference or signature that is not an object is refused.
function sigOf(v: unknown): Record<string, unknown> | null {
  if (!named(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.sig == null) r.sig = {};
  return object(r.sig) ? r.sig : null;
}
function faceRef(v: unknown): boolean {
  const s = sigOf(v);
  if (!s) return false;
  if (typeof s.type !== 'string') s.type = '';
  if (!vec3(s.c)) s.c = [0, 0, 0];
  if (!num(s.area)) s.area = 0;
  if (s.n != null && !vec3(s.n)) delete s.n;
  return true;
}
function edgeRef(v: unknown): boolean {
  const s = sigOf(v);
  if (!s) return false;
  if (typeof s.type !== 'string') s.type = '';
  if (!vec3(s.m)) s.m = [0, 0, 0];
  if (!num(s.len)) s.len = 0;
  return true;
}
const list = (v: unknown, item: (x: unknown) => boolean) => Array.isArray(v) && v.every(item);
// A feature's own sketch may be '' (a panel or the Assistant creates it before a
// sketch is picked); the rebuild reports that feature instead of failing the file.
const sketchId = (v: unknown) => typeof v === 'string';

function plane(v: unknown): boolean {
  if (v == null) return true;
  if (!object(v)) return false;
  if (v.kind === 'base') return ['front', 'top', 'right'].includes(String(v.plane));
  if (v.kind === 'feature') return id(v.id);
  return v.kind === 'face' && faceRef(v.face) && (v.x == null || vec3(v.x));
}

function vec3(v: unknown): boolean {
  return Array.isArray(v) && v.length === 3 && v.every((c) => Number.isFinite(c));
}

function axis(v: unknown): boolean {
  if (v == null) return true;
  if (!object(v)) return false;
  if (v.kind === 'base') return ['x', 'y', 'z'].includes(String(v.axis));
  if (v.kind === 'edge') return edgeRef(v.edge);
  if (v.kind === 'face') return faceRef(v.face);
  return v.kind === 'sketchLine' && id(v.sketch) && id(v.entity);
}

const patternDir = (v: unknown) => object(v) && axis(v.ref);

// Weldments: segments of layout sketches and members of structural member features.
const segment = (v: unknown) => object(v) && id(v.sketch) && id(v.entity);
const group = (v: unknown) => object(v) && list(v.segments, segment);
const memberRef = (v: unknown) => object(v) && id(v.feature) && typeof v.member === 'string';
const text = (v: unknown) => typeof v === 'string';
const oneOf = (v: unknown, values: string[]) => values.includes(String(v));

/**
 * The face and edge references of any feature type (every "faces" and "edges"
 * list, and a single "face"), with damaged signatures repaired in place.
 */
function refsValid(r: Record<string, unknown>): boolean {
  if (Array.isArray(r.edges) && !r.edges.every(edgeRef)) return false;
  if (Array.isArray(r.faces) && !r.faces.every(faceRef)) return false;
  if (r.face != null && !faceRef(r.face)) return false;
  return !(object(r.tool) && r.tool.face != null && !faceRef(r.tool.face));
}

export function validFeature(f: Feature): boolean {
  const r = f as unknown as Record<string, unknown>;
  if (!refsValid(r)) return false;
  if (isSurfaceFeature(f)) return validSurfaceFeature(f, plane, axis);
  switch (f.type) {
    case 'extrude':
    case 'hole':
      return sketchId(r.sketch);
    case 'revolve':
      return sketchId(r.sketch) && axis(r.axis);
    case 'fillet':
    case 'chamfer':
      return list(r.edges, named) && list(r.faces, named);
    case 'shell':
      return list(r.faces, named);
    case 'draft':
      return list(r.faces, named) && plane(r.neutral);
    case 'mirror':
      return list(r.seeds, id) && plane(r.plane);
    case 'plane':
      return plane(r.ref);
    case 'linearPattern':
      return list(r.seeds, id) && patternDir(r.dir1) && (r.dir2 == null || patternDir(r.dir2));
    case 'circularPattern':
      return list(r.seeds, id) && axis(r.axis);
    case 'loft':
      return list(r.profiles, id);
    case 'sweep':
      return (r.profile == null || id(r.profile)) && (r.path == null || id(r.path));
    case 'baseFlange':
    case 'edgeFlange':
    case 'sketchedBend':
    case 'hem':
      return validSheetMetalFeature(r);
    case 'structuralMember':
      return text(r.standard) && text(r.profile) && text(r.size) && text(r.pierce) && list(r.groups, group) && oneOf(r.corner, ['miter', 'butt1', 'butt2']);
    case 'trimExtend':
      return list(r.members, memberRef) && list(r.boundaryMembers, memberRef) && list(r.faces, named) && oneOf(r.boundary, ['faces', 'members']);
    case 'endCap':
      return list(r.faces, named);
    case 'gusset':
      return list(r.faces, named) && oneOf(r.shape, ['triangular', 'polygonal']) && oneOf(r.location, ['center', 'side1', 'side2']);
    case 'weldBead':
      return list(r.edges, named);
    default:
      return true;
  }
}
