// Shader node tree → GLSL code generation (pure; no WebGL). The material and world wrappers
// (material.ts, world.ts) embed the generated code into three.js shaders.
//
// Every unlinked socket value becomes a uniform so editing values never recompiles; the
// generated text (and therefore the program cache key) only depends on the graph structure,
// enum properties and a few value-derived feature flags.
import type { DocumentData, NodeData, NodeTreeData, SocketValue } from '../../data/types';
import { findSocket, getNodeType, inputValue, nodeSockets, propValue, socketDefault, interfaceSockets } from '../registry';
import { activeOutput, internalLinks, linkStatus } from '../tree';
import type { SocketDef, SocketType } from '../types';
import { collectLib } from './glsl/lib';
import { rerouteType } from '../common';

export type GType = 'float' | 'vec3' | 'vec4' | 'NdClosure';

export type UniformValue = number | number[] | { kind: 'image'; image: string | null; interpolation: string } | { kind: 'lut'; data: Float32Array; width: number; nearest?: boolean };

export interface UniformSpec {
  name: string;
  type: 'float' | 'vec2' | 'vec3' | 'vec4' | 'sampler2D';
  value: UniformValue;
}

export interface Features {
  transmission: boolean;
  coat: boolean;
  sheen: boolean;
  anisotropy: boolean;
  thinFilm: boolean;
  alpha: boolean;
  displacement: boolean;
  volumeOnly: boolean;
  vertexColor: boolean;
  objectInfo: boolean;
  barycentric: boolean;
}

export interface CompiledTree {
  /** GLSL library functions */
  lib: string;
  /** uniform declarations */
  decls: string;
  /** statements computing `NdClosure ndC` (and `vec3 ndDisp` when displacement is used) */
  body: string;
  uniforms: UniformSpec[];
  features: Features;
  errors: string[];
  /** structural key (identical for trees that differ only in values) */
  key: string;
}

export type Target = 'MATERIAL' | 'WORLD';

/** Marker in the body where the material wrapper applies displacement (bump) to `ndN`. */
export const DISPLACE_MARK = '/*ND_DISPLACE*/';

/** GLSL expressions for the shading context, provided by the wrapper. */
export interface ShadingContext {
  P: string;
  N: string;
  Ng: string;
  I: string;
  uv: string;
  orco: string;
  obj: string;
  objN: string;
  cam: string;
  win: string;
  refl: string;
  col: string;
  back: string;
  tangent: string;
  bary: string;
  /** object info: location, color, alpha, object index, material index, random */
  objLoc: string;
  objColor: string;
  objIndex: string;
  matIndex: string;
  objRandom: string;
  viewPos: string;
}

export const MATERIAL_CONTEXT: ShadingContext = {
  P: 'ndP',
  N: 'ndN',
  Ng: 'ndNg',
  I: 'ndI',
  uv: 'vec3(ndUV, 0.0)',
  orco: 'ndOrco',
  obj: 'ndObj',
  objN: 'ndObjN',
  cam: 'ndCam',
  win: 'ndWin',
  refl: 'ndRefl',
  col: 'ndCol',
  back: 'ndBack',
  tangent: 'ndT',
  bary: 'ndBary',
  objLoc: 'ndObjLoc.xyz',
  objColor: 'ndObjColor',
  objIndex: 'ndObjInfo.y',
  matIndex: 'ndObjInfo.z',
  objRandom: 'ndObjInfo.x',
  viewPos: 'ndViewPos',
};

export const WORLD_CONTEXT: ShadingContext = {
  P: 'ndDir',
  N: '(-ndDir)',
  Ng: '(-ndDir)',
  I: '(-ndDir)',
  uv: 'vec3(0.0)',
  orco: 'ndDir',
  obj: 'ndDir',
  objN: '(-ndDir)',
  cam: 'ndDir',
  win: 'vec3(ndWinUV, 0.0)',
  refl: 'ndDir',
  col: 'vec4(0.0)',
  back: '0.0',
  tangent: 'vec3(1.0, 0.0, 0.0)',
  bary: 'vec3(0.0)',
  objLoc: 'vec3(0.0)',
  objColor: 'vec4(0.0)',
  objIndex: '0.0',
  matIndex: '0.0',
  objRandom: '0.0',
  viewPos: 'ndDir',
};

export function glslType(t: SocketType): GType {
  switch (t) {
    case 'VECTOR':
    case 'ROTATION':
      return 'vec3';
    case 'RGBA':
      return 'vec4';
    case 'SHADER':
      return 'NdClosure';
    default:
      return 'float';
  }
}

