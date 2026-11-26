// Sheet metal without the kernel: bend allowance math, open profile layout,
// file validation and the DXF writer.
import { describe, expect, it } from 'vitest';
import {
  type BendParams, bendAllowance, layoutOpenProfile, newBaseFlange, newEdgeFlange, newHem, newSketchedBend, openChain, setback, sheetParamsError,
  validSheetMetalFeature,
} from '../src/model/sheetmetal';
import { type FlatPattern, bendNote, flatPatternDxf, flatSize, parseDxfEntities } from '../src/model/flat-pattern';
import { DocStore, newDocument, parseDocument, serializeDocument } from '../src/model/document';
import { consumedSketches, dependencies } from '../src/model/features';
import type { SkEntity } from '../src/model/types';

const P = (over: Partial<BendParams> = {}): BendParams => ({ thickness: 2, radius: 1, allowance: 'kFactor', kFactor: 0.5, allowanceValue: 0, ...over });

function chain(pts: [number, number][], prefix = 'c'): SkEntity[] {
  const ents: SkEntity[] = pts.map(([x, y], i) => ({ id: `${prefix}p${i}`, t: 'point', x, y }));
  for (let i = 0; i + 1 < pts.length; i++) ents.push({ id: `${prefix}l${i}`, t: 'line', a: `${prefix}p${i}`, b: `${prefix}p${i + 1}` });
  return ents;
}

describe('bend allowance', () => {
  it('uses the K-factor formula BA = pi/180 * angle * (R + K*T)', () => {
    expect(bendAllowance(90, 1, P())).toBeCloseTo((Math.PI / 180) * 90 * (1 + 0.5 * 2), 12);
    expect(bendAllowance(45, 3, P({ kFactor: 0.33 }))).toBeCloseTo((Math.PI / 180) * 45 * (3 + 0.33 * 2), 12);
    expect(bendAllowance(120, 0, P({ kFactor: 0 }))).toBe(0);
  });

  it('takes a bend allowance as given and turns a bend deduction into one', () => {
    expect(bendAllowance(90, 1, P({ allowance: 'bendAllowance', allowanceValue: 3.2 }))).toBe(3.2);
    // BD = 2 * OSSB - BA with OSSB = tan(45) * (R + T) = 3.
    expect(bendAllowance(90, 1, P({ allowance: 'bendDeduction', allowanceValue: 2 }))).toBeCloseTo(4, 12);
    expect(setback(90, 3)).toBeCloseTo(3, 12);
    expect(setback(60, 3)).toBeCloseTo(3 * Math.tan(Math.PI / 6), 12);
  });

  it('gives a hem a finite allowance with a bend deduction (a 180 degree bend has no virtual sharp)', () => {
    // BD 2 at 90 degrees: BA90 = 4 = pi/2 * (R + K*T) gives K; the hem uses it at its own radius.
    const p = P({ allowance: 'bendDeduction', allowanceValue: 2 });
    const k = (4 / (Math.PI / 2) - 1) / 2;
    expect(bendAllowance(180, 0.5, p)).toBeCloseTo(Math.PI * (0.5 + k * 2), 9);
    expect(bendAllowance(180, 1, p)).toBeCloseTo(8, 9);
  });

  it('rejects parameters it cannot bend with', () => {
    expect(sheetParamsError(P())).toBeNull();
    expect(sheetParamsError(P({ thickness: 0 }))).toMatch(/Thickness/);
    expect(sheetParamsError(P({ radius: -1 }))).toMatch(/radius/);
    expect(sheetParamsError(P({ kFactor: 1.2 }))).toMatch(/K-factor/);
    expect(sheetParamsError(P({ allowance: 'bendAllowance', allowanceValue: NaN }))).toMatch(/allowance/);
  });
});

