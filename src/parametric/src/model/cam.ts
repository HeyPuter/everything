// CAM (computer-aided manufacturing) data kept with the part: the cutting
// tools, the setups (how the part sits on the machine, its stock and work
// origin) and each setup's machining operations. Plain JSON like the rest of
// the part, in millimetres, degrees, millimetres per minute and revolutions
// per minute. Toolpaths are not stored: they are generated from the part.

import type { FaceRef, Id, PartDocument } from './types';

/** Direction from the part toward the spindle, in model coordinates. */
export type CamAxis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

/** Where the work coordinate system (G54) is, on the stock. */
export type CamOrigin = 'topCenter' | 'topFrontLeft' | 'topBackLeft' | 'bottomFrontLeft' | 'modelOrigin';

export type CamToolType = 'flat' | 'ball' | 'bull' | 'drill' | 'chamfer';

export interface CamTool {
  id: Id;
  /** Tool number in the machine's tool changer (T1...). */
  number: number;
  name: string;
  type: CamToolType;
  diameter: number;
  /** Bull nose end mills: radius of the rounded corners. */
  cornerRadius?: number;
  /** Drills and chamfer mills: included angle of the point (118 for a drill, 90 for a chamfer mill). */
  tipAngle?: number;
  /** Length of the cutting part. */
  fluteLength: number;
  flutes: number;
  /** Spindle speed (rpm). */
  rpm: number;
  /** Cutting feed (mm/min). */
  feed: number;
  /** Plunge and ramp feed (mm/min). */
  plunge: number;
  coolant: boolean;
}

export interface CamStock {
  /** 'offset': the part's bounding box grown by the offsets; 'fixed': a box of this size around the part. */
  mode: 'offset' | 'fixed';
  /** Offset mode: added around the sides, above and below the part. */
  side: number;
  top: number;
  bottom: number;
  /** Fixed mode: width (X), depth (Y) and height (Z) on the machine. */
  size: [number, number, number];
}

export type CamOpType = 'face' | 'contour' | 'pocket' | 'drill' | 'bore' | 'rough' | 'parallel' | 'waterline';

export interface CamOpBase {
  id: Id;
  name: string;
  type: CamOpType;
  tool: Id;
  suppressed?: boolean;
  /** Feeds and speeds overriding the tool's (absent: the tool's). */
  rpm?: number;
  feed?: number;
  plunge?: number;
}

/** Faces the top of the stock down to the top of the part. */
export interface FaceOp extends CamOpBase {
  type: 'face';
  stepover: number;
  stepdown: number;
  /** Left on top of the part (absent: 0). */
  leave: number;
  /** Angle of the passes from the machine's X axis (degrees). */
  angle: number;
}

/** Cuts around the outside of the part, through its full height. */
export interface ContourOp extends CamOpBase {
  type: 'contour';
  stepdown: number;
  /** Stock to leave on the walls. */
  leave: number;
  /** How far below the bottom of the part to cut. */
  breakthrough: number;
  direction: 'climb' | 'conventional';
  /** Holding tabs left in the last passes (count 0: none). */
  tabs: { count: number; width: number; height: number };
  /** Radius of the arcs leading on and off the wall (0: straight on). */
  lead: number;
  /** Angle the passes ramp down at along the contour (degrees from horizontal). */
  rampAngle: number;
}

export type ClearingPattern = 'offset' | 'zigzag';
export type EntryKind = 'helix' | 'ramp' | 'plunge';

/** Clears pockets down to picked flat floors. */
export interface PocketOp extends CamOpBase {
  type: 'pocket';
  /** Floors of the pockets (planar faces facing the tool). */
  faces: FaceRef[];
  stepover: number;
  stepdown: number;
  /** Stock to leave on the walls and floor. */
  leave: number;
  floorLeave: number;
  pattern: ClearingPattern;
  direction: 'climb' | 'conventional';
  entry: EntryKind;
  /** Ramp and helix angle (degrees from horizontal). */
  rampAngle: number;
}

