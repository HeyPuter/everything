// Shader node trees (materials, worlds) in the 4.2 layout. Every node type is written from the
// generated table of new nodes (legacy type number, storage struct and sockets as the host creates
// them); node settings go into custom1/custom2/storage through the reader's own property rules
// (nodeprops.gen.ts) run backwards, so a file read back gives the same settings.
import type { NodeData, NodeTreeData, SocketValue } from '../../../data/types';
import { getNodeType } from '../../../nodes/registry';
// the shader node types (their sockets and default values) register when this module loads
import '../../../nodes/shader/defs';
import { TEX_MAPPING_NODES, texMapping } from '../../../nodes/texmapping';
import { NODE_PROP_RULES } from '../nodeprops.gen';
import { NODE_TYPES, type GenSocket } from './nodes.gen';
import type { Addr, BlendWriter, Struct } from './container';

const NODE_SELECT = 1;
const NODE_OPTIONS = 2;
const NODE_HIDDEN = 8;
const NODE_DO_OUTPUT = 64;
const NODE_MUTED = 512;
const NODE_INIT = 1 << 16;
const SOCK_IN = 1;
const SOCK_OUT = 2;
const SOCK_HIDDEN = 2;
const LINK_VALID = 2;
const LINK_MUTED = 16;
const FLT_MAX = 3.4028234663852886e38;

export interface NodeTreeContext {
  /** address of an image data-block by document id (0 when it is not written) */
  image: (id: string | null | undefined) => Addr;
  warn: (msg: string) => void;
  /** name of the owner, for messages */
  owner: string;
}

const RAMP_INTERP = ['LINEAR', 'EASE', 'B_SPLINE', 'CARDINAL', 'CONSTANT'];
const RAMP_MODE = ['RGB', 'HSV', 'HSL'];
const RAMP_HUE = ['NEAR', 'FAR', 'CW', 'CCW'];

/** Whether every node of the tree can be written (unknown node types make the caller fall back). */
export function unsupportedNodes(tree: NodeTreeData): string[] {
  return [...new Set(tree.nodes.filter((n) => !NODE_TYPES[n.type]).map((n) => n.type))];
}

function setField(st: Struct, path: string, value: number) {
  if (!st.has(path)) return;
  st.set(path, value);
}

/** Node settings → custom1/custom2/storage fields (inverse of the reader's rules). */
function applyProps(node: NodeData, bn: Struct, storage: Struct | null) {
  const rules = NODE_PROP_RULES[node.type];
  if (!rules) return;
  for (const [prop, r] of Object.entries(rules)) {
    const v = node.props[prop];
    if (v === undefined || v === null) continue;
    const target = r.f.startsWith('storage.') ? storage : r.f.startsWith('socket.') ? null : bn;
    const path = r.f.startsWith('storage.') ? r.f.slice(8) : r.f;
    if (!target || !target.has(path)) continue;
    if (r.e) {
      const hit = Object.entries(r.e).find(([, item]) => item === v);
      if (hit) target.set(path, +hit[0]);
    } else if (r.b !== undefined) {
      const bits = Math.abs(r.b);
      const on = r.b > 0 ? !!v : !v;
      target.flag(path, bits, on);
    }
  }
}

function socketValueStruct(w: BlendWriter, type: string, value: SocketValue | undefined, def: { min?: number; max?: number } | undefined, image: NodeTreeContext['image']): Struct | null {
  if (!type) return null;
  const st = w.struct(type);
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? +v : d);
  switch (type) {
    case 'bNodeSocketValueFloat':
    case 'bNodeSocketValueInt':
      st.set('value', num(value));
      st.set('min', def?.min ?? (type === 'bNodeSocketValueInt' ? -2147483648 : -FLT_MAX));
      st.set('max', def?.max ?? (type === 'bNodeSocketValueInt' ? 2147483647 : FLT_MAX));
      break;
    case 'bNodeSocketValueBoolean':
      st.set('value', value ? 1 : 0);
      break;
    case 'bNodeSocketValueVector': {
      const v = Array.isArray(value) ? value : [0, 0, 0];
      st.set('value', [num(v[0]), num(v[1]), num(v[2])]);
      st.set('min', def?.min ?? -FLT_MAX).set('max', def?.max ?? FLT_MAX);
      break;
    }
    case 'bNodeSocketValueRGBA': {
      const v = Array.isArray(value) ? value : [0, 0, 0, 1];
      st.set('value', [num(v[0]), num(v[1]), num(v[2]), num(v[3], 1)]);
      break;
    }
    case 'bNodeSocketValueString':
      st.set('value', typeof value === 'string' ? value : '');
      break;
    case 'bNodeSocketValueImage':
      st.ptr('value', image(typeof value === 'string' ? value : null));
      break;
    default:
      // object / collection / material / texture values: left empty
      break;
  }
  return st;
}

