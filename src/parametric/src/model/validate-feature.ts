// Validate the references of features other than sketches at the file
// boundary. The feature tree, delete checks and the rebuild walk these lists
// and references, so a missing list or a reference without a name broke the
// app after the file had replaced the open document.
import type { Feature } from './types';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const named = (v: unknown) => object(v) && typeof v.name === 'string';
const list = (v: unknown, item: (x: unknown) => boolean) => Array.isArray(v) && v.every(item);
// A feature's own sketch may be '' (a panel or the Assistant creates it before a
// sketch is picked); the rebuild reports that feature instead of failing the file.
const sketchId = (v: unknown) => typeof v === 'string';

function plane(v: unknown): boolean {
  if (v == null) return true;
  if (!object(v)) return false;
  if (v.kind === 'base') return ['front', 'top', 'right'].includes(String(v.plane));
  if (v.kind === 'feature') return id(v.id);
  return v.kind === 'face' && named(v.face);
}

function axis(v: unknown): boolean {
  if (v == null) return true;
  if (!object(v)) return false;
  if (v.kind === 'base') return ['x', 'y', 'z'].includes(String(v.axis));
  if (v.kind === 'edge') return named(v.edge);
  if (v.kind === 'face') return named(v.face);
  return v.kind === 'sketchLine' && id(v.sketch) && id(v.entity);
}

const patternDir = (v: unknown) => object(v) && axis(v.ref);

export function validFeature(f: Feature): boolean {
  const r = f as unknown as Record<string, unknown>;
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
    default:
      return true;
  }
}
