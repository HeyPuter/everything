// Node tree editing utilities (pure data operations; the editor and operators build on these).
import type { DocumentData, LinkData, NodeData, NodeGroupData, NodeTreeData, SocketValue } from '../data/types';
import { uid } from '../data/defaults';
import { allSockets, canConvert, findSocket, getNodeType, isAvailable, nodeSockets, socketDefault, SOCKET_IDNAME, canonicalIdname } from './registry';
import { EXTEND_SOCKET, groupIdnameFor } from './common';
import type { SocketContext, SocketDef, TreeType } from './types';

export const ctxOf = (doc: DocumentData, tree: NodeTreeData): SocketContext => ({ doc, tree });

export function nodeById(tree: NodeTreeData, id: string) {
  return tree.nodes.find((n) => n.id === id);
}

export function uniqueNodeName(tree: NodeTreeData, base: string): string {
  const names = new Set(tree.nodes.map((n) => n.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; i < 10000; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
  return `${stem}.${uid('n')}`;
}

/** Create a node (not yet added to the tree). */
export function makeNode(tree: NodeTreeData, idname: string, location: [number, number], settings: Record<string, SocketValue> = {}): NodeData {
  const type = canonicalIdname(idname);
  const def = getNodeType(type);
  const node: NodeData = {
    id: uid('node'),
    type,
    name: uniqueNodeName(tree, def?.label ?? idname),
    location: [location[0], location[1]],
    inputs: {},
    props: {},
  };
  if (def) {
    for (const p of def.props) if (p.d !== undefined && p.d !== null) node.props[p.id] = Array.isArray(p.d) ? [...p.d] : p.d;
    if (def.width !== 140) node.width = def.width;
    Object.assign(node.props, settings);
    def.init?.(node);
  } else Object.assign(node.props, settings);
  return node;
}

export function addNode(tree: NodeTreeData, idname: string, location: [number, number], settings: Record<string, SocketValue> = {}): NodeData {
  const n = makeNode(tree, idname, location, settings);
  tree.nodes.push(n);
  return n;
}

// ---------------------------------------------------------------------------
// Links

export function linksTo(tree: NodeTreeData, nodeId: string, socket?: string) {
  return tree.links.filter((l) => l.to_node === nodeId && (socket === undefined || l.to_socket === socket));
}

export function linksFrom(tree: NodeTreeData, nodeId: string, socket?: string) {
  return tree.links.filter((l) => l.from_node === nodeId && (socket === undefined || l.from_socket === socket));
}

/** Whether `target` is reachable downstream from `start` (cycle detection). */
export function dependsOn(tree: NodeTreeData, start: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of tree.links) if (l.from_node === id) stack.push(l.to_node);
  }
  return false;
}

export interface LinkStatus {
  valid: boolean;
  /** sockets are hidden/unavailable: link is kept but inactive */
  inactive: boolean;
  fromType?: SocketDef['type'];
  toType?: SocketDef['type'];
}

/** Validity of a link (types compatible, no cycle, sockets available). */
export function linkStatus(ctx: SocketContext, l: LinkData): LinkStatus {
  const from = nodeById(ctx.tree, l.from_node),
    to = nodeById(ctx.tree, l.to_node);
  if (!from || !to) return { valid: false, inactive: true };
  const fs = findSocket(from, l.from_socket, true, ctx),
    ts = findSocket(to, l.to_socket, false, ctx);
  if (!fs || !ts) return { valid: false, inactive: true };
  const inactive = !isAvailable(from, fs, true) || !isAvailable(to, ts, false);
  const valid = canConvert(fs.type, ts.type) && !dependsOn(ctx.tree, l.to_node, l.from_node);
  return { valid, inactive, fromType: fs.type, toType: ts.type };
}

/**
 * Connect two sockets. Replaces existing links into single inputs. Linking to a group
 * input/output "extend" socket adds an interface socket. Returns the link or null if invalid.
 */