/** Writes a ColorBand from the color ramp props. */
function writeColorRamp(storage: Struct, props: Record<string, SocketValue>) {
  const flat = Array.isArray(props.color_ramp) ? (props.color_ramp as number[]) : null;
  if (flat && flat.length >= 5) {
    const n = Math.min(32, Math.floor(flat.length / 5));
    storage.set('tot', n);
    for (let i = 0; i < n; i++) {
      const d = storage.sub('data').layout; // CBData layout (array element)
      void d;
    }
    // CBData[32] is an embedded array: fill element by element through raw offsets
    const field = storage.layout.byName.get('data')!;
    const elem = field.struct!;
    for (let i = 0; i < n; i++) {
      const at = (name: string) => elem.byName.get(name)!.offset;
      const base = field.offset + i * elem.size;
      const dv = new DataView(storage.bytes.buffer, storage.bytes.byteOffset, storage.bytes.byteLength);
      const [pos, r, g, b, a] = flat.slice(i * 5, i * 5 + 5);
      dv.setFloat32(base + at('pos'), pos, true);
      dv.setFloat32(base + at('r'), r, true);
      dv.setFloat32(base + at('g'), g, true);
      dv.setFloat32(base + at('b'), b, true);
      dv.setFloat32(base + at('a'), a, true);
    }
  }
  const pick = (list: string[], v: SocketValue | undefined) => Math.max(0, list.indexOf(String(v)));
  if (props.ramp_interpolation !== undefined) storage.set('ipotype', pick(RAMP_INTERP, props.ramp_interpolation));
  if (props.ramp_color_mode !== undefined) storage.set('color_mode', pick(RAMP_MODE, props.ramp_color_mode));
  if (props.ramp_hue_interpolation !== undefined) storage.set('ipotype_hue', pick(RAMP_HUE, props.ramp_hue_interpolation));
}

/** A CurveMapping (RGB / Vector / Float Curves): every curve gets its own point array. */
function writeCurveMapping(w: BlendWriter, storage: Struct, node: NodeData) {
  const kind = node.type === 'ShaderNodeRGBCurve' ? 'RGB' : node.type === 'ShaderNodeVectorCurve' ? 'VECTOR' : 'FLOAT';
  const n = kind === 'RGB' ? 4 : kind === 'VECTOR' ? 3 : 1;
  const extend = node.props.curve_extend === 'EXTRAPOLATED';
  storage.flag('flag', 16, extend);
  const field = storage.layout.byName.get('cm')!;
  const mapLayout = field.struct!;
  for (let slot = 0; slot < 4; slot++) {
    // RGB curves store C in slot 3 and R,G,B in 0..2
    const i = kind === 'RGB' ? (slot === 3 ? 0 : slot + 1) : slot;
    const map = new (storage.constructor as new (l: typeof mapLayout, b: Uint8Array, o: number) => Struct)(mapLayout, storage.bytes, field.offset + slot * mapLayout.size);
    let pts: number[] = [];
    if (i < n) {
      const flat = node.props[`curve_${i}`];
      pts = Array.isArray(flat) && flat.length >= 6 ? (flat as number[]) : [];
    }
    if (!pts.length) pts = kind === 'VECTOR' ? [-1, -1, 0, 1, 1, 0] : [0, 0, 0, 1, 1, 0];
    const list: Struct[] = [];
    for (let k = 0; k + 2 < pts.length; k += 3) {
      const p = w.struct('CurveMapPoint').set('x', pts[k]).set('y', pts[k + 1]);
      p.set('flag', pts[k + 2] === 1 ? 2 : pts[k + 2] === 2 ? 4 : 0);
      list.push(p);
    }
    map.set('totpoint', list.length);
    map.ptr('curve', w.write('DATA', list));
  }
  if (kind === 'RGB') {
    const black = node.props.black_level,
      white = node.props.white_level;
    if (Array.isArray(black)) storage.set('black', black as number[]);
    if (Array.isArray(white)) storage.set('white', white as number[]);
  }
}

/**
 * Writes an embedded node tree (DATA block after its owner's ID block) at `addr`.
 * Nodes of types the table does not have are left out (with a message).
 */
