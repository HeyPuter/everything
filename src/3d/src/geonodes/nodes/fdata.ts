// Registers the interface data of the function/field/topology/input node families with the
// shared table used by `gn()`. Imported first by each family module.
import { GN_NODE_DATA } from '../data.gen';
import { GN_FIELD_NODE_DATA } from '../data-fields.gen';

for (const [k, v] of Object.entries(GN_FIELD_NODE_DATA)) if (!GN_NODE_DATA[k]) GN_NODE_DATA[k] = v;

export {};