export function connect(ctx: SocketContext, fromNode: string, fromSocket: string, toNode: string, toSocket: string): LinkData | null {
  const { tree } = ctx;
  if (fromNode === toNode) return null;
  const from = nodeById(tree, fromNode),
    to = nodeById(tree, toNode);
  if (!from || !to) return null;
  if (dependsOn(tree, toNode, fromNode)) return null;
  // extend sockets on group input / output (other nodes' extend sockets are handled by their owners)
  const groupIO = (n: NodeData) => n.type === 'NodeGroupInput' || n.type === 'NodeGroupOutput';
  const fromExt = fromSocket === EXTEND_SOCKET && groupIO(from),
    toExt = toSocket === EXTEND_SOCKET && groupIO(to);
  if (fromExt || toExt) {
    if (fromExt && toExt) return null;
    if (fromExt) {
      const target = findSocket(to, toSocket, false, ctx);
      if (!target) return null;
      fromSocket = addInterfaceSocket(tree, 'INPUT', target.name || 'Value', target.type === 'CUSTOM' ? 'FLOAT' : target.type, socketDefaultFor(to, target)).identifier;
    } else {
      const source = findSocket(from, fromSocket, true, ctx);
      if (!source) return null;
      toSocket = addInterfaceSocket(tree, 'OUTPUT', source.name || 'Value', source.type === 'CUSTOM' ? 'FLOAT' : source.type).identifier;
    }
  }
  const fs = findSocket(from, fromSocket, true, ctx),
    ts = findSocket(to, toSocket, false, ctx);
  if (!fs || !ts) return null;
  if (!canConvert(fs.type, ts.type) && fs.type !== 'CUSTOM' && ts.type !== 'CUSTOM') return null;
  if (!ts.multiInput) tree.links = tree.links.filter((l) => !(l.to_node === toNode && l.to_socket === ts.identifier));
  const link: LinkData = {
    id: uid('link'),
    from_node: fromNode,
    from_socket: fs.identifier,
    to_node: toNode,
    to_socket: ts.identifier,
  };
  tree.links.push(link);
  return link;
}

function socketDefaultFor(node: NodeData, s: SocketDef): SocketValue | undefined {
  const v = node.inputs[s.identifier];
  return v === undefined ? s.default : v;
}

export function addInterfaceSocket(tree: NodeTreeData, inOut: 'INPUT' | 'OUTPUT', name: string, type: SocketDef['type'], def?: SocketValue) {
  tree.interface ??= [];
  const used = new Set(tree.interface.map((i) => i.identifier));
  let k = tree.interface.length;
  while (used.has(`Socket_${k}`)) k++;
  const names = new Set(tree.interface.filter((i) => i.in_out === inOut).map((i) => i.name));
  let nm = name;
  for (let i = 1; names.has(nm); i++) nm = `${name}.${String(i).padStart(3, '0')}`;
  const item: NonNullable<NodeTreeData['interface']>[number] = {
    in_out: inOut,
    name: nm,
    socket_type: SOCKET_IDNAME[type] ?? 'NodeSocketFloat',
    identifier: `Socket_${k}`,
  };
  if (def !== undefined && def !== null) item.default_value = Array.isArray(def) ? [...def] : def;
  tree.interface.push(item);
  return item;
}

export function removeLinks(tree: NodeTreeData, ids: Set<string>) {
  tree.links = tree.links.filter((l) => !ids.has(l.id));
}

// ---------------------------------------------------------------------------
// Node operations

export function removeNodes(tree: NodeTreeData, ids: Set<string>) {
  // frames: children of a removed frame keep their place
  for (const n of tree.nodes) if (n.parent && ids.has(n.parent)) n.parent = null;
  tree.nodes = tree.nodes.filter((n) => !ids.has(n.id));
  tree.links = tree.links.filter((l) => !ids.has(l.from_node) && !ids.has(l.to_node));
  if (tree.active_node && ids.has(tree.active_node)) tree.active_node = null;
}

