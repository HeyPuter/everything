// Drawing views of assemblies and sheet metal flat patterns on the real OpenCascade kernel:
// projections of placed components (collapsed or exploded, sectioned per component) and the
// flat pattern view's outline, bend lines and edges.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { AssemblyBuilder, type AsmSceneItem } from '../src/kernel/assembly';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import type { ProjectionResult } from '../src/kernel/protocol';
import { placementMatrix } from '../src/assembly/compose';
import { flatEdges, flatProjection } from '../src/drawing/flat';
import { buildSheet, toSvg } from '../src/drawing/sheet';
import { projectionRequest, resolveViews, viewPrims } from '../src/drawing/views';
import { flatSize } from '../src/model/flat-pattern';
import type { Placement } from '../src/model/assembly';
import { newBaseFlange } from '../src/model/sheetmetal';
import type { DrawingDoc, SkEntity } from '../src/model/types';
import { circle, extrude, rect, req, sketch } from './helpers';

beforeAll(async () => {
  setOc(await init());
}, 60000);

const item = (part: string, pl: Placement, name: string): AsmSceneItem => ({ part, m: placementMatrix(pl), name, color: '#888888' });
const at = (p: [number, number, number]): Placement => ({ p, q: [0, 0, 0, 1] });
const width = (r: ProjectionResult) => r.bounds![2] - r.bounds![0];
const height = (r: ProjectionResult) => r.bounds![3] - r.bounds![1];

