import { describe, it, expect, vi } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addSwatch, addGroup, swatchesOf, groupsOf, findSwatch } from '../src/features/paint/swatch-model.js';
import { spotInks, spotEquivalents, isSpot } from '../src/features/prepress/separations.js';
import { applySpotSettings, spotColorsDialog, pressCmyk } from '../src/features/paint/spot-colors.js';
import { encodeSwatchExchange, decodeSwatchExchange, swatchesCss, cssVarName } from '../src/features/paint/swatch-exchange.js';
import { parseSwatchFile } from '../src/features/paint/swatch-libraries.js';
import { recolorGroup } from '../src/features/paint/edit-colors-ui.js';
import { writePDF } from '../src/features/io/pdf.js';
import { installCanvasStub } from './helpers.js';

const solid = (color, extra = {}) => ({ type: 'solid', color, ...extra });
const dialog = () => document.querySelector('dialog[open]');
const button = (label) => [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const tick = () => new Promise((r) => setTimeout(r, 0));
const latin1 = (b) => Array.from(b, (c) => String.fromCharCode(c)).join('');

describe('Spot Colors', () => {
  it('prints inks as process and uses their CMYK equivalents', () => {
    const doc = VDocument.create({ width: 100, height: 100 });
    let a;
    let b;
    doc.transact('inks', () => {
      a = addSwatch(doc, { name: 'Ink A', paint: solid('#e03020'), spot: true });
      b = addSwatch(doc, { name: 'Ink B', paint: solid('#2040c0'), spot: true });
    });
    expect(spotInks(doc).map((s) => s.name)).toEqual(['Ink A', 'Ink B']);
    doc.transact('Spot Colors', () => applySpotSettings(doc, { definition: 'cmyk', inks: [{ id: a, name: 'Signal Red', printAsProcess: false, cmyk: { c: 0, m: 90, y: 85, k: 0 } }, { id: b, printAsProcess: true, cmyk: { c: 100, m: 70, y: 0, k: 5 } }] }));
    expect(isSpot(findSwatch(doc, b))).toBe(false);
    expect(spotInks(doc)).toEqual([{ id: a, name: 'Signal Red', color: '#e03020', cmyk: { c: 0, m: 90, y: 85, k: 0 } }]);
    expect([...spotEquivalents(doc).keys()]).toEqual([a, b]);
    // The on-screen definition ignores the equivalents.
    doc.transact('lab', () => applySpotSettings(doc, { definition: 'lab' }));
    expect(spotInks(doc)[0].cmyk).toBeUndefined();
    expect(spotEquivalents(doc).size).toBe(0);
    doc.undo();
    expect(doc.root.spotColors.definition).toBe('cmyk');
  });

  it('writes the equivalents into CMYK PDF output', async () => {
    installCanvasStub();
    const doc = VDocument.create({ width: 200, height: 200 });
    let a;
    let b;
    doc.transact('inks', () => {
      a = addSwatch(doc, { name: 'Ink A', paint: solid('#e03020'), spot: true, spotCmyk: { c: 0, m: 90, y: 85, k: 0 } });
      b = addSwatch(doc, { name: 'Ink B', paint: solid('#2040c0'), spot: true, printAsProcess: true, spotCmyk: { c: 100, m: 70, y: 0, k: 5 } });
      doc.updateRoot({ spotColors: { definition: 'cmyk' } });
      const layer = doc.layers()[0].id;
      doc.insert(createPath(rectangle(10, 10, 50, 50), true, { fill: solid('#e03020', { swatchId: a }), stroke: null }), layer);
      doc.insert(createPath(rectangle(80, 10, 50, 50), true, { fill: solid('#2040c0', { swatchId: b }), stroke: null }), layer);
    });
    const { bytes } = await writePDF(doc, [{ x: 0, y: 0, w: 200, h: 200 }], { compress: false, colorSpace: 'cmyk', spots: new Map(spotInks(doc).map((s) => [s.id, s])), spotEquivalents: spotEquivalents(doc) });
    const s = latin1(bytes);
    // Ink A: a Separation whose alternate is its CMYK equivalent.
    expect(s).toMatch(/\/Separation \/Ink#20A \/DeviceCMYK << \/FunctionType 2 \/Domain \[0 1\] \/C0 \[0 0 0 0\] \/C1 \[0 0\.9 0\.85 0\]/);
    // Ink B prints as process with its equivalent.
    expect(s).toMatch(/\n1 0\.7 0 0\.05 k\n/);
  });

  it('edits the inks in the dialog', async () => {
    const { app, ed, doc, panel, menuItem } = await paintSetup();
    let id;
    doc.transact('ink', () => (id = addSwatch(doc, { name: 'Ink', paint: solid('#10a050'), spot: true })));
    const p = panel('swatches');
    menuItem(p, 'Spot Colors...').run();
    await tick();
    const dlg = dialog();
    expect(dlg.querySelectorAll('.spc-row').length).toBe(1);
    // Prefilled from the press model.
    const pre = pressCmyk('#10a050');
    expect(Number(dlg.querySelector('.spc-num').value)).toBeCloseTo(pre.c, 1);
    dlg.querySelector('input[value="cmyk"]').checked = true;
    dlg.querySelector('.spc-print').value = 'process';
    dlg.querySelectorAll('.spc-num')[3].value = '12';
    button('OK').click();
    await tick();
    const sw = findSwatch(doc, id);
    expect(sw.printAsProcess).toBe(true);
    expect(sw.spotCmyk.k).toBe(12);
    expect(doc.root.spotColors.definition).toBe('cmyk');
    expect(app.editor).toBe(ed);
  });
});

describe('Swatch Options for gradients and patterns', () => {
  it('edits a gradient swatch', async () => {
    const { ed, doc, panel } = await paintSetup();
    let id;
    doc.transact('g', () => (id = addSwatch(doc, { name: 'Fade', paint: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }] } })));
    const p = panel('swatches');
    const done = p.editSwatch(id);
    await tick();
    const dlg = dialog();
    const type = dlg.querySelector('#swo-gtype');
    type.value = 'radial';
    type.dispatchEvent(new Event('change'));
    expect(dlg.querySelector('#swo-aspect').closest('.form-row').hidden).toBe(false);
    button('Reverse').click();
    const color = dlg.querySelector('#swo-stop-color');
    color.value = '#ff0000';
    color.dispatchEvent(new Event('input'));
    dlg.querySelector('#swo-name').value = 'Red Fade';
    button('OK').click();
    await done;
    const sw = findSwatch(doc, id);
    expect(sw.name).toBe('Red Fade');
    expect(sw.paint.type).toBe('radial');
    expect(sw.paint.stops[0].color).toBe('#ff0000');
    expect(sw.paint.stops[1].color).toBe('#ffffff');
    ed.doc.undo();
    expect(findSwatch(doc, id).paint.type).toBe('linear');
  });

  it('opens pattern editing from a pattern swatch', async () => {
    const { app, doc, panel } = await paintSetup();
    let id;
    doc.transact('p', () => (id = addSwatch(doc, { name: 'Dots', paint: { type: 'pattern', id: 'pat-x' } })));
    const p = panel('swatches');
    const run = vi.spyOn(app.commands, 'run').mockImplementation(() => {});
    const done = p.editSwatch(id);
    await tick();
    button('Edit Pattern...').click();
    await done;
    expect(run).toHaveBeenCalledWith('pattern.edit', { patternId: 'pat-x' });
    run.mockRestore();
  });
});

