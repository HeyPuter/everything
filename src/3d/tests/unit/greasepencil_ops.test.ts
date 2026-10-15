// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/data';
import '../../src/greasepencil/index';
import { fromStrokes, toStrokes, newStroke, newPoint, newLayer, newGreasePencil, setKeyframe, emptyDrawing, gpOf, type GPPoint } from '../../src/greasepencil/data';
import { resamplePoints, interpolateStroke, interpolateDrawing, interpolateSequence, interpolateAt, shouldFlip } from '../../src/greasepencil/interpolate';
import { cleanLoose, mergeByDistance, cleanDuplicateFrames } from '../../src/greasepencil/cleanup';
import { selectAlternate, selectEnds, splitStrokes, extrudeStrokes, reorderStrokes, setStartPoint, dissolveBetween, simplifyFixed, sampleByLength, outlinePoints } from '../../src/greasepencil/editops';
import { mergeLayers, isolateLayer } from '../../src/greasepencil/layerops';
import { Vector3 } from 'three';

const xs = (pts: GPPoint[]) => pts.map((p) => +p.co[0].toFixed(3));
const line = (x: number[], z = 0, sel: number[] = []) => newStroke(x.map((v, i) => ({ ...newPoint([v, 0, z]), select: sel.includes(i) })));

describe('interpolation', () => {
  it('resamples evenly along the length', () => {
    expect(xs(resamplePoints(line([0, 1, 2]).points, 5, false))).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(xs(resamplePoints(line([0, 0.2, 2]).points, 3, false))).toEqual([0, 1, 2]);
  });

  it('pairs equal point counts directly and resamples different ones', () => {
    // equal counts: point by point
    const a = line([0, 0.2, 2]),
      b = line([0, 1, 2], 2);
    const m = interpolateStroke(a, b, 0.5);
    expect(xs(m.points)).toEqual([0, 0.6, 2]);
    expect(m.points[1].co[2]).toBeCloseTo(1);
    // 3 → 5 points: both sampled to 5
    const c = interpolateStroke(line([0, 1, 2]), line([0, 1, 2, 3, 4], 2), 2 / 9);
    expect(c.points.length).toBe(5);
    expect(c.points[4].co[0]).toBeCloseTo(2.444, 3);
    expect(c.points[0].co[2]).toBeCloseTo(0.444, 3);
  });

  it('flips a reversed target stroke automatically', () => {
    const a = line([0, 1, 2]),
      b = line([2, 1, 0]);
    expect(shouldFlip(a.points, b.points)).toBe(true);
    expect(xs(interpolateStroke(a, b, 0.5).points)).toEqual([0, 1, 2]);
    expect(xs(interpolateStroke(a, b, 0.5, 'NONE').points)).toEqual([1, 1, 1]);
  });

  it('drops strokes that have no partner', () => {
    const d = interpolateDrawing(fromStrokes([line([0, 1])]), fromStrokes([line([0, 1], 1), line([5, 6], 1)]), 0.5)!;
    expect(toStrokes(d).length).toBe(1);
  });

  it('fills the frames between two keys with breakdowns (sequence) and one frame (single)', () => {
    const gp = newGreasePencil();
    const l = newLayer();
    gp.layers.push(l);
    setKeyframe(gp, l, 1, fromStrokes([line([0, 1, 2])]));
    setKeyframe(gp, l, 10, fromStrokes([line([0, 1, 2, 3, 4], 2)]));
    expect(interpolateSequence(gp, l, 1, { step: 2, type: 'LINEAR', easing: 'EASE_IN' })).toBe(4);
    expect(l.frames.map((f) => [f.frame_number, f.keyframe_type])).toEqual([
      [1, 'KEYFRAME'],
      [3, 'BREAKDOWN'],
      [5, 'BREAKDOWN'],
      [7, 'BREAKDOWN'],
      [9, 'BREAKDOWN'],
      [10, 'KEYFRAME'],
    ]);
    const f3 = toStrokes(gp.drawings[l.frames[1].drawing])[0];
    expect(f3.points[0].co[2]).toBeCloseTo(0.444, 3);
    // a single in-between replaces a breakdown, never a key
    expect(interpolateAt(gp, l, 5, 0.1, {})).toBe(true);
    expect(interpolateAt(gp, l, 1, 0, {})).toBe(false);
  });

  it('eases the sequence', () => {
    const gp = newGreasePencil();
    const l = newLayer();
    gp.layers.push(l);
    setKeyframe(gp, l, 0, fromStrokes([line([0, 1])]));
    setKeyframe(gp, l, 4, fromStrokes([line([0, 1], 4)]));
    interpolateSequence(gp, l, 0, { step: 1, type: 'QUAD', easing: 'EASE_IN' });
    const z = l.frames.slice(1, 4).map((f) => toStrokes(gp.drawings[f.drawing])[0].points[0].co[2]);
    expect(z.map((v) => +v.toFixed(3))).toEqual([0.25, 1, 2.25]);
  });
});

