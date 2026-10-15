// Driver evaluation: variables read properties and transforms of other data-blocks, the driver
// combines them (scripted expression, average, sum, min, max) and its F-Curve maps the result to
// the driven property's value. Expressions run in the sandboxed evaluator of driverexpr.ts.
import type { DocumentData, Driver, DriverIdType, DriverTarget, DriverVariable, FCurve, ObjectData, PoseBone } from '../data/types';
import { getValue, resolve, tokenize } from '../data/rna';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { localMatrix, poseBoneMatrix, threeOrder, toMatrix4 } from '../eval/transform';
import { compileExpr, exprErrorText, runExpr, PY_KEYWORDS, type ExprEnv, type RefValue } from './driverexpr';
import { evaluateFCurve } from './fcurve';
import type { RotationMode } from '../data/types';

// ---------------------------------------------------------------------------
// expression helpers kept for number fields and transform input ("2*pi/3")

type Compiled = ReturnType<typeof compileExpr>;

export function parseExpression(src: string): Compiled {
  return compileExpr(src);
}

export function evalExpression(node: Compiled, vars: Record<string, number>): number {
  return runExpr(node, { vars });
}

// ---------------------------------------------------------------------------
// evaluation context

/** Evaluated state the driver can read (world matrices, poses); falls back to document values. */
export interface DriverContext {
  world?: (id: string) => Matrix4 | undefined;
  /** world matrix before constraints */
  basis?: (id: string) => Matrix4 | undefined;
  /** evaluated pose bone matrices (armature space) */
  bone?: (id: string, bone: string) => { pose: Matrix4; rest: Matrix4; parent: string | null } | undefined;
  /** active object (Context Property ▸ Active View Layer) */
  activeObject?: () => ObjectData | null;
}

export class DriverError extends Error {}

const ID_TABLES: Record<DriverIdType, keyof DocumentData | null> = {
  OBJECT: 'objects',
  SCENE: null,
  MESH: 'meshes',
  CURVE: 'curves',
  LIGHT: 'lights',
  CAMERA: 'cameras',
  ARMATURE: 'armatures',
  LATTICE: 'lattices',
  MATERIAL: 'materials',
  WORLD: 'worlds',
  IMAGE: 'images',
  ACTION: 'actions',
  NODETREE: 'node_groups',
  TEXT: 'texts',
  COLLECTION: 'collections',
  PARTICLE: 'particles',
};

/** Data-blocks of an ID type: [id, name]. */
export function idsOfType(doc: DocumentData, type: DriverIdType): { id: string; name: string }[] {
  if (type === 'SCENE') return [{ id: 'scene', name: doc.scene.name || 'Scene' }];
  const table = ID_TABLES[type];
  const t = table ? (doc[table] as Record<string, { id?: string; name?: string }> | undefined) : undefined;
  if (!t) return [];
  if (type === 'OBJECT') return doc.object_order.filter((id) => t[id]).map((id) => ({ id, name: t[id].name ?? id }));
  return Object.entries(t).map(([id, v]) => ({ id, name: v?.name ?? id }));
}

/** The data-block a target refers to, or undefined. */
export function targetBlock(doc: DocumentData, t: DriverTarget): Record<string, unknown> | undefined {
  if (!t.id) return undefined;
  const type = t.id_type ?? 'OBJECT';
  if (type === 'SCENE') return doc.scene as unknown as Record<string, unknown>;
  const table = ID_TABLES[type];
  return table ? ((doc[table] as Record<string, Record<string, unknown>> | undefined)?.[t.id] ?? undefined) : undefined;
}

const targetObject = (doc: DocumentData, t: DriverTarget | undefined): ObjectData | undefined =>
  t?.id && (t.id_type ?? 'OBJECT') === 'OBJECT' ? doc.objects[t.id] : undefined;

/** Read a path on a plain data-block (not an object): props, ["name"] lookups and [index]. */
export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  let tokens;
  try {
    tokens = tokenize(path);
  } catch {
    return undefined;
  }
  for (const tok of tokens) {
    if (cur == null || typeof cur !== 'object') return undefined;
    const o = cur as Record<string, unknown>;
    if (tok.kind === 'prop') {
      if (tok.name in o) cur = o[tok.name];
      else if (tok.name === 'key_blocks' && Array.isArray(o)) cur = o;
      else if (tok.name === 'nodes' && o.tree && typeof o.tree === 'object') cur = (o.tree as Record<string, unknown>).nodes;
      else if (tok.name === 'default_value') continue;
      else return undefined;
    } else if (tok.kind === 'key') {
      if (Array.isArray(o)) cur = o.find((x) => x && typeof x === 'object' && ((x as { name?: string }).name === tok.key || (x as { identifier?: string }).identifier === tok.key));
      else cur = o[tok.key];
    } else cur = (o as unknown as unknown[])[tok.index];
  }
  return cur;
}