export interface HoleRef {
  /** One of the hole's cylindrical faces. */
  face: FaceRef;
}

export type DrillCycle = 'drill' | 'peck' | 'chipBreak';

/** Drills holes with a drill (canned cycles). */
export interface DrillOp extends CamOpBase {
  type: 'drill';
  /** Holes to drill; empty: every hole of the tool's diameter that opens toward the tool. */
  holes: HoleRef[];
  cycle: DrillCycle;
  /** Peck depth (peck and chip break cycles). */
  peck: number;
  /** Dwell at the bottom (seconds). */
  dwell: number;
  /** Extra depth through holes that go through the part. */
  breakthrough: number;
  /** Through holes: the drill point goes all the way through (adds the point's length). */
  tipThrough: boolean;
}

/** Mills holes larger than the tool along a helix. */
export interface BoreOp extends CamOpBase {
  type: 'bore';
  holes: HoleRef[];
  /** Depth per turn of the helix. */
  pitch: number;
  leave: number;
  breakthrough: number;
  direction: 'climb' | 'conventional';
}

/** Removes the bulk of the stock around the part in levels (3D). */
export interface RoughOp extends CamOpBase {
  type: 'rough';
  stepover: number;
  stepdown: number;
  leave: number;
  floorLeave: number;
  pattern: ClearingPattern;
  direction: 'climb' | 'conventional';
  entry: EntryKind;
  rampAngle: number;
}

/** Finishes the surfaces with parallel passes (3D). */
export interface ParallelOp extends CamOpBase {
  type: 'parallel';
  stepover: number;
  /** Angle of the passes from the machine's X axis (degrees). */
  angle: number;
  leave: number;
  /** Chord tolerance of the passes. */
  tolerance: number;
  /** Area machined: the stock, or the part's outline (plus the tool radius). */
  boundary: 'stock' | 'silhouette';
  /** Only surfaces flatter than this (degrees from horizontal); 90: all. */
  maxSlope: number;
}

/** Finishes steep walls with constant-height passes (3D). */
export interface WaterlineOp extends CamOpBase {
  type: 'waterline';
  stepdown: number;
  leave: number;
  tolerance: number;
  direction: 'climb' | 'conventional';
}

export type CamOperation = FaceOp | ContourOp | PocketOp | DrillOp | BoreOp | RoughOp | ParallelOp | WaterlineOp;

export interface CamSetup {
  id: Id;
  name: string;
  axis: CamAxis;
  /** Turn of the part about the tool axis (degrees, a multiple of 90). */
  rotation: number;
  origin: CamOrigin;
  stock: CamStock;
  /** Heights above the top of the stock: rapid moves above clearance, feeds start from retract. */
  clearance: number;
  retract: number;
  /** Work offset (54 for G54 ... 59). */
  workOffset: number;
  ops: CamOperation[];
}

export type CamController = 'fanuc' | 'haas' | 'linuxcnc' | 'mach3' | 'grbl';

export interface CamPost {
  controller: CamController;
  /** Program number (O-number for Fanuc and Haas). */
  program: number;
  /** Output inch (G20) or millimetre (G21) values; absent: the part's units. */
  units?: 'mm' | 'in';
  /** Write arcs as G2/G3 (else as short lines). */
  arcs: boolean;
  /** Write line numbers (N10, N20...). */
  lineNumbers: boolean;
  /** Write drilling as canned cycles (G81/G83/G73); else as moves. */
  cannedCycles: boolean;
  /** Rapid feed of the machine, for the cycle time estimate (mm/min). */
  rapidFeed: number;
}

export interface CamDoc {
  tools: CamTool[];
  setups: CamSetup[];
  post: CamPost;
}

export const CAM_OP_LABELS: Record<CamOpType, string> = {
  face: 'Face',
  contour: '2D Contour',
  pocket: '2D Pocket',
  drill: 'Drill',
  bore: 'Bore',
  rough: '3D Rough',
  parallel: 'Parallel',
  waterline: 'Waterline',
};

