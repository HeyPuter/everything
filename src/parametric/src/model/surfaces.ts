// Surface modeling features: names, parameters, references and factories.
// The geometry is built in src/kernel/surfaces.ts.

import type {
  DeleteFaceFeature, EdgeRef, FaceRef, Feature, Id, PlaneRef, SurfaceCutFeature, SurfaceExtendFeature, SurfaceExtrudeFeature,
  SurfaceFillFeature, SurfaceKnitFeature, SurfaceLoftFeature, SurfaceOffsetFeature, SurfacePlanarFeature, SurfaceRevolveFeature,
  SurfaceSweepFeature, SurfaceTrimFeature, ThickenFeature,
} from './types';

export type SurfaceFeature =
  | SurfaceExtrudeFeature
  | SurfaceRevolveFeature
  | SurfaceSweepFeature
  | SurfaceLoftFeature
  | SurfacePlanarFeature
  | SurfaceOffsetFeature
  | SurfaceFillFeature
  | SurfaceTrimFeature
  | SurfaceExtendFeature
  | SurfaceKnitFeature
  | ThickenFeature
  | SurfaceCutFeature
  | DeleteFaceFeature;

export type SurfaceFeatureType = SurfaceFeature['type'];

export const SURFACE_LABELS: Record<SurfaceFeatureType, string> = {
  surfaceExtrude: 'Extruded Surface',
  surfaceRevolve: 'Revolved Surface',
  surfaceSweep: 'Swept Surface',
  surfaceLoft: 'Lofted Surface',
  surfacePlanar: 'Planar Surface',
  surfaceOffset: 'Offset Surface',
  surfaceFill: 'Filled Surface',
  surfaceTrim: 'Trim Surface',
  surfaceExtend: 'Extend Surface',
  surfaceKnit: 'Knit Surface',
  thicken: 'Thicken',
  surfaceCut: 'Cut With Surface',
  deleteFace: 'Delete Face',
};

/** Base of the default names in the tree ("Surface-Extrude1", as other CAD systems name them). */
export const SURFACE_BASE_NAMES: Record<SurfaceFeatureType, string> = {
  surfaceExtrude: 'Surface-Extrude',
  surfaceRevolve: 'Surface-Revolve',
  surfaceSweep: 'Surface-Sweep',
  surfaceLoft: 'Surface-Loft',
  surfacePlanar: 'Surface-Plane',
  surfaceOffset: 'Surface-Offset',
  surfaceFill: 'Surface-Fill',
  surfaceTrim: 'Surface-Trim',
  surfaceExtend: 'Surface-Extend',
  surfaceKnit: 'Surface-Knit',
  thicken: 'Thicken',
  surfaceCut: 'SurfaceCut',
  deleteFace: 'Delete Face',
};

export const SURFACE_TYPES = new Set<string>(Object.keys(SURFACE_LABELS));

export const isSurfaceFeature = (f: Feature): f is SurfaceFeature => SURFACE_TYPES.has(f.type);

/** Surface features whose result is a surface body (shown, hidden and picked like one). */
export function makesSurfaceBody(f: Feature): boolean {
  if (!isSurfaceFeature(f)) return false;
  if (f.type === 'thicken' || f.type === 'surfaceCut') return false;
  if (f.type === 'surfaceKnit') return !f.solid;
  if (f.type === 'deleteFace') return f.mode === 'delete';
  return true;
}

export const SURFACE_PARAM_FIELDS = {
  surfaceExtrude: [
    { path: 'depth', kind: 'length' as const, label: 'Depth' },
    { path: 'dir2.depth', kind: 'length' as const, label: 'Depth (Direction 2)' },
  ],
  surfaceRevolve: [{ path: 'angle', kind: 'angle' as const, label: 'Angle' }],
  surfaceOffset: [{ path: 'distance', kind: 'length' as const, label: 'Offset distance' }],
  surfaceExtend: [{ path: 'distance', kind: 'length' as const, label: 'Distance' }],
  surfaceKnit: [{ path: 'tolerance', kind: 'length' as const, label: 'Knit tolerance' }],
  thicken: [{ path: 'thickness', kind: 'length' as const, label: 'Thickness' }],
};

export function surfaceIcon(f: SurfaceFeature): string {
  if (f.type === 'thicken') return f.cut ? 'thickenCut' : 'thicken';
  return f.type;
}

/** Sketches a surface feature consumes (shown nested under it in the tree). */
export function surfaceSketches(f: SurfaceFeature): Id[] {
  switch (f.type) {
    case 'surfaceExtrude':
    case 'surfaceRevolve':
      return f.sketch ? [f.sketch] : [];
    case 'surfaceSweep':
      return [f.profile, f.path].filter((x): x is Id => !!x);
    case 'surfaceLoft':
      return f.profiles;
    case 'surfacePlanar':
      return f.sketch ? [f.sketch] : [];
    case 'surfaceTrim':
      return f.tool?.kind === 'sketch' ? [f.tool.sketch] : [];
    default:
      return [];
  }
}

