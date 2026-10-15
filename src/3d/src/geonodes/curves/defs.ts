// Registration helpers of the curve node family: merges this family's interface data into the
// geometry node table before nodes are defined, and places nodes in the Add menu.
import { GN_NODE_DATA } from '../data.gen';
import { CURVE_NODE_DATA } from './data';
import { gn as gnBase, type GnOptions } from '../nodes/defs';
import type { GeoNodeExec } from '../exec';
import type { NodeClass, NodeTypeDef } from '../../nodes/types';

for (const [k, v] of Object.entries(CURVE_NODE_DATA)) if (!GN_NODE_DATA[k]) GN_NODE_DATA[k] = v;

export function gn(idname: string, category: NodeClass, exec: GeoNodeExec, opts: GnOptions = {}): NodeTypeDef {
  return gnBase(idname, category, exec, opts);
}

export { prop, sprop } from '../nodes/defs';
