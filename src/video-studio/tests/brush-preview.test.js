import { it, expect, afterEach } from 'vitest';
import { fixture, clip, onMain } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { defaultMask } from '../src/model/masks.js';
import { defaultRegion } from '../src/model/removal.js';
import { clipLayer } from '../src/engine/scene.js';
import { Compositor } from '../src/engine/compositor.js';
import { sourceToProject, maskToSource } from '../src/engine/mask-shapes.js';
import { createMaskOverlay } from '../src/ui/mask-overlay.js';
import { createRemovalOverlay } from '../src/ui/removal-overlay.js';
import { maskEdit } from '../src/ui/mask-edit-state.js';
import { removeEdit } from '../src/ui/remove-edit-state.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { findClip } from '../src/model/timeline.js';

const overlays = [];
afterEach(() => { overlays.splice(0).forEach(o => o.dispose()); document.body.replaceChildren(); maskEdit.cursor = removeEdit.cursor = null; });
function setup(kind, nested = false) {
  const p = fixture(); let [c] = onMain(p, clip('video', 0, 4));
  Object.assign(c.transform, { sx: 2, sy: 0.5 });
  c.crop = { l: 0.1, r: 0.2, t: 0.05, b: 0.15 };
  if (nested) {
    c.transform.rotation = 37;
    const group = createCompound(p, [c.id], { ripple: false });
    Object.assign(group.transform, { sx: 1.8, sy: 0.7, rotation: 23, flipH: true });
    [c] = breakApart(p, group.id);
  }
  const shape = kind === 'mask' ? defaultMask('brush') : defaultRegion('brush');
  Object.assign(shape, { rotation: 31 });
  shape.strokes = [{ size: 0.1, erase: false, pts: [0.1, -0.05, 0.2, 0.12] }, { size: 0.05, erase: true, pts: [0.15, 0] }];
  if (kind === 'mask') c.masks = [shape]; else c.removal = { on: true, feather: 0, regions: [shape] };
  maskEdit.set({ index: 0, brush: { size: 0.1, erase: false }, cursor: null });
  removeEdit.set({ index: 0, size: 0.1, tool: 'brush', show: true, cursor: null });
  const stage = document.createElement('div'); document.body.append(stage);
  const store = new EditorStore(p), ctx = { store }, id = c.id;
  ctx.actions = createActions(ctx);
  const current = () => findClip(store.project, id).clip;
  const overlay = (kind === 'mask' ? createMaskOverlay : createRemovalOverlay)({ store, actions: ctx.actions, stage });
  stage.append(overlay.el);
  let layer, box;
  const draw = () => {
    layer = clipLayer(store.project, current(), 0, 0);
    box = Compositor.prototype.layerBox.call({ projW: 1920, projH: 1080 }, layer, { width: layer.width, height: layer.height });
    overlay.draw(layer, box, 0.25, 480, 270);
  };
  const off = store.on('change', draw);
  overlays.push({ dispose() { off(); overlay.dispose(); } });
  draw();
  const project = (x, y) => sourceToProject(layer, box, layer.width, layer.height, x, y).map(v => v * 0.25);
  return { p, store, get c() { return current(); }, get shape() { return kind === 'mask' ? current().masks[0] : current().removal.regions[0]; }, overlay, draw, project };
}
function mapped(node, point) {
  for (let el = node; el && el.tagName !== 'svg'; el = el.parentElement) {
    const raw = el.getAttribute('transform');
    if (!raw) continue;
    const m = raw.match(/matrix\(([^)]+)\)/)[1].trim().split(/[ ,]+/).map(Number);
    point = [m[0] * point[0] + m[2] * point[1] + m[4], m[1] * point[0] + m[3] * point[1] + m[5]];
  }
  return point;
}
function circlePoint(node, angle) {
  const circle = node.tagName === 'circle';
  const center = circle ? ['cx', 'cy'].map(k => Number(node.getAttribute(k))) : node.getAttribute('d').match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi).slice(0, 2).map(Number);
  const r = circle ? Number(node.getAttribute('r')) : Number(node.getAttribute('stroke-width')) / 2;
  return mapped(node, [center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)]);
}
const angles = Array.from({ length: 16 }, (_, i) => i * Math.PI / 8);
const close = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
function checkCursor(env, size, at = [240, 135]) {
  const cursor = env.overlay.el.querySelector('.mask-brush-cursor');
  const center = env.project(960, 540), radius = size * 1080 / 2;
  for (const a of angles) {
    const edge = env.project(960 + radius * Math.cos(a), 540 + radius * Math.sin(a));
    close(circlePoint(cursor, a), edge.map((v, i) => at[i] + v - center[i]));
  }
}

