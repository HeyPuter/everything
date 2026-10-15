import type { Matrix4 } from 'three';
import type { DocumentData, ModifierBase, ObjectData, Constraint, MeshData } from '../data/types';
import type { Depsgraph } from './depsgraph';

/** Evaluated mesh: same layout as MeshData's geometry arrays. */
export interface EvalMesh {
  positions: Float32Array;
  offsets: Uint32Array;
  indices: Uint32Array;
  uvs: Float32Array;
  normals: Float32Array; // flat, per corner (tool compatible)
  /** custom split normals per corner (e.g. Weighted Normal modifier); overrides computed shading normals */
  custom_normals?: Float32Array;
  /** per face: quads split along the other diagonal */
  quad_flip?: Uint8Array;
  /** per face strength (0 weak, 1 medium, 2 strong) */
  face_strength?: Uint8Array;
  smooth?: Uint8Array;
  material_index?: Uint16Array;
  seams?: Uint32Array;
  sharp?: Uint32Array;
  creases?: Float32Array;
  /** vertex colors per corner RGBA (active color attribute) */
  colors?: Float32Array;
  /** per-vertex weights for each vertex group (aligned with MeshData.vertex_groups) */
  weights?: Float32Array[];
  vertex_groups?: { name: string }[];
  auto_smooth_angle?: number;
  /** For each evaluated vertex, the source vertex it derives from (or -1). */
  origIndex?: Int32Array;
  /** Loose edges (pairs) to draw as wires (e.g. from wireframe-only output). */
  looseEdges?: Uint32Array;
  /** Point cloud (vertices without faces) radii, e.g. from geometry nodes */
  pointRadius?: Float32Array;
  /** Instances produced by geometry nodes / particles */
  instances?: GeometryInstance[];
  /** Curves (polylines) to draw as wires */
  curves?: { points: Float32Array; cyclic: boolean }[];
}

export interface GeometryInstance {
  mesh?: EvalMesh;
  objectId?: string;
  matrix: number[]; // relative to owner
  materialIds?: (string | null)[];
}

export interface ModifierContext {
  doc: DocumentData;
  ob: ObjectData;
  graph: Depsgraph;
  frame: number;
  /** Source mesh data (for vertex groups etc) */
  source: MeshData | null;
  editMode: boolean;
  render: boolean;
}

export interface ModifierType {
  type: string;
  label: string;
  category: 'EDIT' | 'GENERATE' | 'DEFORM' | 'NORMALS' | 'PHYSICS' | 'COLOR';
  icon: string;
  /** object types the modifier can be added to (default: meshes, curves, text, lattices) */
  objectTypes?: string[];
  defaults: () => Record<string, unknown>;
  /** Object ids this modifier depends on (targets) */
  deps?: (m: ModifierBase) => (string | null | undefined)[];
  apply: (mesh: EvalMesh, m: ModifierBase, ctx: ModifierContext) => EvalMesh;
  /** Whether output depends on scene time */
  timeDependent?: (m: ModifierBase) => boolean;
  /** Extra evaluation signature (inputs not stored on the modifier itself, e.g. physics settings/cache state) */
  signature?: (m: ModifierBase, ctx: { doc: DocumentData; ob: ObjectData; graph: Depsgraph; frame: number }) => string;
  /** Deform-only modifiers keep topology (cage mapping is preserved) */
  deformOnly?: boolean;
  supportsEditMode?: boolean;
}

export interface ConstraintContext {
  doc: DocumentData;
  graph: Depsgraph;
  ob: ObjectData;
  frame: number;
  /** Set when the owner is a pose bone (bone constraints). */
  pchan?: BoneOwner;
  /** Target matrix converted to the constraint's target space (set by the solver; null when the target is missing). */
  target?: Matrix4 | null;
  /** World matrix of a target object/bone, taking the pose being evaluated into account. */
  targetWorld?: (id: string | null | undefined, bone?: string, headTail?: number) => Matrix4 | null;
}

/** Pose bone owner of a constraint: the armature pose being evaluated. */
export interface BoneOwner {
  name: string;
  bones: Map<string, import('./armature').BoneEval>;
  arm: import('../data/types').ArmatureData;
  /** world matrix of the armature object */
  armWorld: Matrix4;
}

export interface ConstraintType {
  type: string;
  label: string;
  category: 'MOTION_TRACKING' | 'TRANSFORM' | 'TRACKING' | 'RELATIONSHIP';
  defaults: () => Record<string, unknown>;
  /** Mutates `owner` (the owner's matrix in the constraint's owner space) in place. */
  apply: (owner: Matrix4, c: Constraint, ctx: ConstraintContext) => void;
  /** Extra objects (besides `target`) that must be evaluated before the owner */
  deps?: (c: Constraint, doc: DocumentData) => (string | null | undefined)[];
  /** Only available on pose bones (solved by the armature evaluation). */
  boneOnly?: boolean;
  /** Owner/target space conversion: which spaces the constraint offers (default none: always world space). */
  spaces?: { owner?: boolean; target?: boolean };
  /** The standard `target` (+ bone subtarget) is resolved by the solver into `ctx.target`. */
  usesTarget?: boolean;
  /** The target's evaluated geometry is read (it must be evaluated before the owner). */
  needsTargetData?: boolean;
  /** Whether the constraint can do something with its current settings (invalid ones are drawn in red). */
  isValid?: (c: Constraint, ctx: { doc: DocumentData; ob: ObjectData; bone?: string }) => boolean;
}
