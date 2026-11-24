// Runs the real OpenCascade kernel in Node: slower than unit tests but it
// is the only way to know the modeling features actually produce solids.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder, checkStep, errorText, isFatal } from '../src/kernel/build';
import * as R from 'replicad';
import { type Sh, getOc, isValid, mirrored, rotated, setOc, subShapes } from '../src/kernel/occ';
import type { Feature, FilletFeature, LinearPatternFeature, ShellFeature, SkDimension, SkEntity, SketchFeature } from '../src/model/types';
import { flangeExample } from '../src/app/examples';
import type { Vec3 } from '../src/math/vec';
import { solveSketch } from '../src/sketch/solver';
import { circle, extrude, polygon, rect, req, revolve, sketch } from './helpers';

beforeAll(async () => {
  setOc(await init());
});

const volume = (b: ModelBuilder) => b.massProperties()!.volume;

describe('feature regeneration', () => {
  it('extrudes a rectangle into a box', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', rect(0, 0, 30, 20)), extrude('E1', 'S1', 10)]));
    expect(res.status.every((s) => s.ok)).toBe(true);
    expect(volume(b)).toBeCloseTo(6000, 3);
    expect(res.faces).toHaveLength(6);
    expect(res.edges).toHaveLength(12);
    expect(res.mesh!.indices.length).toBeGreaterThan(0);
    // Faces are named by the sketch entity they come from.
    const names = res.faces.map((f) => f.name).sort();
    expect(names.filter((n) => n.startsWith('E1:side:'))).toHaveLength(4);
    expect(names).toContain('E1:cap0');
    expect(names).toContain('E1:cap1');
  });

  it('extrudes a small profile far from the sketch origin without losing it', async () => {
    const b = new ModelBuilder();
    const origin = 100_000_000;
    const res = await b.build(req([sketch('S1', rect(origin, origin, origin + 0.5, origin + 0.5)), extrude('E1', 'S1', 2)]));
    expect(res.status.every((s) => s.ok)).toBe(true);
    expect(volume(b)).toBeCloseTo(0.5, 5);
  });

  it('extrudes nested profiles with holes (even-odd)', async () => {
    const b = new ModelBuilder();
    const ents = [...rect(-20, -20, 20, 20), ...circle(0, 0, 10), ...circle(0, 0, 5)];
    await b.build(req([sketch('S1', ents), extrude('E1', 'S1', 2)]));
    const expected = (40 * 40 - Math.PI * 100 + Math.PI * 25) * 2;
    expect(volume(b)).toBeCloseTo(expected, 1);
  });

  it('combines untrimmed crossing contours the same wherever they cross, with a warning', async () => {
    // A circle over a rectangle's top edge came out as a hole crossing the
    // outline (no volume at all); over its right edge it was added.
    for (const [x, y] of [[0, 10], [20, 0], [-20, 0]]) {
      const b = new ModelBuilder();
      const res = await b.build(req([sketch('S1', [...rect(-20, -10, 20, 10), ...circle(x, y, 5)]), extrude('E1', 'S1', 1)]));
      expect(res.status[1]).toMatchObject({ ok: true, warning: expect.stringMatching(/cross each other/) });
      expect(volume(b)).toBeCloseTo(800 + Math.PI * 12.5, 3);
    }
  });

  it('extrudes rectangles sharing a side into one valid solid', async () => {
    // The shared side is drawn twice: it made faces of no area and an invalid solid.
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', [...rect(0, 0, 10, 10), ...rect(10, 0, 20, 10)]), extrude('E1', 'S1', 1)]));
    expect(res.status.every((s) => s.ok && !s.warning)).toBe(true);
    expect(volume(b)).toBeCloseTo(200, 6);
    expect(res.faces).toHaveLength(6);
    expect(isValid((b as unknown as { current: { body: Sh } }).current.body)).toBe(true);
  });

  it('extrudes a rectangle divided by many lines into one plain box', async () => {
    // The regions between the dividers are fused in one boolean (one by one was
    // several times slower), and the result is the box with its six faces.
    const ents: SkEntity[] = [...rect(0, 0, 60, 10, 't')];
    for (let i = 1; i < 30; i++) ents.push({ id: `a${i}`, t: 'point', x: i * 2, y: 0 }, { id: `b${i}`, t: 'point', x: i * 2, y: 10 }, { id: `d${i}`, t: 'line', a: `a${i}`, b: `b${i}` });
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', ents), extrude('E1', 'S1', 5)]));
    expect(res.status[1]).toEqual({ id: 'E1', ok: true });
    expect(volume(b)).toBeCloseTo(3000, 6);
    expect(res.faces).toHaveLength(6);
    expect(isValid((b as unknown as { current: { body: Sh } }).current.body)).toBe(true);
  });

  it('builds the same box when lines, points or projected edges only touch the profile', async () => {
    // Sketches that built a profile before curves were split at T junctions.
    const P = (id: string, x: number, y: number, extra: Partial<SkEntity> = {}) => ({ id, t: 'point', x, y, ...extra }) as SkEntity;
    const L = (id: string, a: string, b: string, extra: Partial<SkEntity> = {}) => ({ id, t: 'line', a, b, ...extra }) as SkEntity;
    const ext = { ext: { kind: 'edge', edge: { name: 'X1:side:l|X1:cap1', sig: { type: 'line', m: [0, 0, 0], len: 10 } } } } as Partial<SkEntity>;
    const cases: [string, SkEntity[], boolean][] = [
      ['a line from an edge going in', [P('t1', 10, 0), P('t2', 10, 8), L('tl', 't1', 't2')], true],
      ['a line from an edge going out', [P('t1', 10, 0), P('t2', 10, -8), L('tl', 't1', 't2')], true],
      ['a construction line ending on an edge', [P('t1', 10, 0), P('t2', 10, 20), L('tl', 't1', 't2', { construction: true })], false],
      ['a point on an edge', [P('pt', 10, 0)], false],
      ['a projected edge ending on an edge', [P('x1', 20, 10), P('x2', 30, 10), L('xl', 'x1', 'x2', ext)], true],
      ['a projected edge lying on an edge', [P('x1', 5, 0), P('x2', 15, 0), L('xl', 'x1', 'x2', ext)], false],
    ];
    for (const [label, extra, warns] of cases) {
      const b = new ModelBuilder();
      const res = await b.build(req([sketch('S1', [...rect(0, 0, 20, 20, 'r'), ...extra]), extrude('E1', 'S1', 2)]));
      expect(res.status[1].ok, label).toBe(true);
      expect(!!res.status[1].warning, label).toBe(warns);
      expect(volume(b), label).toBeCloseTo(800, 6);
      expect(res.faces.map((f) => f.name).sort(), label).toEqual(['E1:cap0', 'E1:cap1', 'E1:side:rl0', 'E1:side:rl1', 'E1:side:rl2', 'E1:side:rl3']);
    }
  });

  it('builds a valid solid when a hole touches its outline or another hole at a point', async () => {
    // The face of such a region is invalid, and so was every solid made from it.
    const body = (b: ModelBuilder) => (b as unknown as { current: { body: Sh } }).current.body;
    const cases: [string, SkEntity[], number][] = [
      ['a circle touching an edge', [...rect(0, 0, 20, 20, 'r'), ...circle(10, 3, 3, 'c')], 400 - Math.PI * 9],
      ['a circle touching the circle round it', [...circle(0, 0, 10, 'o'), ...circle(5, 0, 5, 'i')], Math.PI * 75],
      ['two circles touching', [...rect(-20, -10, 20, 10, 'r'), ...circle(-3, 0, 3, 'a'), ...circle(3, 0, 3, 'b')], 800 - Math.PI * 18],
    ];
    for (const [label, ents, area] of cases) {
      const b = new ModelBuilder();
      const res = await b.build(req([sketch('S1', ents), extrude('E1', 'S1', 2)]));
      expect(res.status[1], label).toEqual({ id: 'E1', ok: true });
      expect(volume(b), label).toBeCloseTo(area * 2, 6);
      expect(isValid(body(b)), label).toBe(true);
    }
    // The inner circle's face is named after it, not after the outer one.
    const ring = await new ModelBuilder().build(req([sketch('S1', cases[1][1]), extrude('E1', 'S1', 2)]));
    expect(ring.faces.map((f) => f.name).sort()).toEqual(['E1:cap0', 'E1:cap1', 'E1:side:i', 'E1:side:o']);
    // A taper cannot follow the faces meeting at the touching point: say why.
    const b = new ModelBuilder();
    const drafted = await b.build(req([sketch('S1', cases[0][1]), extrude('E1', 'S1', 1, { draft: 2 })]));
    expect(drafted.status[1].error).toMatch(/cannot taper a hole that touches the outline/);
  });

  it('extrudes the same spline region and hole in either drawing direction', async () => {
    const volumes: number[] = [];
    for (const clockwise of [false, true]) {
      const pts = ['a', 'b', 'c', 'd', 'a'];
      const b = new ModelBuilder();
      const res = await b.build(req([sketch('S1', [
        { id: 'a', t: 'point', x: -5, y: -5 },
        { id: 'b', t: 'point', x: 5, y: -5 },
        { id: 'c', t: 'point', x: 5, y: 5 },
        { id: 'd', t: 'point', x: -5, y: 5 },
        { id: 's', t: 'spline', pts: clockwise ? pts.reverse() : pts },
        ...circle(0, 0, 2),
      ]), extrude('E1', 'S1', 2)]));
      expect(res.status.every((s) => s.ok)).toBe(true);
      volumes.push(volume(b));
      expect(volume(b)).toBeGreaterThan(200);
      b.reset();
    }
    expect(volumes[0]).toBeCloseTo(volumes[1], 4);
  });

  it('cuts through all and supports mid-plane and two-direction extrusion', async () => {
    const b = new ModelBuilder();
    const feats: Feature[] = [
      sketch('S1', rect(-10, -10, 10, 10)),
      extrude('E1', 'S1', 20, { end: 'midPlane' }),
      sketch('S2', circle(0, 0, 3), { kind: 'base', plane: 'top' }),
      extrude('E2', 'S2', 1, { cut: true, end: 'throughAll', dir2: { end: 'throughAll', depth: 0 } }),
    ];
    const res = await b.build(req(feats));
    expect(res.status.every((s) => s.ok)).toBe(true);
    expect(volume(b)).toBeCloseTo(20 * 20 * 20 - Math.PI * 9 * 20, 1);
    expect(res.bbox!.min[2]).toBeCloseTo(-10, 6);
  });

  it('extrudes a boss through all up to the far side of the body', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)];
    const pin = (extra: Parameters<typeof extrude>[3]) => [...base, sketch('S2', circle(5, 15, 2)), extrude('E2', 'S2', 1, { end: 'throughAll', ...extra })];
    let r = await b.build(req(pin({})));
    expect(r.status[3]).toEqual({ id: 'E2', ok: true });
    expect(r.bbox!.max[2]).toBeCloseTo(10, 9);
    expect(volume(b)).toBeCloseTo(1000 + Math.PI * 4 * 10, 3);
    r = await b.build(req(pin({ flip: true })));
    expect(r.status[3].error).toMatch(/no body to extrude through/);
    // Direction 2 through all, away from the body, says it is Direction 2.
    r = await b.build(req(pin({ dir2: { end: 'throughAll', depth: 1 } })));
    expect(r.status[3].error).toBe('There is no body to extrude through in Direction 2. Use Blind for it, or turn Direction 2 off.');
    r = await b.build(req([sketch('S2', circle(5, 15, 2)), extrude('E2', 'S2', 1, { end: 'throughAll' })]));
    expect(r.status[1].error).toMatch(/needs a body/);
  });

  it('drafts both directions of an extrusion away from the sketch plane', async () => {
    const t = Math.tan((5 * Math.PI) / 180);
    // Square frustum of side 20 at the sketch plane, height h, tapering inward.
    const frustum = (h: number) => (20 ** 3 - (20 - 2 * h * t) ** 3) / (6 * t);
    const b = new ModelBuilder();
    for (const extra of [{ dir2: { end: 'blind' as const, depth: 10 } }, { end: 'midPlane' as const, depth: 20 }]) {
      const res = await b.build(req([sketch('S1', rect(-10, -10, 10, 10)), extrude('E1', 'S1', 10, { draft: 5, ...extra })]));
      expect(res.status[1].ok).toBe(true);
      const mp = b.massProperties()!;
      expect(mp.volume).toBeCloseTo(2 * frustum(10), 2);
      expect(mp.center[2]).toBeCloseTo(0, 6);
      expect(res.bbox!.min[2]).toBeCloseTo(-10, 6);
      expect(res.bbox!.max[0]).toBeCloseTo(10, 4);
    }
    // One direction keeps the sketch profile at the sketch plane.
    await b.build(req([sketch('S1', rect(-10, -10, 10, 10)), extrude('E1', 'S1', 10, { draft: 5 })]));
    expect(volume(b)).toBeCloseTo(frustum(10), 2);
  });

  it('reports a draft that closes the profile before the end instead of passing through it', async () => {
    const b = new ModelBuilder();
    const t = Math.tan((30 * Math.PI) / 180);
    const run = async (ents: ReturnType<typeof circle>, depth: number, extra: Parameters<typeof extrude>[3] = {}) =>
      (await b.build(req([sketch('S1', ents), extrude('E1', 'S1', depth, { draft: 30, ...extra })]))).status[1];
    // A 10 mm radius closes to a point 17.3 mm up: this used to come out as an hourglass.
    expect((await run(circle(0, 0, 10), 30)).error).toMatch(/closes the profile/);
    expect((await run(circle(0, 0, 10), 30, { end: 'midPlane' })).ok).toBe(true);
    expect(await run(circle(0, 0, 10), 15)).toEqual({ id: 'E1', ok: true });
    expect(volume(b)).toBeCloseTo((Math.PI / 3) * 15 * (100 + 10 * (10 - 15 * t) + (10 - 15 * t) ** 2), 2);
    // A 40 x 10 slot of a rectangle and two arcs: its half width is what counts.
    const slot = [
      { id: 'p0', t: 'point', x: -20, y: -5 }, { id: 'p1', t: 'point', x: 20, y: -5 }, { id: 'p2', t: 'point', x: 20, y: 5 }, { id: 'p3', t: 'point', x: -20, y: 5 },
      { id: 'c0', t: 'point', x: 20, y: 0 }, { id: 'c1', t: 'point', x: -20, y: 0 },
      { id: 'l0', t: 'line', a: 'p0', b: 'p1' }, { id: 'a0', t: 'arc', c: 'c0', a: 'p1', b: 'p2' },
      { id: 'l1', t: 'line', a: 'p2', b: 'p3' }, { id: 'a1', t: 'arc', c: 'c1', a: 'p3', b: 'p0' },
    ] as ReturnType<typeof circle>;
    expect((await run(slot, 4.9 / t)).ok).toBe(true);
    expect((await run(slot, 5.1 / t)).error).toMatch(/closes the profile/);
    // Outward, the holes close instead.
    const ring = [...circle(0, 0, 20), ...circle(0, 0, 4)];
    expect((await run(ring, 3.9 / t, { draftOutward: true })).ok).toBe(true);
    expect((await run(ring, 4.1 / t, { draftOutward: true })).error).toMatch(/closes the profile/);
    expect((await run(ring, 7.9 / t)).ok).toBe(true);
    expect((await run(ring, 8.1 / t)).error).toMatch(/closes the profile/);
  });

  it('reports negative draft angles and direction 2 depths instead of ignoring them', async () => {
    const b = new ModelBuilder();
    const neg = await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10, { draft: -5 })]));
    expect(neg.status[1].ok).toBe(false);
    expect(neg.status[1].error).toMatch(/draft angle/i);
    for (const draft of [90, 100]) {
      const steep = await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 1, { draft })]));
      expect(steep.status[1].error).toBe('The draft angle must be less than 90 degrees');
    }
    const d2 = await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10, { dir2: { end: 'blind', depth: 0 } })]));
    expect(d2.status[1].ok).toBe(false);
    expect(d2.status[1].error).toMatch(/Direction 2/);
    // Values the end conditions do not use are not checked.
    const unused = [
      extrude('E1', 'S1', 0, { end: 'throughAll', cut: true }),
      extrude('E1', 'S1', 10, { end: 'midPlane', dir2: { end: 'blind', depth: -1 } }),
      extrude('E1', 'S1', 10, { dir2: { end: 'throughAll', depth: 0 }, cut: true }),
    ];
    for (const f of unused) {
      const r = await b.build(req([sketch('S0', rect(-20, -20, 20, 20)), extrude('E0', 'S0', 5, { end: 'midPlane' }), sketch('S1', rect(0, 0, 10, 10)), f]));
      expect(r.status[3].error).toBeUndefined();
    }
  });

  it('revolves a profile about a centerline', async () => {
    const b = new ModelBuilder();
    const ents = [
      ...rect(5, 0, 10, 20),
      { id: 'a1', t: 'point', x: 0, y: -5 }, { id: 'a2', t: 'point', x: 0, y: 25 },
      { id: 'axis', t: 'line', a: 'a1', b: 'a2', construction: true },
    ] as any[];
    await b.build(req([sketch('S1', ents), revolve('R1', 'S1')]));
    expect(volume(b)).toBeCloseTo(Math.PI * (100 - 25) * 20, 0);
    const over = await b.build(req([sketch('S1', ents), revolve('R1', 'S1', 400)]));
    expect(over.status[1].error).toBe('The angle cannot be more than 360 degrees');
  });

  it('revolves about the free-standing centerline, not a construction diagonal of the profile', async () => {
    const b = new ModelBuilder();
    const ents = [
      ...rect(5, 0, 10, 20, 'r'),
      // A center rectangle's diagonal, listed before the axis.
      { id: 'dg', t: 'line', a: 'rp0', b: 'rp2', construction: true },
      { id: 'a1', t: 'point', x: 0, y: -5 }, { id: 'a2', t: 'point', x: 0, y: 25 },
      { id: 'axis', t: 'line', a: 'a1', b: 'a2', construction: true },
    ] as any[];
    // It revolved about the diagonal, which crosses the profile.
    const res = await b.build(req([sketch('S1', ents), revolve('R1', 'S1')]));
    expect(res.status[1].error).toBeUndefined();
    expect(volume(b)).toBeCloseTo(Math.PI * (100 - 25) * 20, 0);
  });

  it('rejects a revolve profile that crosses its axis with a readable error', async () => {
    const b = new ModelBuilder();
    const axis = [
      { id: 'a1', t: 'point', x: 0, y: -5 }, { id: 'a2', t: 'point', x: 0, y: 25 },
      { id: 'axis', t: 'line', a: 'a1', b: 'a2', construction: true },
    ] as any[];
    const res = await b.build(req([sketch('S1', [...rect(-5, 0, 10, 20), ...axis]), revolve('R1', 'S1')]));
    expect(res.status[1].ok).toBe(false);
    expect(res.status[1].error).toMatch(/crosses the axis/);
    // Touching the axis is fine.
    const ok = await b.build(req([sketch('S1', [...rect(0, 0, 10, 20), ...axis]), revolve('R1', 'S1')]));
    expect(ok.status[1].ok).toBe(true);
    expect(errorText(new (WebAssembly as any).Exception(new (WebAssembly as any).Tag({ parameters: [] }), []))).not.toMatch(/object/);
  });

  it('fails thin extrudes instead of building a full solid', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', circle(0, 0, 10)), extrude('E1', 'S1', 5, { thin: { thickness: 1, side: 'inside' } })]));
    expect(res.status[1].ok).toBe(false);
    expect(res.status[1].error).toMatch(/Thin features/);
    expect(b.hasBody).toBe(false);
  });

  it('warns when a cut misses the body', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-10, -10, 10, 10)), extrude('E1', 'S1', 10), sketch('S2', circle(0, 0, 3))];
    // Cuts go against the sketch normal by default: away from this body.
    const miss = await b.build(req([...base, extrude('E2', 'S2', 5, { cut: true, end: 'throughAll' })]));
    expect(miss.status[3]).toMatchObject({ ok: true, warning: expect.stringMatching(/does not remove any material/) });
    const hit = await b.build(req([...base, extrude('E2', 'S2', 5, { cut: true, end: 'throughAll', flip: true })]));
    expect(hit.status[3]).toEqual({ id: 'E2', ok: true });
    // While the cut is being edited, its preview says so too.
    const preview = await b.build(req(base, { preview: extrude('E2', 'S2', 5, { cut: true, end: 'throughAll' }) }));
    expect(preview.previewWarning).toMatch(/does not remove any material/);
    expect((await b.build(req(base, { preview: extrude('E2', 'S2', 5, { cut: true, end: 'throughAll', flip: true }) }))).previewWarning).toBeUndefined();
  });

  it('warns when a boss or mirror adds no material', async () => {
    // A boss sketched on the base and extruded into the box (Reverse direction) changed nothing, silently.
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-10, -10, 10, 10)), extrude('E1', 'S1', 10), sketch('S2', circle(0, 0, 3))];
    const inside = await b.build(req([...base, extrude('E2', 'S2', 5)]));
    expect(inside.status[3]).toMatchObject({ ok: true, warning: 'The feature adds no material: it lies inside the part. Check its direction.' });
    expect((await b.build(req([...base, extrude('E2', 'S2', 5, { flip: true })]))).status[3]).toEqual({ id: 'E2', ok: true });
    // Half inside still adds the other half.
    expect((await b.build(req([...base, extrude('E2', 'S2', 5, { end: 'midPlane' })]))).status[3]).toEqual({ id: 'E2', ok: true });
    const mirror = (plane: 'right' | 'top'): Feature => ({ id: 'M', name: 'M', type: 'mirror', seeds: [], plane: { kind: 'base', plane } });
    expect((await b.build(req([...base.slice(0, 2), mirror('right')]))).status[2]).toMatchObject({ ok: true, warning: expect.stringMatching(/already symmetric/) });
    expect((await b.build(req([sketch('S1', rect(0, -10, 10, 10)), extrude('E1', 'S1', 10), mirror('right')]))).status[2]).toEqual({ id: 'M', ok: true });
    // Copies of a boss that all land inside the part.
    const boss: Feature[] = [...base, extrude('E2', 'S2', 5, { flip: true })];
    const lin = (spacing: number): Feature => ({ id: 'P', name: 'P', type: 'linearPattern', seeds: ['E2'], dir1: { ref: { kind: 'base', axis: 'z' }, spacing, count: 2, flip: false }, dir2: null });
    expect((await b.build(req([...boss, lin(8)]))).status[4]).toMatchObject({ ok: true, warning: expect.stringMatching(/copies add no material/) });
    expect((await b.build(req([...boss, lin(-8)]))).status[4]).toEqual({ id: 'P', ok: true });
  });

  it('sweeps along path segments drawn in any order', async () => {
    const P = (id: string, x: number, y: number) => ({ id, t: 'point', x, y });
    const L = (id: string, a: string, b: string) => ({ id, t: 'line', a, b });
    const prof = sketch('SP', circle(0, 0, 2));
    // Right plane: sketch x is world -Z, so the path leaves the profile along its normal.
    const pts = [P('a', 0, 0), P('b', -20, 0), P('c', -20, 20), P('d', -40, 20)];
    const sweep: Feature = { id: 'SW', name: 'SW', type: 'sweep', profile: 'SP', path: 'PA', cut: false };
    const right = { kind: 'base', plane: 'right' } as const;
    for (const lines of [[L('l1', 'a', 'b'), L('l2', 'b', 'c'), L('l3', 'c', 'd')], [L('l1', 'a', 'b'), L('l3', 'd', 'c'), L('l2', 'c', 'b')]]) {
      const b = new ModelBuilder();
      const res = await b.build(req([prof, sketch('PA', [...pts, ...lines] as any[], right), sweep]));
      expect(res.status[2].ok).toBe(true);
      expect(volume(b)).toBeCloseTo(Math.PI * 4 * 60, 0);
    }
    // A sweep that lies in the profile plane has no volume: an error, not an empty solid.
    const b = new ModelBuilder();
    const flat = await b.build(req([prof, sketch('PA', [P('a', 0, 0), P('b', 0, 20), L('l1', 'a', 'b')] as any[], right), sweep]));
    expect(flat.status[2].ok).toBe(false);
    // Branching paths are rejected.
    const branch = await b.build(req([prof, sketch('PA', [...pts, P('e', -20, -20), L('l1', 'a', 'b'), L('l2', 'b', 'c'), L('l4', 'b', 'e')] as any[], right), sweep]));
    expect(branch.status[2].error).toMatch(/connected chain/);
  });

  it('lofts and sweeps profiles with an inner loop as hollow solids', async () => {
    const plane: Feature = { id: 'PL', name: 'PL', type: 'plane', ref: { kind: 'base', plane: 'front' }, offset: 20, flip: false };
    const loft: Feature = { id: 'LO', name: 'LO', type: 'loft', profiles: ['S1', 'S2'], cut: false, ruled: true };
    const b = new ModelBuilder();
    const hollow = await b.build(req([
      sketch('S1', [...rect(-10, -10, 10, 10), ...circle(0, 0, 4)]), plane,
      sketch('S2', [...rect(-10, -10, 10, 10), ...circle(0, 0, 4)], { kind: 'feature', id: 'PL' }), loft,
    ]));
    expect(hollow.status[3]).toEqual({ id: 'LO', ok: true });
    expect(volume(b)).toBeCloseTo((400 - Math.PI * 16) * 20, 0);
    // Contours that cannot be lofted are reported, not silently dropped.
    const extra = await b.build(req([
      sketch('S1', [...rect(-10, -10, 10, 10), ...rect(20, 0, 25, 5)]), plane,
      sketch('S2', rect(-10, -10, 10, 10), { kind: 'feature', id: 'PL' }), loft,
    ]));
    expect(extra.status[3].ok).toBe(true);
    expect(extra.status[3].warning).toMatch(/first closed contour/);
    // Profiles in one plane, and a path that is the profile's own sketch, say so.
    const flat = await b.build(req([sketch('S1', rect(-10, -10, 10, 10)), sketch('S2', circle(30, 0, 5)), loft]));
    expect(flat.status[2].error).toBe('The profiles S1 and S2 lie in the same plane. Sketch each profile on its own plane.');
    const self = await b.build(req([sketch('S1', rect(-10, -10, 10, 10)), { id: 'SW', name: 'SW', type: 'sweep', profile: 'S1', path: 'S1', cut: false }]));
    expect(self.status[1].error).toBe('The profile and the path are the same sketch. Draw the path in a sketch of its own.');
    // A tube profile sweeps into a pipe.
    const P = (id: string, x: number, y: number) => ({ id, t: 'point', x, y });
    const path = sketch('PA', [P('a', 0, 0), P('b', -30, 0), { id: 'l', t: 'line', a: 'a', b: 'b' }] as any[], { kind: 'base', plane: 'right' });
    const sweep: Feature = { id: 'SW', name: 'SW', type: 'sweep', profile: 'SP', path: 'PA', cut: false };
    const pipe = await b.build(req([sketch('SP', [...circle(0, 0, 3), ...circle(0, 0, 2)]), path, sweep]));
    expect(pipe.status[2]).toEqual({ id: 'SW', ok: true });
    expect(volume(b)).toBeCloseTo(Math.PI * (9 - 4) * 30, 1);
  });

  it('names revolved faces after their profile curves and keeps references through edits', async () => {
    const rebuild = async (dim: string, value: number) => {
      const doc = flangeExample();
      const s = doc.features[0] as SketchFeature;
      (s.constraints.find((c) => c.id === dim) as SkDimension).value = value;
      solveSketch(s.entities, s.constraints, { value: (d: SkDimension) => Number(d.value) });
      const b = new ModelBuilder();
      const res = await b.build({ features: doc.features, upTo: doc.features.length, blobs: {}, quality: 0 });
      return { b, res };
    };
    const { res } = await rebuild('d1', 12);
    const top = res.faces.find((f) => f.name === 'f1:side:fl2')!;
    expect(top.type).toBe('plane');
    expect(top.normal![1]).toBeCloseTo(1, 9);
    expect(res.faces.find((f) => f.name === 'f1:side:fl0')!.normal![1]).toBeCloseTo(-1, 9);
    // Bore radius 12 -> 5, outer radius 45 -> 60: holes, pattern and chamfer still apply.
    for (const [dim, v, vol] of [['d1', 5, Math.PI * (2000 * 8 + 459 * 18)], ['d2', 60, Math.PI * (3456 * 8 + 340 * 18)]] as const) {
      const r = await rebuild(dim, v);
      expect(r.res.status.filter((x) => !x.ok || x.warning)).toEqual([]);
      // Six 7 mm bolt holes through the 8 mm flange, and a 1.5 mm chamfer on the rim.
      const holes = 6 * Math.PI * 3.5 ** 2 * 8;
      const chamfer = 0.5 * 1.5 ** 2 * 2 * Math.PI * (v === 60 ? 60 : 45);
      expect(volume(r.b)).toBeCloseTo(vol - holes - chamfer, -1);
    }
  });

  it('gives mirrored planar faces outward normals', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', rect(5, 0, 15, 10)), extrude('E1', 'S1', 10), { id: 'M1', name: 'M1', type: 'mirror', seeds: [], plane: { kind: 'base', plane: 'right' } }]));
    expect(res.faces).toHaveLength(12);
    for (const f of res.faces) {
      const c: [number, number, number] = [Math.sign(f.center[0]) * 10, 5, 5];
      const out = f.normal!.reduce((a, n, i) => a + n * (f.center[i] - c[i]), 0);
      expect(out, f.name).toBeGreaterThan(0);
    }
  });

  it('fillets edges referenced by name and survives a dimension change', async () => {
    const fillet = (): FilletFeature => ({ id: 'F1', name: 'F1', type: 'fillet', edges: [], faces: [], radius: 2 });
    const b = new ModelBuilder();
    const base = [sketch('S1', rect(0, 0, 30, 20, 'r')), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    // Pick the four vertical edges (between side faces).
    const vertical = r0.edges.filter((e) => e.name.split('|').every((n) => n.startsWith('E1:side:')));
    expect(vertical).toHaveLength(4);
    const f = fillet();
    f.edges = vertical.map((e) => ({ name: e.name, sig: { type: e.type, m: e.mid, len: e.length } }));
    const r1 = await b.build(req([...base, f]));
    expect(r1.status.every((s) => s.ok)).toBe(true);
    const v1 = volume(b);
    expect(v1).toBeCloseTo(6000 - 4 * (4 - Math.PI) * 10, 2);
    // Make the box taller: edge names stay valid and the fillet still applies.
    const taller = [sketch('S1', rect(0, 0, 30, 20, 'r')), extrude('E1', 'S1', 25), f];
    const r2 = await b.build(req(taller));
    expect(r2.status.every((s) => s.ok)).toBe(true);
    expect(volume(b)).toBeCloseTo(30 * 20 * 25 - 4 * (4 - Math.PI) * 25, 2);
  });

  it('rounds all of an edge an upstream cut split, and says when its edge is gone', async () => {
    // A notch cut through the edge rounded only the half nearest its middle;
    // a step cut along the whole edge moved the fillet to the next edge without a word.
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(0, 0, 40, 20, 'b')), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const e = r0.edges.find((x) => x.type === 'line' && Math.abs(x.mid[1]) < 1e-6 && Math.abs(x.mid[2] - 10) < 1e-6)!;
    const fillet: Feature = { id: 'F', name: 'F', type: 'fillet', edges: [{ name: e.name, sig: { type: 'line', m: e.mid, len: e.length } }], faces: [], radius: 2 };
    const notch: Feature[] = [sketch('S2', rect(18, -1, 22, 5, 'n')), extrude('E2', 'S2', 20, { cut: true, end: 'throughAll', flip: true })];
    await b.build(req([...base, ...notch]));
    const before = volume(b);
    const r = await b.build(req([...base, ...notch, fillet]));
    expect(r.status[4]).toEqual({ id: 'F', ok: true });
    expect(before - volume(b)).toBeCloseTo((4 - Math.PI) * 36, 3);
    const top = { kind: 'face' as const, face: { name: 'E1:cap1', sig: { type: 'plane', c: [20, 10, 10] as Vec3, n: [0, 0, 1] as Vec3, area: 800 } } };
    const step: Feature[] = [sketch('S3', rect(-1, -1, 41, 3, 's'), top), extrude('E3', 'S3', 0.5, { cut: true })];
    expect((await b.build(req([...base, ...step, fillet]))).status[4]).toMatchObject({ ok: true, warning: expect.stringMatching(/A selected edge \(made by E1\) is gone; the edge nearest its place was used/) });
  });

  it('names the side face of a wide arc after the arc, not after a nearby line', async () => {
    const b = new ModelBuilder();
    // A 270 degree arc closed by two radii: the arc face's centroid lies nearer the radii.
    const c = 20 * Math.SQRT1_2;
    const ents: SketchFeature['entities'] = [
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'pa', t: 'point', x: c, y: c }, { id: 'pb', t: 'point', x: c, y: -c },
      { id: 'arc', t: 'arc', c: 'o', a: 'pa', b: 'pb' }, { id: 'la', t: 'line', a: 'o', b: 'pa' }, { id: 'lb', t: 'line', a: 'pb', b: 'o' },
    ];
    const r = await b.build(req([sketch('S1', ents), extrude('E1', 'S1', 10)]));
    expect(r.faces.find((f) => f.type === 'cylinder')!.name).toBe('E1:side:arc');
    expect(new Set(r.faces.map((f) => f.name)).size).toBe(r.faces.length);
    expect(r.edges.map((e) => e.name)).toContain('E1:cap1|E1:side:arc');
  });

  it('names the faces of two arcs of one circle after each arc', async () => {
    const b = new ModelBuilder();
    // A round bar with two flats.
    const ents: SketchFeature['entities'] = [
      { id: 'o', t: 'point', x: 0, y: 0 },
      { id: 'p1', t: 'point', x: 8, y: 6 }, { id: 'p2', t: 'point', x: -8, y: 6 }, { id: 'p3', t: 'point', x: -8, y: -6 }, { id: 'p4', t: 'point', x: 8, y: -6 },
      { id: 'top', t: 'arc', c: 'o', a: 'p1', b: 'p2' }, { id: 'left', t: 'line', a: 'p2', b: 'p3' },
      { id: 'bot', t: 'arc', c: 'o', a: 'p3', b: 'p4' }, { id: 'right', t: 'line', a: 'p4', b: 'p1' },
    ];
    const r = await b.build(req([sketch('S1', ents), extrude('E1', 'S1', 10)]));
    const arcs = r.faces.filter((f) => f.type === 'cylinder');
    expect(arcs.find((f) => f.center[1] > 0)!.name).toBe('E1:side:top');
    expect(arcs.find((f) => f.center[1] < 0)!.name).toBe('E1:side:bot');
  });

  it('names a revolved arc face after the arc, not after the chord closing it', async () => {
    const b = new ModelBuilder();
    // Half a disc beside the axis: the arc's ends average onto the chord line.
    const ents: SketchFeature['entities'] = [
      { id: 'o', t: 'point', x: 30, y: 0 }, { id: 'pa', t: 'point', x: 30, y: -10 }, { id: 'pb', t: 'point', x: 30, y: 10 },
      { id: 'arc', t: 'arc', c: 'o', a: 'pa', b: 'pb' }, { id: 'ln', t: 'line', a: 'pb', b: 'pa' },
      { id: 'a1', t: 'point', x: 0, y: -20 }, { id: 'a2', t: 'point', x: 0, y: 20 }, { id: 'ax', t: 'line', a: 'a1', b: 'a2', construction: true },
    ];
    for (const extra of [{}, { angle: 90 }, { angle: 90, end: 'midPlane' as const }]) {
      const r = await b.build(req([sketch('S1', ents), revolve('R1', 'S1', 360, extra)]));
      expect(r.faces.find((f) => f.type === 'torus')!.name).toBe('R1:side:arc');
      expect(r.faces.find((f) => f.type === 'cylinder')!.name).toBe('R1:side:ln');
    }
  });

  it('keeps the names of fillet and loft faces that a later cut trims', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', circle(0, 0, 20, 'cc')), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const top = r0.edges.find((e) => e.name.includes('E1:cap1'))!;
    const fillet: FilletFeature = { id: 'F1', name: 'F1', type: 'fillet', edges: [{ name: top.name, sig: { type: top.type, m: top.mid, len: top.length } }], faces: [], radius: 3 };
    const round = (await b.build(req([...base, fillet]))).faces.find((f) => f.type === 'torus')!.name;
    expect(round).toMatch(/^F1:/);
    const slot = [sketch('S3', rect(15, -2, 30, 2)), extrude('E3', 'S3', 50, { cut: true, flip: true })];
    const r1 = await b.build(req([...base, fillet, ...slot]));
    expect(r1.status.every((s) => s.ok)).toBe(true);
    expect(r1.faces.filter((f) => f.type === 'torus').map((f) => f.name)).toEqual([round]);
    // A hole through two side faces of a loft leaves their names alone.
    const loft: Feature[] = [
      sketch('A', rect(-10, -10, 10, 10)),
      { id: 'P1', name: 'P1', type: 'plane', ref: { kind: 'base', plane: 'front' }, offset: 20, flip: false },
      sketch('B', circle(0, 0, 5), { kind: 'feature', id: 'P1' }),
      { id: 'L', name: 'L', type: 'loft', profiles: ['A', 'B'], cut: false, ruled: false },
    ];
    const names = (r: { faces: { name: string; type: string }[] }) => r.faces.filter((f) => f.type === 'bspline').map((f) => f.name).sort();
    const before = names(await b.build(req(loft)));
    const hole = [sketch('S9', circle(0, -8, 2), { kind: 'base', plane: 'top' }), extrude('E9', 'S9', 50, { cut: true, end: 'throughAll', dir2: { end: 'throughAll', depth: 0 } })];
    const r2 = await b.build(req([...loft, ...hole]));
    expect(r2.status.every((s) => s.ok)).toBe(true);
    expect(names(r2)).toEqual(before);
  });

  it('keeps the names of drafted faces when more faces are drafted', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-10, -10, 10, 10, 'r')), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const side = (n: string) => {
      const f = r0.faces.find((x) => x.name === `E1:side:${n}`)!;
      return { name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } };
    };
    const draft = (faces: ReturnType<typeof side>[]): Feature => ({ id: 'D1', name: 'D1', type: 'draft', faces, neutral: { kind: 'base', plane: 'front' }, angle: 5, flip: false });
    const r1 = await b.build(req([...base, draft([side('rl1')])]));
    expect(r1.status[2].ok).toBe(true);
    const edge = r1.edges.find((e) => e.name.includes('D1:') && e.name.includes('E1:cap1'))!;
    expect(edge.mid[0]).toBeGreaterThan(9);
    // Drafting a face that comes first in the body must not hand its name
    // (and so a later fillet on that edge) to another face.
    const r2 = await b.build(req([...base, draft([side('rl0'), side('rl1')])]));
    expect(r2.status[2].ok).toBe(true);
    const same = r2.edges.find((e) => e.name === edge.name)!;
    expect(same.mid[0]).toBeCloseTo(edge.mid[0], 6);
    expect(r2.faces.filter((f) => f.name.startsWith('D1:'))).toHaveLength(2);
  });

  it('shells a box removing the top face', async () => {
    const b = new ModelBuilder();
    const base = [sketch('S1', rect(0, 0, 30, 20)), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const top = r0.faces.find((f) => f.name === 'E1:cap1')!;
    const shell: ShellFeature = { id: 'SH', name: 'Shell', type: 'shell', thickness: 1, outward: false, faces: [{ name: top.name, sig: { type: top.type, c: top.center, n: top.normal, area: top.area } }] };
    const r1 = await b.build(req([...base, shell]));
    expect(r1.status[2]).toEqual({ id: 'SH', ok: true });
    expect(volume(b)).toBeCloseTo(6000 - 28 * 18 * 9, 1);
  });

  it('says to remove fewer faces when the faces a shell opens leave nothing to hold its walls', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(0, 0, 40, 20)), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const sides = r0.faces.filter((f) => f.name.includes(':side:')).map((f) => ({ name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } }));
    const r = await b.build(req([...base, { id: 'SH', name: 'SH', type: 'shell', faces: sides, thickness: 1, outward: false }]));
    expect(r.status[2].error).toBe('The shell could not be created. Try a smaller thickness, or remove fewer faces.');
  });

  it('shells a box with no faces removed into a closed hollow part', async () => {
    const b = new ModelBuilder();
    const base = [sketch('S1', rect(-10, -10, 10, 10)), extrude('E1', 'S1', 10)];
    await b.build(req(base));
    const shell = (thickness: number, outward: boolean): ShellFeature => ({ id: 'SH', name: 'Shell', type: 'shell', thickness, outward, faces: [] });
    let r = await b.build(req([...base, shell(1, false)]));
    expect(r.status[2]).toEqual({ id: 'SH', ok: true });
    // The outer box stays, with an 18 x 18 x 8 cavity inside.
    expect(volume(b)).toBeCloseTo(4000 - 18 * 18 * 8, 1);
    expect(r.bbox!.max[2]).toBeCloseTo(10, 6);
    expect(r.faces).toHaveLength(12);
    r = await b.build(req([...base, shell(1, true)]));
    expect(r.status[2]).toEqual({ id: 'SH', ok: true });
    // Outward: walls round the original box, which becomes the cavity.
    const outer = 22 * 22 * 12 - (8 * 20 + 4 * 10) * (1 - Math.PI / 4) - 8 * (1 - Math.PI / 6);
    expect(volume(b)).toBeCloseTo(outer - 4000, 1);
    expect(r.bbox!.max[2]).toBeCloseTo(11, 6);
    for (const t of [10, 50]) {
      r = await b.build(req([...base, shell(t, false)]));
      expect(r.status[2].ok).toBe(false);
      expect(volume(b)).toBeCloseTo(4000, 3);
    }
    // With a hole through it the offset comes back as a closed shell, not a solid.
    const holed = [...base, sketch('S2', circle(0, 0, 3)), extrude('E2', 'S2', 10, { cut: true, flip: true })];
    r = await b.build(req([...holed, { ...shell(1, false), id: 'SH2' }]));
    expect(r.status[4]).toEqual({ id: 'SH2', ok: true });
    const wall = 20 * 20 * 10 - Math.PI * 9 * 10 - (18 * 18 * 8 - Math.PI * 16 * 8);
    expect(volume(b)).toBeCloseTo(wall, 1);
  });

  it('shells each body of a part with separate bodies', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', [...rect(0, 0, 10, 10), ...rect(20, 0, 30, 10)]), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const tops = r0.faces.filter((f) => f.name === 'E1:cap1').sort((p, q) => p.center[0] - q.center[0]);
    const ref = (f: (typeof tops)[number]) => ({ name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } });
    const shell = (faces: ReturnType<typeof ref>[]): ShellFeature => ({ id: 'SH', name: 'Shell', type: 'shell', thickness: 1, outward: false, faces });
    const open = 1000 - 8 * 8 * 9;
    // Open the top of both, of one (the other stays solid), or of none.
    for (const [faces, v] of [[tops.map(ref), 2 * open], [[ref(tops[1])], 1000 + open], [[], 2 * (1000 - 8 * 8 * 8)]] as const) {
      const r = await b.build(req([...base, shell([...faces])]));
      expect(r.status[2]).toEqual({ id: 'SH', ok: true });
      expect(volume(b)).toBeCloseTo(v, 1);
    }
  });

  it('cuts counterbored and countersunk holes and rejects a hole shallower than its counterbore or countersink', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-20, -20, 20, 20)), extrude('E1', 'S1', 3)];
    const r0 = await b.build(req(base));
    const top = r0.faces.find((f) => f.name === 'E1:cap1')!;
    const pos = sketch('S2', [{ id: 'hp', t: 'point', x: 0, y: 0 }], { kind: 'face', face: { name: top.name, sig: { type: 'plane', c: top.center, n: top.normal, area: top.area } } });
    const hole = (end: 'blind' | 'throughAll', depth: number, cbDepth: number): Feature => ({
      id: 'H', name: 'H', type: 'hole', sketch: 'S2', kind: 'counterbore', diameter: 4, end, depth, cbDiameter: 8, cbDepth, csDiameter: 8, csAngle: 90, flip: false,
    });
    let r = await b.build(req([...base, pos, hole('blind', 2.5, 1)]));
    expect(r.status[3].ok).toBe(true);
    expect(4800 - volume(b)).toBeCloseTo(Math.PI * 16 + Math.PI * 4 * 1.5, 3);
    for (const depth of [1, 0.5]) {
      r = await b.build(req([...base, pos, hole('blind', depth, 1)]));
      expect(r.status[3].ok).toBe(false);
      expect(r.status[3].error).toMatch(/greater than the counterbore depth/);
    }
    // Through all with a counterbore deeper than the plate: the counterbore goes through.
    r = await b.build(req([...base, pos, hole('throughAll', 0, 5)]));
    expect(r.status[3].ok).toBe(true);
    expect(4800 - volume(b)).toBeCloseTo(Math.PI * 16 * 3, 3);
    // No hole of the hole diameter is left, which is likely a slip: said.
    expect(r.status[3].warning).toBe('The counterbore goes through the part, so no hole of the hole diameter is left. Check its depth.');
    expect((await b.build(req([...base, pos, hole('throughAll', 0, 1)]))).status[3]).toEqual({ id: 'H', ok: true });
    // A blind countersunk hole ending inside its 2 mm deep countersink.
    const sink = (depth: number): Feature => ({ ...hole('blind', depth, 1), kind: 'countersink' } as Feature);
    r = await b.build(req([...base, pos, sink(2.5)]));
    expect(r.status[3].ok).toBe(true);
    expect(4800 - volume(b)).toBeCloseTo((Math.PI * 2 / 3) * (16 + 8 + 4) + Math.PI * 4 * 0.5, 3);
    for (const depth of [2, 1]) {
      r = await b.build(req([...base, pos, sink(depth)]));
      expect(r.status[3].ok).toBe(false);
      expect(r.status[3].error).toMatch(/greater than the countersink depth/);
    }
  });

  it('reports an error instead of a degenerate fillet or shell', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-10, -10, 10, 10)), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const top = r0.faces.find((f) => f.name === 'E1:cap1')!;
    const shell = (thickness: number, outward = false): ShellFeature => ({
      id: 'SH', name: 'Shell', type: 'shell', thickness, outward,
      faces: [{ name: top.name, sig: { type: top.type, c: top.center, n: top.normal, area: top.area } }],
    });
    // Thicker than the part: OpenCascade returns an unchanged or empty solid.
    for (const t of [10, 15, 50]) {
      const r = await b.build(req([...base, shell(t)]));
      expect(r.status[2].ok).toBe(false);
      expect(r.status[2].error).toMatch(/smaller thickness/);
      expect(volume(b)).toBeCloseTo(4000, 3);
    }
    expect((await b.build(req([...base, shell(2)]))).status[2].ok).toBe(true);
    expect((await b.build(req([...base, shell(2, true)]))).status[2].ok).toBe(true);
    // A wall as thick as a fillet's radius cannot be offset: say so.
    const vertical = r0.edges.filter((e) => e.name.split('|').every((n) => n.startsWith('E1:side:'))).map((e) => ({ name: e.name, sig: { type: e.type, m: e.mid, len: e.length } }));
    const round: FilletFeature = { id: 'F1', name: 'F1', type: 'fillet', edges: vertical, faces: [], radius: 1 };
    const rounded = await b.build(req([...base, round, shell(1)]));
    expect(rounded.status[3].ok).toBe(false);
    expect(rounded.status[3].error).toMatch(/thinner than the radius of the fillets/);
    expect((await b.build(req([...base, round, shell(0.5)]))).status[3].ok).toBe(true);
    // A radius that consumes the whole box comes back as a zero-volume solid.
    const edges = r0.edges.map((e) => ({ name: e.name, sig: { type: e.type, m: e.mid, len: e.length } }));
    const fillet: FilletFeature = { id: 'F1', name: 'F1', type: 'fillet', edges, faces: [], radius: 9 };
    const r = await b.build(req([...base, fillet]));
    expect(r.status[2].ok).toBe(false);
    expect(volume(b)).toBeCloseTo(4000, 3);
  });

  it('chamfers every edge of a selected face with its two distances on the same sides', async () => {
    const b = new ModelBuilder();
    // A notch makes the top face's neighbours come before and after it in the body.
    const base: Feature[] = [
      sketch('S1', rect(-20, -20, 20, 20)), extrude('E1', 'S1', 10),
      sketch('S2', rect(-25, -5, -10, 5)), extrude('E2', 'S2', 50, { cut: true, flip: true }),
    ];
    const r0 = await b.build(req(base));
    const top = r0.faces.find((f) => f.name === 'E1:cap1')!;
    const chamfer = (flip: boolean): Feature => ({
      id: 'C', name: 'C', type: 'chamfer', edges: [], faces: [{ name: top.name, sig: { type: top.type, c: top.center, n: top.normal, area: top.area } }],
      mode: 'twoDistance', distance: 1, distance2: 3, angle: 45, flip,
    });
    // Distance 1 down the walls, distance 2 across the top; Flip swaps them.
    for (const [flip, nz] of [[false, 3 / Math.sqrt(10)], [true, 1 / Math.sqrt(10)]] as const) {
      const r = await b.build(req([...base, chamfer(flip)]));
      expect(r.status[4].ok).toBe(true);
      const slopes = r.faces.filter((f) => f.feature === 'C').map((f) => f.normal![2]);
      expect(slopes).toHaveLength(8);
      for (const z of slopes) expect(z).toBeCloseTo(nz, 6);
    }
  });

  it('reports chamfer distances and angles out of range by name', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-10, -10, 10, 10)), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const e = r0.edges[0];
    const chamfer = (mode: 'twoDistance' | 'distanceAngle', distance2: number, angle: number): Feature => ({
      id: 'C', name: 'C', type: 'chamfer', edges: [{ name: e.name, sig: { type: e.type, m: e.mid, len: e.length } }], faces: [], mode, distance: 1, distance2, angle, flip: false,
    });
    for (const [c, msg] of [[chamfer('twoDistance', 0, 45), /Distance 2 must be greater than zero/], [chamfer('twoDistance', -1, 45), /Distance 2/],
      [chamfer('distanceAngle', 1, 90), /between 0 and 90/], [chamfer('distanceAngle', 1, 120), /between 0 and 90/], [chamfer('distanceAngle', 1, 0), /between 0 and 90/]] as const) {
      const r = await b.build(req([...base, c]));
      expect(r.status[2].ok).toBe(false);
      expect(r.status[2].error).toMatch(msg);
    }
    // Values that only matter in another mode are not checked.
    expect((await b.build(req([...base, { ...chamfer('twoDistance', 2, 0) }]))).status[2].ok).toBe(true);
    expect((await b.build(req([...base, { ...chamfer('distanceAngle', 0, 30) }]))).status[2].ok).toBe(true);
    expect((await b.build(req([...base, { ...chamfer('distanceAngle', 0, 30), mode: 'distance' } as Feature]))).status[2].ok).toBe(true);
  });

  it('sketches on a face and patterns a cut', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(0, 0, 50, 10)), extrude('E1', 'S1', 5)];
    const r0 = await b.build(req(base));
    const top = r0.faces.find((f) => f.name === 'E1:cap1')!;
    const s2 = sketch('S2', circle(5, 5, 2), { kind: 'face', face: { name: top.name, sig: { type: 'plane', c: top.center, n: top.normal, area: top.area } } });
    const cutF = extrude('E2', 'S2', 5, { cut: true, end: 'throughAll' });
    const pat: Feature = {
      id: 'P1', name: 'P1', type: 'linearPattern', seeds: ['E2'],
      dir1: { ref: { kind: 'base', axis: 'x' }, spacing: 10, count: 4, flip: false }, dir2: null,
    };
    const res = await b.build(req([...base, s2, cutF, pat]));
    expect(res.status.map((s) => s.ok)).toEqual([true, true, true, true, true]);
    expect(volume(b)).toBeCloseTo(50 * 10 * 5 - 4 * Math.PI * 4 * 5, 1);
  });

  it('reports patterns whose instances would all land on the seed', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-20, -20, 20, 20)), extrude('E1', 'S1', 10), sketch('S2', circle(10, 0, 2)), extrude('E2', 'S2', 10, { cut: true, flip: true })];
    const circ = (angle: number, equal: boolean): Feature => ({ id: 'P', name: 'P', type: 'circularPattern', seeds: ['E2'], axis: { kind: 'base', axis: 'z' }, count: 4, angle, equal, flip: false });
    const lin = (spacing: number): Feature => ({ id: 'P', name: 'P', type: 'linearPattern', seeds: ['E2'], dir1: { ref: { kind: 'base', axis: 'y' }, spacing, count: 3, flip: false }, dir2: null });
    for (const p of [circ(360, false), circ(0, true), circ(720, false)]) {
      const res = await b.build(req([...base, p]));
      expect(res.status[4].ok).toBe(false);
      expect(res.status[4].error).toMatch(/on top of each other/);
    }
    expect((await b.build(req([...base, lin(0)]))).status[4].error).toMatch(/spacing must not be zero/);
    const one = { ...lin(10), dir1: { ...(lin(10) as LinearPatternFeature).dir1, count: 1 } } as Feature;
    expect((await b.build(req([...base, one]))).status[4].error).toMatch(/only the original. Set 2 or more instances/);
    // Direction 2 turned on without a direction says so.
    const noDir2 = { ...lin(10), dir2: { ref: null, spacing: 5, count: 2, flip: false } } as Feature;
    expect((await b.build(req([...base, noDir2]))).status[4].error).toBe('Select a direction for Direction 2');
    for (const p of [circ(360, true), circ(-360, true), circ(90, false), lin(-10)]) expect((await b.build(req([...base, p]))).status[4]).toEqual({ id: 'P', ok: true });
    // A full turn the other way makes the same four holes.
    await b.build(req([...base, circ(-360, true)]));
    expect(volume(b)).toBeCloseTo(40 * 40 * 10 - 4 * Math.PI * 4 * 10, 3);
    // Copies of a cut that all land off the part do nothing: say so.
    const off = await b.build(req([...base, lin(100)]));
    expect(off.status[4].ok).toBe(true);
    expect(off.status[4].warning).toMatch(/do not remove any material/);
  });

  it('cuts and adds overlapping holes and pattern copies as their union', async () => {
    // The copies went to the boolean as one compound, whose pieces it does
    // not intersect with each other: two holes at one point cut nothing,
    // overlapping holes cut one, and overlapping boss copies left a gap.
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(0, 0, 40, 20)), extrude('E1', 'S1', 10)];
    const holes = (pts: [number, number][]): Feature[] => [
      sketch('S2', pts.map(([x, y], i) => ({ id: `hp${i}`, t: 'point', x, y }))),
      { id: 'H', name: 'H', type: 'hole', sketch: 'S2', kind: 'simple', diameter: 5, end: 'throughAll', depth: 10, cbDiameter: 9, cbDepth: 3, csDiameter: 10, csAngle: 90, flip: true },
    ];
    const one = Math.PI * 6.25 * 10;
    let res = await b.build(req([...base, ...holes([[10, 10], [10, 10]])]));
    expect(res.status[3]).toEqual({ id: 'H', ok: true });
    expect(8000 - volume(b)).toBeCloseTo(one, 3);
    // Two holes 2 mm apart: the union of two 2.5 mm circles.
    const lens = 2 * 6.25 * Math.acos(0.4) - Math.sqrt(21);
    await b.build(req([...base, ...holes([[10, 10], [12, 10]])]));
    expect(8000 - volume(b)).toBeCloseTo(2 * one - lens * 10, 3);
    const lin = (seed: string, spacing: number): Feature => ({ id: 'P', name: 'P', type: 'linearPattern', seeds: [seed], dir1: { ref: { kind: 'base', axis: 'x' }, spacing, count: 3, flip: false }, dir2: null });
    res = await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10), lin('E1', 5)]));
    expect(volume(b)).toBeCloseTo(2000, 3);
    expect(isValid((b as unknown as { current: { body: Sh } }).current.body)).toBe(true);
    // Eight slots round a centre overlap there: a valid body with the union cut.
    const circ: Feature = { id: 'P', name: 'P', type: 'circularPattern', seeds: ['E3'], axis: { kind: 'base', axis: 'z' }, count: 8, angle: 360, equal: true, flip: false };
    res = await b.build(req([sketch('S1', rect(-50, -50, 50, 50)), extrude('E1', 'S1', 10), sketch('S3', rect(-5, 0, 5, 30)), extrude('E3', 'S3', 5, { cut: true, flip: true }), circ]));
    expect(res.status[4]).toEqual({ id: 'P', ok: true });
    expect(isValid((b as unknown as { current: { body: Sh } }).current.body)).toBe(true);
    // Each slot overlaps the others over 5 / tan(22.5°) of its 5 mm half-width at the centre.
    expect(100000 - volume(b)).toBeCloseTo((8 * 10 * 30 - 8 * 5 * 5 / Math.tan(Math.PI / 8)) * 5, 3);
  });

  it('suppresses the features built on a suppressed feature instead of failing them', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(0, 0, 50, 10)), extrude('E1', 'S1', 5)];
    const r0 = await b.build(req(base));
    const top = r0.faces.find((f) => f.name === 'E1:cap1')!;
    const feats: Feature[] = [
      ...base,
      sketch('S2', circle(5, 5, 2), { kind: 'face', face: { name: top.name, sig: { type: 'plane', c: top.center, n: top.normal, area: top.area } } }),
      extrude('E2', 'S2', 5, { cut: true, end: 'throughAll' }),
      { id: 'P1', name: 'P1', type: 'linearPattern', seeds: ['E2'], dir1: { ref: { kind: 'base', axis: 'x' }, spacing: 10, count: 2, flip: false }, dir2: null },
      sketch('S3', rect(0, 20, 10, 30)),
      extrude('E3', 'S3', 5),
    ];
    const all = await b.build(req(feats));
    expect(all.status.every((s) => s.ok && !s.suppressed)).toBe(true);
    // Suppressing the face sketch takes the cut and its pattern with it.
    const offS2 = structuredClone(feats);
    offS2[2].suppressed = true;
    let r = await b.build(req(offS2));
    expect(r.status.map((s) => !!s.suppressed)).toEqual([false, false, true, true, true, false, false]);
    expect(r.status.every((s) => s.ok)).toBe(true);
    expect(volume(b)).toBeCloseTo(50 * 10 * 5 + 10 * 10 * 5, 3);
    // Suppressing the base suppresses everything built on its faces.
    const offE1 = structuredClone(feats);
    offE1[1].suppressed = true;
    r = await b.build(req(offE1));
    expect(r.status.map((s) => !!s.suppressed)).toEqual([false, true, true, true, true, false, false]);
    expect(r.status.every((s) => s.ok)).toBe(true);
    expect(volume(b)).toBeCloseTo(10 * 10 * 5, 3);
    // Unsuppressing brings the children back.
    r = await b.build(req(feats));
    expect(r.status.every((s) => s.ok && !s.suppressed)).toBe(true);
    expect(volume(b)).toBeCloseTo(50 * 10 * 5 - 2 * Math.PI * 4 * 5 + 10 * 10 * 5, 1);
  });

  it('names the faces of pattern copies after their copy even where they lie level with the seed', async () => {
    // The copies' top faces took the seed's name: a fillet round one went to
    // another copy when the spacing changed, and stayed on when the pattern
    // was suppressed.
    const b = new ModelBuilder();
    const top = { kind: 'face' as const, face: { name: 'E1:cap1', sig: { type: 'plane', c: [50, 10, 5] as Vec3, n: [0, 0, 1] as Vec3, area: 2000 } } };
    const base: Feature[] = [sketch('S1', rect(0, 0, 100, 20)), extrude('E1', 'S1', 5), sketch('S2', rect(2, 2, 12, 12), top), extrude('E2', 'S2', 5)];
    const lin = (spacing: number, suppressed = false): Feature => ({ id: 'P', name: 'P', type: 'linearPattern', seeds: ['E2'], dir1: { ref: { kind: 'base', axis: 'x' }, spacing, count: 4, flip: false }, dir2: null, suppressed });
    let r = await b.build(req([...base, lin(20)]));
    const tops = r.faces.filter((f) => f.type === 'plane' && Math.abs(f.center[2] - 10) < 1e-6).map((f) => f.name).sort();
    expect(tops).toEqual(['E2:cap1', 'E2:cap1@P.1', 'E2:cap1@P.2', 'E2:cap1@P.3']);
    const copy = r.faces.find((f) => f.name === 'E2:cap1@P.2')!;
    const round = (name: string): FilletFeature => ({ id: 'F', name: 'F', type: 'fillet', edges: [], radius: 1, faces: [{ name, sig: { type: 'plane', c: copy.center, n: copy.normal, area: copy.area } }] });
    const filleted = () => r.faces.filter((f) => f.name.startsWith('F:')).map((f) => f.center[0]);
    // Spacing 20 to 30: the fillet stays on the second copy, now 20 mm further on.
    r = await b.build(req([...base, lin(30), round(copy.name)]));
    expect(r.status.every((s) => s.ok)).toBe(true);
    for (const x of filleted()) expect(Math.abs(x - 67)).toBeLessThan(6);
    // Suppressing the pattern suppresses what was built on its copy.
    r = await b.build(req([...base, lin(20, true), round(copy.name)]));
    expect(r.status.slice(4)).toEqual([{ id: 'P', ok: true, suppressed: true }, { id: 'F', ok: true, suppressed: true }]);
    // A reference saved under the old naming (the seed's name, the copy's place) still finds the copy.
    r = await b.build(req([...base, lin(20), round('E2:cap1')]));
    expect(r.status.every((s) => s.ok)).toBe(true);
    expect(filleted().length).toBeGreaterThan(0);
    for (const x of filleted()) expect(Math.abs(x - 47)).toBeLessThan(6);
  });

  it('keeps a sketch on a face from turning when an upstream edit tilts the face', async () => {
    // A draft of 8 degrees on the +X face kept the sketch's x axis along -Z;
    // 9 degrees crossed the threshold of the axis choice and turned it to -Y.
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(0, 0, 40, 20)), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const side = r0.faces.find((f) => f.normal && f.normal[0] > 0.9)!;
    const draft = (angle: number): Feature => ({ id: 'D', name: 'D', type: 'draft', faces: [{ name: side.name, sig: { type: 'plane', c: side.center, n: side.normal, area: side.area } }], neutral: { kind: 'base', plane: 'top' }, angle, flip: false });
    const r8 = await b.build(req([...base, draft(8)]));
    const face = r8.faces.find((f) => f.name === `D:d:${side.name}`)!;
    const onFace = (x?: Vec3) => sketch('S2', circle(5, 3, 1), { kind: 'face', face: { name: face.name, sig: { type: 'plane', c: face.center, n: face.normal, area: face.area } }, ...(x ? { x } : {}) });
    const xAxis = async (angle: number, x?: Vec3) => (await b.build(req([...base, draft(angle), onFace(x)]))).frames.S2.x;
    // Picked at 8 degrees, the face keeps the direction its frame was made from.
    const kept: Vec3 = [0, 0, -1];
    expect(r8.faces.find((f) => f.name === face.name)!.frame!.x[2]).toBeCloseTo(-1, 2);
    for (const angle of [8, 9, 12]) expect((await xAxis(angle, kept))[2]).toBeLessThan(-0.95);
    // Without it (parts saved before), the axis is chosen again as it always was.
    expect((await xAxis(8))[2]).toBeLessThan(-0.95);
    expect((await xAxis(9))[1]).toBeLessThan(-0.95);
  });

  it('mirrors and patterns a pattern of a boss and a cut as a boss and a cut', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [
      sketch('S1', rect(-50, -50, 50, 50)), extrude('E1', 'S1', 10),
      sketch('S2', circle(-40, -40, 3)), extrude('E2', 'S2', 5, { flip: true }),
      sketch('S3', circle(-40, 40, 3)), extrude('E3', 'S3', 10, { cut: true, flip: true }),
      { id: 'P1', name: 'P1', type: 'linearPattern', seeds: ['E2', 'E3'], dir1: { ref: { kind: 'base', axis: 'x' }, spacing: 20, count: 2, flip: false }, dir2: null },
    ];
    await b.build(req(base));
    const v1 = volume(b);
    const boss = Math.PI * 9 * 5, hole = Math.PI * 9 * 10;
    // The mirrored copy of the cut instance cuts too (it used to be added as material).
    const mirror: Feature = { id: 'M1', name: 'M1', type: 'mirror', seeds: ['P1'], plane: { kind: 'base', plane: 'right' } };
    let r = await b.build(req([...base, mirror]));
    expect(r.status[7].ok).toBe(true);
    expect(volume(b) - v1).toBeCloseTo(boss - hole, 3);
    // Two copies of both, all on the plate.
    const pattern: Feature = { id: 'P2', name: 'P2', type: 'circularPattern', seeds: ['P1'], axis: { kind: 'base', axis: 'z' }, angle: 360, count: 2, equal: true, flip: false };
    r = await b.build(req([...base, pattern]));
    expect(r.status[7].ok).toBe(true);
    expect(volume(b) - v1).toBeCloseTo(boss - hole, 3);
  });

  it('says why a pattern seed has nothing to copy', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-20, -20, 20, 20)), extrude('E1', 'S1', 10), sketch('S2', circle(10, 0, 2))];
    const pattern = (seed: string): Feature => ({ id: 'P', name: 'P', type: 'linearPattern', seeds: [seed], dir1: { ref: { kind: 'base', axis: 'y' }, spacing: 5, count: 2, flip: false }, dir2: null });
    const error = async (feats: Feature[]) => (await b.build(req(feats))).status.find((s) => s.id === 'P')!.error;
    // A seed whose own build failed (a zero depth here).
    expect(await error([...base, extrude('E2', 'S2', 0, { cut: true, flip: true }), pattern('E2')])).toMatch(/failed to build/);
    expect(await error([...base, pattern('E2'), extrude('E2', 'S2', 5, { cut: true, flip: true })])).toMatch(/comes after/);
    expect(await error([...base, pattern('gone')])).toMatch(/no longer exists/);
    expect(await error([...base, pattern('S2')])).toMatch(/cannot be patterned/);
    expect(await error([...base, extrude('E2', 'S2', 5, { cut: true, flip: true }), pattern('E2')])).toBeUndefined();
  });

  it('names the sketch, plane or feature whose face a feature is missing', async () => {
    const b = new ModelBuilder();
    const named = (f: Feature, name: string) => ({ ...f, name });
    const status = async (feats: Feature[], id: string) => (await b.build(req(feats))).status.find((s) => s.id === id)!.error;
    const open = named(sketch('S1', [{ id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 5, y: 0 }, { id: 'l', t: 'line', a: 'a', b: 'b' }]), 'Sketch1');
    const plane = named({ id: 'P1', name: '', type: 'plane', ref: { kind: 'feature', id: 'gone' }, offset: 5, flip: false }, 'Plane1');
    // A sketch that failed (on a plane that failed), and one after the feature.
    expect(await status([plane, named(sketch('S1', rect(0, 0, 5, 5), { kind: 'feature', id: 'P1' }), 'Sketch1'), extrude('E1', 'S1', 5)], 'E1'))
      .toBe('The profile sketch (Sketch1) failed to build');
    // Renaming changes no geometry (the steps stay cached), but the message follows the name.
    expect(await status([plane, named(sketch('S1', rect(0, 0, 5, 5), { kind: 'feature', id: 'P1' }), 'Profile'), extrude('E1', 'S1', 5)], 'E1'))
      .toBe('The profile sketch (Profile) failed to build');
    expect(await status([plane], 'P1')).toBe('The reference plane no longer exists');
    expect(await status([extrude('E1', 'S1', 5), open], 'E1')).toBe('The profile sketch (Sketch1) comes after this feature in the tree');
    // Deleting that sketch changes nothing before the extrude, but its message must follow.
    expect(await status([extrude('E1', 'S1', 5)], 'E1')).toBe('The profile sketch no longer exists');
    const lin: Feature = { id: 'LP', name: 'LP', type: 'linearPattern', seeds: ['E3'], dir1: { ref: { kind: 'base', axis: 'x' }, spacing: 5, count: 3, flip: false }, dir2: null };
    const seed: Feature[] = [named(sketch('S1', rect(0, 0, 5, 5)), 'Sketch1'), named(extrude('E3', 'S1', 5), 'Boss')];
    expect(await status([lin, ...seed], 'LP')).toBe('The seed feature Boss comes after this feature in the tree');
    expect(await status([lin], 'LP')).toBe('A seed feature no longer exists');
    expect(await status([extrude('E1', '', 5)], 'E1')).toBe('Select the profile sketch');
    // A face reference says which feature made the face.
    const base: Feature[] = [named(sketch('S2', rect(0, 0, 10, 10)), 'Sketch2'), named(extrude('E2', 'S2', 10), 'Boss')];
    const gone: ShellFeature = { id: 'SH', name: 'SH', type: 'shell', thickness: 1, outward: false, faces: [{ name: 'E2:side:zz', sig: { type: 'cone', c: [99, 99, 99], area: 1 } }] };
    expect(await status([...base, gone], 'SH')).toBe('A referenced face (made by Boss) no longer exists. Edit the feature and select it again.');
    // A pattern copy that is gone was made by the pattern.
    const pattern: Feature = named({ id: 'LP', name: '', type: 'linearPattern', seeds: ['E2'], dir1: { ref: { kind: 'base', axis: 'x' }, spacing: 20, count: 2, flip: false }, dir2: null }, 'Row');
    const copy: ShellFeature = { ...gone, faces: [{ name: 'E2:side:zz@LP.5', sig: { type: 'cone', c: [99, 99, 99], area: 1 } }] };
    expect(await status([...base, pattern, copy], 'SH')).toBe('A referenced face (made by Row) no longer exists. Edit the feature and select it again.');
  });

  it('reports selected regions that a sketch edit moved away', async () => {
    const b = new ModelBuilder();
    const two = (bx: number) => sketch('S1', [...circle(0, 0, 5, 'ca'), ...circle(bx, 0, 5, 'cb')]);
    const both = extrude('E1', 'S1', 10, { contours: [[0, 0], [20, 0]] });
    const onlyB = extrude('E1', 'S1', 10, { contours: [[20, 0]] });
    expect((await b.build(req([two(20), both]))).status[1]).toEqual({ id: 'E1', ok: true });
    expect(volume(b)).toBeCloseTo(2 * Math.PI * 250, 0);
    // The second circle moved: the first region is still built, with a warning.
    let r = await b.build(req([two(50), both]));
    expect(r.status[1].ok).toBe(true);
    expect(r.status[1].warning).toMatch(/no longer in the sketch/);
    expect(volume(b)).toBeCloseTo(Math.PI * 250, 0);
    r = await b.build(req([two(50), onlyB]));
    expect(r.status[1].ok).toBe(false);
    expect(r.status[1].error).toMatch(/no longer in the sketch/);
  });

  it('reports a useful error for an open profile and keeps building later features', async () => {
    const b = new ModelBuilder();
    const open = [{ id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 10, y: 0 }, { id: 'l', t: 'line', a: 'a', b: 'b' }] as any[];
    const res = await b.build(req([sketch('S1', open), extrude('E1', 'S1', 5), sketch('S2', rect(0, 0, 5, 5)), extrude('E2', 'S2', 5)]));
    expect(res.status[1].ok).toBe(false);
    expect(res.status[1].error).toMatch(/open/i);
    expect(res.status[3].ok).toBe(true);
    expect(volume(b)).toBeCloseTo(125, 3);
    // Untrimmed contours lying over each other say so.
    const corner = await b.build(req([sketch('S1', [...rect(0, 0, 20, 20), ...rect(0, 0, 5, 5)]), extrude('E1', 'S1', 5)]));
    expect(corner.status[1].error).toMatch(/lie over each other. Trim them/);
  });

  it('reuses cached steps when only later features change', async () => {
    const b = new ModelBuilder();
    const feats: Feature[] = [sketch('S1', polygon([[0, 0], [40, 0], [40, 40], [0, 40]])), extrude('E1', 'S1', 40)];
    await b.build(req(feats));
    const r = await b.build(req([...feats, sketch('S2', circle(20, 20, 5), { kind: 'base', plane: 'front' }), extrude('E2', 'S2', 50, { cut: true, flip: true })]));
    expect(r.status.every((s) => s.ok)).toBe(true);
    expect(volume(b)).toBeCloseTo(40 ** 3 - Math.PI * 25 * 40, 1);
    // Renaming or hiding a feature changes no geometry: nothing is rebuilt.
    const renamed = structuredClone(feats);
    renamed[0].name = 'Base sketch';
    renamed[0].hidden = true;
    (renamed[0] as SketchFeature).frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };
    const r1 = await b.build(req(feats));
    const r2 = await b.build(req(renamed));
    expect(r2.mesh).toBe(r1.mesh);
    // The exact bounding box (slow for filleted bodies) is not computed again.
    expect(r2.bbox).toBe(r1.bbox);
    // Opening and closing a sketch builds up to before it, then past it: the
    // body is the same and is not meshed again.
    const withSketch = [...feats, sketch('S3', circle(5, 5, 1))];
    const open = await b.build({ ...req(withSketch), upTo: 2, preview: withSketch[2] });
    expect(open.mesh).toBe(r1.mesh);
    expect((await b.build(req(withSketch))).mesh).toBe(r1.mesh);
  });

  it('computes mass properties and exports STEP and STL', async () => {
    const b = new ModelBuilder();
    await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)]));
    const mp = b.massProperties()!;
    expect(mp.solid).toBe(true);
    expect(mp.center[0]).toBeCloseTo(5, 6);
    expect(mp.center[2]).toBeCloseTo(5, 6);
    expect(mp.area).toBeCloseTo(600, 4);
    // Cube inertia per unit density about its centre: V * a^2 / 6
    expect(mp.inertia[0]).toBeCloseTo((1000 * 100) / 6, 2);
    expect(mp.principal.moments[0]).toBeCloseTo((1000 * 100) / 6, 2);
    const step = new TextDecoder().decode(b.exportStep());
    expect(step).toContain('ISO-10303-21');
    const stl = b.exportStl(1);
    expect(new DataView(stl.buffer).getUint32(80, true)).toBe(12);
  });

  it('reports draft angles of 90 degrees or more by name', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-10, -10, 10, 10, 'r')), extrude('E1', 'S1', 10)];
    const f = (await b.build(req(base))).faces.find((x) => x.name === 'E1:side:rl1')!;
    const draft = (angle: number): Feature => ({
      id: 'D1', name: 'D1', type: 'draft', neutral: { kind: 'base', plane: 'front' }, angle, flip: false,
      faces: [{ name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } }],
    });
    for (const angle of [95, -90]) expect((await b.build(req([...base, draft(angle)]))).status[2].error).toMatch(/between -90 and 90 degrees/);
    expect((await b.build(req([...base, draft(-5)]))).status[2].ok).toBe(true);
    // A draft of 0 degrees changes nothing: said, as for other features that change nothing.
    expect((await b.build(req([...base, draft(0)]))).status[2]).toEqual({ id: 'D1', ok: true, warning: 'A draft angle of 0 degrees changes nothing. Enter an angle.' });
    expect(volume(b)).toBeCloseTo(4000, 6);
    // A value that is not a number (a damaged file) is named.
    expect((await b.build(req([...base, { ...draft(5), angle: 'x' } as Feature]))).status[2].error).toBe('Draft angle has an invalid value');
  });

  it('says a body of surfaces only has no mass instead of a centre at the origin', async () => {
    const face = subShapes(R.makeBox([0, 0, 0], [10, 10, 10]) as unknown as Sh, 'face')[0];
    const b = new ModelBuilder();
    const res = await b.build(req([{ id: 'I1', name: 'I1', type: 'import', format: 'brep', blob: 'f', fileName: 'f.brep' }], { blobs: { f: getOc().BRepToolsWrapper.Write(face.wrapped) } }));
    expect(res.status[0].ok).toBe(true);
    const mp = b.massProperties()!;
    expect(mp.solid).toBe(false);
    expect(mp.area).toBeCloseTo(100, 6);
  });

  it('frees the points and directions it hands to OpenCascade', async () => {
    const b = new ModelBuilder();
    const base: Feature[] = [sketch('S1', rect(-10, -10, 10, 10, 'r')), extrude('E1', 'S1', 10)];
    const r0 = await b.build(req(base));
    const f = r0.faces.find((x) => x.name === 'E1:side:rl1')!;
    const draft: Feature = {
      id: 'D1', name: 'D1', type: 'draft', neutral: { kind: 'base', plane: 'front' }, angle: 5, flip: false,
      faces: [{ name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } }],
    };
    const box = R.makeBox([0, 0, 0], [1, 1, 1]) as unknown as Sh;
    // The bindings never free value objects on their own: count the ones left.
    const oc = getOc();
    const made: { isDeleted(): boolean }[] = [];
    const types = { gp_Pnt: oc.gp_Pnt, gp_Dir: oc.gp_Dir };
    for (const [k, T] of Object.entries(types)) {
      oc[k] = new Proxy(T, { construct: (t, args) => { const o = new t(...args); made.push(o); return o; } });
    }
    try {
      expect((await b.build(req([...base, draft]))).status[2].ok).toBe(true);
      b.massProperties();
      rotated(box, [0, 0, 0], [0, 0, 1], 1);
      mirrored(box, [0, 0, 0], [1, 0, 0]);
    } finally {
      Object.assign(oc, types);
    }
    expect(made.length).toBeGreaterThan(0);
    expect(made.filter((o) => !o.isDeleted())).toHaveLength(0);
  });

  it('frees the surfaces it looks up to name trimmed spline faces', async () => {
    const b = new ModelBuilder();
    const loft: Feature[] = [
      sketch('A', rect(-10, -10, 10, 10)),
      { id: 'P1', name: 'P1', type: 'plane', ref: { kind: 'base', plane: 'front' }, offset: 20, flip: false },
      sketch('B', circle(0, 0, 5), { kind: 'feature', id: 'P1' }),
      { id: 'L', name: 'L', type: 'loft', profiles: ['A', 'B'], cut: false, ruled: false },
      sketch('S9', circle(0, -8, 2), { kind: 'base', plane: 'top' }),
      extrude('E9', 'S9', 50, { cut: true, end: 'throughAll', dir2: { end: 'throughAll', depth: 0 } }),
    ];
    // A surface handle keeps its surface alive: count the ones left.
    const tool = getOc().BRep_Tool;
    const surface = tool.Surface;
    const made: { isDeleted(): boolean }[] = [];
    // The bindings look up their overloads on the function they find there: give it them.
    tool.Surface = Object.assign((...args: unknown[]) => { const s = surface.apply(tool, args); made.push(s); return s; }, surface);
    try {
      const res = await b.build(req(loft));
      expect(res.status.every((s) => s.ok)).toBe(true);
      // The trimmed loft faces keep their names (the surfaces were compared).
      expect(res.faces.filter((f) => f.type === 'bspline').map((f) => f.name).sort()).toEqual(['L:l0', 'L:l1', 'L:l2', 'L:l3', 'L:l4']);
    } finally {
      tool.Surface = surface;
    }
    expect(made.length).toBeGreaterThan(0);
    expect(made.filter((s) => !s.isDeleted())).toHaveLength(0);
  });

  it('measures the minimum distance between faces, edges and points', async () => {
    const b = new ModelBuilder();
    await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)]));
    const caps = b.faceNames().flatMap((n, i) => (n.startsWith('E1:cap') ? [i] : []));
    const r = b.measure({ kind: 'face', index: caps[0] }, { kind: 'face', index: caps[1] });
    expect(r.distance).toBeCloseTo(10, 6);
    const p = b.measure({ kind: 'vertex', p: [5, 5, 30] }, { kind: 'edge', index: 0 });
    expect(p.distance).toBeGreaterThan(0);
    expect(b.measure({ kind: 'vertex', p: [20, 5, 5] }, { kind: 'vertex', p: [20, 5, 8] }).distance).toBeCloseTo(3, 9);
  });

  it('reads an imported STEP file once for the import check and the build', async () => {
    const b = new ModelBuilder();
    await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)]));
    const step = new TextDecoder().decode(b.exportStep());
    expect(await checkStep('not a STEP file')).toMatch(/could not be read/);
    const oc = getOc();
    const Reader = oc.STEPControl_Reader;
    let reads = 0;
    oc.STEPControl_Reader = function (...args: unknown[]) { reads++; return new Reader(...args); };
    try {
      expect(await checkStep(step)).toBeNull();
      const imp = new ModelBuilder();
      const res = await imp.build(req([{ id: 'I1', name: 'I1', type: 'import', format: 'step', blob: 'b1', fileName: 'a.step' }], { blobs: { b1: step } }));
      expect(res.status[0].ok).toBe(true);
      expect(volume(imp)).toBeCloseTo(1000, 3);
      // Opening another part lets go of the imported shape.
      const cache = (imp as unknown as { importCache: Map<string, unknown> }).importCache;
      expect(cache.size).toBe(1);
      await imp.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)]));
      expect(cache.size).toBe(0);
    } finally {
      oc.STEPControl_Reader = Reader;
    }
    expect(reads).toBe(1);
  });

  it('invalidates imported geometry when file data changes under the same key', async () => {
    const source = new ModelBuilder();
    await source.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)]));
    const first = new TextDecoder().decode(source.exportStep());
    await source.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 20)]));
    const second = new TextDecoder().decode(source.exportStep());
    const imported = new ModelBuilder();
    const features: Feature[] = [{ id: 'I1', name: 'Import1', type: 'import', format: 'step', blob: 'b1', fileName: 'body.step' }];
    await imported.build(req(features, { blobs: { b1: first } }));
    expect(volume(imported)).toBeCloseTo(1000, 5);
    const changed = await imported.build(req(features, { blobs: { b1: second } }));
    expect(volume(imported)).toBeCloseTo(2000, 5);
    const unchanged = await imported.build(req(features, { blobs: { b1: second } }));
    expect(unchanged.mesh).toBe(changed.mesh);
    const missing = await imported.build(req(features));
    expect(missing.status[0]).toMatchObject({ ok: false, error: 'The imported file data is missing' });
    expect(missing.mesh).toBeNull();
    const restored = await imported.build(req(features, { blobs: { b1: first } }));
    expect(restored.status[0].ok).toBe(true);
    expect(volume(imported)).toBeCloseTo(1000, 5);
  });

  it('projects drawing views with visible and hidden lines', async () => {
    const b = new ModelBuilder();
    // 40 x 20 plate, 10 thick, with a hole through it.
    await b.build(req([sketch('S1', [...rect(0, 0, 40, 20), ...circle(20, 10, 4)]), extrude('E1', 'S1', 10)]));
    const [front, top] = b.project([
      { id: 'front', dir: [0, 0, 1], x: [1, 0, 0] },
      { id: 'top', dir: [0, 1, 0], x: [1, 0, 0] },
    ]);
    expect(front.bounds![2] - front.bounds![0]).toBeCloseTo(40, 3);
    expect(front.bounds![3] - front.bounds![1]).toBeCloseTo(20, 3);
    expect(front.visible.length).toBeGreaterThan(0);
    // From the top the hole is hidden: two hidden lines.
    expect(top.bounds![3] - top.bounds![1]).toBeCloseTo(10, 3);
    expect(top.hidden.length).toBeGreaterThan(0);
  });

  it('fails a feature whose value could not be evaluated instead of building it with zero', async () => {
    const b = new ModelBuilder();
    const feats: Feature[] = [
      sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10),
      { id: 'P1', name: 'P1', type: 'plane', ref: { kind: 'base', plane: 'front' }, offset: 0, flip: false },
      sketch('S2', rect(2, 2, 4, 4), { kind: 'feature', id: 'P1' }), extrude('E2', 'S2', 3, { flip: true }),
    ];
    // The plane's offset expression failed (its value stands at 0): the plane
    // fails and the boss on it is not built at the wrong height.
    const res = await b.build(req(feats, { invalid: { P1: 'Offset: Unknown name "Gap"' } }));
    expect(res.status[2]).toEqual({ id: 'P1', ok: false, error: 'Offset: Unknown name "Gap"' });
    expect(res.status[4].ok).toBe(false);
    expect(volume(b)).toBeCloseTo(1000, 6);
    // Fixed again (an offset of 20), both build.
    const fixed = await b.build(req(feats.map((f) => (f.id === 'P1' ? { ...f, offset: 20 } : f))));
    expect(fixed.status.every((s) => s.ok)).toBe(true);
    expect(volume(b)).toBeCloseTo(1012, 6);
  });

  it('honours the rollback position', async () => {
    const b = new ModelBuilder();
    const feats: Feature[] = [sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10), sketch('S2', rect(0, 0, 5, 5)), extrude('E2', 'S2', 20)];
    await b.build({ ...req(feats), upTo: 2 });
    expect(volume(b)).toBeCloseTo(1000, 4);
  });

  it('shows the frames of rolled-back planes of this part, not of a part opened before', async () => {
    // The steps beyond the rollback bar were trusted whatever part built them.
    const b = new ModelBuilder();
    const plane = (offset: number): Feature => ({ id: 'P1', name: 'P1', type: 'plane', ref: { kind: 'base', plane: 'front' }, offset, flip: false });
    const head: Feature[] = [sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)];
    const s2 = sketch('S2', rect(0, 0, 5, 5), { kind: 'feature', id: 'P1' });
    const part = (offset: number): Feature[] => [...head, plane(offset), s2];
    await b.build(req(part(10)));
    // Rolled back to before the plane, the same part shows where its plane was built.
    expect((await b.build({ ...req(part(10)), upTo: 2 })).frames.P1.o[2]).toBeCloseTo(10, 9);
    // Another part whose plane sits elsewhere does not show the first part's.
    expect((await b.build({ ...req(part(30)), upTo: 2 })).frames.P1).toBeUndefined();
  });
});

describe('kernel failures', () => {
  it('does not record an aborted kernel as a feature error', async () => {
    const b = new ModelBuilder();
    // A WebAssembly trap or abort leaves the module unusable: the build must
    // fail as a whole (so the worker is replaced), not carry on.
    (b as unknown as { apply: () => never }).apply = () => { throw new WebAssembly.RuntimeError('Aborted(OOM)'); };
    await expect(b.build(req([sketch('S1', rect(0, 0, 30, 20))]))).rejects.toThrow('Aborted(OOM)');
    expect(isFatal(new WebAssembly.RuntimeError('unreachable'))).toBe(true);
    expect(isFatal(new Error('Fillet failed'))).toBe(false);
    expect(isFatal(42)).toBe(false);
  });
});