export const CAM_OP_ICONS: Record<CamOpType, string> = {
  face: 'camFace',
  contour: 'camContour',
  pocket: 'camPocket',
  drill: 'camDrill',
  bore: 'camBore',
  rough: 'camRough',
  parallel: 'camParallel',
  waterline: 'camWaterline',
};

export const TOOL_TYPE_LABELS: Record<CamToolType, string> = {
  flat: 'Flat end mill',
  ball: 'Ball end mill',
  bull: 'Bull nose end mill',
  drill: 'Drill',
  chamfer: 'Chamfer mill',
};

export const CONTROLLER_LABELS: Record<CamController, string> = {
  fanuc: 'Fanuc (generic)',
  haas: 'Haas',
  linuxcnc: 'LinuxCNC',
  mach3: 'Mach3 / Mach4',
  grbl: 'Grbl',
};

/** The tool types an operation can use. */
export function opToolTypes(type: CamOpType): CamToolType[] {
  switch (type) {
    case 'drill': return ['drill', 'flat'];
    case 'face': case 'contour': case 'pocket': case 'bore': case 'rough': return ['flat', 'bull'];
    case 'parallel': return ['ball', 'bull', 'flat', 'chamfer'];
    case 'waterline': return ['ball', 'bull', 'flat'];
  }
}

/** New CAM data; `id` gives ids from the part's counter (so they never meet a feature's). */
export function newCamDoc(id: (prefix: string) => Id, inch = false): CamDoc {
  return {
    tools: defaultTools(id, inch),
    setups: [],
    post: { controller: 'fanuc', program: 1001, arcs: true, lineNumbers: false, cannedCycles: true, rapidFeed: 5000 },
  };
}

/** A starting tool library: common end mills and drills. */
export function defaultTools(id: (prefix: string) => Id, inch = false): CamTool[] {
  const mm = (v: number, i: number) => (inch ? i * 25.4 : v);
  const t = (number: number, name: string, type: CamToolType, d: number, extra: Partial<CamTool> = {}): CamTool => ({
    id: id('t'), number, name, type, diameter: d, fluteLength: Math.max(3 * d, 6), flutes: type === 'drill' ? 2 : 3,
    rpm: Math.round(Math.min(18000, 80000 / Math.max(1, d))), feed: Math.round(Math.max(150, Math.min(2500, 120 * d))), plunge: Math.round(Math.max(80, Math.min(800, 40 * d))), coolant: true,
    ...extra,
  });
  return [
    t(1, inch ? '1/2" flat end mill' : '12 mm flat end mill', 'flat', mm(12, 0.5)),
    t(2, inch ? '1/4" flat end mill' : '6 mm flat end mill', 'flat', mm(6, 0.25)),
    t(3, inch ? '1/8" flat end mill' : '3 mm flat end mill', 'flat', mm(3, 0.125)),
    t(4, inch ? '1/4" ball end mill' : '6 mm ball end mill', 'ball', mm(6, 0.25)),
    t(5, inch ? '1/8" ball end mill' : '3 mm ball end mill', 'ball', mm(3, 0.125)),
    t(6, inch ? '#7 drill (M5 tap)' : '4.2 mm drill (M5 tap)', 'drill', inch ? 0.201 * 25.4 : 4.2, { tipAngle: 118, feed: 200, plunge: 200, rpm: 2500 }),
    t(7, inch ? '1/4" drill' : '5 mm drill', 'drill', mm(5, 0.25), { tipAngle: 118, feed: 220, plunge: 220, rpm: 2200 }),
    t(8, inch ? '1/2" chamfer mill 90°' : '10 mm chamfer mill 90°', 'chamfer', mm(10, 0.5), { tipAngle: 90 }),
  ];
}

const finite = (v: unknown, lo = -Infinity, hi = Infinity): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => typeof v === 'string' && (all as readonly string[]).includes(v);

