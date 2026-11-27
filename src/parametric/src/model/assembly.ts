// Assembly documents: components (placed instances of part files), mates
// between their faces and edges, and exploded view steps. An assembly is
// saved in a .parametric file like a part, told apart by its format.
//
// Every component references its part file by location AND the assembly
// embeds a copy of each part document it uses (once per part, however many
// instances), so it still opens when a part file is moved, deleted, shared
// or downloaded as one file. The copies live in `blobs` as part file text,
// keyed by an id that changes whenever a newer copy is taken: blobs are kept
// out of undo snapshots, and undo goes back to the copy it referenced.
//
// The document keeps the fields every part document has (name, units,
// variables, an always empty feature list...) so the document store, file
// operations, history and recovery treat both kinds alike.

import type { Vec3, Quat } from '../math/vec';
import { qNormalize } from '../math/vec';
import type { BasePlane, EdgeRef, FaceRef, Id, Param, PartDocument, UnitSystem } from './types';
import { UNIT_SYSTEMS } from './units';
import { parseDocument } from './document';
import { validDrawing } from './validate-drawing';

export const ASSEMBLY_FORMAT = 'parametric-assembly';

/** Where a part file lives (the same shape as platform/files Location). */
export type PartSource = { type: 'cloud'; path: string } | { type: 'local'; id: string };

/** Rigid placement of a component: world = rotate(q, local) + p. */
export interface Placement {
  p: Vec3;
  /** Unit quaternion (x, y, z, w). */
  q: Quat;
}

export interface AsmPart {
  id: Id;
  /** The part's name (its file's name when it has one). */
  name: string;
  /** The part file; null for parts that exist only inside the assembly (an uploaded STEP model). */
  source: PartSource | null;
  /** Version of the source file the embedded copy was read from, to tell when the file is newer. */
  version: { modified: number; size: number | null } | null;
  /** Key into the document's blobs of the embedded part document's file text. */
  blob: Id;
  /** Appearance colour of this part's components (#rrggbb). */
  color: string;
}

export interface AsmComponent {
  id: Id;
  /** Instance name, e.g. "bracket<1>". */
  name: string;
  part: Id;
  placement: Placement;
  /** Fixed components never move; the first one inserted is fixed. */
  fixed: boolean;
  hidden?: boolean;
  suppressed?: boolean;
}

export type MateType = 'coincident' | 'parallel' | 'perpendicular' | 'distance' | 'angle' | 'concentric' | 'tangent' | 'lock' | MechanicalMateType;

/**
 * Mechanical mates. A hinge is concentric and coincident in one; width and
 * slot take two entities on a side. Gear, rack and pinion and screw couple
 * how far one component turns to how far another turns or slides: they
 * relate motions, not positions, so they hold from wherever the components
 * are when they are added (see the solver).
 */
export type MechanicalMateType = 'hinge' | 'slider' | 'gear' | 'rackPinion' | 'screw' | 'width' | 'slot' | 'cam' | 'universal';
export const MECHANICAL_MATES: readonly MechanicalMateType[] = ['hinge', 'slider', 'gear', 'rackPinion', 'screw', 'width', 'slot', 'cam', 'universal'];
export const isMechanical = (t: MateType): t is MechanicalMateType => (MECHANICAL_MATES as readonly string[]).includes(t);

/** What a mate references: a face or edge of a component (by name, as features reference faces), an assembly plane, or a whole component (lock). */
export type MateRef =
  | { comp: Id; face: FaceRef }
  | { comp: Id; edge: EdgeRef }
  /** A vertex of a component, in its part's coordinates (cam followers). */
  | { comp: Id; point: Vec3 }
  | { comp: Id }
  | { plane: BasePlane };

