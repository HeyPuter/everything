// Node tree conversion (material / world / group trees) into NodeTreeData.
// Node types keep the idnames stored in the file; inputs are keyed by socket identifier.
import type { NodeData, NodeTreeData, SocketValue, LinkData } from '../../data/types';
import { uid } from '../../data/defaults';
import type { BStruct } from './reader';
import type { Ctx } from './context';
import { NODE_PROP_RULES } from './nodeprops.gen';
import { GEO_NODE_PROP_RULES } from './nodeprops_geo.gen';
import { newZonePending, readZoneNode, finishZones } from './zones';

const NODE_HIDDEN = 8;
const NODE_DO_OUTPUT = 64;
const NODE_MUTED = 512;

function readField(node: BStruct, path: string): number | null {
  if (path.startsWith('socket.')) {
    // value of a menu socket
    const sock = node.list('inputs', 1000).find((s) => s.str('identifier') === path.slice(7));
    const dv = sock?.ref('default_value');
    return dv && dv.has('value') ? dv.num('value') : null;
  }
  if (path.startsWith('storage.')) {
    let s: BStruct | null = node.ref('storage');
    const parts = path.slice(8).split('.');
    for (let i = 0; s && i < parts.length - 1; i++) s = s.sub(parts[i]);
    if (!s || !s.has(parts[parts.length - 1])) return null;
    return s.num(parts[parts.length - 1]);
  }
  return node.has(path) ? node.num(path) : null;
}

function socketValue(sock: BStruct, ctx: Ctx): SocketValue | undefined {
  const dv = sock.ref('default_value');
  if (!dv) return undefined;
  switch (dv.type) {
    case 'bNodeSocketValueFloat':
    case 'bNodeSocketValueInt':
      return dv.num('value');
    case 'bNodeSocketValueBoolean':
      return dv.num('value') !== 0;
    case 'bNodeSocketValueVector': {
      const dims = dv.num('dimensions') || 3;
      return dv.nums('value').slice(0, Math.max(2, Math.min(4, dims)));
    }
    case 'bNodeSocketValueRGBA':
      return dv.nums('value', 4);
    case 'bNodeSocketValueRotation':
      return dv.nums('value_euler', 3);
    case 'bNodeSocketValueString':
      return dv.str('value');
    case 'bNodeSocketValueImage':
      return ctx.image(dv.ref('value'));
    case 'bNodeSocketValueMaterial':
      return ctx.material(dv.ref('value'));
    case 'bNodeSocketValueObject':
      return ctx.objectRef(dv.ref('value'));
    case 'bNodeSocketValueCollection':
      return ctx.collection(dv.ref('value'));
    default:
      return undefined;
  }
}

const RAMP_INTERP = ['LINEAR', 'EASE', 'B_SPLINE', 'CARDINAL', 'CONSTANT'];
const RAMP_MODE = ['RGB', 'HSV', 'HSL'];
const RAMP_HUE = ['NEAR', 'FAR', 'CW', 'CCW'];

function colorRamp(band: BStruct, props: Record<string, SocketValue>) {
  const tot = Math.max(0, Math.min(32, band.num('tot')));
  const flat: number[] = [];
  for (let i = 0; i < tot; i++) {
    const d = band.sub('data', i);
    if (!d) break;
    flat.push(d.num('pos'), d.num('r'), d.num('g'), d.num('b'), d.num('a'));
  }
  props.color_ramp = flat;
  props.ramp_interpolation = RAMP_INTERP[band.num('ipotype')] ?? 'LINEAR';
  props.ramp_color_mode = RAMP_MODE[band.num('color_mode')] ?? 'RGB';
  props.ramp_hue_interpolation = RAMP_HUE[band.num('ipotype_hue')] ?? 'NEAR';
}