function numeric(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

/** Value of a Single Property / Context Property target. Throws DriverError when it can't be read. */
function propertyValue(doc: DocumentData, v: DriverVariable, ctx: DriverContext): number {
  const t = v.targets[0];
  if (!t) throw new DriverError('Invalid target');
  const fallback = () => {
    if (t.use_fallback_value) return t.fallback_value ?? 0;
    return undefined;
  };
  const noPath = () => {
    const fb = fallback();
    if (fb !== undefined) return fb;
    throw new DriverError('Invalid target channel: no path');
  };
  let raw: unknown;
  if (v.type === 'CONTEXT_PROP') {
    if (!t.data_path) return noPath();
    const root = t.context_property === 'ACTIVE_VIEW_LAYER' ? viewLayerRoot(ctx) : doc.scene;
    raw = readPath(root, t.data_path);
  } else {
    const block = targetBlock(doc, t);
    if (!block) {
      const fb = fallback();
      if (fb !== undefined) return fb;
      throw new DriverError(t.id ? 'Invalid target: data-block not found' : 'Invalid target: no data-block chosen');
    }
    if (!t.data_path) return noPath();
    if ((t.id_type ?? 'OBJECT') === 'OBJECT') {
      try {
        raw = getValue(doc, block as unknown as ObjectData, t.data_path);
      } catch {
        raw = undefined;
      }
    } else raw = readPath(block, t.data_path);
  }
  const n = numeric(raw);
  if (n === undefined) {
    const fb = fallback();
    if (fb !== undefined) return fb;
    if (raw !== undefined && typeof raw === 'object') throw new DriverError('Invalid target channel: path points to a group of values (add an index like [0])');
    throw new DriverError(`Invalid target channel: '${t.data_path}' not found`);
  }
  return n;
}

function viewLayerRoot(ctx: DriverContext) {
  const active = ctx.activeObject?.() ?? null;
  return { name: 'ViewLayer', objects: { active }, use: true };
}

// ---------------------------------------------------------------------------
// transforms

function parentMatrixOf(doc: DocumentData, ob: ObjectData, ctx: DriverContext, depth = 0): Matrix4 {
  if (!ob.parent || depth > 64) return new Matrix4();
  const p = doc.objects[ob.parent];
  if (!p) return new Matrix4();
  return worldOf(doc, p, ctx, depth + 1).clone().multiply(toMatrix4(ob.matrix_parent_inverse));
}

/** Evaluated world matrix (after constraints), or one built from the document (parents only). */
function worldOf(doc: DocumentData, ob: ObjectData, ctx: DriverContext, depth = 0): Matrix4 {
  const w = ctx.world?.(ob.id);
  if (w) return w;
  return parentMatrixOf(doc, ob, ctx, depth).multiply(localMatrix(ob, new Matrix4()));
}

interface TargetXform {
  m: Matrix4;
  /** raw channel values for Local Space (keeps Euler angles outside ±180°) */
  raw?: { loc: number[]; euler?: number[]; order?: RotationMode; scale: number[] };
  /** Euler order and values the rotation channels follow in AUTO mode */
  order: RotationMode;
  compat?: number[];
}

function boneOf(ob: ObjectData, name: string | undefined): PoseBone | undefined {
  return name && ob.type === 'ARMATURE' ? (ob.pose?.[name] ?? undefined) : undefined;
}

function restOf(doc: DocumentData, ob: ObjectData, bone: string): Matrix4 | undefined {
  const arm = ob.data ? doc.armatures[ob.data] : undefined;
  const b = arm?.bones.find((x) => x.name === bone);
  if (!b) return undefined;
  const m = new Matrix4();
  const head = new Vector3(...b.head),
    tail = new Vector3(...b.tail);
  const y = tail.clone().sub(head).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), y);
  if (y.y < -0.99999) q.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
  q.premultiply(new Quaternion().setFromAxisAngle(y, b.roll));
  m.makeRotationFromQuaternion(q).setPosition(head);
  return m;
}