export function fmt(v: number) {
  if (!Number.isFinite(v)) return '0.0';
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

export function literal(type: GType, v: SocketValue, N = 'ndN'): string {
  const arr = Array.isArray(v) ? v : [typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : 0];
  if (type === 'float') return fmt(arr.length >= 3 ? (arr.length >= 4 ? arr[0] * 0.2126 + arr[1] * 0.7152 + arr[2] * 0.0722 : (arr[0] + arr[1] + arr[2]) / 3) : arr[0]);
  if (type === 'vec3') return arr.length >= 3 ? `vec3(${fmt(arr[0])}, ${fmt(arr[1])}, ${fmt(arr[2])})` : `vec3(${fmt(arr[0])})`;
  if (type === 'vec4')
    return arr.length >= 4
      ? `vec4(${fmt(arr[0])}, ${fmt(arr[1])}, ${fmt(arr[2])}, ${fmt(arr[3])})`
      : arr.length === 3
        ? `vec4(${fmt(arr[0])}, ${fmt(arr[1])}, ${fmt(arr[2])}, 1.0)`
        : `vec4(vec3(${fmt(arr[0])}), 1.0)`;
  return `nd_cl_empty(${N})`;
}

/** Implicit conversion between GLSL types (implicit socket conversion rules). */
export function convert(expr: string, from: GType, to: GType, N = 'ndN'): string {
  if (from === to) return expr;
  if (to === 'NdClosure') {
    if (from === 'float') return `nd_cl_emission(vec3(${expr}), ${N})`;
    if (from === 'vec3') return `nd_cl_emission(${expr}, ${N})`;
    return `nd_cl_emission((${expr}).rgb, ${N})`;
  }
  if (from === 'NdClosure') return literal(to, 0);
  if (from === 'float') return to === 'vec3' ? `vec3(${expr})` : `vec4(vec3(${expr}), 1.0)`;
  if (from === 'vec3') return to === 'float' ? `dot(${expr}, vec3(1.0 / 3.0))` : `vec4(${expr}, 1.0)`;
  // vec4
  return to === 'float' ? `nd_luma((${expr}).rgb)` : `(${expr}).rgb`;
}

interface Scope {
  tree: NodeTreeData;
  prefix: string;
  /** outer group node context (for Group Input nodes) */
  outer?: { scope: Scope; node: NodeData };
  groupStack: string[];
  /** outputs replaced by loop variables inside repeat zone bodies (node id → outputs) */
  overrides?: Map<string, Outputs>;
}

/** Repeat zone node types (shared with geometry nodes). */
export const REPEAT_INPUT_TYPE = 'GeometryNodeRepeatInput';
export const REPEAT_OUTPUT_TYPE = 'GeometryNodeRepeatOutput';
/** Upper bound of repeat zone iterations in shaders. */
export const MAX_SHADER_ITERATIONS = 4096;

interface RepeatItem {
  id: number;
  name: string;
  socket_type: string;
}
function repeatItems(n: NodeData): RepeatItem[] {
  const raw = n.props.repeat_items;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RepeatItem[]) : [];
  } catch {
    return [];
  }
}
const SHADER_ITEM_TYPES = new Set(['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'ROTATION']);

/** Bundle and closure node types (shared with geometry nodes), resolved while compiling. */
const COMBINE_BUNDLE = 'NodeCombineBundle';
const SEPARATE_BUNDLE = 'NodeSeparateBundle';
const JOIN_BUNDLE = 'NodeJoinBundle';
const GET_BUNDLE_ITEM = 'NodeGetBundleItem';
const STORE_BUNDLE_ITEM = 'NodeStoreBundleItem';
const CLOSURE_INPUT = 'NodeClosureInput';
const CLOSURE_OUTPUT = 'NodeClosureOutput';
const EVALUATE_CLOSURE = 'NodeEvaluateClosure';
export const SHADER_BUNDLE_NODES = [COMBINE_BUNDLE, SEPARATE_BUNDLE, JOIN_BUNDLE, GET_BUNDLE_ITEM, STORE_BUNDLE_ITEM, CLOSURE_INPUT, CLOSURE_OUTPUT, EVALUATE_CLOSURE];

/** A bundle while compiling: named values (GLSL expressions, or nested bundles). */
type CgBundle = Map<string, { expr: string; type: GType } | { bundle: CgBundle }>;
/** A closure while compiling: the zone and the scope it was made in. */
interface CgClosure {
  input: NodeData | undefined;
  output: NodeData;
  scope: Scope;
}

function namedItems(n: NodeData | undefined, key: string): RepeatItem[] {
  if (!n) return [];
  const raw = n.props[key];
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RepeatItem[]) : [];
  } catch {
    return [];
  }
}
const pathParts = (p: string) =>
  p
    .split('/')
    .map((x) => x.trim())
    .filter(Boolean);

