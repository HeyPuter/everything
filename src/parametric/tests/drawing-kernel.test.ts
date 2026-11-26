// Drawing views on real parts, projected by the OpenCascade kernel in Node: section views
// (the cut face hatched, holes left open), and dimensions measured from model edges.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import type { ProjectionResult } from '../src/kernel/protocol';
import type { DrawingDoc } from '../src/model/types';
import { buildSheet, toSvg } from '../src/drawing/sheet';
import { hatch, projectionRequest, resolveViews } from '../src/drawing/views';
import { circle, extrude, rect, req, sketch } from './helpers';

beforeAll(async () => {
  setOc(await init());
});

/** Projects every view of a drawing the way the drawing workspace does. */
function projectAll(b: ModelBuilder, d: DrawingDoc): Map<string, ProjectionResult> {
  const rs = resolveViews(d);
  const out = new Map<string, ProjectionResult>();
  for (const v of d.views) {
    const r = rs.get(v.id);
    if (!r) continue;
    const [res] = b.project([projectionRequest(r, v.hidden)]);
    out.set(v.id, res);
  }
  return out;
}

const info = (edges: ReturnType<ModelBuilder['build']> extends Promise<infer R> ? R : never) => ({
  partName: 'Plate', material: 'Steel', units: 'mm', date: '2026-01-01', formatLength: (v: number) => v.toFixed(2),
  edges: () => (edges as { edges: import('../src/kernel/protocol').EdgeInfo[] }).edges,
});

describe('section views', () => {
  // A 40 x 20 plate, 6 thick, with a 10 mm hole in the middle (front plane: x right, y up, z toward the front).
  const plate = () => req([sketch('S1', [...rect(-20, -10, 20, 10), ...circle(0, 0, 5)]), extrude('E1', 'S1', 6)]);

  it('cuts a holed plate through the hole: the cut face is hatched with the hole left as a gap', async () => {
    const b = new ModelBuilder();
    const res = await b.build(plate());
    const d: DrawingDoc = {
      sheet: 'A4', landscape: true, scale: 2, title: '', drawnBy: '', notes: '', annotations: [],
      views: [
        { id: 'v1', kind: 'front', x: 100, y: 120, hidden: false, dims: false },
        // A horizontal cutting line through the hole's centre, the section placed above it (third angle: seen from above).
        { id: 'v2', kind: 'front', type: 'section', parent: 'v1', line: [30, 0, -30, 0], label: 'A', x: 100, y: 50, hidden: false, dims: false },
      ],
    };
    const r = resolveViews(d).get('v2')!;
    // Placed above, it looks down like a top view and keeps the half below the line.
    expect(r.o.dir).toEqual([0, 1, 0]);
    expect(r.align).toBe('x');
    expect(r.section!.n).toEqual([0, -1, 0]);
    const proj = projectAll(b, d);
    const sec = proj.get('v2')!;
    // Cut faces: two 15 x 6 rectangles either side of the hole, in the view's coordinates (x along X, y down along -Z... the depth).
    expect(sec.cut!.length).toBeGreaterThanOrEqual(8);
    const xs = sec.cut!.flatMap((pl) => pl.filter((_, i) => i % 2 === 0));
    expect(Math.min(...xs)).toBeCloseTo(-20, 6);
    expect(Math.max(...xs)).toBeCloseTo(20, 6);
    // No outline crosses the hole.
    for (const pl of sec.cut!) for (let i = 0; i + 3 < pl.length; i += 2) {
      const [x1, x2] = [pl[i], pl[i + 2]];
      expect(Math.min(x1, x2) >= 5 - 1e-6 || Math.max(x1, x2) <= -5 + 1e-6).toBe(true);
    }
    // Hatched area: lines at 45 degrees across the two rectangles; none inside the hole.
    const lines = hatch(sec.cut!, 45, 1);
    expect(lines.length).toBeGreaterThan(10);
    for (const [x1, y1, x2, y2] of lines) {
      const mx = (x1 + x2) / 2;
      expect(Math.abs(mx) >= 5 - 1e-6, `hatch at ${mx},${(y1 + y2) / 2}`).toBe(true);
    }
    // The hatch covers 2 x 15 x 6 = 180 mm2: total hatch length x spacing.
    const total = lines.reduce((s, [x1, y1, x2, y2]) => s + Math.hypot(x2 - x1, y2 - y1), 0);
    expect(total * 1).toBeCloseTo(180, -1);
    // The sheet: the section's label, the cutting line's letters, and the hatch drawn in the view's group.
    const sheet = buildSheet(d, proj, info(res));
    const svg = toSvg(sheet.items, sheet.w, sheet.h);
    expect(svg).toContain('>SECTION A-A<');
    expect((svg.match(/>A</g) ?? []).length).toBe(2);
    expect((svg.match(/data-view="v2"/g) ?? []).length).toBe(1);
    // Aligned with its parent: the same x on the sheet for the same model x.
    const p1 = sheet.placements.get('v1')!, p2 = sheet.placements.get('v2')!;
    expect(p2.tx).toBeCloseTo(p1.tx, 9);
    // The section's projection is half the plate seen from above: 40 wide, 6 deep.
    expect(sec.bounds![2] - sec.bounds![0]).toBeCloseTo(40, 4);
    expect(sec.bounds![3] - sec.bounds![1]).toBeCloseTo(6, 4);
  });

  it('a vertical cut seen from the right shows the hole as a gap across the thickness', async () => {
    const b = new ModelBuilder();
    await b.build(plate());
    const d: DrawingDoc = {
      sheet: 'A4', landscape: true, scale: 2, title: '', drawnBy: '', notes: '',
      views: [
        { id: 'v1', kind: 'front', x: 100, y: 120, hidden: false, dims: false },
        // Vertical line through the hole, drawn bottom to top: its left normal points right.
        { id: 'v2', kind: 'front', type: 'section', parent: 'v1', line: [0, 15, 0, -15], label: 'B', x: 200, y: 120, hidden: false, dims: false },
      ],
    };
    const r = resolveViews(d).get('v2')!;
    expect(r.o.dir).toEqual([1, 0, 0]);
    expect(r.align).toBe('y');
    const sec = projectAll(b, d).get('v2')!;
    const ys = sec.cut!.flatMap((pl) => pl.filter((_, i) => i % 2 === 1));
    expect(Math.min(...ys)).toBeCloseTo(-10, 6);
    expect(Math.max(...ys)).toBeCloseTo(10, 6);
    const lines = hatch(sec.cut!, 45, 0.5);
    for (const [, y1, , y2] of lines) expect(Math.abs((y1 + y2) / 2) >= 5 - 1e-6).toBe(true);
    // First angle: the same placement looks from the other side.
    const first = resolveViews({ ...d, projection: 'first' }).get('v2')!;
    expect(first.o.dir).toEqual([-1, 0, 0]);
    expect(first.section!.n).toEqual([1, 0, 0]);
  });

  it('a section that misses the part is empty, not an error', async () => {
    const b = new ModelBuilder();
    await b.build(plate());
    const [res] = b.project([{ id: 's', dir: [0, 1, 0], x: [1, 0, 0], section: { p: [0, 50, 0], n: [0, 1, 0] } }]);
    expect(res.bounds).toBeNull();
    expect(res.cut).toEqual([]);
  });
});

