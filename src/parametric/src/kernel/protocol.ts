// Messages exchanged with the geometry worker. Mesh arrays are transferred
// (not copied) to keep large models cheap to update.

import type { Frame, Vec3 } from '../math/vec';
import type { Feature, Id, SkEntity } from '../model/types';
import type { FlatPattern } from '../model/flat-pattern';
import type { WeldMemberInfo } from '../model/weldments';
import type { AsmRequest } from './assembly';

/** Features with every Param already evaluated to a number. */
export type ResolvedFeature = Feature;

export interface BuildRequest {
  features: ResolvedFeature[];
  /** Number of features to build (rollback position). */
  upTo: number;
  /** Large payloads referenced by import features. */
  blobs: Record<Id, string>;
  /** Mesh quality: 0 coarse, 1 normal, 2 fine. */
  quality: number;
  /**
   * Features with a value whose expression could not be evaluated, with the
   * message. They fail without building (their values stand at zero).
   */
  invalid?: Record<Id, string>;
  /** Optional preview: build this feature on top of the result without caching. */
  preview?: ResolvedFeature | null;
}

export interface FaceInfo {
  name: string;
  type: string;
  center: Vec3;
  area: number;
  /** Planar faces: outward normal and a frame suitable for sketching. */
  normal?: Vec3;
  frame?: Frame;
  /** Cylindrical/conical/spherical faces: axis and radius. */
  axis?: { p: Vec3; d: Vec3 };
  radius?: number;
  /** Feature that last named this face. */
  feature: Id;
  /** The surface body the face is on (a surface feature's id); absent for faces of the solid. */
  body?: Id;
}

export interface EdgeInfo {
  name: string;
  type: string;
  a: Vec3;
  b: Vec3;
  mid: Vec3;
  length: number;
  faces: number[];
  /** Line edges: direction. Circular edges: centre, axis and radius. */
  dir?: Vec3;
  center?: Vec3;
  axis?: Vec3;
  radius?: number;
  /** The surface body the edge is on; absent for edges of the solid. */
  body?: Id;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Face index of every vertex. */
  vertexFace: Float32Array;
  /** Pairs of points, one segment per pair. */
  edgePositions: Float32Array;
  /** Edge index of every segment end point. */
  edgeIds: Float32Array;
  /** Unique topological vertices. */
  vertices: Float32Array;
}

export interface FeatureStatus {
  id: Id;
  ok: boolean;
  error?: string;
  warning?: string;
  /** Not built: suppressed, or built on a suppressed feature. */
  suppressed?: boolean;
}

export interface BuildResult {
  mesh: MeshData | null;
  /** The body's mesh is the one sent with the previous result (mesh is then null). */
  meshUnchanged?: boolean;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  status: FeatureStatus[];
  /** Resolved frames of sketches and reference planes. */
  frames: Record<Id, Frame>;
  /** Resolved axes used by features (for display). */
  bbox: { min: Vec3; max: Vec3 } | null;
  /**
   * Sketches with geometry projected from the model, as built: projected
   * entities moved onto their model edges and the sketch solved again. `lost`
   * lists projected entities whose edge or vertex is gone.
   */
  sketches?: Record<Id, { entities: SkEntity[]; lost: Id[] }>;
  /** Milliseconds spent building (excluding cached steps). */
  ms: number;
  /** Preview tool body for the feature being edited. */
  preview: MeshData | null;
  /** 'tool': draw over the body; 'body': replaces the body while editing. */
  previewKind?: 'tool' | 'body';
  previewError?: string;
  /** Non-fatal problem of the previewed feature (a cut that removes nothing...). */
  previewWarning?: string;
  /** Bytes of WebAssembly memory the kernel holds after the build (it never shrinks). */
  heap?: number;
  /** Set when there are surface bodies: their faces and edges follow the solid's from these indices. */
  surfaces?: { face: number; edge: number };
  /** Structural members as built (weldment parts only), for the cut list. */
  weldments?: WeldMemberInfo[];
}

/** The flat pattern of a sheet metal part, and the solid showing it (placed on the part's base flange). */
export interface FlatPatternResult {
  pattern: FlatPattern | null;
  error?: string;
  mesh: MeshData | null;
}

export interface MassProperties {
  /**
   * The body has closed solid volume. Without it (only surfaces) there is no
   * mass, centre of mass or inertia to report: those values are zero.
   */
  solid: boolean;
  volume: number;
  area: number;
  center: Vec3;
  /** Inertia tensor about the centre of mass (per unit density), row-major 3x3. */
  inertia: number[];
  principal: { moments: Vec3; axes: [Vec3, Vec3, Vec3] };
  /** Area of the surface bodies (not part of the solid's volume or area), when there are any. */
  surfaceArea?: number;
}

export type MeasureTarget =
  | { kind: 'face'; index: number }
  | { kind: 'edge'; index: number }
  | { kind: 'vertex'; p: Vec3 };

export interface MeasureResult {
  distance: number;
  p1: Vec3;
  p2: Vec3;
}

export interface ProjectionRequest {
  id: string;
  /** Direction from the model toward the viewer. */
  dir: Vec3;
  /** Paper x axis in model space. */
  x: Vec3;
  /** Whether to find the hidden lines too (default true). */
  hidden?: boolean;
  /** Whether to draw smooth (tangent) edges (default true). */
  smooth?: boolean;
  /**
   * Section views: the body is cut by the plane through p with normal n, and only
   * the part n points to ((x - p) . n >= 0) is projected.
   */
  section?: { p: Vec3; n: Vec3 };
}

export interface ProjectionResult {
  id: string;
  /** SVG path data in model millimetres, y pointing down. */
  visible: string[];
  hidden: string[];
  /** [minX, minY, maxX, maxY] of the visible lines (y down). */
  bounds: [number, number, number, number] | null;
  /** Section views: outlines of the cut faces, polylines [x0, y0, x1, y1, ...] in the same coordinates. */
  cut?: number[][];
  /** Assembly section views: which component each cut outline belongs to (each is hatched its own way). */
  cutGroups?: number[];
}

export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'reset' }
  /**
   * req.blobs holds only file data the worker does not have yet; `blobs`
   * lists every id still in use (the worker drops the rest).
   */
  | { id: number; type: 'build'; req: BuildRequest; blobs: Id[] }
  | { id: number; type: 'mass' }
  | { id: number; type: 'flatPattern'; quality: number }
  | { id: number; type: 'project'; views: ProjectionRequest[] }
  | { id: number; type: 'measure'; a: MeasureTarget; b: MeasureTarget }
  | { id: number; type: 'export'; format: 'step' | 'stl' | 'brep'; quality: number; name?: string }
  | { id: number; type: 'checkImport'; format: 'step'; text: string }
  | { id: number; type: 'convertSolidWorks'; data: Uint8Array; name: string }
  /** Assemblies: building their parts and the placed components (see assembly.ts). */
  | { id: number; type: 'asm'; req: AsmRequest }
  /** Development builds only: fail on purpose to test recovery. */
  | { id: number; type: 'debugFail'; mode: 'hang' | 'abort' | 'crash' };

export type WorkerResponse =
  /** heap: bytes of WebAssembly memory after the request (assembly requests; builds report it in their result). */
  | { id: number; ok: true; result: unknown; heap?: number }
  /** fatal: the OpenCascade module aborted and the worker must be replaced. */
  | { id: number; ok: false; error: string; fatal?: boolean };
