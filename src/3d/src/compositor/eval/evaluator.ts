// Compositor graph evaluation: pulls node outputs on demand from the output nodes (Group Output
// = composite, active Viewer), follows links with implicit conversions, handles reroutes, muted
// nodes (internal pass-through links), frames and node groups, and runs each node's GPU
// implementation. Every intermediate texture is released when the evaluation finishes.
import type { DocumentData, NodeData, NodeTreeData, SocketValue } from '../../data/types';
import { findSocket, getNodeType, inputValue, interfaceSockets, nodeSockets, propValue, socketDefault } from '../../nodes/registry';
import { activeOutput, internalLinks, linkStatus } from '../../nodes/tree';
import { rerouteType } from '../../nodes/common';
import type { SocketContext, SocketDef } from '../../nodes/types';
import type { Gpu, Texture, UniformValue } from '../gpu/gpu';
import { Result, asVec4, convertValue, domainEqual, xfInvert, xfMul, type DataType, type Domain, IDENTITY, type Xform, type Sampling } from './result';
import { pack, readAs } from './convert';

/** Render passes: the built-in ones plus index, cryptomatte (`CryptoObject00`, …) and AOV (`AOV <name>`) passes. */
export type PassName = 'Combined' | 'Depth' | 'Normal' | 'Mist' | (string & {});

/** Render Layers data: top-down float passes of the last render. */
export interface LayerSource {
  width: number;
  height: number;
  /** changes whenever the pixels change (texture cache key) */
  version: string;
  passes: Partial<Record<PassName, Float32Array>>;
}

export interface EvalEnv {
  doc: DocumentData;
  /** compositing resolution (render size) */
  renderSize: [number, number];
  frame: number;
  fps: number;
  layers: LayerSource | null;
  /** id of the viewer node to evaluate (root tree), null for none */
  viewer: string | null;
  /** evaluate the composite output (Group Output) */
  composite: boolean;
  /** values of the root tree's Group Input sockets by identifier (node groups run on an image) */
  groupInputs?: Record<string, Result>;
}

export interface Scope {
  tree: NodeTreeData;
  key: string;
  outer?: { scope: Scope; node: NodeData };
  stack: string[];
}

export type NodeExec = (x: NodeCtx) => void;
/** Node implementations by idname (registered by ops/*.ts). */
export const nodeExecs: Record<string, NodeExec> = {};
export function registerExec(idnames: string | string[], fn: NodeExec) {
  for (const id of Array.isArray(idnames) ? idnames : [idnames]) nodeExecs[id] = fn;
}

export function dataTypeOf(t: SocketDef['type']): DataType {
  switch (t) {
    case 'FLOAT':
    case 'VECTOR':
    case 'RGBA':
    case 'INT':
    case 'BOOLEAN':
    case 'MENU':
    case 'STRING':
      return t;
    case 'ROTATION':
      return 'VECTOR';
    default:
      return 'FLOAT';
  }
}

const isNumeric = (t: DataType) => t === 'FLOAT' || t === 'VECTOR' || t === 'RGBA' || t === 'INT' || t === 'BOOLEAN';

// ---------------------------------------------------------------------------
// shared GPU passes

const CONVERT_PASS = (from: DataType, to: DataType) => `
uniform sampler2D u_src;
layout(location = 0) out vec4 o0;
void main() { vec4 t = cmpPx(u_src); o0 = ${pack(readAs('t', from, to === 'RGBA' ? 'vec4' : to === 'VECTOR' ? 'vec3' : 'float'), to === 'RGBA' ? 'vec4' : to === 'VECTOR' ? 'vec3' : 'float', to)}; }`;

/** Resample an image onto another domain (pixel centres mapped through both transforms). */
const REALIZE_PASS = `
uniform sampler2D u_src;
uniform mat3 u_map;
uniform int u_interp;
uniform int u_extX;
uniform int u_extY;
layout(location = 0) out vec4 o0;
void main() {
  vec2 p = (u_map * vec3(gl_FragCoord.xy, 1.0)).xy;
  o0 = cmpSample(u_src, p, u_interp, u_extX, u_extY);
}`;

