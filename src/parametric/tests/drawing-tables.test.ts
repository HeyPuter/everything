// Bill of materials and cut list tables, balloons and their numbering, automatic balloon
// placement, and the drawing data they add (validated on open).
import { describe, expect, it } from 'vitest';
import { buildSheet, standardLayout, toSvg } from '../src/drawing/sheet';
import type { BomRow } from '../src/drawing/source';
import {
  BALLOON_R, TABLE_ROW_H, autoBalloons, balloonTip, bomTable, cutListTable, drawBalloon, drawTable, fitCell, splitTable, itemOfEdge, layoutTable, tableOrigin, tableSize,
} from '../src/drawing/tables';
import { textWidth } from '../src/drawing/pdf';
import { toDxf } from '../src/drawing/dxf';
import type { Prim } from '../src/drawing/views';
import { newAssembly, validateAssembly } from '../src/model/assembly';
import { validDrawing } from '../src/model/validate-drawing';
import { cutListRows, weldmentCutList, type WeldMemberInfo } from '../src/model/weldments';
import type { DrawingDoc } from '../src/model/types';
import type { Item } from '../src/drawing/sheet';
import { SHEETS } from '../src/drawing/sheet';
import { toolSpecs } from '../src/assistant/tools';

const rows: BomRow[] = [
  { item: 1, name: 'Base plate', material: 'Steel', qty: 1, prefixes: ['c1#'] },
  { item: 2, name: 'Pin', material: '', qty: 3, prefixes: ['c2#', 'c3#', 'c4#'] },
];

