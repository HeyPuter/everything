// Geometry node tree evaluation.
//
// Evaluation is demand driven: the Group Output (and an active Viewer) pull their inputs, which
// evaluates upstream nodes lazily (a Switch only evaluates the branch it selects). Every node
// gets a signature built from its settings, unlinked input values and the signatures of the
// nodes feeding it; results are kept in a per-modifier cache across evaluations, so editing a
// node only recomputes that node and what depends on it.
import type { LinkData, NodeData, NodeTreeData, SocketValue } from '../data/types';
import { findSocket, allSockets, getNodeType, propValue, socketDefault } from '../nodes/registry';
import { ctxOf, internalLinks } from '../nodes/tree';
import { rerouteType } from '../nodes/common';
import type { SocketContext, SocketDef, SocketType } from '../nodes/types';
import { geoExecs, type EvalEnv, type ExecContext, type Val } from './exec';
import { Field, ConstField, convertField, constOf } from './field';
import { GeometrySet } from './geometry';
import type { FieldType } from './types';

export interface NodeCacheEntry {
  sig: string;
  outputs: Record<string, Val>;
  used: number;
  /** warnings raised when the node executed (re-reported on cache hits) */
  warnings?: string[];
}
export type NodeCache = Map<string, NodeCacheEntry>;

export interface EvalLog {
  warnings: Map<string, string[]>;
  /** number of nodes executed (not served from the cache) */
  executed: number;
  generation: number;
}