const FILL_PASS = `
uniform vec4 u_value;
layout(location = 0) out vec4 o0;
void main() { o0 = u_value; }`;

/**
 * Pixel-space mapping from an output domain to an input domain: p_in = M · p_out (homogeneous).
 * Centres are aligned with an integer offset when only translations differ (pixel exact).
 */
export function realizeMap(out: Domain, inp: Domain): Float32Array {
  const fx = ((((out.w - inp.w) / 2) % 1) + 1) % 1,
    fy = ((((out.h - inp.h) / 2) % 1) + 1) % 1;
  const cOut: Xform = [1, 0, 0, 1, -out.w / 2, -out.h / 2];
  const cIn: Xform = [1, 0, 0, 1, inp.w / 2 + fx, inp.h / 2 + fy];
  const m = xfMul(cIn, xfMul(xfInvert(inp.xf), xfMul(out.xf, cOut)));
  // column-major mat3
  return new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
}

// ---------------------------------------------------------------------------

export class Evaluator {
  readonly errors = new Map<string, string>();
  /** textures allocated during this evaluation (freed by finish()) */
  private transient = new Set<Texture>();
  private memo = new Map<string, Map<string, Result>>();
  private inProgress = new Set<string>();
  /** node ids evaluated in the root tree (for UI feedback) */
  readonly evaluated = new Set<string>();

  constructor(
    readonly gpu: Gpu,
    readonly env: EvalEnv,
  ) {}

  // -------------------------------------------------------------------------
  // GPU helpers

  alloc(w: number, h: number, label?: string): Texture {
    const t = this.gpu.alloc(w, h, label);
    this.transient.add(t);
    return t;
  }

  /** Free an intermediate texture early (when it is certainly not referenced). */
  release(t: Texture) {
    if (this.transient.delete(t)) this.gpu.free(t);
  }

  /** Keep a texture alive after finish() (the caller frees it). */
  keep(t: Texture) {
    this.transient.delete(t);
  }

  pass(key: string, body: string | (() => string), out: Texture | Texture[], uniforms: Record<string, UniformValue>, outputs?: number) {
    const prog = this.gpu.program(key, body, outputs ?? (Array.isArray(out) ? out.length : 1));
    this.gpu.run(prog, out, uniforms);
  }

  /** Texture of a result (single values become 1×1 textures). */
  tex(r: Result): Texture {
    if (r.tex) return r.tex;
    const t = this.alloc(1, 1, 'single');
    const v = asVec4(r.type, r.value ?? 0);
    this.pass('fill', FILL_PASS, t, { u_value: v });
    r.tex = t;
    return t;
  }

  /** Image of a result realized on `d` (a texture with d's size). */
  realize(r: Result, d: Domain): Texture {
    if (!r.domain) {
      const t = this.alloc(d.w, d.h, 'fill');
      if (r.value !== undefined) this.pass('fill', FILL_PASS, t, { u_value: asVec4(r.type, r.value) });
      else
        this.pass('realize', REALIZE_PASS, t, {
          u_src: this.tex(r),
          u_map: new Float32Array([0, 0, 0, 0, 0, 0, 0.5, 0.5, 1]),
          u_interp: 0,
          u_extX: 1,
          u_extY: 1,
        });
      return t;
    }
    if (domainEqual(r.domain, d)) return r.tex!;
    const t = this.alloc(d.w, d.h, 'realize');
    const s = r.sampling;
    this.pass('realize', REALIZE_PASS, t, {
      u_src: r.tex!,
      u_map: realizeMap(d, r.domain),
      u_interp: s.interp,
      u_extX: s.extX,
      u_extY: s.extY,
    });
    return t;
  }