describe('tables', () => {
  it('lays out a bill of materials with fixed column widths, the header first', () => {
    const t = bomTable(rows);
    expect(t.header).toEqual(['ITEM NO.', 'PART NUMBER', 'MATERIAL', 'QTY.']);
    expect(t.rows).toEqual([['1', 'Base plate', 'Steel', '1'], ['2', 'Pin', '', '3']]);
    const { w, h } = tableSize(t);
    expect(w).toBe(126);
    expect(h).toBe(3 * TABLE_ROW_H);
    // The same width whatever the rows hold (a table on the title block keeps its place).
    expect(tableSize(bomTable([{ ...rows[0], name: 'A much longer part number than the column holds' }])).w).toBe(126);
    const L = layoutTable(t, [100, 50]);
    expect(L.box).toEqual([100, 50, 226, 50 + 3 * TABLE_ROW_H]);
    expect(L.cols).toEqual([100, 116, 168, 212, 226]);
    expect(L.rows).toEqual([50, 56, 62, 68]);
    const cell = (s: string) => L.texts.find((x) => x.s === s)!;
    // Header centred and bold; item numbers and quantities centred, names from the left.
    expect(cell('PART NUMBER')).toMatchObject({ x: 142, anchor: 'middle', bold: true });
    expect(cell('Base plate')).toMatchObject({ anchor: 'start', bold: false });
    expect(cell('Base plate').x).toBeCloseTo(117.2, 6);
    expect(cell('Base plate').y).toBeGreaterThan(56);
    expect(cell('Base plate').y).toBeLessThan(62);
    expect(cell('3')).toMatchObject({ x: 219, anchor: 'middle' });
  });

  it('places a table on the title block by its bottom right corner, growing upward', () => {
    const t = bomTable(rows);
    expect(tableOrigin(t, [400, 255], 'bottomRight')).toEqual([400 - 126, 255 - 18]);
    expect(layoutTable(t, [400, 255], 'bottomRight').box).toEqual([274, 237, 400, 255]);
    expect(tableOrigin(t, [10, 10])).toEqual([10, 10]);
  });

  it('shrinks long values to fit their cell, then cuts them short', () => {
    expect(fitCell('Pin', 40, 2.5)).toEqual({ s: 'Pin', size: 2.5 });
    const f = fitCell('A rather long name', 20, 2.5);
    expect(f.size).toBeLessThan(2.5);
    expect(textWidth(f.s, f.size)).toBeLessThanOrEqual(20 + 1e-9);
    const g = fitCell('An extremely long part name that cannot fit in the cell at all', 20, 2.5);
    expect(g.s.endsWith('…')).toBe(true);
    expect(textWidth(g.s, g.size)).toBeLessThanOrEqual(20 + 1e-9);
  });

  it('writes a value cut short with an ellipsis that DXF can show', () => {
    const items: Item[] = [];
    drawTable(items, bomTable([{ item: 1, name: 'A very long part number that cannot fit in its cell at all, not even in the smallest legible text', material: 'Steel', qty: 1, prefixes: [] }]), [10, 10]);
    const text = toDxf(items, 297, 210);
    expect(text).toMatch(/\nA very long part.*\.\.\.\n/);
    expect(text).not.toMatch(/\nA very long part.*\?\n/);
  });

  it('makes the cut list table from the cut list rows', () => {
    const m = (feature: string, member: string, length: number, a1: number, a2: number): WeldMemberInfo => ({
      feature, member, group: 0, standard: 'iso', profile: 'squareTube', size: '40x40x3', desc: 'SQ TUBE 40 x 40 x 3', length, angle1: a1, angle2: a2, volume: length * 444, area: 444,
    });
    const list = weldmentCutList({ material: null }, [m('M1', 's/a', 440, 45, 45), m('M1', 's/b', 240, 45, 45), m('M1', 's/c', 440, 45, 45), m('M1', 's/d', 240, 45, 45)]);
    const r = cutListRows(list, 'MMGS', 1);
    const t = cutListTable(r.rows, 'mm');
    expect(t.header).toEqual(['ITEM NO.', 'QTY.', 'DESCRIPTION', 'LENGTH (mm)', 'ANGLE1', 'ANGLE2']);
    expect(t.rows).toEqual([['1', '2', 'SQ TUBE 40 x 40 x 3', '440.0', '45.00°', '45.00°'], ['2', '2', 'SQ TUBE 40 x 40 x 3', '240.0', '45.00°', '45.00°']]);
    expect(t.widths).toHaveLength(6);
    expect(tableSize(t).w).toBeLessThanOrEqual(170);
  });

  it('draws the table, a value missing from the source as a note, and both are boxes to pick', () => {
    const d: DrawingDoc = {
      sheet: 'A3', landscape: true, scale: 1, title: '', drawnBy: '', notes: '', views: [],
      annotations: [{ id: 'a1', type: 'bom', at: [410, 255], anchor: 'bottomRight' }, { id: 'a2', type: 'cutList', at: [20, 20] }],
    };
    const s = buildSheet(d, new Map(), { partName: 'A', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(1), table: (a) => (a.type === 'bom' ? bomTable(rows) : null) });
    const svg = toSvg(s.items, s.w, s.h);
    expect(svg).toContain('>PART NUMBER<');
    expect(svg).toContain('>Base plate<');
    expect(svg).toContain('CUT LIST? (no structural members)');
    expect(s.annos.find((a) => a.id === 'a1')!.box).toEqual([284, 237, 410, 255]);
    expect(s.annos.find((a) => a.id === 'a2')).toBeTruthy();
    expect(s.warnings).toEqual([]);
  });

  it('continues a table too tall for the sheet in columns to its left, each with the header, all on the sheet', () => {
    const many: BomRow[] = Array.from({ length: 60 }, (_, i) => ({ item: i + 1, name: `Part ${i + 1}`, material: '', qty: 1, prefixes: [`c${i}#`] }));
    const d: DrawingDoc = { sheet: 'A3', landscape: true, scale: 1, title: '', drawnBy: '', notes: '', views: [], annotations: [{ id: 'a1', type: 'bom', at: [410, 255], anchor: 'bottomRight' }] };
    const s = buildSheet(d, new Map(), { partName: 'A', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(1), table: () => bomTable(many) });
    const texts = s.items.filter((it): it is Extract<Item, { t: 'text' }> => it.t === 'text');
    // Every row once, the header in each column, everything inside the border.
    for (let i = 1; i <= 60; i++) expect(texts.filter((x) => x.s === `Part ${i}`)).toHaveLength(1);
    expect(texts.filter((x) => x.s === 'PART NUMBER')).toHaveLength(2);
    for (const x of texts) expect(x.y).toBeGreaterThan(10);
    const box = s.annos.find((a) => a.id === 'a1')!.box;
    expect(box[1]).toBeGreaterThanOrEqual(10);
    expect(box[0]).toBeGreaterThanOrEqual(10);
    expect(box[2]).toBe(410);
    expect(box[3]).toBe(255);
    // Item 1 is in the first column (on the right), the last item in the one left of it, both standing on the title block.
    const first = texts.find((x) => x.s === 'Part 1')!, last = texts.find((x) => x.s === 'Part 60')!;
    expect(last.x).toBeLessThan(first.x - tableSize(bomTable(many)).w);
    expect(s.warnings).toEqual([]);
    const parts = splitTable(bomTable(many), [410, 255], 'bottomRight', { top: 10, bottom: 287, left: 10, right: 410 });
    expect(parts.parts.length).toBe(2);
    expect(parts.parts[0].t.rows[0][1]).toBe('Part 1');
    expect(parts.parts.every((p) => tableSize(p.t).h <= 245)).toBe(true);
    expect(parts.fits).toBe(true);
  });

  it('says in red, and as a warning, when a table does not fit on the sheet even split', () => {
    const many: BomRow[] = Array.from({ length: 400 }, (_, i) => ({ item: i + 1, name: `Part ${i + 1}`, material: '', qty: 1, prefixes: [] }));
    const d: DrawingDoc = { sheet: 'A4', landscape: true, scale: 1, title: '', drawnBy: '', notes: '', views: [], annotations: [{ id: 'a1', type: 'bom', at: [287, 168], anchor: 'bottomRight' }] };
    const s = buildSheet(d, new Map(), { partName: 'A', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(1), table: () => bomTable(many) });
    expect(s.warnings).toEqual(['The bill of materials does not fit on this sheet: use a larger sheet.']);
    const note = s.items.find((it): it is Extract<Item, { t: 'text' }> => it.t === 'text' && it.s.includes('DOES NOT FIT'))!;
    expect(note.color).toBeTruthy();
    expect(note.x).toBeGreaterThanOrEqual(10);
    expect(note.x + textWidth(note.s, note.size)).toBeLessThanOrEqual(287 + 1e-9);
    expect(note.y).toBeGreaterThan(10);
  });
});