/** Calls the visitors with every reference of a surface feature (for dependencies). */
export function surfaceRefs(f: SurfaceFeature, visit: { name: (n: string) => void; plane: (p: PlaneRef | null | undefined) => void; axis: (a: SurfaceRevolveFeature['axis']) => void }) {
  const faces = (l: FaceRef[]) => l.forEach((r) => visit.name(r.name));
  const edges = (l: EdgeRef[]) => l.forEach((r) => visit.name(r.name));
  switch (f.type) {
    case 'surfaceRevolve': visit.axis(f.axis); break;
    case 'surfacePlanar': edges(f.edges); break;
    case 'surfaceOffset': faces(f.faces); break;
    case 'surfaceFill': edges(f.edges); break;
    case 'surfaceTrim':
      faces(f.faces);
      if (f.tool?.kind === 'plane') visit.plane(f.tool.plane);
      else if (f.tool?.kind === 'surface') visit.name(f.tool.face.name);
      break;
    case 'surfaceExtend': edges(f.edges); break;
    case 'surfaceKnit': faces(f.faces); break;
    case 'thicken': faces(f.faces); break;
    case 'surfaceCut': if (f.face) visit.name(f.face.name); break;
    case 'deleteFace': faces(f.faces); break;
    default: break;
  }
}

// ---- validation of files ----

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const named = (v: unknown) => object(v) && typeof v.name === 'string';
const list = (v: unknown, item: (x: unknown) => boolean) => Array.isArray(v) && v.every(item);
const optId = (v: unknown) => v == null || typeof v === 'string';
const vec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((c) => Number.isFinite(c));
const param = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string';
const oneOf = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v);

/**
 * Whether a surface feature from a file has the fields the rebuild, the tree
 * and the panels walk. `plane` and `axis` are the validators of the other features.
 */
export function validSurfaceFeature(f: Feature, plane: (v: unknown) => boolean, axis: (v: unknown) => boolean): boolean {
  const r = f as unknown as Record<string, unknown>;
  switch (f.type) {
    case 'surfaceExtrude':
      return typeof r.sketch === 'string' && oneOf(r.end, ['blind', 'midPlane']) && param(r.depth)
        && (r.dir2 == null || (object(r.dir2) && param(r.dir2.depth)));
    case 'surfaceRevolve':
      return typeof r.sketch === 'string' && axis(r.axis) && oneOf(r.end, ['blind', 'midPlane']) && param(r.angle);
    case 'surfaceSweep':
      return optId(r.profile) && optId(r.path);
    case 'surfaceLoft':
      return list(r.profiles, id);
    case 'surfacePlanar':
      return optId(r.sketch) && list(r.edges, named);
    case 'surfaceOffset':
      return list(r.faces, named) && param(r.distance);
    case 'surfaceFill':
      return list(r.edges, named);
    case 'surfaceTrim': {
      const t = r.tool;
      const tool = t == null || (object(t) && (
        (t.kind === 'sketch' && typeof t.sketch === 'string') || (t.kind === 'plane' && t.plane != null && plane(t.plane)) || (t.kind === 'surface' && named(t.face))));
      return list(r.faces, named) && tool && list(r.keep, vec3);
    }
    case 'surfaceExtend':
      return list(r.edges, named) && param(r.distance) && oneOf(r.mode, ['same', 'linear']);
    case 'surfaceKnit':
      return list(r.faces, named) && param(r.tolerance);
    case 'thicken':
      return list(r.faces, named) && param(r.thickness) && oneOf(r.side, ['front', 'back', 'both']);
    case 'surfaceCut':
      return r.face == null || named(r.face);
    case 'deleteFace':
      return list(r.faces, named) && oneOf(r.mode, ['delete', 'patch']);
    default:
      return true;
  }
}

// ---- factories ----

export function newSurfaceFeature(type: SurfaceFeatureType, fid: Id, name: string, size: number): SurfaceFeature {
  const base = { id: fid, name };
  switch (type) {
    case 'surfaceExtrude': return { ...base, type, sketch: '', end: 'blind', depth: size, flip: false, dir2: null };
    case 'surfaceRevolve': return { ...base, type, sketch: '', axis: null, end: 'blind', angle: 360, flip: false };
    case 'surfaceSweep': return { ...base, type, profile: null, path: null };
    case 'surfaceLoft': return { ...base, type, profiles: [], ruled: false };
    case 'surfacePlanar': return { ...base, type, sketch: null, edges: [] };
    case 'surfaceOffset': return { ...base, type, faces: [], distance: Math.max(size / 10, 1), flip: false };
    case 'surfaceFill': return { ...base, type, edges: [] };
    case 'surfaceTrim': return { ...base, type, faces: [], tool: null, keep: [], flip: false };
    case 'surfaceExtend': return { ...base, type, edges: [], distance: Math.max(size / 5, 1), mode: 'same' };
    case 'surfaceKnit': return { ...base, type, faces: [], tolerance: 0.01, solid: false };
    case 'thicken': return { ...base, type, faces: [], thickness: Math.max(size / 20, 1), side: 'front', cut: false };
    case 'surfaceCut': return { ...base, type, face: null, flip: false };
    case 'deleteFace': return { ...base, type, faces: [], mode: 'delete' };
  }
}