it.each(['mask', 'removal'])('shows the %s brush footprint through unequal axes', kind => {
  const env = setup(kind);
  env.overlay.el.dispatchEvent(new MouseEvent('pointermove', { clientX: 240, clientY: 135 }));
  checkCursor(env, 0.1);
});

it.each(['mask', 'removal'])('updates the %s cursor through shear, crop, flips, brush size and redraw', kind => {
  const env = setup(kind, true);
  env.overlay.el.dispatchEvent(new MouseEvent('pointermove', { clientX: 240, clientY: 135 }));
  checkCursor(env, 0.1);
  if (kind === 'mask') maskEdit.set({ brush: { size: 0.2, erase: true } }); else removeEdit.set({ size: 0.2, tool: 'erase' });
  env.c.transform.rotation += 18; env.draw();
  checkCursor(env, 0.2);
  expect(env.overlay.el.querySelector('.mask-brush-cursor').classList.contains('erase')).toBe(true);
  env.overlay.el.dispatchEvent(new MouseEvent('pointerleave'));
  expect(env.overlay.el.querySelector('.mask-brush-cursor')).toBeNull();
});

it.each([false, true])('projects painted and erased removal strokes as source circles (nested %s)', nested => {
  const env = setup('removal', nested);
  const nodes = [...env.overlay.el.querySelectorAll('mask path, mask circle')];
  expect(nodes).toHaveLength(2);
  env.shape.strokes.forEach((stroke, index) => {
    const cx = stroke.pts[0] * 1920 * env.shape.w, cy = stroke.pts[1] * 1080 * env.shape.h;
    const radius = stroke.size * Math.min(1920 * env.shape.w, 1080 * env.shape.h) / 2;
    for (const a of angles) {
      const source = maskToSource(env.shape, 1920, 1080, cx + radius * Math.cos(a), cy + radius * Math.sin(a));
      close(circlePoint(nodes[index], a), env.project(...source));
    }
  });
});

it.each(['mask', 'removal'])('paints undoable %s strokes through the displayed picture', kind => {
  const env = setup(kind, true), original = structuredClone(env.shape.strokes);
  const at = env.project(1100, 600), end = env.project(1200, 650);
  const fire = (el, type, p) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: p[0], clientY: p[1] }));
  fire(env.overlay.el, 'pointermove', at);
  fire(env.overlay.el.querySelector(kind === 'mask' ? '[data-mh=paint]' : '[data-rh=paint]'), 'pointerdown', at);
  fire(env.overlay.el, 'pointermove', end);
  fire(env.overlay.el, 'pointerup', end);
  expect(env.shape.strokes).toHaveLength(original.length + 1);
  expect(env.shape.strokes.at(-1).pts).toHaveLength(4);
  env.store.undo(); expect(env.shape.strokes).toEqual(original);
  env.store.redo(); expect(env.shape.strokes).toHaveLength(original.length + 1);
});

it('uses the selected removal region’s brush units, including the eraser fallback', () => {
  const env = setup('removal', true);
  Object.assign(env.shape, { w: 0.5, h: 0.5 }); env.draw();
  env.overlay.el.dispatchEvent(new MouseEvent('pointermove', { clientX: 240, clientY: 135 }));
  checkCursor(env, 0.05);
  env.c.removal.regions.push(defaultRegion('rectangle'));
  removeEdit.set({ index: 1, tool: 'erase' }); env.draw();
  checkCursor(env, 0.05);
});

it('keeps the mask cursor at the pointer throughout a paint drag and redraw', () => {
  const env = setup('mask', true), at = env.project(1100, 600), end = env.project(1200, 650);
  const fire = (el, type, p) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: p[0], clientY: p[1] }));
  fire(env.overlay.el, 'pointermove', at);
  fire(env.overlay.el.querySelector('[data-mh=paint]'), 'pointerdown', at);
  fire(env.overlay.el, 'pointermove', end);
  close(mapped(env.overlay.el.querySelector('.mask-brush-cursor'), [0, 0]), end);
  env.draw();
  close(mapped(env.overlay.el.querySelector('.mask-brush-cursor'), [0, 0]), end);
  fire(env.overlay.el, 'pointerup', end);
});
