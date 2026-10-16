// Point cloud data: a set of points with a radius and any number of generic point attributes.
// Stored in `doc.pointclouds`; objects of type 'POINTCLOUD' point to it.
import type { ID } from '../data/types';
import type { AttrArray, DataType } from '../geonodes/types';

/** A point attribute. Built-in ones: `radius` (FLOAT), `.selection` (BOOLEAN, Edit Mode). */
export interface PointCloudAttribute {
  name: string;
  data_type: DataType;
  data: AttrArray;
}

export interface PointCloudData {
  id: ID;
  name: string;
  /** object space, xyz per point */
  positions: Float32Array;
  attributes: PointCloudAttribute[];
  /** index into `attributes` of the active attribute (-1 for none) */
  active_attribute?: number;
  materials: (ID | null)[];
  users?: number;
  use_fake_user?: boolean;
}