describe('clean up', () => {
  it('removes short strokes', () => {
    const ss = [line([0]), line([0, 1]), line([0, 1, 2])];
    expect(cleanLoose(ss, 1).map((s) => s.points.length)).toEqual([2, 3]);
    expect(cleanLoose(ss, 2).map((s) => s.points.length)).toEqual([3]);
  });

  it('merges runs of close points', () => {
    const m = mergeByDistance(line([0, 0.0005, 0.001, 0.0015]).points, 0.001);
    expect(m.map((p) => +p.co[0].toFixed(5))).toEqual([0.00025, 0.00125]);
  });

  it('deletes keys repeating the previous drawing', () => {
    const gp = newGreasePencil();
    const l = newLayer();
    gp.layers.push(l);
    setKeyframe(gp, l, 1, fromStrokes([line([0, 1])]));
    setKeyframe(gp, l, 5, fromStrokes([line([0, 1])]));
    setKeyframe(gp, l, 8, emptyDrawing());
    setKeyframe(gp, l, 9, emptyDrawing());
    expect(cleanDuplicateFrames(l, gp.drawings)).toBe(2);
    expect(l.frames.map((f) => f.frame_number)).toEqual([1, 8]);
  });
});

describe('stroke editing kernels', () => {
  it('selects alternate points and stroke ends', () => {
    const sel = (ss: ReturnType<typeof line>[]) => ss.map((s) => s.points.map((p) => (p.select ? 1 : 0)).join(''));
    expect(sel(selectAlternate([line([0, 1, 2, 3, 4, 5], 0, [0]), line([0, 1, 2])], false))).toEqual(['101010', '000']);
    expect(sel(selectAlternate([line([0, 1, 2, 3, 4, 5], 0, [0])], true))).toEqual(['010100']);
    expect(sel(selectEnds([line([0, 1, 2, 3, 4, 5], 0, [0, 1, 2, 3, 4, 5]), line([0, 1, 2, 3])], 1, 2))).toEqual(['100011', '1011']);
  });

  it('splits selected runs into new strokes', () => {
    const out = splitStrokes([line([0, 1, 2, 3, 4, 5], 0, [1, 2])]);
    expect(out.map((s) => xs(s.points))).toEqual([[1, 2], [0, 1], [2, 3, 4, 5]]);
    expect(out[0].points.every((p) => p.select)).toBe(true);
  });

  it('extrudes stroke ends and starts strokes from middle points', () => {
    const ends = extrudeStrokes([line([0, 1, 2], 0, [0, 2])]);
    expect(xs(ends[0].points)).toEqual([0, 0, 1, 2, 2]);
    expect(ends[0].points.map((p) => !!p.select)).toEqual([true, false, false, false, true]);
    const mid = extrudeStrokes([line([0, 1, 2], 0, [1])]);
    expect(mid.length).toBe(2);
    expect(xs(mid[1].points)).toEqual([1, 1]);
  });

  it('reorders the selected strokes', () => {
    const a = line([0], 0, [0]),
      b = line([1]),
      c = line([2]);
    expect(reorderStrokes([a, b, c], 'TOP')).toEqual([b, c, a]);
    expect(reorderStrokes([b, c, a], 'BOTTOM')).toEqual([a, b, c]);
    expect(reorderStrokes([a, b, c], 'UP')).toEqual([b, a, c]);
    expect(reorderStrokes([b, a, c], 'DOWN')).toEqual([a, b, c]);
  });

  it('sets the start point of closed strokes and dissolves between selections', () => {
    const s = { ...line([0, 1, 2, 3], 0, [2]), cyclic: true };
    expect(xs(setStartPoint(s).points)).toEqual([2, 3, 0, 1]);
    expect(xs(dissolveBetween(line([0, 1, 2, 3, 4, 5], 0, [1, 4])).points)).toEqual([0, 1, 4, 5]);
  });

  it('simplifies by fixed steps and samples by length', () => {
    expect(xs(simplifyFixed(line([0, 1, 2, 3, 4]).points, 1))).toEqual([0, 2, 4]);
    expect(xs(sampleByLength(line([0, 4]).points, 1, false))).toEqual([0, 1, 2, 3, 4]);
  });

  it('outlines a stroke as a closed loop around it', () => {
    const s = line([0, 1]);
    s.points.forEach((p) => (p.radius = 0.1));
    const o = outlinePoints(s, new Vector3(0, 1, 0), 0, 2);
    // two sides + two caps of three points
    expect(o.length).toBe(2 + 3 + 2 + 3);
    const zs = o.map((p) => Math.abs(p.co[2]));
    expect(Math.max(...zs)).toBeCloseTo(0.1);
    expect(Math.min(...o.map((p) => p.co[0]))).toBeCloseTo(-0.1);
  });
});

