// SolidWorks part import: the Parasolid solid inside .sldprt files is
// converted to STEP and read back by the real kernel. The fixtures are
// controlled parts from the sldprt-format-research corpus (MIT); the expected
// volumes are those of SolidWorks' own STEP export of the same parts.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { SolidWorksError, solidWorksToStep } from '../src/formats/sldprt';
import { readStreams } from '../src/formats/sldprt/container';
import { Graph, GeomError, nurbsCurve } from '../src/formats/sldprt/geom';
import { type XtNode, XtError, parseTransmit } from '../src/formats/sldprt/xt';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import { req } from './helpers';

beforeAll(async () => {
  setOc(await init());
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/sldprt/${name}`, import.meta.url)));

async function importStep(step: string) {
  const b = new ModelBuilder();
  const res = await b.build(req([{ id: 'i', name: 'i', type: 'import', format: 'step', blob: 'b', fileName: '' }], { blobs: { b: step } }));
  expect(res.status[0]).toMatchObject({ ok: true });
  return { volume: b.massProperties()!.volume, faces: res.faces.length };
}

describe('SolidWorks parts', () => {
  it.each([
    // file, container, faces, volume (mm^3)
    ['cube-hole-sw2022.sldprt', 'modern', 7, 1000 - Math.PI * 2.5 * 2.5 * 10],
    ['cube-shell-sw2011.sldprt', 'ole2', 11, 424],
    ['cylinders-crossed-sw2022.sldprt', 'modern', 8, 2474.926],
    ['loft-spline-sw2022.sldprt', 'modern', 6, 739.805],
  ] as const)('opens %s', async (name, container, faces, volume) => {
    const data = fixture(name);
    expect((await readStreams(data)).kind).toBe(container);
    const r = await solidWorksToStep(data, name);
    expect(r).toMatchObject({ solids: 1, sheets: 0, faces, skipped: 0 });
    expect(r.step).toMatch(/^ISO-10303-21;/);
    const got = await importStep(r.step);
    expect(got.faces).toBe(faces);
    expect(got.volume).toBeCloseTo(volume, 2);
  });

  it('keeps exact geometry where STEP has the type', async () => {
    const hole = (await solidWorksToStep(fixture('cube-hole-sw2022.sldprt'), 'hole.sldprt')).step;
    expect(hole).toContain('CIRCLE(');
    expect(hole).not.toContain('B_SPLINE');
    // Parasolid metres become millimetres: the hole is 2.5 mm in radius.
    expect(Number(/CYLINDRICAL_SURFACE\('',#\d+,([\d.E-]+)\)/.exec(hole)![1])).toBeCloseTo(2.5, 9);
    // Crossed cylinders meet along exact ellipses.
    const crossed = (await solidWorksToStep(fixture('cylinders-crossed-sw2022.sldprt'), 'x.sldprt')).step;
    expect(crossed.match(/ELLIPSE\('',#\d+,7\.07106781186547\d*,5\.\)/g)).toHaveLength(4);
  });

  it('explains what it cannot open', async () => {
    const part = fixture('cube-hole-sw2022.sldprt');
    await expect(solidWorksToStep(part, 'a.SLDASM')).rejects.toThrow(/assemblies/);
    await expect(solidWorksToStep(part, 'a.slddrw')).rejects.toThrow(/drawings/);
    await expect(solidWorksToStep(new TextEncoder().encode('not a part file at all, just text'.repeat(40)), 'a.sldprt')).rejects.toBeInstanceOf(SolidWorksError);
    // A part whose streams were cut short has no readable solid.
    await expect(solidWorksToStep(part.slice(0, 4000), 'a.sldprt')).rejects.toBeInstanceOf(SolidWorksError);
  });

  it('does not allocate what a damaged file only claims', async () => {
    // Every stream of an OLE2 part claims to be 256 MB long; the chains are short.
    const d = fixture('cube-shell-sw2011.sldprt');
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const ss = 1 << dv.getUint16(30, true);
    const fat = (dv.getUint32(76, true) + 1) * ss;
    let patched = 0;
    for (let sec = dv.getUint32(48, true), guard = 0; sec < 0xfffffff0 && guard < 100; sec = dv.getUint32(fat + sec * 4, true), guard++) {
      for (let o = (sec + 1) * ss; o < (sec + 2) * ss; o += 128) if (d[o + 66] === 2) { dv.setUint32(o + 120, 0x0fffffff, true); patched++; }
    }
    expect(patched).toBeGreaterThan(10);
    const { streams } = await readStreams(d);
    const total = [...streams.values()].reduce((a, s) => a + s.length, 0);
    expect(total).toBeLessThan(4 * d.length);
  });

  it('checks knot multiplicities before expanding them', () => {
    // A damaged file's multiplicities can ask for billions of knots; this curve needs 6.
    const node = (id: number, name: string, f: XtNode['f']): [number, XtNode] => [id, { type: 0, name, id, f }];
    const nodes = new Map<number, XtNode>([
      node(1, 'BSPLINE_CURVE', { nurbs: 2 }),
      node(2, 'NURBS_CURVE', { degree: 2, n_vertices: 3, vertex_dim: 3, bspline_vertices: 3, knots: 4, knot_mult: 5, rational: false }),
      node(3, 'BSPLINE_VERTICES', { vertices: [0, 0, 0, 1, 0, 0, 2, 1, 0] }),
      node(4, 'KNOT_SET', { knots: Array.from({ length: 100 }, (_, i) => i) }),
      node(5, 'KNOT_MULT', { mult: new Array(100).fill(32767) }),
    ]);
    expect(() => nurbsCurve(new Graph(nodes), nodes.get(1)!)).toThrow(new GeomError('Bad B-spline knot count'));
    nodes.set(4, { type: 0, name: 'KNOT_SET', id: 4, f: { knots: [0, 1] } });
    nodes.set(5, { type: 0, name: 'KNOT_MULT', id: 5, f: { mult: [3, 3] } });
    expect(nurbsCurve(new Graph(nodes), nodes.get(1)!).knots).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('stops at a negative length instead of reading the same records again', () => {
    const b: number[] = [];
    const str = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const i16 = (v: number) => b.push((v >> 8) & 0xff, v & 0xff);
    const i32 = (v: number) => b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    b.push(...str('PS'), 0, 0, 0, 1, ...str('v'), 0, 0, 0, 9, ...str('SCH_13006'));
    i16(9000); i16(0); b.push(0, 0);
    // A type of its own with one variable-length text field, then a node of it
    // whose length steps back to the start of its own record.
    i16(8000); b.push(1, 1, ...str('X'), 1, ...str('x'), 1, ...str('s')); i16(0); i16(2); b.push(1, ...str('c'), 1);
    i32(0); i16(5);
    i16(8000); i32(-8); i16(6);
    i16(1);
    expect(() => parseTransmit(new Uint8Array(b))).toThrow(XtError);
  });
});
