// Scene compositing data model: the scene's compositing node tree is a
// node group (`scene.compositing_node_group`, tree type COMPOSITOR) whose Group Output is the
// composite result. Compositing applies to final renders when the group is set, the scene's
// (deprecated but still honoured) `use_nodes` is on and Output ▸ Post Processing ▸ Compositing
// (`render.use_compositing`) is enabled.
import type { DocumentData, LinkData, NodeData, NodeGroupData, NodeTreeData } from '../data/types';
import { uid } from '../data/defaults';
import { uniqueGroupName } from '../nodes/tree';

export function compositingGroup(doc: DocumentData): NodeGroupData | null {
  const id = doc.scene.compositing_node_group;
  const g = id ? doc.node_groups[id] : undefined;
  return g && g.tree.type === 'COMPOSITOR' ? g : null;
}

/** Whether final renders pass through the compositor. */
export function compositingActive(doc: DocumentData): boolean {
  return !!compositingGroup(doc) && doc.scene.use_nodes !== false && doc.scene.render.use_compositing !== false;
}

function node(type: string, name: string, location: [number, number], extra: Partial<NodeData> = {}): NodeData {
  return {
    id: uid('node'),
    type,
    name,
    location,
    inputs: {},
    props: {},
    ...extra,
  };
}

/** The default compositing tree: Render Layers → Group Output (Image) and Viewer. */
export function defaultCompositingTree(): NodeTreeData {
  const rl = node('CompositorNodeRLayers', 'Render Layers', [-390, 100], {
    width: 240,
  });
  const rr = node('NodeReroute', 'Reroute', [100, 65]);
  const out = node('NodeGroupOutput', 'Group Output', [200, 100], {
    props: { is_active_output: true },
  });
  const viewer = node('CompositorNodeViewer', 'Viewer', [200, 20]);
  const link = (a: NodeData, as: string, b: NodeData, bs: string): LinkData => ({
    id: uid('link'),
    from_node: a.id,
    from_socket: as,
    to_node: b.id,
    to_socket: bs,
  });
  return {
    type: 'COMPOSITOR',
    nodes: [rl, rr, out, viewer],
    links: [link(rl, 'Image', rr, 'Input'), link(rr, 'Output', out, 'Socket_1'), link(rr, 'Output', viewer, 'Image')],
    interface: [
      {
        in_out: 'INPUT',
        name: 'Image',
        socket_type: 'NodeSocketColor',
        identifier: 'Socket_0',
        default_value: [1, 1, 1, 1],
      },
      {
        in_out: 'OUTPUT',
        name: 'Image',
        socket_type: 'NodeSocketColor',
        identifier: 'Socket_1',
      },
    ],
    active_node: viewer.id,
  };
}

/** Create a compositing node group, assign it to the scene and enable compositing. */
export function newCompositingGroup(doc: DocumentData, name = 'Compositor Nodes'): NodeGroupData {
  const g: NodeGroupData = {
    id: uid('ng'),
    name: uniqueGroupName(doc, name),
    tree: defaultCompositingTree(),
  };
  // a legacy embedded tree (older documents) becomes the new group's content
  const legacy = doc.scene.compositor;
  if (legacy && legacy.nodes.some((n) => n.type !== 'CompositorNodeComposite')) {
    g.tree = migrateLegacyTree(legacy);
    doc.scene.compositor = null;
  }
  doc.node_groups[g.id] = g;
  doc.scene.compositing_node_group = g.id;
  doc.scene.use_nodes = true;
  return g;
}

/** Legacy embedded trees used a Composite node; it becomes the Group Output. */
export function migrateLegacyTree(t: NodeTreeData): NodeTreeData {
  const tree: NodeTreeData = structuredClone(t);
  tree.type = 'COMPOSITOR';
  tree.interface = [
    {
      in_out: 'INPUT',
      name: 'Image',
      socket_type: 'NodeSocketColor',
      identifier: 'Socket_0',
      default_value: [1, 1, 1, 1],
    },
    {
      in_out: 'OUTPUT',
      name: 'Image',
      socket_type: 'NodeSocketColor',
      identifier: 'Socket_1',
    },
  ];
  for (const n of tree.nodes)
    if (n.type === 'CompositorNodeComposite') {
      n.type = 'NodeGroupOutput';
      n.name = 'Group Output';
      n.props = { is_active_output: true };
    }
  const outs = new Set(tree.nodes.filter((n) => n.type === 'NodeGroupOutput').map((n) => n.id));
  for (const l of tree.links) if (outs.has(l.to_node)) l.to_socket = 'Socket_1';
  return tree;
}

/** Node groups usable as the scene compositing tree. */
export function compositorGroups(doc: DocumentData): NodeGroupData[] {
  return Object.values(doc.node_groups).filter((g) => g.tree.type === 'COMPOSITOR');
}