describe('layers', () => {
  it('merges layers keeping every key frame', () => {
    const gp = newGreasePencil();
    const a = newLayer('A'),
      b = newLayer('B');
    gp.layers.push(a, b);
    setKeyframe(gp, a, 1, fromStrokes([line([0])]));
    setKeyframe(gp, b, 3, fromStrokes([line([1])]));
    const m = mergeLayers(gp, [a, b]);
    expect(m.map((x) => [x.n, toStrokes(x.d).length])).toEqual([
      [1, 1],
      [3, 2],
    ]);
  });

  it('isolates and restores', () => {
    const gp = newGreasePencil();
    gp.layers.push(newLayer('A'), newLayer('B'), newLayer('C'));
    isolateLayer(gp, 1, true);
    expect(gp.layers.map((l) => [l.lock, l.hide])).toEqual([
      [true, true],
      [false, false],
      [true, true],
    ]);
    isolateLayer(gp, 1, true);
    expect(gp.layers.every((l) => !l.lock && !l.hide)).toBe(true);
  });
});

describe('operators', () => {
  beforeEach(() => {
    setApp(new App(startupDocument()));
    app.run('object.select_all', { action: 'SELECT' });
    app.run('object.delete');
    app.run('object.grease_pencil_add', { type: 'STROKE' });
  });

  it('interpolate sequence creates breakdowns in Draw Mode', () => {
    const gp = gpOf(app.doc, app.activeObject)!;
    const l = gp.layers[gp.active_layer_index];
    setKeyframe(gp, l, 11, fromStrokes(toStrokes(gp.drawings[l.frames[0].drawing]).map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, co: [p.co[0], p.co[1], p.co[2] + 1] as [number, number, number] })) }))));
    app.run('object.mode_set', { mode: 'PAINT_GREASE_PENCIL' });
    expect(app.run('grease_pencil.interpolate_sequence', { step: 5 }, { invoke: false })).toBe('FINISHED');
    expect(l.frames.map((f) => f.frame_number)).toEqual([1, 6, 11]);
    expect(l.frames[1].keyframe_type).toBe('BREAKDOWN');
    expect(app.run('grease_pencil.delete_breakdown', {}, { invoke: false })).toBe('FINISHED');
    expect(gpOf(app.doc, app.activeObject)!.layers[gp.active_layer_index].frames.length).toBe(2);
  });

  it('copy / paste and separate in Edit Mode', () => {
    app.run('object.mode_set', { mode: 'EDIT' });
    app.run('grease_pencil.select_all', { action: 'SELECT' });
    expect(app.run('grease_pencil.copy', {}, { invoke: false })).toBe('FINISHED');
    const gp = () => gpOf(app.doc, app.activeObject)!;
    const count = () => gp().drawings.reduce((a, d) => a + d.offsets.length - 1, 0);
    const before = count();
    expect(app.run('grease_pencil.paste', {}, { invoke: false })).toBe('FINISHED');
    // all three copied strokes (two lines, one fill) land on the active layer
    expect(count()).toBe(before + 3);
    expect(app.run('grease_pencil.separate', { mode: 'LAYER' }, { invoke: false })).toBe('FINISHED');
    expect(Object.keys(app.doc.objects).length).toBe(2);
  });
});

