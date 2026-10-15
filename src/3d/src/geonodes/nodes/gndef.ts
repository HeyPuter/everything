// Compact definitions of geometry node types whose interface is written inline (zones, mesh
// operations, sampling and instance nodes).
import { registerNodeType } from '../../nodes/registry';
import type { NodeClass, NodePropDef, NodeTypeDef, SocketDef, SocketType } from '../../nodes/types';
import type { SocketValue } from '../../data/types';
import { registerExec, type GeoNodeExec } from '../exec';

export type NodeSpec = Partial<Omit<NodeTypeDef, 'idname' | 'label' | 'category'>> & {
  idname: string;
  label: string;
  category: NodeClass;
};

/** Register a geometry node type with its exec implementation. */
export function geoNode(spec: NodeSpec, exec: GeoNodeExec): NodeTypeDef {
  const def: NodeTypeDef = {
    treeTypes: ['GEOMETRY'],
    inputs: [],
    outputs: [],
    props: [],
    width: 140,
    ...spec,
  };
  registerNodeType(def);
  registerExec(def.idname, exec);
  return def;
}

type SockOpts = Partial<Omit<SocketDef, 'name' | 'type'>> & {
  id?: string;
  d?: SocketValue;
  field?: boolean;
  dot?: boolean;
};

/** Socket shorthand: identifier defaults to the name; `field` draws a diamond, `dot` a diamond with dot. */
export function sock(name: string, type: SocketType, o: SockOpts = {}): SocketDef {
  const { id, d, field, dot, ...rest } = o;
  const s: SocketDef = { name, identifier: id ?? name, type, ...rest };
  if (d !== undefined) s.default = d;
  if (field) s.shape = 'DIAMOND';
  if (dot) s.shape = 'DIAMOND_DOT';
  return s;
}

export const geo = (name: string, o: SockOpts = {}) => sock(name, 'GEOMETRY', o);
/** Field selection input (hidden value, default true). */
export const selection = (name = 'Selection') => sock(name, 'BOOLEAN', { d: true, hide_value: true, field: true });

export function enumProp(id: string, name: string, items: [string, string][], d = items[0][0], o: Partial<NodePropDef> = {}): NodePropDef {
  return { id, name, type: 'ENUM', items, d, noLabel: true, ...o };
}

export const ATTRIBUTE_TYPE_ITEMS: [string, string][] = [
  ['FLOAT', 'Float'],
  ['INT', 'Integer'],
  ['BOOLEAN', 'Boolean'],
  ['FLOAT_VECTOR', 'Vector'],
  ['FLOAT_COLOR', 'Color'],
  ['QUATERNION', 'Rotation'],
];
