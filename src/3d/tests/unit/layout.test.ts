import { describe, it, expect } from 'vitest';
import { areaRects, splitLayout, joinLayout, swapLayout, neighbourOn, removeFromLayout, treeFromRects, leaves, sharedSide } from '../../src/ui/layout';
import type { LayoutNode, AreaState } from '../../src/ui/screen';

const A = (id: string): LayoutNode => ({ area: { id, type: 'VIEW_3D' } });
const H = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ split: 'h', ratio, a, b });
const V = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ split: 'v', ratio, a, b });
const ids = (n: LayoutNode) => leaves(n).map((s) => s.id);
const W = 1002,
  HH = 602;

describe('area rectangles', () => {
  it('tile the screen with a gap between areas', () => {
    const r = areaRects(H(0.5, A('a'), V(0.5, A('b'), A('c'))), W, HH);
    expect(r.get('a')).toEqual({ x: 0, y: 0, w: 500, h: 602 });
    expect(r.get('b')).toEqual({ x: 502, y: 0, w: 500, h: 300 });
    expect(r.get('c')).toEqual({ x: 502, y: 302, w: 500, h: 300 });
  });
  it('finds shared edges', () => {
    expect(sharedSide({ x: 0, y: 0, w: 100, h: 50 }, { x: 102, y: 0, w: 30, h: 50 })).toBe('RIGHT');
    expect(sharedSide({ x: 0, y: 52, w: 100, h: 50 }, { x: 0, y: 0, w: 100, h: 50 })).toBe('UP');
    expect(sharedSide({ x: 0, y: 0, w: 100, h: 50 }, { x: 102, y: 0, w: 30, h: 40 })).toBeNull();
  });
});

describe('split', () => {
  it('replaces the area by two at the given ratio', () => {
    const st: AreaState = { id: 'n', type: 'TEXT' };
    const t = splitLayout(H(0.5, A('a'), A('b')), 'b', 'v', 0.25, st);
    expect(ids(t)).toEqual(['a', 'b', 'n']);
    const r = areaRects(t, W, HH);
    expect(r.get('b')!.h).toBe(150);
    expect(r.get('n')!.y).toBe(152);
  });
});

describe('join', () => {
  it('joins siblings: the kept area takes the whole room', () => {
    const t = joinLayout(H(0.3, A('a'), A('b')), 'a', 'b', W, HH)!;
    expect(t).toEqual(A('a'));
  });
  it('joins across a nested split when the edges line up', () => {
    // a | b | c : join b into a
    const t = joinLayout(H(0.3, A('a'), H(0.5, A('b'), A('c'))), 'a', 'b', W, HH)!;
    expect(ids(t)).toEqual(['a', 'c']);
    const before = areaRects(H(0.3, A('a'), H(0.5, A('b'), A('c'))), W, HH);
    const after = areaRects(t, W, HH);
    expect(after.get('c')).toEqual(before.get('c'));
    expect(after.get('a')!.w).toBe(before.get('a')!.w + 2 + before.get('b')!.w);
  });
  it('rebuilds the tree when the joined areas are in different subtrees', () => {
    // [x / a] | [y / b] with equal row heights: a and b share an edge
    const root = H(0.5, V(0.5, A('x'), A('a')), V(0.5, A('y'), A('b')));
    const t = joinLayout(root, 'a', 'b', W, HH)!;
    expect(t).not.toBeNull();
    const r = areaRects(t, W, HH);
    expect(r.get('a')).toEqual({ x: 0, y: 302, w: 1002, h: 300 });
    expect(r.get('x')!.w).toBe(500);
    expect(r.get('y')!.x).toBe(502);
  });
  it('refuses areas that do not share a whole edge', () => {
    const root = H(0.5, A('a'), V(0.5, A('b'), A('c')));
    expect(joinLayout(root, 'a', 'b', W, HH)).toBeNull();
    expect(joinLayout(root, 'b', 'c', W, HH)).not.toBeNull();
  });
  it('finds the neighbour on a side', () => {
    const root = H(0.5, A('a'), V(0.5, A('b'), A('c')));
    expect(neighbourOn(root, 'b', 'DOWN', W, HH)).toBe('c');
    expect(neighbourOn(root, 'a', 'RIGHT', W, HH)).toBeNull();
    expect(neighbourOn(root, 'b', 'LEFT', W, HH)).toBeNull();
  });
});

describe('swap and remove', () => {
  it('swaps two areas keeping the geometry', () => {
    const root = H(0.3, A('a'), V(0.5, A('b'), A('c')));
    const t = swapLayout(root, 'a', 'c');
    expect(ids(t)).toEqual(['c', 'b', 'a']);
    expect(areaRects(t, W, HH).get('c')).toEqual(areaRects(root, W, HH).get('a'));
  });
  it('removes an area giving room to its sibling', () => {
    const t = removeFromLayout(H(0.3, A('a'), V(0.5, A('b'), A('c'))), 'b')!;
    expect(t).toEqual(H(0.3, A('a'), A('c')));
    expect(removeFromLayout(A('a'), 'a')).toBeNull();
  });
  it('builds trees from tiling rectangles', () => {
    const rects = areaRects(V(0.4, H(0.5, A('a'), A('b')), A('c')), W, HH);
    const items = ['a', 'b', 'c'].map((id) => ({ st: { id, type: 'VIEW_3D' as const }, r: rects.get(id)! }));
    const t = treeFromRects(items, { x: 0, y: 0, w: W, h: HH })!;
    const back = areaRects(t, W, HH);
    for (const id of ['a', 'b', 'c']) expect(back.get(id)).toEqual(rects.get(id));
  });
});
