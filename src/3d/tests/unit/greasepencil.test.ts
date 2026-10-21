import { describe, it, expect } from 'vitest';
import { buildStrokeBuffers, triangulateLoops, pointColor, KIND_FILL, KIND_SEGMENT, KIND_DOT, type StrokeStyle } from '../../src/greasepencil/geometry';
import { eraseHard, eraseStrokes, eraseSoft, circleRoots } from '../../src/greasepencil/erase';
import { fromStrokes, toStrokes, newStroke, newPoint, newLayer, newGreasePencil, frameAt, onionFrames, onionAlpha, setKeyframe, emptyDrawing, compactDrawings, copyDrawing, type GPPoint } from '../../src/greasepencil/data';
import { smoothPoints, subdivideStroke, joinStrokes, filterPoints, simplifyPoints } from '../../src/greasepencil/strokeops';
import { floodFill, dilate, traceContours, simplifyLoop } from '../../src/greasepencil/fillmath';
import { encodeDocument, decodeDocument } from '../../src/io/native';
import { emptyDocument } from '../../src/data/defaults';
import { cloneShared } from '../../src/data/cow';

const LINE: StrokeStyle = { stroke: true, fill: false, color: [0, 0, 0, 1], fillColor: [1, 1, 1, 1], mode: 'LINE' };
const pts = (xy: [number, number][], r = 0.1): GPPoint[] => xy.map(([x, z]) => newPoint([x, 0, z], r));

describe('stroke geometry', () => {
  it('emits one quad per segment, closing cyclic strokes', () => {
    const d = fromStrokes([newStroke(pts([[0, 0], [1, 0], [1, 1]]))]);
    const b = buildStrokeBuffers(d, [LINE]);
    expect(b.vertexCount).toBe(8);
    expect(b.index.length).toBe(12);
    expect(b.orderEnd).toBe(2); // each stroke owns two draw orders (fill, line)
    const c = buildStrokeBuffers(fromStrokes([newStroke(pts([[0, 0], [1, 0], [1, 1]]), { cyclic: true })]), [LINE]);
    expect(c.vertexCount).toBe(12);
    // the closing segment goes from the last point back to the first
    expect([...c.p0.slice(8 * 3, 8 * 3 + 3)]).toEqual([1, 0, 1]);
    expect([...c.p1.slice(8 * 3, 8 * 3 + 3)]).toEqual([0, 0, 0]);
  });

  it('a single point is a round dot (degenerate segment)', () => {
    const b = buildStrokeBuffers(fromStrokes([newStroke(pts([[2, 3]], 0.5))]), [LINE]);
    expect(b.vertexCount).toBe(4);
    expect(b.info[0]).toBe(KIND_SEGMENT);
    expect([...b.p0.slice(0, 3)]).toEqual([...b.p1.slice(0, 3)]);
    expect(b.radius[0]).toBeCloseTo(0.5);
  });

  it('flags flat caps only on the stroke ends and passes per point radius', () => {
    const p = pts([[0, 0], [1, 0], [2, 0]]);
    p[0].radius = 0.2;
    p[2].radius = 0.4;
    const b = buildStrokeBuffers(fromStrokes([newStroke(p, { start_cap: 1, end_cap: 1 })]), [LINE]);
    const flags = [b.info[2], b.info[4 * 4 + 2]];
    expect(flags).toEqual([1, 2]);
    expect(b.radius[0]).toBeCloseTo(0.2); // first segment, p0 radius
    expect(b.radius[4 * 2 + 1]).toBeCloseTo(0.4); // second segment, p1 radius
    // neighbours: the first segment knows the point after its end, the second the one before its start
    expect(b.nbr1[3]).toBeCloseTo(0.4);
    expect(b.nbr0[16 + 3]).toBeCloseTo(0.2);
    expect(b.nbr0[3]).toBe(0);
  });

  it('mixes vertex color over the material color and applies point opacity', () => {
    const p = pts([[0, 0], [1, 0]]);
    p[0].vertex_color = [1, 0, 0, 0.5];
    p[0].opacity = 0.5;
    const d = fromStrokes([newStroke(p)]);
    expect(pointColor(d, 0, [0, 0, 1, 1])).toEqual([0.5, 0, 0.5, 0.5]);
    expect(pointColor(d, 1, [0, 0, 1, 1])).toEqual([0, 0, 1, 1]);
  });

  it('dots / squares materials draw one quad per point, hidden slots are skipped', () => {
    const d = fromStrokes([newStroke(pts([[0, 0], [1, 0], [2, 0]])), newStroke(pts([[0, 1], [1, 1]]), { material_index: 1 })]);
    const b = buildStrokeBuffers(d, [{ ...LINE, mode: 'DOTS' }, null]);
    expect(b.vertexCount).toBe(12);
    expect(b.info[0]).toBe(KIND_DOT);
    expect(b.strokeOrder[1]).toBe(-1);
  });

  it('fills come before their stroke line and take their own draw order', () => {
    const d = fromStrokes([newStroke(pts([[0, 0], [1, 0], [1, 1], [0, 1]]), { cyclic: true })]);
    const b = buildStrokeBuffers(d, [{ ...LINE, fill: true }], 10);
    const fillVerts = 6; // 2 triangles
    expect(b.info[0]).toBe(KIND_FILL);
    expect(b.info[1]).toBe(10);
    expect(b.info[fillVerts * 4 + 1]).toBe(11);
    expect(b.orderEnd).toBe(12);
  });
});