function curveMapping(cm: BStruct, kind: 'RGB' | 'VECTOR' | 'FLOAT', props: Record<string, SocketValue>) {
  const n = kind === 'RGB' ? 4 : kind === 'VECTOR' ? 3 : 1;
  props.curve_kind = kind;
  props.curve_active = 0;
  // flag bit 1<<? for extrapolation is not relied upon: default horizontal
  props.curve_extend = 'HORIZONTAL';
  for (let i = 0; i < n; i++) {
    // RGB curves store C in slot 3 and R,G,B in 0..2
    const map = cm.sub('cm', kind === 'RGB' ? (i === 0 ? 3 : i - 1) : i);
    if (!map) continue;
    const pts = map.refArray('curve', map.num('totpoint'));
    const flat: number[] = [];
    for (const p of pts) {
      const fl = p.num('flag');
      flat.push(p.num('x'), p.num('y'), fl & 2 ? 1 : fl & 4 ? 2 : 0);
    }
    if (flat.length) props[`curve_${i}`] = flat;
  }
  if (kind === 'RGB') {
    const black = cm.nums('black', 3),
      white = cm.nums('white', 3);
    if (black.length === 3) props.black_level = black;
    if (white.length === 3) props.white_level = white;
  }
}

/** Convert a bNodeTree. `groupStack` guards against recursive groups. */
export function convertNodeTree(nt: BStruct, type: NodeTreeData['type'], ctx: Ctx, groupStack: Set<number> = new Set()): NodeTreeData {
  const tree: NodeTreeData = { type, nodes: [], links: [] };
  const byOffset = new Map<number, NodeData>();
  const parents: [NodeData, BStruct][] = [];
  const unknownStorage: string[] = [];
  const zones = newZonePending();
  for (const n of nt.list('nodes', 100_000)) {
    const idname = n.str('idname');
    const flag = n.num('flag');
    const loc = n.has('location') ? n.nums('location', 2) : [n.num('locx'), n.num('locy')];
    const node: NodeData = {
      id: uid('node'),
      type: idname,
      name: n.str('name'),
      location: [loc[0] ?? 0, loc[1] ?? 0],
      inputs: {},
      props: {},
    };
    const label = n.str('label');
    if (label) node.label = label;
    const width = n.num('width');
    if (width > 0) node.width = width;
    if (flag & NODE_HIDDEN) node.hide = true;
    if (flag & NODE_MUTED) node.mute = true;
    for (const s of n.list('inputs', 1000)) {
      const v = socketValue(s, ctx);
      if (v !== undefined) node.inputs[s.str('identifier')] = v;
    }
    // output values carried by input-less nodes (Value, RGB, Normal)
    if (idname === 'ShaderNodeValue' || idname === 'ShaderNodeRGB' || idname === 'ShaderNodeNormal') {
      for (const s of n.list('outputs', 100)) {
        const v = socketValue(s, ctx);
        if (v !== undefined) node.props[`outputs.${s.str('identifier')}`] = v;
      }
    }
    const rules = NODE_PROP_RULES[idname] ?? GEO_NODE_PROP_RULES[idname];
    if (rules) {
      for (const [prop, r] of Object.entries(rules)) {
        const raw = readField(n, r.f);
        if (raw === null) continue;
        if (r.e) {
          const item = r.e[raw];
          if (item !== undefined) node.props[prop] = item;
        } else if (r.b !== undefined) node.props[prop] = r.b > 0 ? (raw & r.b) !== 0 : (raw & -r.b) === 0;
      }
    }
    if (idname.startsWith('ShaderNodeOutput')) node.props.is_active_output = (flag & NODE_DO_OUTPUT) !== 0;
    const storage = n.ref('storage');
    const id = n.ref('id');
    if (idname === 'ShaderNodeTexImage' || idname === 'ShaderNodeTexEnvironment') {
      node.props.image = ctx.image(id);
    } else if (idname === 'ShaderNodeValToRGB' && storage?.type === 'ColorBand') {
      colorRamp(storage, node.props);
    } else if ((idname === 'ShaderNodeRGBCurve' || idname === 'ShaderNodeVectorCurve' || idname === 'ShaderNodeFloatCurve') && storage?.type === 'CurveMapping') {
      curveMapping(storage, idname === 'ShaderNodeRGBCurve' ? 'RGB' : idname === 'ShaderNodeVectorCurve' ? 'VECTOR' : 'FLOAT', node.props);
    } else if (idname === 'ShaderNodeGroup' || idname === 'GeometryNodeGroup') {
      node.props.node_tree = id ? convertGroup(id, type, ctx, groupStack) : null;
    }
    readZoneNode(n, node, zones);
    if (storage) {
      // string settings stored by name (attribute / UV map / color layer names)
      if (idname === 'ShaderNodeAttribute' && storage.has('name')) node.props.attribute_name = storage.str('name');
      for (const k of ['uv_map', 'layer_name']) if (storage.has(k)) node.props[k] = storage.str(k);
    } else if (!rules && n.ptr('storage') !== 0 && !idname.match(/^GeometryNode(Repeat|Simulation|ForeachGeometryElement)(Input|Output)$|^GeometryNode(Bake|CaptureAttribute)$/)) unknownStorage.push(idname);
    tree.nodes.push(node);
    byOffset.set(n.offset, node);
    const parent = n.ref('parent');
    if (parent) parents.push([node, parent]);
  }
  for (const [node, p] of parents) {
    const pn = byOffset.get(p.offset);
    if (pn) node.parent = pn.id;
  }
  for (const l of nt.list('links', 1_000_000)) {
    const from = l.ref('fromnode'),
      to = l.ref('tonode'),
      fs = l.ref('fromsock'),
      ts = l.ref('tosock');
    const a = from && byOffset.get(from.offset),
      b = to && byOffset.get(to.offset);
    if (!a || !b || !fs || !ts) continue;
    const link: LinkData = { id: uid('link'), from_node: a.id, from_socket: fs.str('identifier'), to_node: b.id, to_socket: ts.str('identifier') };
    if (l.num('flag') & 16) link.is_muted = true;
    tree.links.push(link);
  }
  finishZones(tree, zones);
  if (unknownStorage.length) ctx.warn.add('Node settings not read', [...new Set(unknownStorage)].join(', '));
  return tree;
}

