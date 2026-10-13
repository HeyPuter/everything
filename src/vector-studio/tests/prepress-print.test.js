import { describe, it, expect } from 'vitest';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { normalizePrint, PRINT_DEFAULTS } from '../src/features/io/print-settings.js';
import { pageSequence, printPlates, documentPlates, buildPrintOutput, printSummary, rasterOutput, processPlatePixels, overprintBlackView } from '../src/features/io/print-output.js';
import { layoutContent } from '../src/features/io/print-layout.js';
import { printJob } from '../src/features/io/print-dialog.js';
import { addSwatch } from '../src/features/paint/swatch-model.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const top = () => [...document.querySelectorAll('dialog[open]')].at(-1);
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}
const button = (label, d = top()) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  let spotId;
  doc.transact('Art', () => {
    spotId = addSwatch(doc, { name: 'Gold Ink', paint: { type: 'solid', color: '#c8a000' }, spot: true });
    doc.insert(createPath(rectangle(20, 20, 100, 100), true, { fill: { type: 'solid', color: '#c8a000', swatchId: spotId }, stroke: null }), ed.targetLayer().id);
    doc.insert(createPath(rectangle(60, 60, 100, 100), true, { fill: { type: 'solid', color: '#3366cc' }, stroke: null, overprintFill: true }), ed.targetLayer().id);
  });
  return { app, ed, doc, spotId };
}

describe('print settings', () => {
  it('normalizes values for presets', () => {
    const v = normalizePrint({ copies: '3', mode: 'nope', skipPlates: ['k'], which: 'range', bitmapPpi: 5000 });
    expect(v).toMatchObject({ copies: 3, mode: 'composite', skipPlates: ['k'], bitmapPpi: 1200 });
    expect('which' in v).toBe(false);
    expect(normalizePrint({}).marks).toEqual(PRINT_DEFAULTS.marks);
  });

  it('orders pages with copies, collation and reverse order', () => {
    const pages = ['A', 'B'];
    const plates = [{ id: 'composite' }];
    const ids = (st) => pageSequence(pages, plates, st).map((x) => x.page).join('');
    expect(ids({ copies: 1 })).toBe('AB');
    expect(ids({ copies: 2, collate: true })).toBe('ABAB');
    expect(ids({ copies: 2, collate: false })).toBe('AABB');
    expect(ids({ copies: 1, reverse: true })).toBe('BA');
    expect(pageSequence(pages, [{ id: 'c' }, { id: 'k' }], { copies: 1 }).map((x) => x.page + x.plate.id).join(' ')).toBe('Ac Ak Bc Bk');
  });

  it('draws Japanese trim marks at the trim and the bleed', () => {
    const rect = { x: 0, y: 0, w: 100, h: 100 };
    const roman = layoutContent(rect, { marks: { trim: true }, bleed: { top: 9, bottom: 9, left: 9, right: 9 } })[0].marks;
    const jp = layoutContent(rect, { marks: { trim: true }, markType: 'japanese', bleed: { top: 9, bottom: 9, left: 9, right: 9 } })[0].marks;
    expect(roman.length).toBe(8);
    // Four corners with two lines each way, plus four center marks of two lines.
    expect(jp.length).toBe(4 * 4 + 8);
  });
});

