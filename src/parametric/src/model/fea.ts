// Static stress analysis study kept with the part: fixtures and loads on
// faces (by reference, so they follow the part through dimension changes)
// and the mesh setting. Values are stored in millimetres, newtons,
// megapascals (N/mm^2) and mm/s^2, whatever the display units. Results are
// not stored: they are computed again from the part and the study.

import type { AxisRef, FaceRef, Id, PartDocument, UnitSystem } from './types';
import { UNIT_SYSTEMS } from './units';

/** A direction: a base axis, a straight edge (or the axis of a circular one), or a face (its normal, or a cylinder's axis). */
export type FeaDir = Exclude<AxisRef, { kind: 'sketchLine' }>;

export type FixtureType = 'fixed' | 'roller' | 'hinge';

export interface FeaFixture {
  id: Id;
  name: string;
  type: FixtureType;
  faces: FaceRef[];
  suppressed?: boolean;
}

/** A total force spread over the faces: normal to them (dir null, pressing on them) or along a direction. */
export interface FeaForce {
  id: Id;
  name: string;
  type: 'force';
  faces: FaceRef[];
  /** Newtons. */
  value: number;
  dir: FeaDir | null;
  flip: boolean;
  suppressed?: boolean;
}

/** A pressure on the faces, pushing into them (flip: pulling). */
export interface FeaPressure {
  id: Id;
  name: string;
  type: 'pressure';
  faces: FaceRef[];
  /** MPa (N/mm^2). */
  value: number;
  flip: boolean;
  suppressed?: boolean;
}

/** The part's own weight: the acceleration of gravity along a direction. */
export interface FeaGravity {
  id: Id;
  name: string;
  type: 'gravity';
  /** mm/s^2. */
  value: number;
  dir: FeaDir;
  flip: boolean;
  suppressed?: boolean;
}

export type FeaLoad = FeaForce | FeaPressure | FeaGravity;
export type FeaLoadType = FeaLoad['type'];

export interface StaticStudy {
  id: Id;
  name: string;
  fixtures: FeaFixture[];
  loads: FeaLoad[];
  /** Mesh fineness from 0 (coarse: twice the automatic element size) to 1 (fine: half of it). */
  mesh: { fineness: number };
}

export const FIXTURE_LABELS: Record<FixtureType, string> = { fixed: 'Fixed', roller: 'Roller/Slider', hinge: 'Fixed Hinge' };
export const LOAD_LABELS: Record<FeaLoadType, string> = { force: 'Force', pressure: 'Pressure', gravity: 'Gravity' };
export const FIXTURE_ICONS: Record<FixtureType, string> = { fixed: 'feaFixed', roller: 'feaRoller', hinge: 'feaHinge' };
export const LOAD_ICONS: Record<FeaLoadType, string> = { force: 'feaForce', pressure: 'feaPressure', gravity: 'feaGravity' };

/** Standard gravity, mm/s^2. */
export const GRAVITY = 9806.65;

export function newStudy(id: Id): StaticStudy {
  return { id, name: 'Static Study', fixtures: [], loads: [], mesh: { fineness: 0.5 } };
}

/** Element size for a fineness, from the automatic size (no larger than the part's walls allow). */
export function elementSizeFor(auto: number, max: number, fineness: number): number {
  return Math.min(max, auto * 2 ** (1 - 2 * Math.max(0, Math.min(1, fineness))));
}

// ---------- units ----------

export interface FeaUnits {
  force: string;
  /** Newtons per display force unit. */
  forceScale: number;
  stress: string;
  /** MPa per display stress unit. */
  stressScale: number;
  accel: string;
  /** mm/s^2 per display acceleration unit. */
  accelScale: number;
  length: string;
  /** mm per display length unit. */
  lengthScale: number;
}

export function feaUnits(units: UnitSystem): FeaUnits {
  const u = UNIT_SYSTEMS[units];
  if (units === 'IPS') return { force: 'lbf', forceScale: 4.4482216152605, stress: 'psi', stressScale: 0.00689475729316836, accel: 'in/s²', accelScale: 25.4, length: u.length, lengthScale: u.scale };
  return { force: 'N', forceScale: 1, stress: 'MPa', stressScale: 1, accel: 'm/s²', accelScale: 1000, length: u.length, lengthScale: u.scale };
}

// ---------- reading files ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(finite);
const str = (v: unknown): v is string => typeof v === 'string';

function faceRefOf(v: unknown): FaceRef | null {
  if (!isObj(v) || !str(v.name) || !isObj(v.sig)) return null;
  const s = v.sig;
  if (!str(s.type) || !vec3(s.c) || !finite(s.area) || (s.n != null && !vec3(s.n))) return null;
  return { name: v.name, sig: { type: s.type, c: s.c as FaceRef['sig']['c'], area: s.area, ...(s.n != null ? { n: s.n as FaceRef['sig']['c'] } : {}) } };
}