export interface Mate {
  id: Id;
  name: string;
  type: MateType;
  a: MateRef;
  b: MateRef;
  /** Directions (normals, axes) point the same way (true) or opposite ways (false). */
  aligned: boolean;
  /** Distance (mm) or angle (degrees); expressions allowed. */
  value?: Param;
  /** Distance and tangent mates: the second entity lies on the other side of the first. */
  flip?: boolean;
  suppressed?: boolean;
  /**
   * Lock mates: where b sits in a's frame. Hinges with angle limits: where b
   * sat in a's frame at 0°. Sliders: where b sat when added (their turn is
   * held, their travel measured from there). Universal joints: where the
   * shafts were when added (the yokes' directions are taken from it).
   */
  rel?: Placement;
  /**
   * The second pair of entities: a hinge's coincident faces (a2 on a's
   * component, b2 on b's), a width mate's groove (a, a2) and tab (b, b2)
   * faces, a slot's two end faces (a, a2; b is the pin), a slider's second
   * planar face on each component.
   */
  a2?: MateRef;
  b2?: MateRef;
  /** Hinge, slider: alignment of the second pair (aligned is that of the first). */
  aligned2?: boolean;
  /** Cam: the profile's faces after a (all on a's component); b is the follower. */
  chain?: FaceRef[];
  /**
   * Distance and angle mates: the entities move freely between these values
   * (value is where they were set up). Hinges: the turn from where the hinge
   * was added (rel), in degrees.
   */
  limit?: { min: Param; max: Param };
  /** Gear: b's pitch diameter (value is a's), or b's part of the ratio. */
  value2?: Param;
  /**
   * Gear: 'ratio' when the values are a ratio rather than pitch diameters.
   * Rack and pinion: 'revolution' when value is the rack's travel per turn
   * rather than the pinion's pitch diameter. Universal joint: 'point' when
   * the shafts' axes meet at a joint point, value along a's axis from its
   * entity.
   */
  by?: 'ratio' | 'revolution' | 'point';
  /** Gear, rack and pinion: the other way round. Screw: a left-hand thread. Cam: the flat follower's other side. */
  reverse?: boolean;
}

/** What a motor does over time: a constant speed, a back and forth (sine), or a ramp between two values. */
export type MotionProfile = 'constant' | 'oscillate' | 'ramp';

/**
 * A motor of a motion study. Rotary motors turn a component about an axis,
 * linear motors move it along a direction (both taken from a face or edge;
 * the component is that of the entity); a mate driver changes the value of
 * a distance or angle mate. Values are in mm, degrees and seconds.
 */
export interface MotionMotor {
  id: Id;
  name: string;
  kind: 'rotary' | 'linear' | 'mate';
  /** Rotary and linear: the axis or direction, on the component it moves (or `mate`). */
  ref?: MateRef;
  /** Mate driver: the distance or angle mate. Rotary: a hinge it turns; linear: a slider it moves (b relative to a). */
  mate?: Id;
  profile: MotionProfile;
  /** Constant: speed (mm/s, deg/s, or rpm when `rpm`). */
  speed?: Param;
  rpm?: boolean;
  /** Oscillate: amplitude (mm or degrees) and frequency (Hz). */
  amplitude?: Param;
  frequency?: Param;
  /** Ramp (mate drivers): the value at the start and at the end of the study. */
  from?: Param;
  to?: Param;
  reverse?: boolean;
  suppressed?: boolean;
}

export interface MotionStudy {
  id: Id;
  name: string;
  /** Seconds. */
  duration: number;
  /** Frames computed per second. */
  fps: number;
  motors: MotionMotor[];
}

export interface ExplodeStep {
  id: Id;
  name: string;
  comps: Id[];
  /** Unit direction in assembly coordinates. */
  dir: Vec3;
  distance: Param;
}

export interface AssemblyDocument extends Omit<PartDocument, 'format' | 'features'> {
  format: typeof ASSEMBLY_FORMAT;
  /** Always empty: an assembly has components, not features. */
  features: [];
  parts: AsmPart[];
  components: AsmComponent[];
  mates: Mate[];
  explode: ExplodeStep[];
  /** Whether the exploded view is shown. */
  exploded: boolean;
  /** Motion studies (absent when there are none, as in files from before them). */
  studies?: MotionStudy[];
}

export const MATE_LABELS: Record<MateType, string> = {
  coincident: 'Coincident', parallel: 'Parallel', perpendicular: 'Perpendicular', distance: 'Distance',
  angle: 'Angle', concentric: 'Concentric', tangent: 'Tangent', lock: 'Lock',
  hinge: 'Hinge', slider: 'Slider', gear: 'Gear', rackPinion: 'Rack Pinion', screw: 'Screw', width: 'Width', slot: 'Slot', cam: 'Cam', universal: 'Universal Joint',
};

/** Distinct component colours, picked in turn for each new part. */
export const PART_COLORS = ['#b8c4d2', '#e0a85a', '#7fb37c', '#c98bb9', '#6fa8dc', '#d9776a', '#a7a35a', '#8e8fd6', '#5fb3a8', '#c7a27c'];

