import { describe, it, expect } from 'vitest';
import { fromStrokes, toStrokes, newStroke, newPoint, copyDrawing, normalizeDrawing, type GPPoint, type GPStroke } from '../../src/greasepencil/data';
import { evaluatedDrawing, evaluatedControlIndex, GP_BEZIER, GP_CATMULL_ROM, GP_NURBS, GP_POLY, H_ALIGN, H_AUTO, H_FREE, H_VECTOR, withDerived } from '../../src/greasepencil/curves';
import { setCurveType, convertCurveType, setHandleType, toggleTarget, fitCatmull, evaluatedPoints, insertOnSegment, cycleHandleType } from '../../src/greasepencil/curvefit';
import { buildStrokeBuffers, KIND_FILL, type StrokeStyle } from '../../src/greasepencil/geometry';

const wave = (n = 120, cyclic = false): GPStroke => {
  const pts: GPPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = cyclic
      ? newPoint([Math.cos(t * Math.PI * 2 * (1 - 1 / n)), 0, Math.sin(t * Math.PI * 2 * (1 - 1 / n))], 0.01 + t * 0.02)
      : newPoint([t * 4 - 2, 0, Math.sin(t * Math.PI * 2) * 0.6], 0.01 + t * 0.02);
    p.select = true;
    pts.push(p);
  }
  return newStroke(pts, { cyclic });
};