describe('model dimensions on a drawing', () => {
  it('measures the plate and its hole from named model edges, and follows a model change', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', [...rect(-20, -10, 20, 10, 'r'), ...circle(0, 0, 5, 'c')]), extrude('E1', 'S1', 6)]));
    const top = res.edges.find((e) => e.type === 'line' && Math.abs(e.a[1] - 10) < 1e-6 && Math.abs(e.b[1] - 10) < 1e-6 && Math.abs(e.a[2] - 6) < 1e-6)!;
    const hole = res.edges.find((e) => e.type === 'circle' && Math.abs(e.center![2] - 6) < 1e-6)!;
    const d: DrawingDoc = {
      sheet: 'A4', landscape: true, scale: 1, title: '', drawnBy: '', notes: '',
      views: [{ id: 'v1', kind: 'front', x: 100, y: 100, hidden: false, dims: false }],
      annotations: [
        { id: 'a1', type: 'dimension', view: 'v1', kind: 'horizontal', refs: [{ edge: top.name, at: 'edge' }], at: [0, -20] },
        { id: 'a2', type: 'dimension', view: 'v1', kind: 'diameter', refs: [{ edge: hole.name, at: 'edge' }], at: [12, 12] },
      ],
    };
    const sheet = buildSheet(d, projectAll(b, d), info(res));
    const svg = toSvg(sheet.items, sheet.w, sheet.h);
    expect(svg).toContain('>40.00<');
    expect(svg).toContain('>Ø10.00<');
    // A wider plate and a larger hole: same edges by name, new values.
    const res2 = await b.build(req([sketch('S1', [...rect(-30, -10, 30, 10, 'r'), ...circle(0, 0, 7, 'c')]), extrude('E1', 'S1', 6)]));
    expect(res2.edges.some((e) => e.name === top.name)).toBe(true);
    const svg2 = toSvg(buildSheet(d, projectAll(b, d), info(res2)).items, 297, 210);
    expect(svg2).toContain('>60.00<');
    expect(svg2).toContain('>Ø14.00<');
    // An edge that is gone leaves the dimension marked as missing.
    const gone: DrawingDoc = { ...d, annotations: [{ ...d.annotations![0], refs: [{ edge: 'no such edge', at: 'edge' }] } as never] };
    const svg3 = toSvg(buildSheet(gone, projectAll(b, gone), info(res2)).items, 297, 210);
    expect(svg3).toContain('? (missing)');
    expect(svg3).toContain('fill="#d32f2f"');
  });
});