/** Matrix (and raw channels) of a target in the requested space. */
function targetTransform(doc: DocumentData, t: DriverTarget, ctx: DriverContext): TargetXform {
  const ob = targetObject(doc, t);
  if (!ob) throw new DriverError(t.id ? 'Invalid target: object not found' : 'Invalid target: no object chosen');
  const space = t.transform_space ?? 'WORLD_SPACE';
  const pb = t.bone_target ? boneOf(ob, t.bone_target) : undefined;
  if (t.bone_target && !pb) throw new DriverError(`Invalid target: bone '${t.bone_target}' not found`);
  if (pb) {
    const order: RotationMode = pb.rotation_mode === 'QUATERNION' || pb.rotation_mode === 'AXIS_ANGLE' ? 'XYZ' : pb.rotation_mode;
    const euler = pb.rotation_mode === order ? [...pb.rotation_euler] : undefined;
    if (space === 'LOCAL_SPACE')
      return { m: poseBoneMatrix(pb, new Matrix4()), raw: { loc: [...pb.location], euler, order, scale: [...pb.scale] }, order, compat: euler };
    const ev = ctx.bone?.(ob.id, t.bone_target!);
    const rest = ev?.rest ?? restOf(doc, ob, t.bone_target!) ?? new Matrix4();
    const pose = ev?.pose ?? rest.clone().multiply(poseBoneMatrix(pb, new Matrix4()));
    if (space === 'WORLD_SPACE') return { m: worldOf(doc, ob, ctx).clone().multiply(pose), order, compat: euler };
    // transform space: posed bone relative to its rest position under the posed parent
    let restRel = rest;
    const parentEv = ev?.parent ? ctx.bone?.(ob.id, ev.parent) : undefined;
    if (parentEv) restRel = parentEv.pose.clone().multiply(parentEv.rest.clone().invert()).multiply(rest);
    return { m: restRel.clone().invert().multiply(pose), order, compat: euler };
  }
  const order: RotationMode = ob.rotation_mode === 'QUATERNION' || ob.rotation_mode === 'AXIS_ANGLE' ? 'XYZ' : ob.rotation_mode;
  const euler = ob.rotation_mode === order ? [...ob.rotation_euler] : undefined;
  const local = localMatrix(ob, new Matrix4());
  if (space === 'LOCAL_SPACE')
    return {
      m: local,
      raw: {
        loc: ob.location.map((x, i) => x + ob.delta_location[i]),
        euler: euler && !ob.delta_rotation_euler.some((x) => x) ? euler : undefined,
        order,
        scale: ob.scale.map((x, i) => x * ob.delta_scale[i]),
      },
      order,
      compat: euler,
    };
  const world = worldOf(doc, ob, ctx);
  if (space === 'WORLD_SPACE') return { m: world, order, compat: euler };
  // transform space: constraints included, parenting removed
  const basis = ctx.basis?.(ob.id);
  if (basis) return { m: local.clone().multiply(basis.clone().invert()).multiply(world), order, compat: euler };
  return { m: parentMatrixOf(doc, ob, ctx).invert().multiply(world), order, compat: euler };
}

const wrap = (v: number, ref: number) => v + Math.round((ref - v) / (2 * Math.PI)) * 2 * Math.PI;

function swingTwist(q: Quaternion, axis: 0 | 1 | 2): number[] {
  const c = [q.x, q.y, q.z];
  const tv = [0, 0, 0];
  tv[axis] = c[axis];
  const twist = new Quaternion(tv[0], tv[1], tv[2], q.w);
  if (twist.lengthSq() < 1e-12) twist.identity();
  else twist.normalize();
  let twistAngle = 2 * Math.atan2(c[axis], q.w);
  if (twistAngle > Math.PI) twistAngle -= 2 * Math.PI;
  if (twistAngle < -Math.PI) twistAngle += 2 * Math.PI;
  const swing = q.clone().multiply(twist.clone().invert());
  const s = swing.w < 0 ? -1 : 1;
  const angle = 2 * Math.acos(Math.min(1, Math.abs(swing.w)));
  const v = [swing.x * s, swing.y * s, swing.z * s];
  const n = Math.hypot(v[0], v[1], v[2]);
  const out = n > 1e-12 ? v.map((x) => (x / n) * angle) : [0, 0, 0];
  out[axis] = twistAngle;
  return [...out, angle];
}

