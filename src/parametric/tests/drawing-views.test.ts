// Drawing views, annotations and exports beyond the standard views: view directions and
// alignment, hatching and clipping, dimension measuring and formatting, the full title block,
// DXF, and validation of old and new drawings.
import { describe, expect, it } from 'vitest';
import type { EdgeInfo, ProjectionResult } from '../src/kernel/protocol';
import type { DrawingDoc, HoleFeature, SkEntity } from '../src/model/types';
import { validDrawing } from '../src/model/validate-drawing';
import { type Geo, drawDimension, guessKind, holeCalloutText, holeSpecOf, measure } from '../src/drawing/annotate';
import { circleArc, dxfText, toDxf } from '../src/drawing/dxf';
import { type Item, buildSheet, toPdf, toSvg, viewCaption } from '../src/drawing/sheet';
import { arcOverHalf, besideOrient, centerMarks, clipToCircle, dependents, hatch, holeAxes, resolveViews, standardOrient, viewPrims } from '../src/drawing/views';
import { detailScale, nextLetter } from '../src/app/drawing';

const fmt = { length: (mm: number, d?: number) => mm.toFixed(d ?? 2), angle: (deg: number, d?: number) => `${deg.toFixed(d ?? 1)}°` };
const base = (views: DrawingDoc['views'], extra: Partial<DrawingDoc> = {}): DrawingDoc => ({ sheet: 'A3', landscape: true, scale: 1, title: 'T', drawnBy: '', notes: '', views, ...extra });
const box = (id: string, w: number, h: number): ProjectionResult => ({ id, visible: [`M ${-w / 2} ${-h / 2} H ${w / 2} V ${h / 2} H ${-w / 2} Z`], hidden: [], bounds: [-w / 2, -h / 2, w / 2, h / 2] });
const info = { partName: 'P', material: 'Steel', units: 'mm', date: '2026-01-01', formatLength: (v: number) => v.toFixed(2) };