/** Internal pass-through pairs of a node (used by mute and delete-with-reconnect). */
export function internalLinks(ctx: SocketContext, node: NodeData): [SocketDef, SocketDef][] {
  const { inputs, outputs } = nodeSockets(node, ctx);
  const pairs: [SocketDef, SocketDef][] = [];
  const used = new Set<string>();
  const rank = (a: SocketDef['type'], b: SocketDef['type']) => (a === b ? 0 : canConvert(a, b) ? 1 : 9);
  for (const out of outputs) {
    let best: SocketDef | null = null,
      bestRank = 9;
    for (const inp of inputs) {
      const r = rank(inp.type, out.type) + (used.has(inp.identifier) ? 0.5 : 0);
      if (r < bestRank) {
        best = inp;
        bestRank = r;
      }
    }
    if (best && bestRank < 9) {
      pairs.push([best, out]);
      used.add(best.identifier);
    }
  }
  return pairs;
}

/** Delete nodes, reconnecting links through them (Ctrl+X). */
export function dissolveNodes(ctx: SocketContext, ids: Set<string>) {
  const { tree } = ctx;
  for (const id of ids) {
    const node = nodeById(tree, id);
    if (!node) continue;
    const pairs = internalLinks(ctx, node);
    for (const [inp, out] of pairs) {
      const src = tree.links.find((l) => l.to_node === id && l.to_socket === inp.identifier);
      if (!src || ids.has(src.from_node)) continue;
      for (const dst of tree.links.filter((l) => l.from_node === id && l.from_socket === out.identifier)) {
        if (ids.has(dst.to_node)) continue;
        tree.links.push({
          id: uid('link'),
          from_node: src.from_node,
          from_socket: src.from_socket,
          to_node: dst.to_node,
          to_socket: dst.to_socket,
        });
      }
    }
    removeNodes(tree, new Set([id]));
  }
  // drop links that became invalid (type mismatch)
  tree.links = tree.links.filter((l) => {
    const st = linkStatus(ctx, l);
    return st.valid || st.inactive;
  });
}

/** Duplicate nodes with the links between them. Returns old id → new node. */
export function duplicateNodes(tree: NodeTreeData, ids: Set<string>, offset: [number, number] = [0, 0], keepInputs = false): Map<string, NodeData> {
  const map = new Map<string, NodeData>();
  for (const n of tree.nodes) {
    if (!ids.has(n.id)) continue;
    const c: NodeData = structuredClone(n);
    c.id = uid('node');
    c.name = uniqueNodeName(tree, n.name);
    c.location = [n.location[0] + offset[0], n.location[1] + offset[1]];
    map.set(n.id, c);
    tree.nodes.push(c);
  }
  for (const c of map.values()) if (c.parent) c.parent = map.get(c.parent)?.id ?? c.parent;
  const extra: LinkData[] = [];
  for (const l of tree.links) {
    const f = map.get(l.from_node),
      t = map.get(l.to_node);
    if (f && t) extra.push({ ...l, id: uid('link'), from_node: f.id, to_node: t.id });
    else if (t && keepInputs) extra.push({ ...l, id: uid('link'), to_node: t.id });
  }
  tree.links.push(...extra);
  return map;
}

/** Insert a node into a link (auto-connect first compatible sockets). */
export function insertOnLink(ctx: SocketContext, nodeId: string, linkId: string): boolean {
  const { tree } = ctx;
  const link = tree.links.find((l) => l.id === linkId);
  const node = nodeById(tree, nodeId);
  if (!link || !node) return false;
  const st = linkStatus(ctx, link);
  const { inputs, outputs } = nodeSockets(node, ctx);
  const inp = inputs.find((s) => st.fromType && s.type === st.fromType) ?? inputs.find((s) => st.fromType && canConvert(st.fromType, s.type));
  const out = outputs.find((s) => st.toType && s.type === st.toType) ?? outputs.find((s) => st.toType && canConvert(s.type, st.toType));
  if (!inp || !out) return false;
  tree.links = tree.links.filter((l) => l.id !== linkId);
  tree.links.push({
    id: uid('link'),
    from_node: link.from_node,
    from_socket: link.from_socket,
    to_node: nodeId,
    to_socket: inp.identifier,
  });
  tree.links.push({
    id: uid('link'),
    from_node: nodeId,
    from_socket: out.identifier,
    to_node: link.to_node,
    to_socket: link.to_socket,
  });
  return true;
}

