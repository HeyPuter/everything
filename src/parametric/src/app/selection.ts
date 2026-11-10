// Selection and pre-selection (hover) of model entities, reference geometry,
// features and sketch entities.

import type { EdgeInfo, FaceInfo } from '../kernel/protocol';
import type { Vec3 } from '../math/vec';
import type { EdgeRef, FaceRef, Id, PlaneRef } from '../model/types';

export type SelItem =
  | { kind: 'face'; index: number; name: string }
  | { kind: 'edge'; index: number; name: string }
  | { kind: 'vertex'; p: Vec3 }
  | { kind: 'plane'; ref: PlaneRef & { kind: 'base' | 'feature' } }
  | { kind: 'origin' }
  | { kind: 'axis'; axis: 'x' | 'y' | 'z' }
  | { kind: 'feature'; id: Id }
  | { kind: 'sk'; id: Id }
  | { kind: 'skdim'; id: Id }
  | { kind: 'skrel'; id: Id };

export function sameItem(a: SelItem, b: SelItem): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'face':
    case 'edge':
      return a.index === (b as typeof a).index;
    case 'vertex': {
      const p = (b as typeof a).p;
      return Math.abs(a.p[0] - p[0]) + Math.abs(a.p[1] - p[1]) + Math.abs(a.p[2] - p[2]) < 1e-9;
    }
    case 'plane': {
      const r = (b as typeof a).ref;
      return a.ref.kind === r.kind && (a.ref.kind === 'base' ? a.ref.plane === (r as typeof a.ref).plane : a.ref.id === (r as { id: Id }).id);
    }
    case 'origin':
      return true;
    case 'axis':
      return a.axis === (b as typeof a).axis;
    default:
      return (a as { id: Id }).id === (b as { id: Id }).id;
  }
}

export function faceRef(f: FaceInfo): FaceRef {
  return { name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } };
}

export function edgeRef(e: EdgeInfo): EdgeRef {
  return { name: e.name, sig: { type: e.type, m: e.mid, len: e.length } };
}

export class Selection {
  items: SelItem[] = [];
  hover: SelItem | null = null;
  private listeners = new Set<(hoverOnly: boolean) => void>();

  /** Listeners learn whether only the pre-selection (hover) changed. */
  on(fn: (hoverOnly: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(hoverOnly = false) {
    for (const fn of this.listeners) fn(hoverOnly);
  }

  has(it: SelItem): boolean {
    return this.items.some((x) => sameItem(x, it));
  }

  set(items: SelItem[]) {
    this.items = [...items];
    this.emit();
  }

  add(it: SelItem) {
    if (!this.has(it)) {
      this.items.push(it);
      this.emit();
    }
  }

  remove(it: SelItem) {
    const n = this.items.length;
    this.items = this.items.filter((x) => !sameItem(x, it));
    if (this.items.length !== n) this.emit();
  }

  toggle(it: SelItem) {
    if (this.has(it)) this.remove(it);
    else this.add(it);
  }

  clear() {
    if (!this.items.length) return;
    this.items = [];
    this.emit();
  }

  setHover(it: SelItem | null) {
    const same = (!it && !this.hover) || (it && this.hover && sameItem(it, this.hover));
    if (same) return;
    this.hover = it;
    this.emit(true);
  }

  ofKind<K extends SelItem['kind']>(kind: K): Extract<SelItem, { kind: K }>[] {
    return this.items.filter((x) => x.kind === kind) as Extract<SelItem, { kind: K }>[];
  }

  /** After a rebuild: re-map faces/edges by name, dropping items (and vertices) that vanished. */
  revalidate(faces: FaceInfo[], edges: EdgeInfo[]) {
    let changed = false;
    const remap = (it: SelItem): SelItem | null => {
      const r = remapItem(it, faces, edges);
      if (r !== it) changed = true;
      return r;
    };
    this.items = this.items.map(remap).filter((x): x is SelItem => !!x);
    if (this.hover) this.hover = remap(this.hover);
    if (changed) this.emit();
  }
}

/**
 * An item picked before a rebuild, on the rebuilt part: faces and edges are
 * found again by name; a vertex stays only while an edge still ends there.
 * Returns the same object when nothing changed and null when it vanished.
 */
export function remapItem(it: SelItem, faces: FaceInfo[], edges: EdgeInfo[]): SelItem | null {
  if (it.kind === 'vertex') {
    // Every vertex of the solid ends an edge; one that moved or went is no longer there to select.
    // (Picked vertices come from single-precision mesh data, hence the relative tolerance.)
    const p = it.p;
    const tol = 1e-5 * (1 + Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]));
    return edges.some((e) => [e.a, e.b].some((q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]) < tol)) ? it : null;
  }
  if (it.kind === 'face') {
    if (faces[it.index]?.name === it.name) return it;
    const i = faces.findIndex((f) => f.name === it.name);
    return i >= 0 ? { ...it, index: i } : null;
  }
  if (it.kind === 'edge') {
    if (edges[it.index]?.name === it.name) return it;
    const i = edges.findIndex((e) => e.name === it.name);
    return i >= 0 ? { ...it, index: i } : null;
  }
  return it;
}
