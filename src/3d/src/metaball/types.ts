// Metaball data: implicit surfaces built from a set of field elements.
import type { ID, Vec3, Vec4 } from '../data/types';

export type MetaElementType = 'BALL' | 'CAPSULE' | 'PLANE' | 'ELLIPSOID' | 'CUBE';

export interface MetaElement {
  type: MetaElementType;
  /** centre in object space */
  co: Vec3;
  /** orientation quaternion (w, x, y, z) */
  rotation: Vec4;
  /** influence radius */
  radius: number;
  /** field strength */
  stiffness: number;
  /** half extents of capsules / planes / cubes, axis scale of ellipsoids */
  size_x: number;
  size_y: number;
  size_z: number;
  /** subtracts its field instead of adding it */
  use_negative: boolean;
  hide?: boolean;
  select?: boolean;
}

export interface MetaballData {
  id: ID;
  name: string;
  /** polygonization cell size in the viewport (object units) */
  resolution: number;
  /** polygonization cell size for final renders */
  render_resolution: number;
  /** field value of the surface */
  threshold: number;
  update_method: 'UPDATE_ALWAYS' | 'HALFRES' | 'FAST' | 'NEVER';
  elements: MetaElement[];
  materials: (ID | null)[];
  /** index of the active element (-1 for none) */
  active_element?: number;
  users?: number;
  use_fake_user?: boolean;
}