/** Link selected nodes left-to-right using the first compatible free sockets (`replace`: also occupied inputs). */
export function makeLinks(ctx: SocketContext, ids: string[], replace = false): number {
  const { tree } = ctx;
  const nodes = ids
    .map((id) => nodeById(tree, id)!)
    .filter(Boolean)
    .sort((a, b) => a.location[0] - b.location[0]);
  let made = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i],
      b = nodes[i + 1];
    if (getNodeType(a.type)?.layout === 'FRAME' || getNodeType(b.type)?.layout === 'FRAME') continue;
    // neighbours that are already connected are left alone
    if (replace && tree.links.some((l) => l.from_node === a.id && l.to_node === b.id)) continue;
    const outs = nodeSockets(a, ctx).outputs.filter((s) => s.type !== 'CUSTOM'),
      ins = nodeSockets(b, ctx).inputs.filter((s) => s.type !== 'CUSTOM' && (replace || !tree.links.some((l) => l.to_node === b.id && l.to_socket === s.identifier)));
    let done = false;
    for (const pass of [0, 1]) {
      for (const o of outs) {
        const target = ins.find((s) => (pass === 0 ? s.type === o.type : canConvert(o.type, s.type)));
        if (target && connect(ctx, a.id, o.identifier, b.id, target.identifier)) {
          made++;
          done = true;
          break;
        }
      }
      if (done) break;
    }
  }
  return made;
}

/** Toggle hiding of unlinked sockets (Ctrl+H). */
export function toggleHiddenSockets(ctx: SocketContext, node: NodeData) {
  if (node.hidden_sockets?.length) {
    node.hidden_sockets = [];
    return;
  }
  const { inputs, outputs } = nodeSockets(node, ctx);
  const hidden: string[] = [];
  for (const s of inputs) if (!ctx.tree.links.some((l) => l.to_node === node.id && l.to_socket === s.identifier)) hidden.push(`in:${s.identifier}`);
  for (const s of outputs) if (!ctx.tree.links.some((l) => l.from_node === node.id && l.from_socket === s.identifier)) hidden.push(`out:${s.identifier}`);
  node.hidden_sockets = hidden;
}

// ---------------------------------------------------------------------------
// Frames

export function joinInFrame(tree: NodeTreeData, ids: string[]): NodeData | null {
  const nodes = ids.map((id) => nodeById(tree, id)).filter((n): n is NodeData => !!n && n.type !== 'NodeFrame');
  if (!nodes.length) return null;
  const minX = Math.min(...nodes.map((n) => n.location[0])),
    maxY = Math.max(...nodes.map((n) => n.location[1]));
  const frame = makeNode(tree, 'NodeFrame', [minX - 30, maxY + 40]);
  // common parent becomes the new frame's parent
  const parents = new Set(nodes.map((n) => n.parent ?? null));
  if (parents.size === 1) frame.parent = [...parents][0];
  for (const n of nodes) n.parent = frame.id;
  // frames are drawn behind nodes: insert before the first child
  const first = Math.min(...nodes.map((n) => tree.nodes.indexOf(n)));
  tree.nodes.splice(first, 0, frame);
  return frame;
}

export function frameChildren(tree: NodeTreeData, frameId: string): NodeData[] {
  return tree.nodes.filter((n) => n.parent === frameId);
}

// ---------------------------------------------------------------------------
// Groups