describe('color groups and selected colors', () => {
  it('Edit Color Group recolors the group and the art linked to it', async () => {
    const { ed, doc, add, panel, menuItem } = await paintSetup();
    let gid;
    let a;
    doc.transact('g', () => {
      gid = addGroup(doc, 'Brand');
      a = addSwatch(doc, { name: 'Red', paint: solid('#ff0000'), global: true, group: gid });
      addSwatch(doc, { name: 'Blue', paint: solid('#0000ff'), group: gid });
    });
    const obj = add({ fill: solid('#ff0000', { swatchId: a }), stroke: null });
    const p = panel('swatches');
    p.selected = new Set([gid]);
    expect(menuItem(p, 'Edit Color Group...').enabled).toBe(true);
    const done = p.editColorGroup();
    await tick();
    const dlg = dialog();
    const rows = dlg.querySelectorAll('.rc-new');
    expect(rows.length).toBe(2);
    rows[0].value = '#00ff00';
    rows[0].dispatchEvent(new Event('input', { bubbles: true }));
    // Live preview inside the open edit.
    expect(findSwatch(doc, a).paint.color).toBe('#00ff00');
    button('OK').click();
    await done;
    expect(findSwatch(doc, a).paint.color).toBe('#00ff00');
    expect(doc.get(obj).fill.color).toBe('#00ff00');
    doc.undo();
    expect(findSwatch(doc, a).paint.color).toBe('#ff0000');
    expect(doc.get(obj).fill.color).toBe('#ff0000');
    expect(ed.doc).toBe(doc);
  });

  it('can save the recolored group as a new one', () => {
    const doc = VDocument.create({ width: 10, height: 10 });
    let gid;
    doc.transact('g', () => {
      gid = addGroup(doc, 'Warm', { paints: [{ name: 'A', paint: solid('#ff0000') }, { name: 'B', paint: solid('#ffaa00') }] });
      recolorGroup(doc, gid, (hex) => (hex === '#ff0000' ? '#00ff00' : hex), { asNew: true });
    });
    expect(groupsOf(doc).map((g) => g.name)).toEqual(['Warm', 'Warm copy']);
    const copy = groupsOf(doc)[1].id;
    expect(swatchesOf(doc).filter((s) => s.group === copy).map((s) => s.paint.color)).toEqual(['#00ff00', '#ffaa00']);
    expect(swatchesOf(doc).filter((s) => s.group === gid).map((s) => s.paint.color)).toEqual(['#ff0000', '#ffaa00']);
  });

  it('adds the selection colors as swatches, global swatches or a group', async () => {
    const { ed, doc, add, panel, menuItem } = await paintSetup();
    const o1 = add({ fill: solid('#123456'), stroke: solid('#abcdef') });
    const o2 = add({ fill: solid('#123456'), stroke: null });
    ed.select([o1, o2]);
    const p = panel('swatches');
    const before = swatchesOf(doc).length;
    menuItem(p, 'Add Selected Colors as Global Swatches').run();
    const added = swatchesOf(doc).slice(before);
    expect(added.map((s) => [s.paint.color, Boolean(s.global)])).toEqual([['#123456', true], ['#abcdef', true]]);
    // The art links to them.
    expect(doc.get(o1).fill.swatchId).toBe(added[0].id);
    expect(doc.get(o1).stroke.swatchId).toBe(added[1].id);
    expect(doc.get(o2).fill.swatchId).toBe(added[0].id);
    // Again: nothing new.
    menuItem(p, 'Add Selected Colors as Global Swatches').run();
    expect(swatchesOf(doc).length).toBe(before + 2);
    menuItem(p, 'Add Selected Colors as Color Group').run();
    const g = groupsOf(doc).at(-1);
    expect(swatchesOf(doc).filter((s) => s.group === g.id).map((s) => s.paint.color)).toEqual(['#123456', '#abcdef']);
  });
});