export const FIELD_TYPES = new Set<SocketType>(['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'ROTATION']);

/** 53-bit string hash (cyrb53). */
export function hash(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Coerce a stored/default socket value to the socket's value type. */
export function coerce(v: SocketValue | undefined, type: SocketType): Val {
  switch (type) {
    case 'FLOAT':
    case 'INT': {
      const n = Array.isArray(v) ? (v[0] ?? 0) : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : 0;
      return type === 'INT' ? Math.round(n) : n;
    }
    case 'BOOLEAN':
      return Array.isArray(v) ? !!v[0] : !!v;
    case 'VECTOR':
    case 'ROTATION':
      return Array.isArray(v) ? [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] : typeof v === 'number' ? [v, v, v] : [0, 0, 0];
    case 'RGBA':
      return Array.isArray(v) ? [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1] : typeof v === 'number' ? [v, v, v, 1] : [0, 0, 0, 1];
    case 'STRING':
      return typeof v === 'string' ? v : '';
    case 'GEOMETRY':
      return GeometrySet.empty();
    case 'MATRIX':
      return Array.isArray(v) && v.length === 16 ? v : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    case 'OBJECT':
    case 'COLLECTION':
    case 'MATERIAL':
    case 'IMAGE':
    case 'FONT':
      return typeof v === 'string' && v ? v : null;
    default:
      return v ?? null;
  }
}

/** Implicit conversion between socket types (fields stay fields). */
export function convertVal(v: Val, from: SocketType, to: SocketType): Val {
  if (from === to || to === 'CUSTOM' || from === 'CUSTOM' || v === undefined) return v;
  if (FIELD_TYPES.has(from) && FIELD_TYPES.has(to)) {
    if (v instanceof Field) return convertField(v, to as FieldType);
    if (typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v)) {
      const f = convertField(new ConstField(from as FieldType, v as number), to as FieldType);
      return (f as ConstField).value as Val;
    }
    return undefined;
  }
  return undefined;
}

const isMulti = (s: SocketDef) => !!s.multiInput;

export class TreeEval {
  private outputsMemo = new Map<string, Record<string, Val>>();
  private sigMemo = new Map<string, string>();
  private visiting = new Set<string>();
  private nodes = new Map<string, NodeData>();
  private linksIn = new Map<string, LinkData[]>();
  private linkedOut = new Set<string>();
  readonly sctx: SocketContext;

  constructor(
    public env: EvalEnv,
    public tree: NodeTreeData,
    public path: string,
    private groupInput: (id: string) => Val,
    private groupInputSig: (id: string) => string,
    public cache: NodeCache,
    public log: EvalLog,
    public depth = 0,
  ) {
    this.sctx = ctxOf(env.doc, tree);
    for (const n of tree.nodes) this.nodes.set(n.id, n);
    for (const l of tree.links) {
      if (l.is_muted) continue;
      const k = `${l.to_node}\u0001${l.to_socket}`;
      const arr = this.linksIn.get(k);
      if (arr) arr.push(l);
      else this.linksIn.set(k, [l]);
      this.linkedOut.add(`${l.from_node}\u0001${l.from_socket}`);
    }
  }

  warn(node: NodeData, msg: string) {
    const key = `${this.path}/${node.id}`;
    const list = this.log.warnings.get(key) ?? [];
    if (!list.includes(msg)) list.push(msg);
    this.log.warnings.set(key, list);
  }

  links(nodeId: string, socket: string): LinkData[] {
    return this.linksIn.get(`${nodeId}\u0001${socket}`) ?? [];
  }

  isUsed(nodeId: string, socket: string) {
    return this.linkedOut.has(`${nodeId}\u0001${socket}`);
  }

  socketType(node: NodeData, socket: string, isOutput: boolean): SocketType {
    if (node.type === 'NodeReroute') return rerouteType(node, this.sctx);
    return findSocket(node, socket, isOutput, this.sctx)?.type ?? 'CUSTOM';
  }

  // -------------------------------------------------------------------------
  // values

  /** Value of an upstream output socket, in that socket's type. */
  private upstream(l: LinkData, depth = 0): Val {
    const from = this.nodes.get(l.from_node);
    if (!from || depth > 256) return undefined;
    if (from.type === 'NodeReroute') {
      const inl = this.links(from.id, 'Input')[0];
      return inl ? this.convertLink(inl, rerouteType(from, this.sctx), depth + 1) : undefined;
    }
    if (from.type === 'NodeGroupInput') return this.groupInput(l.from_socket);
    if (from.mute) {
      const pair = internalLinks(this.sctx, from).find(([, o]) => o.identifier === l.from_socket);
      if (!pair) return undefined;
      const inl = this.links(from.id, pair[0].identifier)[0];
      const v = inl ? this.convertLink(inl, pair[0].type, depth + 1) : coerce(from.inputs[pair[0].identifier] ?? socketDefault(pair[0]), pair[0].type);
      return convertVal(v, pair[0].type, pair[1].type);
    }
    return this.nodeOutputs(from)[l.from_socket];
  }

  private convertLink(l: LinkData, toType: SocketType, depth = 0): Val {
    const from = this.nodes.get(l.from_node);
    if (!from) return undefined;
    const fromType = this.socketType(from, l.from_socket, true);
    return convertVal(this.upstream(l, depth), fromType, toType);
  }

  /** Converted value of a node input (linked or stored). */
  inputValue(node: NodeData, s: SocketDef): Val {
    const ls = this.links(node.id, s.identifier);
    if (ls.length) {
      const v = this.convertLink(ls[ls.length - 1], s.type);
      if (v !== undefined) return v;
    }
    return coerce(node.inputs[s.identifier] ?? socketDefault(s), s.type);
  }

  inputValues(node: NodeData, s: SocketDef): Val[] {
    return this.links(node.id, s.identifier)
      .map((l) => this.convertLink(l, s.type))
      .filter((v) => v !== undefined);
  }

  // -------------------------------------------------------------------------
  // signatures

  private linkSig(l: LinkData, depth = 0): string {
    const from = this.nodes.get(l.from_node);
    if (!from || depth > 256) return '-';
    if (from.type === 'NodeReroute') {
      const inl = this.links(from.id, 'Input')[0];
      return inl ? this.linkSig(inl, depth + 1) : '-';
    }
    if (from.type === 'NodeGroupInput') return `gi:${this.groupInputSig(l.from_socket)}`;
    if (from.mute) {
      const pair = internalLinks(this.sctx, from).find(([, o]) => o.identifier === l.from_socket);
      if (!pair) return 'm-';
      const inl = this.links(from.id, pair[0].identifier)[0];
      return inl ? `m${this.linkSig(inl, depth + 1)}` : `mv${JSON.stringify(from.inputs[pair[0].identifier] ?? null)}`;
    }
    return `${this.signature(from)}.${l.from_socket}`;
  }

  inputSig(node: NodeData, identifier: string): string {
    const ls = this.links(node.id, identifier);
    if (ls.length) return ls.map((l) => this.linkSig(l)).join('+');
    return JSON.stringify(node.inputs[identifier] ?? null);
  }

  signature(node: NodeData): string {
    const memo = this.sigMemo.get(node.id);
    if (memo) return memo;
    if (this.visiting.has(node.id)) return 'cycle';
    this.visiting.add(node.id);
    const { inputs, outputs } = allSockets(node, this.sctx);
    let s = `${node.type}|${JSON.stringify(node.props)}|${JSON.stringify(node.inputs)}`;
    for (const i of inputs) {
      const ls = this.links(node.id, i.identifier);
      if (ls.length) s += `|${i.identifier}<${ls.map((l) => this.linkSig(l)).join('+')}`;
    }
    for (const o of outputs) if (this.isUsed(node.id, o.identifier)) s += `|>${o.identifier}`;
    if (node.type === 'GeometryNodeGroup') {
      const g = node.props.node_tree ? this.env.doc.node_groups[node.props.node_tree as string] : undefined;
      s += `|g${g ? hash(JSON.stringify(g.tree)) : ''}`;
    }
    const ex = geoExecs[node.type];
    if (ex?.sig) s += `|${ex.sig(node, this.env)}`;
    const h = hash(s);
    this.visiting.delete(node.id);
    this.sigMemo.set(node.id, h);
    return h;
  }

  // -------------------------------------------------------------------------
  // node execution

  nodeOutputs(node: NodeData): Record<string, Val> {
    const memo = this.outputsMemo.get(node.id);
    if (memo) return memo;
    if (this.visiting.has(node.id)) return {};
    const path = `${this.path}/${node.id}`;
    const sig = this.signature(node);
    const cached = this.cache.get(path);
    if (cached && cached.sig === sig) {
      cached.used = this.log.generation;
      if (cached.warnings) for (const w of cached.warnings) this.warn(node, w);
      this.outputsMemo.set(node.id, cached.outputs);
      return cached.outputs;
    }
    this.visiting.add(node.id);
    let outputs: Record<string, Val> = {};
    try {
      if (node.type === 'GeometryNodeGroup') outputs = this.groupNode(node, path);
      else {
        const ex = geoExecs[node.type];
        if (!ex) {
          this.warn(node, `Node type "${getNodeType(node.type)?.label ?? node.type}" is not supported in geometry nodes`);
        } else {
          this.log.executed++;
          outputs = ex.exec(this.execContext(node, path));
        }
      }
    } catch (e) {
      this.warn(node, e instanceof Error ? e.message : String(e));
      outputs = {};
    }
    this.visiting.delete(node.id);
    this.outputsMemo.set(node.id, outputs);
    this.cache.set(path, { sig, outputs, used: this.log.generation, warnings: this.log.warnings.get(path) ? [...this.log.warnings.get(path)!] : undefined });
    return outputs;
  }

  private groupNode(node: NodeData, path: string): Record<string, Val> {
    const gid = node.props.node_tree as string | null;
    const g = gid ? this.env.doc.node_groups[gid] : undefined;
    if (!g) return {};
    if (this.depth > 32) {
      this.warn(node, 'Node group nesting is too deep');
      return {};
    }
    const sub = new TreeEval(
      this.env,
      g.tree,
      path,
      (id) => {
        const s = findSocket(node, id, false, this.sctx);
        return s ? this.inputValue(node, s) : undefined;
      },
      (id) => `${this.signature(node)}:${this.inputSig(node, id)}`,
      this.cache,
      this.log,
      this.depth + 1,
    );
    return sub.groupOutputs();
  }

  /** Values of the tree's active Group Output, keyed by interface identifier. */
  groupOutputs(): Record<string, Val> {
    const outs = this.tree.nodes.filter((n) => n.type === 'NodeGroupOutput');
    const gout = outs.find((n) => propValue(n, 'is_active_output') !== false) ?? outs[0];
    const result: Record<string, Val> = {};
    if (!gout) return result;
    for (const s of allSockets(gout, this.sctx).inputs) {
      if (s.type === 'CUSTOM') continue;
      result[s.identifier] = this.inputValue(gout, s);
    }
    return result;
  }

  execContext(node: NodeData, path: string): ExecContext {
    const self = this;
    const ex = geoExecs[node.type];
    const sock = (id: string) => findSocket(node, id, false, self.sctx);
    const singleOf = (id: string): Val => {
      const s = sock(id);
      if (!s) return undefined;
      const v = self.inputValue(node, s);
      if (v instanceof Field) {
        const c = constOf(v);
        if (c !== undefined) return c as Val;
        self.warn(node, `Input "${s.name}" does not support fields`);
        return coerce(node.inputs[s.identifier] ?? socketDefault(s), s.type);
      }
      return v;
    };
    const ctx: ExecContext = {
      node,
      tree: self.tree,
      env: self.env,
      path,
      prop: <T extends SocketValue>(id: string) => propValue(node, id) as T,
      linked: (id) => self.links(node.id, id).length > 0,
      input: (id) => {
        const s = sock(id);
        return s ? self.inputValue(node, s) : undefined;
      },
      geometry: (id) => {
        const s = sock(id);
        if (!s) return GeometrySet.empty();
        if (isMulti(s)) {
          const all = self.inputValues(node, s).filter((g): g is GeometrySet => g instanceof GeometrySet);
          return all[0] ?? GeometrySet.empty();
        }
        const v = self.inputValue(node, s);
        return v instanceof GeometrySet ? v : GeometrySet.empty();
      },
      geometries: (id) => {
        const s = sock(id);
        if (!s) return [];
        return self.inputValues(node, s).filter((g): g is GeometrySet => g instanceof GeometrySet);
      },
      values: (id) => {
        const s = sock(id);
        return s ? self.inputValues(node, s) : [];
      },
      field: (id, type) => {
        const s = sock(id);
        const t = (type ?? (s && FIELD_TYPES.has(s.type) ? s.type : 'FLOAT')) as FieldType;
        if (!s) return new ConstField(t, 0);
        if (!self.links(node.id, id).length && ex?.implicit?.[id]) return convertField(ex.implicit[id](), t);
        const v = self.inputValue(node, s);
        const st = (FIELD_TYPES.has(s.type) ? s.type : t) as FieldType;
        if (v instanceof Field) return convertField(v, t);
        if (v === undefined || v === null || typeof v === 'string' || v instanceof GeometrySet) return new ConstField(t, 0);
        return convertField(new ConstField(st, v as number), t);
      },
      float: (id) => {
        const v = singleOf(id);
        return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) ? (v[0] ?? 0) : 0;
      },
      int: (id) => Math.round(ctx.float(id)),
      bool: (id) => {
        const v = singleOf(id);
        return typeof v === 'boolean' ? v : typeof v === 'number' ? v > 0 : false;
      },
      vector: (id) => {
        const v = singleOf(id);
        return Array.isArray(v) ? [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] : typeof v === 'number' ? [v, v, v] : [0, 0, 0];
      },
      color: (id) => {
        const v = singleOf(id);
        return Array.isArray(v) ? [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1] : typeof v === 'number' ? [v, v, v, 1] : [0, 0, 0, 1];
      },
      string: (id) => {
        const v = singleOf(id);
        return typeof v === 'string' ? v : '';
      },
      idRef: (id) => {
        const v = singleOf(id);
        return typeof v === 'string' && v ? v : null;
      },
      matrix: (id) => {
        const v = singleOf(id);
        return Array.isArray(v) && v.length === 16 ? v : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      },
      used: (out) => self.isUsed(node.id, out),
      anon: (out) => `#${path}:${out}`,
      warn: (m) => self.warn(node, m),
    };
    return ctx;
  }
}

/**
 * Drop cache entries that have not been used for a while. Entries upstream of a cache hit are not
 * visited, so they are kept for some generations to keep re-editing a mid-tree node cheap.
 */
export function pruneCache(cache: NodeCache, generation: number, keep = 24) {
  for (const [k, e] of cache) if (e.used < generation - keep) cache.delete(k);
}