export const isAssembly = (doc: { format?: unknown } | null | undefined): doc is AssemblyDocument => doc?.format === ASSEMBLY_FORMAT;

/** The open document as an assembly (the store is typed for parts; see the note at the top). */
export const asAssembly = (doc: unknown): AssemblyDocument | null => (isAssembly(doc as { format?: unknown }) ? doc as AssemblyDocument : null);

export function newAssembly(name = 'Assembly1', units: UnitSystem = 'MMGS'): AssemblyDocument {
  const now = Date.now();
  return {
    format: ASSEMBLY_FORMAT,
    version: 1,
    name,
    units,
    decimals: units === 'IPS' ? 3 : 2,
    material: null,
    color: '#b8c4d2',
    variables: [],
    features: [],
    rollback: null,
    blobs: {},
    parts: [],
    components: [],
    mates: [],
    explode: [],
    exploded: false,
    nextId: 1,
    created: now,
    modified: now,
  };
}

export const IDENTITY: Placement = { p: [0, 0, 0], q: [0, 0, 0, 1] };

// ---------- validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isParam = (v: unknown) => isNum(v) || typeof v === 'string';
const BASE_PLANES = ['front', 'top', 'right'];
const MATE_TYPES = Object.keys(MATE_LABELS);
/** The most components (and parts), mates and explode steps an assembly file may have. */
export const MAX_COMPONENTS = 2000, MAX_MATES = 10000, MAX_EXPLODE_STEPS = 1000;
/** The most motion studies, motors per study, and frames a study may compute. */
export const MAX_STUDIES = 100, MAX_MOTORS = 50, MAX_FRAMES = 20000;

function validPlacement(v: unknown): v is Placement {
  return isObj(v) && isVec(v.p) && Array.isArray(v.q) && v.q.length === 4 && v.q.every(isNum) && Math.hypot(...(v.q as number[])) > 1e-9;
}

function validFaceRef(v: unknown): boolean {
  return isObj(v) && typeof v.name === 'string' && isObj(v.sig) && typeof v.sig.type === 'string' && isVec(v.sig.c) && isNum(v.sig.area) && (v.sig.n === undefined || isVec(v.sig.n));
}

function validEdgeRef(v: unknown): boolean {
  return isObj(v) && typeof v.name === 'string' && isObj(v.sig) && typeof v.sig.type === 'string' && isVec(v.sig.m) && isNum(v.sig.len);
}

function validMateRef(v: unknown, comps: Set<string>): boolean {
  if (!isObj(v)) return false;
  if ('plane' in v) return BASE_PLANES.includes(v.plane as string);
  if (!isStr(v.comp) || !comps.has(v.comp)) return false;
  if ('face' in v) return validFaceRef(v.face);
  if ('edge' in v) return validEdgeRef(v.edge);
  if ('point' in v) return isVec(v.point);
  return true;
}

/** The new fields of a mate (limits, second entities, mechanical settings), each only where its type has it. */
function validMateExtras(m: Record<string, unknown>, comps: Set<string>): boolean {
  const t = m.type as MateType;
  const has = (k: string) => m[k] !== undefined;
  const isBool = (k: string) => !has(k) || typeof m[k] === 'boolean';
  if (has('a2') && (!['hinge', 'width', 'slot', 'slider'].includes(t) || !validMateRef(m.a2, comps))) return false;
  if (has('b2') && (!['hinge', 'width', 'slider'].includes(t) || !validMateRef(m.b2, comps))) return false;
  if (!isBool('aligned2') || !isBool('reverse')) return false;
  if (has('value2') && (t !== 'gear' || !isParam(m.value2))) return false;
  if (has('limit') && (!['distance', 'angle', 'hinge', 'slider'].includes(t) || !isObj(m.limit) || !isParam(m.limit.min) || !isParam(m.limit.max))) return false;
  if (has('by') && !((t === 'gear' && m.by === 'ratio') || (t === 'rackPinion' && m.by === 'revolution') || (t === 'universal' && m.by === 'point'))) return false;
  // A cam's other profile faces: faces of its component.
  if (has('chain') && (t !== 'cam' || !Array.isArray(m.chain) || m.chain.length > 500 || !m.chain.every(validFaceRef) || !isObj(m.a) || !('face' in m.a))) return false;
  // Vertices are followers of cams only.
  if ([m.a, m.a2, m.b2, ...(t === 'cam' ? [] : [m.b])].some((r) => isObj(r) && 'point' in r)) return false;
  if (!isMechanical(t)) return !has('aligned2') && !has('reverse');
  // What each mechanical mate needs; its entities are faces, edges, vertices or planes (not whole components).
  const needs: Record<MechanicalMateType, string[]> = {
    hinge: ['a2', 'b2'], slider: ['rel'], width: ['a2', 'b2'], slot: ['a2'], gear: ['value', 'value2'], rackPinion: ['value'], screw: ['value'], cam: [], universal: ['rel'],
  };
  if (needs[t].some((k) => !has(k))) return false;
  // A slider takes one entity, or two faces, on each component; a joint point has its offset.
  if (t === 'slider' && has('a2') !== has('b2')) return false;
  if (t === 'universal' && (m.by === 'point') !== has('value')) return false;
  return [m.a, m.b, m.a2, m.b2].every((r) => r === undefined || (isObj(r) && ('plane' in r || 'face' in r || 'edge' in r || 'point' in r)));
}

