// Hair: Curves objects (strands attached to a mesh surface) with Edit Mode and Sculpt Curves
// mode, plus Particle Edit mode for hair particle systems. Imported for registration side
// effects from src/modules.ts.
import { OB_ICON, DATA_ICON, DATA_TABLE, ID_GROUPS } from '../editors/outliner/tree';
import './icons';
import './eval';
import './display';
import './render';
import './add';

OB_ICON.CURVES = 'outliner_ob_curves';
DATA_ICON.CURVES = 'curves_data';
DATA_TABLE.CURVES = 'hair_curves';
if (!ID_GROUPS.some((g) => g[1] === 'hair_curves')) {
  const at = ID_GROUPS.findIndex((g) => g[1] === 'grease_pencils');
  ID_GROUPS.splice(at < 0 ? ID_GROUPS.length : at + 1, 0, ['Hair Curves', 'hair_curves', 'curves_data']);
}
export {};
