// Schematic editor and shared canvas regressions: wheel input during drags,
// device pixel ratio changes, wire tool connections and corners, and text.
// jsdom has no WebGL, so the canvas view gets a renderer whose camera maths
// is the real one and whose drawing is a no-op.
import { describe, it, expect, afterEach } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { Renderer2D } from '../src/render/renderer2d.js';
import { mil } from '../src/core/units.js';
import { layoutText, textWidth } from '../src/render/font.js';

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

describe('wire tool', () => {
  const G = mil(100);
  const at = (x, y) => ({ x, y, rawX: x, rawY: y, sx: 0, sy: 0 });
  const wires = (ed) => [...ed.doc.items()].filter((o) => o.t === 'wire');

  it('finishes when it ends on an existing wire, at its end or along it', async () => {
    app = await boot();
    const ed = app.activeEditor;
    const X = 10 * G,
      Y = 75 * G;
    ed.doc.store.transact('Wire', (s) =>
      s.add({ id: 'w-free', t: 'wire', pts: [X, Y, X + 6 * G, Y] }),
    );
    const before = new Set(wires(ed).map((w) => w.id));
    ed.startTool('wire');
    const tool = ed.tool;
    // Onto the dangling end.
    tool.click(at(X + 6 * G, Y - 4 * G));
    tool.click(at(X + 6 * G, Y));
    expect(tool.pts).toBeNull();
    // Onto the middle of the wire.
    tool.click(at(X + 2 * G, Y - 4 * G));
    tool.click(at(X + 2 * G, Y));
    expect(tool.pts).toBeNull();
    const placed = wires(ed).filter((w) => !before.has(w.id));
    expect(placed.map((w) => w.pts)).toEqual([
      [X + 6 * G, Y - 4 * G, X + 6 * G, Y],
      [X + 2 * G, Y - 4 * G, X + 2 * G, Y],
    ]);
    // Empty space keeps drawing.
    tool.click(at(X, Y - 10 * G));
    tool.click(at(X + 3 * G, Y - 10 * G));
    expect(tool.pts).toEqual([X, Y - 10 * G, X + 3 * G, Y - 10 * G]);
  });

  it('does not end a bus on a wire', async () => {
    app = await boot();
    const ed = app.activeEditor;
    const X = 10 * G,
      Y = 75 * G;
    ed.doc.store.transact('Wire', (s) =>
      s.add({ id: 'w-free', t: 'wire', pts: [X, Y, X + 6 * G, Y] }),
    );
    ed.startTool('bus');
    ed.tool.click(at(X + 2 * G, Y - 4 * G));
    ed.tool.click(at(X + 2 * G, Y));
    expect(ed.tool.pts).not.toBeNull();
  });
});

describe('wire tool backspace', () => {
  const G = mil(100);
  const at = (x, y) => ({ x, y, rawX: x, rawY: y, sx: 0, sy: 0 });
  const key = (ed, combo) => ed.tool.key({}, combo);

  it('removes the whole last click, including the corner it added', async () => {
    app = await boot();
    const ed = app.activeEditor;
    app.settings.set('schCorner', '90start');
    ed.startTool('wire');
    const X = 10 * G,
      Y = 75 * G;
    ed.tool.click(at(X, Y));
    ed.tool.click(at(X + 4 * G, Y + 3 * G));
    expect(ed.tool.pts).toEqual([X, Y, X + 4 * G, Y, X + 4 * G, Y + 3 * G]);
    ed.tool.click(at(X + 6 * G, Y + 3 * G));
    key(ed, 'Backspace');
    expect(ed.tool.pts).toEqual([X, Y, X + 4 * G, Y, X + 4 * G, Y + 3 * G]);
    key(ed, 'Backspace');
    expect(ed.tool.pts).toEqual([X, Y]);
    // Nothing is left to commit: Escape places no stub.
    const n = ed.doc.store.undoLabel;
    key(ed, 'Escape');
    expect(ed.doc.store.undoLabel).toBe(n);
    // A further Backspace with only the start point drops the wire.
    ed.tool.click(at(X, Y));
    key(ed, 'Backspace');
    expect(ed.tool.pts).toBeNull();
  });
});

describe('stroke font fallbacks', () => {
  it('draws one missing-glyph box per character, even outside the BMP', () => {
    const box = layoutText('\u2603', 1);
    expect(layoutText('\u{1F600}', 1).strokes).toEqual(box.strokes);
    expect(textWidth('\u{1F600}', 1)).toBeCloseTo(textWidth('\u2603', 1), 9);
    expect(textWidth('A\u{1D400}B', 1)).toBeCloseTo(textWidth('A\u2603B', 1), 9);
  });

  it('draws accented letters as their base letter rather than a box', () => {
    expect(layoutText('J\u00fcrgen', 1).strokes).toEqual(layoutText('Jurgen', 1).strokes);
    expect(layoutText('\u00c9t\u00e9', 1).strokes).toEqual(layoutText('Ete', 1).strokes);
    // Overbars still work around them.
    expect(layoutText('~\u00e9~', 1).strokes.length).toBe(layoutText('~e~', 1).strokes.length);
  });
});
