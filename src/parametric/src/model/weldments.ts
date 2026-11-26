// Weldment features: factories, member identities and the cut list.

import type {
  EndCapFeature, GussetFeature, Id, MemberRef, PartDocument, SegmentRef, StructuralMemberFeature, TrimExtendFeature, UnitSystem, WeldBeadFeature,
} from './types';
import { UNIT_SYSTEMS, formatNumber } from './units';

/** A member's key inside its feature: the sketch segment it runs along. */
export const memberKey = (s: SegmentRef) => `${s.sketch}/${s.entity}`;

/**
 * The member a face of a structural member belongs to. Member faces are
 * named "<feature>:<sketch>/<entity>:<n>".
 */
export function memberOfFace(name: string): MemberRef | null {
  const m = /^([^:|@#/]+):([^:|@#/]+\/[^:|@#/]+):\d+(?:#\d+)?$/.exec(name);
  return m ? { feature: m[1], member: m[2] } : null;
}

export const sameMember = (a: MemberRef, b: MemberRef) => a.feature === b.feature && a.member === b.member;

export const newStructuralMember = (id: Id, name: string, groups: SegmentRef[][] = []): StructuralMemberFeature => ({
  id, name, type: 'structuralMember', standard: 'iso', profile: 'squareTube', size: '40x40x3',
  groups: groups.map((segments) => ({ segments })), rotation: 0, mirror: false, pierce: 'centroid',
  corner: 'miter', gap: 0, trimGroups: true, gap2: 0,
});

export const newTrimExtend = (id: Id, name: string): TrimExtendFeature => ({
  id, name, type: 'trimExtend', members: [], boundary: 'faces', faces: [], boundaryMembers: [], allowExtension: true, coped: false, gap: 0,
});

export const newEndCap = (id: Id, name: string, thickness: number): EndCapFeature => ({
  id, name, type: 'endCap', faces: [], thickness, offset: 0, inward: false,
});

export const newGusset = (id: Id, name: string, size: number, thickness: number): GussetFeature => ({
  id, name, type: 'gusset', faces: [], shape: 'triangular', d1: size, d2: size, d3: size / 2, thickness, location: 'center', chamfer: 0,
});

export const newWeldBead = (id: Id, name: string, size: number): WeldBeadFeature => ({ id, name, type: 'weldBead', edges: [], size });

// ---------- cut list ----------

/** A member as built, reported by the geometry kernel with every rebuild. */
export interface WeldMemberInfo {
  /** Structural member feature. */
  feature: Id;
  /** Sketch segment the member runs along ("sketch/entity"). */
  member: string;
  group: number;
  standard: string;
  profile: string;
  size: string;
  /** e.g. "SQ TUBE 40 x 40 x 3". */
  desc: string;
  /** Overall length (long point to long point), mm. */
  length: number;
  /** End cut angles from square, degrees (0 for a square cut, 45 for a miter of a right-angle corner). */
  angle1: number;
  angle2: number;
  /** Volume of the member, mm³. */
  volume: number;
  /** Cross-section area, mm². */
  area: number;
  /** The member follows an arc. */
  curved?: boolean;
  /** Radius of the arc it follows (sketch arc), mm. */
  radius?: number;
}

export interface CutListItem {
  item: number;
  quantity: number;
  description: string;
  /** Length of one piece, mm. */
  length: number;
  angle1: number;
  angle2: number;
  /** Mass of one piece, kg. */
  mass: number;
  totalLength: number;
  totalMass: number;
  curved: boolean;
  /** Radius of the arc a curved piece follows, mm. */
  radius?: number;
  members: { feature: Id; member: string }[];
}

export interface CutList {
  items: CutListItem[];
  /** Pieces in all. */
  count: number;
  totalLength: number;
  /** kg */
  totalMass: number;
  /** The density used, kg/m³, and whether it is the part's material. */
  density: number;
  material: string | null;
  /** A later feature other than a cut (a fillet, a shell) changed the members: the masses are from before it. */
  massApproximate?: boolean;
}

/** Lengths and angles closer than these make identical pieces. */
export const CUT_LIST_TOLERANCE = { length: 0.01, angle: 0.01 };

/**
 * The cut list of a part's weldment: identical members (same profile, same
 * length and the same end angles, either way round, within the tolerance)
 * are one item with their quantity. Mass uses the part's material (1000
 * kg/m³ when it has none, as mass properties do). Pass the latest build
 * result (or its `weldments` list); a drawing's cut list table can use it.
 */
export function weldmentCutList(doc: Pick<PartDocument, 'material'>, build: WeldMemberInfo[] | { weldments?: WeldMemberInfo[] } | null | undefined): CutList {
  const members = Array.isArray(build) ? build : build?.weldments;
  const density = doc.material?.density ?? 1000;
  const items: CutListItem[] = [];
  const tol = CUT_LIST_TOLERANCE;
  const close = (a: number, b: number, t: number) => Math.abs(a - b) <= t;
  for (const m of members ?? []) {
    // The smaller angle first, so a piece cut the other way round matches.
    const [a1, a2] = m.angle1 <= m.angle2 ? [m.angle1, m.angle2] : [m.angle2, m.angle1];
    const mass = m.volume * 1e-9 * density;
    // Curved pieces of one length are bent to different radii.
    const sameBend = (it: CutListItem) => !it.curved || close(it.radius ?? 0, m.radius ?? 0, tol.length);
    const same = items.find((it) => it.description === m.desc && it.curved === !!m.curved && close(it.length, m.length, tol.length) && close(it.angle1, a1, tol.angle) && close(it.angle2, a2, tol.angle) && sameBend(it));
    if (same) {
      same.quantity++;
      same.totalLength += m.length;
      same.totalMass += mass;
      same.members.push({ feature: m.feature, member: m.member });
    } else {
      items.push({
        item: 0, quantity: 1, description: m.desc, length: m.length, angle1: a1, angle2: a2, mass, totalLength: m.length, totalMass: mass,
        curved: !!m.curved, ...(m.curved && m.radius != null ? { radius: m.radius } : {}), members: [{ feature: m.feature, member: m.member }],
      });
    }
  }
  for (const it of items) it.mass = it.totalMass / it.quantity;
  items.sort((a, b) => a.description.localeCompare(b.description, 'en', { numeric: true }) || b.length - a.length || a.angle1 - b.angle1 || a.angle2 - b.angle2 || (a.radius ?? 0) - (b.radius ?? 0));
  items.forEach((it, i) => { it.item = i + 1; });
  return {
    items,
    count: items.reduce((s, it) => s + it.quantity, 0),
    totalLength: items.reduce((s, it) => s + it.totalLength, 0),
    totalMass: items.reduce((s, it) => s + it.totalMass, 0),
    density,
    material: doc.material?.name ?? null,
  };
}

/** Cut list rows as text in the part's units: what the dialog shows and the CSV holds. */
export function cutListRows(list: CutList, units: UnitSystem, decimals: number): { header: string[]; rows: string[][]; total: string[] } {
  const u = UNIT_SYSTEMS[units];
  const len = (mm: number) => formatNumber(mm / u.scale, decimals);
  const mass = (kg: number) => formatNumber(kg / u.massScale, Math.max(2, decimals));
  const ang = (d: number) => formatNumber(d, 2);
  const m = list.massApproximate ? `${u.mass}, before later changes` : u.mass;
  return {
    header: ['Item', 'Qty', 'Description', `Length (${u.length})`, 'Angle 1 (°)', 'Angle 2 (°)', `Total length (${u.length})`, `Mass each (${m})`, `Total mass (${m})`],
    rows: list.items.map((it) => [
      String(it.item), String(it.quantity), it.description + (it.curved ? (it.radius != null ? ` (curved, R ${len(it.radius)})` : ' (curved)') : ''), len(it.length), ang(it.angle1), ang(it.angle2),
      len(it.totalLength), mass(it.mass), mass(it.totalMass),
    ]),
    total: ['', String(list.count), 'Total', '', '', '', len(list.totalLength), '', mass(list.totalMass)],
  };
}

/** The cut list as CSV (RFC 4180 quoting). */
export function cutListCsv(list: CutList, units: UnitSystem, decimals: number): string {
  const { header, rows, total } = cutListRows(list, units, decimals);
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [header, ...rows, total].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