describe('view directions', () => {
  it('projects to each side in third and first angle like the standard views', () => {
    const front = standardOrient('front');
    const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-12);
    // Third angle: the view on a side is seen from that side.
    expect(near(besideOrient(front, [1, 0], false).dir, [1, 0, 0])).toBe(true);
    expect(near(besideOrient(front, [1, 0], false).x, standardOrient('right').x)).toBe(true);
    expect(near(besideOrient(front, [0, -1], false).dir, [0, 1, 0])).toBe(true);
    expect(near(besideOrient(front, [0, -1], false).x, standardOrient('top').x)).toBe(true);
    expect(near(besideOrient(front, [0, 1], false).dir, [0, -1, 0])).toBe(true);
    // First angle: right of the front is the view from the left, below it the view from above.
    expect(near(besideOrient(front, [1, 0], true).dir, [-1, 0, 0])).toBe(true);
    expect(near(besideOrient(front, [0, 1], true).dir, [0, 1, 0])).toBe(true);
    expect(near(besideOrient(front, [0, 1], true).x, standardOrient('top').x)).toBe(true);
  });

  it('resolves projected, section and detail views from their parents, and drops orphans', () => {
    const d = base([
      { id: 'v1', kind: 'front', x: 100, y: 100, hidden: true, dims: true },
      { id: 'v2', kind: 'right', type: 'projected', parent: 'v1', side: 'right', x: 200, y: 50, hidden: true, dims: false },
      { id: 'v3', kind: 'front', type: 'detail', parent: 'v2', circle: [1, 2, 5], x: 300, y: 200, hidden: false, dims: false },
      { id: 'v4', kind: 'front', type: 'projected', parent: 'gone', side: 'left', x: 0, y: 0, hidden: false, dims: false },
    ], { scale: 0.5 });
    const rs = resolveViews(d);
    expect(rs.get('v2')).toMatchObject({ type: 'projected', align: 'y', scale: 0.5 });
    // A detail is twice its parent's scale unless given its own, and looks the same way.
    expect(rs.get('v3')).toMatchObject({ type: 'detail', scale: 1, clip: { c: [1, 2], r: 5 } });
    expect(rs.get('v3')!.key).toBe(rs.get('v2')!.key);
    expect(rs.has('v4')).toBe(false);
    expect(viewCaption(d, rs.get('v2')!)).toBe('RIGHT');
    expect(viewCaption(d, rs.get('v3')!)).toBe('DETAIL A  SCALE 1:1');
    expect(dependents(d, 'v1')).toEqual(['v2', 'v3']);
  });

  it('keeps a projected view aligned with its parent on the sheet', () => {
    const d = base([
      { id: 'v1', kind: 'front', x: 100, y: 100, hidden: false, dims: false },
      { id: 'v2', kind: 'right', type: 'projected', parent: 'v1', side: 'right', x: 200, y: 37, hidden: false, dims: false },
      { id: 'v3', kind: 'top', type: 'projected', parent: 'v1', side: 'above', x: 13, y: 40, hidden: false, dims: false },
    ]);
    // Bounds offset differently in each view: alignment is by model coordinates, not view centres.
    const proj = new Map<string, ProjectionResult>([
      ['v1', { id: 'v1', visible: ['M0 0L40 0L40 -20L0 -20Z'], hidden: [], bounds: [0, -20, 40, 0] }],
      ['v2', { id: 'v2', visible: ['M-10 0L0 0L0 -20L-10 -20Z'], hidden: [], bounds: [-10, -20, 0, 0] }],
      ['v3', { id: 'v3', visible: ['M0 0L40 0L40 10L0 10Z'], hidden: [], bounds: [0, 0, 40, 10] }],
    ]);
    const s = buildSheet(d, proj, info);
    const p1 = s.placements.get('v1')!, p2 = s.placements.get('v2')!, p3 = s.placements.get('v3')!;
    expect(p2.ty).toBe(p1.ty);
    expect(p3.tx).toBe(p1.tx);
    // The free axis is where the view was put.
    expect((p2.frame.x0 + p2.frame.x1) / 2).toBeCloseTo(200, 9);
    expect((p3.frame.y0 + p3.frame.y1) / 2).toBeCloseTo(40, 9);
  });

  it('picks the next free view letter, skipping I, O and Q', () => {
    const d = base(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((label, i) => ({ id: `s${i}`, kind: 'front', type: 'section', parent: 'v0', line: [0, 0, 1, 0] as [number, number, number, number], label, x: 0, y: 0, hidden: false, dims: false })));
    expect(nextLetter(d)).toBe('J');
    expect(detailScale(1)).toBe(2);
    expect(detailScale(0.5)).toBe(1);
    expect(detailScale(0.3)).toBe(1);
  });
});

describe('hatching and clipping', () => {
  it('hatches a square with a square hole even-odd at 45 degrees', () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0], inner = [3, 3, 7, 3, 7, 7, 3, 7, 3, 3];
    const lines = hatch([outer, inner], 45, 0.25);
    const area = lines.reduce((s, [x1, y1, x2, y2]) => s + Math.hypot(x2 - x1, y2 - y1), 0) * 0.25;
    expect(area).toBeCloseTo(100 - 16, 0);
    for (const [x1, y1, x2, y2] of lines) {
      // Every line is at 45 degrees and none crosses the hole.
      expect(Math.abs(Math.abs(x2 - x1) - Math.abs(y2 - y1))).toBeLessThan(1e-9);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      expect(mx > 3 + 1e-9 && mx < 7 - 1e-9 && my > 3 + 1e-9 && my < 7 - 1e-9).toBe(false);
    }
    expect(hatch([], 45, 1)).toEqual([]);
  });

  it('clips polylines to a circle', () => {
    const parts = clipToCircle([[-10, 0], [10, 0]], [0, 0], 5);
    expect(parts).toHaveLength(1);
    expect(parts[0][0][0]).toBeCloseTo(-5, 9);
    expect(parts[0][1][0]).toBeCloseTo(5, 9);
    expect(clipToCircle([[-10, 9], [10, 9]], [0, 0], 5)).toEqual([]);
    // In and out again: two pieces.
    expect(clipToCircle([[0, 0], [10, 0], [10, 1], [0, 1]], [0, 0], 3)).toHaveLength(2);
  });
});