  /** Convert a result to another data type (images through a GPU pass). */
  convert(r: Result, to: DataType): Result {
    if (r.type === to) return r;
    if (!isNumeric(r.type) || !isNumeric(to)) {
      return Result.single(to, convertValue(r.value ?? null, r.type, to));
    }
    if (!r.tex && r.value !== undefined) return Result.single(to, convertValue(r.value, r.type, to));
    const src = r.tex ?? this.tex(r);
    const t = this.alloc(src.w, src.h, 'convert');
    this.pass(`convert:${r.type}:${to}`, CONVERT_PASS(r.type, to), t, {
      u_src: src,
    });
    const out = r.domain ? Result.image(to, t, r.domain, r.sampling) : Object.assign(new Result(to), { tex: t });
    return out;
  }

  /** CPU value of a single result (reads 1×1 GPU results back; images: centre pixel). */
  value(r: Result): SocketValue {
    if (r.value !== undefined) return r.value;
    const t = r.tex;
    if (!t) return 0;
    const px = this.gpu.read(t, Math.floor(t.w / 2), Math.floor(t.h / 2), 1, 1);
    const v = Array.from(px);
    let out: SocketValue;
    switch (r.type) {
      case 'RGBA':
        out = v;
        break;
      case 'VECTOR':
        out = v.slice(0, 3);
        break;
      case 'INT':
        out = Math.trunc(v[0]);
        break;
      case 'BOOLEAN':
        out = v[0] > 0.5;
        break;
      default:
        out = v[0];
    }
    if (!r.domain) r.value = out;
    return out;
  }

  finish() {
    for (const t of this.transient) this.gpu.free(t);
    this.transient.clear();
  }

  // -------------------------------------------------------------------------
  // graph

  rootScope(tree: NodeTreeData): Scope {
    return { tree, key: 'r', stack: [] };
  }

  socketCtx(scope: Scope): SocketContext {
    return { doc: this.env.doc, tree: scope.tree };
  }

  /** Value of an input socket converted to the socket's type. */
  input(scope: Scope, node: NodeData, s: SocketDef): Result {
    const want = dataTypeOf(s.type);
    const link = scope.tree.links.find((l) => l.to_node === node.id && l.to_socket === s.identifier && !l.is_muted);
    if (link) {
      const st = linkStatus(this.socketCtx(scope), link);
      const from = scope.tree.nodes.find((n) => n.id === link.from_node);
      if (st.valid && !st.inactive && from) {
        const outs = this.outputs(scope, from);
        const r = outs.get(link.from_socket);
        if (r) return this.convert(r, want);
      }
    }
    return Result.single(want, inputValue(node, s));
  }

  isLinked(scope: Scope, node: NodeData, id: string) {
    const link = scope.tree.links.find((l) => l.to_node === node.id && l.to_socket === id && !l.is_muted);
    if (!link) return false;
    const st = linkStatus(this.socketCtx(scope), link);
    return st.valid && !st.inactive;
  }

