import { describe, it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { normalizeProject } from '../src/model/project.js';
import { valueAt } from '../src/model/keyframes.js';
import { motionSamples } from '../src/model/clip-extras.js';
import { poseMatrix, placePose } from '../src/lib/geometry.js';
import { evaluate, motionStateAt } from '../src/engine/scene.js';
import { Compositor } from '../src/engine/compositor.js';
import { sourceToProject, projectToSource } from '../src/engine/mask-shapes.js';

const FREE = { ripple: false, linkOverlays: false };
const points = [[0, 0], [0, 1], [1, 0], [1, 1], [0.3, 0.7]];
function transform([x, y], tr, W, H) {
  const a = tr.rotation * Math.PI / 180;
  const X = x * tr.scale * (tr.sx ?? 1) * (tr.flipH ? -1 : 1);
  const Y = y * tr.scale * (tr.sy ?? 1) * (tr.flipV ? -1 : 1);
  return [tr.x * W + X * Math.cos(a) - Y * Math.sin(a), tr.y * H + X * Math.sin(a) + Y * Math.cos(a)];
}
const close = (actual, expected) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 7));
function check(p, expected, time = s(1)) {
  const { width: W, height: H } = p.settings;
  const layer = evaluate(p, time)[0];
  const comp = Object.assign(Object.create(Compositor.prototype), { projW: W, projH: H });
  const box = comp.layerBox(layer, { width: W, height: H });
  const matrix = comp._matrix(box.cx, box.cy, box.w, box.h, layer.rotation, box.skew);
  points.forEach(([u, v], i) => {
    close(sourceToProject(layer, box, W, H, u * W, v * H), expected[i]);
    close(projectToSource(layer, box, W, H, ...expected[i]), [u * W, v * H]);
    const x = (layer.flipH ? 1 - u : u) - 0.5;
    const y = 0.5 - (layer.flipV ? 1 - v : v);
    const gx = (matrix[0] * x + matrix[3] * y + matrix[6] + 1) * W / 2;
    const gy = (1 - matrix[1] * x - matrix[4] * y - matrix[7]) * H / 2;
    expect(gx).toBeCloseTo(expected[i][0], 3); expect(gy).toBeCloseTo(expected[i][1], 3);
  });
}

describe('compound affine geometry', () => {
  it.each([
    { sx: 2, sy: 0.5 },
    { sx: 2, sy: 0.5, rotation: 25 },
    { sx: 2, sy: 0.5, rotation: 25, flipH: true },
    { sx: 0.5, sy: 2, rotation: -35, flipV: true },
    { rotation: 25, flipH: true },
    { rotation: 25, flipV: true },
    { sx: 2, sy: 0.5, rotation: 25, flipH: true, flipV: true },
  ])('preserves every source corner through nested scaling and flattening (%j)', patch => {
    const p = fixture(); const { width: W, height: H } = p.settings;
    const [v] = onMain(p, clip('video', 0, 4));
    Object.assign(v.transform, { x: 0.13, y: -0.07, scale: 0.6, rotation: 37, sx: 1.3, sy: 0.8, flipV: true });
    const child = structuredClone(v.transform);
    const c = createCompound(p, [v.id], FREE);
    Object.assign(c.transform, { x: -0.1, y: 0.04, scale: 0.7, uniform: false, ...patch });
    const expected = points.map(([u, v]) => transform(transform([(u - 0.5) * W, (v - 0.5) * H], child, W, H), c.transform, W, H)).map(([x, y]) => [x + W / 2, y + H / 2]);
    check(p, expected);
    check(normalizeProject(JSON.parse(JSON.stringify(p))), expected);
    breakApart(p, c.id, FREE);
    check(p, expected);
    check(normalizeProject(JSON.parse(JSON.stringify(p))), expected);
  });
});