describe('model edges in a view', () => {
  const edge = (name: string, e: Partial<EdgeInfo>): EdgeInfo => ({ name, type: 'line', a: [0, 0, 0], b: [0, 0, 0], mid: [0, 0, 0], length: 1, faces: [0, 1], ...e });
  const hole = (name: string, z: number): EdgeInfo => edge(name, { type: 'circle', a: [13, 5, z], b: [13, 5, z], mid: [7, 5, z], center: [10, 5, z], axis: [0, 0, 1], radius: 3, length: 6 * Math.PI });
  const edges = [
    edge('top', { a: [0, 10, 0], b: [40, 10, 0], mid: [20, 10, 0], length: 40 }),
    edge('seam', { a: [7, 5, 0], b: [7, 5, 6], faces: [3] }),
    hole('h0', 0), hole('h6', 6),
  ];
  it('sees lines and holes end on from the front, and holes edge on from above', () => {
    const d = base([{ id: 'v1', kind: 'front', x: 0, y: 0, hidden: false, dims: false }, { id: 'v2', kind: 'top', x: 0, y: 0, hidden: false, dims: false }]);
    const rs = resolveViews(d);
    const front = viewPrims(rs.get('v1')!, edges);
    expect(front.find((p) => p.edge === 'top')).toMatchObject({ kind: 'line', a: [0, -10], b: [40, -10] });
    expect(front.some((p) => p.edge === 'seam')).toBe(false);
    expect(front.find((p) => p.edge === 'h0')).toMatchObject({ kind: 'arc', c: [10, -5], r: 3, full: true });
    // One centre mark for the two circles of the hole.
    expect(centerMarks(front)).toEqual([{ c: [10, -5], r: 3, edge: 'h0' }]);
    const top = viewPrims(rs.get('v2')!, edges);
    const across = top.find((p) => p.edge === 'h6')!;
    expect(across.kind).toBe('line');
    // The hole's axis, from the top: a centerline through both circles' centres.
    const axes = holeAxes(rs.get('v2')!, edges);
    expect(axes).toHaveLength(1);
    expect(Math.abs(axes[0].a[1] - axes[0].b[1])).toBeCloseTo(6, 9);
    expect(arcOverHalf({ a: [1, 0], b: [-1, 0], m: [0, 1], c: [0, 0] })).toBe(false);
    expect(arcOverHalf({ a: [1, 0.1], b: [-1, 0.1], m: [0, -1], c: [0, 0] })).toBe(true);
  });
});