describe('open profiles', () => {
  it('orders the chain from the end of the first curve in the sketch, whichever way lines were drawn', () => {
    const ents: SkEntity[] = [
      { id: 'a', t: 'point', x: 50, y: 30 }, { id: 'b', t: 'point', x: 50, y: 0 }, { id: 'c', t: 'point', x: 0, y: 0 },
      { id: 'l2', t: 'line', a: 'a', b: 'b' }, { id: 'l1', t: 'line', a: 'c', b: 'b' },
    ];
    const r = openChain(ents);
    if ('error' in r) throw new Error(r.error);
    expect(r.segs.map((s) => [s.src, s.a, s.b])).toEqual([['l2', [50, 30], [50, 0]], ['l1', [50, 0], [0, 0]]]);
  });

  it('says why a sketch is not one open chain', () => {
    expect(openChain([])).toEqual({ error: expect.stringMatching(/no lines/) });
    const square = [...chain([[0, 0], [1, 0], [1, 1], [0, 1]], 's'), { id: 'close', t: 'line', a: 'sp3', b: 'sp0' } as SkEntity];
    expect(openChain(square)).toEqual({ error: 'The profile is closed' });
    const t: SkEntity[] = [...chain([[0, 0], [10, 0]], 'a'), ...chain([[10, 0], [10, 10]], 'b'), ...chain([[10, 0], [20, 0]], 'd')];
    expect(openChain(t)).toEqual({ error: expect.stringMatching(/branches/) });
    expect(openChain([...chain([[0, 0], [10, 0]], 'a'), ...chain([[20, 0], [30, 0]], 'b')])).toEqual({ error: expect.stringMatching(/single chain/) });
    expect(openChain([{ id: 'c', t: 'point', x: 0, y: 0 }, { id: 'k', t: 'circle', c: 'c', r: 3 }])).toEqual({ error: expect.stringMatching(/lines and arcs/) });
  });

  it('lays an L profile out flat: legs less their setbacks plus the bend allowance', () => {
    const segs = (openChain(chain([[0, 0], [50, 0], [50, 30]])) as { segs: never }).segs;
    const p = P();
    // Thickness on the inside of the corner (left of the chain): the sketch is the outside, setback tan(45)(R + T).
    const out = layoutOpenProfile(segs, p, 0);
    if ('error' in out) throw new Error(out.error);
    expect(out.bends).toHaveLength(1);
    expect(out.bends[0]).toMatchObject({ up: true, angle: expect.closeTo(90, 9), radius: 1, width: expect.closeTo(bendAllowance(90, 1, p), 12) });
    expect(out.runs[0]).toMatchObject({ x0: 0, x1: expect.closeTo(47, 9) });
    expect(out.runs[1].x1 - out.runs[1].x0).toBeCloseTo(27, 9);
    expect(out.runs[1].x1).toBeCloseTo(47 + Math.PI + 27, 9);
    // Thickness outside the corner: the sketch is the inside, setback tan(45) R.
    const inside = layoutOpenProfile(segs, p, 2);
    if ('error' in inside) throw new Error(inside.error);
    expect(inside.runs[1].x1).toBeCloseTo(49 + Math.PI + 29, 9);
    // Turning right goes down.
    const right = layoutOpenProfile((openChain(chain([[0, 0], [50, 0], [50, -30]])) as { segs: never }).segs, p, 0);
    if ('error' in right) throw new Error(right.error);
    expect(right.bends[0].up).toBe(false);
  });

  it('joins lines that go on straight, and reports corners it cannot bend', () => {
    const straight = layoutOpenProfile((openChain(chain([[0, 0], [20, 0], [50, 0], [50, 30]])) as { segs: never }).segs, P(), 0);
    if ('error' in straight) throw new Error(straight.error);
    expect(straight.runs).toHaveLength(2);
    expect(straight.runs[0].x1).toBeCloseTo(47, 9);
    const short = layoutOpenProfile((openChain(chain([[0, 0], [2, 0], [2, 30]])) as { segs: never }).segs, P(), 0);
    expect(short).toEqual({ error: expect.stringMatching(/too short/) });
    const back = layoutOpenProfile((openChain(chain([[0, 0], [50, 0], [0, 0.0001]])) as { segs: never }).segs, P(), 0);
    expect(back).toEqual({ error: expect.stringMatching(/folds back/) });
  });

  it('uses a tangent arc as a bend of its radius and rejects one that is not tangent', () => {
    const arc = (cx: number, cy: number): SkEntity[] => [
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 30, y: 0 }, { id: 'c', t: 'point', x: 35, y: 5 }, { id: 'd', t: 'point', x: 35, y: 30 },
      { id: 'o', t: 'point', x: cx, y: cy },
      { id: 'l1', t: 'line', a: 'a', b: 'b' }, { id: 'arc', t: 'arc', c: 'o', a: 'b', b: 'c' }, { id: 'l2', t: 'line', a: 'c', b: 'd' },
    ];
    const ok = layoutOpenProfile((openChain(arc(30, 5)) as { segs: never }).segs, P(), 0);
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.bends[0]).toMatchObject({ up: true, radius: 3, angle: expect.closeTo(90, 9), src: 'arc' });
    expect(ok.runs[0].x1).toBeCloseTo(30, 9);
    const bad = layoutOpenProfile((openChain(arc(32, 3)) as { segs: never }).segs, P(), 0);
    expect(bad).toEqual({ error: expect.stringMatching(/tangent/) });
  });
});