/** Largest distance from the source points to the evaluated poly line of a stroke. */
function deviation(src: GPStroke, s: GPStroke): number {
  const ev = evaluatedPoints(s).map((p) => p.co);
  const segDist = (p: number[], a: number[], b: number[]) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2));
    return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
  };
  let worst = 0;
  for (const p of src.points) {
    let best = Infinity;
    for (let i = 0; i + 1 < ev.length; i++) best = Math.min(best, segDist(p.co, ev[i], ev[i + 1]));
    if (src.cyclic && ev.length > 2) best = Math.min(best, segDist(p.co, ev[ev.length - 1], ev[0]));
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('stroke spline data', () => {
  it('poly drawings carry no spline arrays and evaluate to themselves', () => {
    const d = fromStrokes([wave(10)]);
    expect(d.curve_type).toBeUndefined();
    expect(d.handle_left).toBeUndefined();
    expect(evaluatedDrawing(d)).toBe(d);
  });

  it('round-trips curve types, handles and stroke types through stroke lists', () => {
    const b = setCurveType(wave(5), GP_BEZIER, false);
    b.points[1].handle_type_left = H_FREE;
    b.points[1].handle_left = [9, 9, 9];
    b.points[2].select_right = true;
    const c = { ...setCurveType(wave(4), GP_NURBS, false), stroke_type: 2 };
    const d = fromStrokes([b, c, newStroke([newPoint([0, 0, 0])])]);
    expect([...d.curve_type!]).toEqual([GP_BEZIER, GP_NURBS, GP_POLY]);
    expect([...d.stroke_type!]).toEqual([0, 2, 0]);
    expect([...d.handle_left!.slice(3, 6)]).toEqual([9, 9, 9]);
    expect(d.select_handle_right![2]).toBe(1);
    const back = toStrokes(d);
    expect(back[0].curve_type).toBe(GP_BEZIER);
    expect(back[0].points[1].handle_left).toEqual([9, 9, 9]);
    expect(back[0].points[2].select_right).toBe(true);
    expect(back[1].curve_type).toBe(GP_NURBS);
    expect(back[1].stroke_type).toBe(2);
    expect(back[2].curve_type).toBeUndefined();
    // copies keep the optional arrays
    const cp = copyDrawing(d);
    expect(cp.handle_left).not.toBe(d.handle_left);
    expect([...cp.handle_left!]).toEqual([...d.handle_left!]);
  });

  it('drops optional arrays of the wrong length and rebuilds auto handles', () => {
    const d = fromStrokes([setCurveType(wave(5), GP_BEZIER, false)]);
    d.handle_left = new Float32Array(3);
    normalizeDrawing(d);
    expect(d.handle_left!.length).toBe(15);
    expect(d.handle_type_left![0]).toBe(H_AUTO);
  });

  it('new points of Bézier strokes get auto handles', () => {
    const s = setCurveType(wave(3), GP_BEZIER, false);
    s.points.splice(1, 0, newPoint([0, 0, 1]));
    const d = fromStrokes([s]);
    expect(d.handle_type_left![1]).toBe(H_AUTO);
    // auto handles are derived: not at the point itself
    expect(Math.hypot(d.handle_left![3] - 0, d.handle_left![5] - 1)).toBeGreaterThan(0.01);
  });
});

describe('evaluation', () => {
  it('a Bézier stroke with vector handles keeps its straight segments', () => {
    const d = fromStrokes([setCurveType(newStroke([newPoint([0, 0, 0], 0.1), newPoint([1, 0, 0], 0.3), newPoint([1, 0, 1], 0.1)]), GP_BEZIER, false)]);
    const ev = evaluatedDrawing(d);
    // vector handles on both sides: one evaluated point per segment
    expect(ev.offsets[1]).toBe(3);
    expect([...ev.radius].map((x) => +x.toFixed(3))).toEqual([0.1, 0.3, 0.1]);
  });

  it('auto handles give a smooth curve with interpolated radius and controls mapped', () => {
    const s = setCurveType(newStroke([newPoint([0, 0, 0], 0.1), newPoint([1, 0, 1], 0.3), newPoint([2, 0, 0], 0.1)]), GP_BEZIER, false);
    s.points.forEach((p) => (p.handle_type_left = p.handle_type_right = H_AUTO));
    const d = fromStrokes([{ ...s, resolution: 8 }]);
    const ev = evaluatedDrawing(d);
    expect(ev.offsets[1]).toBe(17);
    expect(ev.radius[4]).toBeCloseTo(0.2, 5);
    const ci = evaluatedControlIndex(d)!;
    expect([...ci]).toEqual([0, 8, 16]);
    // the evaluated drawing is cached for the same arrays
    expect(evaluatedDrawing(d)).toBe(ev);
  });

  it('per stroke fill / stroke types override the material', () => {
    const LINE: StrokeStyle = { stroke: true, fill: false, color: [0, 0, 0, 1], fillColor: [1, 1, 1, 1], mode: 'LINE' };
    const sq = [newPoint([0, 0, 0]), newPoint([1, 0, 0]), newPoint([1, 0, 1]), newPoint([0, 0, 1])];
    const fillOnly = buildStrokeBuffers(fromStrokes([newStroke(sq, { cyclic: true, stroke_type: 2 })]), [LINE]);
    expect([...fillOnly.info].filter((_, i) => i % 4 === 0).every((k) => k === KIND_FILL)).toBe(true);
    const both = buildStrokeBuffers(fromStrokes([newStroke(sq, { cyclic: true, stroke_type: 3 })]), [LINE]);
    const kinds = new Set([...both.info].filter((_, i) => i % 4 === 0));
    expect(kinds.size).toBe(2);
    // fill guides are skipped unless asked for
    const g = fromStrokes([newStroke(sq, { is_fill_guide: true })]);
    expect(buildStrokeBuffers(g, [LINE]).vertexCount).toBe(0);
    expect(buildStrokeBuffers(g, [LINE], 0, 0, false, true).vertexCount).toBeGreaterThan(0);
  });
});

describe('set curve type', () => {
  it('poly → Bézier uses vector handles; Bézier → NURBS with handles makes 3 points each', () => {
    const b = setCurveType(wave(8), GP_BEZIER, false);
    expect(b.points.every((p) => p.handle_type_left === H_VECTOR)).toBe(true);
    const d = withDerived(fromStrokes([b]));
    // vector handle: a third of the way to the neighbour
    expect(d.handle_right![0]).toBeCloseTo(b.points[0].co[0] + (b.points[1].co[0] - b.points[0].co[0]) / 3, 5);
    const back = toStrokes(d)[0];
    const n = setCurveType(back, GP_NURBS, true);
    expect(n.points.length).toBe(24);
    expect(n.knots_mode).toBe(2);
    expect(setCurveType(back, GP_NURBS, false).points.length).toBe(8);
    expect(setCurveType(back, GP_POLY, false).curve_type).toBeUndefined();
  });

  it('Catmull-Rom → Bézier keeps the shape with aligned handles', () => {
    const cr = setCurveType(wave(9), GP_CATMULL_ROM, false);
    const b = setCurveType(cr, GP_BEZIER, true);
    expect(b.points[3].handle_type_left).toBe(H_ALIGN);
    const e1 = evaluatedPoints({ ...cr, resolution: 12 });
    const e2 = evaluatedPoints({ ...b, resolution: 12 });
    expect(e1.length).toBe(e2.length);
    for (let i = 0; i < e1.length; i++) for (let k = 0; k < 3; k++) expect(e2[i].co[k]).toBeCloseTo(e1[i].co[k], 4);
  });
});

describe('convert curve type', () => {
  for (const cyclic of [false, true])
    it(`fits Bézier, Catmull-Rom and NURBS within the threshold (${cyclic ? 'cyclic' : 'open'})`, () => {
      const src = wave(160, cyclic);
      const b = convertCurveType(src, GP_BEZIER, 0.01);
      expect(b.curve_type).toBe(GP_BEZIER);
      expect(b.points.length).toBeLessThan(30);
      expect(b.points.length).toBeGreaterThan(3);
      expect(deviation(src, b)).toBeLessThan(0.02);
      if (!cyclic) {
        expect(b.points[0].handle_type_left).toBe(H_FREE);
        expect(b.points[1].handle_type_left).toBe(H_ALIGN);
      }
      // a finer threshold keeps more points
      expect(convertCurveType(src, GP_BEZIER, 0.0005).points.length).toBeGreaterThan(b.points.length);
      const c = convertCurveType(src, GP_CATMULL_ROM, 0.01);
      expect(c.points.length).toBeLessThan(60);
      expect(deviation(src, c)).toBeLessThan(0.02);
      const n = convertCurveType(src, GP_NURBS, 0.01);
      expect(n.curve_type).toBe(GP_NURBS);
      expect(deviation(src, n)).toBeLessThan(0.03);
      // back to poly: the evaluated points
      const p = convertCurveType({ ...b, resolution: 6 }, GP_POLY, 0.01);
      expect(p.curve_type).toBeUndefined();
      expect(p.points.length).toBe((b.points.length - (cyclic ? 0 : 1)) * 6 + (cyclic ? 0 : 1));
    });

  it('Catmull-Rom fitting keeps the ends of open strokes', () => {
    const P: [number, number, number][] = Array.from({ length: 50 }, (_, i) => [i / 10, 0, (i / 10) ** 2]);
    const idx = fitCatmull(P, 0.001);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(49);
  });
});

describe('handle types', () => {
  it('sets selected handles and toggles free / align', () => {
    const b = setCurveType(wave(4), GP_BEZIER, false);
    b.points.forEach((p) => (p.select = false));
    b.points[1].select = true;
    b.points[2].select_left = true;
    const r = setHandleType(b, 'ALIGN')!;
    expect(r.points[1].handle_type_left).toBe(H_ALIGN);
    expect(r.points[1].handle_type_right).toBe(H_ALIGN);
    expect(r.points[2].handle_type_left).toBe(H_ALIGN);
    expect(r.points[2].handle_type_right).toBe(H_VECTOR);
    expect(toggleTarget([r])).toBe(H_FREE);
    const f = setHandleType(r, 'TOGGLE_FREE_ALIGN', toggleTarget([r]))!;
    expect(toggleTarget([f])).toBe(H_ALIGN);
    expect(setHandleType(wave(3), 'AUTO')).toBeNull();
  });
});

describe('pen edits', () => {
  it('inserting a point on a Bézier segment keeps the shape', () => {
    const s0 = setCurveType(newStroke([newPoint([0, 0, 0]), newPoint([1, 0, 1]), newPoint([2, 0, 0])]), GP_BEZIER, false);
    s0.points.forEach((p) => (p.handle_type_left = p.handle_type_right = H_AUTO));
    const s = toStrokes(fromStrokes([{ ...s0, resolution: 64 }]))[0];
    const { stroke, index } = insertOnSegment(s, 0, 0.5);
    expect(index).toBe(1);
    expect(stroke.points.length).toBe(4);
    expect(stroke.points[1].select).toBe(true);
    // the new point lies on the old curve
    const before = evaluatedPoints(s).map((p) => p.co);
    const m = stroke.points[1].co;
    const near = Math.min(...before.map((q) => Math.hypot(q[0] - m[0], q[1] - m[1], q[2] - m[2])));
    expect(near).toBeLessThan(0.02);
    // and the evaluated curve stays within a small distance of the old one
    const after = evaluatedPoints(toStrokes(fromStrokes([stroke]))[0]).map((p) => p.co);
    for (const q of after) expect(Math.min(...before.map((r) => Math.hypot(q[0] - r[0], q[1] - r[1], q[2] - r[2])))).toBeLessThan(0.03);
  });

  it('inserting on a poly segment interpolates the point', () => {
    const s = newStroke([newPoint([0, 0, 0], 0.1), newPoint([2, 0, 0], 0.3)]);
    const r = insertOnSegment(s, 0, 0.25).stroke;
    expect(r.points[1].co).toEqual([0.5, 0, 0]);
    expect(r.points[1].radius).toBeCloseTo(0.15);
  });

  it('cycles handle types', () => {
    let p = { ...newPoint([0, 0, 0]), handle_type_left: H_AUTO, handle_type_right: H_AUTO };
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      p = cycleHandleType(p);
      seen.push(p.handle_type_left!);
    }
    expect(seen).toEqual([H_VECTOR, H_ALIGN, H_FREE, H_AUTO]);
  });
});