type Outputs = Map<string, { expr: string; type: GType }>;

/** API handed to per-node generators. */
export interface NodeGen {
  node: NodeData;
  target: Target;
  ctx: ShadingContext;
  /** input converted to `type` (linked, else uniform value / default) */
  in(id: string, type: GType): string;
  /** linked input converted to `type`, else `fallback` */
  inOr(id: string, type: GType, fallback: string): string;
  linked(id: string): boolean;
  /** raw stored value of an unlinked input (for feature flags) */
  value(id: string): SocketValue;
  /** compile-time value of an input: followed through reroutes, Menu nodes and group inputs */
  staticValue(id: string): SocketValue;
  prop(id: string): SocketValue;
  str(id: string): string;
  out(id: string, type: GType, expr: string): void;
  tmp(type: GType | 'int' | 'NdVor' | 'vec2' | 'mat3' | 'mat4', expr: string): string;
  stmt(code: string): void;
  lib(...names: string[]): void;
  uniform(type: UniformSpec['type'], value: UniformValue): string;
  feature(f: keyof Features): void;
  error(msg: string): void;
  doc: DocumentData;
}

export type NodeGenerator = (g: NodeGen) => void;

export const nodeGenerators: Record<string, NodeGenerator> = {};
export function registerGenerator(idnames: string | string[], gen: NodeGenerator) {
  for (const id of Array.isArray(idnames) ? idnames : [idnames]) nodeGenerators[id] = gen;
}

export class Codegen {
  lines: string[] = [];
  libs = new Set<string>(['nd_math', 'nd_closure']);
  uniforms: UniformSpec[] = [];
  errors: string[] = [];
  features: Features = {
    transmission: false,
    coat: false,
    sheen: false,
    anisotropy: false,
    thinFilm: false,
    alpha: false,
    displacement: false,
    volumeOnly: false,
    vertexColor: false,
    objectInfo: false,
    barycentric: false,
  };
  private cache = new Map<string, Outputs>();
  private inProgress = new Set<string>();
  private vars = 0;
  /** bundle / closure values referenced by token expressions */
  private values = new Map<string, CgBundle | CgClosure>();
  private closureDepth = 0;

  constructor(
    public doc: DocumentData,
    public target: Target,
    public ctx: ShadingContext,
  ) {}

  newVar(prefix = 't') {
    return `${prefix}${this.vars++}`;
  }

  addUniform(type: UniformSpec['type'], value: UniformValue) {
    const name = `ndU${this.uniforms.length}`;
    this.uniforms.push({ name, type, value });
    return name;
  }

  private socketCtx(scope: Scope) {
    return { doc: this.doc, tree: scope.tree };
  }

  /** Expression for an input socket of `node` in `scope`, converted to `type`. */
  inputExpr(scope: Scope, node: NodeData, id: string, type: GType, fallback?: string): string {
    const sctx = this.socketCtx(scope);
    const link = scope.tree.links.find((l) => l.to_node === node.id && l.to_socket === id && !l.is_muted);
    if (link) {
      const st = linkStatus(sctx, link);
      const from = scope.tree.nodes.find((n) => n.id === link.from_node);
      if (st.valid && !st.inactive && from) {
        const outs = this.nodeOutputs(scope, from);
        const o = outs?.get(link.from_socket);
        if (o) return convert(o.expr, o.type, type, this.ctx.N);
      } else if (st.fromType === 'SHADER' && st.toType !== 'SHADER') this.errors.push(`Invalid link into ${node.name}: ${id}`);
    }
    if (fallback !== undefined) return fallback;
    const s = findSocket(node, id, false, sctx);
    if (!s) return literal(type, 0, this.ctx.N);
    if (s.type === 'SHADER') return `nd_cl_empty(${this.ctx.N})`;
    if (s.hide_value) return this.hiddenDefault(s, type);
    const v = inputValue(node, s);
    return convert(this.addUniform(glslType(s.type) === 'vec4' ? 'vec4' : glslType(s.type) === 'vec3' ? 'vec3' : 'float', uniformValue(s, v)), glslType(s.type), type, this.ctx.N);
  }

