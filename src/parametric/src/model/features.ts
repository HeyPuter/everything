// Feature factories, display names and parameter metadata.

import type {
  AxisRef, ChamferFeature, CircularPatternFeature, DraftFeature, ExtrudeFeature, Feature, FeatureType, FilletFeature, HoleFeature,
  Id, LinearPatternFeature, LoftFeature, MirrorFeature, PartDocument, PlaneFeature, PlaneRef, RevolveFeature, ShellFeature,
  SketchFeature, SweepFeature,
} from './types';

export type ParamKind = 'length' | 'angle' | 'count';

/** Paths (dot separated) of numeric parameters per feature type. */
export const PARAM_FIELDS: Partial<Record<FeatureType, { path: string; kind: ParamKind; label: string }[]>> = {
  extrude: [
    { path: 'depth', kind: 'length', label: 'Depth' },
    { path: 'dir2.depth', kind: 'length', label: 'Depth (Direction 2)' },
    { path: 'draft', kind: 'angle', label: 'Draft angle' },
  ],
  revolve: [{ path: 'angle', kind: 'angle', label: 'Angle' }],
  fillet: [{ path: 'radius', kind: 'length', label: 'Radius' }],
  chamfer: [
    { path: 'distance', kind: 'length', label: 'Distance' },
    { path: 'distance2', kind: 'length', label: 'Distance 2' },
    { path: 'angle', kind: 'angle', label: 'Angle' },
  ],
  shell: [{ path: 'thickness', kind: 'length', label: 'Thickness' }],
  hole: [
    { path: 'diameter', kind: 'length', label: 'Diameter' },
    { path: 'depth', kind: 'length', label: 'Depth' },
    { path: 'cbDiameter', kind: 'length', label: 'Counterbore diameter' },
    { path: 'cbDepth', kind: 'length', label: 'Counterbore depth' },
    { path: 'csDiameter', kind: 'length', label: 'Countersink diameter' },
    { path: 'csAngle', kind: 'angle', label: 'Countersink angle' },
  ],
  linearPattern: [
    { path: 'dir1.spacing', kind: 'length', label: 'Spacing' },
    { path: 'dir1.count', kind: 'count', label: 'Instances' },
    { path: 'dir2.spacing', kind: 'length', label: 'Spacing (Direction 2)' },
    { path: 'dir2.count', kind: 'count', label: 'Instances (Direction 2)' },
  ],
  circularPattern: [
    { path: 'angle', kind: 'angle', label: 'Angle' },
    { path: 'count', kind: 'count', label: 'Instances' },
  ],
  plane: [{ path: 'offset', kind: 'length', label: 'Offset' }],
  draft: [{ path: 'angle', kind: 'angle', label: 'Draft angle' }],
};

const BASE_NAMES: Record<FeatureType, string> = {
  sketch: 'Sketch',
  extrude: 'Extrude',
  revolve: 'Revolve',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  shell: 'Shell',
  hole: 'Hole',
  linearPattern: 'Linear Pattern',
  circularPattern: 'Circular Pattern',
  mirror: 'Mirror',
  plane: 'Plane',
  loft: 'Loft',
  sweep: 'Sweep',
  draft: 'Draft',
  import: 'Imported',
};

export const FEATURE_LABELS: Record<FeatureType, string> = {
  sketch: 'Sketch',
  extrude: 'Extrude',
  revolve: 'Revolve',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  shell: 'Shell',
  hole: 'Hole',
  linearPattern: 'Linear Pattern',
  circularPattern: 'Circular Pattern',
  mirror: 'Mirror',
  plane: 'Reference Plane',
  loft: 'Loft',
  sweep: 'Sweep',
  draft: 'Draft',
  import: 'Imported Body',
};

export function featureIcon(f: Feature): string {
  switch (f.type) {
    case 'sketch': return 'sketchFeature';
    case 'extrude': return f.cut ? 'extrudeCut' : 'extrude';
    case 'revolve': return f.cut ? 'revolveCut' : 'revolve';
    case 'loft': return 'loft';
    case 'sweep': return 'sweep';
    case 'import': return 'part';
    default: return f.type;
  }
}