describe('corner joins', () => {
  it('points with a miter angle cut their segments and add a join', () => {
    const LINE: StrokeStyle = { stroke: true, fill: false, color: [0, 0, 0, 1], fillColor: [1, 1, 1, 1], mode: 'LINE' };
    const pts = [newPoint([0, 0, 0], 0.1), newPoint([1, 0, 1], 0.1), newPoint([2, 0, 0], 0.1)];
    const round = buildStrokeBuffers(fromStrokes([newStroke(pts)]), [LINE]);
    expect(round.vertexCount).toBe(8);
    const sharp = pts.map((p) => ({ ...p, miter_angle: Math.PI / 4 }));
    const b = buildStrokeBuffers(fromStrokes([newStroke(sharp)]), [LINE]);
    // two segments plus one join (the end points are not corners)
    expect(b.vertexCount).toBe(12);
    const kinds = [...b.info].filter((_, i) => i % 4 === 0);
    expect(kinds.filter((k) => k === 4).length).toBe(4);
    // the segments are cut at the corner: end flag on the first, start flag on the second
    const flags = [...b.info].filter((_, i) => i % 4 === 2);
    expect(flags[0] & 2).toBe(2);
    expect(flags[4] & 1).toBe(1);
    // the join carries the miter limit in its second neighbour slot
    expect(b.nbr1[8 * 4 + 3]).toBeCloseTo(Math.PI / 4);
  });
});