  private hiddenDefault(s: SocketDef, type: GType) {
    if (s.type === 'VECTOR') {
      const n = s.name;
      if (n === 'Normal' || n.endsWith('Normal')) return convert(this.ctx.N, 'vec3', type);
      if (n === 'Tangent') return convert(this.ctx.tangent, 'vec3', type);
      return convert(this.ctx.orco, 'vec3', type);
    }
    return literal(type, socketDefault(s));
  }

  isLinked(scope: Scope, node: NodeData, id: string) {
    const link = scope.tree.links.find((l) => l.to_node === node.id && l.to_socket === id && !l.is_muted);
    if (!link) return false;
    const st = linkStatus(this.socketCtx(scope), link);
    return st.valid && !st.inactive;
  }

  /**
   * Value of an input known while compiling (menus): the unlinked value, or the value of the
   * constant / group input it is linked to.
   */
  staticValue(scope: Scope, node: NodeData, id: string, depth = 0): SocketValue {
    const link = scope.tree.links.find((l) => l.to_node === node.id && l.to_socket === id && !l.is_muted);
    const sctx = this.socketCtx(scope);
    if (!link || depth > 32) {
      const s = findSocket(node, id, false, sctx);
      return s ? inputValue(node, s) : null;
    }
    const from = scope.tree.nodes.find((n) => n.id === link.from_node);
    if (!from) return null;
    if (from.type === 'NodeReroute') return this.staticValue(scope, from, 'Input', depth + 1);
    if (from.type === 'FunctionNodeInputMenu') return (from.props.value as SocketValue) ?? null;
    if (from.type === 'NodeGroupInput') {
      if (scope.outer) return this.staticValue(scope.outer.scope, scope.outer.node, link.from_socket, depth + 1);
      const s = interfaceSockets(scope.tree, 'INPUT').find((x) => x.identifier === link.from_socket);
      return s ? socketDefault(s) : null;
    }
    return null;
  }

  private token(v: CgBundle | CgClosure) {
    const t = `__nd_value_${this.values.size}`;
    this.values.set(t, v);
    return t;
  }
  /** The bundle linked into an input (empty when none). */
  private bundleIn(scope: Scope, node: NodeData, id: string): CgBundle {
    const v = this.values.get(this.inputExpr(scope, node, id, 'float', '0.0'));
    return v instanceof Map ? v : new Map();
  }
  private bundleGet(b: CgBundle, path: string): { expr: string; type: GType } | { bundle: CgBundle } | undefined {
    const parts = pathParts(path);
    let cur: CgBundle | undefined = b;
    for (let i = 0; cur && i < parts.length; i++) {
      const e: { expr: string; type: GType } | { bundle: CgBundle } | undefined = cur.get(parts[i]);
      if (!e) return undefined;
      if (i === parts.length - 1) return e;
      cur = 'bundle' in e ? e.bundle : undefined;
    }
    return undefined;
  }
  private bundleWith(b: CgBundle, path: string, e: { expr: string; type: GType } | { bundle: CgBundle }): CgBundle {
    const [head, ...rest] = pathParts(path);
    const m: CgBundle = new Map(b);
    if (!head) return m;
    if (!rest.length) m.set(head, e);
    else {
      const cur = m.get(head);
      m.set(head, { bundle: this.bundleWith(cur && 'bundle' in cur ? cur.bundle : new Map(), rest.join('/'), e) });
    }
    return m;
  }
  /** An entry of a bundle as an expression of `type` (defaults when missing or not a value). */
  private entryExpr(e: { expr: string; type: GType } | { bundle: CgBundle } | undefined, socketType: string): { expr: string; type: GType } {
    const t = glslType(socketType as SocketType);
    if (socketType === 'BUNDLE') return { expr: this.token(e && 'bundle' in e ? e.bundle : new Map()), type: 'float' };
    if (!e || 'bundle' in e) return { expr: literal(t, 0, this.ctx.N), type: t };
    return { expr: convert(e.expr, e.type, t, this.ctx.N), type: t };
  }