function validMotor(v: unknown, comps: Set<string>, mates: Set<string>): boolean {
  if (!isObj(v) || !isStr(v.id) || typeof v.name !== 'string' || !['rotary', 'linear', 'mate'].includes(v.kind as string) || !['constant', 'oscillate', 'ramp'].includes(v.profile as string)) return false;
  for (const k of ['speed', 'amplitude', 'frequency', 'from', 'to']) if (v[k] !== undefined && !isParam(v[k])) return false;
  for (const k of ['rpm', 'reverse', 'suppressed']) if (v[k] !== undefined && typeof v[k] !== 'boolean') return false;
  const need = v.profile === 'constant' ? ['speed'] : v.profile === 'oscillate' ? ['amplitude', 'frequency'] : ['from', 'to'];
  if (need.some((k) => v[k] === undefined)) return false;
  if (v.kind === 'mate') return isStr(v.mate) && mates.has(v.mate) && v.ref === undefined && v.rpm === undefined;
  // Rotary and linear motors move the component of a face or edge (or turn a hinge, move a slider), at a constant speed or back and forth.
  if (v.profile === 'ramp' || (v.rpm !== undefined && v.kind !== 'rotary')) return false;
  if (v.mate !== undefined) return isStr(v.mate) && mates.has(v.mate) && v.ref === undefined;
  return isObj(v.ref) && isStr(v.ref.comp) && ('face' in v.ref || 'edge' in v.ref) && validMateRef(v.ref, comps);
}

function validSource(v: unknown): v is PartSource | null {
  return v === null || (isObj(v) && ((v.type === 'cloud' && isStr(v.path)) || (v.type === 'local' && isStr(v.id))));
}

/**
 * Validates and normalises an assembly read from a file (throws a readable
 * error). Embedded parts are checked when they are used, so one damaged part
 * shows as a failed component rather than refusing the whole assembly.
 */
export function parseAssembly(text: string): AssemblyDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not a valid assembly file.');
  }
  return validateAssembly(raw);
}

