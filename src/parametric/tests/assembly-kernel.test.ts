// Assemblies on the real OpenCascade kernel in Node: parts built per
// component, placed copies combined, interference, mass, STEP and STL.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import * as R from 'replicad';
import { AssemblyBuilder, type AsmPartResult, type AsmSceneItem } from '../src/kernel/assembly';
import { bbox, setOc, subShapes, volumeOf, wrap } from '../src/kernel/occ';
import { ModelBuilder } from '../src/kernel/build';
import { placementMatrix } from '../src/assembly/compose';
import { qAxisAngle } from '../src/math/vec';
import type { Placement } from '../src/model/assembly';
import { circle, extrude, rect, sketch } from './helpers';
import { newSurfaceFeature } from '../src/model/surfaces';
import type { Feature } from '../src/model/types';

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

  it('checks only pairs in different groups, and leaves out meshes when asked (a motion study frame by frame)', async () => {
    const a = new AssemblyBuilder();
    await built(a);
    a.setScene([item('box', at([0, 0, 0]), 'box<1>'), item('box', at([15, 0, 0]), 'box<2>'), item('pin', at([5, 5, -10]), 'pin<1>')]);
    const pairs = a.interference({ mesh: false, groups: [0, 0, 1] });
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[0, 2]]);
    expect(pairs[0].volume).toBeCloseTo(Math.PI * 9 * 10, 1);
    expect(pairs[0].mesh).toBeNull();
  });

  it('reports a pair whose overlap cannot be computed as not checked, never as clear', async () => {
    const a = new AssemblyBuilder();
    await built(a);
    a.setScene([item('box', at([0, 0, 0]), 'box<1>'), item('box', at([15, 0, 0]), 'box<2>')]);
    (a as unknown as { sharedSolid: () => never }).sharedSolid = () => { throw new Error('boolean failed'); };
    expect(a.interference()).toEqual([{ a: 0, b: 1, volume: 0, mesh: null, failed: true }]);
  });

  it('measures, draws and exports the surface bodies of a part, but weighs and checks interference of solids only', async () => {
    const a = new AssemblyBuilder();
    // A 20 × 10 × 10 box with a 30 × 30 open surface sheet (an extruded line) above it.
    const sheet: Feature[] = [
      sketch('S2', [{ id: 'q0', t: 'point', x: -5, y: 20 }, { id: 'q1', t: 'point', x: 25, y: 20 }, { id: 'ql', t: 'line', a: 'q0', b: 'q1' }]),
      { ...newSurfaceFeature('surfaceExtrude', 'F1', 'F1', 10), sketch: 'S2', depth: 30 } as Feature,
    ];
    const [withSheet] = await a.build([{ key: 'sheet', features: [...box(), ...sheet], blobs: {}, quality: 0 }]);
    await built(a);
    expect(withSheet.status.every((s) => s.ok)).toBe(true);
    const solidFaces = withSheet.faces.filter((f) => !f.body).length;
    expect(withSheet.faces.length).toBeGreaterThan(solidFaces);
    // The sheet part first, then a box: the box's faces are numbered after the sheet's.
    a.setScene([item('sheet', at([0, 0, 0]), 'plate<1>'), item('box', at([100, 0, 0]), 'box<1>')]);
    const boxFace = withSheet.faces.length; // the first face of box<1>
    expect(a.measure({ kind: 'face', index: boxFace }, { kind: 'vertex', p: [100, 5, 5] }).distance).toBeLessThan(10.01);
    // The sheet itself can be measured (it is 20 above the box's base sketch plane, along y).
    const sheetFace = withSheet.faces.findIndex((f) => f.body);
    expect(a.measure({ kind: 'face', index: sheetFace }, { kind: 'vertex', p: [10, 30, 15] }).distance).toBeCloseTo(10, 4);
    // STEP: the sheet goes in as a shell beside the solids.
    const step = new TextDecoder().decode(await a.exportStep());
    expect(step).toMatch(/SHELL_BASED_SURFACE_MODEL|OPEN_SHELL/);
    // Mass: solids only.
    expect(a.mass([1000, 1000])!.volume).toBeCloseTo(4000, 0);
    // Drawings: the front view reaches up to the sheet (y = 20).
    const [front] = a.project([{ id: 'f', dir: [0, 0, 1], x: [1, 0, 0], hidden: false }]);
    expect(front.bounds![3] - front.bounds![1]).toBeGreaterThan(19);
    // Interference: the box overlapping only the sheet is not an interference of solids.
    a.setScene([item('sheet', at([0, 0, 0]), 'plate<1>'), item('box', at([0, 15, 0]), 'box<2>')]);
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

  it('a STEP export read back has each component where it was placed, under its own name', async () => {
    const a = new AssemblyBuilder();
    await built(a);
    // The box (20 × 10 × 10 from the origin) moved, and turned a quarter about z.
    a.setScene([item('box', at([100, 0, 0]), 'bracket<1>'), item('box', at([0, 50, 0], qAxisAngle([0, 0, 1], Math.PI / 2)), 'bracket<2>')]);
    const data = await a.exportStep();
    const text = new TextDecoder().decode(data);
    expect(text.match(/PRODUCT\('bracket<1>'/g)).toHaveLength(1);
    expect(text.match(/PRODUCT\('bracket<2>'/g)).toHaveLength(1);
    const shape = await R.importSTEP(new Blob([data as BlobPart]));
    const boxes = subShapes(wrap(shape.wrapped), 'solid').map((x) => bbox(x)!).sort((p, q) => q.min[0] - p.min[0]);
    const near = (v: number[], w: number[]) => v.forEach((x, i) => expect(x).toBeCloseTo(w[i], 3));
    near(boxes[0].min, [100, 0, 0]);
    near(boxes[0].max, [120, 10, 10]);
    // Turned: x from -10 to 0, y from 50 to 70.
    near(boxes[1].min, [-10, 50, 0]);
    near(boxes[1].max, [0, 70, 10]);
  });
});