describe('dimensions', () => {
  const L = (a: [number, number], b: [number, number]): Geo => ({ kind: 'line', a, b });
  const P = (p: [number, number]): Geo => ({ kind: 'point', p });
  const circle: Geo = { kind: 'circle', c: [5, 5], r: 2.5, full: true, a: [7.5, 5], b: [7.5, 5], m: [2.5, 5] };

  it('chooses the kind from the geometry and where the value is placed', () => {
    expect(guessKind([circle], [20, 0])).toBe('diameter');
    expect(guessKind([{ ...circle, full: false, a: [7.5, 5], b: [5, 2.5], m: [6.77, 3.23] }], [20, 0])).toBe('radius');
    expect(guessKind([L([0, 0], [10, 0])], [5, -5])).toBe('horizontal');
    expect(guessKind([L([0, 0], [10, 10])], [5, -20])).toBe('horizontal');
    expect(guessKind([L([0, 0], [10, 10])], [-20, 5])).toBe('vertical');
    expect(guessKind([L([0, 0], [10, 10])], [0, 10])).toBe('aligned');
    expect(guessKind([L([0, 0], [10, 0]), L([0, 0], [10, 10])], [9, 3])).toBe('angle');
    expect(guessKind([L([0, 0], [10, 0]), L([0, 4], [10, 4])], [5, 2])).toBe('vertical');
    expect(guessKind([P([0, 0]), L([5, -5], [5, 5])], [2, -8])).toBe('horizontal');
  });

  it('measures lengths, distances, diameters, radii and angles', () => {
    expect(measure('horizontal', [L([0, 0], [30, 40])])!.value).toBeCloseTo(30, 12);
    expect(measure('vertical', [L([0, 0], [30, 40])])!.value).toBeCloseTo(40, 12);
    expect(measure('aligned', [L([0, 0], [30, 40])])!.value).toBeCloseTo(50, 12);
    expect(measure('vertical', [L([0, 0], [10, 0]), L([3, 7], [9, 7])])!.value).toBeCloseTo(7, 12);
    expect(measure('aligned', [P([0, 0]), L([5, -5], [5, 5])])!.value).toBeCloseTo(5, 12);
    expect(measure('diameter', [circle])!.value).toBe(5);
    expect(measure('radius', [circle])!.value).toBe(2.5);
    expect(measure('angle', [L([0, 0], [10, 0]), L([0, 0], [10, 10])])!.value).toBeCloseTo(45, 9);
    expect(measure('angle', [L([0, 0], [10, 0]), L([0, 1], [10, 1])])).toBeNull();
  });

  it('formats values in the document units with their decimals and symbols', () => {
    const items: Item[] = [];
    const pl = { T: (q: [number, number]): [number, number] => [100 + q[0] * 2, 100 + q[1] * 2], s: 2 };
    const texts = () => items.filter((i) => i.t === 'text').map((i) => (i as Extract<Item, { t: 'text' }>).s);
    drawDimension(items, { id: 'd', type: 'dimension', view: 'v', kind: 'diameter', refs: [], at: [15, -5] }, measure('diameter', [circle]), pl, fmt);
    drawDimension(items, { id: 'd', type: 'dimension', view: 'v', kind: 'radius', refs: [], at: [6, 5] , decimals: 1 }, measure('radius', [circle]), pl, fmt);
    drawDimension(items, { id: 'd', type: 'dimension', view: 'v', kind: 'vertical', refs: [], at: [-10, 20], prefix: '2X ' }, measure('vertical', [L([0, 0], [30, 40])]), pl, fmt);
    drawDimension(items, { id: 'd', type: 'dimension', view: 'v', kind: 'angle', refs: [], at: [9, 3] }, measure('angle', [L([0, 0], [10, 0]), L([0, 0], [10, 10])]), pl, fmt);
    expect(texts()).toEqual(['Ø5.00', 'R2.5', '2X 40.00', '45.0°']);
    // A vertical value reads upward.
    expect(items.find((i) => i.t === 'text' && i.s === '2X 40.00')).toMatchObject({ rotate: -90 });
    // Missing geometry: drawn where it was, in red, marked.
    const gone: Item[] = [];
    drawDimension(gone, { id: 'd', type: 'dimension', view: 'v', kind: 'diameter', refs: [], at: [0, 0] }, null, pl, fmt);
    expect(gone).toEqual([expect.objectContaining({ t: 'text', s: 'Ø? (missing)', color: '#d32f2f' })]);
    expect(holeCalloutText({ kind: 'counterbore', diameter: 6.6, cbDiameter: 11, cbDepth: 6.4, count: 4 }, fmt)).toBe('4X Ø6.60 THRU\nCBORE Ø11.00 DEEP 6.40');
    expect(holeCalloutText({ kind: 'countersink', diameter: 5, depth: 10, csDiameter: 10, csAngle: 90, count: 1 }, fmt)).toBe('Ø5.00 DEEP 10.00\nCSK Ø10.00 X 90°');
  });

  it('counts the holes a hole feature makes, not the points of lines and circles locating them', () => {
    const hole = { id: 'h', type: 'hole', name: 'Hole1', sketch: 's', kind: 'simple', diameter: 6, end: 'throughAll', depth: 10, cbDiameter: 11, cbDepth: 3, csDiameter: 12, csAngle: 90, flip: false } as HoleFeature;
    // Two hole centres, a construction line between them (its own end points) and a circle around one.
    const entities: SkEntity[] = [
      { id: 'p1', t: 'point', x: 0, y: 0 }, { id: 'p2', t: 'point', x: 20, y: 0 },
      { id: 'p3', t: 'point', x: -10, y: 5 }, { id: 'p4', t: 'point', x: 30, y: 5 }, { id: 'l1', t: 'line', a: 'p3', b: 'p4', construction: true },
      { id: 'p5', t: 'point', x: 0, y: 0 }, { id: 'c1', t: 'circle', c: 'p5', r: 8, construction: true },
      { id: 'p6', t: 'point', x: 5, y: 5, construction: true },
    ];
    expect(holeSpecOf(hole, entities).count).toBe(2);
    expect(holeCalloutText(holeSpecOf(hole, entities), fmt)).toBe('2X Ø6.00 THRU');
    expect(holeSpecOf({ ...hole, end: 'blind' }, entities.slice(0, 1))).toMatchObject({ count: 1, depth: 10 });
  });
});

