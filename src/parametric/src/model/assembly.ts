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

export type MateType = 'coincident' | 'parallel' | 'perpendicular' | 'distance' | 'angle' | 'concentric' | 'tangent' | 'lock';

/** What a mate references: a face or edge of a component (by name, as features reference faces), an assembly plane, or a whole component (lock). */
export type MateRef =
  | { comp: Id; face: FaceRef }
  | { comp: Id; edge: EdgeRef }
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
  /** Lock mates: where b sits in a's frame. */
  rel?: Placement;
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
}

export const MATE_LABELS: Record<MateType, string> = {
  coincident: 'Coincident', parallel: 'Parallel', perpendicular: 'Perpendicular', distance: 'Distance',
  angle: 'Angle', concentric: 'Concentric', tangent: 'Tangent', lock: 'Lock',
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
  return true;
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
    ids.add(m.id);
  }
  const explode = Array.isArray(d.explode) ? d.explode : [];
  for (const s of explode) {
    if (!isObj(s) || !isStr(s.id) || ids.has(s.id) || !Array.isArray(s.comps) || !s.comps.every((c) => compIds.has(c as string)) || !isVec(s.dir) || !isParam(s.distance)) throw damaged('invalid explode step');
    ids.add(s.id);
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
    explode: explode.map((s) => ({ id: s.id, name: typeof s.name === 'string' && s.name ? s.name : s.id, comps: [...s.comps], dir: [...s.dir] as Vec3, distance: s.distance })),
    exploded: d.exploded === true && explode.length > 0,
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

/** Allocates a new id in an assembly (components, parts, mates, explode steps). */
export function nextAsmId(doc: AssemblyDocument, prefix: string): Id {
  const used = new Set<string>([...doc.parts.map((p) => p.id), ...doc.components.map((c) => c.id), ...doc.mates.map((m) => m.id), ...doc.explode.map((s) => s.id)]);
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

/** The components a mate references. */
export function mateComps(m: Mate): Id[] {
  const out: Id[] = [];
  for (const r of [m.a, m.b]) if ('comp' in r) out.push(r.comp);
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