  /** Bundles and closures: compile-time values passed between nodes by token. */
  private genBundleNode(scope: Scope, node: NodeData, outs: Outputs) {
    const sctx = this.socketCtx(scope);
    const item = (it: RepeatItem) => `Item_${it.id}`;
    switch (node.type) {
      case COMBINE_BUNDLE: {
        let b: CgBundle = new Map();
        for (const it of namedItems(node, 'bundle_items')) {
          if (it.socket_type === 'BUNDLE') b.set(it.name, { bundle: this.bundleIn(scope, node, item(it)) });
          else {
            const t = glslType(it.socket_type as SocketType);
            b = new Map(b).set(it.name, { expr: this.declare(t, this.inputExpr(scope, node, item(it), t)), type: t });
          }
        }
        outs.set('Bundle', { expr: this.token(b), type: 'float' });
        return;
      }
      case SEPARATE_BUNDLE: {
        const b = this.bundleIn(scope, node, 'Bundle');
        for (const it of namedItems(node, 'bundle_items')) outs.set(item(it), this.entryExpr(b.get(it.name), it.socket_type));
        return;
      }
      case JOIN_BUNDLE: {
        const joined: CgBundle = new Map();
        for (const l of scope.tree.links.filter((x) => x.to_node === node.id && x.to_socket === 'Bundle' && !x.is_muted)) {
          const from = scope.tree.nodes.find((n) => n.id === l.from_node);
          const v = from ? this.values.get(this.nodeOutputs(scope, from)?.get(l.from_socket)?.expr ?? '') : undefined;
          if (v instanceof Map) for (const [k, e] of v) if (!joined.has(k)) joined.set(k, e);
        }
        outs.set('Bundle', { expr: this.token(joined), type: 'float' });
        return;
      }
      case GET_BUNDLE_ITEM: {
        const b = this.bundleIn(scope, node, 'Bundle');
        const path = String(this.staticValue(scope, node, 'Path') ?? '');
        const e = this.bundleGet(b, path);
        const type = String(node.props.socket_type ?? 'FLOAT');
        outs.set('Item', this.entryExpr(e, type));
        outs.set('Exists', { expr: e ? '1.0' : '0.0', type: 'float' });
        let rest = b;
        if (this.staticValue(scope, node, 'Remove')) {
          const parts = pathParts(path);
          const parent = parts.length > 1 ? this.bundleGet(b, parts.slice(0, -1).join('/')) : undefined;
          if (parts.length === 1) {
            rest = new Map(b);
            rest.delete(parts[0]);
          } else if (parent && 'bundle' in parent) {
            const inner = new Map(parent.bundle);
            inner.delete(parts[parts.length - 1]);
            rest = this.bundleWith(b, parts.slice(0, -1).join('/'), { bundle: inner });
          }
        }
        outs.set('Bundle', { expr: this.token(rest), type: 'float' });
        return;
      }
      case STORE_BUNDLE_ITEM: {
        const b = this.bundleIn(scope, node, 'Bundle');
        const path = String(this.staticValue(scope, node, 'Path') ?? '');
        const type = String(node.props.socket_type ?? 'FLOAT');
        const t = glslType(type as SocketType);
        const e = type === 'BUNDLE' ? { bundle: this.bundleIn(scope, node, 'Item') } : { expr: this.declare(t, this.inputExpr(scope, node, 'Item', t)), type: t };
        outs.set('Bundle', { expr: this.token(path.trim() ? this.bundleWith(b, path, e) : b), type: 'float' });
        return;
      }
      case CLOSURE_OUTPUT: {
        const input = scope.tree.nodes.find((n) => n.type === CLOSURE_INPUT && n.props.paired_output === node.id);
        outs.set('Closure', { expr: this.token({ input, output: node, scope }), type: 'float' });
        return;
      }
      case CLOSURE_INPUT: {
        // used outside its zone: the defaults
        const out = scope.tree.nodes.find((n) => n.id === node.props.paired_output);
        for (const it of namedItems(out, 'input_items')) outs.set(item(it), this.entryExpr(undefined, it.socket_type));
        return;
      }
      case EVALUATE_CLOSURE: {
        const c = this.values.get(this.inputExpr(scope, node, 'Closure', 'float', '0.0'));
        const ins = namedItems(node, 'input_items'),
          results = namedItems(node, 'output_items');
        if (!c || c instanceof Map || this.closureDepth > 16) {
          if (c && !(c instanceof Map)) this.errors.push(`${node.name}: closures call each other too deeply`);
          for (const it of results) outs.set(item(it), this.entryExpr(undefined, it.socket_type));
          return;
        }
        // the closure body runs where it is evaluated: its inputs become this node's inputs
        const args = new Map<string, { expr: string; type: GType } | { bundle: CgBundle }>();
        for (const it of ins) {
          if (it.socket_type === 'BUNDLE') args.set(it.name, { bundle: this.bundleIn(scope, node, item(it)) });
          else {
            const t = glslType(it.socket_type as SocketType);
            args.set(it.name, { expr: this.declare(t, this.inputExpr(scope, node, item(it), t)), type: t });
          }
        }
        const over: Outputs = new Map();
        for (const it of namedItems(c.output, 'input_items')) over.set(item(it), this.entryExpr(args.get(it.name), it.socket_type));
        const overrides = new Map(c.scope.overrides ?? []);
        if (c.input) overrides.set(c.input.id, over);
        const body: Scope = { ...c.scope, prefix: `${c.scope.prefix}/clo${this.vars++}`, overrides };
        const produced = new Map(namedItems(c.output, 'output_items').map((it) => [it.name, it]));
        this.closureDepth++;
        try {
          for (const it of results) {
            const src = produced.get(it.name);
            if (!src) {
              outs.set(item(it), this.entryExpr(undefined, it.socket_type));
              continue;
            }
            const t = glslType(it.socket_type as SocketType);
            if (it.socket_type === 'BUNDLE') {
              const v = this.values.get(this.inputExpr(body, c.output, item(src), 'float', '0.0'));
              outs.set(item(it), { expr: this.token(v instanceof Map ? v : new Map()), type: 'float' });
            } else outs.set(item(it), { expr: this.declare(t, this.inputExpr(body, c.output, item(src), t)), type: t });
          }
        } finally {
          this.closureDepth--;
        }
        void sctx;
        return;
      }
    }
  }

