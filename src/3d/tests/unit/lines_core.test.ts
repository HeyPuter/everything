import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { extractFeatures, F, type FeatureMesh } from '../../src/lines/core/features';
import { Occlusion, visibilityPieces, clipSegment, type LineCamera } from '../../src/lines/core/visibility';
import { chainPieces, splitStrokes, selectAndSort, dashes, type SV } from '../../src/lines/core/chain';
import { styleStrokes, resample, blendValue } from '../../src/lines/core/style';
import { rasterizeStrokes } from '../../src/lines/core/raster';
import { renderLines, edgeTypeSelected } from '../../src/lines/core/pipeline';
import { newLineSet, newLineStyle, defaultFreestyleSettings, newLineStyleModifier } from '../../src/lines/defaults';
import type { LineStyleData } from '../../src/lines/types';

function cube(size = 1, offset: [number, number, number] = [0, 0, 0]) {
  const s = size / 2;
  const P: number[] = [];
  for (const [x, y, z] of [
    [-s, -s, -s],
    [s, -s, -s],
    [s, s, -s],
    [-s, s, -s],
    [-s, -s, s],
    [s, -s, s],
    [s, s, s],
    [-s, s, s],
  ])
    P.push(x + offset[0], y + offset[1], z + offset[2]);
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  return { positions: new Float32Array(P), offsets: new Uint32Array([0, 4, 8, 12, 16, 20, 24]), indices: new Uint32Array(faces.flat()) };
}

function camera(eye: [number, number, number], W = 200, H = 200): LineCamera {
  const c = new PerspectiveCamera(40, W / H, 0.1, 100);
  c.up.set(0, 0, 1);
  c.position.set(...eye);
  c.lookAt(new Vector3(0, 0, 0));
  c.updateMatrixWorld(true);
  const vp = c.projectionMatrix.clone().multiply(c.matrixWorldInverse);
  const dir = new Vector3(0, 0, -1).applyQuaternion(c.quaternion);
  return { viewProj: vp.elements, width: W, height: H, view: { ortho: false, eye, dir: [dir.x, dir.y, dir.z] } };
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('feature edges', () => {
  it('finds silhouettes and creases of a cube', () => {
    const c = cube();
    const fm: FeatureMesh = { ...c, object: 0 };
    const cam = camera([4, -5, 3]);
    const edges = extractFeatures(fm, cam.view, { creaseAngle: (134 * Math.PI) / 180 });
    // every cube edge is a crease (90°)
    expect(edges.length).toBe(12);
    expect(edges.every((e) => e.flags & F.CREASE)).toBe(true);
    // seen from a corner direction: 6 silhouette edges
    expect(edges.filter((e) => e.flags & F.SILHOUETTE).length).toBe(6);
  });

  it('marks material boundaries and edge marks', () => {
    const c = cube();
    const marks = new Uint8Array(24);
    marks[0] = 1; // first corner of the bottom face: edge 0-3
    const fm: FeatureMesh = { ...c, object: 0, material_index: new Uint16Array([0, 1, 0, 0, 0, 0]), edgeMarks: marks };
    const edges = extractFeatures(fm, camera([4, -5, 3]).view, { creaseAngle: 0.1 });
    expect(edges.filter((e) => e.flags & F.MATERIAL).length).toBe(4);
    const marked = edges.filter((e) => e.flags & F.EDGE_MARK);
    expect(marked.length).toBe(1);
    expect([marked[0].ia, marked[0].ib].sort()).toEqual([0, 3]);
  });
});

describe('visibility', () => {
  it('splits edges into visible and hidden pieces', () => {
    const c = cube();
    const cam = camera([4, -5, 3]);
    const edges = extractFeatures({ ...c, object: 0 }, cam.view, { creaseAngle: 2.3 });
    const occ = new Occlusion([{ ...c, world: identity, object: 0 }]);
    const pieces = visibilityPieces(edges, cam, occ, { maxQi: 5 });
    const visible = new Set(pieces.filter((p) => p.qi === 0).map((p) => p.edge));
    const hidden = new Set(pieces.filter((p) => p.qi > 0).map((p) => p.edge));
    // a cube seen from a corner: 9 visible edges, 3 hidden ones
    expect(visible.size).toBe(9);
    expect(hidden.size).toBe(3);
  });

  it('hides lines behind another object', () => {
    const back = cube(1, [0, 3, 0]);
    const front = cube(2, [0, 0, 0]);
    const cam = camera([0, -8, 0]);
    // camera looks along +Y at the origin: the small cube behind is fully hidden
    const edges = extractFeatures({ ...back, object: 1 }, cam.view, { creaseAngle: 2.3 });
    const occ = new Occlusion([
      { ...front, world: identity, object: 0 },
      { ...back, world: identity, object: 1 },
    ]);
    const pieces = visibilityPieces(edges, cam, occ, { maxQi: 3 });
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.every((p) => p.qi > 0)).toBe(true);
  });

  it('clips segments to the view volume', () => {
    const cam = camera([0, -8, 0]);
    expect(clipSegment(cam, [0, 0, 0], [1, 0, 0])).toEqual([0, 1]);
    // behind the camera
    expect(clipSegment(cam, [0, -10, 0], [1, -10, 0])).toBeNull();
    const r = clipSegment(cam, [0, 0, 0], [0, -20, 0]);
    expect(r).not.toBeNull();
    expect(r![1]).toBeLessThan(1);
  });

  it('finds contours and external contours', () => {
    const c = cube();
    const cam = camera([4, -5, 3]);
    const edges = extractFeatures({ ...c, object: 0 }, cam.view, { creaseAngle: 2.3 });
    const occ = new Occlusion([{ ...c, world: identity, object: 0 }]);
    const pieces = visibilityPieces(edges, cam, occ, { contours: true });
    const ext = pieces.filter((p) => p.flags & F.EXTERNAL_CONTOUR);
    expect(ext.length).toBe(6);
  });
});

