import { describe, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { TransformSession, PREVIEW_THRESHOLD } from '../src/tools/transform-session.js';

// Record paint order through bitmap blits as well as direct drawing. This catches
// ordering errors that inspecting the document tree or selection cannot detect.
function recordPaint(view) {
  const contexts = new Map();
  const getContext = HTMLCanvasElement.prototype.getContext;
  const instrument = (ctx) => {
    if (contexts.has(ctx)) return ctx;
    const original = { fill: ctx.fill, clearRect: ctx.clearRect, drawImage: ctx.drawImage };
    const colors = [];
    contexts.set(ctx, { original, colors });
    ctx.fill = function () { colors.push(this.fillStyle); };
    ctx.clearRect = () => { colors.length = 0; };
    ctx.drawImage = (canvas) => {
      const source = contexts.get(canvas.getContext('2d'));
      if (source) colors.push(...source.colors);
    };
    return ctx;
  };
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (...args) {
    return instrument(getContext.apply(this, args));
  });
  instrument(view.actx);
  return {
    colors: () => contexts.get(view.actx).colors.filter((c) => ['#ff0000', '#00ff00', '#0000ff'].includes(c)),
    reset: () => { contexts.get(view.actx).colors.length = 0; },
    restore: () => {
      for (const [ctx, { original }] of contexts) Object.assign(ctx, original);
      spy.mockRestore();
    },
  };
}

function scene({ hidden = false } = {}) {
  const app = bootApp();
  const ed = app.newDocument();
  ed.view.set({ width: 500, height: 500, zoom: 1, panX: 0, panY: 0 });
  const ids = [];
  ed.doc.transact('Stack', () => {
    const add = (color, x = 0) => {
      const n = createPath(rectangle(x, 0, 20, 20), true, { fill: { type: 'solid', color }, stroke: null });
      ed.doc.insert(n, ed.targetLayer().id);
      return n.id;
    };
    ids.push(add('#ff0000'));
    for (let i = 0; i < PREVIEW_THRESHOLD - 1; i++) ids.push(add('#888888', 100));
    const stationary = add('#00ff00');
    if (hidden) ed.doc.update(stationary, { hidden: true });
    ids.push(add('#0000ff', 10));
  });
  ed.select(ids);
  return { ed, view: app.views.get(ed) };
}

describe('large-selection stacking', () => {
  it.each([false, true])('keeps stationary artwork between selected objects (slow scene: %s)', (slowScene) => {
    const { ed, view } = scene();
    const paint = recordPaint(view);
    const session = new TransformSession(ed, 'Move');
    try {
      session.apply([1, 0, 0, 1, 2, 0]);
      view.slowScene = slowScene;
      view.renderNow();
      expect(paint.colors()).toEqual(['#ff0000', '#00ff00', '#0000ff']);
      paint.reset();
      session.commit();
      view.renderNow();
      expect(paint.colors()).toEqual(['#ff0000', '#00ff00', '#0000ff']);
    } finally {
      if (ed.doc.tx) session.cancel();
      paint.restore();
    }
  });
});

it('preserves the original/copy stacking order while Alt-dragging', () => {
  const { ed, view } = scene();
  const paint = recordPaint(view);
  const session = new TransformSession(ed, 'Move', { duplicate: true });
  try {
    session.apply([1, 0, 0, 1, 2, 0]);
    view.renderNow();
    expect(paint.colors()).toEqual(['#ff0000', '#ff0000', '#00ff00', '#0000ff', '#0000ff']);
    paint.reset();
    session.cancel();
    view.renderNow();
    expect(paint.colors()).toEqual(['#ff0000', '#00ff00', '#0000ff']);
  } finally {
    if (ed.doc.tx) session.cancel();
    paint.restore();
  }
});

it('does not abandon bitmap acceleration for hidden artwork between selected objects', () => {
  const { ed, view } = scene({ hidden: true });
  const paint = recordPaint(view);
  const session = new TransformSession(ed, 'Move');
  try {
    session.apply([1, 0, 0, 1, 2, 0]);
    expect(ed.dragPreview).toBeTruthy();
    view.renderNow();
    expect(paint.colors()).toEqual(['#ff0000', '#0000ff']);
  } finally {
    session.cancel();
    paint.restore();
  }
});
