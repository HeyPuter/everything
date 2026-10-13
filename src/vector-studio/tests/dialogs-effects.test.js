import { describe, it, expect } from 'vitest';
import { convertPixels, docRasterSettings, setDocRasterSettings } from '../src/features/effects/raster.js';
import { transformEffect } from '../src/features/effects/geom/distort.js';
import { bootAppWithFeatures } from './helpers.js';

const sq = () => [{ closed: true, anchors: [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => ({ x, y, ix: x, iy: y, ox: x, oy: y })) }];

describe('Rasterize color models', () => {
  it('converts pixels to grayscale and to black and white', () => {
    const px = () => new Uint8ClampedArray([255, 0, 0, 255, 250, 250, 250, 100]);
    const g = convertPixels(px(), 'grayscale');
    expect(g[0]).toBe(g[1]);
    expect(g[0]).toBe(Math.round(0.2126 * 255));
    const b = convertPixels(px(), 'bitmap');
    expect([...b]).toEqual([0, 0, 0, 255, 255, 255, 255, 0]);
    expect([...convertPixels(px(), 'rgb')]).toEqual([...px()]);
  });

  it('keeps the color model in the document raster settings', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const doc = app.editor.doc;
    doc.transact('s', () => setDocRasterSettings(doc, { colorModel: 'grayscale' }));
    expect(docRasterSettings(doc).colorModel).toBe('grayscale');
  });

  it('offers the color model in the Document Raster Effects Settings dialog', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const done = app.commands.run('effect.rasterSettings');
    await new Promise((r) => setTimeout(r, 0));
    const dlg = document.querySelector('dialog[open]');
    const label = [...dlg.querySelectorAll('label')].find((l) => l.textContent === 'Color Model');
    const sel = document.getElementById(label.htmlFor);
    sel.value = 'bitmap';
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(docRasterSettings(app.editor.doc).colorModel).toBe('bitmap');
  });
});

describe('Transform effect', () => {
  it('scales strokes with the object when asked', () => {
    const b = { x: 0, y: 0, w: 10, h: 10 };
    const plain = transformEffect(sq(), { scaleH: 2, scaleV: 2, copies: 0 }, b, 4);
    expect(plain[0].paint).toBeUndefined();
    const scaled = transformEffect(sq(), { scaleH: 2, scaleV: 2, copies: 0, scaleStrokes: true }, b, 4);
    expect(scaled[0].paint.strokeWidth).toBeCloseTo(8);
    const copies = transformEffect(sq(), { scaleH: 0.5, scaleV: 0.5, copies: 2, scaleStrokes: true }, b, 4);
    expect(copies.map((s) => s.paint?.strokeWidth ?? 4)).toEqual([4, 2, 1]);
  });
});
