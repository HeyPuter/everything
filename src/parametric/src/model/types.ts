// Part document model. Everything here is plain JSON so a document can be
// saved, diffed for undo, and posted to the geometry worker unchanged.
// Lengths are stored in millimetres and angles in degrees regardless of the
// display unit system.

import type { Vec2, Vec3, Frame } from '../math/vec';

export type Id = string;

/** A numeric parameter: a literal, or an expression string such as "=Width/2". */
export type Param = number | string;

export type UnitSystem = 'MMGS' | 'CGS' | 'MKS' | 'IPS';
export type BasePlane = 'front' | 'top' | 'right';

// ---- Topology references ----
// Faces are named after the feature and sketch entity that created their
// surface, so references survive dimension changes. The geometric signature
// is a fallback used to disambiguate split faces.

export interface FaceSig {
  type: string;
  c: Vec3;
  n?: Vec3;
  area: number;
}

export interface EdgeSig {
  type: string;
  m: Vec3;
  len: number;
}

export interface FaceRef {
  name: string;
  sig: FaceSig;
}

export interface EdgeRef {
  name: string;
  sig: EdgeSig;
}

export interface VertexRef {
  p: Vec3;
}

export type PlaneRef =
  | { kind: 'base'; plane: BasePlane }
  | { kind: 'feature'; id: Id }
  | { kind: 'face'; face: FaceRef };

export type AxisRef =
  | { kind: 'base'; axis: 'x' | 'y' | 'z' }
  | { kind: 'edge'; edge: EdgeRef }
  | { kind: 'face'; face: FaceRef }
  | { kind: 'sketchLine'; sketch: Id; entity: Id };

// ---- Sketch ----

/**
 * Link from projected sketch geometry to the model. Every rebuild puts the
 * entity back on its model edge (or vertex), and the solver holds it fixed.
 * - edge: a line, arc or circle on the projected edge; a point for a straight
 *   edge seen end-on.
 * - vertex: a point on a model vertex, found again as the end the edges
 *   meeting there share (p is where it was, to pick between candidates).
 */
export type ExtRef =
  | { kind: 'edge'; edge: EdgeRef }
  | { kind: 'vertex'; edges: EdgeRef[]; p: Vec3 };

export interface SkBase {
  id: Id;
  construction?: boolean;
  /** Projected from the model and kept linked to it. */
  ext?: ExtRef;
}

export interface SkPoint extends SkBase {
  t: 'point';
  x: number;
  y: number;
}

export interface SkLine extends SkBase {
  t: 'line';
  a: Id;
  b: Id;
}

export interface SkCircle extends SkBase {
  t: 'circle';
  c: Id;
  r: number;
}

/** Counter-clockwise arc around c from a to b. */
export interface SkArc extends SkBase {
  t: 'arc';
  c: Id;
  a: Id;
  b: Id;
}

/** Smooth curve through its points (centripetal Catmull-Rom, exported as Beziers). */
export interface SkSpline extends SkBase {
  t: 'spline';
  pts: Id[];
}

export type SkEntity = SkPoint | SkLine | SkCircle | SkArc | SkSpline;
export type SkCurve = SkLine | SkCircle | SkArc | SkSpline;

export type RelationType =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'equal'
  | 'concentric'
  | 'midpoint'
  | 'collinear'
  | 'fix'
  | 'symmetric';

export type DimensionType = 'distance' | 'hdistance' | 'vdistance' | 'radius' | 'diameter' | 'angle';

export interface SkRelation {
  id: Id;
  type: RelationType;
  refs: Id[];
  /** Tangent circles: true when one lies inside the other. */
  internal?: boolean;
}

export interface SkDimension {
  id: Id;
  type: DimensionType;
  refs: Id[];
  value: Param;
  /** Reference (driven) dimensions report a value without constraining. */
  driven?: boolean;
  /** Label position in sketch coordinates. */
  at: Vec2;
  /** Dimension name used in equations, e.g. D1. */
  name: string;
  /** Angle dimensions: which of the four angles between two lines is meant. */
  sector?: number;
}

export type SkConstraint = SkRelation | SkDimension;

export const isDimension = (c: SkConstraint): c is SkDimension =>
  c.type === 'distance' || c.type === 'hdistance' || c.type === 'vdistance' ||
  c.type === 'radius' || c.type === 'diameter' || c.type === 'angle';

// ---- Features ----

export interface FeatureBase {
  id: Id;
  name: string;
  suppressed?: boolean;
  hidden?: boolean;
}

export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  plane: PlaneRef;
  entities: SkEntity[];
  constraints: SkConstraint[];
  /** Plane frame resolved at the last rebuild (kept for display while editing). */
  frame?: Frame;
}

export type EndCondition = 'blind' | 'throughAll' | 'midPlane';

export interface ExtrudeDir2 {
  end: 'blind' | 'throughAll';
  depth: Param;
}