import { stabilize, trimEnds } from '../../src/greasepencil/drawproc';
import { primitivePoints, segmentControls } from '../../src/greasepencil/primitives';
import { trimStrokes, insidePolygon } from '../../src/greasepencil/drawtools';

describe('draw input processing', () => {
  it('stabilizer trails the pointer by its radius', () => {
    expect(stabilize({ x: 0, y: 0 }, { x: 5, y: 0 }, 10, 0.5)).toEqual({ x: 0, y: 0 });
    const p = stabilize({ x: 0, y: 0 }, { x: 30, y: 0 }, 10, 0);
    expect(p.x).toBeCloseTo(20);
  });

  it('trims the overshooting ends of a self-crossing stroke', () => {
    // a loop: starts left of the crossing and ends past it
    const s = [
      [0, 0],
      [10, 0],
      [10, 10],
      [5, 10],
      [5, -5],
    ].map(([x, y]) => ({ x, y, pressure: 1 }));
    const t = trimEnds(s);
    expect(t[0]).toMatchObject({ x: 5, y: 0 });
    expect(t[t.length - 1]).toMatchObject({ x: 5, y: 0 });
  });
});

describe('primitives', () => {
  it('builds lines, boxes and curves from control points', () => {
    expect(primitivePoints('LINE', [{ x: 0, y: 0 }, { x: 10, y: 0 }], 1).map((p) => p.x)).toEqual([0, 5, 10]);
    expect(primitivePoints('LINE', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0).length).toBe(3);
    expect(primitivePoints('BOX', [{ x: 0, y: 0 }, { x: 10, y: 10 }], 0).length).toBe(4);
    const cp = [{ x: 0, y: 0 }, ...segmentControls('CURVE', { x: 0, y: 0 }, { x: 9, y: 0 })];
    const pts = primitivePoints('CURVE', cp, 8);
    expect(pts.length).toBe(9);
    expect(pts[4].x).toBeCloseTo(4.5);
    // arc: a quarter of an ellipse through the corner side
    const arc = primitivePoints('ARC', [{ x: 0, y: 0 }, ...segmentControls('ARC', { x: 0, y: 0 }, { x: 10, y: 10 })], 8);
    expect(arc[4].x).toBeGreaterThan(5);
    expect(arc[4].y).toBeLessThan(5);
  });
});

describe('trim', () => {
  it('removes the lassoed piece of a stroke up to its crossings', () => {
    const a = newStroke([newPoint([0, 0, 0]), newPoint([10, 0, 0])]);
    const b = newStroke([newPoint([5, 0, -5]), newPoint([5, 0, 5])]);
    const scr = [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      [
        { x: 5, y: -5 },
        { x: 5, y: 5 },
      ],
    ];
    const lasso = [
      { x: -1, y: -1 },
      { x: 3, y: -1 },
      { x: 3, y: 1 },
      { x: -1, y: 1 },
    ];
    expect(insidePolygon(0, 0, lasso)).toBe(true);
    const out = trimStrokes([a, b], scr, lasso)!;
    expect(out.length).toBe(2);
    expect(out[0].points.map((p) => p.co[0])).toEqual([5, 10]);
  });
});

import { kernels, buildStrokes, changeLength, timeOffset, evaluateDrawing, activeModifiers } from '../../src/greasepencil/modifiers';
import { Matrix4 } from 'three';