describe('soft strokes', () => {
  it('carry their softness in the flag bits and fill inner joints with dots', () => {
    const LINE: StrokeStyle = { stroke: true, fill: false, color: [0, 0, 0, 1], fillColor: [1, 1, 1, 1], mode: 'LINE' };
    const pts = [newPoint([0, 0, 0], 0.1), newPoint([1, 0, 0.2], 0.1), newPoint([2, 0, 0], 0.1), newPoint([3, 0, 0.3], 0.1)];
    const d = fromStrokes([newStroke(pts, { softness: 0.5 })]);
    expect(d.softness![0]).toBeCloseTo(0.5);
    expect(toStrokes(d)[0].softness).toBeCloseTo(0.5);
    const b = buildStrokeBuffers(d, [LINE]);
    // three segments + two joint dots
    expect(b.vertexCount).toBe(20);
    const flags = [...b.info].filter((_, i) => i % 4 === 2);
    expect(flags[0] >> 4).toBe(128);
    // inner ends are cut, the stroke ends stay round
    expect(flags[0] & 3).toBe(2);
    expect(flags[4] & 3).toBe(3);
    expect(flags[8] & 3).toBe(1);
  });
});

describe('material textures and passes', () => {
  const base: StrokeStyle = { stroke: true, fill: true, color: [0, 0, 0, 1], fillColor: [1, 1, 1, 1], mode: 'LINE' };
  const sq = () => [newPoint([0, 0, 0]), newPoint([1, 0, 0]), newPoint([1, 0, 1]), newPoint([0, 0, 1])];
  it('marks texture fills (kind 3) and textured lines (flag bit)', () => {
    const tex: StrokeStyle = { ...base, fillTex: { image: 'im', mix: 0.25, clamp: false, offset: [0, 0], angle: 0, scale: [1, 1] }, strokeTex: { image: 'im', mix: 0, uvFactor: 1 } };
    const b = buildStrokeBuffers(fromStrokes([newStroke(sq(), { cyclic: true })]), [tex]);
    const kinds = [...b.info].filter((_, i) => i % 4 === 0);
    const fillAt = kinds.indexOf(KIND_FILL);
    expect(b.nbr0[fillAt * 4 + 2]).toBe(3);
    expect(b.nbr0[fillAt * 4 + 3]).toBeCloseTo(0.25);
    const segAt = kinds.indexOf(1);
    expect(b.info[segAt * 4 + 2] & 4096).toBe(4096);
  });
  it('gives every stroke two draw orders, so partial passes stack like the full one', () => {
    const d = fromStrokes([newStroke(sq(), { material_index: 0 }), newStroke(sq(), { material_index: 1 }), newStroke(sq(), { material_index: 0 })]);
    const full = buildStrokeBuffers(d, [base, base]);
    expect(full.orderEnd).toBe(6);
    const only1 = buildStrokeBuffers(d, [base, base], 0, 0, false, false, (k) => k === 1);
    const orders = new Set([...only1.info].filter((_, i) => i % 4 === 1));
    expect([...orders].sort()).toEqual([2, 3]);
    expect(only1.orderEnd).toBe(6);
  });
});

