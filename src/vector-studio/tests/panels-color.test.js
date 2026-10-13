import { describe, it, expect } from 'vitest';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { hexToRgb, rgbToHsb } from '../src/lib/color.js';
import { bootAppWithFeatures } from './helpers.js';
import { harmonyColors, variationRow, nearestColor, clusterColors, reduceColorsMap, harmonyMap, paletteMap, HARMONY_RULES, hexToLab } from '../src/features/panels/color-harmony.js';
import { quantizeCmyk, convertSelectionColors, isBlack, overprintBlack, exportSettingsData, parseSettings, applySettings, SETTINGS_FORMAT } from '../src/features/panels/edit-commands.js';
import { guideColors, GUIDE_DEFAULTS } from '../src/features/panels/color-guide.js';
import { findSwatch } from '../src/features/paint/swatch-model.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const solid = (color, extra = {}) => ({ type: 'solid', color, ...extra });
const hue = (hex) => rgbToHsb(hexToRgb(hex)).h;

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  const add = (style) => {
    const p = createPath(rectangle(0, 0, 10, 10), true, style);
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    return p.id;
  };
  return { app, ed, doc, add };
}

describe('Color harmony', () => {
  it('rotates hues for hue rules and includes the base', () => {
    const base = '#ff0000';
    expect(harmonyColors(base, 'complementary')).toEqual(['#ff0000', '#00ffff']);
    const triad = harmonyColors(base, 'triad');
    expect(triad.map((c) => Math.round(hue(c)))).toEqual([0, 120, 240]);
    const split = harmonyColors(base, 'split');
    expect(split.map((c) => Math.round(hue(c)))).toEqual([0, 150, 210]);
    for (const r of HARMONY_RULES) {
      const out = harmonyColors('#3366cc', r.id);
      expect(out).toContain('#3366cc');
      expect(out.length).toBeGreaterThan(1);
      for (const c of out) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('builds tone rules from the base hue', () => {
    const shades = harmonyColors('#3366cc', 'shades');
    const v = shades.map((c) => rgbToHsb(hexToRgb(c)).v);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeLessThan(v[i - 1]);
    const mono = harmonyColors('#3366cc', 'monochrome');
    for (const c of mono.slice(1)) expect(Math.abs(hue(c) - hue('#3366cc'))).toBeLessThan(2);
  });

  it('makes variation rows: shades left, tints right, the color in the middle', () => {
    const row = variationRow('#3366cc', 'tints', 3, 100);
    expect(row.length).toBe(7);
    expect(row[3]).toBe('#3366cc');
    expect(row[0]).toBe('#000000');
    expect(row[6]).toBe('#ffffff');
    const vivid = variationRow('#6688aa', 'vividMuted', 2);
    const s = vivid.map((c) => rgbToHsb(hexToRgb(c)).s);
    expect(s[0]).toBeLessThan(s[2]);
    expect(s[4]).toBeGreaterThan(s[2]);
    const wc = variationRow('#8844cc', 'warmCool', 2);
    expect(wc[2]).toBe('#8844cc');
    expect(wc[4]).not.toBe(wc[0]);
  });

  it('measures perceptual distance and snaps to the nearest palette color', () => {
    expect(hexToLab('#ffffff').l).toBeCloseTo(100, 0);
    expect(hexToLab('#000000').l).toBeCloseTo(0, 0);
    expect(nearestColor('#fe0101', ['#00ff00', '#ff0000', '#0000ff'])).toBe('#ff0000');
  });

  it('clusters colors into k groups and reduces them, keeping brightness', () => {
    const colors = [
      { color: '#ff0000', count: 5 },
      { color: '#cc0000', count: 2 },
      { color: '#0000ff', count: 4 },
      { color: '#0000aa', count: 1 },
    ];
    const { centers, assign } = clusterColors(colors, 2);
    expect(centers.sort()).toEqual(['#0000ff', '#ff0000']);
    expect(assign.get('#cc0000')).toBe(assign.get('#ff0000'));
    const one = reduceColorsMap(colors, 1);
    // Everything takes the red hue; the dark blue stays dark.
    for (const v of Object.values(one)) expect(Math.round(hue(v)) % 360).toBe(0);
    expect(rgbToHsb(hexToRgb(one['#0000aa'])).v).toBeLessThan(rgbToHsb(hexToRgb(one['#0000ff'])).v);
    const h = harmonyMap(colors, 'complementary');
    expect(Object.keys(h).length).toBe(4);
    expect(paletteMap(colors, ['#ee1111', '#1111ee'])).toEqual({ '#ff0000': '#ee1111', '#cc0000': '#ee1111', '#0000ff': '#1111ee', '#0000aa': '#1111ee' });
  });

  it('the Color Guide limits its colors to a palette', () => {
    const g = { ...GUIDE_DEFAULTS, base: '#3366cc', rule: 'triad', steps: 2 };
    const free = guideColors(g);
    expect(free.harmony.length).toBe(3);
    expect(free.rows.every((r) => r.length === 5)).toBe(true);
    const lim = guideColors(g, ['#000000', '#ffffff', '#3366cc']);
    for (const c of [...lim.harmony, ...lim.rows.flat()]) expect(['#000000', '#ffffff', '#3366cc']).toContain(c);
  });
});

describe('Convert to CMYK / RGB', () => {
  it('rounds colors through whole CMYK percentages and marks them', async () => {
    const { ed, doc, add } = await setup();
    const id = add({ fill: solid('#3a7bd5'), stroke: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#123456', opacity: 1 }, { offset: 1, color: '#abcdef', opacity: 1 }] } });
    ed.select([id]);
    const q = quantizeCmyk('#3a7bd5');
    expect(Object.values(q.cmyk).every(Number.isInteger)).toBe(true);
    convertSelectionColors(ed, 'cmyk');
    const n = doc.get(id);
    expect(n.fill).toMatchObject({ color: q.color, mode: 'cmyk', cmyk: q.cmyk });
    expect(n.stroke.stops[0].color).toBe(quantizeCmyk('#123456').color);
    convertSelectionColors(ed, 'rgb');
    expect(doc.get(id).fill.mode).toBe('rgb');
    expect(doc.get(id).fill.cmyk).toBeUndefined();
    doc.undo();
    doc.undo();
    expect(doc.get(id).fill).toEqual(solid('#3a7bd5'));
  });

  it('marks the global swatches the selection uses', async () => {
    const { ed, doc, add } = await setup();
    const sw = doc.root.swatches[15];
    doc.transact('Global', () => doc.updateRoot({ swatches: doc.root.swatches.map((s) => (s.id === sw.id ? { ...s, global: true } : s)) }));
    const id = add({ fill: { ...solid(sw.paint.color), swatchId: sw.id } });
    ed.select([id]);
    convertSelectionColors(ed, 'cmyk');
    expect(findSwatch(doc, sw.id).mode).toBe('cmyk');
    expect(doc.get(id).fill.swatchId).toBe(sw.id);
  });
});

describe('Overprint Black', () => {
  it('finds blacks by their K value and optional CMY', () => {
    expect(isBlack(solid('#000000'))).toBe(true);
    expect(isBlack(solid('#333333'), 80)).toBe(true);
    expect(isBlack(solid('#333333'), 90)).toBe(false);
    expect(isBlack(solid('#1a0000'), 50)).toBe(false);
    expect(isBlack(solid('#1a0000'), 50, true)).toBe(true);
    expect(isBlack({ type: 'solid', color: '#111111', cmyk: { c: 60, m: 40, y: 40, k: 100 } }, 100)).toBe(false);
    expect(isBlack({ type: 'solid', color: '#111111', cmyk: { c: 60, m: 40, y: 40, k: 100 } }, 100, true)).toBe(true);
    expect(isBlack(null)).toBe(false);
  });

  it('adds and removes overprint on black fills and strokes', async () => {
    const { ed, doc, add } = await setup();
    const a = add({ fill: solid('#000000'), stroke: solid('#ff0000') });
    const b = add({ fill: solid('#ffffff'), stroke: solid('#000000') });
    ed.select([a, b]);
    expect(overprintBlack(ed, { add: true })).toBe(2);
    expect(doc.get(a)).toMatchObject({ overprintFill: true });
    expect(doc.get(a).overprintStroke).toBeUndefined();
    expect(doc.get(b)).toMatchObject({ overprintStroke: true });
    expect(overprintBlack(ed, { add: false, stroke: false })).toBe(1);
    expect(doc.get(a).overprintFill).toBe(false);
  });

  it('the dialog applies its settings', async () => {
    const { app, ed, doc, add } = await setup();
    const a = add({ fill: solid('#000000') });
    ed.select([a]);
    const done = app.commands.run('color.overprintBlack');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(doc.get(a).overprintFill).toBe(true);
  });
});

describe('Recolor with Preset', () => {
  it('opens Recolor with the reduced colors assigned', async () => {
    const { app, ed, doc, add } = await setup();
    const a = add({ fill: solid('#ff0000'), stroke: null });
    const b = add({ fill: solid('#0000ff'), stroke: null });
    ed.select([a, b]);
    const done = app.commands.run('color.preset.one');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    expect(dlg.querySelector('.dialog-title').textContent).toBe('Recolor: 1 Color');
    const news = [...dlg.querySelectorAll('input.rc-new')].map((i) => i.value);
    expect(new Set(news.map((c) => Math.round(hue(c)))).size).toBe(1);
    [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'OK').click();
    await done;
    expect(Math.round(hue(doc.get(a).fill.color))).toBe(Math.round(hue(doc.get(b).fill.color)));
  });

  it('limits colors to a chosen library', async () => {
    const { app, ed, add } = await setup();
    ed.select([add({ fill: solid('#fe0102'), stroke: null })]);
    const done = app.commands.run('color.preset.library');
    await tick();
    let dlg = document.querySelector('dialog[open]');
    const sel = dlg.querySelector('select');
    sel.value = 'brights';
    [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'OK').click();
    await tick();
    await tick();
    dlg = document.querySelector('dialog[open]');
    expect(dlg.querySelector('.dialog-title').textContent).toBe('Recolor: Brights');
    expect(dlg.querySelector('input.rc-new').value).toBe('#ff2d3c');
    [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'Cancel').click();
    await done;
  });
});

describe('My Settings', () => {
  it('exports preferences without session state and imports them back', async () => {
    const { app } = await setup();
    app.prefs.set('keyboardIncrement', 5);
    app.prefs.set('lastRect', { w: 1 });
    const data = exportSettingsData(app.prefs);
    expect(data.format).toBe(SETTINGS_FORMAT);
    expect(data.prefs.keyboardIncrement).toBe(5);
    expect('lastRect' in data.prefs).toBe(false);
    expect('recentFiles' in data.prefs).toBe(false);
    expect(() => parseSettings({ format: 'other' })).toThrow(/not a Vector Studio settings file/);
    const values = parseSettings(JSON.parse(JSON.stringify({ ...data, prefs: { ...data.prefs, keyboardIncrement: 2, theme: 'dark', recentFiles: ['x'] } })));
    expect(values.recentFiles).toBeUndefined();
    const events = [];
    app.on('settings-imported', (v) => events.push(v));
    applySettings(app, values);
    expect(app.prefs.get('keyboardIncrement')).toBe(2);
    expect(document.documentElement.dataset.themeResolved || app.prefs.get('theme')).toBeTruthy();
    expect(events.length).toBe(1);
  });
});