export function validateAssembly(raw: unknown): AssemblyDocument {
  const d = raw as Partial<AssemblyDocument> & Record<string, unknown>;
  if (!isObj(d) || d.format !== ASSEMBLY_FORMAT) throw new Error('This file is not an assembly created with Parametric.');
  if (typeof d.version === 'number' && d.version > 1) throw new Error('This assembly was created with a newer version of Parametric.');
  if (d.version !== 1) throw new Error('The assembly file is damaged (unknown version).');
  const damaged = (what: string) => new Error(`The assembly file is damaged (${what}).`);
  const blobs = isObj(d.blobs) ? d.blobs : {};
  if (!Object.values(blobs).every((b) => typeof b === 'string')) throw damaged('invalid part copy');
  if (!Array.isArray(d.parts) || !Array.isArray(d.components)) throw damaged('no component list');
  // Far beyond any assembly made here: a file this big was damaged or made by hand, and would not open in a browser tab.
  const mates0 = Array.isArray(d.mates) ? d.mates : [], explode0 = Array.isArray(d.explode) ? d.explode : [];
  for (const [list, max, what] of [[d.components, MAX_COMPONENTS, 'components'], [d.parts, MAX_COMPONENTS, 'parts'], [mates0, MAX_MATES, 'mates'], [explode0, MAX_EXPLODE_STEPS, 'explode steps']] as const) {
    if (list.length > max) throw new Error(`This assembly has ${list.length} ${what}, more than Parametric can open (at most ${max}).`);
  }
  const partIds = new Set<string>();
  for (const p of d.parts) {
    if (!isObj(p) || !isStr(p.id) || partIds.has(p.id) || typeof p.name !== 'string' || !isStr(p.blob) || !Object.hasOwn(blobs, p.blob) || !validSource(p.source)) throw damaged('invalid part');
    partIds.add(p.id);
  }
  const compIds = new Set<string>();
  for (const c of d.components) {
    if (!isObj(c) || !isStr(c.id) || compIds.has(c.id) || partIds.has(c.id) || !isStr(c.part) || !partIds.has(c.part) || !validPlacement(c.placement)) throw damaged('invalid component');
    compIds.add(c.id);
  }
  const mates = Array.isArray(d.mates) ? d.mates : [];
  const ids = new Set([...partIds, ...compIds]);
  for (const m of mates) {
    if (!isObj(m) || !isStr(m.id) || ids.has(m.id) || !MATE_TYPES.includes(m.type as string) || !validMateRef(m.a, compIds) || !validMateRef(m.b, compIds)) throw damaged('invalid mate');
    if (m.value !== undefined && !isParam(m.value)) throw damaged('invalid mate value');
    if (m.rel !== undefined && !validPlacement(m.rel)) throw damaged('invalid mate');
    if (!validMateExtras(m, compIds)) throw damaged('invalid mate');
    ids.add(m.id);
  }
  const mateIds = new Set(mates.map((m) => (m as Mate).id));
  const explode = Array.isArray(d.explode) ? d.explode : [];
  for (const s of explode) {
    if (!isObj(s) || !isStr(s.id) || ids.has(s.id) || !Array.isArray(s.comps) || !s.comps.every((c) => compIds.has(c as string)) || !isVec(s.dir) || !isParam(s.distance)) throw damaged('invalid explode step');
    ids.add(s.id);
  }
  // Motion studies (files from before them have none).
  if (d.studies !== undefined && !Array.isArray(d.studies)) throw damaged('invalid motion study');
  const studies = (d.studies ?? []) as unknown[];
  if (studies.length > MAX_STUDIES) throw new Error(`This assembly has ${studies.length} motion studies, more than Parametric can open (at most ${MAX_STUDIES}).`);
  for (const s of studies) {
    if (!isObj(s) || !isStr(s.id) || ids.has(s.id) || typeof s.name !== 'string' || !isNum(s.duration) || s.duration <= 0 || s.duration > 3600 || !isNum(s.fps) || s.fps < 1 || s.fps > 240
      || s.duration * s.fps > MAX_FRAMES || !Array.isArray(s.motors) || s.motors.length > MAX_MOTORS) throw damaged('invalid motion study');
    ids.add(s.id);
    for (const mo of s.motors) {
      if (!validMotor(mo, compIds, mateIds) || ids.has((mo as MotionMotor).id)) throw damaged('invalid motor');
      ids.add((mo as MotionMotor).id);
    }
  }
  if (d.drawing != null && !validDrawing(d.drawing)) throw damaged('invalid drawing');
  const units = typeof d.units === 'string' && Object.hasOwn(UNIT_SYSTEMS, d.units) ? d.units : 'MMGS';
  const base = newAssembly(typeof d.name === 'string' && d.name ? d.name : undefined, units);
  const variables = (Array.isArray(d.variables) ? d.variables : [])
    .filter((v) => isObj(v) && typeof v.name === 'string')
    .map((v, i) => ({ id: isStr(v.id) ? v.id : `v${i + 1}x`, name: v.name, expr: typeof v.expr === 'string' ? v.expr : String(v.expr ?? '') }));
  const doc: AssemblyDocument = {
    ...base,
    name: typeof d.name === 'string' && d.name ? d.name : base.name,
    units,
    decimals: Number.isInteger(d.decimals) && (d.decimals as number) >= 0 && (d.decimals as number) <= 8 ? d.decimals as number : base.decimals,
    variables,
    blobs: blobs as Record<Id, string>,
    parts: d.parts.map((p) => ({
      id: p.id, name: p.name, source: p.source ?? null, blob: p.blob,
      version: isObj(p.version) && isNum(p.version.modified) ? { modified: p.version.modified, size: isNum(p.version.size) ? p.version.size : null } : null,
      color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : PART_COLORS[0],
    })),
    components: d.components.map((c) => ({
      id: c.id, name: typeof c.name === 'string' && c.name ? c.name : c.id, part: c.part,
      placement: { p: [...c.placement.p] as Vec3, q: qNormalize(c.placement.q as Quat) },
      fixed: c.fixed === true,
      ...(c.hidden === true ? { hidden: true } : {}),
      ...(c.suppressed === true ? { suppressed: true } : {}),
    })),
    mates: mates.map((m) => ({
      ...m,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      aligned: m.aligned === true,
      ...(m.flip === true ? { flip: true } : { flip: undefined }),
      ...(m.suppressed === true ? { suppressed: true } : { suppressed: undefined }),
    })).map((m) => JSON.parse(JSON.stringify(m)) as Mate),
    explode: explode.map((s) => ({ id: s.id, name: typeof s.name === 'string' && s.name ? s.name : s.id, comps: [...new Set(s.comps as Id[])], dir: [...s.dir] as Vec3, distance: s.distance })),
    exploded: d.exploded === true && explode.length > 0,
    ...(studies.length ? { studies: (studies as MotionStudy[]).map((s) => ({ id: s.id, name: s.name || s.id, duration: s.duration, fps: s.fps, motors: s.motors.map(motorCopy) })) } : {}),
    ...(d.drawing != null ? { drawing: d.drawing } : {}),
    created: isNum(d.created) && Math.abs(d.created) < 8.64e15 ? d.created : base.created,
    modified: isNum(d.modified) && Math.abs(d.modified) < 8.64e15 ? d.modified : base.modified,
    nextId: 1,
  };
  // New ids must not collide with existing ones, even when the counter is stale.
  let max = 0;
  for (const id of [...ids, ...variables.map((v) => v.id)]) {
    const m = /^[a-z]+(\d+)$/i.exec(id);
    if (m && Number.isSafeInteger(Number(m[1]))) max = Math.max(max, Number(m[1]));
  }
  doc.nextId = Math.max(isNum(d.nextId) && Number.isSafeInteger(d.nextId) && d.nextId > 0 ? d.nextId : 1, max + 1);
  return doc;
}

