// Runs the real OpenCascade kernel in Node: slower than unit tests but it
// is the only way to know the modeling features actually produce solids.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder, errorText } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import type { Feature, FilletFeature, ShellFeature } from '../src/model/types';
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
    // A radius that consumes the whole box comes back as a zero-volume solid.
    const edges = r0.edges.map((e) => ({ name: e.name, sig: { type: e.type, m: e.mid, len: e.length } }));
    const fillet: FilletFeature = { id: 'F1', name: 'F1', type: 'fillet', edges, faces: [], radius: 9 };
    const r = await b.build(req([...base, fillet]));
    expect(r.status[2].ok).toBe(false);
    expect(volume(b)).toBeCloseTo(4000, 3);
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
