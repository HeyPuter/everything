// Armature Edit Mode kernels: side names, selection walks, fill / split / dissolve, bone
// collections and visibility. Pure functions over ArmatureData (unit tested).
import { Vector3 } from 'three';
import type { ArmatureData, Bone, BoneCollection, Vec3 } from '../../data/types';

const V = (a: ArrayLike<number>) => new Vector3(a[0], a[1], a[2]);

// ---------------------------------------------------------------------------
// names

const SIDE_PAIRS: [string, string][] = [
  ['L', 'R'],
  ['l', 'r'],
  ['Left', 'Right'],
  ['left', 'right'],
  ['LEFT', 'RIGHT'],
];

/** Split a trailing ".001"-style number off a name. */
function splitNumber(name: string): [string, string] {
  const m = /^(.*?)(\.\d+)$/.exec(name);
  return m ? [m[1], m[2]] : [name, ''];
}

/** Swap the side marker of a name (Bone.L ↔ Bone.R, Left_arm ↔ Right_arm …); unchanged when it has none. */
export function flipSideName(name: string): string {
  const [base, num] = splitNumber(name);
  for (const [a, b] of SIDE_PAIRS) {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      // suffix: separator + side
      let m = new RegExp(`^(.*[._\\- ])${x}$`).exec(base);
      if (m) return m[1] + y + num;
      // prefix: side + separator
      m = new RegExp(`^${x}([._\\- ].*)$`).exec(base);
      if (m) return y + m[1] + num;
      // whole words left/right anywhere
      if (x.length > 1) {
        const i = base.indexOf(x);
        if (i >= 0) return base.slice(0, i) + y + base.slice(i + x.length) + num;
      }
    }
  }
  return name;
}

/** Remove a side marker suffix (".L", "_R", ".Fr", ".Top" …). */
export function stripSide(name: string): string {
  const [base] = splitNumber(name);
  return base.replace(/[._\- ](L|R|l|r|Left|Right|left|right|Fr|Bk|fr|bk|Top|Bot|top|bot)$/, '');
}

/** Name with a side suffix from the bone's position along an axis (head, or tail when the head is centred). */
export function autoSideName(b: Bone, axis: 'XAXIS' | 'YAXIS' | 'ZAXIS'): string {
  const k = axis === 'XAXIS' ? 0 : axis === 'YAXIS' ? 1 : 2;
  let v = b.head[k];
  if (Math.abs(v) < 1e-3) v = b.tail[k];
  if (Math.abs(v) < 1e-3) return b.name;
  const base = stripSide(b.name);
  const side = axis === 'XAXIS' ? (v > 0 ? 'L' : 'R') : axis === 'YAXIS' ? (v < 0 ? 'Fr' : 'Bk') : v > 0 ? 'Top' : 'Bot';
  return `${base}.${side}`;
}

export function uniqueBoneName(arm: ArmatureData, base: string, except?: Bone) {
  const taken = (n: string) => arm.bones.some((b) => b !== except && b.name === n);
  if (!taken(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken(n)) return n;
  }
}

/**
 * Rename bones in one go, keeping parents and collections consistent. Returns a map old → new
 * for the callers that also rename pose channels, vertex groups or F-curves.
 */
export function renameBones(arm: ArmatureData, wanted: Map<Bone, string>): Map<string, string> {
  const changes = new Map<string, string>();
  const old = new Map<Bone, string>();
  for (const [b, n] of wanted) if (n !== b.name) old.set(b, b.name);
  // temporary names avoid collisions while swapping (A.L ↔ A.R)
  for (const b of old.keys()) b.name = `\u0000${b.name}`;
  for (const [b, prev] of old) {
    b.name = uniqueBoneName(arm, wanted.get(b)!, b);
    changes.set(prev, b.name);
  }
  for (const b of arm.bones) if (b.parent && changes.has(b.parent)) b.parent = changes.get(b.parent)!;
  if (arm.active_bone && changes.has(arm.active_bone)) arm.active_bone = changes.get(arm.active_bone)!;
  return changes;
}

// ---------------------------------------------------------------------------
// collections and visibility

export function collectionsOf(arm: ArmatureData): BoneCollection[] {
  return (arm.collections ??= []);
}