/** Wrap nodes into a new node group (Ctrl+G). Returns the group node. */
export function makeGroup(doc: DocumentData, tree: NodeTreeData, ids: Set<string>, name = 'NodeGroup'): NodeData | null {
  const ctx = ctxOf(doc, tree);
  const moving = tree.nodes.filter((n) => ids.has(n.id) && n.type !== 'NodeGroupInput' && n.type !== 'NodeGroupOutput');
  if (!moving.length) return null;
  const set = new Set(moving.map((n) => n.id));
  const treeType: TreeType = tree.type === 'WORLD' ? 'SHADER' : tree.type;
  const gtree: NodeTreeData = {
    type: treeType,
    nodes: [],
    links: [],
    interface: [],
  };
  const minX = Math.min(...moving.map((n) => n.location[0])),
    maxX = Math.max(...moving.map((n) => n.location[0] + (n.width ?? 140)));
  const cy = moving.reduce((s, n) => s + n.location[1], 0) / moving.length;
  const cx = (minX + maxX) / 2;
  const gin = makeNode(gtree, 'NodeGroupInput', [minX - cx - 200, 0]);
  const gout = makeNode(gtree, 'NodeGroupOutput', [maxX - cx + 60, 0]);
  gtree.nodes.push(gin, gout);
  for (const n of moving) {
    const c: NodeData = structuredClone(n);
    c.location = [n.location[0] - cx, n.location[1] - cy];
    if (c.parent && !set.has(c.parent)) c.parent = null;
    c.select = false;
    gtree.nodes.push(c);
  }
  const groupNode = makeNode(tree, groupIdnameFor(tree.type), [cx - 70, cy]);
  const group: NodeGroupData = {
    id: uid('ng'),
    name: uniqueGroupName(doc, name),
    tree: gtree,
  };
  doc.node_groups[group.id] = group;
  groupNode.props.node_tree = group.id;
  groupNode.select = true;
  const newLinks: LinkData[] = [];
  const inputMap = new Map<string, string>(); // from node:socket → interface id
  const outputMap = new Map<string, string>();
  for (const l of tree.links) {
    const fi = set.has(l.from_node),
      ti = set.has(l.to_node);
    if (fi && ti) gtree.links.push({ ...l });
    else if (!fi && ti) {
      const key = `${l.from_node}:${l.from_socket}`;
      let ident = inputMap.get(key);
      if (!ident) {
        const to = nodeById(tree, l.to_node)!;
        const s = findSocket(to, l.to_socket, false, ctx);
        const item = addInterfaceSocket(gtree, 'INPUT', s?.name ?? l.to_socket, s?.type ?? 'FLOAT', s ? (to.inputs[s.identifier] ?? socketDefault(s)) : undefined);
        ident = item.identifier;
        inputMap.set(key, ident);
        newLinks.push({
          id: uid('link'),
          from_node: l.from_node,
          from_socket: l.from_socket,
          to_node: groupNode.id,
          to_socket: ident,
        });
      }
      gtree.links.push({
        id: uid('link'),
        from_node: gin.id,
        from_socket: ident,
        to_node: l.to_node,
        to_socket: l.to_socket,
      });
    } else if (fi && !ti) {
      const key = `${l.from_node}:${l.from_socket}`;
      let ident = outputMap.get(key);
      if (!ident) {
        const from = nodeById(tree, l.from_node)!;
        const s = findSocket(from, l.from_socket, true, ctx);
        const item = addInterfaceSocket(gtree, 'OUTPUT', s?.name ?? l.from_socket, s?.type ?? 'FLOAT');
        ident = item.identifier;
        outputMap.set(key, ident);
        gtree.links.push({
          id: uid('link'),
          from_node: l.from_node,
          from_socket: l.from_socket,
          to_node: gout.id,
          to_socket: ident,
        });
      }
      newLinks.push({
        id: uid('link'),
        from_node: groupNode.id,
        from_socket: ident,
        to_node: l.to_node,
        to_socket: l.to_socket,
      });
    }
  }
  removeNodes(tree, set);
  for (const n of tree.nodes) n.select = false;
  tree.nodes.push(groupNode);
  tree.links.push(...newLinks);
  tree.active_node = groupNode.id;
  return groupNode;
}