it('preserves nested, animated group axes and motion-blur samples after flattening and save', () => {
  const p = fixture(); const { width: W, height: H } = p.settings;
  const [v] = onMain(p, clip('video', 0, 4));
  Object.assign(v.transform, { x: 0.1, y: -0.1, rotation: 31, scale: 0.4, flipH: true });
  v.keyframes.rotation = [{ t: 0, v: 15, ease: 'linear' }, { t: s(4), v: 65, ease: 'linear' }];
  v.motionBlur = { on: true, amount: 100 };
  const child = structuredClone(v);
  const inner = createCompound(p, [v.id], FREE);
  Object.assign(inner.transform, { sx: 1.8, sy: 0.5, rotation: -27, flipV: true, uniform: false });
  inner.keyframes.sx = [{ t: 0, v: 1.5, ease: 'linear' }, { t: s(4), v: 2.5, ease: 'linear' }];
  const outer = createCompound(p, [inner.id], FREE);
  Object.assign(outer.transform, { x: -0.1, y: 0.05, sx: 0.7, sy: 1.7, rotation: 43, flipH: true, uniform: false });
  const parents = [structuredClone(inner), structuredClone(outer)];
  const verify = project => {
    for (const time of [s(0.5), s(1.5), s(3)]) {
      const poses = [child, ...parents].map(c => ({ ...c.transform, ...Object.fromEntries(Object.keys(c.keyframes).map(prop => [prop, valueAt(c.keyframes, prop, time, c.transform[prop])])) }));
      const expected = points.map(([u, v]) => poses.reduce((point, tr) => transform(point, tr, W, H), [(u - 0.5) * W, (v - 0.5) * H])).map(([x, y]) => [x + W / 2, y + H / 2]);
      check(project, expected, time);
      const layer = evaluate(project, time)[0];
      const samples = motionSamples(t => motionStateAt(child, t), time, project.settings.fps, 100);
      expect(layer.extras.motion).toHaveLength(samples.length);
      samples.forEach((sample, i) => {
        const actual = { ...layer.extras.motion[i], flipH: layer.flipH, flipV: layer.flipV };
        const matrix = poseMatrix(actual);
        for (const point of [[0, 0], [400, 150]]) {
          const wanted = poses.slice(1).reduce((point, tr) => transform(point, tr, W, H), transform(point, { ...sample, flipH: true }, W, H));
          close([actual.x * W + matrix[0] * point[0] + matrix[2] * point[1], actual.y * H + matrix[1] * point[0] + matrix[3] * point[1]], wanted);
        }
      });
    }
  };
  verify(p);
  const [nested] = breakApart(p, outer.id, FREE);
  verify(p);
  breakApart(p, nested.id, FREE);
  verify(p);
  verify(normalizeProject(JSON.parse(JSON.stringify(p))));
});

it.each([{ sx: 0, sy: 2 }, { sx: 2, sy: 0 }, { sx: 0, sy: 0 }])('keeps collapsed parent axes finite (%j)', patch => {
  const child = { x: 0.1, y: 0.2, scale: 0.7, rotation: 37, sx: 1.3, sy: 0.8, flipV: true };
  const parent = { x: 0.2, y: -0.1, scale: 0.9, rotation: 25, flipH: true, ...patch };
  const actual = placePose({ ...child }, parent, 1920, 1080), m = poseMatrix(actual);
  expect(Object.values(actual).every(v => typeof v !== 'number' || Number.isFinite(v))).toBe(true);
  for (const point of [[0, 0], [400, 150], [-900, 300]]) {
    close([actual.x * 1920 + m[0] * point[0] + m[2] * point[1], actual.y * 1080 + m[1] * point[0] + m[3] * point[1]], transform(transform(point, child, 1920, 1080), parent, 1920, 1080));
  }
});

it('maps cropped source points through the same geometry for masks and tracking', async () => {
  const { mediaBox, sourcePointToFrame } = await import('../src/ui/tracking-dialog.js');
  const p = fixture(), { width: W, height: H } = p.settings;
  const [v] = onMain(p, clip('video', 0, 4));
  v.crop = { l: 0.1, r: 0.2, t: 0.15, b: 0.05 };
  Object.assign(v.transform, { scale: 0.4, rotation: 37, flipV: true });
  const child = structuredClone(v);
  const parent = createCompound(p, [v.id], FREE);
  Object.assign(parent.transform, { sx: 1.8, sy: 0.6, rotation: 25, flipH: true });
  const layer = evaluate(p, s(1))[0];
  const comp = Object.assign(Object.create(Compositor.prototype), { projW: W, projH: H });
  const box = comp.layerBox(layer, { width: W, height: H });
  const fit = Math.min(W / (W * 0.7), H / (H * 0.8));
  for (const [u, v] of [[0.1, 0.15], [0.8, 0.95], [0.4, 0.3]]) {
    const point = [(u - 0.45) * W * fit, (v - 0.55) * H * fit];
    const [x, y] = transform(transform(point, child.transform, W, H), parent.transform, W, H);
    const expected = [x + W / 2, y + H / 2];
    close(sourceToProject(layer, box, W, H, u * W, v * H), expected);
    close(projectToSource(layer, box, W, H, ...expected), [u * W, v * H]);
    const tracked = sourcePointToFrame(mediaBox(p, layer), u, v);
    close([tracked.x, tracked.y], expected);
  }
});