function dirOf(v: unknown): FeaDir | null {
  if (!isObj(v)) return null;
  if (v.kind === 'base') return v.axis === 'x' || v.axis === 'y' || v.axis === 'z' ? { kind: 'base', axis: v.axis } : null;
  if (v.kind === 'face') { const face = faceRefOf(v.face); return face ? { kind: 'face', face } : null; }
  if (v.kind === 'edge' && isObj(v.edge) && str(v.edge.name) && isObj(v.edge.sig)) {
    const s = v.edge.sig;
    if (!str(s.type) || !vec3(s.m) || !finite(s.len)) return null;
    return { kind: 'edge', edge: { name: v.edge.name, sig: { type: s.type, m: s.m as [number, number, number], len: s.len } } };
  }
  return null;
}

function facesOf(v: unknown): FaceRef[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map(faceRefOf);
  return out.every((f): f is FaceRef => !!f) ? out : null;
}

const bad = (what: string): never => { throw new Error(`The part file is damaged (invalid study: ${what}).`); };

/**
 * Checks a study read from a file, strictly: anything that is not a study
 * as this version writes it is refused with a message (a damaged study is
 * not silently changed into another one).
 */
export function parseStudy(raw: unknown): StaticStudy {
  if (!isObj(raw) || !str(raw.id) || !raw.id || !str(raw.name)) bad('identity');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.fixtures) || !Array.isArray(r.loads) || !isObj(r.mesh)) bad('lists');
  const ids = new Set<string>([r.id as string]);
  const ident = (o: Record<string, unknown>, what: string) => {
    if (!str(o.id) || !o.id || ids.has(o.id) || !str(o.name)) bad(`${what} identity`);
    ids.add(o.id as string);
    if (o.suppressed !== undefined && typeof o.suppressed !== 'boolean') bad(`${what} suppression`);
    return { id: o.id as string, name: o.name as string, ...(o.suppressed ? { suppressed: true } : {}) };
  };
  const fixtures = (r.fixtures as unknown[]).map((f): FeaFixture => {
    if (!isObj(f)) return bad('fixture');
    const base = ident(f, 'fixture');
    if (f.type !== 'fixed' && f.type !== 'roller' && f.type !== 'hinge') bad('fixture type');
    const faces = facesOf(f.faces) ?? bad('fixture faces');
    return { ...base, type: f.type as FixtureType, faces };
  });
  const loads = (r.loads as unknown[]).map((l): FeaLoad => {
    if (!isObj(l)) return bad('load');
    const base = ident(l, 'load');
    // Loads are positive amounts (their direction says which way): the panels never write others.
    if (!finite(l.value) || (l.value as number) <= 0) bad('load value');
    if (typeof l.flip !== 'boolean') bad('load direction');
    const value = l.value as number, flip = l.flip as boolean;
    if (l.type === 'force') {
      const faces = facesOf(l.faces) ?? bad('force faces');
      const dir = l.dir == null ? null : (dirOf(l.dir) ?? bad('force direction'));
      return { ...base, type: 'force', faces, value, dir, flip };
    }
    if (l.type === 'pressure') return { ...base, type: 'pressure', faces: facesOf(l.faces) ?? bad('pressure faces'), value, flip };
    if (l.type === 'gravity') return { ...base, type: 'gravity', value, dir: dirOf(l.dir) ?? bad('gravity direction'), flip };
    return bad('load type');
  });
  const m = r.mesh as Record<string, unknown>;
  if (!finite(m.fineness) || m.fineness < 0 || m.fineness > 1) bad('mesh');
  return { id: r.id as string, name: r.name as string, fixtures, loads, mesh: { fineness: m.fineness as number } };
}

/** Ids used by a study (so new ids never collide with them). */
export function studyIds(s: StaticStudy | null | undefined): string[] {
  return s ? [s.id, ...s.fixtures.map((f) => f.id), ...s.loads.map((l) => l.id)] : [];
}

export function studyOf(doc: PartDocument): StaticStudy | null {
  return doc.study ?? null;
}

/** Name for a new fixture or load: the label followed by the first number not taken. */
export function nextStudyName(s: StaticStudy, label: string): string {
  const used = new Set([...s.fixtures, ...s.loads].map((x) => x.name.toLowerCase()));
  const base = label.replace(/[^A-Za-z]/g, '');
  for (let i = 1; ; i++) if (!used.has(`${base}-${i}`.toLowerCase())) return `${base}-${i}`;
}