export function uniqueGroupName(doc: DocumentData, base: string) {
  const names = new Set(Object.values(doc.node_groups).map((g) => g.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

/** Expand a group node into its contents (Ctrl+Alt+G). Returns the new nodes. */
export function ungroup(doc: DocumentData, tree: NodeTreeData, groupNodeId: string): NodeData[] {
  const gnode = nodeById(tree, groupNodeId);
  const group = gnode?.props.node_tree ? doc.node_groups[gnode.props.node_tree as string] : undefined;
  if (!gnode || !group) return [];
  const g = group.tree;
  const map = new Map<string, NodeData>();
  const inner = g.nodes.filter((n) => n.type !== 'NodeGroupInput' && n.type !== 'NodeGroupOutput');
  const cx = gnode.location[0] + 70,
    cy = gnode.location[1];
  for (const n of inner) {
    const c: NodeData = structuredClone(n);
    c.id = uid('node');
    c.name = uniqueNodeName(tree, n.name);
    c.location = [n.location[0] + cx, n.location[1] + cy];
    c.select = true;
    map.set(n.id, c);
  }
  for (const c of map.values()) if (c.parent) c.parent = map.get(c.parent)?.id ?? null;
  const ginIds = new Set(g.nodes.filter((n) => n.type === 'NodeGroupInput').map((n) => n.id));
  const goutIds = new Set(g.nodes.filter((n) => n.type === 'NodeGroupOutput').map((n) => n.id));
  const added: LinkData[] = [];
  for (const l of g.links) {
    const f = map.get(l.from_node),
      t = map.get(l.to_node);
    if (f && t) added.push({ ...l, id: uid('link'), from_node: f.id, to_node: t.id });
    else if (ginIds.has(l.from_node) && t) {
      // outer link into the group socket, or the socket's stored value
      const outer = tree.links.find((x) => x.to_node === gnode.id && x.to_socket === l.from_socket);
      if (outer)
        added.push({
          id: uid('link'),
          from_node: outer.from_node,
          from_socket: outer.from_socket,
          to_node: t.id,
          to_socket: l.to_socket,
        });
      else if (gnode.inputs[l.from_socket] !== undefined) t.inputs[l.to_socket] = structuredClone(gnode.inputs[l.from_socket]);
      else {
        const item = g.interface?.find((i) => i.identifier === l.from_socket);
        if (item?.default_value !== undefined) t.inputs[l.to_socket] = structuredClone(item.default_value);
      }
    } else if (f && goutIds.has(l.to_node)) {
      for (const outer of tree.links.filter((x) => x.from_node === gnode.id && x.from_socket === l.to_socket))
        added.push({
          id: uid('link'),
          from_node: f.id,
          from_socket: l.from_socket,
          to_node: outer.to_node,
          to_socket: outer.to_socket,
        });
    }
  }
  // pass-through: group input directly to group output
  for (const l of g.links) {
    if (ginIds.has(l.from_node) && goutIds.has(l.to_node)) {
      const outer = tree.links.find((x) => x.to_node === gnode.id && x.to_socket === l.from_socket);
      if (!outer) continue;
      for (const o of tree.links.filter((x) => x.from_node === gnode.id && x.from_socket === l.to_socket))
        added.push({
          id: uid('link'),
          from_node: outer.from_node,
          from_socket: outer.from_socket,
          to_node: o.to_node,
          to_socket: o.to_socket,
        });
    }
  }
  for (const n of tree.nodes) n.select = false;
  removeNodes(tree, new Set([gnode.id]));
  tree.nodes.push(...map.values());
  tree.links.push(...added);
  return [...map.values()];
}

/** Node groups usable from a tree (same tree kind, excluding those that would recurse). */
export function compatibleGroups(doc: DocumentData, treeType: TreeType, excludeId?: string): NodeGroupData[] {
  const kind = treeType === 'WORLD' ? 'SHADER' : treeType;
  return Object.values(doc.node_groups).filter((g) => g.tree.type === kind && g.id !== excludeId && !groupContains(doc, g, excludeId));
}

export function groupContains(doc: DocumentData, g: NodeGroupData, id: string | undefined, depth = 0): boolean {
  if (!id || depth > 32) return false;
  for (const n of g.tree.nodes) {
    const ref = n.props.node_tree as string | undefined;
    if (!ref) continue;
    if (ref === id) return true;
    const sub = doc.node_groups[ref];
    if (sub && groupContains(doc, sub, id, depth + 1)) return true;
  }
  return false;
}

/** The active output node of a tree for a target (EEVEE-like). */
export function activeOutput(tree: NodeTreeData, type: string): NodeData | undefined {
  const outs = tree.nodes.filter((n) => n.type === type && !n.mute);
  return outs.find((n) => n.props.is_active_output && n.props.target !== 'CYCLES') ?? outs.find((n) => n.props.target !== 'CYCLES') ?? outs[0];
}

export { allSockets };
