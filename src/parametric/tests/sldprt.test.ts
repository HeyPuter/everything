// SolidWorks part import: the Parasolid solid inside .sldprt files is
// converted to STEP and read back by the real kernel. The fixtures are
// controlled parts from the sldprt-format-research corpus (MIT); the expected
// volumes are those of SolidWorks' own STEP export of the same parts.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { SolidWorksError, solidWorksToStep } from '../src/formats/sldprt';
import { readStreams } from '../src/formats/sldprt/container';
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
});