describe('grease pencil modifiers', () => {
  const ctx = () => {
    const gp = newGreasePencil();
    const layer = newLayer('L');
    gp.layers.push(layer);
    return { doc: app.doc, ob: app.activeObject!, gp, layer, layerIndex: 0, frame: 1, keyFrame: 1, nextKeyFrame: null, prevStrokeCount: 0, world: new Matrix4() };
  };
  beforeEach(() => {
    setApp(new App(startupDocument()));
  });

  it('thickness, opacity and tint', () => {
    const s = [line([0, 1])];
    expect(kernels.GREASE_PENCIL_THICKNESS(s, { thickness_factor: 2 }, ctx())[0].points[0].radius).toBeCloseTo(0.02);
    expect(kernels.GREASE_PENCIL_THICKNESS(s, { use_uniform_thickness: true, thickness: 0.5 }, ctx())[0].points[1].radius).toBeCloseTo(0.25);
    expect(kernels.GREASE_PENCIL_OPACITY(s, { color_factor: 0.5 }, ctx())[0].points[0].opacity).toBeCloseTo(0.5);
    const t = kernels.GREASE_PENCIL_TINT(s, { factor: 1, color: [1, 0, 0], color_mode: 'STROKE' }, ctx())[0].points[0].vertex_color;
    expect(t).toEqual([1, 0, 0, 1]);
  });

  it('array, mirror and multiple strokes add copies', () => {
    const s = [line([0, 1])];
    const arr = kernels.GREASE_PENCIL_ARRAY(s, { count: 3, use_relative_offset: true, relative_offset: [1, 0, 0] }, ctx());
    expect(arr.map((x) => x.points[0].co[0])).toEqual([0, 1, 2]);
    const mir = kernels.GREASE_PENCIL_MIRROR([line([1, 2])], { use_axis_x: true }, ctx());
    expect(mir.map((x) => x.points[1].co[0])).toEqual([2, -2]);
    expect(kernels.GREASE_PENCIL_MULTIPLY(s, { duplicates: 2, distance: 0.1 }, ctx()).length).toBe(3);
  });

  it('dot dash splits strokes into dashes', () => {
    const out = kernels.GREASE_PENCIL_DASH([line([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])], { segments: [{ dash: 2, gap: 1, radius: 1, opacity: 1, material_index: -1 }] }, ctx());
    expect(out.map((s) => xs(s.points))).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]);
  });

  it('length grows and shrinks the ends', () => {
    expect(changeLength(line([0, 1]).points, 0.5, 0).map((p) => p.co[0])).toEqual([-0.5, 0, 1]);
    expect(changeLength(line([0, 1, 2]).points, -0.5, -0.5).map((p) => p.co[0])).toEqual([0.5, 1, 1.5]);
  });

  it('build reveals points over the frames after the key', () => {
    const s = [line([0, 1, 2, 3]), line([0, 1, 2, 3])];
    const at = (frame: number) => buildStrokes(s, { length: 10 }, { frame, keyFrame: 1, prevStrokeCount: 0 }).reduce((a, x) => a + x.points.length, 0);
    expect(at(1)).toBe(0);
    expect(at(6)).toBe(4);
    expect(at(11)).toBe(8);
    expect(buildStrokes(s, { length: 10, transition: 'SHRINK' }, { frame: 11, keyFrame: 1, prevStrokeCount: 0 }).length).toBe(0);
  });

  it('time offset modes', () => {
    expect(timeOffset({ mode: 'NORMAL', offset: 2 }, 5, 1, 10)).toBe(7);
    expect(timeOffset({ mode: 'NORMAL', offset: 2 }, 10, 1, 10)).toBe(2);
    expect(timeOffset({ mode: 'FIX', offset: 4 }, 9, 1, 10)).toBe(4);
    expect(timeOffset({ mode: 'REVERSE', offset: 0 }, 1, 1, 10)).toBe(10);
    expect(timeOffset({ mode: 'PINGPONG', offset: 0 }, 12, 1, 10)).toBe(8);
  });

  it('evaluates the stack on a drawing (cached) for an object', () => {
    app.run('object.grease_pencil_add', { type: 'STROKE' });
    const ob = app.activeObject!;
    expect(app.run('object.modifier_add', { type: 'GREASE_PENCIL_THICKNESS' }, { invoke: false })).toBe('FINISHED');
    ob.modifiers[0].thickness_factor = 3;
    const gp = gpOf(app.doc, ob)!;
    const l = gp.layers[1];
    const d = gp.drawings[l.frames[0].drawing];
    const mods = activeModifiers(ob);
    const ev = evaluateDrawing(d, { doc: app.doc, ob, gp, layer: l, layerIndex: 1, frame: 1, keyFrame: 1, nextKeyFrame: null, prevStrokeCount: 0, world: new Matrix4() }, mods);
    expect(ev.radius[0]).toBeCloseTo(d.radius[0] * 3);
    expect(evaluateDrawing(d, { doc: app.doc, ob, gp, layer: l, layerIndex: 1, frame: 1, keyFrame: 1, nextKeyFrame: null, prevStrokeCount: 0, world: new Matrix4() }, mods)).toBe(ev);
    // grease pencil modifiers are not offered for meshes
    app.run('mesh.primitive_cube_add', {}, { invoke: false });
    expect(app.run('object.modifier_add', { type: 'GREASE_PENCIL_THICKNESS' }, { invoke: false })).toBe('CANCELLED');
  });
});