describe('sheet metal documents', () => {
  function doc() {
    const d = newDocument();
    d.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: chain([[0, 0], [10, 0], [10, 10]]), constraints: [] });
    const bf = newBaseFlange('f2', 'Base-Flange1', 's1', 1, 20);
    bf.sm.thickness = '=T';
    d.variables.push({ id: 'v1', name: 'T', expr: '1.5' });
    const ef = { ...newEdgeFlange('f3', 'Edge-Flange1', 10), edges: [{ name: 'f2:end1|f2:cl1:a', sig: { type: 'line', m: [0, 0, 0] as [number, number, number], len: 20 } }] };
    d.features.push(bf, ef, newSketchedBend('f4', 'Sketched Bend1', 's1'), { ...newHem('f5', 'Hem1', 5, 0.5), edges: [] });
    return d;
  }

  it('saves, opens and evaluates sheet metal features', () => {
    const d = parseDocument(serializeDocument(doc()));
    expect(d.features.map((f) => f.type)).toEqual(['sketch', 'baseFlange', 'edgeFlange', 'sketchedBend', 'hem']);
    const resolved = new DocStore(d).resolve();
    expect(resolved.errors.size).toBe(0);
    expect((resolved.features[1] as { sm: { thickness: number } }).sm.thickness).toBe(1.5);
    expect(dependencies(d.features[2])).toEqual(['f2']);
    expect(consumedSketches(d.features[1])).toEqual(['s1']);
    expect(consumedSketches(d.features[3])).toEqual(['s1']);
  });

  it('rejects damaged sheet metal features', () => {
    for (const damage of [
      (f: Record<string, unknown>) => { if (f.type === 'baseFlange') delete f.sm; },
      (f: Record<string, unknown>) => { if (f.type === 'baseFlange') (f.sm as Record<string, unknown>).allowance = 'magic'; },
      (f: Record<string, unknown>) => { if (f.type === 'edgeFlange') f.edges = [{}]; },
      (f: Record<string, unknown>) => { if (f.type === 'edgeFlange') f.position = 'sideways'; },
      (f: Record<string, unknown>) => { if (f.type === 'hem') f.kind = 'rolled'; },
      (f: Record<string, unknown>) => { if (f.type === 'sketchedBend') f.sketch = 5; },
    ]) {
      const d = doc();
      d.features.forEach((f) => damage(f as unknown as Record<string, unknown>));
      expect(() => parseDocument(JSON.stringify(d))).toThrow(/damaged/);
    }
    expect(validSheetMetalFeature({ type: 'other' })).toBe(true);
  });
});

describe('flat pattern DXF', () => {
  const pattern: FlatPattern = {
    loops: [
      { outer: true, segs: [{ k: 'line', a: [0, 0], b: [100, 0] }, { k: 'arc', c: [100, 10], r: 10, a0: -Math.PI / 2, a1: 0 }, { k: 'line', a: [110, 10], b: [0, 10] }, { k: 'line', a: [0, 10], b: [0, 0] }] },
      { outer: false, segs: [{ k: 'circle', c: [50, 5], r: 2 }] },
    ],
    bends: [{ a: [30, 0], b: [30, 10], up: false, angle: 45, radius: 1.5, allowance: 2, feature: 'f3' }],
    thickness: 2, min: [0, 0], max: [110, 10], notes: [], placement: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  };

  it('writes lines, arcs in degrees, circles and dashed bend lines with notes', () => {
    const ents = parseDxfEntities(flatPatternDxf(pattern));
    expect(ents.map((e) => `${e.type}:${e.layer}`)).toEqual(['LINE:OUTLINE', 'ARC:OUTLINE', 'LINE:OUTLINE', 'LINE:OUTLINE', 'CIRCLE:CUTS', 'LINE:BEND_DOWN', 'TEXT:BEND_NOTES']);
    const arc = ents[1].values;
    expect([arc.get(50)![0], arc.get(51)![0], arc.get(40)![0]]).toEqual(['-90', '0', '10']);
    expect(ents[5].values.get(6)).toEqual(['DASHED']);
    expect(ents[6].values.get(1)).toEqual(['DOWN 45%%d R 1.5']);
    expect(parseDxfEntities(flatPatternDxf(pattern, { notes: false })).some((e) => e.type === 'TEXT')).toBe(false);
  });

  it('declares its layers and line types and ends with EOF', () => {
    const text = flatPatternDxf(pattern);
    const lines = text.trim().split('\n');
    expect(lines.length % 2).toBe(0);
    expect(lines.slice(-2)).toEqual(['0', 'EOF']);
    for (const layer of ['OUTLINE', 'CUTS', 'BEND_UP', 'BEND_DOWN', 'BEND_NOTES']) expect(text).toContain(`\n2\n${layer}\n`);
    expect(text).toContain('\n2\nDASHED\n');
    expect(text).toContain('AC1009');
  });

  it('notes and sizes', () => {
    expect(bendNote(pattern.bends[0])).toBe('DOWN 45° R 1.5');
    expect(bendNote({ ...pattern.bends[0], up: true, angle: 90 }, (v) => `${v.toFixed(2)} mm`)).toBe('UP 90° R 1.50 mm');
    expect(flatSize(pattern)).toEqual([110, 10]);
  });
});