/** Value of a Transform Channel target. */
export function transformChannel(x: TargetXform, type: string, rotationMode = 'AUTO'): number {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  x.m.decompose(p, q, s);
  if (type.startsWith('LOC_')) {
    const i = 'XYZ'.indexOf(type[4]);
    return x.raw ? x.raw.loc[i] : p.getComponent(i);
  }
  if (type.startsWith('SCALE_')) {
    const sc = x.raw ? x.raw.scale : [s.x, s.y, s.z];
    if (type === 'SCALE_AVG') return Math.cbrt(sc[0] * sc[1] * sc[2]);
    return sc['XYZ'.indexOf(type[6])];
  }
  // rotation
  const comp = type === 'ROT_W' ? 3 : 'XYZ'.indexOf(type[4]);
  if (rotationMode === 'QUATERNION') {
    if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    return comp === 3 ? q.w : [q.x, q.y, q.z][comp];
  }
  if (rotationMode.startsWith('SWING_TWIST_')) {
    if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    return swingTwist(q, 'XYZ'.indexOf(rotationMode.slice(-1)) as 0 | 1 | 2)[comp];
  }
  if (comp === 3) return 0;
  if (rotationMode === 'AUTO' && x.raw?.euler) return x.raw.euler[comp];
  const order = (rotationMode === 'AUTO' ? x.order : rotationMode) as RotationMode;
  const e = new Euler().setFromQuaternion(q, threeOrder(order));
  const v = [e.x, e.y, e.z][comp];
  return rotationMode === 'AUTO' && x.compat ? wrap(v, x.compat[comp]) : v;
}

function worldQuat(doc: DocumentData, t: DriverTarget, ctx: DriverContext): Quaternion {
  const x = targetTransform(doc, { ...t, transform_space: 'WORLD_SPACE' }, ctx);
  const q = new Quaternion();
  x.m.decompose(new Vector3(), q, new Vector3());
  return q;
}

// ---------------------------------------------------------------------------
// variables

const NEEDS_TWO = new Set(['ROTATION_DIFF', 'LOC_DIFF']);
export const variableTargetCount = (v: DriverVariable) => (NEEDS_TWO.has(v.type) ? 2 : 1);

/** Value of one variable. Throws DriverError with a readable message when it can't be evaluated. */
export function variableValue(doc: DocumentData, v: DriverVariable, ctx: DriverContext = {}): number {
  switch (v.type) {
    case 'SINGLE_PROP':
    case 'CONTEXT_PROP':
      return propertyValue(doc, v, ctx);
    case 'TRANSFORMS': {
      const t = v.targets[0];
      if (!t) throw new DriverError('Invalid target');
      return transformChannel(targetTransform(doc, t, ctx), t.transform_type ?? 'LOC_X', t.rotation_mode ?? 'AUTO');
    }
    case 'LOC_DIFF': {
      const [a, b] = v.targets;
      if (!a || !b) throw new DriverError('Invalid target: two objects needed');
      const pa = new Vector3().setFromMatrixPosition(targetTransform(doc, a, ctx).m);
      const pb = new Vector3().setFromMatrixPosition(targetTransform(doc, b, ctx).m);
      return pa.distanceTo(pb);
    }
    case 'ROTATION_DIFF': {
      const [a, b] = v.targets;
      if (!a || !b) throw new DriverError('Invalid target: two objects needed');
      const qa = worldQuat(doc, a, ctx),
        qb = worldQuat(doc, b, ctx);
      return 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb))));
    }
  }
  throw new DriverError('Unknown variable type');
}

/** Why a variable name can't be used in expressions, or null when it is fine. */
export function variableNameError(name: string): string | null {
  if (!name) return 'Name is empty';
  if (/^[0-9]/.test(name)) return 'Name starts with a number';
  if (name.startsWith('_')) return 'Name starts with an underscore (reserved)';
  if (/\s/.test(name)) return 'Name contains a space';
  if (name.includes('.')) return 'Name contains a dot';
  if (/[^A-Za-z0-9_]/.test(name)) return 'Name contains special characters';
  if (PY_KEYWORDS.has(name)) return 'Name is a reserved word';
  return null;
}


// ---------------------------------------------------------------------------
// drivers

export interface DriverResult {
  /** combined driver value before the F-Curve mapping */
  input: number;
  /** final value written to the property */
  value: number;
  /** per-variable values (null on error) */
  values: (number | null)[];
  /** per-variable error messages */
  varErrors: (string | null)[];
  error: string | null;
}

/** Map the driver value through its F-Curve (keys and modifiers); passes through when it has neither. */
export function driverCurveValue(fc: FCurve | undefined, x: number): number {
  if (!fc || fc.mute) return x;
  if (!fc.keyframe_points.length && !fc.modifiers.some((m) => !m.mute)) return x;
  return evaluateFCurve(fc, x);
}

