import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { exportFormats } from '../src/features/io/hooks.js';
import { createPath } from '../src/model/nodes.js';
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