  /** Repeat zone: a loop whose body is generated with the zone input replaced by loop variables. */
  private genRepeat(scope: Scope, output: NodeData, outs: Outputs) {
    const input = scope.tree.nodes.find((n) => n.type === REPEAT_INPUT_TYPE && n.props.paired_output === output.id);
    const items = repeatItems(output).filter((it) => SHADER_ITEM_TYPES.has(it.socket_type));
    if (!input) {
      this.errors.push(`${output.name}: the repeat zone has no input node`);
      return;
    }
    const tid = (it: RepeatItem) => `Item_${it.id}`;
    const types = items.map((it) => glslType(it.socket_type as SocketType));
    const vars = items.map((it, k) => this.declare(types[k], this.inputExpr(scope, input, tid(it), types[k])));
    const count = this.declare('float', this.inputExpr(scope, input, 'Iterations', 'float'));
    const i = this.newVar('i');
    this.lines.push(`for (int ${i} = 0; ${i} < ${MAX_SHADER_ITERATIONS}; ${i}++) {`, `if (float(${i}) >= ${count}) break;`);
    const inner: Outputs = new Map();
    inner.set('Iteration', { expr: `float(${i})`, type: 'float' });
    items.forEach((it, k) => inner.set(tid(it), { expr: vars[k], type: types[k] }));
    const overrides = new Map(scope.overrides ?? []);
    overrides.set(input.id, inner);
    const body: Scope = { ...scope, prefix: `${scope.prefix}/rep${this.vars++}`, overrides };
    const next = items.map((it, k) => this.declare(types[k], this.inputExpr(body, output, tid(it), types[k], vars[k])));
    items.forEach((_, k) => this.lines.push(`${vars[k]} = ${next[k]};`));
    this.lines.push('}');
    items.forEach((it, k) => outs.set(tid(it), { expr: vars[k], type: types[k] }));
  }