  /** Evaluate (once per scope) the outputs of a node. */
  outputs(scope: Scope, node: NodeData): Map<string, Result> {
    const key = `${scope.key}|${node.id}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const outs = new Map<string, Result>();
    if (this.inProgress.has(key)) {
      this.errors.set(node.id, 'Cycle detected');
      return outs;
    }
    this.inProgress.add(key);
    if (!scope.outer) this.evaluated.add(node.id);
    const sctx = this.socketCtx(scope);
    const sockets = nodeSockets(node, sctx);
    const def = getNodeType(node.type);
    try {
      if (node.type === 'NodeReroute') {
        const t = rerouteType(node, sctx);
        const s = findSocket(node, 'Input', false, sctx);
        if (s && t !== 'CUSTOM') outs.set('Output', this.input(scope, node, { ...s, type: t }));
      } else if (node.mute) {
        for (const [inp, out] of internalLinks(sctx, node)) {
          const r = this.input(scope, node, inp);
          outs.set(out.identifier, this.convert(r, dataTypeOf(out.type)));
        }
      } else if (node.type === 'NodeGroupInput') {
        for (const s of interfaceSockets(scope.tree, 'INPUT')) {
          if (scope.outer) {
            const os = findSocket(scope.outer.node, s.identifier, false, this.socketCtx(scope.outer.scope));
            if (os) {
              outs.set(s.identifier, this.input(scope.outer.scope, scope.outer.node, os));
              continue;
            }
          }
          const given = !scope.outer ? this.env.groupInputs?.[s.identifier] : undefined;
          outs.set(s.identifier, given ?? Result.single(dataTypeOf(s.type), socketDefault(s)));
        }
      } else if (def?.dynamicSockets && node.props.node_tree !== undefined) {
        this.group(scope, node, outs);
      } else if (def && !def.layout) {
        const exec = nodeExecs[def.idname];
        if (exec) exec(new NodeCtx(this, scope, node, outs));
        else if (def.category !== 'output') this.errors.set(node.id, `${def.label} is not supported by the compositor`);
      }
    } catch (e) {
      this.errors.set(node.id, e instanceof Error ? e.message : String(e));
      console.warn(`Compositor: ${node.name}:`, e);
    }
    // missing outputs: socket defaults
    for (const s of sockets.outputs) if (!outs.has(s.identifier)) outs.set(s.identifier, Result.single(dataTypeOf(s.type), socketDefault(s)));
    this.inProgress.delete(key);
    this.memo.set(key, outs);
    return outs;
  }

  private group(scope: Scope, node: NodeData, outs: Map<string, Result>) {
    const gid = node.props.node_tree as string | null;
    const group = gid ? this.env.doc.node_groups[gid] : undefined;
    if (!group) return;
    if (scope.stack.includes(group.id) || scope.stack.length > 32) {
      this.errors.set(node.id, `Recursive node group ${group.name}`);
      return;
    }
    const inner: Scope = {
      tree: group.tree,
      key: `${scope.key}/${node.id}`,
      outer: { scope, node },
      stack: [...scope.stack, group.id],
    };
    const gout = activeOutput(group.tree, 'NodeGroupOutput');
    for (const s of interfaceSockets(group.tree, 'OUTPUT')) {
      if (!gout) {
        outs.set(s.identifier, Result.single(dataTypeOf(s.type), socketDefault(s)));
        continue;
      }
      const gs = findSocket(gout, s.identifier, false, this.socketCtx(inner));
      outs.set(s.identifier, gs ? this.input(inner, gout, gs) : Result.single(dataTypeOf(s.type), socketDefault(s)));
    }
  }

  /** Result of the root tree's composite output (first Group Output input), or null. */
  compositeOutput(tree: NodeTreeData): Result | null {
    const scope = this.rootScope(tree);
    const gout = activeOutput(tree, 'NodeGroupOutput');
    if (!gout) return null;
    this.evaluated.add(gout.id);
    const ins = nodeSockets(gout, this.socketCtx(scope)).inputs.filter((s) => s.type !== 'CUSTOM');
    const s = ins.find((x) => x.type === 'RGBA') ?? ins[0];
    if (!s) return null;
    return this.convert(this.input(scope, gout, s), 'RGBA');
  }

  /** Input of a viewer node. */
  viewerOutput(tree: NodeTreeData, viewer: NodeData): Result {
    const scope = this.rootScope(tree);
    this.evaluated.add(viewer.id);
    const s = findSocket(viewer, 'Image', false, this.socketCtx(scope))!;
    return this.convert(this.input(scope, viewer, s), 'RGBA');
  }
}

// ---------------------------------------------------------------------------

/** Execution context handed to node implementations. */
export class NodeCtx {
  readonly ctx: SocketContext;
  private sockets: { inputs: SocketDef[]; outputs: SocketDef[] };
  private cache = new Map<string, Result>();

  constructor(
    readonly ev: Evaluator,
    readonly scope: Scope,
    readonly node: NodeData,
    readonly outs: Map<string, Result>,
  ) {
    this.ctx = ev.socketCtx(scope);
    this.sockets = nodeSockets(node, this.ctx);
  }

  get env() {
    return this.ev.env;
  }

  get gpu() {
    return this.ev.gpu;
  }

  prop(id: string): SocketValue {
    return propValue(this.node, id);
  }

  str(id: string): string {
    return String(this.prop(id) ?? '');
  }

  socket(id: string, isOutput = false): SocketDef | undefined {
    return (isOutput ? this.sockets.outputs : this.sockets.inputs).find((s) => s.identifier === id) ?? findSocket(this.node, id, isOutput, this.ctx);
  }

  inputSockets() {
    return this.sockets.inputs;
  }

  outputSockets() {
    return this.sockets.outputs;
  }

  /** Input value converted to its socket type. */
  input(id: string): Result {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const s = this.socket(id);
    const r = s ? this.ev.input(this.scope, this.node, s) : Result.single('FLOAT', 0);
    this.cache.set(id, r);
    return r;
  }

  linked(id: string) {
    return this.ev.isLinked(this.scope, this.node, id);
  }

  /** Single value of an input (images contribute their centre pixel). */
  value(id: string): SocketValue {
    return this.ev.value(this.input(id));
  }

  num(id: string, fallback = 0): number {
    const v = this.value(id);
    if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (Array.isArray(v)) return v[0] ?? fallback;
    return fallback;
  }

  vec(id: string, n = 3): number[] {
    const v = this.value(id);
    const a = Array.isArray(v) ? v : [Number(v) || 0];
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(a[i] ?? (a.length === 1 ? a[0] : 0));
    return out;
  }

  bool(id: string): boolean {
    const v = this.value(id);
    return typeof v === 'boolean' ? v : !!v && v !== '0';
  }

  menu(id: string): string {
    const v = this.input(id).value;
    if (typeof v === 'string') return v;
    const s = this.socket(id);
    return String(s?.default ?? '');
  }

  out(id: string, r: Result) {
    const s = this.socket(id, true);
    this.outs.set(id, s ? this.ev.convert(r, dataTypeOf(s.type)) : r);
  }

  error(msg: string) {
    this.ev.errors.set(this.node.id, msg);
  }

  /**
   * Operation domain: the domain of the first image among `ids` (default: all inputs, colour
   * sockets first, factors last), or null when every input is a single value.
   */
  domain(ids?: string[]): Domain | null {
    const order = ids ?? defaultPriority(this.sockets.inputs);
    for (const id of order) {
      const r = this.input(id);
      if (r.domain) return r.domain;
    }
    return null;
  }

  /** Allocate an output texture for a domain. */
  alloc(d: { w: number; h: number }, label?: string): Texture {
    return this.ev.alloc(d.w, d.h, label ?? this.node.type);
  }

  /** Input `id` as a texture realized on `d`. */
  realized(id: string, d: Domain): Texture {
    return this.ev.realize(this.input(id), d);
  }

  pass(key: string, body: string | (() => string), out: Texture | Texture[], uniforms: Record<string, UniformValue>) {
    this.ev.pass(key, body, out, uniforms);
  }

  image(type: DataType, tex: Texture, d: Domain, sampling?: Sampling) {
    return Result.image(type, tex, d, sampling);
  }
}

function defaultPriority(inputs: SocketDef[]): string[] {
  const rank = (s: SocketDef) => (/^(Fac|Factor)/.test(s.identifier) ? 2 : s.type === 'RGBA' ? 0 : 1);
  return inputs
    .map((s, i) => [s, i] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([s]) => s.identifier);
}

export { IDENTITY };
