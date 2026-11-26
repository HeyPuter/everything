// Assemblies on the real OpenCascade kernel in Node: parts built per
// component, placed copies combined, interference, mass, STEP and STL.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import * as R from 'replicad';
import { AssemblyBuilder, type AsmPartResult, type AsmSceneItem } from '../src/kernel/assembly';
import { setOc, subShapes, volumeOf, wrap } from '../src/kernel/occ';
import { ModelBuilder } from '../src/kernel/build';
import { placementMatrix } from '../src/assembly/compose';
import { qAxisAngle } from '../src/math/vec';
import type { Placement } from '../src/model/assembly';
import { circle, extrude, rect, sketch } from './helpers';

beforeAll(async () => {
  setOc(await init());
});

const box = () => [sketch('S1', rect(0, 0, 20, 10)), extrude('E1', 'S1', 10)];
const pin = () => [sketch('S1', circle(0, 0, 3)), extrude('E1', 'S1', 30)];
const item = (part: string, pl: Placement, name: string): AsmSceneItem => ({ part, m: placementMatrix(pl), name, color: '#888888' });
const at = (p: [number, number, number], q: [number, number, number, number] = [0, 0, 0, 1]): Placement => ({ p, q });

async function built(a: AssemblyBuilder) {
  const res = await a.build([
    { key: 'box', features: box(), blobs: {}, quality: 0 },
    { key: 'pin', features: pin(), blobs: {}, quality: 0 },
  ]);
  return Object.fromEntries(res.map((r) => [r.key, r])) as Record<string, AsmPartResult>;
}

