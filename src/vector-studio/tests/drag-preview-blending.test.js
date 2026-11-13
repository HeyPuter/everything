import { expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { regionPool } from '../src/render/effects.js';
import { viewHooks } from '../src/render/canvas-view.js';
import { TransformSession, PREVIEW_THRESHOLD } from '../src/tools/transform-session.js';

// An independent one-pixel Canvas compositing oracle. Every painted rectangle
// in these scenes covers the sampled overlap before and after the one-unit move.
// Transparent cache canvases must retain alpha until they meet their backdrop.
function sampleOverlap(view) {
  const states = new Map();
  const instrument = (ctx) => {
    if (states.has(ctx)) return ctx;
    const original = Object.fromEntries(['fill', 'fillRect', 'clearRect', 'drawImage', 'save', 'restore', 'globalAlpha', 'globalCompositeOperation'].map((k) => [k, ctx[k]]));
    const state = { rgba: [0, 0, 0, 0], original };
    const stack = [];
    states.set(ctx, state);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const composite = (source) => {
      const dest = state.rgba;
      const sa = source[3] * ctx.globalAlpha;
      const da = dest[3];
      const alpha = sa + da * (1 - sa);
      const blend = ctx.globalCompositeOperation === 'multiply' ? (s, d) => s * d : (s) => s;
      state.rgba = [0, 1, 2].map((i) => alpha ? ((1 - sa) * da * dest[i] + (1 - da) * sa * source[i] + sa * da * blend(source[i], dest[i])) / alpha : 0).concat(alpha);
    };
    const fill = () => {
      const hex = /^#([0-9a-f]{6})$/i.exec(ctx.fillStyle)?.[1];
      if (hex) composite([0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(1));
    };
    ctx.fill = fill;
    ctx.fillRect = fill;
    ctx.clearRect = () => { state.rgba = [0, 0, 0, 0]; };
    ctx.drawImage = (canvas) => {
      const source = states.get(canvas.getContext('2d'));
      if (source) composite(source.rgba);
    };
    ctx.save = () => stack.push([ctx.globalAlpha, ctx.globalCompositeOperation, ctx.fillStyle]);
    ctx.restore = () => {
      const saved = stack.pop();
      if (saved) [ctx.globalAlpha, ctx.globalCompositeOperation, ctx.fillStyle] = saved;
    };
    return ctx;
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (...args) {
    return instrument(getContext.apply(this, args));
  });
  const acquire = regionPool.acquire;
  const poolSpy = vi.spyOn(regionPool, 'acquire').mockImplementation(function (...args) {
    const layer = acquire.apply(this, args);
    instrument(layer.ctx);
    return layer;
  });
  instrument(view.actx);
  return {
    color: () => states.get(view.actx).rgba,
    restore: () => {
      for (const [ctx, state] of states) Object.assign(ctx, state.original);
      spy.mockRestore();
      poolSpy.mockRestore();
    },
  };
}

function primePanSnapshot(view) {
  const canvas = document.createElement('canvas');
  canvas.width = view.art.width;
  canvas.height = view.art.height;
  canvas.getContext('2d').drawImage(view.art, 0, 0);
  view.snapshot = { canvas, matrix: view.editor.view.matrix.slice() };
  view.lastRenderMs = 20;
  view.fastMode = true;
}

it.each([
  { count: 1, moving: 'background' },
  { count: PREVIEW_THRESHOLD + 1, moving: 'background' },
  { count: PREVIEW_THRESHOLD + 1, moving: 'blend' },
  { count: 1, moving: 'background', kind: 'appearance' },
  { count: PREVIEW_THRESHOLD + 1, moving: 'blend', kind: 'appearance' },
  { count: PREVIEW_THRESHOLD + 1, moving: 'blend', kind: 'group' },
  { count: PREVIEW_THRESHOLD + 1, moving: 'blend', kind: 'isolated' },
  { count: PREVIEW_THRESHOLD + 1, moving: 'blend', kind: 'overprint' },
  { count: 1, moving: 'background', kind: 'overprint-toggle' },
  { count: PREVIEW_THRESHOLD + 1, moving: 'blend', kind: 'overprint-toggle' },
  { count: 1, moving: 'background', kind: 'outline-toggle' },
  { count: PREVIEW_THRESHOLD + 1, moving: 'blend', kind: 'outline-toggle' },
])('preserves Multiply over its backdrop while dragging $count $moving objects ($kind)', ({ count, moving, kind }) => {
  const app = bootApp();
  const ed = app.newDocument();
  const view = app.views.get(ed);
  ed.view.set({ width: 64, height: 64, zoom: 1, panX: 0, panY: 0 });
  view.art.width = view.art.height = 64;
  let background, blend;
  const fillers = [];
  ed.doc.transact('Overlap', () => {
    const add = (fill, blendMode = 'normal', parent = ed.targetLayer().id) => {
      const n = createPath(rectangle(0, 0, 20, 20), true, { fill: fill && { type: 'solid', color: fill }, stroke: null, blendMode });
      ed.doc.insert(n, parent);
      return n.id;
    };
    background = add('#ff0000');
    for (let i = 1; i < count; i++) fillers.push(add(null));
    let group;
    if (kind === 'group' || kind === 'isolated') {
      group = createGroup([], { isolate: kind === 'isolated' });
      ed.doc.insert(group, ed.targetLayer().id);
    }
    blend = add('#00ffff', kind === 'appearance' || kind?.startsWith('overprint') || kind === 'outline-toggle' ? 'normal' : 'multiply', group?.id);
    if (kind === 'appearance') ed.doc.update(blend, { appearance: [{ type: 'fill', base: true, blendMode: 'multiply' }, { type: 'stroke', base: true }] });
    if (kind?.startsWith('overprint')) ed.doc.update(blend, { overprintFill: true });
    if (group) blend = group.id;
  });
  ed.select([moving === 'background' ? background : blend, ...fillers]);
  ed.viewOptions.overprint = kind === 'overprint';
  const overprintOptions = (editor, options) => ({ ...options, overprint: editor.viewOptions.overprint });
  viewHooks.artOptions.push(overprintOptions);
  let expected = kind === 'isolated' || kind?.endsWith('toggle') ? [0, 1, 1, 1] : [0, 0, 0, 1];
  const pixel = sampleOverlap(view);
  let session;
  try {
    view.renderNow();
    expect(pixel.color()).toEqual(expected);
    session = new TransformSession(ed, 'Move');
    session.apply([1, 0, 0, 1, 1, 0]);
    view.slowScene = true;
    view.renderNow();
    expect(pixel.color()).toEqual(expected);
    if (kind === 'isolated') expect(ed.dragPreview).toBeTruthy();
    if (kind?.endsWith('toggle')) {
      expect(ed.dragPreview || view.interaction).toBeTruthy();
      if (count > PREVIEW_THRESHOLD) primePanSnapshot(view);
      ed.setViewOption(kind === 'outline-toggle' ? 'mode' : 'overprint', kind === 'outline-toggle' ? 'outline' : true);
      view.slowScene = true;
      view.renderNow();
      expected = kind === 'outline-toggle' ? [1, 1, 1, 1] : [0, 0, 0, 1];
      expect(pixel.color()).toEqual(expected);
    }
    session.commit();
    view.renderNow();
    expect(pixel.color()).toEqual(expected);
  } finally {
    if (ed.doc.tx) session?.cancel();
    pixel.restore();
    viewHooks.artOptions.splice(viewHooks.artOptions.indexOf(overprintOptions), 1);
  }
});

it.each([1, PREVIEW_THRESHOLD + 1])('refreshes cached pasteboard colors during a %s-object drag', (count) => {
  const app = bootApp();
  const ed = app.newDocument();
  const view = app.views.get(ed);
  ed.view.set({ width: 64, height: 64, zoom: 1, panX: 0, panY: 0 });
  view.art.width = view.art.height = 64;
  ed.setViewOption('artboards', false);
  view.host.style.setProperty('--pasteboard', '#111111');
  const ids = [];
  ed.doc.transact('Geometry', () => {
    for (let i = 0; i < count; i++) {
      const n = createPath(rectangle(0, 0, 20, 20), true, { fill: null, stroke: null });
      ed.doc.insert(n, ed.targetLayer().id);
      ids.push(n.id);
    }
  });
  ed.select(ids);
  const pixel = sampleOverlap(view);
  const session = new TransformSession(ed, 'Move');
  try {
    session.apply([1, 0, 0, 1, 1, 0]);
    view.slowScene = true;
    view.renderNow();
    expect(pixel.color()).toEqual([17 / 255, 17 / 255, 17 / 255, 1]);
    if (count > PREVIEW_THRESHOLD) primePanSnapshot(view);
    view.host.style.setProperty('--pasteboard', '#222222');
    view.refreshColors();
    view.slowScene = true;
    view.renderNow();
    expect(pixel.color()).toEqual([34 / 255, 34 / 255, 34 / 255, 1]);
  } finally {
    session.cancel();
    pixel.restore();
  }
});
