// Neutral intermediate representation shared by the interchange importers.
// Importers (glTF, FBX, USD, Collada, ...) describe a scene in their *source* coordinate
// system; `commitScene` (to-document.ts) converts it into document objects (Z-up, meters).
// Matrices are column-major 4x4 arrays (three.js `Matrix4.elements` layout).

export type M4 = number[];

export interface IRScene {
  /** Source → document axis conversion (3x3 rotation, row-major), applied as a change of basis. */
  axis: number[];
  /** Multiplies all distances (e.g. 0.01 for centimeters). */
  unitScale: number;
  /**
   * 'BAKE' (default): conjugate every node by the axis conversion and scale vertex data
   * (glTF/USD style: identity rotations stay identity). 'ROOT': apply the axis and unit conversion
   * as a global matrix on root nodes only and keep local data untouched (FBX style, so files
   * written by DCC exporters that baked the conversion into roots round-trip cleanly).
   */
  unitScaleMode?: 'BAKE' | 'ROOT';
  nodes: IRNode[];
  meshes: IRMesh[];
  materials: IRMaterial[];
  images: IRImage[];
  skins: IRSkin[];
  animations: IRAnimation[];
  /** frames per second used to convert animation times (seconds) into frames */
  fps?: number;
  warnings: string[];
}

export interface IRNode {
  name: string;
  /** index of the parent node or -1 */
  parent: number;
  /** local matrix in source space */
  matrix: M4;
  mesh?: number;
  /** skin index (glTF semantics: vertices are in bind space, node transform ignored) */
  skin?: number;
  camera?: IRCamera;
  light?: IRLight;
  /**
   * For cameras/lights: matrix mapping the canonical camera/light frame (looks down -Z,
   * +Y up) into the node's local frame, in source space. Identity for glTF/USD.
   */
  attachCorrection?: M4;
  /** default morph target weights */
  morphWeights?: number[];
  /** per-object material overrides per slot (null = keep mesh material) */
  hidden?: boolean;
  /** skeleton node (FBX LimbNode, USD joint): becomes a bone when it belongs to an armature */
  isBone?: boolean;
  /** bone length hint (source units) when the format stores it */
  boneLength?: number;
  extras?: Record<string, number | string | boolean>;
}

export interface IRColorLayer {
  name: string;
  domain: 'POINT' | 'CORNER';
  /** linear RGBA */
  data: Float32Array;
}

export interface IRMesh {
  name: string;
  /** xyz per vertex, source space */
  positions: Float32Array;
  /** corner count per face */
  faceSizes: Uint32Array;
  /** vertex index per corner */
  indices: Uint32Array;
  /** uv per corner (bottom-left origin) */
  uvs?: Float32Array;
  /** additional UV layers are dropped (the document holds one UV map) */
  uvName?: string;
  /** normal per corner (source space); used to derive smooth/flat shading */
  normals?: Float32Array;
  /** explicit per-face smooth flags (OBJ 's', FBX smoothing) — overrides normals detection */
  smooth?: Uint8Array;
  /** per-face material slot */
  materialIndex?: Uint16Array;
  /** material slots → IR material index (or -1 for empty) */
  materials: number[];
  colors?: IRColorLayer[];
  /** vertex groups: names and per-vertex weights (dense) */
  groups?: { names: string[]; weights: Float32Array[] };
  /** absolute positions per shape key (source space) */
  shapeKeys?: { name: string; positions: Float32Array }[];
  /** loose edges (vertex pairs) — dropped with a warning */
  looseEdges?: number;
}

export interface IRTexRef {
  image: number;
  /** KHR_texture_transform-style UV transform */
  offset?: [number, number];
  rotation?: number;
  scale?: [number, number];
  interpolation?: 'Linear' | 'Closest';
  extension?: 'REPEAT' | 'EXTEND' | 'MIRROR' | 'CLIP';
  /** which channel feeds the socket (for packed textures) */
  channel?: 'R' | 'G' | 'B' | 'A' | 'RGB';
}