const sv = (x: number, y: number): SV => ({ x, y, dist: 5, p: [x, y, 0], mat: 0, obj: 0, angle: Math.PI / 2, curv: 0, side: 0 });

describe('chaining and styling', () => {
  it('chains the visible outline of a cube into one closed stroke', () => {
    const c = cube();
    const cam = camera([4, -5, 3]);
    const edges = extractFeatures({ ...c, object: 0 }, cam.view, { creaseAngle: 2.3 });
    const occ = new Occlusion([{ ...c, world: identity, object: 0 }]);
    const sil = visibilityPieces(edges, cam, occ).filter((p) => p.qi === 0 && p.flags & F.SILHOUETTE);
    const strokes = chainPieces(sil, cam, { use_chaining: true, chaining: 'PLAIN', rounds: 3 });
    expect(strokes.length).toBe(1);
    expect(strokes[0].pts.length).toBe(7);
    const unchained = chainPieces(sil, cam, { use_chaining: false, chaining: 'PLAIN', rounds: 3 });
    expect(unchained.length).toBe(6);
  });

  it('splits, selects and sorts strokes', () => {
    const long = { pts: [sv(0, 0), sv(100, 0)], qi: 0, flags: 0 };
    const short = { pts: [sv(0, 10), sv(5, 10)], qi: 0, flags: 0 };
    expect(splitStrokes([long], { use_split_length: true, split_length: 30 }).length).toBe(4);
    expect(dashes([long], [10, 10, 0, 0, 0, 0]).length).toBe(5);
    expect(selectAndSort([long, short], { use_length_min: true, length_min: 10 }).length).toBe(1);
    const sorted = selectAndSort([short, long], { use_sorting: true, sort_key: '2D_LENGTH', sort_order: 'REVERSE' });
    expect(sorted[0]).toBe(long);
    const angled = { pts: [sv(0, 0), sv(10, 0), sv(10, 10)], qi: 0, flags: 0 };
    expect(splitStrokes([angled], { use_angle_max: true, angle_max: Math.PI / 4 }).length).toBe(2);
  });

  it('applies colour, alpha and thickness modifiers', () => {
    const ls = { ...newLineStyle(), id: 'ls' } as LineStyleData;
    ls.geometry_modifiers = [];
    ls.color = [1, 0, 0];
    const along = newLineStyleModifier('thickness', 'ALONG_STROKE');
    along.value_min = 0;
    along.value_max = 10;
    ls.thickness_modifiers.push(along);
    const alpha = newLineStyleModifier('alpha', 'ALONG_STROKE');
    alpha.invert = true;
    ls.alpha_modifiers.push(alpha);
    const out = styleStrokes([{ pts: [sv(0, 0), sv(50, 0), sv(100, 0)], qi: 0, flags: 0 }], ls, { thicknessScale: 1 });
    expect(out.length).toBe(1);
    const s = out[0];
    expect(s.r[0]).toBe(1);
    expect(s.tl[0] + s.tr[0]).toBeCloseTo(0);
    expect(s.tl[2] + s.tr[2]).toBeCloseTo(10);
    expect(s.a[0]).toBeCloseTo(1);
    expect(s.a[2]).toBeCloseTo(0);
    expect(blendValue('MULTIPLY', 4, 0.5, 1)).toBe(2);
  });

  it('resamples and dashes strokes', () => {
    const pts = resample([sv(0, 0), sv(100, 0)], 10);
    expect(pts.length).toBe(11);
    const ls = { ...newLineStyle(), id: 'ls' } as LineStyleData;
    ls.use_dashed_line = true;
    ls.dash1 = 20;
    ls.gap1 = 10;
    const out = styleStrokes([{ pts: [sv(0, 0), sv(100, 0)], qi: 0, flags: 0 }], ls, { thicknessScale: 1 });
    expect(out.length).toBe(4);
  });
});

