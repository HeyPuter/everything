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

describe('Drop Shadow darkness', () => {
  it('chooses a darkness shadow in the dialog and exports it to SVG', async () => {
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const { exportSVG } = await import('../src/features/io/svg-export.js');
    const app = await bootAppWithFeatures();
    app.newDocument();
    const doc = app.editor.doc;
    const n = createPath(rectangle(0, 0, 50, 50), true, { fill: { type: 'solid', color: '#3366ff' }, stroke: null });
    doc.transact('r', () => doc.insert(n, app.editor.targetLayer().id));
    app.editor.select([n.id]);
    const done = app.commands.run('effect.dropShadow');
    await new Promise((r) => setTimeout(r, 0));
    const dlg = document.querySelector('dialog[open]');
    const label = (t) => [...dlg.querySelectorAll('label[for]')].find((l) => l.textContent === t);
    const darkInput = document.getElementById(label('Darkness').htmlFor);
    expect(darkInput.disabled).toBe(true);
    const radio = [...dlg.querySelectorAll('label.radio')].find((l) => l.textContent === 'Darkness').querySelector('input');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    expect(darkInput.disabled).toBe(false);
    darkInput.value = '40%';
    darkInput.dispatchEvent(new Event('input', { bubbles: true }));
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    const fx = doc.get(n.id).effects[0];
    expect(fx).toMatchObject({ type: 'dropShadow', shadowFrom: 'darkness', darkness: 0.4 });
    const svg = exportSVG(doc, { rect: { x: -50, y: -50, w: 200, h: 200 } });
    expect(svg).toContain('slope="0.6"');
  });
});
