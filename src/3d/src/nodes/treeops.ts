// Node tree commands behind the node editor's Select, Node and link gestures: grouped selection,
// frames, group insert/separate, swapping node types, reroutes on links and insert offsets.
// Pure data operations (no DOM), so they are unit-testable; operators live in editor/*.ts.
import type { DocumentData, LinkData, NodeData, NodeTreeData, SocketValue } from '../data/types';
import { uid } from '../data/defaults';
import { canConvert, getNodeType, nodeSockets, socketDefault } from './registry';
import { groupNodeIdnames } from './common';
import { activeOutput, addInterfaceSocket, connect as connectLink, ctxOf, internalLinks, makeNode, nodeById, removeNodes, uniqueNodeName } from './tree';
import type { ResolvedSocket, SocketContext } from './types';

export const isGroupNode = (n: NodeData | undefined | null): boolean => !!n && Object.values(groupNodeIdnames).includes(n.type) && 'node_tree' in n.props;
export const isFrame = (n: NodeData | undefined | null) => !!n && getNodeType(n.type)?.layout === 'FRAME';
export const isReroute = (n: NodeData | undefined | null) => !!n && getNodeType(n.type)?.layout === 'REROUTE';

const activeOf = (tree: NodeTreeData) => (tree.active_node ? nodeById(tree, tree.active_node) : undefined);

// ---------------------------------------------------------------------------
// Selection

export type GroupedType = 'TYPE' | 'COLOR' | 'PREFIX' | 'SUFFIX';

/** Split a node name at its last separator ('.', '_', '-' or space): [prefix, suffix]. */
export function nameParts(name: string): [string, string] | null {
  for (let i = name.length - 1; i >= 0; i--) if ('._- '.includes(name[i])) return [name.slice(0, i), name.slice(i + 1)];
  return null;
}

function sameColor(a: NodeData, b: NodeData) {
  const ca = a.use_custom_color ? a.color : null,
    cb = b.use_custom_color ? b.color : null;
  if (!ca || !cb) return !ca && !cb;
  return ca.every((v, i) => Math.abs(v - (cb[i] ?? 0)) < 1e-3);
}

/** Select nodes sharing a property with the active node. Returns how many nodes are selected. */
export function selectGrouped(tree: NodeTreeData, type: GroupedType, extend = false): number {
  const act = activeOf(tree);
  if (!act) return 0;
  const parts = nameParts(act.name);
  const match = (n: NodeData) => {
    switch (type) {
      case 'TYPE':
        return n.type === act.type;
      case 'COLOR':
        return sameColor(n, act);
      case 'PREFIX': {
        const p = nameParts(n.name);
        return !!parts && !!p && p[0] === parts[0];
      }
      case 'SUFFIX': {
        const p = nameParts(n.name);
        return !!parts && !!p && p[1] === parts[1];
      }
    }
  };
  for (const n of tree.nodes) {
    if (n === act) n.select = true;
    else if (match(n)) n.select = true;
    else if (!extend) n.select = false;
  }
  return tree.nodes.filter((n) => n.select).length;
}

/** Activate the next (or previous) node of the active node's type, ordered left to right. */
export function sameTypeStep(tree: NodeTreeData, prev: boolean): NodeData | null {
  const act = activeOf(tree);
  if (!act) return null;
  const same = tree.nodes.filter((n) => n.type === act.type).sort((a, b) => a.location[0] - b.location[0] || b.location[1] - a.location[1]);
  if (same.length < 2) return null;
  const i = same.indexOf(act);
  const next = same[(i + (prev ? -1 : 1) + same.length) % same.length];
  for (const n of tree.nodes) n.select = n === next;
  tree.active_node = next.id;
  return next;
}

// ---------------------------------------------------------------------------
// Frames

/** Whether `node` is `ancestor` or nested inside it. */
export function isInside(tree: NodeTreeData, node: NodeData, ancestor: string): boolean {
  let p: NodeData | undefined = node;
  for (let depth = 0; p && depth < 64; depth++) {
    if (p.id === ancestor) return true;
    p = p.parent ? nodeById(tree, p.parent) : undefined;
  }
  return false;
}

/** Attach the selected nodes to a frame (Make Parent). Returns the number of nodes attached. */
export function parentSet(tree: NodeTreeData, ids: Iterable<string>, frameId: string): number {
  const frame = nodeById(tree, frameId);
  if (!isFrame(frame)) return 0;
  let n = 0;
  for (const id of ids) {
    const node = nodeById(tree, id);
    if (!node || node === frame || isInside(tree, frame!, node.id)) continue;
    node.parent = frameId;
    n++;
  }
  return n;
}