/** Next free display name such as "Extrude3". */
export function nextName(doc: PartDocument, base: string): string {
  let n = 1;
  const names = new Set(doc.features.map((f) => f.name));
  while (names.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

export function defaultName(doc: PartDocument, type: FeatureType, cut = false): string {
  const base = cut && (type === 'extrude' || type === 'revolve') ? `Cut-${BASE_NAMES[type]}` : BASE_NAMES[type];
  return nextName(doc, base);
}

export const newSketch = (id: Id, name: string, plane: PlaneRef): SketchFeature => ({ id, name, type: 'sketch', plane, entities: [], constraints: [] });

export const newExtrude = (id: Id, name: string, sketch: Id, cut: boolean, depth: number): ExtrudeFeature => ({
  id, name, type: 'extrude', sketch, cut, end: cut ? 'throughAll' : 'blind', depth, flip: false, dir2: null, draft: 0, draftOutward: false, thin: null,
});

export const newRevolve = (id: Id, name: string, sketch: Id, cut: boolean): RevolveFeature => ({
  id, name, type: 'revolve', sketch, cut, axis: null, end: 'blind', angle: 360, flip: false, thin: null,
});

export const newFillet = (id: Id, name: string, radius: number): FilletFeature => ({ id, name, type: 'fillet', edges: [], faces: [], radius });

export const newChamfer = (id: Id, name: string, distance: number): ChamferFeature => ({
  id, name, type: 'chamfer', edges: [], faces: [], mode: 'distance', distance, distance2: distance, angle: 45, flip: false,
});

export const newShell = (id: Id, name: string, thickness: number): ShellFeature => ({ id, name, type: 'shell', faces: [], thickness, outward: false });

export const newHole = (id: Id, name: string, sketch: Id, diameter: number): HoleFeature => ({
  id, name, type: 'hole', sketch, kind: 'simple', diameter, end: 'throughAll', depth: diameter * 2, cbDiameter: diameter * 1.8, cbDepth: diameter * 0.6,
  csDiameter: diameter * 2, csAngle: 90, flip: false,
});

export const newLinearPattern = (id: Id, name: string, seeds: Id[], spacing: number): LinearPatternFeature => ({
  id, name, type: 'linearPattern', seeds, dir1: { ref: null, spacing, count: 3, flip: false }, dir2: null,
});

export const newCircularPattern = (id: Id, name: string, seeds: Id[]): CircularPatternFeature => ({
  id, name, type: 'circularPattern', seeds, axis: null, angle: 360, count: 4, equal: true, flip: false,
});

export const newMirror = (id: Id, name: string, seeds: Id[]): MirrorFeature => ({ id, name, type: 'mirror', seeds, plane: null });

export const newPlane = (id: Id, name: string, ref: PlaneRef | null, offset: number): PlaneFeature => ({ id, name, type: 'plane', ref, offset, flip: false });

export const newLoft = (id: Id, name: string, profiles: Id[], cut: boolean): LoftFeature => ({ id, name, type: 'loft', profiles, cut, ruled: false });

export const newSweep = (id: Id, name: string, cut: boolean): SweepFeature => ({ id, name, type: 'sweep', profile: null, path: null, cut });

export const newDraft = (id: Id, name: string): DraftFeature => ({ id, name, type: 'draft', faces: [], neutral: null, angle: 3, flip: false });

/** Features that consume a sketch (the sketch is shown nested under them). */
export function consumedSketches(f: Feature): Id[] {
  switch (f.type) {
    case 'extrude':
    case 'revolve':
    case 'hole':
      return [f.sketch];
    case 'loft':
      return f.profiles;
    case 'sweep':
      return [f.profile, f.path].filter((x): x is Id => !!x);
    default:
      return [];
  }
}

/**
 * Ids of the features that created a named face or edge. Face names start
 * with the creating feature ("f3:cap1"), patterned and mirrored copies add
 * "@<pattern>.<n>", and edge names join the names of their faces with "|".
 */
export function refFeatureIds(name: string): Id[] {
  const out: Id[] = [];
  for (const part of name.split('|')) {
    const [base, ...copies] = part.replace(/#\d+$/, '').split('@');
    const i = base.indexOf(':');
    if (i > 0) out.push(base.slice(0, i));
    for (const c of copies) { const id = c.split('.')[0]; if (id) out.push(id); }
  }
  return out;
}

/** Ids of features a feature depends on (for delete warnings and ordering). */
export function dependencies(f: Feature): Id[] {
  const out = new Set<Id>(consumedSketches(f));
  const visitName = (name: string) => { for (const id of refFeatureIds(name)) if (id !== f.id) out.add(id); };
  const visitPlane = (p: PlaneRef | null | undefined) => {
    if (p?.kind === 'feature') out.add(p.id);
    else if (p?.kind === 'face') visitName(p.face.name);
  };
  const visitAxis = (a: AxisRef | null | undefined) => {
    if (a?.kind === 'sketchLine') out.add(a.sketch);
    else if (a?.kind === 'edge') visitName(a.edge.name);
    else if (a?.kind === 'face') visitName(a.face.name);
  };
  if (f.type === 'sketch') visitPlane(f.plane);
  if (f.type === 'plane') visitPlane(f.ref);
  if (f.type === 'mirror') { visitPlane(f.plane); f.seeds.forEach((s) => out.add(s)); }
  if (f.type === 'draft') { visitPlane(f.neutral); f.faces.forEach((r) => visitName(r.name)); }
  if (f.type === 'linearPattern' || f.type === 'circularPattern') f.seeds.forEach((s) => out.add(s));
  if (f.type === 'revolve' || f.type === 'circularPattern') visitAxis(f.axis);
  if (f.type === 'linearPattern') for (const d of [f.dir1, f.dir2]) visitAxis(d?.ref);
  if (f.type === 'fillet' || f.type === 'chamfer') { f.edges.forEach((r) => visitName(r.name)); f.faces.forEach((r) => visitName(r.name)); }
  if (f.type === 'shell') f.faces.forEach((r) => visitName(r.name));
  return [...out];
}

export function getPath(obj: unknown, path: string): unknown {
  let cur = obj as Record<string, unknown> | null;
  for (const k of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[k] as Record<string, unknown> | null;
  }
  return cur;
}

export function setPath(obj: unknown, path: string, value: unknown) {
  const keys = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null) return;
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}