describe('fill triangulation', () => {
  const area = (P: number[], tris: number[]) => {
    let a = 0;
    for (let k = 0; k < tris.length; k += 3) {
      const [i, j, l] = [tris[k], tris[k + 1], tris[k + 2]];
      a += Math.abs((P[j * 3] - P[i * 3]) * (P[l * 3 + 2] - P[i * 3 + 2]) - (P[l * 3] - P[i * 3]) * (P[j * 3 + 2] - P[i * 3 + 2])) / 2;
    }
    return a;
  };
  // outer 4x4 square (XZ plane), hole 2x2, island 1x1 inside the hole
  const P = [0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4, 1, 0, 1, 3, 0, 1, 3, 0, 3, 1, 0, 3, 1.5, 0, 1.5, 2.5, 0, 1.5, 2.5, 0, 2.5, 1.5, 0, 2.5];
  it('triangulates a simple polygon', () => {
    expect(area(P, triangulateLoops(P, [[0, 1, 2, 3]]))).toBeCloseTo(16);
  });
  it('even-odd: an inner loop is a hole, an island inside the hole is filled again', () => {
    expect(area(P, triangulateLoops(P, [[0, 1, 2, 3], [4, 5, 6, 7]]))).toBeCloseTo(12);
    // loop order and winding do not matter
    expect(area(P, triangulateLoops(P, [[7, 6, 5, 4], [0, 1, 2, 3]]))).toBeCloseTo(12);
    expect(area(P, triangulateLoops(P, [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]))).toBeCloseTo(13);
  });
  it('strokes sharing a fill id are filled together', () => {
    const outer = pts([[0, 0], [4, 0], [4, 4], [0, 4]]);
    const hole = pts([[1, 1], [3, 1], [3, 3], [1, 3]]);
    const d = fromStrokes([newStroke(outer, { cyclic: true, fill_id: 7 }), newStroke(hole, { cyclic: true, fill_id: 7 })]);
    const b = buildStrokeBuffers(d, [{ ...LINE, stroke: false, fill: true }]);
    const tris: number[] = [];
    const flat: number[] = [];
    for (let v = 0; v < b.vertexCount; v++) {
      flat.push(b.p0[v * 3], b.p0[v * 3 + 1], b.p0[v * 3 + 2]);
      tris.push(v);
    }
    expect(area(flat, tris)).toBeCloseTo(12);
  });
});