function socketTypeFromIdname(idname: string) {
  return idname || 'NodeSocketFloat';
}

/** A node group used outside node trees (geometry nodes modifiers); returns its id. */
export function convertGroupTree(gt: BStruct, type: NodeTreeData['type'], ctx: Ctx): string | null {
  return convertGroup(gt, type, ctx, new Set());
}

/** Node groups become NodeGroupData; returns its id. */
export function convertGroup(gt: BStruct, parentType: NodeTreeData['type'], ctx: Ctx, stack: Set<number>): string | null {
  const done = ctx.ids.get(gt.offset);
  if (done) return done;
  if (stack.has(gt.offset)) {
    ctx.warn.add('Recursive node group skipped', gt.idName);
    return null;
  }
  stack.add(gt.offset);
  const tree = convertNodeTree(gt, parentType === 'WORLD' ? 'SHADER' : parentType, ctx, stack);
  stack.delete(gt.offset);
  // interface from the group input/output nodes' sockets (stable across file versions)
  const iface: NonNullable<NodeTreeData['interface']> = [];
  for (const n of gt.list('nodes', 100_000)) {
    const idn = n.str('idname');
    if (idn !== 'NodeGroupInput' && idn !== 'NodeGroupOutput') continue;
    const list = idn === 'NodeGroupInput' ? n.list('outputs') : n.list('inputs');
    for (const s of list) {
      const sid = s.str('idname');
      if (!sid || sid === 'NodeSocketVirtual') continue;
      const identifier = s.str('identifier');
      const inOut = idn === 'NodeGroupInput' ? 'INPUT' : 'OUTPUT';
      if (iface.some((x) => x.identifier === identifier && x.in_out === inOut)) continue;
      const dv = socketValue(s, ctx);
      iface.push({ in_out: inOut, name: s.str('name'), socket_type: socketTypeFromIdname(sid), identifier, ...(dv !== undefined ? { default_value: dv } : {}) });
    }
  }
  tree.interface = iface;
  const id = uid('ng');
  ctx.doc.node_groups[id] = { id, name: gt.idName, tree };
  ctx.ids.set(gt.offset, id);
  return id;
}