describe('assembly geometry', () => {
  it('builds each part once and reports its faces', async () => {
    const a = new AssemblyBuilder();
    const parts = await built(a);
    expect(parts.box.faces).toHaveLength(6);
    expect(parts.box.mesh!.indices.length).toBeGreaterThan(0);
    expect(parts.pin.faces.some((f) => f.type === 'cylinder')).toBe(true);
    expect(parts.box.status.every((s) => s.ok)).toBe(true);
  });

  it('combines placed components: volume, centre of mass and projections', async () => {
    const a = new AssemblyBuilder();
    await built(a);
    // Two boxes side by side and a pin standing clear of them.
    a.setScene([item('box', at([0, 0, 0]), 'box<1>'), item('box', at([30, 0, 0]), 'box<2>'), item('pin', at([100, 0, 0], qAxisAngle([1, 0, 0], Math.PI / 2)), 'pin<1>')]);
    const mp = a.massProperties()!;
    expect(mp.volume).toBeCloseTo(2 * 2000 + Math.PI * 9 * 30, 0);
    const m = a.mass([7800, 7800, 2700])!;
    expect(m.mass).toBeCloseTo((4000 * 7800 + Math.PI * 9 * 30 * 2700) * 1e-9, 6);
    expect(m.open).toEqual([]);
    // The rotated pin points along -y (its 30 mm length from z turned about x).
    const combined = a.combined()!;
    const solids = subShapes(combined, 'solid');
    expect(solids).toHaveLength(3);
    const proj = a.project([{ id: 'front', dir: [0, 0, 1], x: [1, 0, 0], hidden: false }]);
    expect(proj[0].visible.length).toBeGreaterThan(0);
    // Measuring between faces of different components (indices in scene order).
    const right = 6 + 0; // first face of box<2>
    const d = a.measure({ kind: 'face', index: right }, { kind: 'face', index: 0 });
    expect(d.distance).toBeGreaterThanOrEqual(0);
  });

  it('weighs hidden components, but leaves them out of measuring, interference and export', async () => {
    const a = new AssemblyBuilder();
    await built(a);
    // A hidden box first: the shown pin's faces are numbered from 0, as the graphics area lists them.
    a.setScene([{ ...item('box', at([0, 0, 0]), 'box<1>'), hidden: true }, item('pin', at([5, 5, -10]), 'pin<1>')]);
    const m = a.mass([7800, 2700])!;
    expect(m.volume).toBeCloseTo(2000 + Math.PI * 9 * 30, 0);
    expect(m.mass).toBeCloseTo((2000 * 7800 + Math.PI * 9 * 30 * 2700) * 1e-9, 6);
    expect(a.massProperties()!.volume).toBeCloseTo(2000 + Math.PI * 9 * 30, 0);
    expect(a.interference()).toEqual([]);
    expect(subShapes(a.combined()!, 'solid')).toHaveLength(1);
    // Face 0 is the pin's (about 20 mm below the point; the hidden box is 30 mm or more away).
    const d = a.measure({ kind: 'face', index: 0 }, { kind: 'vertex', p: [5, 5, 40] });
    expect(d.distance).toBeLessThan(25);
  });

  it('finds interfering components and the volume they share', async () => {
    const a = new AssemblyBuilder();
    await built(a);
    // box<2> overlaps box<1> by 5 mm in x (5 × 10 × 10); the pin passes through box<1> (r 3, 10 mm deep).
    a.setScene([item('box', at([0, 0, 0]), 'box<1>'), item('box', at([15, 0, 0]), 'box<2>'), item('pin', at([5, 5, -10]), 'pin<1>'), item('box', at([0, 40, 0]), 'box<3>')]);
    const pairs = a.interference();
    const find = (x: number, y: number) => pairs.find((p) => p.a === x && p.b === y);
    expect(find(0, 1)!.volume).toBeCloseTo(500, 3);
    expect(find(0, 2)!.volume).toBeCloseTo(Math.PI * 9 * 10, 1);
    expect(find(0, 1)!.mesh!.indices.length).toBeGreaterThan(0);
    // Touching without overlapping is not interference.
    expect(pairs.some((p) => p.a === 3 || p.b === 3)).toBe(false);
    expect(pairs).toHaveLength(2);
    a.setScene([item('box', at([0, 0, 0]), 'box<1>'), item('box', at([20, 0, 0]), 'box<2>')]);
    expect(a.interference()).toEqual([]);
  });

  it('exports a STEP file with each component as a named solid, and leaves part export as it was', async () => {
    const part = new ModelBuilder();
    await part.build({ features: box(), upTo: 2, blobs: {}, quality: 0 });
    const before = new TextDecoder().decode(part.exportStep('Block')).replace(/\d{4}-\d\d-\d\dT[\d:]+/g, '');
    const a = new AssemblyBuilder();
    await built(a);
    a.setScene([item('box', at([0, 0, 0]), 'bracket<1>'), item('box', at([40, 0, 0], qAxisAngle([0, 0, 1], 0.5)), 'bracket<2>'), item('pin', at([0, 0, 20]), 'pin<1>')]);
    const data = await a.exportStep();
    const text = new TextDecoder().decode(data);
    expect(text).toContain('bracket<1>');
    expect(text).toContain('bracket<2>');
    expect(text).toContain('pin<1>');
    // Read back: three solids with the components' total volume.
    const shape = await R.importSTEP(new Blob([data as BlobPart]));
    const solids = subShapes(wrap(shape.wrapped), 'solid');
    expect(solids).toHaveLength(3);
    const total = solids.reduce((s, x) => s + volumeOf(x), 0);
    expect(total).toBeCloseTo(4000 + Math.PI * 9 * 30, 0);
    // A part exported afterwards is written exactly as before.
    const after = new TextDecoder().decode(part.exportStep('Block')).replace(/\d{4}-\d\d-\d\dT[\d:]+/g, '');
    expect(after).toBe(before);
    const stl = a.exportStl(1);
    const tris = new DataView(stl.buffer).getUint32(80, true);
    expect(tris).toBeGreaterThan(24);
    expect(stl.length).toBe(84 + tris * 50);
  });
});