describe('sheet', () => {
  it('draws the full title block with the projection symbol only when asked', () => {
    const basic = toSvg(buildSheet(base([]), new Map(), info).items, 420, 297);
    expect(basic).not.toContain('THIRD ANGLE');
    expect(basic).not.toContain('<circle');
    const full = buildSheet(base([], { titleBlock: 'full', revision: 'B', projection: 'first' }), new Map(), info);
    const svg = toSvg(full.items, full.w, full.h);
    expect(svg).toContain('>FIRST ANGLE<');
    expect(svg).toContain('>1 OF 1<');
    expect(svg).toContain('>B<');
    expect((svg.match(/<circle/g) ?? []).length).toBe(2);
    // The symbol: first angle puts the end view (circles) left of the side view.
    const circles = full.items.filter((i) => i.t === 'circle') as Extract<Item, { t: 'circle' }>[];
    const trapezoid = full.items.filter((i) => i.t === 'line' && i.w === 0.25 && Math.abs(i.y1 - i.y2) > 0.5 && Math.abs(i.x1 - i.x2) > 0.5) as Extract<Item, { t: 'line' }>[];
    expect(circles[0].cx).toBeLessThan(Math.min(...trapezoid.map((l) => Math.min(l.x1, l.x2))));
    const third = buildSheet(base([], { titleBlock: 'full' }), new Map(), info);
    const c3 = third.items.find((i) => i.t === 'circle') as Extract<Item, { t: 'circle' }>;
    expect(c3.cx).toBeGreaterThan(circles[0].cx);
    // PDF draws circles and colours.
    const pdf = new TextDecoder().decode(toPdf(full.items, full.w, full.h, 'T'));
    expect(pdf).toContain('(FIRST ANGLE) Tj');
  });

  it('draws section hatching inside the view group, the cutting line and the caption', () => {
    const d = base([
      { id: 'v1', kind: 'front', x: 100, y: 100, hidden: false, dims: false },
      { id: 'v2', kind: 'front', type: 'section', parent: 'v1', line: [-30, 0, 30, 0], label: 'C', x: 100, y: 200, hidden: false, dims: false },
    ]);
    const sec = { ...box('v2', 40, 6), cut: [[-20, -3, 20, -3, 20, 3, -20, 3, -20, -3]] };
    const s = buildSheet(d, new Map([['v1', box('v1', 40, 20)], ['v2', sec]]), info);
    const svg = toSvg(s.items, s.w, s.h);
    expect(svg).toContain('>SECTION C-C<');
    expect((svg.match(/>C</g) ?? []).length).toBe(2);
    expect((svg.match(/data-view="v2"/g) ?? []).length).toBe(1);
    // The cutting line's thick ends.
    expect(s.items.filter((i) => i.t === 'line' && i.w === 0.6)).toHaveLength(2);
  });

  it('says where a section view is when its cutting line misses the part, and keeps it selectable', () => {
    const d = base([
      { id: 'v1', kind: 'front', x: 100, y: 100, hidden: false, dims: false },
      { id: 'v2', kind: 'front', type: 'section', parent: 'v1', line: [30, 500, -30, 500], label: 'B', x: 150, y: 200, hidden: false, dims: false },
    ]);
    const s = buildSheet(d, new Map([['v1', box('v1', 40, 20)], ['v2', { id: 'v2', visible: [], hidden: [], bounds: null, cut: [] }]]), info);
    const note = s.items.find((i) => i.t === 'text' && i.s.startsWith('SECTION B-B:')) as Extract<Item, { t: 'text' }>;
    expect(note).toMatchObject({ s: 'SECTION B-B: THE CUTTING LINE MISSES THE PART', color: '#d32f2f' });
    const f = s.frames.find((q) => q.id === 'v2')!;
    expect(f.x0).toBeLessThan(150);
    expect(f.x1).toBeGreaterThan(150);
    expect(f.y0).toBeLessThan(200);
    // Still projecting: nothing yet.
    expect(buildSheet(d, new Map([['v1', box('v1', 40, 20)]]), info).frames.map((q) => q.id)).toEqual(['v1']);
  });
});

