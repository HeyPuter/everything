// Part document model. Everything here is plain JSON so a document can be
// saved, diffed for undo, and posted to the geometry worker unchanged.
// Lengths are stored in millimetres and angles in degrees regardless of the
// display unit system.

import type { Vec2, Vec3, Frame } from '../math/vec';
import type { BaseFlangeFeature, EdgeFlangeFeature, HemFeature, SketchedBendFeature } from './sheetmetal';
import type { CamDoc } from './cam';

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
  | {
    kind: 'face';
    face: FaceRef;
    /**
     * World direction the frame's x axis is projected from, as chosen when the
     * face was picked. Without it the axis is chosen again from the face's
     * normal on every rebuild, and a face tilting past the choice's threshold
     * turned the sketch on it by 90 degrees.
     */
    x?: Vec3;
  };

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

// ---- Surfaces ----
// Surface features make (or change) surface bodies: open sheets kept apart
// from the solid, each named after the feature that last made it. Thicken,
// Knit (as a solid) and Cut With Surface turn them into solid geometry.

export interface SurfaceExtrudeFeature extends FeatureBase {
  type: 'surfaceExtrude';
  sketch: Id;
  end: 'blind' | 'midPlane';
  depth: Param;
  flip: boolean;
  /** Second direction (Blind), or null. */
  dir2: { depth: Param } | null;
}

export interface SurfaceRevolveFeature extends FeatureBase {
  type: 'surfaceRevolve';
  sketch: Id;
  /** null picks the sketch's first centerline. */
  axis: AxisRef | null;
  end: 'blind' | 'midPlane';
  angle: Param;
  flip: boolean;
}

export interface SurfaceSweepFeature extends FeatureBase {
  type: 'surfaceSweep';
  profile: Id | null;
  path: Id | null;
}

export interface SurfaceLoftFeature extends FeatureBase {
  type: 'surfaceLoft';
  profiles: Id[];
  ruled: boolean;
}

/** A planar surface from the closed regions of a sketch, or from a closed loop of edges. */
export interface SurfacePlanarFeature extends FeatureBase {
  type: 'surfacePlanar';
  sketch: Id | null;
  edges: EdgeRef[];
}

/** Offset copies of faces (of the solid or of surfaces); a distance of zero copies them. */
export interface SurfaceOffsetFeature extends FeatureBase {
  type: 'surfaceOffset';
  faces: FaceRef[];
  distance: Param;
  flip: boolean;
}

/** A patch filling a closed boundary of edges. */
export interface SurfaceFillFeature extends FeatureBase {
  type: 'surfaceFill';
  edges: EdgeRef[];
}

export type TrimTool =
  | { kind: 'sketch'; sketch: Id }
  | { kind: 'plane'; plane: PlaneRef }
  | { kind: 'surface'; face: FaceRef };

/** Trims surface bodies with a sketch, plane or another surface, keeping the pieces picked (or one side). */
export interface SurfaceTrimFeature extends FeatureBase {
  type: 'surfaceTrim';
  /** A face of each surface body to trim. */
  faces: FaceRef[];
  tool: TrimTool | null;
  /** Points on the pieces to keep; empty keeps the side the tool's normal points to (flip: the other). */
  keep: Vec3[];
  flip: boolean;
}

/** Extends a surface past its boundary edges. */
export interface SurfaceExtendFeature extends FeatureBase {
  type: 'surfaceExtend';
  edges: EdgeRef[];
  distance: Param;
  /** same: the surface carries on as it is; linear: tangent to it, straight. */
  mode: 'same' | 'linear';
}

/** Sews surface bodies into one, and into a solid when they close a volume. */
export interface SurfaceKnitFeature extends FeatureBase {
  type: 'surfaceKnit';
  /** A face of each surface body to knit. */
  faces: FaceRef[];
  tolerance: Param;
  solid: boolean;
}

/** Turns a surface body into a solid of a thickness: added to the solid body, or cut from it. */
export interface ThickenFeature extends FeatureBase {
  type: 'thicken';
  /** A face of the surface body to thicken. */
  faces: FaceRef[];
  thickness: Param;
  /** front: along the surface normal; back: against it; both: half each way. */
  side: 'front' | 'back' | 'both';
  cut: boolean;
}

/** Cuts the solid body with a surface, removing the material on the side its normal points to (flip: the other). */
export interface SurfaceCutFeature extends FeatureBase {
  type: 'surfaceCut';
  face: FaceRef | null;
  flip: boolean;
}

/** Removes faces from the solid, leaving a surface body (or patching the hole). */
export interface DeleteFaceFeature extends FeatureBase {
  type: 'deleteFace';
  faces: FaceRef[];
  mode: 'delete' | 'patch';
}

// ---- Weldments ----

/** A line or arc of a sketch, used as the path of a structural member. */
export interface SegmentRef {
  sketch: Id;
  entity: Id;
}

/** Segments whose members are joined by the group's corner treatment. */
export interface MemberGroup {
  segments: SegmentRef[];
}