/**
 * A part or an assembly from a .parametric file's text. Parts take exactly
 * the path they always did; an assembly is told by its format.
 */
export function parseAnyDocument(text: string): PartDocument | AssemblyDocument {
  if (/^\s*\{\s*"format"\s*:\s*"parametric-assembly"/.test(text.slice(0, 200))) return parseAssembly(text);
  try {
    return parseDocument(text);
  } catch (e) {
    // An assembly whose format is not written first (edited by hand, say).
    if (text.length < 50_000_000 && text.includes(ASSEMBLY_FORMAT)) {
      let raw: unknown = null;
      try { raw = JSON.parse(text); } catch { /* not JSON: the part error says so */ }
      if (isAssembly(raw as { format?: unknown })) return validateAssembly(raw);
    }
    throw e;
  }
}

/** A motor with only the fields it may have (a file's other fields are dropped). */
function motorCopy(m: MotionMotor): MotionMotor {
  const out: MotionMotor = { id: m.id, name: m.name || m.id, kind: m.kind, profile: m.profile };
  for (const k of ['ref', 'mate', 'speed', 'amplitude', 'frequency', 'from', 'to'] as const) if (m[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = structuredClone(m[k]);
  for (const k of ['rpm', 'reverse', 'suppressed'] as const) if (m[k] === true) out[k] = true;
  return out;
}

/** Allocates a new id in an assembly (components, parts, mates, explode steps, motion studies and motors). */
export function nextAsmId(doc: AssemblyDocument, prefix: string): Id {
  const studies = doc.studies ?? [];
  const used = new Set<string>([...doc.parts.map((p) => p.id), ...doc.components.map((c) => c.id), ...doc.mates.map((m) => m.id), ...doc.explode.map((s) => s.id), ...studies.flatMap((s) => [s.id, ...s.motors.map((m) => m.id)])]);
  let id: string;
  do id = `${prefix}${doc.nextId++}`; while (used.has(id));
  return id;
}

/** A new key for an embedded part copy (copies are immutable: an update gets a new key). */
export function newPartBlobId(doc: { blobs: Record<string, string> }): Id {
  let id: string;
  do id = `a${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`; while (Object.hasOwn(doc.blobs, id));
  return id;
}

/** Instance name for a new component of a part: "name<n>" with the first free n. */
export function instanceName(doc: AssemblyDocument, partName: string): string {
  const taken = new Set(doc.components.map((c) => c.name.toLowerCase()));
  let n = 1;
  while (taken.has(`${partName}<${n}>`.toLowerCase())) n++;
  return `${partName}<${n}>`;
}

/** The colour a newly embedded part gets: the first palette colour not used yet. */
export function nextPartColor(doc: AssemblyDocument): string {
  const used = new Set(doc.parts.map((p) => p.color.toLowerCase()));
  return PART_COLORS.find((c) => !used.has(c)) ?? PART_COLORS[doc.parts.length % PART_COLORS.length];
}

/** The entities a mate references (its second pair, and a cam's other faces, too). */
export const mateRefs = (m: Mate): MateRef[] => [
  m.a, m.b, ...(m.a2 ? [m.a2] : []), ...(m.b2 ? [m.b2] : []),
  ...(m.chain && 'comp' in m.a ? m.chain.map((face) => ({ comp: (m.a as { comp: Id }).comp, face })) : []),
];

/** The components a mate references. */
export function mateComps(m: Mate): Id[] {
  const out: Id[] = [];
  for (const r of mateRefs(m)) if ('comp' in r && !out.includes(r.comp)) out.push(r.comp);
  return out;
}

// ---------- embedded parts ----------

/**
 * Parses embedded part documents. Kept by blob key: a key always holds the
 * same text, so the parsed document can be reused until the key goes away.
 */
export class PartCache {
  private cache = new Map<Id, { text: string; doc: PartDocument | null; error: string | null }>();

  constructor(private parse: (text: string) => PartDocument) {}

  get(doc: AssemblyDocument, partId: Id): { doc: PartDocument | null; error: string | null } {
    const p = doc.parts.find((x) => x.id === partId);
    if (!p) return { doc: null, error: 'The part is missing from the assembly' };
    const text = doc.blobs[p.blob];
    if (typeof text !== 'string') return { doc: null, error: 'The copy of the part kept in the assembly is missing' };
    const hit = this.cache.get(p.blob);
    if (hit && hit.text === text) return hit;
    let parsed: PartDocument | null = null, error: string | null = null;
    try {
      parsed = this.parse(text);
    } catch (e) {
      error = (e as Error).message;
    }
    const entry = { text, doc: parsed, error };
    this.cache.set(p.blob, entry);
    return entry;
  }

  /** Forgets copies no longer referenced by the document. */
  prune(doc: AssemblyDocument) {
    const keep = new Set(doc.parts.map((p) => p.blob));
    for (const k of [...this.cache.keys()]) if (!keep.has(k)) this.cache.delete(k);
  }
}

// ---------- bill of materials ----------

export interface BomRow {
  /** Item number, from 1, in the order parts first appear in the assembly. */
  item: number;
  part: Id;
  name: string;
  quantity: number;
  /** Material name, or '' when the part has none. */
  material: string;
  /** Where the part file is, for reference. */
  source: PartSource | null;
}

/**
 * The assembly's bill of materials: one row per part, counting its
 * components that are not suppressed (hidden ones count: they are still in
 * the assembly). `partDoc` gives the embedded part document (for its material).
 */
export function assemblyBom(doc: AssemblyDocument, partDoc: (partId: Id) => PartDocument | null = () => null): BomRow[] {
  const rows: BomRow[] = [];
  for (const c of doc.components) {
    if (c.suppressed) continue;
    let row = rows.find((r) => r.part === c.part);
    if (!row) {
      const p = doc.parts.find((x) => x.id === c.part);
      if (!p) continue;
      row = { item: rows.length + 1, part: p.id, name: p.name, quantity: 0, material: partDoc(p.id)?.material?.name ?? '', source: p.source };
      rows.push(row);
    }
    row.quantity++;
  }
  return rows;
}

/** The bill of materials as CSV text (for spreadsheets), or tab-separated (`sep` '\t', to paste into one). */
export function bomCsv(rows: BomRow[], sep: ',' | '\t' = ','): string {
  const cell = (v: string | number) => (/["\n\r]/.test(String(v)) || String(v).includes(sep) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [['Item No.', 'Part Name', 'Quantity', 'Material'], ...rows.map((r) => [r.item, r.name, r.quantity, r.material])].map((row) => row.map(cell).join(sep)).join('\n');
}