describe('erasers', () => {
  const screen = (p: GPPoint): [number, number] => [p.co[0], p.co[2]];
  it('point eraser cuts exactly at the circle boundary', () => {
    const st = newStroke(pts([[0, 0], [10, 0]]));
    const r = eraseHard([st], screen, 5, 0, 2);
    expect(r.changed).toBe(true);
    expect(r.strokes.length).toBe(2);
    expect(r.strokes[0].points.at(-1)!.co[0]).toBeCloseTo(3);
    expect(r.strokes[1].points[0].co[0]).toBeCloseTo(7);
  });
  it('point eraser opens a cyclic stroke into one stroke', () => {
    const sq = newStroke(pts([[0, 0], [10, 0], [10, 10], [0, 10]]), { cyclic: true });
    const r = eraseHard([sq], screen, 10, 10, 2);
    expect(r.strokes.length).toBe(1);
    const s = r.strokes[0];
    expect(s.cyclic).toBe(false);
    // starts right after the cut on the top edge and ends right before it on the right edge
    expect(s.points[0].co).toEqual([8, 0, 10]);
    expect(s.points.at(-1)!.co[0]).toBeCloseTo(10);
    expect(s.points.at(-1)!.co[2]).toBeCloseTo(8);
  });
  it('untouched strokes are kept as they are', () => {
    const st = newStroke(pts([[0, 0], [10, 0]]));
    const r = eraseHard([st], screen, 5, 5, 2);
    expect(r.changed).toBe(false);
    expect(r.strokes[0]).toBe(st);
  });
  it('stroke eraser removes touched strokes only', () => {
    const a = newStroke(pts([[0, 0], [10, 0]])),
      b = newStroke(pts([[0, 5], [10, 5]]));
    const r = eraseStrokes([a, b], screen, 5, 0.5, 1);
    expect(r.strokes).toEqual([b]);
  });
  it('dissolve fades opacity and splits where points vanish', () => {
    const st = newStroke(pts([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]));
    const r = eraseSoft([st], screen, 2, 0, 1.5, 2);
    expect(r.changed).toBe(true);
    expect(r.strokes.length).toBe(2);
    expect(r.strokes[0].points[1].opacity).toBeLessThan(1);
  });
  it('circle roots', () => {
    expect(circleRoots(0, 0, 10, 0, 5, 0, 2)).toEqual([0.3, 0.7]);
    expect(circleRoots(0, 0, 10, 0, 5, 5, 2)).toEqual([]);
  });
});

describe('keyframes and onion skins', () => {
  const gp = newGreasePencil();
  const l = newLayer();
  gp.layers.push(l);
  for (const f of [1, 5, 9, 20]) setKeyframe(gp, l, f, emptyDrawing());
  l.frames[2].keyframe_type = 'BREAKDOWN';
  it('finds the held keyframe', () => {
    expect(frameAt(l, 0)).toBeNull();
    expect(frameAt(l, 1)!.frame_number).toBe(1);
    expect(frameAt(l, 7)!.frame_number).toBe(5);
    expect(frameAt(l, 100)!.frame_number).toBe(20);
  });
  it('relative mode counts keyframes', () => {
    gp.onion_mode = 'RELATIVE';
    gp.ghost_before_range = 1;
    gp.ghost_after_range = 2;
    const o = onionFrames(gp, l, 6);
    expect(o.map((x) => [x.frame.frame_number, x.side, x.distance])).toEqual([
      [1, -1, 1],
      [9, 1, 1],
      [20, 1, 2],
    ]);
  });
  it('absolute mode counts frames, filter by keyframe type', () => {
    gp.onion_mode = 'ABSOLUTE';
    gp.ghost_before_range = 5;
    gp.ghost_after_range = 5;
    expect(onionFrames(gp, l, 6).map((x) => x.frame.frame_number)).toEqual([1, 9]);
    gp.onion_keyframe_type = 'BREAKDOWN';
    expect(onionFrames(gp, l, 6).map((x) => x.frame.frame_number)).toEqual([9]);
    gp.onion_keyframe_type = 'ALL';
  });
  it('selected mode and loop', () => {
    gp.onion_mode = 'SELECTED';
    l.frames[3].select = true;
    expect(onionFrames(gp, l, 6).map((x) => x.frame.frame_number)).toEqual([20]);
    l.frames[3].select = false;
    gp.onion_mode = 'RELATIVE';
    gp.use_onion_loop = true;
    expect(onionFrames(gp, l, 25, { start: 1, end: 30 }).map((x) => [x.frame.frame_number, x.side])).toContainEqual([1, 1]);
    gp.use_onion_loop = false;
  });
  it('fades with distance', () => {
    gp.use_onion_fade = true;
    const near = onionAlpha(gp, { frame: l.frames[0], side: -1, distance: 1 }, 3);
    const far = onionAlpha(gp, { frame: l.frames[0], side: -1, distance: 3 }, 3);
    expect(near).toBeCloseTo(gp.onion_factor);
    expect(far).toBeLessThan(near);
  });
  it('compacts unused drawings', () => {
    const g = newGreasePencil();
    const ly = newLayer();
    g.layers.push(ly);
    setKeyframe(g, ly, 1, emptyDrawing());
    setKeyframe(g, ly, 2, emptyDrawing());
    ly.frames.splice(0, 1);
    compactDrawings(g);
    expect(g.drawings.length).toBe(1);
    expect(ly.frames[0].drawing).toBe(0);
  });
});