import { renameLayer } from '../../src/greasepencil/layerops';

describe('layer masks', () => {
  beforeEach(() => {
    setApp(new App(startupDocument()));
    app.run('object.grease_pencil_add', { type: 'STROKE' });
  });

  it('adds, reorders and removes masks; renaming a layer keeps its masks', () => {
    const gp = gpOf(app.doc, app.activeObject)!;
    gp.layers.push(newLayer('Top'));
    gp.active_layer_index = 1; // Lines
    expect(app.run('grease_pencil.relative_layer_mask_add', { mode: 'BELOW' }, { invoke: false })).toBe('FINISHED');
    expect(app.run('grease_pencil.layer_mask_add', { name: 'Top' }, { invoke: false })).toBe('FINISHED');
    const l = () => gpOf(app.doc, app.activeObject)!.layers[1];
    expect(l().mask_layers!.map((m) => m.name)).toEqual(['Color', 'Top']);
    expect(l().use_masks).toBe(true);
    expect(app.run('grease_pencil.layer_mask_add', { name: 'Top' }, { invoke: false })).toBe('CANCELLED');
    expect(app.run('grease_pencil.layer_mask_reorder', { direction: 'UP' }, { invoke: false })).toBe('FINISHED');
    expect(l().mask_layers!.map((m) => m.name)).toEqual(['Top', 'Color']);
    renameLayer(gpOf(app.doc, app.activeObject)!, gpOf(app.doc, app.activeObject)!.layers[2], 'Above');
    expect(l().mask_layers![0].name).toBe('Above');
    expect(app.run('grease_pencil.layer_mask_remove', {}, { invoke: false })).toBe('FINISHED');
    expect(l().mask_layers!.length).toBe(1);
  });
});

import { armatureWeights } from '../../src/greasepencil/weightpaint';

