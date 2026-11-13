// Smoothing (a pulled-string stabilizer) for the Pencil, Paintbrush and Merge Brush, and the Merge Brush's Fidelity.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { toolSettings } from '../src/features/tool-props/index.js';
import { Stabilizer, stringLength, MAX_STRING_PX } from '../src/tools/stabilizer.js';

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

function newDoc() {
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  return ed;
}

function ev(x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

/** A shaky horizontal stroke from (100, 100) to (400, 100): +-3 units of tremor on every sample after the first. */
const shaky = Array.from({ length: 151 }, (_, i) => [100 + i * 2, i ? 100 + (i % 2 ? 3 : -3) : 100]);

async function stroke(tool, points, extra = () => ({})) {
  tool.onPointerDown(ev(...points[0], extra(0)));
  points.slice(1).forEach((p, i) => tool.onPointerMove(ev(...p, extra(i + 1))));
  await tool.onPointerUp(ev(...points.at(-1), extra(points.length - 1)));
}

/** Largest distance of a path's anchors and handles from the line y = 100. */
const wobble = (n) => Math.max(...n.anchors.flatMap((a) => [a.y, a.iy, a.oy].map((y) => Math.abs(y - 100))));

describe('Stabilizer', () => {
  it('keeps tremor shorter than the string out of the line, one point per sample', () => {
    const s = new Stabilizer(50, 1, { x: 0, y: 0 });
    expect(s.length).toBe(MAX_STRING_PX / 2);
    const out = [];
    for (let i = 1; i <= 100; i++) out.push(s.push({ x: i * 2, y: i % 2 ? 4 : -4 }));
    expect(out).toHaveLength(100);
    // Once the string is taut the drawn line runs straight while the pen wobbles by 8 units.
    const tail = out.slice(30).map((p) => p.y);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(1);
    // The line trails the pen by the string length.
    expect(200 - out.at(-1).x).toBeCloseTo(s.length, 0);
  });

  it('measures the string in screen pixels and passes points through when off', () => {
    expect(stringLength(100, 2)).toBe(MAX_STRING_PX / 2);
    expect(stringLength(0, 1)).toBe(0);
    expect(stringLength(250, 1)).toBe(MAX_STRING_PX);
    const off = new Stabilizer(0, 1, { x: 0, y: 0 });
    expect(off.push({ x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });

  it('keeps the pen path for a stroke shorter than the string', () => {
    const s = new Stabilizer(100, 1, { x: 0, y: 0 });
    const pts = [{ x: 0, y: 0 }];
    for (let i = 1; i <= 5; i++) pts.push(s.push({ x: i * 2, y: 0 }));
    expect(pts.every((p) => p.x === 0)).toBe(true);
    const kept = s.finish(pts);
    expect(kept.map((p) => p.x)).toEqual([0, 2, 4, 6, 8, 10]);
  });
});

describe('Smoothing in the freehand tools', () => {
  it('the Pencil draws a steadier line with Smoothing on, and remembers the setting', async () => {
    const ed = newDoc();
    app.setTool('pencil');
    const tool = app.tool;
    tool.fidelity = 0;
    tool.smoothing = 0;
    await stroke(tool, shaky);
    const rough = ed.doc.leaves().at(-1);
    // Start the next stroke fresh rather than continuing the selected one.
    ed.clearSelection();
    tool.smoothing = 60;
    expect(app.prefs.get('pencilSmoothing')).toBe(60);
    await stroke(tool, shaky);
    const steady = ed.doc.leaves().at(-1);
    expect(steady.id).not.toBe(rough.id);
    expect(wobble(rough)).toBeGreaterThan(2);
    expect(wobble(steady)).toBeLessThan(1.5);
    tool.smoothing = 0;
    app.setTool('selection');
  });

  it('the Paintbrush keeps one pen pressure per smoothed point', async () => {
    const ed = newDoc();
    app.setTool('paintbrush');
    const tool = app.tool;
    tool.smoothing = 60;
    expect(app.prefs.get('paintbrushOptions').smoothing).toBe(60);
    tool.onPointerDown(ev(...shaky[0], { pointerType: 'pen', pressure: 0.2 }));
    shaky.slice(1).forEach((p, i) => tool.onPointerMove(ev(...p, { pointerType: 'pen', pressure: 0.2 + (0.6 * i) / shaky.length })));
    expect(tool.pressures).toHaveLength(tool.points.length);
    await tool.onPointerUp(ev(...shaky.at(-1), { pointerType: 'pen' }));
    const n = ed.doc.leaves().at(-1);
    expect(wobble(n)).toBeLessThan(1.5);
    // Pressure still shapes the width.
    expect(n.widthProfile).toBeTruthy();
    tool.smoothing = 0;
    app.setTool('selection');
  });

  it('the Merge Brush paints a steadier blob with Smoothing on', async () => {
    const ed = newDoc();
    app.setTool('blob-brush');
    const tool = app.tool;
    tool.size = 10;
    tool.smoothing = 0;
    await stroke(tool, shaky);
    const rough = ed.doc.leaves().at(-1);
    ed.doc.transact('Clear', () => ed.doc.remove(rough.id));
    tool.smoothing = 60;
    await stroke(tool, shaky);
    const steady = ed.doc.leaves().at(-1);
    const spread = (n) => {
      const ys = n.anchors.filter((a) => a.x > 150 && a.x < 300).map((a) => a.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    // A 10-unit brush: the steady blob is about 10 tall, the shaky one wider.
    expect(spread(steady)).toBeLessThan(11);
    expect(spread(rough)).toBeGreaterThan(spread(steady));
    tool.smoothing = 0;
    app.setTool('selection');
  });
});

describe('Merge Brush Fidelity', () => {
  /** A smooth wave: a higher fidelity fits it with fewer anchors. */
  const wave = Array.from({ length: 121 }, (_, i) => [100 + i * 3, 200 + 40 * Math.sin(i / 8)]);

  it('defaults close to the old fit and simplifies more when set toward Smooth', async () => {
    const ed = newDoc();
    app.setTool('blob-brush');
    const tool = app.tool;
    tool.size = 6;
    app.prefs.set('blobBrushFidelity', null);
    expect(tool.fidelity).toBe(5);
    await stroke(tool, wave);
    const accurate = ed.doc.leaves().at(-1);
    ed.doc.transact('Clear', () => ed.doc.remove(accurate.id));
    tool.fidelity = 100;
    expect(app.prefs.get('blobBrushFidelity')).toBe(100);
    await stroke(tool, wave);
    const smooth = ed.doc.leaves().at(-1);
    expect(smooth.anchors.length).toBeLessThan(accurate.anchors.length);
    app.prefs.set('blobBrushFidelity', null);
    app.setTool('selection');
  });

  it('shows Fidelity and Smoothing in the Properties panel tool settings', () => {
    newDoc();
    app.setTool('blob-brush');
    const s = toolSettings(app);
    expect(s.fields.map((f) => f.key)).toEqual(['size', 'fidelity', 'smoothing', 'pressure']);
    s.set('fidelity', 40);
    s.set('smoothing', 25);
    expect(app.tool.fidelity).toBe(40);
    expect(app.tool.smoothing).toBe(25);
    app.prefs.set('blobBrushFidelity', null);
    app.prefs.set('blobBrushSmoothing', 0);
    app.setTool('pencil');
    expect(toolSettings(app).fields.map((f) => f.key)).toContain('smoothing');
    app.setTool('selection');
  });
});