export function writeNodeTree(w: BlendWriter, tree: NodeTreeData, addr: Addr, owner: Addr, ctx: NodeTreeContext): Addr {
  const nt = w.struct('bNodeTree');
  nt.set('id.name', 'NTShader Nodetree').set('id.flag', 1024).set('idname', 'ShaderNodeTree').set('type', 0);
  nt.ptr('owner_id', owner);
  const slot = w.reserve();

  const nodes = tree.nodes.filter((n) => NODE_TYPES[n.type]);
  const skipped = tree.nodes.filter((n) => !NODE_TYPES[n.type]);
  if (skipped.length) ctx.warn(`Nodes not stored in .blend files: ${[...new Set(skipped.map((n) => n.type))].join(', ')} (${ctx.owner})`);
  const nodeAddr = new Map<string, Addr>(nodes.map((n) => [n.id, w.addr()]));
  const sockAddr = new Map<string, Addr>(); // `${nodeId}|in|${identifier}`
  const names = new Set<string>();
  const outputsSeen = new Set<string>();
  const nodeStructs: { st: Struct; addr: Addr }[] = [];

  nodes.forEach((node, idx) => {
    const [legacyType, storageType, storageDefaults, genIn, genOut, genWidth] = NODE_TYPES[node.type];
    const def = getNodeType(node.type);
    const bn = w.struct('bNode');
    let name = node.name || def?.label || node.type;
    for (let k = 1; names.has(name); k++) name = `${node.name}.${String(k).padStart(3, '0')}`;
    names.add(name);
    bn.set('name', name).set('idname', node.type).set('type', legacyType).set('identifier', idx + 1).set('ui_order', idx);
    if (node.label) bn.set('label', node.label);
    let flag = NODE_INIT | NODE_OPTIONS | (node.select ? NODE_SELECT : 0);
    if (node.hide) flag |= NODE_HIDDEN;
    if (node.mute) flag |= NODE_MUTED;
    if (node.type.startsWith('ShaderNodeOutput')) {
      const active = node.props.is_active_output !== false && !outputsSeen.has(node.type);
      if (active) {
        flag |= NODE_DO_OUTPUT;
        outputsSeen.add(node.type);
      }
    }
    if (node.hide_options) flag &= ~NODE_OPTIONS;
    bn.set('flag', flag);
    bn.set('locx', node.location[0]).set('locy', node.location[1]);
    bn.set('width', node.width ?? genWidth ?? 140).set('height', 100);
    if (node.use_custom_color && node.color) bn.set('color', node.color).flag('flag', 1 << 4, false);

    // storage
    let storage: Struct | null = null;
    if (storageType) {
      storage = w.struct(storageType);
      for (const [k, v] of Object.entries(storageDefaults)) if (storage.has(k)) storage.set(k, v as never);
      if (node.type === 'ShaderNodeValToRGB') writeColorRamp(storage, node.props);
      if (storageType === 'CurveMapping') writeCurveMapping(w, storage, node);
      if (TEX_MAPPING_NODES.has(node.type) && storage.has('base.tex_mapping.loc')) {
        const tm = texMapping(node);
        const axes = ['NONE', 'X', 'Y', 'Z'];
        storage.set('base.tex_mapping.type', Math.max(0, ['POINT', 'TEXTURE', 'VECTOR', 'NORMAL'].indexOf(tm.vector_type)));
        storage.set('base.tex_mapping.loc', tm.translation).set('base.tex_mapping.rot', tm.rotation).set('base.tex_mapping.size', tm.scale);
        storage.set('base.tex_mapping.projx', Math.max(0, axes.indexOf(tm.mapping_x)));
        storage.set('base.tex_mapping.projy', Math.max(0, axes.indexOf(tm.mapping_y)));
        storage.set('base.tex_mapping.projz', Math.max(0, axes.indexOf(tm.mapping_z)));
      }
      if (node.type === 'ShaderNodeAttribute' && typeof node.props.attribute_name === 'string' && storage.has('name')) storage.set('name', node.props.attribute_name);
      for (const k of ['uv_map', 'layer_name']) if (typeof node.props[k] === 'string' && storage.has(k)) storage.set(k, node.props[k] as string);
    }
    applyProps(node, bn, storage);
    if (node.type === 'ShaderNodeTexImage' || node.type === 'ShaderNodeTexEnvironment') {
      const im = ctx.image(typeof node.props.image === 'string' ? node.props.image : null);
      if (im) bn.ptr('id', im);
    }

    // sockets: every socket of the type, with the node's values
    const writeSockets = (gen: GenSocket[], inOut: number) => {
      const structs: Struct[] = [];
      const addrs: Addr[] = [];
      for (const [identifier, sname, idname, stype, valueType] of gen) {
        const so = w.struct('bNodeSocket');
        so.set('identifier', identifier).set('name', sname).set('idname', idname).set('type', stype).set('in_out', inOut);
        so.set('limit', inOut === SOCK_IN ? 1 : 4095);
        if (node.hidden_sockets?.includes(`${inOut === SOCK_IN ? 'in' : 'out'}:${identifier}`)) so.flag('flag', SOCK_HIDDEN, true);
        const sockDef = (inOut === SOCK_IN ? def?.inputs : def?.outputs)?.find((s) => s.identifier === identifier);
        const value = inOut === SOCK_IN ? (node.inputs[identifier] ?? sockDef?.default) : node.props[`outputs.${identifier}`];
        const hasValue = value !== undefined || inOut === SOCK_OUT;
        if (valueType && hasValue) {
          const dv = socketValueStruct(w, valueType, value ?? sockDef?.default, sockDef, ctx.image);
          if (dv) so.ptr('default_value', w.write('DATA', dv));
        } else if (valueType) {
          // no value known: a value struct with the type's neutral value keeps the socket valid
          const dv = socketValueStruct(w, valueType, undefined, sockDef, ctx.image);
          if (dv) so.ptr('default_value', w.write('DATA', dv));
        }
        const a = w.addr();
        sockAddr.set(`${node.id}|${inOut}|${identifier}`, a);
        structs.push(so);
        addrs.push(a);
      }
      structs.forEach((s, i) => {
        if (i > 0) s.ptr('prev', addrs[i - 1]);
        if (i < structs.length - 1) s.ptr('next', addrs[i + 1]);
      });
      return { structs, addrs };
    };
    const ins = writeSockets(genIn, SOCK_IN);
    const outs = writeSockets(genOut, SOCK_OUT);
    if (ins.addrs.length) bn.list('inputs', ins.addrs[0], ins.addrs[ins.addrs.length - 1]);
    if (outs.addrs.length) bn.list('outputs', outs.addrs[0], outs.addrs[outs.addrs.length - 1]);
    ins.structs.forEach((s, i) => w.write('DATA', s, ins.addrs[i]));
    outs.structs.forEach((s, i) => w.write('DATA', s, outs.addrs[i]));
    if (storage) bn.ptr('storage', w.write('DATA', storage));
    nodeStructs.push({ st: bn, addr: nodeAddr.get(node.id)! });
  });

  // parents (frames), list order
  nodes.forEach((node, i) => {
    const { st } = nodeStructs[i];
    if (node.parent && nodeAddr.has(node.parent)) st.ptr('parent', nodeAddr.get(node.parent)!);
    if (i > 0) st.ptr('prev', nodeStructs[i - 1].addr);
    if (i < nodeStructs.length - 1) st.ptr('next', nodeStructs[i + 1].addr);
  });
  nodeStructs.forEach(({ st, addr: a }) => w.write('DATA', st, a));
  if (nodeStructs.length) nt.list('nodes', nodeStructs[0].addr, nodeStructs[nodeStructs.length - 1].addr);

  // links
  const links: { st: Struct; addr: Addr }[] = [];
  for (const l of tree.links) {
    const fn = nodeAddr.get(l.from_node),
      tn = nodeAddr.get(l.to_node);
    const fs = sockAddr.get(`${l.from_node}|${SOCK_OUT}|${l.from_socket}`),
      ts = sockAddr.get(`${l.to_node}|${SOCK_IN}|${l.to_socket}`);
    if (!fn || !tn || !fs || !ts) continue;
    const st = w.struct('bNodeLink');
    st.ptr('fromnode', fn).ptr('tonode', tn).ptr('fromsock', fs).ptr('tosock', ts);
    st.set('flag', LINK_VALID | (l.is_muted ? LINK_MUTED : 0));
    links.push({ st, addr: w.addr() });
  }
  links.forEach((l, i) => {
    if (i > 0) l.st.ptr('prev', links[i - 1].addr);
    if (i < links.length - 1) l.st.ptr('next', links[i + 1].addr);
  });
  links.forEach((l) => w.write('DATA', l.st, l.addr));
  if (links.length) nt.list('links', links[0].addr, links[links.length - 1].addr);
  return w.fill(slot, 'DATA', nt, addr);
}