  /** Generate (once) the code for a node and return its output expressions. */
  nodeOutputs(scope: Scope, node: NodeData): Outputs | undefined {
    const over = scope.overrides?.get(node.id);
    if (over) return over;
    const key = `${scope.prefix}|${node.id}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.inProgress.has(key)) {
      this.errors.push(`Cycle at ${node.name}`);
      return undefined;
    }
    this.inProgress.add(key);
    const outs: Outputs = new Map();
    const sctx = this.socketCtx(scope);
    const sockets = nodeSockets(node, sctx);
    const def = getNodeType(node.type);
    if (node.type === 'NodeReroute') {
      const t = glslType(rerouteType(node, sctx));
      outs.set('Output', {
        expr: this.declare(t, this.inputExpr(scope, node, 'Input', t)),
        type: t,
      });
    } else if (node.mute) {
      for (const [inp, out] of internalLinks(sctx, node)) {
        const t = glslType(out.type);
        outs.set(out.identifier, {
          expr: this.declare(t, this.inputExpr(scope, node, inp.identifier, t)),
          type: t,
        });
      }
    } else if (node.type === 'NodeGroupInput') {
      const outer = scope.outer;
      for (const s of interfaceSockets(scope.tree, 'INPUT')) {
        const t = glslType(s.type);
        let expr: string;
        if (outer) expr = this.inputExpr(outer.scope, outer.node, s.identifier, t);
        else expr = literal(t, socketDefault(s));
        outs.set(s.identifier, { expr: this.declare(t, expr), type: t });
      }
    } else if (def?.dynamicSockets && node.props.node_tree !== undefined) {
      this.genGroup(scope, node, outs);
    } else if (SHADER_BUNDLE_NODES.includes(node.type)) {
      this.genBundleNode(scope, node, outs);
    } else if (node.type === REPEAT_OUTPUT_TYPE) {
      this.genRepeat(scope, node, outs);
    } else if (node.type === REPEAT_INPUT_TYPE) {
      // used outside its zone (no loop variables): the initial values pass through
      outs.set('Iteration', { expr: '0.0', type: 'float' });
      for (const s of sockets.outputs)
        if (s.identifier.startsWith('Item_')) {
          const t = glslType(s.type);
          outs.set(s.identifier, { expr: this.declare(t, this.inputExpr(scope, node, s.identifier, t)), type: t });
        }
    } else {
      const gen = nodeGenerators[def?.idname ?? node.type];
      if (!gen) {
        if (def && !def.layout && def.category !== 'output') this.errors.push(`${def.label} is not supported in the viewport`);
      } else {
        const api = this.api(scope, node, outs);
        try {
          gen(api);
        } catch (e) {
          this.errors.push(`${node.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    // fill any missing outputs with defaults
    for (const s of sockets.outputs) {
      if (outs.has(s.identifier)) continue;
      const t = glslType(s.type);
      outs.set(s.identifier, {
        expr: literal(t, t === 'NdClosure' ? 0 : socketDefault(s), this.ctx.N),
        type: t,
      });
    }
    this.inProgress.delete(key);
    this.cache.set(key, outs);
    return outs;
  }

  declare(type: GType | string, expr: string) {
    // bundle / closure tokens are compile-time values, not GLSL
    if (this.values.has(expr)) return expr;
    const v = this.newVar('v');
    this.lines.push(`${type} ${v} = ${expr};`);
    return v;
  }

  private genGroup(scope: Scope, node: NodeData, outs: Outputs) {
    const gid = node.props.node_tree as string | null;
    const group = gid ? this.doc.node_groups[gid] : undefined;
    if (!group) return;
    if (scope.groupStack.includes(group.id)) {
      this.errors.push(`Recursive node group ${group.name}`);
      return;
    }
    const inner: Scope = {
      tree: group.tree,
      prefix: `${scope.prefix}/${node.id}`,
      outer: { scope, node },
      groupStack: [...scope.groupStack, group.id],
    };
    const gout = activeOutput(group.tree, 'NodeGroupOutput');
    for (const s of interfaceSockets(group.tree, 'OUTPUT')) {
      const t = glslType(s.type);
      const expr = gout ? this.inputExpr(inner, gout, s.identifier, t, literal(t, socketDefault(s), this.ctx.N)) : literal(t, socketDefault(s), this.ctx.N);
      outs.set(s.identifier, { expr: this.declare(t, expr), type: t });
    }
  }

  private api(scope: Scope, node: NodeData, outs: Outputs): NodeGen {
    const self = this;
    return {
      node,
      target: this.target,
      ctx: this.ctx,
      doc: this.doc,
      in: (id, type) => self.inputExpr(scope, node, id, type),
      inOr: (id, type, fallback) => self.inputExpr(scope, node, id, type, fallback),
      linked: (id) => self.isLinked(scope, node, id),
      value: (id) => {
        const s = findSocket(node, id, false, self.socketCtx(scope));
        return s ? inputValue(node, s) : null;
      },
      staticValue: (id) => self.staticValue(scope, node, id),
      prop: (id) => propValue(node, id),
      str: (id) => String(propValue(node, id) ?? ''),
      out: (id, type, expr) => {
        outs.set(id, { expr: self.declare(type, expr), type });
      },
      tmp: (type, expr) => self.declare(type, expr),
      stmt: (code) => self.lines.push(code),
      lib: (...names) => names.forEach((n) => self.libs.add(n)),
      uniform: (type, value) => self.addUniform(type, value),
      feature: (f) => (self.features[f] = true),
      error: (msg) => self.errors.push(`${node.name}: ${msg}`),
    };
  }

  /** Root entry: the expression for an input of an output node at the top level. */
  root(tree: NodeTreeData) {
    return { tree, prefix: 'r', groupStack: [] } as Scope;
  }

  finish(): Omit<CompiledTree, 'body'> & { code: string } {
    const lib = collectLib(this.libs);
    const decls = this.uniforms.map((u) => `uniform ${u.type} ${u.name};`).join('\n');
    const code = this.lines.join('\n');
    return {
      lib,
      decls,
      code,
      uniforms: this.uniforms,
      features: this.features,
      errors: this.errors,
      key: '',
    };
  }
}

function uniformValue(s: SocketDef, v: SocketValue): UniformValue {
  const t = glslType(s.type);
  if (t === 'float') return typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : Array.isArray(v) ? (v[0] ?? 0) : 0;
  const arr = Array.isArray(v) ? [...v] : [typeof v === 'number' ? v : 0];
  if (t === 'vec3') return arr.length >= 3 ? arr.slice(0, 3) : [arr[0], arr[0], arr[0]];
  return arr.length >= 4 ? arr.slice(0, 4) : arr.length === 3 ? [...arr, 1] : [arr[0], arr[0], arr[0], 1];
}

/** Simple string hash for structural keys. */
export function hashString(s: string): string {
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 + c, 0x5bd1e995) ^ (h2 >>> 13);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${s.length.toString(36)}`;
}

/**
 * Compile a material or world node tree. For materials the body defines `NdClosure ndC` and
 * `vec3 ndDisp`; for worlds it defines `NdClosure ndC` (background = emission).
 */
export function compileTree(doc: DocumentData, tree: NodeTreeData, target: Target, ctx: ShadingContext = target === 'WORLD' ? WORLD_CONTEXT : MATERIAL_CONTEXT): CompiledTree {
  const cg = new Codegen(doc, target, ctx);
  const scope = cg.root(tree);
  const outType = target === 'WORLD' ? 'ShaderNodeOutputWorld' : 'ShaderNodeOutputMaterial';
  const out = activeOutput(tree, outType);
  let dispLine = 'vec3 ndDisp = vec3(0.0);';
  let surf = `nd_cl_empty(${ctx.N})`;
  if (out) {
    if (target === 'MATERIAL' && cg.isLinked(scope, out, 'Displacement')) {
      cg.features.displacement = true;
      const d = cg.inputExpr(scope, out, 'Displacement', 'vec3');
      dispLine = `vec3 ndDisp = ${d};`;
    }
    const dispCode = cg.lines.splice(0);
    if (cg.isLinked(scope, out, 'Surface')) surf = cg.inputExpr(scope, out, 'Surface', 'NdClosure');
    else if (cg.isLinked(scope, out, 'Volume')) {
      surf = cg.inputExpr(scope, out, 'Volume', 'NdClosure');
      cg.features.volumeOnly = true;
      cg.features.alpha = true;
    } else if (target === 'MATERIAL') surf = `nd_cl_bsdf(vec3(0.0), 0.0, 0.5, 1.5, 0.5, ${ctx.N})`;
    const surfCode = cg.lines.splice(0);
    cg.lines.push(...dispCode, dispLine, DISPLACE_MARK, ...surfCode, `NdClosure ndC = ${surf};`);
  } else {
    cg.errors.push(target === 'WORLD' ? 'No World Output node' : 'No Material Output node');
    cg.lines.push(dispLine, `NdClosure ndC = ${target === 'WORLD' ? `nd_cl_emission(vec3(0.0), ${ctx.N})` : `nd_cl_bsdf(vec3(0.0), 0.0, 0.5, 1.5, 0.5, ${ctx.N})`};`);
  }
  const f = cg.finish();
  const body = f.code;
  const key = hashString(`${target}\n${f.lib}\n${f.decls}\n${body}\n${JSON.stringify(f.features)}`);
  return {
    lib: f.lib,
    decls: f.decls,
    body,
    uniforms: f.uniforms,
    features: f.features,
    errors: f.errors,
    key,
  };
}