export interface ThinOptions {
  thickness: Param;
  /** one side (direction of the profile normal), the other side, or both. */
  side: 'outside' | 'inside' | 'mid';
}

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  sketch: Id;
  cut: boolean;
  end: EndCondition;
  depth: Param;
  flip: boolean;
  dir2: ExtrudeDir2 | null;
  draft: Param;
  draftOutward: boolean;
  thin: ThinOptions | null;
  /** Optional sample points (sketch coordinates) choosing which regions to use. */
  contours?: Vec2[];
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  sketch: Id;
  cut: boolean;
  /** null picks the sketch's first centerline. */
  axis: AxisRef | null;
  end: 'blind' | 'midPlane';
  angle: Param;
  flip: boolean;
  thin: ThinOptions | null;
  contours?: Vec2[];
}

export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  edges: EdgeRef[];
  faces: FaceRef[];
  radius: Param;
}

export interface ChamferFeature extends FeatureBase {
  type: 'chamfer';
  edges: EdgeRef[];
  faces: FaceRef[];
  mode: 'distance' | 'distanceAngle' | 'twoDistance';
  distance: Param;
  distance2: Param;
  angle: Param;
  flip: boolean;
}

export interface ShellFeature extends FeatureBase {
  type: 'shell';
  faces: FaceRef[];
  thickness: Param;
  outward: boolean;
}

export type HoleKind = 'simple' | 'counterbore' | 'countersink';

export interface HoleFeature extends FeatureBase {
  type: 'hole';
  /** Sketch whose points mark hole centres; the sketch plane sets the direction. */
  sketch: Id;
  kind: HoleKind;
  diameter: Param;
  end: 'blind' | 'throughAll';
  depth: Param;
  cbDiameter: Param;
  cbDepth: Param;
  csDiameter: Param;
  csAngle: Param;
  flip: boolean;
}

export interface PatternDir {
  ref: AxisRef | null;
  spacing: Param;
  count: Param;
  flip: boolean;
}

export interface LinearPatternFeature extends FeatureBase {
  type: 'linearPattern';
  seeds: Id[];
  dir1: PatternDir;
  dir2: PatternDir | null;
}

export interface CircularPatternFeature extends FeatureBase {
  type: 'circularPattern';
  seeds: Id[];
  axis: AxisRef | null;
  angle: Param;
  count: Param;
  equal: boolean;
  flip: boolean;
}

export interface MirrorFeature extends FeatureBase {
  type: 'mirror';
  /** Features to mirror; empty mirrors the whole body. */
  seeds: Id[];
  plane: PlaneRef | null;
}

export interface PlaneFeature extends FeatureBase {
  type: 'plane';
  ref: PlaneRef | null;
  offset: Param;
  flip: boolean;
}

export interface LoftFeature extends FeatureBase {
  type: 'loft';
  profiles: Id[];
  cut: boolean;
  ruled: boolean;
}

export interface SweepFeature extends FeatureBase {
  type: 'sweep';
  profile: Id | null;
  path: Id | null;
  cut: boolean;
}

export interface DraftFeature extends FeatureBase {
  type: 'draft';
  faces: FaceRef[];
  neutral: PlaneRef | null;
  angle: Param;
  flip: boolean;
}

export interface ImportFeature extends FeatureBase {
  type: 'import';
  format: 'step' | 'brep';
  /** Key into PartDocument.blobs holding the file text. */
  blob: Id;
  fileName: string;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | HoleFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | MirrorFeature
  | PlaneFeature
  | LoftFeature
  | SweepFeature
  | DraftFeature
  | ImportFeature;

export type FeatureType = Feature['type'];

export interface Variable {
  id: Id;
  name: string;
  expr: string;
}

export interface MaterialRef {
  name: string;
  /** kg/m^3 */
  density: number;
}

export interface PartDocument {
  format: 'parametric-part';
  version: 1;
  name: string;
  units: UnitSystem;
  /** Decimal places shown for lengths. */
  decimals: number;
  material: MaterialRef | null;
  color: string;
  variables: Variable[];
  features: Feature[];
  /** Features at index >= rollback are rolled back (not built). null = none. */
  rollback: number | null;
  /** Large payloads (imported geometry) kept out of undo snapshots. */
  blobs: Record<Id, string>;
  /** 2D drawing of the part (sheet with projected views), if created. */
  drawing?: DrawingDoc | null;
  nextId: number;
  created: number;
  modified: number;
}

// ---- Drawings ----

export type SheetSize = 'A4' | 'A3' | 'A2' | 'A1' | 'Letter' | 'Tabloid';
export type DrawingViewKind = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'isometric';

export interface DrawingView {
  id: Id;
  kind: DrawingViewKind;
  /** Centre of the view on the sheet, in sheet millimetres (y down). */
  x: number;
  y: number;
  hidden: boolean;
  /** Show overall width and height dimensions. */
  dims: boolean;
}

export interface DrawingDoc {
  sheet: SheetSize;
  landscape: boolean;
  /** Model to paper scale, e.g. 0.5 for 1:2. */
  scale: number;
  views: DrawingView[];
  title: string;
  drawnBy: string;
  notes: string;
}
