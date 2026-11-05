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
import { Batch } from '../src/render/batch.js';
import { drawSheet, sheetFrame } from '../src/render/sch-scene.js';
import { SCH_PALETTES } from '../src/render/palette.js';
import { Settings } from '../src/app/settings.js';
import { drawSchObject } from '../src/render/sch-scene.js';
import { schBounds, graphicBox, textBox, fieldText, SCH_TEXT } from '../src/model/sch.js';
import { placeSymbol, fieldPosition } from '../src/model/place.js';
import { createExampleProject } from '../src/app/demo.js';
import { bboxIntersects, bboxUnion, bboxEmpty } from '../src/core/geom.js';
import { schObjectPrims } from '../src/io/schgraphics.js';
import { textStrokes } from '../src/render/font.js';

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

describe('nudging', () => {
  it('keeps wires attached to the nudged part, as a drag does, in one merged undo step', async () => {
    app = await boot();
    const ed = app.activeEditor;
    const nets = (u) => {
      const nl = app.project.netlist();
      return [1, 2].map((n) => nl.byPin.get(`${u.id}:${n}`));
    };
    const r3 = [...ed.doc.items()].find((o) => o.designator === 'R3');
    const before = nets(r3);
    expect(before.every((n) => n && !/^Net/.test(n))).toBe(true);
    const label = ed.doc.store.undoLabel;
    ed.setSelection([r3.id]);
    ed.select.key({}, 'ArrowUp');
    ed.select.key({}, 'ArrowUp');
    const moved = ed.doc.store.get(r3.id);
    expect(moved.y - r3.y).toBe(2 * ed.grid);
    expect(nets(moved)).toEqual(before);
    expect(ed.doc.store.undoLabel).toBe('Nudge');
    ed.doc.store.undo();
    expect(ed.doc.store.get(r3.id).y).toBe(r3.y);
    expect(ed.doc.store.undoLabel).toBe(label);
  });
});

describe('presses in tools without a drag gesture', () => {
  it('still click when the pointer moves a few pixels during the press', async () => {
    app = await boot();
    const ed = withCamera(app.activeEditor);
    ed.startTool('wire');
    const press = (x, y, jx) => {
      ed.canvas.dispatchEvent(pointer('pointerdown', x, y));
      ed.canvas.dispatchEvent(pointer('pointermove', x + jx, y));
      ed.canvas.dispatchEvent(pointer('pointerup', x + jx, y));
    };
    press(100, 100, 6);
    expect(ed.tool.pts?.length).toBe(2);
    press(300, 100, 6);
    expect(ed.tool.pts?.length).toBeGreaterThanOrEqual(4);
    // The point lands where the pointer was released (the preview's end).
    const end = ed.worldAt(306, 100);
    const n = ed.tool.pts.length;
    expect(Math.abs(ed.tool.pts[n - 2] - end.x)).toBeLessThanOrEqual(ed.grid / 2);
  });

  it('keeps dragging for the select tool', async () => {
    app = await boot();
    const ed = withCamera(app.activeEditor);
    const part = [...ed.doc.items()].find((o) => o.t === 'part');
    const [sx, sy] = ed.renderer.worldToScreen(part.x, part.y);
    ed.canvas.dispatchEvent(pointer('pointerdown', sx, sy));
    ed.canvas.dispatchEvent(pointer('pointermove', sx + 50, sy));
    ed.canvas.dispatchEvent(pointer('pointerup', sx + 50, sy));
    expect(ed.doc.store.get(part.id).x).not.toBe(part.x);
  });
});