describe('texture mapping modifier', () => {
  it('sets the line mapping and moves / scales / turns the fill mapping', async () => {
    const { kernels } = await import('../../src/greasepencil/modifiers');
    const sq = newStroke([newPoint([0, 0, 0]), newPoint([2, 0, 0]), newPoint([2, 0, 1]), newPoint([0, 0, 1])], { cyclic: true });
    const m = { mode: 'STROKE_AND_FILL', fit_method: 'FIT_STROKE', uv_offset: 0.25, uv_scale: 2, alignment_rotation: 0.5, fill_rotation: 0.3, fill_offset: [0.5, 0], fill_scale: 2 } as never;
    const [o] = kernels.GREASE_PENCIL_TEXTURE([sq], m, {} as never);
    expect(o.uv_stroke).toEqual([0.25, 2, 1, 0.5]);
    // bounds-based start: the fill maps 2 × 1 units, halved by the scale
    expect(o.uv_scale![0]).toBeCloseTo(1);
    expect(o.uv_scale![1]).toBeCloseTo(0.5);
    expect(o.uv_rotation).toBeCloseTo(0.3);
    // the line mapping reaches the GPU buffers: fitted u runs 0..1 along the stroke, offset then scaled
    const LINE: StrokeStyle = { stroke: true, fill: false, color: [0, 0, 0, 1], fillColor: [1, 1, 1, 1], mode: 'LINE', strokeTex: { image: 'im', mix: 0, uvFactor: 1 } };
    const b = buildStrokeBuffers(fromStrokes([{ ...o, cyclic: false }]), [LINE]);
    expect(b.uv[0]).toBeCloseTo((0 + 0.25) * 2);
    // end of the last segment: fully along the open stroke (u = (1 + offset) * scale)
    const segVerts = 3 * 4;
    expect(b.uv[(segVerts - 1) * 2 + 1]).toBeCloseTo((1 + 0.25) * 2);
  });
});

describe('pen nib', () => {
  it('thins strokes running along the nib angle', async () => {
    const { nibFactor } = await import('../../src/greasepencil/drawproc');
    expect(nibFactor(0, 0, 0.8)).toBeCloseTo(0.2);
    expect(nibFactor(Math.PI / 2, 0, 0.8)).toBeCloseTo(1);
    expect(nibFactor(Math.PI, 0, 0.5)).toBeCloseTo(0.5);
    expect(nibFactor(0.3, 0.3, 0)).toBe(1);
  });
});