/** Evaluate a driver with full diagnostics. */
export function runDriver(doc: DocumentData, owner: ObjectData, drv: Driver, frame: number, ctx: DriverContext = {}): DriverResult {
  const vars: Record<string, number> = { frame };
  const values: (number | null)[] = [];
  const varErrors: (string | null)[] = [];
  let error: string | null = null;
  for (const v of drv.variables) {
    const nameErr = variableNameError(v.name);
    try {
      const x = variableValue(doc, v, ctx);
      values.push(x);
      varErrors.push(nameErr);
      vars[v.name] = x;
    } catch (e) {
      values.push(null);
      varErrors.push(e instanceof Error ? e.message : String(e));
    }
    if (nameErr && drv.type === 'SCRIPTED') error ??= `Invalid variable name '${v.name}': ${nameErr}`;
  }
  const firstVarErr = varErrors.findIndex((x) => x !== null);
  const ok = values.filter((x): x is number => x !== null);
  let input = 0;
  if (drv.type === 'SCRIPTED') {
    try {
      const c = compileExpr(drv.expression);
      const env: ExprEnv = { vars };
      if (drv.use_self) env.self = selfRef(doc, owner);
      // a missing variable only matters when the expression reads it
      for (const name of c.names)
        if (!(name in vars)) {
          const bad = drv.variables.findIndex((v) => v.name === name);
          if (bad >= 0 && varErrors[bad]) throw new DriverError(`Variable '${name}': ${varErrors[bad]}`);
        }
      input = runExpr(c, env);
    } catch (e) {
      error ??= e instanceof DriverError ? e.message : exprErrorText(e);
    }
  } else {
    if (firstVarErr >= 0) error ??= `Variable '${drv.variables[firstVarErr].name}': ${varErrors[firstVarErr]}`;
    switch (drv.type) {
      case 'AVERAGE':
        input = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0;
        break;
      case 'SUM':
        input = ok.reduce((a, b) => a + b, 0);
        break;
      case 'MIN':
        input = ok.length ? Math.min(...ok) : 0;
        break;
      case 'MAX':
        input = ok.length ? Math.max(...ok) : 0;
        break;
    }
  }
  if (!error && !Number.isFinite(input)) error = 'Driver value is not a finite number';
  const value = driverCurveValue(drv.fcurve, input);
  return { input, value, values, varErrors, error };
}

function selfRef(doc: DocumentData, ob: ObjectData): RefValue {
  return {
    kind: 'ref',
    path: '',
    read: (path) => {
      if (!path) return ob;
      try {
        if (path === 'name') return ob.name;
        return getValue(doc, ob, path);
      } catch {
        return undefined;
      }
    },
  };
}

/** Driver value written to the property (throws when the driver has errors). */
export function evaluateDriver(doc: DocumentData, owner: ObjectData, drv: Driver, frame: number, ctx: DriverContext = {}): number {
  const r = runDriver(doc, owner, drv, frame, ctx);
  if (r.error) throw new DriverError(r.error);
  return r.value;
}

/** Whether the driven property path resolves. */
export function drivenPathValid(doc: DocumentData, ob: ObjectData, drv: Driver): boolean {
  try {
    if (!resolve(doc, ob, drv.data_path)) return false;
    const v = getValue(doc, ob, drv.data_path);
    if (v === undefined) return false;
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return drv.array_index >= 0 && drv.array_index < (v as ArrayLike<unknown>).length;
    return typeof v === 'number' || typeof v === 'boolean';
  } catch {
    return false;
  }
}

/** Objects a driver reads (used to order evaluation). */
export function driverDependencies(drv: Driver): string[] {
  const out: string[] = [];
  for (const v of drv.variables) for (const t of v.targets) if (t.id && (t.id_type ?? 'OBJECT') === 'OBJECT') out.push(t.id);
  return out;
}

/** Evaluate and apply all drivers of an object. */
export function applyDrivers(doc: DocumentData, ob: ObjectData, frame: number, ctx: DriverContext, write: (path: string, index: number, value: number) => void) {
  const ad = ob.animation_data;
  if (!ad?.drivers.length) return;
  for (const drv of ad.drivers) {
    if (drv.fcurve?.mute) continue;
    const r = runDriver(doc, ob, drv, frame, ctx);
    if (!r.error && Number.isFinite(r.value)) write(drv.data_path, drv.array_index, r.value);
  }
}