export interface IRMaterial {
  name: string;
  baseColor: [number, number, number, number];
  baseColorTex?: IRTexRef;
  metallic: number;
  roughness: number;
  /** glTF packing: G = roughness, B = metallic */
  metallicRoughnessTex?: IRTexRef;
  metallicTex?: IRTexRef;
  roughnessTex?: IRTexRef;
  normalTex?: IRTexRef & { strength?: number };
  /** grayscale bump/height map (OBJ map_Bump without normal-map semantics) */
  bumpTex?: IRTexRef & { strength?: number };
  emissive?: [number, number, number];
  emissiveStrength?: number;
  emissiveTex?: IRTexRef;
  occlusionTex?: IRTexRef;
  alphaTex?: IRTexRef;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided?: boolean;
  transmission?: number;
  transmissionTex?: IRTexRef;
  ior?: number;
  specular?: number;
  specularTint?: [number, number, number];
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheenColor?: [number, number, number];
  sheenRoughness?: number;
  /** multiply base color by the mesh's first color attribute */
  useVertexColor?: boolean;
  unlit?: boolean;
}

export interface IRImage {
  name: string;
  mime: string;
  bytes: Uint8Array | null;
  /** original file path / URI for reporting */
  uri?: string;
  colorspace?: 'sRGB' | 'Non-Color';
}

export interface IRCamera {
  type: 'PERSP' | 'ORTHO';
  /** vertical field of view (radians) — glTF style */
  yfov?: number;
  /** focal length (mm) + sensor (mm) — DCC style */
  lens?: number;
  sensorWidth?: number;
  sensorHeight?: number;
  sensorFit?: 'AUTO' | 'HORIZONTAL' | 'VERTICAL';
  /** full orthographic width (document units after unit scale) */
  orthoScale?: number;
  clipStart?: number;
  clipEnd?: number;
  /** clip distances are in source units and should be scaled by unitScale */
  scaleClip?: boolean;
  shiftX?: number;
  shiftY?: number;
}

export interface IRLight {
  type: 'POINT' | 'SUN' | 'SPOT' | 'AREA';
  color: [number, number, number];
  /** document units: W (point/spot/area) or W/m² (sun) */
  energy: number;
  /** full cone angle (radians) */
  spotSize?: number;
  spotBlend?: number;
  radius?: number;
  size?: number;
  sizeY?: number;
  shape?: 'SQUARE' | 'RECTANGLE' | 'DISK' | 'ELLIPSE';
  range?: number;
  castShadow?: boolean;
}

export interface IRSkin {
  name: string;
  joints: number[];
  /** maps mesh-space (bind) vertices into joint space, per joint, source space */
  inverseBind: M4[];
}

export type IRInterp = 'LINEAR' | 'STEP' | 'CUBICSPLINE';

export interface IRChannel {
  node: number;
  path: 'translation' | 'rotation' | 'scale' | 'weights' | 'matrix';
  /** seconds */
  times: Float32Array | number[];
  /** translation/scale: 3, rotation: 4 (xyzw), weights: n, matrix: 16 — per key (x3 for CUBICSPLINE: in, value, out) */
  values: Float32Array | number[];
  interpolation: IRInterp;
}

export interface IRAnimation {
  name: string;
  channels: IRChannel[];
}

export function emptyScene(): IRScene {
  return { axis: [1, 0, 0, 0, 1, 0, 0, 0, 1], unitScale: 1, nodes: [], meshes: [], materials: [], images: [], skins: [], animations: [], warnings: [] };
}

export const IDENTITY16: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Y-up (glTF) → Z-up: x→x, y→z, z→-y (rotation of +90° about X). Row-major 3x3. */
export const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, -1, 0, 1, 0];

export function defaultMaterial(name = 'Material'): IRMaterial {
  return { name, baseColor: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.5 };
}
