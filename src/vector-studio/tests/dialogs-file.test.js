import { describe, it, expect, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { artboardPositions, parsePresetForm } from '../src/features/files/presets.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const dlg = () => document.querySelector('dialog[open]');
async function waitDialog() {
  for (let i = 0; i < 200 && !dlg(); i++) await tick(10);
  return dlg();
}
const button = (label) => [...dlg().querySelectorAll('button')].find((b) => b.textContent === label);

describe('New Document', () => {
  it('lays out artboards by row, by column, in one row and right to left', () => {
    expect(artboardPositions(4, 100, 50, { layout: 'gridRow', spacing: 10, columns: 2 })).toEqual([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 0, y: 60 },
      { x: 110, y: 60 },
    ]);
    expect(artboardPositions(3, 100, 50, { layout: 'gridCol', spacing: 10, columns: 2 })).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 60 },
      { x: 110, y: 0 },
    ]);
    expect(artboardPositions(3, 100, 50, { layout: 'row', spacing: 0 }).map((p) => p.x)).toEqual([0, 100, 200]);
    expect(artboardPositions(3, 100, 50, { layout: 'col', spacing: 0 }).map((p) => p.y)).toEqual([0, 50, 100]);
    expect(artboardPositions(2, 100, 50, { layout: 'row', spacing: 0, rtl: true }).map((p) => p.x)).toEqual([100, 0]);
  });

  it('parses color mode and layout settings', () => {
    const base = { name: 'Doc', width: '100', height: '50', units: 'pt', artboards: '3', bleed: {}, colorMode: 'CMYK', layout: 'row', spacing: '5', columns: '' };
    const r = parsePresetForm(base);
    expect(r.value).toMatchObject({ colorMode: 'CMYK', layout: 'row', spacing: 5, columns: 0, rtl: false });
    expect(parsePresetForm({ ...base, spacing: '-1' })).toMatchObject({ ok: false, field: 'spacing' });
    expect(parsePresetForm({ ...base, artboards: '1' }).value.layout).toBeUndefined();
  });

  it('creates a CMYK document with its artboards in one column', async () => {
    const app = await bootAppWithFeatures();
    const done = app.commands.run('file.new');
    const d = await waitDialog();
    const set = (id, v) => {
      const el = d.querySelector(`#${id}`);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('nd-width', '100');
    set('nd-height', '50');
    set('nd-artboards', '3');
    expect(d.querySelector('.newdoc-layout-box').hidden).toBe(false);
    d.querySelector('[data-layout="col"]').click();
    expect(d.querySelector('#nd-columns').disabled).toBe(true);
    set('nd-spacing', '10');
    set('nd-color', 'CMYK');
    button('Create').click();
    await done;
    await tick(10);
    const doc = app.editor.doc;
    expect(doc.root.colorMode).toBe('CMYK');
    const units = doc.root.units;
    const k = { pt: 1, in: 72, mm: 72 / 25.4, px: 1, pc: 12, cm: 72 / 2.54 }[units];
    expect(doc.artboards.map((a) => Math.round(a.y / k))).toEqual([0, 60, 120]);
    expect(doc.undoStack.length).toBe(0);
  });
});

describe('Export for Screens', () => {
  it('ticks the artboards in a range and exports the full document as one file', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument({ artboards: 3 });
    const doc = app.editor.doc;
    doc.transact('r', () => doc.insert(createPath(rectangle(0, 0, 50, 50), true, { fill: { type: 'solid', color: '#ff0000' } }), app.editor.targetLayer().id));
    app.prefs.set('io:screens', undefined);
    const names = [];
    const orig = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:x';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      names.push(this.download);
    });
    try {
      const done = app.commands.run('file.exportScreens');
      const d = await waitDialog();
      const range = d.querySelector('.io-select-row .io-range');
      range.value = '2';
      range.dispatchEvent(new Event('input'));
      const checks = [...d.querySelectorAll('.io-asset input[type=checkbox]')];
      expect(checks.map((c) => c.checked)).toEqual([false, true, false]);
      const fmt = d.querySelector('.io-format-row select:nth-of-type(2)') || d.querySelectorAll('.io-format-row select')[1];
      fmt.value = 'svg';
      fmt.dispatchEvent(new Event('change'));
      const full = [...d.querySelectorAll('.form-row.check')].find((r) => r.textContent.startsWith('Full Document')).querySelector('input');
      full.checked = true;
      full.dispatchEvent(new Event('change'));
      expect(checks[1].disabled).toBe(true);
      button('Export Artboard').click();
      await done;
      await tick(50);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/\.svg$/);
    } finally {
      click.mockRestore();
      URL.createObjectURL = orig;
    }
  });

  it('fills the formats from the iOS preset', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const done = app.commands.run('file.exportScreens');
    await waitDialog();
    button('iOS').click();
    expect(dlg().querySelectorAll('.io-format-row')).toHaveLength(3);
    button('Cancel').click();
    await done;
  });
});
