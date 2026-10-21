// @vitest-environment happy-dom
// SVG as Curves: control points, handle types, fills and units checked against the reference
// app's result for the same file.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emptyDocument } from '../../src/data/defaults';
import { importSvgCurves, parsePathCubics, arcToCubics } from '../../src/io/formats/svgcurves';

const svg = readFileSync(resolve(__dirname, '../fixtures/formats/r4_shapes.svg'), 'utf8');
const r5 = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5 + 0);

describe('SVG as curves', () => {
  it('parses path commands into cubic segments', () => {
    const [p] = parsePathCubics('M10 10 h 20 v 10 q 5 5 10 0 t 10 0 a 5 5 0 0 1 10 0 z');
    expect(p.closed).toBe(true);
    expect(p.segs[0].line).toBe(true);
    expect(p.segs[0].to).toEqual([30, 10]);
    expect(p.segs[2].line).toBe(false);
    // the arc ends where it was asked to
    const arc = arcToCubics([0, 0], 10, 10, 0, false, true, [20, 0]);
    expect(arc.length).toBe(2);
    expect(r5(arc[1].to)).toEqual([20, 0]);
    expect(r5(arc[0].to)).toEqual([10, -10]);
  });

  it('matches the reference import of the same file', () => {
    const doc = emptyDocument();
    const obs = importSvgCurves(doc, svg, 'r4_shapes.svg', doc.scene.collection);
    expect(obs.map((o) => o.name)).toEqual(['tri', 'wave', 'box', 'Curve']);
    const col = Object.values(doc.collections).find((c) => c.name === 'r4_shapes.svg')!;
    expect(col.objects.length).toBe(4);
    const cu = (n: string) => doc.curves[obs.find((o) => o.name === n)!.data!];
    const tri = cu('tri');
    expect(tri.dimensions).toBe('2D');
    expect(tri.fill_mode).toBe('BOTH');
    expect(doc.materials[tri.materials[0]!].diffuse_color).toEqual([1, 0, 0, 1]);
    const ts = tri.splines[0];
    expect(ts.use_cyclic_u).toBe(true);
    expect(ts.bezier_points.map((b) => r5(b.co))).toEqual([
      [0.00564, 0.0254, 0],
      [0.02822, 0.0254, 0],
      [0.01693, 0.00564, 0],
    ]);
    expect(r5(ts.bezier_points[0].handle_left)).toEqual([0.00941, 0.01881, 0]);
    expect(ts.bezier_points[0].handle_left_type).toBe('VECTOR');
    const wave = cu('wave');
    expect(wave.dimensions).toBe('3D');
    expect(wave.materials).toEqual([]);
    const w = wave.splines[0].bezier_points;
    expect(w.length).toBe(3);
    expect(r5(w[1].co)).toEqual([0.04798, 0.01411, 0]);
    expect(r5(w[1].handle_left)).toEqual([0.04233, 0, 0]);
    expect(r5(w[1].handle_right)).toEqual([0.05362, 0.02822, 0]);
    expect(r5(w[0].handle_left)).toEqual(r5(w[0].co));
    expect(w[1].handle_left_type).toBe('FREE');
    const box = cu('box').splines[0].bezier_points;
    expect(box.map((b) => r5(b.co))).toEqual([
      [0.00564, 0.01129, 0],
      [0.01693, 0.01129, 0],
      [0.01693, 0.00282, 0],
      [0.00564, 0.00282, 0],
    ]);
    const circle = cu('Curve').splines[0].bezier_points;
    expect(circle.map((b) => r5(b.co))).toEqual([
      [0.03951, 0.00564, 0],
      [0.04233, 0.00847, 0],
      [0.04516, 0.00564, 0],
      [0.04233, 0.00282, 0],
    ]);
    expect(r5(circle[1].handle_left)).toEqual([0.04078, 0.00847, 0]);
    // the two green shapes share one material
    expect(cu('box').materials[0]).toBe(cu('Curve').materials[0]);
  });
});