describe('stroke operations', () => {
  it('round-trips strokes through the struct-of-arrays drawing', () => {
    const s = newStroke(pts([[0, 0], [1, 2]]), { cyclic: true, material_index: 3, start_cap: 1, fill_color: [1, 0, 0, 1], fill_id: 4 });
    const back = toStrokes(fromStrokes([s]))[0];
    expect(back.points.map((p) => p.co)).toEqual(s.points.map((p) => p.co));
    expect([back.cyclic, back.material_index, back.start_cap, back.end_cap, back.fill_id]).toEqual([true, 3, 1, 0, 4]);
    const copy = copyDrawing(fromStrokes([s]));
    expect(copy.offsets).toEqual(new Uint32Array([0, 2]));
  });
  it('subdivides and joins', () => {
    const s = newStroke(pts([[0, 0], [1, 0], [2, 0]]));
    expect(subdivideStroke(s, 2, false).points.length).toBe(7);
    const a = newStroke(pts([[0, 0], [1, 0]])),
      b = newStroke(pts([[3, 0], [2, 0]]));
    const j = joinStrokes([a, b])!;
    expect(j.points.map((p) => p.co[0])).toEqual([0, 1, 2, 3]);
  });
  it('smoothing keeps end points of open strokes', () => {
    const s = pts([[0, 0], [1, 1], [2, 0]]);
    const out = smoothPoints(s, 1, 1, false, { position: true, radius: false, opacity: false });
    expect(out[0].co).toEqual([0, 0, 0]);
    expect(out[1].co[2]).toBeCloseTo(0);
  });
  it('splits strokes at removed points and simplifies', () => {
    const s = newStroke(pts([[0, 0], [1, 0], [2, 0], [3, 0]]));
    const parts = filterPoints(s, (_p, i) => i !== 1);
    expect(parts.map((x) => x.points.length)).toEqual([1, 2]);
    expect(simplifyPoints(s.points, 0.01).length).toBe(2);
  });
});

describe('fill raster kernels', () => {
  const W = 20,
    H = 20;
  const ring = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - 10, y - 10);
      if (d > 5 && d < 7) ring[y * W + x] = 1;
    }
  it('flood fills a closed region and detects leaks', () => {
    const r = floodFill(ring, W, H, 10, 10)!;
    expect(r).not.toBeNull();
    expect(r[10 * W + 10]).toBe(1);
    expect(r[10 * W + 18]).toBe(0);
    expect(floodFill(ring, W, H, 1, 1)).toBeNull();
    expect(floodFill(ring, W, H, 16, 10)).toBeNull(); // on the boundary
  });
  it('traces outer and hole contours', () => {
    const loops = traceContours(ring, W, H);
    expect(loops.length).toBe(2);
    const filled = dilate(floodFill(ring, W, H, 10, 10)!, W, H, 1);
    const one = traceContours(filled, W, H);
    expect(one.length).toBe(1);
    expect(simplifyLoop(one[0], 0.5).length).toBeLessThan(one[0].length);
  });
});

describe('persistence', () => {
  it('saves and loads grease pencil data in the native format and survives undo snapshots', () => {
    const doc = emptyDocument();
    const gp = newGreasePencil('GP');
    const l = newLayer('Lines');
    gp.layers.push(l);
    setKeyframe(gp, l, 3, fromStrokes([newStroke(pts([[0, 0], [1, 1]], 0.25), { cyclic: true })]), 'BREAKDOWN');
    doc.grease_pencils = { [gp.id]: gp };
    const back = decodeDocument(encodeDocument(doc)).doc;
    const g2 = back.grease_pencils![gp.id];
    expect(g2.layers[0].frames[0]).toMatchObject({ frame_number: 3, keyframe_type: 'BREAKDOWN' });
    const d2 = g2.drawings[0];
    expect(d2.radius).toBeInstanceOf(Float32Array);
    expect([...d2.radius]).toEqual([0.25, 0.25]);
    expect([...d2.cyclic]).toEqual([1]);
    const snap = cloneShared(doc);
    expect(snap.grease_pencils![gp.id].drawings[0].position).toBe(gp.drawings[0].position);
  });
});
