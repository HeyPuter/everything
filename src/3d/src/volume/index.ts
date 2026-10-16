// Volumes: Volume objects holding voxel grids (OpenVDB import, geometry nodes, Mesh to Volume),
// their viewport display, properties, modifiers and rendering. Imported for registration side
// effects from src/modules.ts.
import { OB_ICON, DATA_ICON, DATA_TABLE, ID_GROUPS } from '../editors/outliner/tree';
import './icons';
import './eval';
import './display';
import './ops';
import './properties';
import './modifiers';
import './render';
import '../render/final/ptsss';
import '../pointcloud/index';
import './geonodes';

OB_ICON.VOLUME = 'outliner_ob_volume';
DATA_ICON.VOLUME = 'volume_data';
DATA_TABLE.VOLUME = 'volumes';
if (!ID_GROUPS.some((g) => g[1] === 'volumes')) {
  const at = ID_GROUPS.findIndex((g) => g[1] === 'texts');
  ID_GROUPS.splice(at < 0 ? ID_GROUPS.length : at + 1, 0, ['Volumes', 'volumes', 'volume_data']);
}
export {};