describe('title block', () => {
  it('keeps long values inside their cells', () => {
    const texts = [];
    const b = new Batch();
    b.text = (str, x, y, size) => texts.push({ str, x, y, size });
    const sheet = {
      size: 'A4',
      title: 'Dual channel 48 V synchronous buck converter with telemetry, rev C',
      author: 'Maximilian Featherstonehaugh-Smythe',
      company: 'Acme Precision Electronics International GmbH',
      revision: 'C',
    };
    drawSheet(b, sheet, SCH_PALETTES.light, {
      fileName: 'power-stage-left-channel-final-v2.sch',
      date: '2026-11-05',
      sheetOf: '1 of 1',
    });
    const { tb } = sheetFrame(sheet);
    const w = tb.x2 - tb.x1;
    const cellEnd = (x) => {
      const f = (x - tb.x1) / w;
      // Cell boundaries of the four rows (fractions of the block width).
      for (const edge of [0.25, 0.4, 0.7])
        if (f < edge - 1e-6 && f > edge - 0.2) return tb.x1 + w * edge;
      return tb.x2;
    };
    for (const name of [sheet.title, 'Maximilian', 'power-stage']) {
      const t = texts.find((e) => e.str.startsWith(name));
      expect(t).toBeTruthy();
      expect(t.x + textWidth(t.str, t.size)).toBeLessThanOrEqual(cellEnd(t.x));
    }
    // Short values keep their normal size.
    const rev = texts.find((e) => e.str === 'C' && e.x > tb.x1 && e.x < tb.x2);
    expect(rev.size).toBeCloseTo(2.6e6, -3);
  });
});

describe('wire tool backspace past the start', () => {
  it('does not fall through to deleting the selection', async () => {
    app = await boot();
    const ed = app.activeEditor;
    const part = [...ed.doc.items()].find((o) => o.t === 'part');
    ed.setSelection([part.id]);
    ed.startTool('wire');
    ed.tool.click({ x: mil(1000), y: mil(7500), rawX: 0, rawY: 0, sx: 0, sy: 0 });
    const press = () =>
      ed.canvas.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
      );
    ed.canvas.focus();
    press();
    expect(ed.tool.pts).toBeNull();
    press();
    press();
    expect(ed.doc.store.get(part.id)).toBeTruthy();
    // Back in the select tool, Backspace deletes as usual.
    ed.endTool();
    press();
    expect(ed.doc.store.get(part.id)).toBeUndefined();
  });
});

describe('zoom limits', () => {
  it('stops zooming out while a sheet is still visible and zooming in at 10 px per micrometre', () => {
    const r = cameraOnly();
    for (let i = 0; i < 200; i++) r.zoomAt(400, 300, 0.5);
    // An A4 sheet (297 mm) is still tens of pixels wide.
    expect(297e3 * r.view.scale).toBeGreaterThanOrEqual(25);
    for (let i = 0; i < 400; i++) r.zoomAt(400, 300, 2);
    expect(r.view.scale).toBeLessThanOrEqual(10);
    // The point under the cursor stays put at the limit.
    const before = r.screenToWorld(123, 45);
    r.zoomAt(123, 45, 2);
    const after = r.screenToWorld(123, 45);
    expect(after[0]).toBeCloseTo(before[0], 0);
    expect(after[1]).toBeCloseTo(before[1], 0);
  });
});

describe('move hint', () => {
  const grab = (ed, o) => {
    const ev = { x: o.x, y: o.y, rawX: o.x, rawY: o.y, sx: 0, sy: 0 };
    ed.select.dragStart(ev);
    expect(ed.select.move).toBeTruthy();
    return ed.select.hint();
  };

  it('offers mirroring in the schematic', async () => {
    app = await boot();
    const ed = app.activeEditor;
    const hint = grab(
      ed,
      [...ed.doc.items()].find((o) => o.t === 'part'),
    );
    expect(hint).toMatch(/X \/ Y mirror/);
    expect(hint).not.toMatch(/L flips/);
    ed.select.cancelDrag();
  });

  it('offers flipping, not mirroring, on the board', async () => {
    app = await boot();
    app.openDoc(app.project.boards[0].id);
    const ed = app.activeEditor;
    const comp = [...ed.doc.items()].find((o) => o.t === 'comp');
    const hint = grab(ed, comp);
    expect(hint).not.toMatch(/mirror/);
    expect(hint).toMatch(/L flips/);
    // X is still consumed (no menu accelerator) and changes nothing.
    expect(ed.select.key({}, 'X')).toBe(true);
    ed.select.cancelDrag();
  });
});

