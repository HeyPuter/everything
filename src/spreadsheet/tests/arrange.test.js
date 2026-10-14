import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { orderObjects, moveObjectTo, groupObjects, ungroupObjects, withGroups, alignRects, distributeRects, boundsOf, rotatePatch, snapRect, canRotate } from '../src/core/arrange.js';

const ids = list => list.map(o => o.id);
const L = (...names) => names.map(n => (typeof n === 'string' ? { id: n } : n));

describe('stacking order', () => {
  it('brings to front and sends to back keeping the moved objects in order', () => {
    const list = L('a', 'b', 'c', 'd', 'e');
    expect(ids(orderObjects(list, ['b', 'd'], 'front'))).toEqual(['a', 'c', 'e', 'b', 'd']);
    expect(ids(orderObjects(list, ['b', 'd'], 'back'))).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('moves forward and backward past one other object each', () => {
    const list = L('a', 'b', 'c', 'd', 'e');
    expect(ids(orderObjects(list, ['b'], 'forward'))).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(ids(orderObjects(list, ['d', 'e'], 'forward'))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(orderObjects(list, ['c', 'd'], 'forward'))).toEqual(['a', 'b', 'e', 'c', 'd']);
    expect(ids(orderObjects(list, ['b', 'c'], 'backward'))).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('moves a group as one unit', () => {
    const list = L('a', { id: 'b', group: 'g' }, { id: 'c', group: 'g' }, 'd');
    expect(withGroups(list, ['c'])).toEqual(['b', 'c']);
    expect(ids(orderObjects(list, ['b'], 'forward'))).toEqual(['a', 'd', 'b', 'c']);
    expect(ids(orderObjects(list, ['d'], 'backward'))).toEqual(['a', 'd', 'b', 'c']);
    expect(ids(orderObjects(list, ['a'], 'forward'))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(moveObjectTo(list, 'd', 0))).toEqual(['d', 'a', 'b', 'c']);
    // A drop between a group's members lands before the group.
    expect(ids(moveObjectTo(list, 'a', 1))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(moveObjectTo(list, 'a', 2))).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('groups', () => {
  it('brings members together at the front member\'s place, and ungroups in place', () => {
    const list = L('a', 'b', 'c', 'd');
    const grouped = groupObjects(list, ['a', 'c'], 'g1');
    expect(ids(grouped)).toEqual(['b', 'a', 'c', 'd']);
    expect(grouped.filter(o => o.group === 'g1').map(o => o.id)).toEqual(['a', 'c']);
    expect(groupObjects(list, ['a'], 'g2')).toBeNull();
    const ungrouped = ungroupObjects(grouped, ['c']);
    expect(ungrouped.some(o => o.group)).toBe(false);
    expect(ids(ungrouped)).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('alignment and distribution', () => {
  const rects = [{ id: 'a', x: 10, y: 10, w: 50, h: 20 }, { id: 'b', x: 100, y: 40, w: 30, h: 60 }, { id: 'c', x: 40, y: 200, w: 20, h: 10 }];
  it('aligns to the edges and centres of the box around them all', () => {
    expect(boundsOf(rects)).toEqual({ x: 10, y: 10, w: 120, h: 200 });
    expect(alignRects(rects, 'left').map(r => r.x)).toEqual([10, 10, 10]);
    expect(alignRects(rects, 'right').map(r => r.x)).toEqual([80, 100, 110]);
    expect(alignRects(rects, 'center').map(r => r.x)).toEqual([45, 55, 60]);
    expect(alignRects(rects, 'top').map(r => r.y)).toEqual([10, 10, 10]);
    expect(alignRects(rects, 'bottom').map(r => r.y)).toEqual([190, 150, 200]);
    expect(alignRects(rects, 'middle').map(r => r.y)).toEqual([100, 80, 105]);
    // One object has nothing to align with.
    expect(alignRects([rects[0]], 'right')).toEqual([{ id: 'a', x: 10, y: 10 }]);
  });

  it('leaves equal gaps between neighbours, the outer two staying put', () => {
    const row = [{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 15, y: 0, w: 20, h: 10 }, { id: 'c', x: 90, y: 0, w: 10, h: 10 }];
    const out = distributeRects(row, 'horizontal');
    expect(out.map(r => r.x)).toEqual([0, 40, 90]);
    expect(distributeRects(row.slice(0, 2), 'horizontal').map(r => r.x)).toEqual([0, 15]);
    const col = row.map(r => ({ ...r, x: 0, y: r.x, w: 10, h: r.w }));
    expect(distributeRects(col, 'vertical').map(r => r.y)).toEqual([0, 40, 90]);
  });

  it('snaps an edge to the nearest line within reach', () => {
    expect(snapRect({ x: 103, y: 47, w: 20, h: 10 }, [0, 100, 200], [0, 60], 5)).toEqual({ x: 100, y: 50 });
    expect(snapRect({ x: 130, y: 20, w: 20, h: 10 }, [0, 100, 200], [0, 60], 5)).toEqual({ x: 130, y: 20 });
  });

  it('rotates by quarter turns and flips', () => {
    expect(rotatePatch({ rotation: 270 }, 'right')).toEqual({ rotation: 0 });
    expect(rotatePatch({}, 'left')).toEqual({ rotation: 270 });
    expect(rotatePatch({ flipH: true }, 'flipH')).toEqual({ flipH: false });
    expect(canRotate({ type: 'image' }) && canRotate({ type: 'text' }) && !canRotate({ type: 'column' })).toBe(true);
  });
});

describe('workbook arrange', () => {
  const book = () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const a = wb.addChart(id, { type: 'text', text: 'A', anchor: { r: 1, c: 1 }, dx: 0, dy: 0, w: 100, h: 50 });
    const b = wb.addChart(id, { type: 'text', text: 'B', anchor: { r: 5, c: 3 }, dx: 10, dy: 4, w: 60, h: 40 });
    const c = wb.addChart(id, { type: 'text', text: 'C', anchor: { r: 2, c: 6 }, dx: 0, dy: 0, w: 80, h: 30 });
    return { wb, id, a, b, c };
  };

  it('aligns objects as one undo step, re-anchoring them to the cells under them', () => {
    const { wb, id, a, b, c } = book();
    const before = [a, b, c].map(o => wb.objectRect(id, o));
    expect(wb.alignObjects(id, [a, b, c], 'left')).toBe(true);
    const after = [a, b, c].map(o => wb.objectRect(id, o));
    expect(new Set(after.map(r => Math.round(r.x))).size).toBe(1);
    expect(after.map(r => r.y)).toEqual(before.map(r => r.y));
    expect(wb.chartById(id, c).anchor.c).toBe(wb.chartById(id, a).anchor.c);
    wb.undo();
    expect([a, b, c].map(o => wb.objectRect(id, o))).toEqual(before);
  });

  it('orders, groups, regroups, hides and renames', () => {
    const { wb, id, a, b, c } = book();
    wb.orderObjects(id, [a], 'front');
    expect(wb.activeSheet.charts.map(o => o.id)).toEqual([b, c, a]);
    const g = wb.groupObjects(id, [b, a]);
    expect(wb.activeSheet.charts.filter(o => o.group === g).map(o => o.id)).toEqual([b, a]);
    expect(wb.activeSheet.charts.map(o => o.id)).toEqual([c, b, a]);
    expect(wb.ungroupObjects(id, [a])).toBe(true);
    expect(wb.canRegroup(id)).toBe(true);
    expect(wb.regroupObjects(id)).toBeTruthy();
    expect(wb.activeSheet.charts.filter(o => o.group).length).toBe(2);
    wb.setObjectsHidden(id, [c], true);
    expect(wb.chartById(id, c).hidden).toBe(true);
    wb.renameObject(id, c, '  Note box ');
    expect(wb.chartById(id, c).name).toBe('Note box');
    const back = new Workbook(wb.toJSON());
    expect(back.activeSheet.charts.map(o => [o.name ?? null, !!o.hidden, !!o.group])).toEqual([['Note box', true, false], [null, false, true], [null, false, true]]);
    wb.undo();
    expect(wb.chartById(id, c).name).toBeUndefined();
  });

  it('rotates text boxes and pictures but not charts, and deletes several at once', () => {
    const { wb, id, a, b } = book();
    wb.rotateObjects(id, [a], 'right');
    wb.rotateObjects(id, [a], 'flipV');
    expect(wb.chartById(id, a)).toMatchObject({ rotation: 90, flipV: true });
    expect(wb.deleteObjects(id, [a, b])).toBe(true);
    expect(wb.activeSheet.charts).toHaveLength(1);
    wb.undo();
    expect(wb.activeSheet.charts).toHaveLength(3);
  });
});
