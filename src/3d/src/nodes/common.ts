// Node types shared by every tree kind: Frame, Reroute, Group Input/Output and group nodes.
import type { NodeData } from '../data/types';
import { registerNodeType, interfaceSockets, findSocket, interfacePanels } from './registry';
import type { NodeTypeDef, SocketContext, SocketDef, TreeType } from './types';

export const ALL_TREES: TreeType[] = ['SHADER', 'WORLD', 'GEOMETRY', 'COMPOSITOR'];

/** Virtual socket on group input/output nodes: linking to it adds an interface socket. */
export const EXTEND_SOCKET = '__extend__';
const extendSocket: SocketDef = {
  name: '',
  identifier: EXTEND_SOCKET,
  type: 'CUSTOM',
  hide_value: true,
};

registerNodeType({
  idname: 'NodeFrame',
  label: 'Frame',
  category: 'layout',
  treeTypes: ALL_TREES,
  inputs: [],
  outputs: [],
  props: [
    {
      id: 'label_size',
      name: 'Label Size',
      type: 'INT',
      d: 20,
      min: 8,
      max: 64,
      inNode: false,
    },
    { id: 'shrink', name: 'Shrink', type: 'BOOLEAN', d: true, inNode: false },
  ],
  width: 150,
  layout: 'FRAME',
  description: 'Collect related nodes together in a common area',
});

/** Resolve the data type flowing into a reroute (follows chains of reroutes). */
export function rerouteType(node: NodeData, ctx: SocketContext | undefined, depth = 0): SocketDef['type'] {
  if (!ctx || depth > 64) return 'CUSTOM';
  const link = ctx.tree.links.find((l) => l.to_node === node.id);
  if (link) {
    const from = ctx.tree.nodes.find((n) => n.id === link.from_node);
    if (from) {
      if (from.type === 'NodeReroute') return rerouteType(from, ctx, depth + 1);
      const s = findSocket(from, link.from_socket, true, ctx);
      if (s) return s.type;
    }
  }
  const out = ctx.tree.links.find((l) => l.from_node === node.id);
  if (out) {
    const to = ctx.tree.nodes.find((n) => n.id === out.to_node);
    if (to && to.type !== 'NodeReroute') {
      const s = findSocket(to, out.to_socket, false, ctx);
      if (s) return s.type;
    }
  }
  return 'CUSTOM';
}

registerNodeType({
  idname: 'NodeReroute',
  label: 'Reroute',
  category: 'layout',
  treeTypes: ALL_TREES,
  inputs: [{ name: 'Input', identifier: 'Input', type: 'CUSTOM', hide_value: true }],
  outputs: [{ name: 'Output', identifier: 'Output', type: 'CUSTOM' }],
  props: [],
  width: 16,
  layout: 'REROUTE',
  dynamicSockets: (node, ctx) => {
    const type = rerouteType(node, ctx);
    return {
      inputs: [{ name: 'Input', identifier: 'Input', type, hide_value: true }],
      outputs: [{ name: 'Output', identifier: 'Output', type }],
    };
  },
  description: 'A single-socket organization tool that supports one input and multiple outputs',
});

registerNodeType({
  idname: 'NodeGroupInput',
  label: 'Group Input',
  category: 'interface',
  treeTypes: ALL_TREES,
  inputs: [],
  outputs: [],
  props: [],
  width: 140,
  hidden: true,
  dynamicSockets: (_node, ctx) => ({
    inputs: [],
    outputs: [
      ...interfaceSockets(ctx.tree, 'INPUT').map((s) => ({
        ...s,
        hide_value: true,
      })),
      extendSocket,
    ],
  }),
  description: 'Expose connected data from inside a node group as inputs to its interface',
});

registerNodeType({
  idname: 'NodeGroupOutput',
  label: 'Group Output',
  category: 'interface',
  treeTypes: ALL_TREES,
  inputs: [],
  outputs: [],
  props: [
    {
      id: 'is_active_output',
      name: 'Active Output',
      type: 'BOOLEAN',
      d: true,
      inNode: false,
    },
  ],
  width: 140,
  hidden: true,
  dynamicSockets: (_node, ctx) => ({
    inputs: [
      ...interfaceSockets(ctx.tree, 'OUTPUT').map((s) => ({
        ...s,
        hide_value: true,
      })),
      extendSocket,
    ],
    outputs: [],
  }),
  description: 'Output data from inside of a node group',
});

/** Create a group node type for a tree kind (ShaderNodeGroup, GeometryNodeGroup, …). */
export function makeGroupNodeType(idname: string, treeTypes: TreeType[]): NodeTypeDef {
  const def: NodeTypeDef = {
    idname,
    label: 'Group',
    category: 'group',
    treeTypes,
    inputs: [],
    outputs: [],
    props: [
      {
        id: 'node_tree',
        name: 'Node Tree',
        type: 'NODE_TREE',
        d: null,
        inNode: false,
      },
    ],
    width: 140,
    hidden: true,
    dynamicSockets: (node, ctx) => {
      const g = node.props.node_tree ? ctx.doc.node_groups[node.props.node_tree as string] : undefined;
      return {
        inputs: interfaceSockets(g?.tree, 'INPUT'),
        outputs: interfaceSockets(g?.tree, 'OUTPUT'),
        panels: interfacePanels(g?.tree),
      };
    },
    description: 'Group node',
  };
  registerNodeType(def);
  return def;
}

export const groupNodeIdnames: Record<string, string> = {};
export function groupIdnameFor(treeType: TreeType) {
  return groupNodeIdnames[treeType] ?? 'ShaderNodeGroup';
}

makeGroupNodeType('ShaderNodeGroup', ['SHADER', 'WORLD']);
groupNodeIdnames.SHADER = 'ShaderNodeGroup';
groupNodeIdnames.WORLD = 'ShaderNodeGroup';