export type CornerTreatment = 'miter' | 'butt1' | 'butt2';

export interface StructuralMemberFeature extends FeatureBase {
  type: 'structuralMember';
  /** Profile library keys (see weldment-profiles.ts). */
  standard: string;
  profile: string;
  size: string;
  groups: MemberGroup[];
  /** Profile rotation about the member axis, degrees. */
  rotation: Param;
  mirror: boolean;
  /** Profile point placed on the sketch segment. */
  pierce: string;
  /** Joints between members of one group. */
  corner: CornerTreatment;
  /** Gap at joints within a group. */
  gap: Param;
  /** Members of later groups are trimmed or extended to members of earlier groups. */
  trimGroups: boolean;
  /** Gap where a member is trimmed to a member of another group. */
  gap2: Param;
}

/** A member of a structural member feature: its feature and segment ("sketch/entity"). */
export interface MemberRef {
  feature: Id;
  member: string;
}

export interface TrimExtendFeature extends FeatureBase {
  type: 'trimExtend';
  /** Members to trim or extend. */
  members: MemberRef[];
  /** Planar faces, or members, to trim to. */
  boundary: 'faces' | 'members';
  faces: FaceRef[];
  boundaryMembers: MemberRef[];
  /** Members that stop short of the boundary are extended to it. */
  allowExtension: boolean;
  /** Members trimmed to members follow their surface (coped) instead of a plane. */
  coped: boolean;
  gap: Param;
}

export interface EndCapFeature extends FeatureBase {
  type: 'endCap';
  /** End faces of tube or pipe members. */
  faces: FaceRef[];
  thickness: Param;
  /** Distance the cap's edge is set in from the member's edge. */
  offset: Param;
  /** Outward adds the cap past the end; inward fits it inside the tube. */
  inward: boolean;
}

export interface GussetFeature extends FeatureBase {
  type: 'gusset';
  /** Two planar faces meeting at a corner. */
  faces: FaceRef[];
  shape: 'triangular' | 'polygonal';
  d1: Param;
  d2: Param;
  /** Polygonal: length of the straight edges at the ends of the legs. */
  d3: Param;
  thickness: Param;
  /** Where the plate lies across its thickness. */
  location: 'center' | 'side1' | 'side2';
  /** Corner clip for the weld at the inner corner (0 for none). */
  chamfer: Param;
}

/** A solid fillet weld: a triangular bead along inside corner edges. */
export interface WeldBeadFeature extends FeatureBase {
  type: 'weldBead';
  edges: EdgeRef[];
  /** Leg length of the weld. */
  size: Param;
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
  | ImportFeature
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
  | DeleteFaceFeature
  | BaseFlangeFeature
  | EdgeFlangeFeature
  | SketchedBendFeature
  | HemFeature
  | StructuralMemberFeature
  | TrimExtendFeature
  | EndCapFeature
  | GussetFeature
  | WeldBeadFeature;

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
  /**
   * Elastic properties for stress analysis (all four, or none): elastic modulus,
   * yield and ultimate tensile strength in MPa, and Poisson's ratio.
   */
  E?: number;
  nu?: number;
  yield?: number;
  uts?: number;
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
  /** Machining: tools, setups and operations (see model/cam.ts), if any. */
  cam?: CamDoc | null;
  nextId: number;
  created: number;
  modified: number;
}

// ---- Drawings ----

export type SheetSize = 'A4' | 'A3' | 'A2' | 'A1' | 'Letter' | 'Tabloid' | 'ANSI C' | 'ANSI D';
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
  /**
   * What the view shows (absent: 'model', a standard view of the part from `kind`).
   * Projected, section and auxiliary views look at the part from beside their parent
   * view; a detail view magnifies a circle of its parent. For these, `kind` is only the
   * parent's kind at creation and the direction comes from the parent.
   */
  type?: DrawingViewType;
  /** The view this one was made from (projected, section, detail and auxiliary views). */
  parent?: Id;
  /** Projected views: on which side of the parent it is placed. */
  side?: DrawingSide;
  /**
   * Section and auxiliary views: the cutting (or folding) line on the parent, in the parent's
   * view coordinates (model millimetres, y down): [x1, y1, x2, y2]. The view lies on the side
   * of the line's left normal (direction (-(y2-y1), x2-x1) on paper with y down).
   */
  line?: [number, number, number, number];
  /** Detail views: the circle on the parent, in the parent's view coordinates [cx, cy, r]. */
  circle?: [number, number, number];
  /** Own scale (model and detail views); absent: the sheet's (a detail view: twice its parent's). */
  scale?: number;
  /** Letter of a section or detail view, or a caption replacing the view's label. */
  label?: string;
  /** Smooth (tangent) edges shown (absent: shown). */
  tangent?: boolean;
  /** Centre marks on circles seen end-on and centrelines of holes seen side-on (absent: off). */
  centerMarks?: boolean;
  /**
   * Where the view's geometry comes from (absent: this part). Assembly drawings name
   * 'assembly' (components where the mates put them) or 'assembly:exploded' (the exploded
   * view); see src/drawing/source.ts. A flat pattern view ('flat' type) uses the sheet
   * metal part's flat pattern instead.
   */
  source?: string;
}