describe('swatch interchange', () => {
  const lib = [
    { name: 'Paper', paint: solid('#fafaf5') },
    { name: 'Signal', paint: solid('#e03020'), global: true, spot: true, mode: 'cmyk', spotCmyk: { c: 0, m: 90, y: 85, k: 0 }, group: 'Brand' },
    { name: 'Ink Blue', paint: solid('#2040c0'), global: true, group: 'Brand' },
    { name: 'Slate', paint: solid('#556677'), mode: 'gray' },
    { name: 'Glow', paint: { type: 'radial', angle: 30, aspect: 0.5, stops: [{ offset: 0, color: '#ffffff', opacity: 1, midpoint: 0.3 }, { offset: 1, color: '#000000', opacity: 0.5 }] } },
    { name: 'Tiles', paint: { type: 'pattern', id: 'p1' } },
  ];

  it('round-trips colors, groups, kinds and gradients through the binary format', () => {
    const bytes = encodeSwatchExchange(lib);
    expect(latin1(bytes.slice(0, 4))).toBe('VSWX');
    const { swatches } = decodeSwatchExchange(bytes);
    expect(swatches.map((s) => s.name)).toEqual(['Paper', 'Slate', 'Glow', 'Signal', 'Ink Blue']);
    const signal = swatches.find((s) => s.name === 'Signal');
    expect(signal).toMatchObject({ paint: solid('#e03020'), global: true, spot: true, mode: 'cmyk', group: 'Brand' });
    expect(signal.spotCmyk.m).toBeCloseTo(90, 3);
    expect(swatches.find((s) => s.name === 'Slate').mode).toBe('gray');
    const glow = swatches.find((s) => s.name === 'Glow').paint;
    expect(glow.type).toBe('radial');
    expect(glow.angle).toBeCloseTo(30, 4);
    expect(glow.aspect).toBeCloseTo(0.5, 4);
    expect(glow.stops[0].midpoint).toBeCloseTo(0.3, 4);
    expect(glow.stops[1].opacity).toBeCloseTo(0.5, 4);
    // The file reader picks the format from the bytes.
    expect(parseSwatchFile(bytes, 'Brand.vswx').swatches.length).toBe(5);
    expect(parseSwatchFile(bytes.slice(0, 20), 'bad.vswx')).toBe(null);
  });

  it('writes CSS custom properties', () => {
    const css = swatchesCss('Brand', lib);
    expect(css).toMatch(/--paper: #fafaf5;/);
    expect(css).toMatch(/\/\* Brand \*\/\n {2}--signal: #e03020;/);
    expect(css).toMatch(/--glow: radial-gradient\(/);
    expect(css).not.toMatch(/tiles/);
    const used = new Set();
    expect(cssVarName('Sky Blue', used)).toBe('--sky-blue');
    expect(cssVarName('Sky  blue!', used)).toBe('--sky-blue-2');
    expect(cssVarName('10%', used)).toBe('--c-10');
  });

  it('keeps groups and kinds in JSON libraries', () => {
    const text = JSON.stringify({ format: 'vector-studio-swatches', name: 'X', swatches: lib });
    const parsed = parseSwatchFile(new TextEncoder().encode(text), 'X.json');
    expect(parsed.swatches[1]).toMatchObject({ group: 'Brand', mode: 'cmyk', spot: true });
  });
});