describe('assembly drawing projections', () => {
  async function built() {
    const a = new AssemblyBuilder();
    await a.build([
      // A 40 × 20 × 10 block with a Ø8 hole at (10, 10), and a Ø8 pin 30 long.
      { key: 'block', features: [sketch('S1', [...rect(0, 0, 40, 20), ...circle(10, 10, 4)]), extrude('E1', 'S1', 10)], blobs: {}, quality: 0 },
      { key: 'pin', features: [sketch('S1', circle(0, 0, 4)), extrude('E1', 'S1', 30)], blobs: {}, quality: 0 },
    ]);
    return a;
  }
  const right = { id: 'r', dir: [1, 0, 0] as [number, number, number], x: [0, 0, -1] as [number, number, number] };

  it('projects the components where the items place them, leaving the scene alone', async () => {
    const a = await built();
    a.setScene([item('block', at([0, 0, 0]), 'block<1>')]);
    // Collapsed: the pin in the hole, its end flush with the block's front (z 10), 20 out the back.
    const collapsed = a.projectItems([item('block', at([0, 0, 0]), 'block<1>'), item('pin', at([10, 10, -20]), 'pin<1>')], [right]);
    expect(width(collapsed[0])).toBeCloseTo(30, 4);
    expect(height(collapsed[0])).toBeCloseTo(20, 4);
    // Exploded: the pin moved 60 along z.
    const exploded = a.projectItems([item('block', at([0, 0, 0]), 'block<1>'), item('pin', at([10, 10, 40]), 'pin<1>')], [right]);
    expect(width(exploded[0])).toBeCloseTo(70, 4);
    // The scene (what measure and export use) is unchanged.
    expect(a.sceneSize).toBe(1);
    expect(width(a.project([right])[0])).toBeCloseTo(10, 4);
  });

  it('cuts each component of a section on its own, and says which component each cut outline belongs to', async () => {
    const a = await built();
    const items = [item('block', at([0, 0, 0]), 'block<1>'), item('pin', at([10, 10, -20]), 'pin<1>')];
    // Horizontal plane through the hole's axis (y = 10), looking up from below.
    const [sec] = a.projectItems(items, [{ id: 's', dir: [0, -1, 0], x: [1, 0, 0], section: { p: [0, 10, 0], n: [0, 1, 0] } }]);
    expect(sec.cut!.length).toBeGreaterThanOrEqual(3);
    expect(sec.cutGroups).toHaveLength(sec.cut!.length);
    expect(new Set(sec.cutGroups)).toEqual(new Set([0, 1]));
    // The pin, cut too, runs 20 past the block: 30 deep in all, 40 wide.
    expect(width(sec)).toBeCloseTo(40, 4);
    expect(height(sec)).toBeCloseTo(30, 4);
    // The pin's cut face is an 8 × 30 rectangle.
    const pinCut = sec.cut!.filter((_, i) => sec.cutGroups![i] === 1).flat();
    const xs = pinCut.filter((_, i) => i % 2 === 0), ys = pinCut.filter((_, i) => i % 2 === 1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(8, 4);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(30, 4);
    // Every component's cut is hatched, at its own angle.
    const d: DrawingDoc = {
      sheet: 'A4', landscape: true, scale: 2, title: '', drawnBy: '', notes: '',
      views: [{ id: 'v1', kind: 'front', x: 80, y: 60, hidden: true, dims: false, source: 'assembly' },
        { id: 'v2', kind: 'front', type: 'section', parent: 'v1', line: [-5, -10, 45, -10], label: 'A', x: 80, y: 150, hidden: false, dims: false }],
    };
    const r = resolveViews(d);
    const proj = new Map<string, ProjectionResult>();
    for (const v of d.views) proj.set(v.id, a.projectItems(items, [projectionRequest(r.get(v.id)!, v.hidden)])[0]);
    const s = buildSheet(d, proj, { partName: 'A', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(1) });
    const hatches = s.items.filter((it) => it.t === 'path' && it.view === 'v2' && it.w < 0.3 && /^M[^A-Z]*L[^A-Z]*M/.test(it.d));
    expect(hatches.length).toBe(2);
  });
});

describe('flat pattern views', () => {
  const T = 2;
  const chain = (pts: [number, number][]): SkEntity[] => [
    ...pts.map(([x, y], i) => ({ id: `p${i}`, t: 'point' as const, x, y })),
    ...pts.slice(1).map((_, i) => ({ id: `l${i}`, t: 'line' as const, a: `p${i}`, b: `p${i + 1}` })),
  ];

  it('draws the flat outline at its size, with a bend line, and edges for dimensions', async () => {
    const b = new ModelBuilder();
    const f = newBaseFlange('B1', 'B1', 'S1', T, 40);
    const res = await b.build(req([sketch('S1', [...chain([[0, 0], [50, 0], [50, 30]])]), f]));
    expect(res.status.every((s) => s.ok)).toBe(true);
    const fp = b.flatPattern().pattern!;
    const [fw, fh] = flatSize(fp);
    const pr = flatProjection('k', fp);
    expect(pr.bounds![2] - pr.bounds![0]).toBeCloseTo(fw, 4);
    expect(pr.bounds![3] - pr.bounds![1]).toBeCloseTo(fh, 4);
    // One of the flat sizes is the flange's depth; the other the two legs unbent.
    expect([fw, fh].some((v) => Math.abs(v - 40) < 1e-6)).toBe(true);
    expect(Math.max(fw, fh)).toBeGreaterThan(70);
    expect(Math.max(fw, fh)).toBeLessThan(80);
    expect(pr.bends).toHaveLength(1);
    expect(pr.bends![0].angle).toBeCloseTo(90, 6);
    // The bend line crosses the flat pattern from side to side.
    const bl = pr.bends![0];
    expect(Math.hypot(bl.b[0] - bl.a[0], bl.b[1] - bl.a[1])).toBeCloseTo(40, 4);
    // Its edges, seen by a flat view, are where its lines are.
    const edges = flatEdges(fp);
    expect(edges.length).toBe(fp.loops.reduce((n, l) => n + l.segs.length, 0));
    const d: DrawingDoc = { sheet: 'A4', landscape: true, scale: 1, title: '', drawnBy: '', notes: '', views: [{ id: 'v1', kind: 'front', type: 'flat', x: 150, y: 100, hidden: false, dims: true }] };
    const r = resolveViews(d).get('v1')!;
    expect(r.source).toBe('flat');
    const prims = viewPrims(r, edges);
    expect(prims.filter((p) => p.kind === 'line')).toHaveLength(4);
    const xs = prims.flatMap((p) => [p.a[0], p.b[0]]), ys = prims.flatMap((p) => [p.a[1], p.b[1]]);
    expect(Math.min(...xs)).toBeCloseTo(pr.bounds![0], 6);
    expect(Math.max(...ys)).toBeCloseTo(pr.bounds![3], 6);
    // On the sheet: the outline, the dashed bend line with its note, the overall size and the caption.
    const s = buildSheet(d, new Map([['v1', pr]]), { partName: 'P', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(2), edges: () => edges });
    const svg = toSvg(s.items, s.w, s.h);
    expect(svg).toContain('>FLAT PATTERN<');
    expect(svg).toMatch(/>UP 90° R 2\.00<|>DOWN 90° R 2\.00</);
    expect(svg).toContain(`>${fw.toFixed(2)}<`);
    expect(svg).toContain(`>${fh.toFixed(2)}<`);
    expect(s.items.filter((it) => it.t === 'line' && it.dash?.length === 2)).toHaveLength(1);
    // A detail of it shows the bend line too, cut off at its circle.
    const cx = (bl.a[0] + bl.b[0]) / 2, cy = (bl.a[1] + bl.b[1]) / 2;
    const dd: DrawingDoc = { ...d, views: [...d.views, { id: 'v2', kind: 'front', type: 'detail', parent: 'v1', circle: [cx, cy, 5], x: 60, y: 60, hidden: false, dims: false }] };
    const s2 = buildSheet(dd, new Map([['v1', pr], ['v2', pr]]), { partName: 'P', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(2), edges: () => edges });
    const bendLines = s2.items.filter((it): it is Extract<typeof it, { t: 'line' }> => it.t === 'line' && it.dash?.length === 2);
    expect(bendLines).toHaveLength(2);
    expect(Math.hypot(bendLines[1].x2 - bendLines[1].x1, bendLines[1].y2 - bendLines[1].y1)).toBeCloseTo(2 * 5 * 2, 4);
  });

  it('says on the sheet what the flat pattern leaves out', async () => {
    const b = new ModelBuilder();
    // An L of sheet with a block added off the sheet: the flat pattern cannot show the block.
    const res = await b.build(req([sketch('S1', chain([[0, 0], [50, 0], [50, 30]])), newBaseFlange('B1', 'B1', 'S1', T, 40), sketch('S2', rect(10, 10, 20, 20), { kind: 'base', plane: 'top' }), extrude('E2', 'S2', 5)]));
    expect(res.status.every((s) => s.ok)).toBe(true);
    const fp = b.flatPattern().pattern!;
    expect(fp.notes.length).toBeGreaterThan(0);
    const pr = flatProjection('k', fp);
    const d: DrawingDoc = { sheet: 'A4', landscape: true, scale: 1, title: '', drawnBy: '', notes: '', views: [{ id: 'v1', kind: 'front', type: 'flat', x: 150, y: 100, hidden: false, dims: true }] };
    const s = buildSheet(d, new Map([['v1', pr]]), { partName: 'P', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(2), edges: () => flatEdges(fp) });
    const texts = s.items.filter((it): it is Extract<typeof it, { t: 'text' }> => it.t === 'text').map((it) => it.s).join('\n');
    expect(texts).toContain('Material the flat pattern cannot show is left out');
    // A part whose flat pattern shows everything has no such note.
    const plain = flatProjection('k', { ...fp, notes: [] });
    const s2 = buildSheet(d, new Map([['v1', plain]]), { partName: 'P', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(2), edges: () => flatEdges(fp) });
    expect(s2.items.some((it) => it.t === 'text' && it.s.includes('left out'))).toBe(false);
  });

  it('says why when the part cannot be flattened', () => {
    const pr = flatProjection('k', null, 'Not a sheet metal part');
    expect(pr.bounds).toBeNull();
    const d: DrawingDoc = { sheet: 'A4', landscape: true, scale: 1, title: '', drawnBy: '', notes: '', views: [{ id: 'v1', kind: 'front', type: 'flat', x: 150, y: 100, hidden: false, dims: true }] };
    const svg = toSvg(buildSheet(d, new Map([['v1', pr]]), { partName: 'P', material: '', units: 'mm', date: '', formatLength: (v) => v.toFixed(2) }).items, 297, 210);
    expect(svg).toContain('FLAT PATTERN: Not a sheet metal part');
  });
});