/** Bone visible in the viewport: not hidden, and (if assigned) in at least one visible/solo collection. */
export function boneVisible(arm: ArmatureData, b: Bone): boolean {
  if (b.hide) return false;
  const cols = arm.collections;
  if (!cols?.length) return true;
  const solo = cols.some((c) => c.is_solo);
  const mine = (b.collections ?? []).map((n) => cols.find((c) => c.name === n)).filter(Boolean) as BoneCollection[];
  if (solo) return mine.some((c) => c.is_solo);
  if (!b.collections?.length || !mine.length) return true;
  return mine.some((c) => c.is_visible);
}

/** Deselect bones that are no longer visible (after hiding a collection). */
export function deselectHidden(arm: ArmatureData) {
  for (const b of arm.bones) if (!boneVisible(arm, b)) setBoneSelected(b, false);
}

export function uniqueCollectionName(arm: ArmatureData, base: string) {
  const cols = collectionsOf(arm);
  if (!cols.some((c) => c.name === base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!cols.some((c) => c.name === n)) return n;
  }
}

export function addCollection(arm: ArmatureData, name = 'Bones'): BoneCollection {
  const c: BoneCollection = { name: uniqueCollectionName(arm, name), is_visible: true };
  const cols = collectionsOf(arm);
  cols.push(c);
  arm.active_collection_index = cols.length - 1;
  return c;
}

export function removeCollection(arm: ArmatureData, index: number) {
  const cols = collectionsOf(arm);
  const c = cols[index];
  if (!c) return false;
  cols.splice(index, 1);
  for (const b of arm.bones) if (b.collections) b.collections = b.collections.filter((n) => n !== c.name);
  arm.active_collection_index = Math.max(0, Math.min(index, cols.length - 1));
  return true;
}

export function renameCollection(arm: ArmatureData, index: number, name: string) {
  const c = collectionsOf(arm)[index];
  if (!c || !name || name === c.name) return;
  const prev = c.name;
  c.name = '\u0000';
  c.name = uniqueCollectionName(arm, name);
  for (const b of arm.bones) if (b.collections) b.collections = b.collections.map((n) => (n === prev ? c.name : n));
}

export function assignBone(b: Bone, name: string) {
  b.collections ??= [];
  if (!b.collections.includes(name)) b.collections.push(name);
}
export function unassignBone(b: Bone, name: string) {
  if (b.collections) b.collections = b.collections.filter((n) => n !== name);
}

// ---------------------------------------------------------------------------
// selection

const byName = (arm: ArmatureData) => new Map(arm.bones.map((b) => [b.name, b]));
export const childrenOf = (arm: ArmatureData, b: Bone) => arm.bones.filter((c) => c.parent === b.name);

export function setBoneSelected(b: Bone, on: boolean) {
  b.select = b.select_head = b.select_tail = on;
}

/** Select the X-mirrored counterparts of the selected bones. */
export function selectMirror(arm: ArmatureData, extend: boolean) {
  const map = byName(arm);
  const sel = arm.bones.filter((b) => b.select);
  if (!extend) for (const b of arm.bones) setBoneSelected(b, false);
  let active: string | null = null;
  for (const b of sel) {
    const m = map.get(flipSideName(b.name));
    if (!m || m === b) {
      if (extend) setBoneSelected(b, true);
      continue;
    }
    setBoneSelected(m, true);
    if (arm.active_bone === b.name) active = m.name;
  }
  if (active) arm.active_bone = active;
}

/** Neighbours of a bone in the hierarchy (parent and children). */
function neighbours(arm: ArmatureData, b: Bone) {
  const map = byName(arm);
  const out = childrenOf(arm, b);
  const p = b.parent ? map.get(b.parent) : undefined;
  if (p) out.push(p);
  return out;
}

export function selectMore(arm: ArmatureData, visible = (_b: Bone) => true) {
  const sel = new Set(arm.bones.filter((b) => b.select));
  for (const b of sel) for (const n of neighbours(arm, b)) if (visible(n)) setBoneSelected(n, true);
}

export function selectLess(arm: ArmatureData) {
  const sel = new Set(arm.bones.filter((b) => b.select));
  // bones at the border of the selection (or without relatives) are dropped
  const drop = [...sel].filter((b) => {
    const n = neighbours(arm, b);
    return !n.length || n.some((x) => !sel.has(x));
  });
  for (const b of drop) setBoneSelected(b, false);
}