describe('separations and output', () => {
  it('lists the document inks and the plates to print', async () => {
    const { app, doc, spotId } = await setup();
    const st = normalizePrint({ mode: 'separations', skipPlates: ['y'] });
    expect(documentPlates(app, doc, st).map((p) => p.id)).toEqual(['c', 'm', 'y', 'k', spotId]);
    expect(printPlates(app, doc, st).map((p) => p.id)).toEqual(['c', 'm', 'k', spotId]);
    expect(printPlates(app, doc, { ...st, spotToProcess: true }).map((p) => p.id)).toEqual(['c', 'm', 'k']);
    expect(printPlates(app, doc, normalizePrint({})).map((p) => p.id)).toEqual(['composite']);
    expect(rasterOutput(st)).toBe(true);
    expect(rasterOutput(normalizePrint({}))).toBe(false);
  });

  it('turns pixels into plate densities', () => {
    const d = new Uint8ClampedArray([0, 255, 255, 255, 255, 255, 255, 255]);
    processPlatePixels(d, 'basic', 0);
    expect([...d]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it('sets black to overprint when asked', async () => {
    const { doc, ed } = await setup();
    const p = createPath(rectangle(0, 0, 5, 5), true, { fill: { type: 'solid', color: '#000000' }, stroke: null });
    doc.transact('k', () => doc.insert(p, ed.targetLayer().id));
    expect(overprintBlackView(doc).get(p.id).overprintFill).toBe(true);
  });

  it('builds composite pages with copies, negative and mirrored film, and a press proof', async () => {
    const { app, ed, doc } = await setup();
    const st = normalizePrint({ copies: 2, collate: true, image: 'negative', emulsion: 'down', colorHandling: 'proof' });
    const pages = printJob(doc, { ...st, which: 'all' });
    const { root } = await buildPrintOutput(app, ed, pages, st);
    const els = root.querySelectorAll('.io-print-page');
    expect(els.length).toBe(2 * pages.length);
    expect(els[0].style.filter).toContain('invert');
    expect(els[0].innerHTML).toContain('scale(-1 1)');
    expect(els[0].querySelector('filter feComponentTransfer')).toBeTruthy();
  });

  it('builds one raster page per plate for separations', async () => {
    const { app, ed, doc } = await setup();
    const st = normalizePrint({ mode: 'separations', marks: { pageInfo: true } });
    const pages = printJob(doc, { ...st, which: 'all' });
    const { root, count } = await buildPrintOutput(app, ed, pages, st);
    expect(count).toBe(5 * pages.length);
    expect(root.querySelectorAll('.io-print-page').length).toBe(count);
    expect(root.textContent).toContain('Gold Ink');
    expect(root.textContent).toContain('Magenta');
  });

  it('summarizes the job with warnings', async () => {
    const { app, ed, doc } = await setup();
    const st = normalizePrint({});
    const { options, warnings } = printSummary(app, ed, printJob(doc, { ...st, which: 'all' }), st);
    expect(options.find(([k]) => k === 'Mode')[1]).toBe('Composite color');
    expect(warnings.join(' ')).toMatch(/spot color will print as process/);
    expect(warnings.join(' ')).toMatch(/set to overprint/);
  });
});

describe('Print dialog and presets', () => {
  it('shows every pane and previews separations by plate', async () => {
    const { app } = await setup();
    const run = app.commands.run('file.print');
    const d = await waitFor(() => document.querySelector('dialog[open].print-dialog'));
    expect([...d.querySelectorAll('.pd-tab')].map((t) => t.textContent)).toEqual(['General', 'Marks and Bleed', 'Output', 'Graphics', 'Color Management', 'Advanced', 'Summary']);
    const output = [...d.querySelectorAll('[role="tabpanel"]')].find((p) => p.getAttribute('aria-label') === 'Output');
    const mode = output.querySelector('select[aria-label="Output mode"]');
    mode.value = 'separations';
    mode.dispatchEvent(new Event('change'));
    expect(d.querySelector('.pd-page-label').textContent).toBe('1 of 5 · Cyan');
    const summary = [...d.querySelectorAll('[role="tabpanel"]')].find((p) => p.getAttribute('aria-label') === 'Summary');
    expect(summary.textContent).toMatch(/Separations: Cyan, Magenta, Yellow, Black, Gold Ink/);
    // Choosing a preset fills the settings.
    const preset = d.querySelector('.pp-preset-select');
    preset.value = 'Fit to Letter';
    preset.dispatchEvent(new Event('change'));
    expect(d.querySelector('select[aria-label="Scaling"]').value).toBe('fit');
    button('Cancel', d).click();
    expect(await run).toBeNull();
  });

  it('edits print presets with the print panes', async () => {
    const { app } = await setup();
    const run = app.commands.run('edit.printPresets');
    await tick();
    const mgr = top();
    expect(mgr.querySelector('.dialog-title').textContent).toBe('Print Presets');
    button('New…', mgr).click();
    const ed = await waitFor(() => document.querySelector('dialog[open].print-dialog'));
    expect(ed.querySelector('.dialog-title').textContent).toBe('Print Preset Options (New)');
    expect(ed.querySelector('.pd-name').value).toBe('Print Preset 1');
    const copies = ed.querySelector('input[aria-label="Copies"]');
    copies.value = '3';
    copies.dispatchEvent(new Event('change'));
    button('OK', ed).click();
    await new Promise((r) => setTimeout(r, 30));
    button('OK', mgr).click();
    await run;
    expect(app.prefs.get('printPresets')['Print Preset 1'].copies).toBe(3);
  });
});