describe('paste designators', () => {
  it('renumbers by the leading letters of the copied designator', async () => {
    app = await boot();
    const ed = app.activeEditor;
    const r3 = [...ed.doc.items()].find((o) => o.designator === 'R3');
    const pasted = [];
    for (const designator of ['U1A', 'R3', 'R?', 'TP12']) {
      ed.setSelection([r3.id]);
      const clip = ed.copySelection();
      clip.objects[0].designator = designator;
      ed.pasteClip(clip);
      ed.tool.click({
        x: mil(1000),
        y: mil(1000 + 300 * pasted.length),
        rawX: 0,
        rawY: 0,
        sx: 0,
        sy: 0,
      });
      pasted.push(ed.selectedObjects()[0].designator);
    }
    const [u, r, rq, tp] = pasted;
    expect(u).toMatch(/^U\d+$/);
    expect(r).toMatch(/^R\d+$/);
    expect(rq).toMatch(/^R\d+$/);
    expect(rq).not.toBe(r);
    expect(tp).toBe('TP1');
  });
});

describe('crosshair cursor preferences', () => {
  const longLines = (ed) => {
    const seg = ed.overlay.bufs.seg;
    const out = [];
    for (let i = 0; i < seg.count; i++) {
      const o = i * seg.stride;
      const [x1, y1, x2, y2] = [seg.f[o], seg.f[o + 1], seg.f[o + 2], seg.f[o + 3]].map(
        (v) => v * 1000,
      );
      if (Math.hypot(x2 - x1, y2 - y1) > 500 * ed.nmPerPx) out.push([x1, y1, x2, y2]);
    }
    return out;
  };

  for (const [kind, key] of [
    ['sch', 'schCrosshair'],
    ['pcb', 'pcbCrosshair'],
  ]) {
    it(`draws a full-view crosshair through the cursor on the ${kind} canvas when ${key} is on`, async () => {
      app = await boot();
      if (kind === 'pcb') app.openDoc(app.project.boards[0].id);
      const ed = withCamera(app.activeEditor);
      ed.canvas.dispatchEvent(pointer('pointermove', 400, 300));
      ed.buildOverlay();
      expect(longLines(ed)).toEqual([]);
      app.settings.set(key, true);
      ed.buildOverlay();
      const lines = longLines(ed);
      expect(lines.length).toBe(2);
      const { x, y } = ed.cursor;
      const [h, v] = lines;
      expect(h[1]).toBeCloseTo(y, -2);
      expect(h[3]).toBeCloseTo(y, -2);
      expect(v[0]).toBeCloseTo(x, -2);
      expect(v[2]).toBeCloseTo(x, -2);
      // Hidden once the pointer leaves the canvas.
      ed.canvas.dispatchEvent(new MouseEvent('pointerleave'));
      ed.buildOverlay();
      expect(longLines(ed)).toEqual([]);
      app.settings.set(key, false);
    });
  }

  it('keeps the board crosshair preference across reloads', () => {
    localStorage.clear();
    new Settings().set('pcbCrosshair', true);
    expect(new Settings().get('pcbCrosshair')).toBe(true);
    localStorage.clear();
  });
});

