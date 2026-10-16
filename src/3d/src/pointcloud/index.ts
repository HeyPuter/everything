// Point clouds: Point Cloud objects (points with radii and attributes), drawn as spheres in the
// viewport and both render engines, with Edit Mode and geometry nodes interop. Imported for
// registration side effects from src/volume/index.ts.
import { DATA_ICON, DATA_TABLE, ID_GROUPS } from '../editors/outliner/tree';
import './eval';
import './display';
import './render';
import './ops';
import './edit';
import './properties';

DATA_ICON.POINTCLOUD = 'pointcloud_data';
DATA_TABLE.POINTCLOUD = 'pointclouds';
if (!ID_GROUPS.some((g) => g[1] === 'pointclouds')) {
  const at = ID_GROUPS.findIndex((g) => g[1] === 'particles');
  ID_GROUPS.splice(at < 0 ? ID_GROUPS.length : at + 1, 0, ['Point Clouds', 'pointclouds', 'pointcloud_data']);
}
export {};