/** All bones reachable through connected parent/child links from the seeds. */
export function linkedBones(arm: ArmatureData, seeds: Bone[], allForks = true): Set<Bone> {
  const map = byName(arm);
  const out = new Set<Bone>(seeds);
  const stack = [...seeds];
  while (stack.length) {
    const b = stack.pop()!;
    const rel: Bone[] = [];
    if (b.use_connect && b.parent) {
      const p = map.get(b.parent);
      if (p) rel.push(p);
    }
    const kids = childrenOf(arm, b).filter((c) => c.use_connect);
    if (allForks || kids.length <= 1) rel.push(...kids);
    for (const r of rel)
      if (!out.has(r)) {
        out.add(r);
        stack.push(r);
      }
  }
  return out;
}

/** Bones on the hierarchy path between two bones (inclusive), or empty if unrelated. */
export function bonePath(arm: ArmatureData, a: Bone, b: Bone): Bone[] {
  const map = byName(arm);
  const chain = (x: Bone) => {
    const out: Bone[] = [x];
    let p = x.parent ? map.get(x.parent) : undefined;
    while (p && out.length < 10000) {
      out.push(p);
      p = p.parent ? map.get(p.parent) : undefined;
    }
    return out;
  };
  const ca = chain(a),
    cb = chain(b);
  const common = ca.find((x) => cb.includes(x));
  if (!common) return [];
  return [...ca.slice(0, ca.indexOf(common) + 1), ...cb.slice(0, cb.indexOf(common)).reverse()];
}

export type SimilarType = 'LENGTH' | 'DIRECTION' | 'PREFIX' | 'SUFFIX' | 'BONE_COLLECTION' | 'CHILDREN' | 'CHILDREN_IMMEDIATE' | 'SIBLINGS';

