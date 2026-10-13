import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { exportFormats } from '../src/features/io/hooks.js';
import { createPath, createImage } from '../src/model/nodes.js';
import { encodePNGSync } from '../src/features/interop/codec/png.js';
import { bytesToDataUrl } from '../src/features/io/image-info.js';
import { rectangle } from '../src/model/shapes.js';

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
});
beforeEach(async () => {
  app = await bootAppWithFeatures();
});
afterEach(() => {
  document.querySelectorAll('dialog').forEach((d) => d.remove());
});

async function openDialogEl() {
  for (let i = 0; i < 300; i++) {
    const d = document.querySelector('dialog[open]');
    if (d) return d;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('No dialog');
}

describe('EPS export options', () => {
  it('offers the flattener presets and flattens transparency by default', async () => {
    expect(exportFormats.get('eps').defaults.flattener).toBe('Medium Resolution');
    const { formatOptionsDialog } = await import('../src/features/io/dialogs.js');
    const pending = formatOptionsDialog(app, 'eps');
    const dlg = await openDialogEl();
    const label = [...dlg.querySelectorAll('label')].find((l) => l.textContent === 'Flatten transparency');
    expect(label).toBeTruthy();
    const select = dlg.querySelector(`#${label.htmlFor}`);
    expect([...select.options].map((o) => o.value)).toEqual(expect.arrayContaining(['High Resolution', 'Medium Resolution', 'Low Resolution', 'none']));
    select.value = 'Low Resolution';
    [...dlg.querySelectorAll('.dialog-footer button')].find((b) => b.textContent === 'OK').click();
    expect(await pending).toMatchObject({ flattener: 'Low Resolution' });
  });

  it('writes transparent artwork opaque through the export job', async () => {
    const ed = app.newDocument({ width: 100, height: 100 });
    ed.doc.transact('x', () => {
      ed.doc.insert(createPath(rectangle(10, 10, 40, 40), true, { fill: { type: 'solid', color: '#0000ff' }, stroke: null }), ed.targetLayer().id);
      ed.doc.insert(createPath(rectangle(30, 30, 40, 40), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null, opacity: 0.5 }), ed.targetLayer().id);
    });
    const notes = [];
    app.notify = (msg) => notes.push(msg);
    const { renderFile } = await import('../src/features/io/jobs.js');
    const blob = await renderFile(app, ed, 'eps', { artboard: 0 }, { level: 3, preview: 'none', textOutlines: false, flattener: 'High Resolution' });
    const text = await blob.text();
    expect(text).toMatch(/0\.502 0 0\.502 rgb|0\.502 0 0\.502 setrgbcolor/);
    expect(notes.join(' ')).not.toMatch(/transparency/);
    // The document itself keeps its transparency.
    expect([...ed.doc.nodes.values()].some((n) => n.opacity === 0.5)).toBe(true);
  });
});

describe('DXF export with images', () => {
  it('delivers the drawing and its images together in a ZIP archive', async () => {
    const ed = app.newDocument({ width: 100, height: 100 });
    ed.doc.assets.set('a1', { mime: 'image/png', data: bytesToDataUrl(encodePNGSync({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) }), 'image/png') });
    ed.doc.transact('x', () => ed.doc.insert(createImage('a1', 2, 2, [20, 0, 0, 20, 10, 10]), ed.targetLayer().id));
    const { renderFile } = await import('../src/features/io/jobs.js');
    const blob = await renderFile(app, ed, 'dxf', { artboard: 0 }, { version: 'R2000', unit: 'mm', title: 'Plan' });
    expect(blob.fileExt).toBe('zip');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 3, 4]);
    expect(text).toContain('Plan.dxf');
    expect(text).toContain('Plan-image-1.png');
    // Without images the result stays a plain DXF file.
    const plain = app.newDocument({ width: 100, height: 100 });
    plain.doc.transact('x', () => plain.doc.insert(createPath(rectangle(10, 10, 40, 40), true, { fill: null, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 1 }), plain.targetLayer().id));
    const dxfBlob = await renderFile(app, plain, 'dxf', { artboard: 0 }, { version: 'R2000', unit: 'mm' });
    expect(dxfBlob.fileExt).toBeUndefined();
    expect(dxfBlob.type).toBe('application/dxf');
  });
});

describe('3D export in the app', () => {
  it('exports 3D objects from Export As and the 3D panel menu', async () => {
    const { newParams } = await import('../src/features/three-d/params.js');
    const { normalizeEffect } = await import('../src/features/paint/effects-model.js');
    const ed = app.newDocument({ width: 200, height: 200 });
    const node = createPath(rectangle(20, 20, 60, 40), true, { fill: { type: 'solid', color: '#3366cc' }, stroke: null, effects: [normalizeEffect({ type: 'threeD', ...newParams('extrude') })] });
    ed.doc.transact('x', () => ed.doc.insert(node, ed.targetLayer().id));
    expect(exportFormats.get('obj').label).toMatch(/OBJ/);
    const { renderFile, allFormats } = await import('../src/features/io/jobs.js');
    expect(Object.keys(allFormats())).toEqual(expect.arrayContaining(['obj', 'glb']));
    const glb = await renderFile(app, ed, 'glb', { artboard: 0 }, { orientation: 'view' });
    expect(new Uint8Array(await glb.arrayBuffer()).subarray(0, 4)).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
    const obj = await renderFile(app, ed, 'obj', { artboard: 0 }, { orientation: 'model', units: 'mm', title: 'Box' });
    expect(obj.fileExt).toBe('zip');
    expect(new TextDecoder('latin1').decode(new Uint8Array(await obj.arrayBuffer()))).toContain('Box.obj');
    // The panel menu exports the selected objects.
    ed.select([node.id]);
    app.openPanel('3d');
    const panel = app.dock.panels.get('3d');
    const menu = panel.menu().filter((m) => typeof m !== 'string');
    const labels = menu.map((m) => m.label);
    expect(menu.find((m) => m.label === 'Export as OBJ...').enabled).toBe(true);
    expect(labels).toEqual(expect.arrayContaining(['Export as OBJ...', 'Export as glTF Binary...']));
    // Nothing to export: a clear message.
    const empty = app.newDocument({ width: 100, height: 100 });
    await expect(renderFile(app, empty, 'glb', { artboard: 0 }, {})).rejects.toThrow(/no 3D objects/);
  });
});