export type DrawingViewType = 'model' | 'projected' | 'section' | 'detail' | 'auxiliary' | 'flat';
export type DrawingSide = 'left' | 'right' | 'above' | 'below';

/** A reference to model geometry seen in a view: a named model edge (as the kernel names them). */
export interface DrawingRef {
  /** Model edge name; an assembly source prefixes the component path. */
  edge: string;
  /** The edge itself, its start or end point, or the centre of a circle or arc. */
  at: 'edge' | 'start' | 'end' | 'center';
}

export type DrawingDimKind = 'horizontal' | 'vertical' | 'aligned' | 'radius' | 'diameter' | 'angle';

interface DrawingAnnotationBase {
  id: Id;
  /** The view it belongs to (it moves with the view and is deleted with it). */
  view?: Id;
}

/** A dimension measured from model geometry in a view: it follows the model as it changes. */
export interface DrawingDimension extends DrawingAnnotationBase {
  type: 'dimension';
  view: Id;
  kind: DrawingDimKind;
  /** One or two references (a line, a circle, two points, two lines...). */
  refs: DrawingRef[];
  /** Where the value sits, in the view's coordinates (model millimetres, y down). */
  at: [number, number];
  /** Decimal places (absent: the document's). */
  decimals?: number;
  /** Text before the value, e.g. "2X ". */
  prefix?: string;
}

/** Text on the sheet, with an optional leader arrow. */
export interface DrawingNote extends DrawingAnnotationBase {
  type: 'note';
  text: string;
  /** Text position: in the view's coordinates with a view, else in sheet millimetres. */
  at: [number, number];
  /** Arrow tip of the leader (same coordinates as `at`). */
  leader?: [number, number];
  /** Text height in sheet millimetres (absent: 3.5). */
  size?: number;
}

export interface DrawingCenterMark extends DrawingAnnotationBase {
  type: 'centerMark';
  view: Id;
  ref: DrawingRef;
}

/** A centreline midway between two parallel edges (the sides of a cylinder or slot). */
export interface DrawingCenterline extends DrawingAnnotationBase {
  type: 'centerline';
  view: Id;
  refs: [DrawingRef, DrawingRef];
}

/** Size and kind of the hole whose circle is referenced, with a leader. */
export interface DrawingHoleCallout extends DrawingAnnotationBase {
  type: 'holeCallout';
  view: Id;
  ref: DrawingRef;
  at: [number, number];
}

/**
 * Item balloon: a circle with the item number and a leader to an edge of a component (an
 * assembly drawing: its bill of materials row) or of a structural member (a weldment: its
 * cut list item).
 */
export interface DrawingBalloon extends DrawingAnnotationBase {
  type: 'balloon';
  view: Id;
  ref: DrawingRef;
  at: [number, number];
  /** Item number override (absent: the BOM row of the component the edge belongs to). */
  item?: number;
  /** Where the leader meets a straight edge, as a fraction of it from its start (absent: its middle). */
  t?: number;
}

/** Bill of materials table of a view's source (rows come from the source, so it follows the assembly). */
export interface DrawingBom extends DrawingAnnotationBase {
  type: 'bom';
  /** Top left corner on the sheet, in millimetres (with anchor 'bottomRight': its bottom right corner). */
  at: [number, number];
  /** The source whose rows it lists (absent: that of the first view). */
  source?: string;
  /** Which corner `at` is (absent: the top left); a table on the title block grows upward from it. */
  anchor?: 'bottomRight';
}

/** Cut list table of a weldment part (rows from the part's structural members as built). */
export interface DrawingCutList extends DrawingAnnotationBase {
  type: 'cutList';
  /** Top left corner on the sheet, in millimetres (with anchor 'bottomRight': its bottom right corner). */
  at: [number, number];
  anchor?: 'bottomRight';
}

export type DrawingAnnotation = DrawingDimension | DrawingNote | DrawingCenterMark | DrawingCenterline | DrawingHoleCallout | DrawingBalloon | DrawingBom | DrawingCutList;

export interface DrawingDoc {
  sheet: SheetSize;
  landscape: boolean;
  /** Model to paper scale, e.g. 0.5 for 1:2. */
  scale: number;
  views: DrawingView[];
  title: string;
  drawnBy: string;
  notes: string;
  /** Annotations: dimensions, notes, centre marks... (absent: none). */
  annotations?: DrawingAnnotation[];
  /** Projection angle of projected views and of the title block's symbol (absent: third angle). */
  projection?: 'third' | 'first';
  /**
   * The title block: 'full' adds the projection symbol, revision and sheet number
   * (absent: the basic one of drawings made before it existed).
   */
  titleBlock?: 'basic' | 'full';
  revision?: string;
}
