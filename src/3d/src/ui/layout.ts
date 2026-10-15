// Pure layout-tree helpers for the screen: area rectangles, splitting, joining and swapping.
// A layout is a binary tree of side-by-side ('h') and stacked ('v') splits whose leaves are areas.
import type { AreaState, LayoutNode } from './screen';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Split = Extract<LayoutNode, { split: string }>;
export type Side = 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';

/** Pixel gap between neighbouring areas (the divider). */
export const GAP = 2;

/** Rectangles of all areas for a screen of `w`×`h` pixels (same rounding as the screen layout). */
export function areaRects(n: LayoutNode, w: number, h: number, gap = GAP): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const place = (n: LayoutNode, x: number, y: number, w: number, hh: number) => {
    if ('area' in n) {
      out.set(n.area.id, { x, y, w, h: hh });
      return;
    }
    if (n.split === 'h') {
      const wa = Math.round((w - gap) * n.ratio);
      place(n.a, x, y, wa, hh);
      place(n.b, x + wa + gap, y, w - wa - gap, hh);
    } else {
      const ha = Math.round((hh - gap) * n.ratio);
      place(n.a, x, y, w, ha);
      place(n.b, x, y + ha + gap, w, hh - ha - gap);
    }
  };
  place(n, 0, 0, w, h);
  return out;
}

export function leaves(n: LayoutNode, out: AreaState[] = []): AreaState[] {
  if ('area' in n) out.push(n.area);
  else {
    leaves(n.a, out);
    leaves(n.b, out);
  }
  return out;
}

function findLeaf(n: LayoutNode, id: string, parent: Split | null = null): { node: LayoutNode; parent: Split | null } | null {
  if ('area' in n) return n.area.id === id ? { node: n, parent } : null;
  return findLeaf(n.a, id, n) ?? findLeaf(n.b, id, n);
}

/**
 * Split area `id`: `dir` 'h' puts the two halves side by side, 'v' stacks them. The new area
 * (`added`) takes the right/bottom part unless `addedFirst`. Returns a new tree.
 */
export function splitLayout(root: LayoutNode, id: string, dir: 'h' | 'v', ratio: number, added: AreaState, addedFirst = false): LayoutNode {
  const r = Math.max(0.02, Math.min(0.98, ratio));
  const rec = (n: LayoutNode): LayoutNode => {
    if ('area' in n) {
      if (n.area.id !== id) return n;
      const nn: LayoutNode = { area: added };
      return addedFirst ? { split: dir, ratio: r, a: nn, b: n } : { split: dir, ratio: r, a: n, b: nn };
    }
    return { ...n, a: rec(n.a), b: rec(n.b) };
  };
  return rec(root);
}

/** Exchange the places of two areas. */
export function swapLayout(root: LayoutNode, idA: string, idB: string): LayoutNode {
  const fa = findLeaf(root, idA),
    fb = findLeaf(root, idB);
  if (!fa || !fb || idA === idB) return root;
  const sa = (fa.node as { area: AreaState }).area,
    sb = (fb.node as { area: AreaState }).area;
  const rec = (n: LayoutNode): LayoutNode => {
    if ('area' in n) return n.area.id === idA ? { area: sb } : n.area.id === idB ? { area: sa } : n;
    return { ...n, a: rec(n.a), b: rec(n.b) };
  };
  return rec(root);
}

const near = (a: number, b: number, tol = 2.5) => Math.abs(a - b) <= tol;

/** Which side of `a` the rectangle `b` lies on when the two share a whole edge, else null. */
export function sharedSide(a: Rect, b: Rect, gap = GAP): Side | null {
  if (near(a.y, b.y) && near(a.h, b.h)) {
    if (near(a.x + a.w + gap, b.x)) return 'RIGHT';
    if (near(b.x + b.w + gap, a.x)) return 'LEFT';
  }
  if (near(a.x, b.x) && near(a.w, b.w)) {
    if (near(a.y + a.h + gap, b.y)) return 'DOWN';
    if (near(b.y + b.h + gap, a.y)) return 'UP';
  }
  return null;
}

/** The area that shares the whole `side` edge of area `id` (a join candidate), if any. */
export function neighbourOn(root: LayoutNode, id: string, side: Side, w: number, h: number): string | null {
  const rects = areaRects(root, w, h);
  const a = rects.get(id);
  if (!a) return null;
  for (const [other, r] of rects) if (other !== id && sharedSide(a, r) === side) return other;
  return null;
}

