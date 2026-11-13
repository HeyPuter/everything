import { describe, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { apply, multiply } from '../src/lib/matrix.js';
import { transformNodes, nodeBounds } from '../src/model/geometry.js';
import { TransformSession, PREVIEW_THRESHOLD } from '../src/tools/transform-session.js';

// Record paint order through bitmap blits as well as direct drawing. This catches
// ordering errors that inspecting the document tree or selection cannot detect.
function recordPaint(view) {
  const contexts = new Map();
  const getContext = HTMLCanvasElement.prototype.getContext;
  const instrument = (ctx) => {
    if (contexts.has(ctx)) return ctx;
    const original = { fill: ctx.fill, clearRect: ctx.clearRect, drawImage: ctx.drawImage, setTransform: ctx.setTransform };
    const colors = [];
    const points = [];
    let matrix = [1, 0, 0, 1, 0, 0];
    contexts.set(ctx, { original, colors, points });
    ctx.setTransform = (...args) => {
      matrix = args.length === 1 ? ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => args[0][k]) : args;
      original.setTransform.apply(ctx, args);
    };
    ctx.fill = function (path) {
      colors.push(this.fillStyle);
      const first = path?.ops.find(([op]) => op === 'M' || op === 'R');
      if (first) points.push({ color: this.fillStyle, ...apply(matrix, first[1], first[2]) });
    };
    ctx.clearRect = () => { colors.length = 0; points.length = 0; };
    ctx.drawImage = (canvas, dx = 0, dy = 0) => {
      const source = contexts.get(canvas.getContext('2d'));
      if (source) {
        colors.push(...source.colors);
        points.push(...source.points.map((p) => ({ color: p.color, ...apply(matrix, p.x + dx, p.y + dy) })));
      }
    };
    return ctx;
  };
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (...args) {
    return instrument(getContext.apply(this, args));
  });
  instrument(view.actx);
  return {
    colors: () => contexts.get(view.actx).colors.filter((c) => ['#ff0000', '#00ff00', '#0000ff'].includes(c)),
    points: () => contexts.get(view.actx).points,
    reset: () => { const current = contexts.get(view.actx); current.colors.length = 0; current.points.length = 0; },
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

it.each([
  { offset: [-100, 0], move: [150, 0] },
  { offset: [600, 0], move: [-550, 0] },
  { offset: [0, -100], move: [0, 150] },
  { offset: [0, 600], move: [0, -550] },
])('shows offscreen artwork entering the viewport ($offset)', ({ offset, move }) => {
  const { ed, view } = scene({ hidden: true });
  ed.doc.transact('Offscreen', () => transformNodes(ed.doc, [ed.topSelection()[0]], [1, 0, 0, 1, ...offset]));
  const paint = recordPaint(view);
  const session = new TransformSession(ed, 'Move');
  try {
    session.apply([1, 0, 0, 1, ...move]);
    view.renderNow();
    expect(ed.dragPreview).toBeTruthy();
    const red = paint.points().find((p) => p.color === '#ff0000');
    expect(red).toBeDefined();
    expect(red.x).toBeCloseTo(offset[0] + move[0]);
    expect(red.y).toBeCloseTo(offset[1] + move[1]);
    paint.reset();
    session.commit();
    view.renderNow();
    expect(paint.points().find((p) => p.color === '#ff0000')).toEqual(red);
  } finally {
    if (ed.doc.tx) session.cancel();
    paint.restore();
  }
});

it('positions the capture correctly with zoom, rotation, and high-DPI rendering', () => {
  const { ed, view } = scene({ hidden: true });
  ed.view.set({ zoom: 1.5, rotation: 30, dpr: 2, panX: 150, panY: 120 });
  const paint = recordPaint(view);
  const session = new TransformSession(ed, 'Move');
  try {
    session.apply([1, 0, 0, 1, 20, 15]);
    view.renderNow();
    expect(ed.dragPreview).toBeTruthy();
    const expected = apply(multiply([2, 0, 0, 2, 0, 0], ed.view.matrix), 20, 15);
    const red = paint.points().find((p) => p.color === '#ff0000');
    expect(red.x).toBeCloseTo(expected.x);
    expect(red.y).toBeCloseTo(expected.y);
    const capture = view.previewCache.mov;
    paint.reset();
    session.apply([0, 1, -1, 0, 20, 15]);
    view.renderNow();
    expect(view.previewCache.mov).toBe(capture);
    const blue = paint.points().find((p) => p.color === '#0000ff');
    const rotated = apply(multiply([2, 0, 0, 2, 0, 0], ed.view.matrix), 20, 25);
    expect(blue.x).toBeCloseTo(rotated.x);
    expect(blue.y).toBeCloseTo(rotated.y);
  } finally {
    session.cancel();
    paint.restore();
  }
});

it.each([{ x: -100000, y: 0, cancel: true }, { x: -100000, y: 0, cancel: false }, { x: -2000, y: -2000, cancel: true }, { x: -2000, y: -2000, cancel: false }])('bounds bitmap memory for an oversized drag ($x, $y; cancel: $cancel)', ({ x, y, cancel }) => {
  const { ed, view } = scene({ hidden: true });
  const first = ed.topSelection()[0];
  ed.doc.transact('Far offscreen', () => transformNodes(ed.doc, [first], [1, 0, 0, 1, x, y]));
  const paint = recordPaint(view);
  const session = new TransformSession(ed, 'Move');
  try {
    session.apply([1, 0, 0, 1, -x + 50, -y]);
    view.renderNow();
    expect(ed.dragPreview).toBeNull();
    expect(view.previewCache).toBeNull();
    expect(view.interactionCanvases?.['pv-moving']).toBeUndefined();
    expect(paint.points().find((p) => p.color === '#ff0000')).toMatchObject({ x: 50, y: 0 });
    session.apply([1, 0, 0, 1, -x + 60, -y]);
    expect(nodeBounds(ed.doc, ed.doc.get(first)).x).toBe(60);
    if (cancel) session.cancel();
    else { session.commit(); ed.doc.undo(); }
    expect(nodeBounds(ed.doc, ed.doc.get(first))).toMatchObject({ x, y });
  } finally {
    if (ed.doc.tx) session.cancel();
    paint.restore();
  }
});
