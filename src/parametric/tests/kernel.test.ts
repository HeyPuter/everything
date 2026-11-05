// Runs the real OpenCascade kernel in Node: slower than unit tests but it
// is the only way to know the modeling features actually produce solids.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder, checkStep, errorText, isFatal } from '../src/kernel/build';
import { getOc, setOc } from '../src/kernel/occ';
import type { Feature, FilletFeature, ShellFeature, SkDimension, SketchFeature } from '../src/model/types';
import { flangeExample } from '../src/app/examples';
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

  it('extrudes nested profiles with holes (even-odd)', async () => {
    const b = new ModelBuilder();
    const ents = [...rect(-20, -20, 20, 20), ...circle(0, 0, 10), ...circle(0, 0, 5)];
    await b.build(req([sketch('S1', ents), extrude('E1', 'S1', 2)]));
    const expected = (40 * 40 - Math.PI * 100 + Math.PI * 25) * 2;
    expect(volume(b)).toBeCloseTo(expected, 1);
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
    const d2 = await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10, { dir2: { end: 'blind', depth: 0 } })]));
    expect(d2.status[1].ok).toBe(false);
    expect(d2.status[1].error).toMatch(/Direction 2/);
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

  it('cuts counterbored holes and rejects a hole shallower than its counterbore', async () => {
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
    for (const p of [circ(360, true), circ(90, false), lin(-10)]) expect((await b.build(req([...base, p]))).status[4]).toEqual({ id: 'P', ok: true });
    // Copies of a cut that all land off the part do nothing: say so.
    const off = await b.build(req([...base, lin(100)]));
    expect(off.status[4].ok).toBe(true);
    expect(off.status[4].warning).toMatch(/do not remove any material/);
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
  });

  it('computes mass properties and exports STEP and STL', async () => {
    const b = new ModelBuilder();
    await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)]));
    const mp = b.massProperties()!;
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

  it('honours the rollback position', async () => {
    const b = new ModelBuilder();
    const feats: Feature[] = [sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10), sketch('S2', rect(0, 0, 5, 5)), extrude('E2', 'S2', 20)];
    await b.build({ ...req(feats), upTo: 2 });
    expect(volume(b)).toBeCloseTo(1000, 4);
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