const AXES: CamAxis[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const ORIGINS: CamOrigin[] = ['topCenter', 'topFrontLeft', 'topBackLeft', 'bottomFrontLeft', 'modelOrigin'];
const TOOL_TYPES: CamToolType[] = ['flat', 'ball', 'bull', 'drill', 'chamfer'];
const OP_TYPES: CamOpType[] = ['face', 'contour', 'pocket', 'drill', 'bore', 'rough', 'parallel', 'waterline'];
const CONTROLLERS: CamController[] = ['fanuc', 'haas', 'linuxcnc', 'mach3', 'grbl'];

function validFaceRef(v: unknown): boolean {
  return isObj(v) && typeof v.name === 'string' && isObj(v.sig) && typeof v.sig.type === 'string' && Array.isArray(v.sig.c);
}

function validTool(t: unknown): t is CamTool {
  return isObj(t) && typeof t.id === 'string' && typeof t.name === 'string' && oneOf(t.type, TOOL_TYPES) && finite(t.diameter, 1e-3, 1e4)
    && finite(t.number, 0, 1e6) && finite(t.rpm, 0) && finite(t.feed, 0) && finite(t.plunge, 0);
}

function validOp(o: unknown): o is CamOperation {
  if (!isObj(o) || typeof o.id !== 'string' || typeof o.name !== 'string' || !oneOf(o.type, OP_TYPES) || typeof o.tool !== 'string') return false;
  if ((o.type === 'pocket') && !(Array.isArray(o.faces) && o.faces.every(validFaceRef))) return false;
  if ((o.type === 'drill' || o.type === 'bore') && !(Array.isArray(o.holes) && o.holes.every((x) => isObj(x) && validFaceRef(x.face)))) return false;
  return true;
}

/**
 * Checks and completes CAM data read from a file. Returns null for data that
 * is not CAM data at all; drops tools and operations that are damaged, and
 * fills in values added since the file was written from the defaults.
 */
export function normalizeCam(raw: unknown): CamDoc | null {
  if (!isObj(raw)) return null;
  const base = newCamDoc(() => '');
  const tools = (Array.isArray(raw.tools) ? raw.tools : []).filter(validTool).map((t) => ({
    ...t, fluteLength: finite(t.fluteLength, 0) ? t.fluteLength : t.diameter * 3, flutes: finite(t.flutes, 1, 20) ? Math.round(t.flutes) : 2, coolant: t.coolant !== false,
  }));
  const ids = new Set<string>();
  const uniqueTools = tools.filter((t) => !ids.has(t.id) && ids.add(t.id));
  const setups: CamSetup[] = [];
  for (const s of Array.isArray(raw.setups) ? raw.setups : []) {
    if (!isObj(s) || typeof s.id !== 'string' || ids.has(s.id)) continue;
    ids.add(s.id);
    const st = isObj(s.stock) ? s.stock : {};
    const size = Array.isArray(st.size) && st.size.length === 3 && st.size.every((v) => finite(v, 0)) ? st.size as [number, number, number] : [100, 100, 25] as [number, number, number];
    const ops = (Array.isArray(s.ops) ? s.ops : []).filter(validOp).filter((o) => !ids.has(o.id) && ids.add(o.id)).map((o) => withOpDefaults(o));
    setups.push({
      id: s.id,
      name: typeof s.name === 'string' ? s.name : 'Setup',
      axis: oneOf(s.axis, AXES) ? s.axis : '+Y',
      rotation: finite(s.rotation) ? (((Math.round(s.rotation / 90) * 90) % 360) + 360) % 360 : 0,
      origin: oneOf(s.origin, ORIGINS) ? s.origin : 'topFrontLeft',
      stock: {
        mode: st.mode === 'fixed' ? 'fixed' : 'offset',
        side: finite(st.side, 0) ? st.side : 2, top: finite(st.top, 0) ? st.top : 1, bottom: finite(st.bottom, 0) ? st.bottom : 0, size,
      },
      clearance: finite(s.clearance, 0) ? s.clearance : 10,
      retract: finite(s.retract, 0) ? s.retract : 3,
      workOffset: finite(s.workOffset, 54, 59) ? Math.round(s.workOffset) : 54,
      ops,
    });
  }
  const p = isObj(raw.post) ? raw.post : {};
  const post: CamPost = {
    controller: oneOf(p.controller, CONTROLLERS) ? p.controller : base.post.controller,
    program: finite(p.program, 1, 99999) ? Math.round(p.program) : base.post.program,
    ...(p.units === 'mm' || p.units === 'in' ? { units: p.units } : {}),
    arcs: p.arcs !== false,
    lineNumbers: p.lineNumbers === true,
    cannedCycles: p.cannedCycles !== false,
    rapidFeed: finite(p.rapidFeed, 1) ? p.rapidFeed : base.post.rapidFeed,
  };
  return { tools: uniqueTools, setups, post };
}

/** Defaults of an operation's values (by type), for a tool of this diameter. */
export function opDefaults(type: CamOpType, d: number): Record<string, unknown> {
  const r = d / 2;
  switch (type) {
    case 'face': return { stepover: d * 0.7, stepdown: 1, leave: 0, angle: 0 };
    case 'contour': return { stepdown: Math.max(0.5, Math.min(d, 3)), leave: 0, breakthrough: 0.5, direction: 'climb', tabs: { count: 0, width: Math.max(3, d), height: 1.5 }, lead: Math.max(0.5, r * 0.5), rampAngle: 3 };
    case 'pocket': return { faces: [], stepover: d * 0.45, stepdown: Math.max(0.5, Math.min(d / 2, 3)), leave: 0, floorLeave: 0, pattern: 'offset', direction: 'climb', entry: 'helix', rampAngle: 3 };
    case 'drill': return { holes: [], cycle: 'peck', peck: Math.max(1, d), dwell: 0, breakthrough: 1, tipThrough: true };
    case 'bore': return { holes: [], pitch: Math.max(0.3, d / 6), leave: 0, breakthrough: 0.5, direction: 'climb' };
    case 'rough': return { stepover: d * 0.4, stepdown: Math.max(0.5, Math.min(d / 2, 3)), leave: 0.3, floorLeave: 0.2, pattern: 'offset', direction: 'climb', entry: 'helix', rampAngle: 3 };
    case 'parallel': return { stepover: Math.max(0.05, d * 0.1), angle: 45, leave: 0, tolerance: 0.01, boundary: 'stock', maxSlope: 90 };
    case 'waterline': return { stepdown: Math.max(0.05, d * 0.08), leave: 0, tolerance: 0.01, direction: 'climb' };
  }
}

function withOpDefaults(o: CamOperation): CamOperation {
  const defs = opDefaults(o.type, 6);
  const out = { ...defs, ...o } as Record<string, unknown>;
  for (const [k, v] of Object.entries(defs)) if (typeof v === 'number' && !finite(out[k])) out[k] = v;
  return out as unknown as CamOperation;
}

/** The ids CAM data uses (they share the part's id counter). */
export function camIds(cam: CamDoc | null | undefined): string[] {
  if (!cam) return [];
  return [...cam.tools.map((t) => t.id), ...cam.setups.flatMap((s) => [s.id, ...s.ops.map((o) => o.id)])];
}

export function camOf(doc: PartDocument): CamDoc | null {
  return doc.cam ?? null;
}

/** Name for a new item: the label followed by the first number not taken. */
export function nextCamName(taken: string[], label: string): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (let i = 1; ; i++) if (!used.has(`${label}${i}`.toLowerCase())) return `${label}${i}`;
}

export function findOp(cam: CamDoc, id: Id): { setup: CamSetup; op: CamOperation } | null {
  for (const setup of cam.setups) {
    const op = setup.ops.find((o) => o.id === id);
    if (op) return { setup, op };
  }
  return null;
}

/** Feeds and speeds an operation runs at. */
export function opFeeds(op: CamOperation, tool: CamTool): { rpm: number; feed: number; plunge: number } {
  return { rpm: op.rpm ?? tool.rpm, feed: op.feed ?? tool.feed, plunge: op.plunge ?? tool.plunge };
}