describe('raster', () => {
  it('draws an anti-aliased stroke over an image', () => {
    const W = 40,
      H = 20;
    const s = { x: new Float32Array([5, 35]), y: new Float32Array([10, 10]), r: new Float32Array([1, 1]), g: new Float32Array([0, 0]), b: new Float32Array([0, 0]), a: new Float32Array([1, 1]), tl: new Float32Array([2, 2]), tr: new Float32Array([2, 2]), caps: 'BUTT' as const };
    const img = rasterizeStrokes([s], W, H);
    const at = (x: number, y: number) => img[(y * W + x) * 4 + 3];
    expect(at(20, 10)).toBeCloseTo(1);
    expect(at(20, 9)).toBeCloseTo(1);
    expect(at(20, 2)).toBe(0);
    // butt caps: nothing left of the start
    expect(at(2, 10)).toBe(0);
    s.caps = 'ROUND' as never;
    const img2 = rasterizeStrokes([s], W, H);
    expect(img2[(10 * W + 4) * 4 + 3]).toBeGreaterThan(0.5);
  });
});

describe('pipeline', () => {
  it('renders a cube outline with the default line set', () => {
    const c = cube();
    const cam = camera([4, -5, 3], 120, 120);
    const fs = defaultFreestyleSettings();
    fs.linesets.push(newLineSet('LineSet', 'ls'));
    const ls = { ...newLineStyle(), id: 'ls' } as LineStyleData;
    const { layer, strokes } = renderLines({ objects: [{ id: 'ob', ...c, world: identity, materials: [] }], camera: cam, settings: fs, linestyles: { ls }, thicknessScale: 1 });
    expect(strokes).toBeGreaterThan(0);
    let covered = 0;
    for (let i = 3; i < layer.length; i += 4) if (layer[i] > 0.5) covered++;
    expect(covered).toBeGreaterThan(200);
    // the visible corner nearest the camera projects to the centre; the image corners stay empty
    expect(layer[(60 * 120 + 60) * 4 + 3]).toBeGreaterThan(0);
    expect(layer[(2 * 120 + 2) * 4 + 3]).toBe(0);
  });

  it('selects edge types with exclusion and negation', () => {
    const set = newLineSet();
    expect(edgeTypeSelected(set, F.CREASE)).toBe(true);
    expect(edgeTypeSelected(set, F.MATERIAL)).toBe(false);
    set.exclude_crease = true;
    expect(edgeTypeSelected(set, F.MATERIAL)).toBe(true);
    set.edge_type_negation = 'EXCLUSIVE';
    expect(edgeTypeSelected(set, F.MATERIAL)).toBe(false);
  });
});

describe('intersections', () => {
  it('finds where two cubes cut through each other', async () => {
    const { intersectionEdges } = await import('../../src/lines/core/intersections');
    const a = cube(2),
      b = cube(2, [1, 1, 1]);
    const edges = intersectionEdges(
      [
        { ...a, world: identity, object: 0 },
        { ...b, world: identity, object: 1 },
      ],
      () => true,
    );
    expect(edges.length).toBeGreaterThan(0);
    // every intersection point lies on both cubes' surfaces (within the overlap box 0..1)
    for (const e of edges) for (const p of [e.pa, e.pb]) for (const c of p) expect(c).toBeGreaterThan(-1e-4), expect(c).toBeLessThan(1 + 1e-4);
    // separated cubes do not intersect
    expect(intersectionEdges([{ ...cube(1), world: identity, object: 0 }, { ...cube(1, [5, 0, 0]), world: identity, object: 1 }], () => true).length).toBe(0);
  });
});

describe('occlusion weights', () => {
  it('faces with zero weight let lines show through', () => {
    const back = cube(1, [0, 3, 0]);
    const front = cube(2, [0, 0, 0]);
    const cam = camera([0, -8, 0]);
    const edges = extractFeatures({ ...back, object: 1 }, cam.view, { creaseAngle: 2.3 });
    const make = (w?: Uint8Array) =>
      new Occlusion([
        { ...front, world: identity, object: 0, faceWeight: w },
        { ...back, world: identity, object: 1 },
      ]);
    expect(visibilityPieces(edges, cam, make()).some((p) => p.qi === 0)).toBe(false);
    expect(visibilityPieces(edges, cam, make(new Uint8Array(6))).some((p) => p.qi === 0)).toBe(true);
    // double weight: the front cube hides twice per crossing
    const qi2 = visibilityPieces(edges, cam, make(new Uint8Array(6).fill(2)), { maxQi: 10 });
    expect(Math.min(...qi2.map((p) => p.qi))).toBeGreaterThanOrEqual(4);
  });
});