/** Detach selected nodes from frames that are not selected themselves. */
export function detachNodes(tree: NodeTreeData, ids: Set<string>): number {
  let n = 0;
  for (const node of tree.nodes) {
    if (!ids.has(node.id) || !node.parent) continue;
    // a selected frame keeps its selected children
    if (ids.has(node.parent)) continue;
    // nested: climb to the first unselected ancestor and attach to its parent
    node.parent = null;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Groups

/** Merge selected Group Input nodes into one (the active one when selected). */
export function joinGroupInputs(tree: NodeTreeData, ids: Set<string>): NodeData | null {
  const inputs = tree.nodes.filter((n) => ids.has(n.id) && n.type === 'NodeGroupInput');
  if (inputs.length < 2) return null;
  const act = activeOf(tree);
  const keep = act && inputs.includes(act) ? act : inputs[0];
  const others = new Set(inputs.filter((n) => n !== keep).map((n) => n.id));
  const seen = new Set<string>();
  const out: LinkData[] = [];
  for (const l of tree.links) {
    const r = others.has(l.from_node) ? { ...l, from_node: keep.id } : l;
    const key = `${r.from_node}|${r.from_socket}|${r.to_node}|${r.to_socket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  tree.links = out;
  // a socket stays visible when any of the merged nodes showed it
  const hidden = inputs.map((n) => new Set(n.hidden_sockets ?? []));
  keep.hidden_sockets = [...hidden[0]].filter((s) => hidden.every((h) => h.has(s)));
  removeNodes(tree, others);
  for (const n of tree.nodes) n.select = n === keep;
  tree.active_node = keep.id;
  return keep;
}

function interfaceIdentForLink(gtree: NodeTreeData, inOut: 'INPUT' | 'OUTPUT', s: ResolvedSocket | undefined, fallback: string, value?: SocketValue) {
  return addInterfaceSocket(gtree, inOut, s?.name ?? fallback, s?.type === 'CUSTOM' || !s ? 'FLOAT' : s.type, value).identifier;
}

function ensureGroupIO(gtree: NodeTreeData, type: 'NodeGroupInput' | 'NodeGroupOutput', x: number): NodeData {
  let n = gtree.nodes.find((x2) => x2.type === type);
  if (!n) {
    n = makeNode(gtree, type, [x, 0]);
    gtree.nodes.push(n);
  }
  return n;
}

/**
 * Move nodes into an existing group (Insert Into Group). Links that cross the group boundary
 * become new interface sockets; links into or out of the group node itself are rewired inside.
 */
export function groupInsert(doc: DocumentData, tree: NodeTreeData, groupNodeId: string, ids: Set<string>): boolean {
  const gnode = nodeById(tree, groupNodeId);
  const group = isGroupNode(gnode) && gnode!.props.node_tree ? doc.node_groups[gnode!.props.node_tree as string] : undefined;
  if (!gnode || !group) return false;
  const moving = tree.nodes.filter((n) => ids.has(n.id) && n.id !== groupNodeId && n.type !== 'NodeGroupInput' && n.type !== 'NodeGroupOutput');
  // a group cannot contain a node that uses itself
  if (moving.some((n) => n.props.node_tree === group.id)) return false;
  if (!moving.length) return false;
  const g = group.tree;
  const ctx = ctxOf(doc, tree);
  const set = new Set(moving.map((n) => n.id));
  const gin = () => ensureGroupIO(g, 'NodeGroupInput', Math.min(0, ...g.nodes.map((n) => n.location[0])) - 200);
  const gout = () => ensureGroupIO(g, 'NodeGroupOutput', Math.max(0, ...g.nodes.map((n) => n.location[0] + (n.width ?? 140))) + 80);
  // place the moved nodes to the right of the group's existing content, keeping their layout
  const inner = g.nodes.filter((n) => n.type !== 'NodeGroupOutput');
  const ox = inner.length ? Math.max(...inner.map((n) => n.location[0] + (n.width ?? 140))) + 60 : 0;
  const minX = Math.min(...moving.map((n) => n.location[0]));
  const cy = moving.reduce((s, n) => s + n.location[1], 0) / moving.length;
  const map = new Map<string, NodeData>();
  for (const n of moving) {
    const c: NodeData = structuredClone(n);
    c.id = uid('node');
    c.name = uniqueNodeName(g, n.name);
    c.location = [n.location[0] - minX + ox, n.location[1] - cy];
    if (c.parent && !set.has(c.parent)) c.parent = null;
    c.select = false;
    map.set(n.id, c);
    g.nodes.push(c);
  }
  for (const c of map.values()) if (c.parent) c.parent = map.get(c.parent)?.id ?? null;
  // shift the group output past the inserted nodes
  const out = g.nodes.find((n) => n.type === 'NodeGroupOutput');
  if (out) out.location[0] = Math.max(out.location[0], ...[...map.values()].map((n) => n.location[0] + (n.width ?? 140) + 80));
  const outerNew: LinkData[] = [];
  const inputMap = new Map<string, string>(),
    outputMap = new Map<string, string>();
  for (const l of tree.links) {
    const fi = set.has(l.from_node),
      ti = set.has(l.to_node);
    if (fi && ti) {
      g.links.push({ ...l, id: uid('link'), from_node: map.get(l.from_node)!.id, to_node: map.get(l.to_node)!.id });
    } else if (fi && l.to_node === gnode.id) {
      // moved node fed the group: connect it straight to what the group input fed
      const src = map.get(l.from_node)!;
      for (const il of g.links.filter((x) => nodeById(g, x.from_node)?.type === 'NodeGroupInput' && x.from_socket === l.to_socket))
        g.links.push({ id: uid('link'), from_node: src.id, from_socket: l.from_socket, to_node: il.to_node, to_socket: il.to_socket });
    } else if (ti && l.from_node === gnode.id) {
      // group fed the moved node: use what reaches the group output inside
      const dst = map.get(l.to_node)!;
      const ol = g.links.find((x) => nodeById(g, x.to_node)?.type === 'NodeGroupOutput' && x.to_socket === l.from_socket);
      if (ol) g.links.push({ id: uid('link'), from_node: ol.from_node, from_socket: ol.from_socket, to_node: dst.id, to_socket: l.to_socket });
    } else if (ti) {
      const key = `${l.from_node}:${l.from_socket}`;
      let ident = inputMap.get(key);
      if (!ident) {
        const to = nodeById(tree, l.to_node)!;
        const s = nodeSockets(to, ctx).inputs.find((x) => x.identifier === l.to_socket);
        ident = interfaceIdentForLink(g, 'INPUT', s, l.to_socket, s ? (to.inputs[s.identifier] ?? socketDefault(s)) : undefined);
        inputMap.set(key, ident);
        outerNew.push({ id: uid('link'), from_node: l.from_node, from_socket: l.from_socket, to_node: gnode.id, to_socket: ident });
      }
      g.links.push({ id: uid('link'), from_node: gin().id, from_socket: ident, to_node: map.get(l.to_node)!.id, to_socket: l.to_socket });
    } else if (fi) {
      const key = `${l.from_node}:${l.from_socket}`;
      let ident = outputMap.get(key);
      if (!ident) {
        const from = nodeById(tree, l.from_node)!;
        const s = nodeSockets(from, ctx).outputs.find((x) => x.identifier === l.from_socket);
        ident = interfaceIdentForLink(g, 'OUTPUT', s, l.from_socket);
        outputMap.set(key, ident);
        g.links.push({ id: uid('link'), from_node: map.get(l.from_node)!.id, from_socket: l.from_socket, to_node: gout().id, to_socket: ident });
      }
      outerNew.push({ id: uid('link'), from_node: gnode.id, from_socket: ident, to_node: l.to_node, to_socket: l.to_socket });
    }
  }
  removeNodes(tree, set);
  tree.links.push(...outerNew);
  for (const n of tree.nodes) n.select = n === gnode;
  tree.active_node = gnode.id;
  return true;
}

/**
 * Copy or move nodes out of a group into the tree that contains the group node (Separate).
 * Links from the group input / to the group output are reconnected to the group node's
 * outer links. Returns the new nodes in the parent tree.
 */
export function groupSeparate(doc: DocumentData, parent: NodeTreeData, groupNodeId: string, ids: Set<string>, mode: 'COPY' | 'MOVE'): NodeData[] {
  const gnode = nodeById(parent, groupNodeId);
  const group = isGroupNode(gnode) && gnode!.props.node_tree ? doc.node_groups[gnode!.props.node_tree as string] : undefined;
  if (!gnode || !group) return [];
  const g = group.tree;
  const picked = g.nodes.filter((n) => ids.has(n.id) && n.type !== 'NodeGroupInput' && n.type !== 'NodeGroupOutput');
  if (!picked.length) return [];
  const set = new Set(picked.map((n) => n.id));
  const map = new Map<string, NodeData>();
  for (const n of parent.nodes) n.select = false;
  for (const n of picked) {
    const c: NodeData = structuredClone(n);
    c.id = uid('node');
    c.name = uniqueNodeName(parent, n.name);
    c.location = [n.location[0] + gnode.location[0], n.location[1] + gnode.location[1]];
    c.parent = c.parent && set.has(c.parent) ? c.parent : (gnode.parent ?? null);
    c.select = true;
    map.set(n.id, c);
    parent.nodes.push(c);
  }
  for (const c of map.values()) if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent)!.id;
  const kind = (id: string) => nodeById(g, id)?.type;
  for (const l of g.links) {
    const f = map.get(l.from_node),
      t = map.get(l.to_node);
    if (f && t) parent.links.push({ ...l, id: uid('link'), from_node: f.id, to_node: t.id });
    else if (t && kind(l.from_node) === 'NodeGroupInput') {
      for (const ol of parent.links.filter((x) => x.to_node === gnode.id && x.to_socket === l.from_socket))
        parent.links.push({ id: uid('link'), from_node: ol.from_node, from_socket: ol.from_socket, to_node: t.id, to_socket: l.to_socket });
      if (!parent.links.some((x) => x.to_node === t.id && x.to_socket === l.to_socket) && gnode.inputs[l.from_socket] !== undefined) t.inputs[l.to_socket] = structuredClone(gnode.inputs[l.from_socket]);
    } else if (f && kind(l.to_node) === 'NodeGroupOutput') {
      for (const ol of parent.links.filter((x) => x.from_node === gnode.id && x.from_socket === l.to_socket))
        parent.links.push({ id: uid('link'), from_node: f.id, from_socket: l.from_socket, to_node: ol.to_node, to_socket: ol.to_socket });
    }
  }
  if (mode === 'MOVE') removeNodes(g, set);
  parent.active_node = [...map.values()][0]?.id ?? parent.active_node;
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Swap

/** Replace a node with a node of another type, keeping position, frame, links and values. */
export function swapNode(ctx: SocketContext, node: NodeData, idname: string, settings: Record<string, SocketValue> = {}): NodeData | null {
  const { tree } = ctx;
  if (!getNodeType(idname)) return null;
  const n = makeNode(tree, idname, node.location, settings);
  n.parent = node.parent ?? null;
  n.label = node.label;
  if (node.use_custom_color) {
    n.use_custom_color = true;
    n.color = node.color ? [...node.color] as typeof node.color : null;
  }
  n.mute = node.mute;
  n.hide = node.hide;
  n.select = node.select;
  const idx = tree.nodes.indexOf(node);
  tree.nodes.splice(idx < 0 ? tree.nodes.length : idx + 1, 0, n);
  const oldS = nodeSockets(node, ctx),
    newS = nodeSockets(n, ctx);
  // best matching socket: same name, then same type, then convertible (each used once)
  const pick = (s: ResolvedSocket, list: ResolvedSocket[], used: Set<string>, isOutput: boolean) => {
    const free = list.filter((x) => !used.has(x.identifier) && x.type !== 'CUSTOM');
    const conv = (x: ResolvedSocket) => (isOutput ? canConvert(x.type, s.type) : canConvert(s.type, x.type));
    return free.find((x) => x.name === s.name && x.type === s.type) ?? free.find((x) => x.name === s.name && conv(x)) ?? free.find((x) => x.type === s.type) ?? free.find(conv);
  };
  const usedIn = new Set<string>();
  for (const s of oldS.inputs) {
    const links = tree.links.filter((l) => l.to_node === node.id && l.to_socket === s.identifier);
    const hasValue = node.inputs[s.identifier] !== undefined;
    if (!links.length && !hasValue) continue;
    const t = pick(s, newS.inputs, usedIn, false);
    if (!t) continue;
    usedIn.add(t.identifier);
    for (const l of links) {
      l.to_node = n.id;
      l.to_socket = t.identifier;
    }
    if (!links.length && t.type === s.type) n.inputs[t.identifier] = structuredClone(node.inputs[s.identifier]);
  }
  const usedOut = new Set<string>();
  for (const s of oldS.outputs) {
    const links = tree.links.filter((l) => l.from_node === node.id && l.from_socket === s.identifier);
    if (!links.length) continue;
    const t = pick(s, newS.outputs, usedOut, true);
    if (!t) continue;
    usedOut.add(t.identifier);
    for (const l of links) {
      l.from_node = n.id;
      l.from_socket = t.identifier;
    }
  }
  for (const c of tree.nodes) if (c.parent === node.id) c.parent = n.id;
  const wasActive = tree.active_node === node.id;
  removeNodes(tree, new Set([node.id]));
  if (wasActive) tree.active_node = n.id;
  // keep the name when the type keeps its label (e.g. Math ▸ Math)
  if (getNodeType(node.type)?.label === getNodeType(idname)?.label) n.name = node.name;
  return n;
}

// ---------------------------------------------------------------------------
// Show / hide, colors, links

/** Collapse nodes and hide their unused sockets, or show everything again when all are already. */
export function collapseHideUnused(ctx: SocketContext, nodes: NodeData[]) {
  const done = nodes.every((n) => n.hide && n.hidden_sockets?.length);
  for (const n of nodes) {
    if (done) {
      n.hide = false;
      n.hidden_sockets = [];
      continue;
    }
    n.hide = true;
    const { inputs, outputs } = nodeSockets(n, ctx);
    const hidden: string[] = [];
    for (const s of inputs) if (!ctx.tree.links.some((l) => l.to_node === n.id && l.to_socket === s.identifier)) hidden.push(`in:${s.identifier}`);
    for (const s of outputs) if (!ctx.tree.links.some((l) => l.from_node === n.id && l.from_socket === s.identifier)) hidden.push(`out:${s.identifier}`);
    n.hidden_sockets = hidden;
  }
}

/** Copy the active node's color to the other selected nodes. */
export function copyColor(tree: NodeTreeData): number {
  const act = activeOf(tree);
  if (!act) return 0;
  let n = 0;
  for (const o of tree.nodes) {
    if (!o.select || o === act) continue;
    o.use_custom_color = !!act.use_custom_color;
    o.color = act.color ? ([...act.color] as typeof act.color) : null;
    n++;
  }
  return n;
}

/** Toggle muting of links. */
export function toggleLinkMute(tree: NodeTreeData, ids: Set<string>) {
  const links = tree.links.filter((l) => ids.has(l.id));
  const mute = !links.every((l) => l.is_muted);
  for (const l of links) {
    if (mute) l.is_muted = true;
    else delete l.is_muted;
  }
}

/**
 * Insert reroutes where a gesture crossed links. Links leaving the same output share one
 * reroute at the average crossing point. Points are in node location space (y up).
 */
export function addReroutes(tree: NodeTreeData, crossings: { link: string; x: number; y: number }[]): NodeData[] {
  const groups = new Map<string, { links: LinkData[]; x: number; y: number }>();
  for (const c of crossings) {
    const l = tree.links.find((x) => x.id === c.link);
    if (!l) continue;
    const key = `${l.from_node}|${l.from_socket}`;
    const g = groups.get(key) ?? { links: [], x: 0, y: 0 };
    g.links.push(l);
    g.x += c.x;
    g.y += c.y;
    groups.set(key, g);
  }
  const made: NodeData[] = [];
  for (const g of groups.values()) {
    const first = g.links[0];
    const r = makeNode(tree, 'NodeReroute', [g.x / g.links.length, g.y / g.links.length]);
    // a reroute inside a frame joins the frame of the nodes it connects when they share one
    const a = nodeById(tree, first.from_node),
      b = nodeById(tree, first.to_node);
    if (a?.parent && a.parent === b?.parent) r.parent = a.parent;
    tree.nodes.push(r);
    tree.links.push({ id: uid('link'), from_node: first.from_node, from_socket: first.from_socket, to_node: r.id, to_socket: 'Input' });
    for (const l of g.links) {
      l.from_node = r.id;
      l.from_socket = 'Output';
    }
    made.push(r);
  }
  return made;
}

/**
 * Nodes to push right when `inserted` lands between nodes: the link's target and everything
 * downstream of it that sits right of the inserted node. Returns the x offset applied.
 */
export function insertOffset(tree: NodeTreeData, inserted: NodeData, widthOf: (n: NodeData) => number, margin = 40): number {
  const right = inserted.location[0] + widthOf(inserted) + margin;
  const next = tree.links.filter((l) => l.from_node === inserted.id).map((l) => nodeById(tree, l.to_node)).filter((n): n is NodeData => !!n && !isFrame(n));
  if (!next.length) return 0;
  const left = Math.min(...next.map((n) => n.location[0]));
  const dx = right - left;
  if (dx <= 0) return 0;
  const moved = new Set<string>();
  const stack = next.map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (moved.has(id) || id === inserted.id) continue;
    const n = nodeById(tree, id);
    if (!n || n.location[0] < inserted.location[0]) continue;
    moved.add(id);
    for (const l of tree.links) if (l.from_node === id) stack.push(l.to_node);
  }
  for (const id of moved) {
    const n = nodeById(tree, id)!;
    n.location = [n.location[0] + dx, n.location[1]];
  }
  return dx;
}

/** Remove the links between the given nodes and the rest of the tree, joining their neighbours where the nodes passed data through. */
export function detachLinks(ctx: SocketContext, ids: Set<string>) {
  const { tree } = ctx;
  const add: LinkData[] = [];
  for (const n of tree.nodes) {
    if (!ids.has(n.id)) continue;
    for (const [inp, out] of internalLinks(ctx, n)) {
      const src = tree.links.find((l) => l.to_node === n.id && l.to_socket === inp.identifier && !ids.has(l.from_node));
      if (!src) continue;
      for (const dst of tree.links.filter((l) => l.from_node === n.id && l.from_socket === out.identifier && !ids.has(l.to_node)))
        add.push({ id: uid('link'), from_node: src.from_node, from_socket: src.from_socket, to_node: dst.to_node, to_socket: dst.to_socket });
    }
  }
  tree.links = tree.links.filter((l) => ids.has(l.from_node) === ids.has(l.to_node));
  tree.links.push(...add);
}

/**
 * Connect a node to the tree's output (Material / World Output, or the Group Output in groups,
 * geometry and compositing trees). Repeating cycles through the node's outputs.
 */
export function connectToOutput(ctx: SocketContext, node: NodeData, target: 'MATERIAL' | 'WORLD' | 'GROUP', socket?: string): LinkData | null {
  const { tree } = ctx;
  const outType = target === 'MATERIAL' ? 'ShaderNodeOutputMaterial' : target === 'WORLD' ? 'ShaderNodeOutputWorld' : 'NodeGroupOutput';
  if (node.type === outType || isFrame(node)) return null;
  const all = nodeSockets(node, ctx).outputs.filter((s) => s.type !== 'CUSTOM');
  // a clicked output socket is used as is; otherwise repeated calls cycle through the outputs
  const outs = socket ? all.filter((s) => s.identifier === socket) : all;
  if (!outs.length) return null;
  let out = target === 'GROUP' ? activeOutputOf(tree, outType) : activeOutput(tree, outType);
  if (!out) {
    out = makeNode(tree, outType, [node.location[0] + (node.width ?? 140) + 80, node.location[1]]);
    tree.nodes.push(out);
  }
  const outNode = out;
  const cur = tree.links.find((l) => l.from_node === node.id && l.to_node === outNode.id);
  const start = cur ? outs.findIndex((s) => s.identifier === cur.from_socket) + 1 : 0;
  for (let k = 0; k < outs.length; k++) {
    const s = outs[(start + k) % outs.length];
    if (cur && outs.length > 1 && s.identifier === cur.from_socket) continue;
    let to: string | undefined;
    if (target === 'GROUP') {
      const ins = nodeSockets(outNode, ctx).inputs.filter((x) => x.type !== 'CUSTOM');
      to = (ins.find((x) => x.type === s.type) ?? (s.type === 'GEOMETRY' ? undefined : ins.find((x) => canConvert(s.type, x.type))))?.identifier;
      if (!to) to = '__extend__';
    } else {
      const ins = nodeSockets(outNode, ctx).inputs;
      to = canConvert(s.type, 'SHADER') ? ins.find((x) => x.identifier === 'Surface')?.identifier : undefined;
    }
    if (!to) continue;
    if (cur) tree.links = tree.links.filter((l) => l !== cur);
    const link = connectLink(ctx, node.id, s.identifier, outNode.id, to);
    if (link) return link;
  }
  return null;
}

function activeOutputOf(tree: NodeTreeData, type: string): NodeData | undefined {
  const outs = tree.nodes.filter((n) => n.type === type && !n.mute);
  return outs.find((n) => n.props.is_active_output) ?? outs[0] ?? tree.nodes.find((n) => n.type === type);
}