describe('DXF', () => {
  it('writes lines, true arcs, circles, text and arrowheads in millimetres with y up', () => {
    const items: Item[] = [
      { t: 'line', x1: 0, y1: 10, x2: 20, y2: 10, w: 0.35 },
      { t: 'path', d: 'M10 0A5 5 0 0 1 0 0', tx: 100, ty: 50, s: 2, w: 0.35 },
      { t: 'circle', cx: 50, cy: 50, r: 4, w: 0.18 },
      { t: 'text', s: 'Ø10 ± 0.1 45°', x: 5, y: 5, size: 3, anchor: 'middle' },
      { t: 'tri', a: [0, 0], b: [1, 1], c: [1, -1] },
      { t: 'path', d: 'M0 0L5 0', tx: 0, ty: 0, s: 1, w: 0.18, dash: [1.6, 0.8] },
    ];
    const dxf = toDxf(items, 100, 100);
    const lines = dxf.split('\n');
    expect(lines.slice(0, 2)).toEqual(['0', 'SECTION']);
    expect(dxf.trimEnd().endsWith('0\nEOF')).toBe(true);
    // The line is at y = 100 - 10.
    const li = lines.indexOf('LINE');
    expect(lines.slice(li, li + 14)).toEqual(['LINE', '8', 'VISIBLE', '10', '0', '20', '90', '30', '0', '11', '20', '21', '90', '31']);
    // The half circle: centre (5, 0) scaled by 2 and moved: (110, 50) on the sheet, y up 50; radius 10.
    // It bulges down the sheet (sweep flag 1 turns clockwise with y down): with y up, 180 to 360 degrees.
    const ai = lines.indexOf('ARC');
    expect(lines.slice(ai, ai + 15)).toEqual(['ARC', '8', 'VISIBLE', '10', '110', '20', '50', '30', '0', '40', '10', '50', '180', '51', '0']);
    expect(lines).toContain('CIRCLE');
    expect(lines).toContain('SOLID');
    expect(dxf).toContain('%%c10 %%p 0.1 45%%d');
    expect(lines[lines.indexOf('HIDDEN', lines.indexOf('ENTITIES'))]).toBe('HIDDEN');
    expect(dxfText('Größe')).toBe('Gr??e');
  });

  it('finds the centre of SVG arcs both ways round', () => {
    const a = circleArc([10, 0], [0, 0], 5, false, true)!;
    expect(a.c[0]).toBeCloseTo(5, 12);
    expect(a.c[1]).toBeCloseTo(0, 12);
    expect(a.sweep).toBeCloseTo(Math.PI, 12);
    // Without the sweep flag the arc turns toward negative angles: around (10, 10), a quarter turn back.
    const b = circleArc([10, 0], [0, 10], 10, false, false)!;
    expect(b.c[0]).toBeCloseTo(10, 12);
    expect(b.c[1]).toBeCloseTo(10, 12);
    expect(b.sweep).toBeCloseTo(-Math.PI / 2, 12);
    const c = circleArc([10, 0], [0, 10], 10, false, true)!;
    expect(c.c[0]).toBeCloseTo(0, 12);
    expect(c.sweep).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('validation', () => {
  const old: DrawingDoc = { sheet: 'A4', landscape: true, scale: 0.5, title: '', drawnBy: '', notes: '', views: [{ id: 'v1', kind: 'front', x: 100, y: 100, hidden: true, dims: true }] };
  it('accepts drawings saved before views and annotations were added', () => {
    expect(validDrawing(old)).toBe(true);
    expect(validDrawing(JSON.parse(JSON.stringify(old)))).toBe(true);
  });

  it('accepts new views, annotations and sheet settings', () => {
    const d: DrawingDoc = {
      ...old, sheet: 'ANSI D', projection: 'first', titleBlock: 'full', revision: 'C',
      views: [
        ...old.views,
        { id: 'v2', kind: 'front', type: 'section', parent: 'v1', line: [0, 0, 10, 0], label: 'A', x: 1, y: 2, hidden: false, dims: false, centerMarks: true, tangent: false },
        { id: 'v3', kind: 'front', type: 'detail', parent: 'v2', circle: [0, 0, 5], scale: 2, label: 'B', x: 1, y: 2, hidden: false, dims: false },
        { id: 'v4', kind: 'right', type: 'projected', parent: 'v1', side: 'right', x: 1, y: 2, hidden: true, dims: false, source: 'part' },
      ],
      annotations: [
        { id: 'a1', type: 'dimension', view: 'v1', kind: 'horizontal', refs: [{ edge: 'E1:side:1|E1:cap1', at: 'edge' }], at: [0, -10], decimals: 1, prefix: '2X ' },
        { id: 'a2', type: 'note', text: 'NOTE', at: [20, 20], leader: [10, 10], size: 3.5 },
        { id: 'a3', type: 'centerMark', view: 'v1', ref: { edge: 'h', at: 'edge' } },
        { id: 'a4', type: 'centerline', view: 'v1', refs: [{ edge: 'a', at: 'edge' }, { edge: 'b', at: 'edge' }] },
        { id: 'a5', type: 'holeCallout', view: 'v1', ref: { edge: 'h', at: 'edge' }, at: [5, 5] },
        { id: 'a6', type: 'balloon', view: 'v1', ref: { edge: 'part1/e', at: 'edge' }, at: [5, 5], item: 3 },
        { id: 'a7', type: 'bom', at: [300, 20] },
      ],
    };
    expect(validDrawing(d)).toBe(true);
  });

  it('rejects damaged new fields', () => {
    const bad = (patch: (d: Record<string, unknown> & { views: Record<string, unknown>[] }) => void) => {
      const d = JSON.parse(JSON.stringify({ ...old, views: [...old.views, { id: 'v2', kind: 'front', type: 'section', parent: 'v1', line: [0, 0, 10, 0], x: 0, y: 0, hidden: false, dims: false }] }));
      patch(d);
      return validDrawing(d);
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((d) => { d.views[1].parent = 'nope'; })).toBe(false);
    expect(bad((d) => { delete d.views[1].line; })).toBe(false);
    expect(bad((d) => { d.views[1].line = [0, 0, 0, 0]; })).toBe(false);
    expect(bad((d) => { d.views[1].type = 'cutaway'; })).toBe(false);
    expect(bad((d) => { d.views[1].scale = 0; })).toBe(false);
    expect(bad((d) => { d.projection = 'second'; })).toBe(false);
    expect(bad((d) => { d.sheet = 'B5'; })).toBe(false);
    expect(bad((d) => { d.annotations = [{ id: 'a', type: 'dimension', view: 'v1', kind: 'diameter', refs: [], at: [0, 0] }]; })).toBe(false);
    expect(bad((d) => { d.annotations = [{ id: 'a', type: 'note', text: 'x', at: [0, 0], view: 'nope' }]; })).toBe(false);
    expect(bad((d) => { d.annotations = [{ id: 'a', type: 'sticker', at: [0, 0] }]; })).toBe(false);
    expect(bad((d) => { d.annotations = [{ id: 'a', type: 'note', text: 'x', at: [0] }]; })).toBe(false);
    // Views made from each other in a loop could never be drawn.
    expect(bad((d) => { d.views[0].type = 'projected'; d.views[0].parent = 'v2'; d.views[0].side = 'left'; })).toBe(false);
    expect(bad((d) => { d.views.push({ id: 'v3', kind: 'front', type: 'detail', parent: 'v3', circle: [0, 0, 5], x: 0, y: 0, hidden: false, dims: false }); })).toBe(false);
  });
});