export function selectSimilar(arm: ArmatureData, type: SimilarType, threshold: number, visible = (_b: Bone) => true) {
  const map = byName(arm);
  const act = (arm.active_bone && map.get(arm.active_bone)) || arm.bones.find((b) => b.select);
  if (!act) return false;
  const len = (b: Bone) => V(b.tail).distanceTo(V(b.head));
  const dir = (b: Bone) => V(b.tail).sub(V(b.head)).normalize();
  const prefix = (n: string) => /^(.*?)[._\- ]/.exec(n)?.[1] ?? '';
  const suffix = (n: string) => /[._\- ]([^._\- ]*)$/.exec(splitNumber(n)[0])?.[1] ?? '';
  const pick = (pred: (b: Bone) => boolean) => {
    for (const b of arm.bones) if (visible(b) && pred(b)) setBoneSelected(b, true);
  };
  switch (type) {
    case 'LENGTH': {
      const l = len(act);
      pick((b) => Math.abs(len(b) - l) <= threshold * Math.max(l, 1e-6));
      break;
    }
    case 'DIRECTION': {
      const d = dir(act);
      pick((b) => dir(b).angleTo(d) <= threshold * Math.PI);
      break;
    }
    case 'PREFIX': {
      const p = prefix(act.name);
      if (!p) return false;
      pick((b) => prefix(b.name) === p);
      break;
    }
    case 'SUFFIX': {
      const s = suffix(act.name);
      if (!s) return false;
      pick((b) => suffix(b.name) === s);
      break;
    }
    case 'BONE_COLLECTION': {
      const cols = new Set(act.collections ?? []);
      pick((b) => (b.collections ?? []).some((n) => cols.has(n)));
      break;
    }
    case 'CHILDREN':
    case 'CHILDREN_IMMEDIATE': {
      const sel = arm.bones.filter((b) => b.select);
      for (const s of sel) {
        const stack = childrenOf(arm, s);
        while (stack.length) {
          const c = stack.pop()!;
          if (visible(c)) setBoneSelected(c, true);
          if (type === 'CHILDREN') stack.push(...childrenOf(arm, c));
        }
      }
      break;
    }
    case 'SIBLINGS': {
      const parents = new Set(arm.bones.filter((b) => b.select).map((b) => b.parent));
      pick((b) => parents.has(b.parent));
      break;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// topology

export function newBoneLike(arm: ArmatureData, name: string, head: ArrayLike<number>, tail: ArrayLike<number>, parent: Bone | null, connect: boolean, template?: Bone): Bone {
  const b: Bone = {
    name: uniqueBoneName(arm, name),
    parent: parent?.name ?? null,
    head: [head[0], head[1], head[2]],
    tail: [tail[0], tail[1], tail[2]],
    roll: template?.roll ?? 0,
    use_connect: connect,
    use_deform: template?.use_deform ?? true,
    use_inherit_rotation: template?.use_inherit_rotation ?? true,
    inherit_scale: template?.inherit_scale ?? 'FULL',
    envelope_distance: template?.envelope_distance ?? 0.25,
    head_radius: template?.head_radius ?? 0.1,
    tail_radius: template?.tail_radius ?? 0.05,
    bbone_segments: template?.bbone_segments ?? 1,
  };
  const cols = template?.collections ?? parent?.collections;
  if (cols?.length) b.collections = [...cols];
  else if (arm.collections?.length) {
    const active = arm.collections[arm.active_collection_index ?? 0] ?? arm.collections[0];
    b.collections = [active.name];
  }
  arm.bones.push(b);
  return b;
}

interface Joint {
  bone: Bone;
  end: 'head' | 'tail';
}

/** Selected joints, merging a connected child's head into its parent's tail. */
export function selectedJoints(arm: ArmatureData, visible = (_b: Bone) => true): Joint[] {
  const out: Joint[] = [];
  const seen: Vector3[] = [];
  for (const b of arm.bones) {
    if (!visible(b)) continue;
    for (const end of ['head', 'tail'] as const) {
      if (!(end === 'head' ? b.select_head : b.select_tail)) continue;
      const p = V(b[end]);
      if (seen.some((q) => q.distanceToSquared(p) < 1e-12)) continue;
      seen.push(p);
      out.push({ bone: b, end });
    }
  }
  return out;
}

/**
 * Fill Between Joints: one joint → a bone from it to `cursor`; two joints → a bone between them,
 * parented (connected) to the bone whose tail starts it.
 */
export function fillJoints(arm: ArmatureData, cursor: ArrayLike<number>, visible = (_b: Bone) => true): Bone | null {
  const joints = selectedJoints(arm, visible);
  if (joints.length < 1 || joints.length > 2) return null;
  let a = joints[0],
    b = joints[1];
  if (!b) {
    const nb = newBoneLike(arm, 'Bone', a.bone[a.end], cursor, null, false);
    for (const x of arm.bones) setBoneSelected(x, false);
    setBoneSelected(nb, true);
    arm.active_bone = nb.name;
    return nb;
  }
  // start at a tail when possible so the new bone can connect to its owner
  if (a.end !== 'tail' && b.end === 'tail') [a, b] = [b, a];
  const parent = a.end === 'tail' ? a.bone : null;
  const nb = newBoneLike(arm, 'Bone', a.bone[a.end], b.bone[b.end], parent, !!parent);
  for (const x of arm.bones) setBoneSelected(x, false);
  setBoneSelected(nb, true);
  arm.active_bone = nb.name;
  return nb;
}

/** Split: selected bones lose their links to unselected parents and children. */
export function splitBones(arm: ArmatureData) {
  const map = byName(arm);
  let changed = false;
  for (const b of arm.bones) {
    if (!b.parent) continue;
    const p = map.get(b.parent);
    if (p && !!p.select !== !!b.select) {
      b.parent = null;
      b.use_connect = false;
      changed = true;
    }
  }
  return changed;
}

/** Dissolve: a selected bone absorbs its single connected child (repeating along selected chains). */
export function dissolveBones(arm: ArmatureData): string[] {
  const removed: string[] = [];
  const order = [...arm.bones];
  for (const b of order) {
    if (!b.select || removed.includes(b.name)) continue;
    for (let guard = 0; guard < 10000; guard++) {
      const kids = childrenOf(arm, b).filter((c) => c.use_connect);
      if (kids.length !== 1) break;
      const c = kids[0];
      const wasSelected = !!c.select;
      b.tail = [...c.tail] as Vec3;
      for (const g of childrenOf(arm, c)) g.parent = b.name;
      arm.bones.splice(arm.bones.indexOf(c), 1);
      removed.push(c.name);
      if (arm.active_bone === c.name) arm.active_bone = b.name;
      if (!wasSelected) break;
    }
  }
  return removed;
}