describe('balloons', () => {
  it('numbers a balloon from the bill of materials row of the component its edge belongs to', () => {
    expect(itemOfEdge('c1#E1:cap0|E1:side:1', rows)).toBe(1);
    expect(itemOfEdge('c3#E1:cap1', rows)).toBe(2);
    expect(itemOfEdge('c9#E1:cap1', rows)).toBeNull();
    // A component id that starts like another's is not taken for it.
    expect(itemOfEdge('c11#E1:cap1', rows)).toBeNull();
  });

  it('ends its leader on the middle of a line, on a circle toward the balloon, or on an arc’s middle', () => {
    expect(balloonTip({ kind: 'line', a: [0, 0], b: [10, 0] }, [50, 50])).toEqual([5, 0]);
    const tip = balloonTip({ kind: 'circle', c: [0, 0], r: 5, full: true, a: [5, 0], b: [5, 0], m: [-5, 0] }, [0, 20]);
    expect(tip[0]).toBeCloseTo(0, 9);
    expect(tip[1]).toBeCloseTo(5, 9);
    expect(balloonTip({ kind: 'circle', c: [0, 0], r: 5, full: false, a: [5, 0], b: [-5, 0], m: [0, -5] }, [0, 20])).toEqual([0, -5]);
  });

  it('ends a leader attached to a line where it was attached', () => {
    expect(balloonTip({ kind: 'line', a: [0, 0], b: [10, 0] }, [50, 50], 0.8)).toEqual([8, 0]);
    expect(balloonTip({ kind: 'line', a: [0, 0], b: [10, 4] }, [50, 50], 0)).toEqual([0, 0]);
    // On the sheet: the view's 20 long edge runs from x 90 to 110.
    const d: DrawingDoc = {
      sheet: 'A4', landscape: true, scale: 1, title: '', drawnBy: '', notes: '',
      views: [{ id: 'v1', kind: 'front', x: 100, y: 100, hidden: false, dims: false, source: 'assembly' }],
      annotations: [{ id: 'a1', type: 'balloon', view: 'v1', ref: { edge: 'c2#e1', at: 'edge' }, at: [30, -30], t: 0.8 }],
    };
    const pr = { id: 'k', visible: ['M0 0L20 0'], hidden: [], bounds: [0, -10, 20, 0] as [number, number, number, number] };
    const edges = [{ name: 'c2#e1', type: 'line', a: [0, 0, 0] as [number, number, number], b: [20, 0, 0] as [number, number, number], mid: [10, 0, 0] as [number, number, number], length: 20, faces: [0, 1], dir: [1, 0, 0] as [number, number, number] }];
    const s = buildSheet(d, new Map([['v1', pr]]), {
      partName: 'A', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(1), edges: () => edges, itemOf: (_src, edge) => itemOfEdge(edge, rows),
    });
    const dot = s.items.find((i): i is Extract<Item, { t: 'circle' }> => i.t === 'circle' && i.r === 0.3)!;
    expect(dot.cx).toBeCloseTo(106, 9);
  });

  it('draws the number in a circle with a leader to a dot on the edge', () => {
    const items: Item[] = [];
    const box = drawBalloon(items, '12', [50, 50], [70, 50]);
    expect(box).toEqual([50 - BALLOON_R, 50 - BALLOON_R, 50 + BALLOON_R, 50 + BALLOON_R]);
    expect(items.filter((it) => it.t === 'circle')).toHaveLength(2);
    const text = items.find((it) => it.t === 'text') as Extract<Item, { t: 'text' }>;
    expect(text).toMatchObject({ s: '12', x: 50, anchor: 'middle' });
    // The leader starts on the circle.
    const leader = items.find((it) => it.t === 'line') as Extract<Item, { t: 'line' }>;
    expect(leader.x1).toBeCloseTo(50 + BALLOON_R, 9);
    expect(leader.x2).toBe(70);
    // A long number shrinks to stay inside the circle.
    const more: Item[] = [];
    drawBalloon(more, '1234', [0, 0], null);
    const t2 = more.find((it) => it.t === 'text') as Extract<Item, { t: 'text' }>;
    expect(textWidth('1234', t2.size)).toBeLessThan(2 * BALLOON_R);
    expect(more.some((it) => it.t === 'line')).toBe(false);
  });

  it('draws balloons on the sheet with the item number of their edge, or a red question mark', () => {
    const d: DrawingDoc = {
      sheet: 'A4', landscape: true, scale: 1, title: '', drawnBy: '', notes: '',
      views: [{ id: 'v1', kind: 'front', x: 100, y: 100, hidden: false, dims: false, source: 'assembly' }],
      annotations: [
        { id: 'a1', type: 'balloon', view: 'v1', ref: { edge: 'c2#e1', at: 'edge' }, at: [30, -30] },
        { id: 'a2', type: 'balloon', view: 'v1', ref: { edge: 'gone#e1', at: 'edge' }, at: [-30, -30] },
        { id: 'a3', type: 'balloon', view: 'v1', ref: { edge: 'c2#e1', at: 'edge' }, at: [30, 30], item: 7 },
      ],
    };
    const pr = { id: 'k', visible: ['M0 0L20 0'], hidden: [], bounds: [0, -10, 20, 0] as [number, number, number, number] };
    const edges = [{ name: 'c2#e1', type: 'line', a: [0, 0, 0] as [number, number, number], b: [20, 0, 0] as [number, number, number], mid: [10, 0, 0] as [number, number, number], length: 20, faces: [0, 1], dir: [1, 0, 0] as [number, number, number] }];
    const s = buildSheet(d, new Map([['v1', pr]]), {
      partName: 'A', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(1), edges: () => edges, itemOf: (_src, edge) => itemOfEdge(edge, rows),
    });
    const texts = s.items.filter((it): it is Extract<Item, { t: 'text' }> => it.t === 'text' && it.anchor === 'middle' && it.size <= 3.5);
    expect(texts.find((t) => t.s === '2')?.color).toBeUndefined();
    expect(texts.find((t) => t.s === '?')?.color).toBe('#d32f2f');
    expect(texts.find((t) => t.s === '7')).toBeTruthy();
    expect(s.annos.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('places automatic balloons outside the view, apart, one per row it shows', () => {
    const line = (edge: string, a: [number, number], b: [number, number]): Prim => ({ edge, kind: 'line', a, b });
    const prims: Prim[] = [
      line('c1#a', [0, 0], [100, 0]), line('c1#b', [100, 0], [100, 50]), line('c1#c', [100, 50], [0, 50]), line('c1#d', [0, 50], [0, 0]),
      line('c2#a', [40, 20], [60, 20]), line('c2#b', [60, 20], [60, 30]),
      line('c3#a', [45, 22], [55, 22]),
    ];
    const plan = autoBalloons(prims, rows, [0, 0, 100, 50], 1);
    expect(plan.map((p) => p.item).sort()).toEqual([1, 2]);
    for (const p of plan) {
      const inside = p.at[0] > -10 && p.at[0] < 110 && p.at[1] > -10 && p.at[1] < 60;
      expect(inside).toBe(false);
      expect(rows.find((r) => r.item === p.item)!.prefixes.some((x) => p.ref.edge.startsWith(x))).toBe(true);
      expect(p.ref.at).toBe('edge');
    }
    expect(Math.hypot(plan[0].at[0] - plan[1].at[0], plan[0].at[1] - plan[1].at[1])).toBeGreaterThanOrEqual(2 * BALLOON_R);
    // Items already ballooned are skipped; rows the view does not show get none.
    expect(autoBalloons(prims, rows, [0, 0, 100, 50], 1, new Set([1])).map((p) => p.item)).toEqual([2]);
    expect(autoBalloons(prims.slice(0, 4), rows, [0, 0, 100, 50], 1).map((p) => p.item)).toEqual([1]);
    // Many components close together are spread around the view.
    const many: BomRow[] = Array.from({ length: 8 }, (_, i) => ({ item: i + 1, name: `P${i}`, qty: 1, prefixes: [`k${i}#`] }));
    const crowded = many.map((_, i) => line(`k${i}#e`, [50 + i * 0.1, 0], [50 + i * 0.1, 1]));
    const spread = autoBalloons(crowded, many, [0, 0, 100, 50], 1);
    expect(spread).toHaveLength(8);
    for (let i = 0; i < spread.length; i++) for (let j = i + 1; j < spread.length; j++) {
      expect(Math.hypot(spread[i].at[0] - spread[j].at[0], spread[i].at[1] - spread[j].at[1])).toBeGreaterThan(2 * BALLOON_R);
    }
  });
});

describe('drawing data', () => {
  const base: DrawingDoc = { sheet: 'A4', landscape: true, scale: 1, title: '', drawnBy: '', notes: '', views: [{ id: 'v1', kind: 'front', x: 100, y: 100, hidden: true, dims: true }] };

  it('accepts flat pattern views, cut lists, anchored tables and exploded assembly views', () => {
    expect(validDrawing({
      ...base,
      views: [...base.views, { id: 'v2', kind: 'front', type: 'flat', x: 1, y: 2, hidden: false, dims: true, scale: 0.5 },
        { id: 'v3', kind: 'front', type: 'detail', parent: 'v2', circle: [0, 0, 5], x: 1, y: 2, hidden: false, dims: false },
        { id: 'v4', kind: 'isometric', x: 1, y: 2, hidden: false, dims: false, source: 'assembly:exploded' }],
      annotations: [
        { id: 'a1', type: 'bom', at: [400, 255], anchor: 'bottomRight' },
        { id: 'a2', type: 'cutList', at: [10, 10] },
        { id: 'a3', type: 'cutList', at: [10, 10], anchor: 'bottomRight' },
        { id: 'a4', type: 'balloon', view: 'v1', ref: { edge: 'c1#E1:cap0', at: 'edge' }, at: [0, 0] },
      ],
    })).toBe(true);
  });

  it('rejects damaged ones', () => {
    const bad = (patch: Partial<DrawingDoc> | Record<string, unknown>) => validDrawing({ ...base, ...patch });
    // A flat view made from another view, or a projected view made from a flat one.
    expect(bad({ views: [...base.views, { id: 'v2', kind: 'front', type: 'flat', parent: 'v1', x: 0, y: 0, hidden: false, dims: true }] })).toBe(false);
    expect(bad({ views: [...base.views, { id: 'v2', kind: 'front', type: 'flat', x: 0, y: 0, hidden: false, dims: true }, { id: 'v3', kind: 'right', type: 'projected', parent: 'v2', side: 'right', x: 0, y: 0, hidden: false, dims: false }] })).toBe(false);
    expect(bad({ annotations: [{ id: 'a', type: 'cutList', at: [0] }] })).toBe(false);
    expect(bad({ annotations: [{ id: 'a', type: 'cutList', at: [0, 0], anchor: 'middle' }] })).toBe(false);
    expect(bad({ annotations: [{ id: 'a', type: 'bom', at: [0, 0], anchor: 'topRight' }] })).toBe(false);
    expect(bad({ annotations: [{ id: 'a', type: 'balloon', view: 'v1', ref: { edge: 'e', at: 'edge' }, at: [0, 0], item: 0 }] })).toBe(false);
    expect(bad({ annotations: [{ id: 'a', type: 'balloon', ref: { edge: 'e', at: 'edge' }, at: [0, 0] }] })).toBe(false);
    expect(bad({ annotations: [{ id: 'a', type: 'balloon', view: 'v1', ref: { edge: 'e', at: 'edge' }, at: [0, 0], t: 1.5 }] })).toBe(false);
    expect(bad({ annotations: [{ id: 'a', type: 'balloon', view: 'v1', ref: { edge: 'e', at: 'edge' }, at: [0, 0], t: '0.5' }] })).toBe(false);
    expect(bad({ annotations: [{ id: 'a', type: 'balloon', view: 'v1', ref: { edge: 'e', at: 'edge' }, at: [0, 0], t: 0.25 }] })).toBe(true);
  });

  it('keeps an assembly’s drawing when the assembly is opened, and rejects a damaged one', () => {
    const doc = { ...newAssembly('Asm'), drawing: { ...base, views: [{ ...base.views[0], source: 'assembly' }], annotations: [{ id: 'a1', type: 'bom', at: [10, 10] }] } };
    const back = validateAssembly(JSON.parse(JSON.stringify(doc)));
    expect(back.drawing).toEqual(doc.drawing);
    expect(validateAssembly(JSON.parse(JSON.stringify(newAssembly('Asm')))).drawing).toBeUndefined();
    expect(() => validateAssembly({ ...JSON.parse(JSON.stringify(doc)), drawing: { ...base, sheet: 'B7' } })).toThrow('The assembly file is damaged (invalid drawing).');
  });

  it('keeps room above the title block for a table when laying out the standard views', () => {
    const sheet = { w: 420, h: 297 };
    const plain = standardLayout(sheet, [0, 0, 0], [200, 100, 80]);
    const kept = standardLayout(sheet, [0, 0, 0], [200, 100, 80], 32 + 40);
    expect(kept.scale).toBeLessThanOrEqual(plain.scale);
    // Default: as before.
    expect(standardLayout(sheet, [0, 0, 0], [200, 100, 80], 32)).toEqual(plain);
  });
});

describe('the assistant’s drawing tool', () => {
  it('offers every sheet size a drawing can have', () => {
    const spec = toolSpecs().find((t) => t.function.name === 'drawing')!;
    const sheet = (spec.function.parameters as { properties: { sheet: { enum: string[] } } }).properties.sheet;
    expect([...sheet.enum].sort()).toEqual(Object.keys(SHEETS).sort());
  });
});
