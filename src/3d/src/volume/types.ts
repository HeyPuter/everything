// Volume data: named voxel grids stored densely (x fastest, then y, then z). Stored in
// `doc.volumes`; objects of type 'VOLUME' point to it. Grids come from imported OpenVDB files,
// geometry nodes, the Mesh to Volume modifier or fluid domains.
import type { ID } from '../data/types';

/** Value type of a grid (bpy names). */
export type GridDataType = 'FLOAT' | 'VECTOR_FLOAT' | 'INT' | 'BOOLEAN' | 'MASK';

/** How a grid's values are meant: a fog (density) volume or a signed distance field. */
export type GridClass = 'FOG_VOLUME' | 'LEVEL_SET' | 'UNKNOWN';

/**
 * A dense voxel grid. Voxel (i, j, k) has its centre at `transform · (i, j, k, 1)` in object
 * space (`transform` maps index space to object space, column-major 4×4), so the grid covers
 * index space [-0.5, dims - 0.5] on every axis.
 */
export interface VolumeGrid {
  name: string;
  data_type: GridDataType;
  grid_class: GridClass;
  dims: [number, number, number];
  transform: number[];
  /** `dims[0]·dims[1]·dims[2]·channels` values */
  values: Float32Array;
  /** value outside the stored voxels */
  background: number;
}

export interface VolumeDisplay {
  /** viewport density multiplier */
  density: number;
  wireframe_type: 'NONE' | 'BOUNDS' | 'BOXES' | 'POINTS';
  wireframe_detail: 'COARSE' | 'FINE';
  interpolation_method: 'LINEAR' | 'CUBIC' | 'CLOSEST';
  use_slice: boolean;
  slice_axis: 'AUTO' | 'X' | 'Y' | 'Z';
  slice_depth: number;
}

export interface VolumeRender {
  precision: 'FULL' | 'HALF' | 'VARIABLE';
  /** step sizes are given in object or world space */
  space: 'OBJECT' | 'WORLD';
  /** ray marching step (0: automatic from the voxel size) */
  step_size: number;
  /** values below this are treated as empty space */
  clipping: number;
}

export interface VolumeData {
  id: ID;
  name: string;
  /** name of the file the grids were imported from ('' for generated volumes) */
  filepath: string;
  /** grids stored in the project */
  grids: VolumeGrid[];
  active_grid_index: number;
  display: VolumeDisplay;
  render: VolumeRender;
  /** grid read as the velocity for motion blur */
  velocity_grid: string;
  velocity_scale: number;
  materials: (ID | null)[];
  users?: number;
  use_fake_user?: boolean;
}

/** Channels per voxel of a grid type. */
export const gridChannels = (t: GridDataType) => (t === 'VECTOR_FLOAT' ? 3 : 1);
