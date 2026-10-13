// Messages exchanged with the geometry worker. Mesh arrays are transferred
// (not copied) to keep large models cheap to update.

import type { Frame, Vec3 } from '../math/vec';
import type { Feature, Id } from '../model/types';

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
}

export interface BuildResult {
  mesh: MeshData | null;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  status: FeatureStatus[];
  /** Resolved frames of sketches and reference planes. */
  frames: Record<Id, Frame>;
  /** Resolved axes used by features (for display). */
  bbox: { min: Vec3; max: Vec3 } | null;
  /** Milliseconds spent building (excluding cached steps). */
  ms: number;
  /** Preview tool body for the feature being edited. */
  preview: MeshData | null;
  /** 'tool': draw over the body; 'body': replaces the body while editing. */
  previewKind?: 'tool' | 'body';
  previewError?: string;
}

export interface MassProperties {
  volume: number;
  area: number;
  center: Vec3;
  /** Inertia tensor about the centre of mass (per unit density), row-major 3x3. */
  inertia: number[];
  principal: { moments: Vec3; axes: [Vec3, Vec3, Vec3] };
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
}

export interface ProjectionResult {
  id: string;
  /** SVG path data in model millimetres, y pointing down. */
  visible: string[];
  hidden: string[];
  /** [minX, minY, maxX, maxY] of the visible lines (y down). */
  bounds: [number, number, number, number] | null;
}

export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'reset' }
  | { id: number; type: 'build'; req: BuildRequest }
  | { id: number; type: 'mass' }
  | { id: number; type: 'project'; views: ProjectionRequest[] }
  | { id: number; type: 'measure'; a: MeasureTarget; b: MeasureTarget }
  | { id: number; type: 'export'; format: 'step' | 'stl' | 'brep'; quality: number }
  | { id: number; type: 'checkImport'; format: 'step'; text: string }
  | { id: number; type: 'convertSolidWorks'; data: Uint8Array; name: string };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