describe('rotated free text', () => {
  const strokesOf = (o) => {
    const b = new Batch();
    drawSchObject(b, o, {}, SCH_PALETTES.light);
    const seg = b.bufs.seg;
    const out = [];
    for (let i = 0; i < seg.count; i++) {
      const k = i * seg.stride;
      out.push(
        [seg.f[k], seg.f[k + 1], seg.f[k + 2], seg.f[k + 3]].map((v) => Math.round(v * 1000)),
      );
    }
    return out;
  };
  const text = (rot) => ({
    id: 't',
    t: 'text',
    x: mil(1000),
    y: mil(1000),
    text: 'Vin 12V',
    size: mil(60),
    rot,
  });

  it('reads upright at 180 and 270 degrees, covering the same box', () => {
    const upsideDown = textStrokes('Vin 12V', mil(1000), mil(1000), mil(60), 180);
    const xs = upsideDown.flatMap((s) => s.filter((_, i) => i % 2 === 0));
    // Upright: the first glyph is the leftmost one and strokes go left to right.
    const s180 = strokesOf(text(180));
    const s0 = strokesOf(text(0));
    expect(s180.length).toBe(s0.length);
    const minX = Math.min(...s180.map((l) => Math.min(l[0], l[2])));
    expect(minX).toBeCloseTo(Math.min(...xs), -3);
    // Glyph shapes match unrotated text, shifted: compare the first stroke's direction.
    const d = (l) => [Math.sign(l[2] - l[0]), Math.sign(l[3] - l[1])];
    expect(s180.map(d)).toEqual(s0.map(d));
    // 270 reads like 90.
    expect(strokesOf(text(270)).map(d)).toEqual(strokesOf(text(90)).map(d));
  });

  it('keeps bounds, hit-testing and the SVG exporter in step with the canvas', () => {
    for (const rot of [0, 90, 180, 270]) {
      const o = text(rot);
      const bb = schBounds(o, {});
      for (const l of strokesOf(o)) {
        for (const [x, y] of [
          [l[0], l[1]],
          [l[2], l[3]],
        ]) {
          expect(x).toBeGreaterThanOrEqual(bb.minX - 2000);
          expect(x).toBeLessThanOrEqual(bb.maxX + 2000);
          expect(y).toBeGreaterThanOrEqual(bb.minY - 2000);
          expect(y).toBeLessThanOrEqual(bb.maxY + 2000);
        }
      }
      const [p] = schObjectPrims(o, {});
      const exported = textStrokes(p.text, p.x, p.y, p.size, p.rot, p.align);
      const canvas = textStrokes(
        o.text,
        o.x,
        o.y,
        o.size,
        rot === 180 || rot === 270 ? rot - 180 : rot,
        rot === 180 || rot === 270 ? { h: 'right', v: 'top' } : undefined,
      );
      expect(exported).toEqual(canvas);
    }
  });
});

describe('part field placement', () => {
  const project = createExampleProject();
  const lib = project.library;
  const parts = [...project.sheets[0].items()].filter((o) => o.t === 'part');
  const bodyOf = (o) =>
    placeSymbol(lib[o.comp], o).graphics.reduce(
      (b, g) => bboxUnion(b, graphicBox(g) || bboxEmpty()),
      bboxEmpty(),
    );
  const fieldBox = (o, name) => {
    const f = fieldPosition(o, name, lib[o.comp]);
    // The ink of the glyphs (textBox adds room for descenders).
    const pts = textStrokes(fieldText(o, name), f.x, f.y, SCH_TEXT, 0, f.align).flat();
    const xs = pts.filter((_, i) => i % 2 === 0),
      ys = pts.filter((_, i) => i % 2 === 1);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  };

  it('keeps fields beside the body on quarter turns and mirrors the upright layout on a half turn', () => {
    for (const base of parts.filter((o) => /^[RC]\d/.test(o.designator))) {
      const at = (rot) => ({ ...base, rot, fields: undefined });
      for (const rot of [90, 270]) {
        const o = at(rot);
        for (const name of ['designator', 'value']) {
          expect(
            bboxIntersects(fieldBox(o, name), bodyOf(o)),
            `${o.designator} ${name} at ${rot}`,
          ).toBe(false);
        }
      }
      // A half turn is the point reflection of the upright layout (the ink
      // stays on the same side of the body, at the same distance).
      const up = at(0),
        down = at(180);
      for (const name of ['designator', 'value']) {
        const a = fieldBox(up, name),
          b = fieldBox(down, name);
        expect(Math.abs(b.maxY - down.y + (a.minY - up.y))).toBeLessThan(mil(5));
      }
    }
  });

  it('leaves fields of unrotated parts, and right-hand fields, where they were', () => {
    for (const o of parts) {
      const r = o.rot || 0;
      for (const name of ['designator', 'value']) {
        const f = fieldPosition(o, name, lib[o.comp]);
        if (r === 0 || (r !== 180 && f.x >= o.x)) expect(f.align).toBeUndefined();
      }
    }
    const c3 = parts.find((o) => o.designator === 'C3');
    expect(fieldPosition(c3, 'designator', lib[c3.comp]).align).toEqual({
      h: 'right',
      v: 'bottom',
    });
  });
});