/** Rebuild a split tree (with ratios) from area rectangles that tile `box`; null when no guillotine cut exists. */
export function treeFromRects(items: { st: AreaState; r: Rect }[], box: Rect, prefer: 'h' | 'v' = 'h', gap = GAP): LayoutNode | null {
  if (items.length === 1) return { area: items[0].st };
  if (!items.length) return null;
  const tryCut = (dir: 'h' | 'v'): LayoutNode | null => {
    const ends = [...new Set(items.map(({ r }) => Math.round(dir === 'h' ? r.x + r.w : r.y + r.h)))].sort((p, q) => p - q);
    for (const c of ends) {
      const boxEnd = dir === 'h' ? box.x + box.w : box.y + box.h;
      if (near(c, boxEnd)) continue;
      const A: typeof items = [],
        B: typeof items = [];
      let ok = true;
      for (const it of items) {
        const s = dir === 'h' ? it.r.x : it.r.y;
        const e = dir === 'h' ? it.r.x + it.r.w : it.r.y + it.r.h;
        if (e <= c + 2.5) A.push(it);
        else if (s >= c + gap - 2.5) B.push(it);
        else {
          ok = false;
          break;
        }
      }
      if (!ok || !A.length || !B.length) continue;
      const boxA: Rect = dir === 'h' ? { x: box.x, y: box.y, w: c - box.x, h: box.h } : { x: box.x, y: box.y, w: box.w, h: c - box.y };
      const boxB: Rect = dir === 'h' ? { x: c + gap, y: box.y, w: box.x + box.w - c - gap, h: box.h } : { x: box.x, y: c + gap, w: box.w, h: box.y + box.h - c - gap };
      const ta = treeFromRects(A, boxA, prefer, gap),
        tb = treeFromRects(B, boxB, prefer, gap);
      if (!ta || !tb) continue;
      const total = (dir === 'h' ? box.w : box.h) - gap;
      return { split: dir, ratio: total > 0 ? (dir === 'h' ? boxA.w : boxA.h) / total : 0.5, a: ta, b: tb };
    }
    return null;
  };
  return tryCut(prefer) ?? tryCut(prefer === 'h' ? 'v' : 'h');
}

/**
 * Join: area `keep` grows over its neighbour `remove`, which must share a whole edge with it.
 * Returns the new tree, or null when the two areas cannot be joined.
 */
export function joinLayout(root: LayoutNode, keep: string, remove: string, w: number, h: number): LayoutNode | null {
  const rects = areaRects(root, w, h);
  const a = rects.get(keep),
    b = rects.get(remove);
  if (!a || !b || keep === remove || !sharedSide(a, b)) return null;
  const union: Rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: 0, h: 0 };
  union.w = Math.max(a.x + a.w, b.x + b.w) - union.x;
  union.h = Math.max(a.y + a.h, b.y + b.h) - union.y;
  const items = leaves(root)
    .filter((st) => st.id !== remove)
    .map((st) => ({ st, r: st.id === keep ? union : rects.get(st.id)! }));
  const prefer = 'area' in root ? 'h' : root.split;
  const tree = treeFromRects(items, { x: 0, y: 0, w, h }, prefer);
  if (!tree) return null;
  // the rebuilt tree must reproduce the intended rectangles
  const check = areaRects(tree, w, h);
  for (const it of items) {
    const r = check.get(it.st.id);
    if (!r || !near(r.x, it.r.x, 3) || !near(r.y, it.r.y, 3) || !near(r.w, it.r.w, 3) || !near(r.h, it.r.h, 3)) return null;
  }
  return tree;
}

/** Remove area `id`, giving its room to its sibling subtree (Close Area). */
export function removeFromLayout(root: LayoutNode, id: string): LayoutNode | null {
  const f = findLeaf(root, id);
  if (!f?.parent) return null;
  const parent = f.parent;
  const other = parent.a === f.node ? parent.b : parent.a;
  const rec = (n: LayoutNode): LayoutNode => {
    if (n === parent) return other;
    if ('area' in n) return n;
    return { ...n, a: rec(n.a), b: rec(n.b) };
  };
  return rec(root);
}
