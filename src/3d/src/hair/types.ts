// Hair curves data: a set of curves (each a run of control points) usually grown from the
// surface of a mesh object. Stored in `doc.hair_curves`; objects of type 'CURVES' point to it.
import type { ID } from '../data/types';
import type { AttrArray, DataType } from '../geonodes/types';

export type HairDomain = 'POINT' | 'CURVE';

/** A generic attribute. Built-in ones: `radius` (POINT), `.selection` (POINT / CURVE float),
 *  `surface_uv_coordinate` (CURVE FLOAT2), `curve_type` / `resolution` / `cyclic` (CURVE). */
export interface HairAttribute {
  name: string;
  domain: HairDomain;
  data_type: DataType;
  data: AttrArray;
}

export interface HairCurvesData {
  id: ID;
  name: string;
  /** control points (object space), xyz per point */
  positions: Float32Array;
  /** first point of every curve plus the total point count (curve count + 1 entries) */
  curve_offsets: Uint32Array;
  attributes: HairAttribute[];
  /** index into `attributes` of the active attribute (-1 for none) */
  active_attribute?: number;
  /** mesh object the curves are attached to */
  surface: ID | null;
  /** UV map of the surface used to (re)attach curve roots */
  surface_uv_map: string;
  /** what selection tools and sculpt selection masks act on */
  selection_domain: HairDomain;
  use_mirror_x: boolean;
  use_mirror_y: boolean;
  use_mirror_z: boolean;
  /** keep sculpted curves outside the surface */
  use_sculpt_collision: boolean;
  materials: (ID | null)[];
  users?: number;
  use_fake_user?: boolean;
}

/** Per-brush settings of Sculpt Curves mode (tool_settings.curves_sculpt.brushes[tool]). */
export interface CurvesBrush {
  /** radius in pixels */
  size: number;
  strength: number;
  falloff: 'SMOOTH' | 'SPHERE' | 'ROOT' | 'SHARP' | 'LINEAR' | 'CONSTANT';
  direction?: 'ADD' | 'SUBTRACT';
  /** Add / Density: curves added per dab */
  add_amount?: number;
  /** Add: interpolate the new curves from neighbours */
  use_length_interpolate?: boolean;
  use_radius_interpolate?: boolean;
  use_shape_interpolate?: boolean;
  use_point_count_interpolate?: boolean;
  /** Add: shape of new curves when not interpolated */
  curve_length?: number;
  curve_radius?: number;
  points_per_curve?: number;
  interpolation_neighbors?: number;
  /** Density: minimum distance between roots */
  minimum_distance?: number;
  density_mode?: 'AUTO' | 'ADD' | 'REMOVE';
  density_add_attempts?: number;
  /** Grow / Shrink */
  use_uniform_scale?: boolean;
  minimum_length?: number;
  /** Selection Paint: selection value painted */
  selection_value?: number;
}

export interface CurvesSculptSettings {
  brushes: Record<string, CurvesBrush>;
  /** a curve's whole length is weighted by the falloff (Comb, Puff, Smooth) */
  curve_parameter_falloff?: number;
}
