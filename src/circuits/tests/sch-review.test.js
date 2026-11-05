// Schematic editor and shared canvas regressions: wheel input during drags,
// device pixel ratio changes, wire tool connections and corners, and text.
// jsdom has no WebGL, so the canvas view gets a renderer whose camera maths
// is the real one and whose drawing is a no-op.
import { describe, it, expect, afterEach } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { Renderer2D } from '../src/render/renderer2d.js';
import { mil } from '../src/core/units.js';

async function boot() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  delete window.puter;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  await app.openExample();
  return app;
}

/** A Renderer2D with the real camera and no GL. */
function cameraOnly(cssW = 800, cssH = 600) {
  const r = Object.create(Renderer2D.prototype);
  Object.assign(r, {
    view: { cx: 0, cy: 0, scale: 0.01 },
    cssW,
    cssH,
    dpr: 1,
    width: cssW,
    height: cssH,
  });
  r.draw = () => {};
  r.release = () => {};
  r.dispose = () => {};
  r.resize = function resize(w, h, dpr = 1) {
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
  };
  return r;
}

function withCamera(ed) {
  ed.renderer = cameraOnly();
  ed._sized = true;
  ed.canvas.setPointerCapture = () => {};
  ed.canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
  });
  return ed;
}

function pointer(type, x, y, extra = {}) {
  const e = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  return e;
}

let app;
afterEach(() => {
  app?.kernel.dispose();
  app = null;
  document.body.innerHTML = '';
});

describe('canvas input', () => {
  it('keeps a dragged selection under the cursor when the wheel scrolls mid-drag', async () => {
    app = await boot();
    const ed = withCamera(app.activeEditor);
    const part = [...ed.doc.items()].find((o) => o.t === 'part');
    const [sx, sy] = ed.renderer.worldToScreen(part.x, part.y);
    const errors = [];
    const onError = (e) => errors.push(e.error || e.message);
    window.addEventListener('error', onError);
    ed.canvas.dispatchEvent(pointer('pointerdown', sx, sy));
    ed.canvas.dispatchEvent(pointer('pointermove', sx + 20, sy));
    ed.canvas.dispatchEvent(pointer('pointermove', sx + 40, sy));
    expect(ed.select.move).toBeTruthy();
    // The wheel pans the view by 100 px while the button is still down.
    const wheel = new WheelEvent('wheel', {
      clientX: sx + 40,
      clientY: sy,
      deltaY: 100,
      bubbles: true,
      cancelable: true,
    });
    expect(() => ed.canvas.dispatchEvent(wheel)).not.toThrow();
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    ed.canvas.dispatchEvent(pointer('pointerup', sx + 40, sy));
    const moved = ed.doc.store.get(part.id);
    // The part follows the cursor's new world position: 40 px right, and
    // 100 px further down the sheet after the pan.
    const px = ed.nmPerPx;
    expect(Math.abs(moved.x - part.x - 40 * px)).toBeLessThanOrEqual(ed.grid);
    expect(Math.abs(moved.y - part.y + 100 * px)).toBeLessThanOrEqual(ed.grid);
  });
});

describe('device pixel ratio', () => {
  it('re-sizes the drawing buffer when the pixel ratio changes without a resize', async () => {
    const queries = [];
    const realMatch = window.matchMedia;
    const realDpr = window.devicePixelRatio;
    window.matchMedia = (media) => {
      const q = {
        media,
        matches: false,
        listeners: new Set(),
        addEventListener(type, fn) {
          if (type === 'change') this.listeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === 'change') this.listeners.delete(fn);
        },
      };
      queries.push(q);
      return q;
    };
    try {
      app = await boot();
      const ed = app.activeEditor;
      const r = cameraOnly();
      r.canvas = ed.canvas;
      r.resize = Renderer2D.prototype.resize;
      r.width = r.height = 1;
      ed.renderer = r;
      ed.wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
      ed._resize();
      expect(ed.canvas.width).toBe(800);
      const live = queries.filter((q) => /resolution/.test(q.media) && q.listeners.size);
      expect(live.length).toBeGreaterThan(0);
      Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
      for (const q of live) for (const fn of [...q.listeners]) fn();
      expect(ed.canvas.width).toBe(1600);
      expect(ed.renderer.dpr).toBe(2);
      // The editor now watches the new ratio, and stops when disposed.
      const active = () => queries.filter((q) => /resolution/.test(q.media) && q.listeners.size);
      expect(active().some((q) => q.media.includes('2dppx'))).toBe(true);
      ed.renderer = null;
      ed.dispose();
      expect(active().filter((q) => [...q.listeners].includes(ed._onDpr))).toEqual([]);
    } finally {
      window.matchMedia = realMatch;
      Object.defineProperty(window, 'devicePixelRatio', { value: realDpr, configurable: true });
    }
  });
});

describe('wheel panning', () => {
  it('pans sideways with Shift whether the wheel reports deltaY or (macOS) deltaX', async () => {
    app = await boot();
    const ed = withCamera(app.activeEditor);
    const v = ed.renderer.view;
    for (const [deltaX, deltaY] of [
      [0, 100],
      [100, 0],
    ]) {
      const before = { ...v };
      ed.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: 400,
          clientY: 300,
          deltaX,
          deltaY,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(v.cy).toBe(before.cy);
      expect(v.cx).toBeCloseTo(before.cx + 100 / v.scale, 6);
    }
    // Without Shift both axes pan as reported.
    const before = { ...v };
    ed.canvas.dispatchEvent(
      new WheelEvent('wheel', {
        clientX: 400,
        clientY: 300,
        deltaX: 30,
        deltaY: 50,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(v.cx).toBeCloseTo(before.cx + 30 / v.scale, 6);
    expect(v.cy).toBeCloseTo(before.cy - 50 / v.scale, 6);
  });
});
