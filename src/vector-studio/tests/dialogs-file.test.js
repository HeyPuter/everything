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

describe('Document Setup type options', () => {
  it('turns typed straight quotes into the document quotes', async () => {
    const { typedQuote } = await import('../src/features/files/type-setup.js');
    expect(typedQuote({}, 'say ', 4, '"')).toBe('“');
    expect(typedQuote({}, 'say “hi', 7, '"')).toBe('”');
    expect(typedQuote({}, 'it', 2, "'")).toBe('’');
    const de = { typeOptions: { language: 'de', double: '„“', single: '‚‘', quotes: true } };
    expect(typedQuote(de, '', 0, '"')).toBe('„');
    expect(typedQuote({ typeOptions: { quotes: false } }, '', 0, '"')).toBe('"');
  });

  it('sets the language and quotes in Document Setup', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const done = app.commands.run('file.documentSetup');
    const d = await waitDialog();
    const lang = d.querySelector('#ds-lang');
    lang.value = 'fr';
    lang.dispatchEvent(new Event('change'));
    expect(d.querySelector('#ds-dq').value).toBe('«»');
    button('OK').click();
    await done;
    expect(app.editor.doc.root.typeOptions).toMatchObject({ language: 'fr', double: '«»', quotes: true });
  });
});

describe('SVG export styling and ids', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g1"><stop offset="0"/></linearGradient></defs><g id="Layer_1"><path id="Star" d="M0 0h1" fill="#f00" stroke="#000" stroke-width="2"/><path d="M0 0h2" fill="url(#g1)"/><rect width="1" height="1" fill="#f00" stroke="#000" stroke-width="2"/></g></svg>';

  it('leaves the default output alone', async () => {
    const { applySvgOptions } = await import('../src/features/io/svg-styling.js');
    expect(applySvgOptions(SVG)).toBe(SVG);
  });

  it('writes inline styles and internal CSS classes', async () => {
    const { applySvgOptions } = await import('../src/features/io/svg-styling.js');
    const inline = applySvgOptions(SVG, { styling: 'inline' });
    expect(inline).toContain('style="fill:#f00;stroke:#000;stroke-width:2"');
    expect(inline).not.toContain(' fill="#f00"');
    const css = applySvgOptions(SVG, { styling: 'css' });
    expect(css).toContain('.st0{fill:#f00;stroke:#000;stroke-width:2}');
    expect(css.match(/class="st0"/g)).toHaveLength(2);
    expect(css).toContain('<style>');
  });

  it('keeps only referenced ids, or gives every object one', async () => {
    const { applySvgOptions } = await import('../src/features/io/svg-styling.js');
    const minimal = applySvgOptions(SVG, { objectIds: 'minimal' });
    expect(minimal).toContain('id="g1"');
    expect(minimal).not.toContain('id="Star"');
    expect(minimal).not.toContain('id="Layer_1"');
    const unique = applySvgOptions(SVG, { objectIds: 'unique' });
    expect(unique).toContain('id="Star"');
    expect(unique).toMatch(/<rect[^>]*id="rect-\d+"/);
  });
});
