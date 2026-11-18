import { it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { clipLayer } from '../src/engine/scene.js';
import { pinKeys } from '../src/ui/tracking-dialog.js';
import { normalizeProject } from '../src/model/project.js';
import { mainTrack } from '../src/model/timeline.js';
import { EditorStore } from '../src/model/store.js';

function targetInGroup(transform, animated = false) {
  const p = fixture(); const [v] = onMain(p, clip('video', 1, 4));
  Object.assign(v.transform, { x: 0.12, y: -0.08, rotation: 15 });
  v.keyframes.x = [{ t: 0, v: 0.12 }, { t: s(4), v: -0.1 }];
  const c = createCompound(p, [v.id], { ripple: false });
  Object.assign(c.transform, transform);
  if (animated) {
    c.animLoop = { id: 'float', duration: s(3) };
    c.keyframes = {
      x: [{ t: 0, v: -0.1 }, { t: s(4), v: 0.2 }],
      rotation: [{ t: 0, v: -20 }, { t: s(4), v: 40 }],
      sx: [{ t: 0, v: 0.6 }, { t: s(4), v: 2.5 }],
    };
  }
  return { p, target: breakApart(p, c.id)[0] };
}
const location = (p, c, t) => { const l = clipLayer(p, c, t, 0); return { x: l.x * p.settings.width, y: l.y * p.settings.height }; };
const points = [1, 1.7, 2.4, 3.1, 4.5].map((t, i) => ({ t: s(t), x: 800 + i * 60, y: 420 + i * 25 }));
const ref = points[2];
function check(p, target, pts = points, reference = ref, tolerance = 1e-5) {
  const before = location(p, target, reference.t), original = JSON.stringify(target);
  const keys = pinKeys(p, target, pts, reference.t);
  expect(JSON.stringify(target)).toBe(original);
  target.keyframes = { ...target.keyframes, ...keys };
  for (const point of pts) {
    const actual = location(p, target, point.t);
    expect(Math.abs(actual.x - before.x - point.x + reference.x)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(actual.y - before.y - point.y + reference.y)).toBeLessThanOrEqual(tolerance);
  }
  return before;
}

it.each([{ sx: 2 }, { sx: 1.8, sy: 0.7, rotation: 35, flipH: true }, { sx: 0.4, sy: 2.5, rotation: -65, flipV: true }])('pins through retained axes %j', transform => {
  const { p, target } = targetInGroup(transform);
  const before = check(p, target);
  const q = normalizeProject(JSON.parse(JSON.stringify(p))), saved = mainTrack(q).clips[0];
  for (const pt of points) {
    const actual = location(q, saved, pt.t);
    expect(actual.x).toBeCloseTo(before.x + pt.x - ref.x, 5);
    expect(actual.y).toBeCloseTo(before.y + pt.y - ref.y, 5);
  }
});

it('compensates animated and nested group motion at each tracked time', () => {
  const { p, target } = targetInGroup({ sx: 1.8, sy: 0.7, flipH: true }, true);
  const c = createCompound(p, [target.id], { ripple: false });
  Object.assign(c.transform, { sx: 0.7, sy: 1.6, rotation: 25 });
  c.keyframes.y = [{ t: 0, v: 0 }, { t: s(4), v: 0.2 }];
  const [child] = breakApart(p, c.id);
  check(p, child);
});

it('keeps the displayed offset for a target with its own position animation', () => {
  const { p, target } = targetInGroup({ sx: 1.8, sy: 0.7, rotation: 35 });
  target.animLoop = { id: 'orbit', duration: s(3) };
  check(p, target);
});

it('bounds simplification error in displayed pixels when group motion magnifies local keys', () => {
  const { p, target } = targetInGroup({ sx: 30, sy: 20, rotation: 35, flipH: true });
  const pts = Array.from({ length: 60 }, (_, i) => ({ t: s(1 + i / 20), x: 800 + i * 3, y: 420 + Math.sin(i / 4) * 20 }));
  check(p, target, pts, pts[0], 3);
});

it('makes finite keys when a parent axis collapses, then follows after it reopens', () => {
  const { p, target } = targetInGroup({ sx: 0, sy: 1 });
  target.inherited[0].parent.keyframes.sx = [{ t: 0, v: 0 }, { t: s(4), v: 2 }];
  const keys = pinKeys(p, target, points, ref.t);
  expect([...keys.x, ...keys.y].every(k => Number.isFinite(k.v))).toBe(true);
});

it('supports undo and redo without changing the retained group', () => {
  const { p, target } = targetInGroup({ sx: 2, sy: 0.5, rotation: 20 });
  const store = new EditorStore(p), before = location(p, target, ref.t);
  const inherited = structuredClone(target.inherited);
  const keys = pinKeys(p, target, points, ref.t);
  store.update('Track motion', p => { Object.assign(mainTrack(p).clips[0].keyframes, keys); });
  expect(mainTrack(store.project).clips[0].inherited).toEqual(inherited);
  store.undo(); expect(location(store.project, mainTrack(store.project).clips[0], ref.t)).toEqual(before);
  store.redo(); const last = points.at(-1), pos = location(store.project, mainTrack(store.project).clips[0], last.t);
  expect(pos.x).toBeCloseTo(before.x + last.x - ref.x, 5);
});

it('does not amplify floating-point noise into huge keys for rotated collapsed groups', () => {
  const { p, target } = targetInGroup({ sx: 2, sy: 1, rotation: 35 });
  const outer = createCompound(p, [target.id], { ripple: false });
  Object.assign(outer.transform, { sx: 0, sy: 1.5, rotation: 20 });
  const [child] = breakApart(p, outer.id);
  const keys = pinKeys(p, child, points, ref.t);
  expect([...keys.x, ...keys.y].every(k => Number.isFinite(k.v) && Math.abs(k.v) < 1)).toBe(true);
});