describe('vertex groups, weight and vertex paint', () => {
  beforeEach(() => {
    setApp(new App(startupDocument()));
    app.run('object.select_all', { action: 'SELECT' });
    app.run('object.delete');
  });

  it('weights survive stroke round trips and edits', () => {
    const s = line([0, 1, 2]);
    s.points[1].weights = { Arm: 0.5 };
    const d = fromStrokes([s]);
    expect([...d.weights!.Arm]).toEqual([0, 0.5, 0]);
    const back = toStrokes(d);
    expect(back[0].points[1].weights).toEqual({ Arm: 0.5 });
    expect(back[0].points[0].weights).toEqual({});
  });

  it('vertex groups: add, assign in Edit Mode, normalize, remove', () => {
    app.run('object.grease_pencil_add', { type: 'STROKE' });
    const ob = app.activeObject!;
    expect(app.run('object.vertex_group_add', {}, { invoke: false })).toBe('FINISHED');
    const gp = () => gpOf(app.doc, ob)!;
    expect(gp().vertex_groups!.map((g) => g.name)).toEqual(['Group']);
    app.run('object.mode_set', { mode: 'EDIT' });
    app.run('grease_pencil.select_all', { action: 'SELECT' });
    (app.doc.scene.tool_settings as { vertex_group_weight?: number }).vertex_group_weight = 0.4;
    expect(app.run('object.vertex_group_assign', {}, { invoke: false })).toBe('FINISHED');
    const w = () => gp().drawings[gp().layers[1].frames[0].drawing].weights!.Group;
    expect(w()[0]).toBeCloseTo(0.4);
    app.run('object.mode_set', { mode: 'WEIGHT_GREASE_PENCIL' });
    expect(app.doc.mode).toBe('WEIGHT_GREASE_PENCIL');
    expect(app.run('grease_pencil.vertex_group_normalize', {}, { invoke: false })).toBe('FINISHED');
    expect(w()[0]).toBeCloseTo(1);
    expect(app.run('grease_pencil.weight_invert', {}, { invoke: false })).toBe('FINISHED');
    expect(w()[0]).toBeCloseTo(0);
    expect(app.run('object.vertex_group_remove', {}, { invoke: false })).toBe('FINISHED');
    expect(gp().vertex_groups!.length).toBe(0);
  });

  it('vertex paint color operators', () => {
    app.run('object.grease_pencil_add', { type: 'STROKE' });
    app.run('object.mode_set', { mode: 'VERTEX_GREASE_PENCIL' });
    expect(app.doc.mode).toBe('VERTEX_GREASE_PENCIL');
    const gp = () => gpOf(app.doc, app.activeObject)!;
    const vc = () => gp().drawings[gp().layers[1].frames[0].drawing].vertex_color;
    expect(app.run('grease_pencil.vertex_color_set', { mode: 'STROKE', factor: 1 }, { invoke: false })).toBe('FINISHED');
    expect(vc()[3]).toBeCloseTo(1);
    expect(app.run('grease_pencil.vertex_color_invert', { mode: 'STROKE' }, { invoke: false })).toBe('FINISHED');
    expect(app.run('grease_pencil.stroke_reset_vertex_color', { mode: 'BOTH' }, { invoke: false })).toBe('FINISHED');
    expect([...vc().slice(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it('automatic weights from an armature', () => {
    app.run('object.armature_add', { location: [0, 0, 0] }, { invoke: false });
    const arm = app.activeObject!;
    app.run('object.grease_pencil_add', { type: 'STROKE', location: [0, 0, 0] });
    const ob = app.activeObject!;
    app.flush();
    armatureWeights(ob, arm, true);
    const gp = gpOf(app.doc, ob)!;
    const bone = app.doc.armatures[arm.data!].bones[0].name;
    expect(gp.vertex_groups!.map((g) => g.name)).toContain(bone);
    const w = gp.drawings[gp.layers[1].frames[0].drawing].weights![bone];
    expect(w.every((x) => Math.abs(x - 1) < 1e-6)).toBe(true);
  });
});

import { extensionLines } from '../../src/greasepencil/fillgaps';

describe('fill gap closure', () => {
  const u = {
    pts: [
      [0, 0],
      [0, 100],
      [100, 100],
      [100, 10],
    ] as [number, number][],
    cyclic: false,
  };
  it('extends open ends along their direction (stopping at strokes when colliding)', () => {
    const lines = extensionLines([u], 'EXTEND', () => 30, false);
    expect(lines.length).toBe(2);
    expect(lines[0]).toEqual([0, 0, 0, -30]);
    expect(lines[1]).toEqual([100, 10, 100, -20]);
    const wall = { pts: [[-50, -5], [150, -5]] as [number, number][], cyclic: false };
    const hit = extensionLines([u, wall], 'EXTEND', () => 30, true);
    expect(hit[0][3]).toBeCloseTo(-5);
  });
  it('joins close ends in radius mode', () => {
    const lines = extensionLines([u], 'RADIUS', () => 120, false);
    expect(lines).toEqual([[0, 0, 100, 10]]);
    expect(extensionLines([u], 'RADIUS', () => 50, false)).toEqual([]);
  });
});

import { buildStrokeBuffers, gradientUV, type StrokeStyle } from '../../src/greasepencil/geometry';

describe('material styles', () => {
  const sq = () => newStroke([newPoint([0, 0, 0]), newPoint([2, 0, 0]), newPoint([2, 0, 2]), newPoint([0, 0, 2])], { cyclic: true });
  it('gradient coordinates span the fill bounds', () => {
    const d = fromStrokes([sq()]);
    const uv = gradientUV(d.position, [[0, 1, 2, 3]], { type: 'LINEAR', mix: [1, 1, 1, 1], factor: 0.5, flip: false, offset: [0, 0], angle: 0, scale: [1, 1] });
    const us = [...uv.values()].map(([u, v]) => [+u.toFixed(3), +v.toFixed(3)]);
    expect(us.every(([u, v]) => (u === 0 || u === 1) && (v === 0 || v === 1))).toBe(true);
  });
  it('holdout strokes are built separately', () => {
    const d = fromStrokes([{ ...sq(), material_index: 0 }, { ...sq(), material_index: 1 }]);
    const base: StrokeStyle = { stroke: true, fill: false, color: [0, 0, 0, 1], fillColor: [1, 1, 1, 1], mode: 'LINE' };
    const styles = [base, { ...base, holdoutStroke: true }];
    const normal = buildStrokeBuffers(d, styles);
    const hold = buildStrokeBuffers(d, styles, 0, 0, true);
    expect(normal.vertexCount).toBe(16);
    expect(hold.vertexCount).toBe(16);
    expect(normal.info[3]).toBe(0);
    expect(hold.info[3]).toBe(1);
  });
});
