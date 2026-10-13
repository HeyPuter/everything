// Character options: underline and strikethrough options, anti-aliasing in
// raster export, the font height reference of the size field, standard
// vertical Roman alignment, tate-chu-yoko, tsume and aki; and SVG export of
// the language, tracking and kerning.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { resolveItems } from '../src/ui/menubar.js';
import { createText } from '../src/model/nodes.js';
import { layoutText, glyphPlacements, decorationOf, decorationRects, fontHeightRatio } from '../src/model/text-layout.js';
import { drawNode } from '../src/render/draw.js';
import { textPieces } from '../src/features/io/text-segments.js';
import { exportSVG as rawExport } from '../src/features/io/svg-export.js';
import { svgToNodes } from '../src/features/io/svg-import.js';

const exportSVG = (d, o) => rawExport(d, { rect: { x: 0, y: 0, w: 300, h: 200 }, ...o });

const tick = () => new Promise((r) => setTimeout(r, 0));
const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 10 };
const dialog = () => document.querySelector('dialog[open]');
const button = (label) => [...dialog().querySelectorAll('button')].find((b) => b.textContent === label);
const field = (label) => {
  const lab = [...dialog().querySelectorAll('label')].find((l) => l.textContent === label);
  return lab ? dialog().querySelector(`#${CSS.escape(lab.htmlFor)}`) : null;
};
function setField(label, value) {
  const el = field(label);
  expect(el, label).toBeTruthy();
  if (el.type === 'checkbox') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

let app;
let doc;

beforeEach(async () => {
  app = await bootAppWithFeatures();
  if (!app.editor) app.newDocument();
  doc = app.editor.doc;
});

function add(text, extra = {}) {
  const t = createText(text, 10, 40, { ...extra, char: { ...createText('', 0, 0).char, ...CHAR, ...(extra.char || {}) } });
  doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
  app.editor.select([t.id]);
  return t.id;
}

function panelMenu(id) {
  app.openPanel(id);
  const p = app.dock.panels.get(id);
  p.ensureBuilt();
  return resolveItems(app, p.menu());
}

describe('underline and strikethrough options', () => {
  it('computes bars from automatic or set weight, offset, color and dashes', () => {
    const st = { ...CHAR, fontSize: 18, underline: true, strike: true };
    expect(decorationOf(st, 18, 'underline')).toEqual({ offset: 18 * 0.12, thickness: 1, paint: null, dash: null });
    expect(decorationOf(st, 18, 'strike').offset).toBeCloseTo(-18 * 0.3);
    const red = { type: 'solid', color: '#ff0000' };
    const custom = { ...st, underlineStyle: { weight: 2, offset: 3, color: red, dash: [4, 2] }, strikeStyle: { weight: 1, offset: 5 } };
    expect(decorationOf(custom, 18, 'underline')).toEqual({ offset: 3, thickness: 2, paint: red, dash: [4, 2] });
    // A strikethrough offset is the bar's bottom above the baseline.
    expect(decorationOf(custom, 18, 'strike').offset).toBe(-6);
    const rects = decorationRects(custom, 18, 0, 20, 100);
    const under = rects.filter((r) => r.paint === red);
    expect(under.map((r) => [r.x, r.w])).toEqual([[0, 4], [6, 4], [12, 4], [18, 2]]);
    expect(under[0].y).toBe(103);
    expect(rects.filter((r) => !r.paint)).toEqual([{ x: 0, y: 94, w: 20, h: 1, paint: null }]);
  });

  it('Underline Options previews live, applies on OK and takes the preview back on Cancel', async () => {
    const id = add('Hello world');
    const menu = panelMenu('character');
    expect(menu.find((i) => i.label === 'Underline Options...')).toBeTruthy();
    expect(menu.find((i) => i.label === 'Strikethrough Options...')).toBeTruthy();
    let done = app.commands.run('type.underlineOptions');
    await tick();
    expect(dialog().querySelector('h2, .dialog-title')?.textContent || dialog().textContent).toContain('Underline Options');
    setField('Underline', true);
    setField('Automatic Weight and Offset', false);
    setField('Weight', '2 pt');
    setField('Offset (below the baseline)', '3 pt');
    setField('Dashed Line', true);
    // Live preview.
    expect(doc.get(id).char.underline).toBe(true);
    expect(doc.get(id).char.underlineStyle).toMatchObject({ weight: 2, offset: 3, dash: [4, 2] });
    button('Cancel').click();
    await done;
    expect(doc.get(id).char.underline).toBe(false);
    expect(doc.get(id).char.underlineStyle).toBe(null);
    const undoDepth = doc.undoStack.length;
    done = app.commands.run('type.underlineOptions');
    await tick();
    setField('Underline', true);
    setField('Color', 'custom');
    setField('Custom Color', '#00ff00');
    button('OK').click();
    await done;
    const n = doc.get(id);
    expect(n.char.underline).toBe(true);
    expect(n.char.underlineStyle).toMatchObject({ weight: null, offset: null, color: { type: 'solid', color: '#00ff00' }, dash: null });
    expect(doc.undoStack.length).toBe(undoDepth + 1);
  });

  it('exports bars in their own color as rectangles, plain ones as text-decoration', () => {
    const plain = add('Plain', { char: { underline: true } });
    const own = add('Own color bars', { char: { underline: true, underlineStyle: { color: { type: 'solid', color: '#ff0000' }, dash: [2, 1] } } });
    const svg = exportSVG(doc, { ids: [plain, own] });
    expect(svg).toMatch(/text-decoration="underline"/);
    expect(svg).toMatch(/<rect[^>]*fill="(#ff0000|#f00|red)"/);
    expect((svg.match(/<rect /g) || []).length).toBeGreaterThan(1);
  });
});

describe('SVG export of language, tracking and kerning', () => {
  it('writes xml:lang on the text and on pieces in another language, and reads it back', async () => {
    const id = add('Hello Welt', { runs: [{ len: 6 }, { len: 4, language: 'de-DE' }] });
    const svg = exportSVG(doc, { ids: [id] });
    expect(svg).toMatch(/<text[^>]*xml:lang="en-US"/);
    expect(svg).toMatch(/<tspan[^>]*xml:lang="de-DE"[^>]*>Welt</);
    const texts = svgToNodes(svg).nodes.filter((n) => n.type === 'text');
    expect(texts.length).toBe(1);
    const langs = new Set();
    const t = texts[0];
    langs.add(t.char.language);
    for (const r of t.runs || []) if (r.language) langs.add(r.language);
    expect([...langs].sort()).toEqual(['de-DE', 'en-US']);
  });

  it('gives tracked and kerned pieces their laid-out length', () => {
    const id = add('Tracked', { char: { tracking: 200 } });
    const lay = layoutText(doc.get(id));
    const piece = textPieces(doc.get(id)).items[0];
    expect(piece.span).toBeCloseTo(lay.lines[0].xs[7] - lay.lines[0].xs[0]);
    const svg = exportSVG(doc, { ids: [id] });
    expect(svg).toMatch(new RegExp(`textLength="${Math.round(piece.span * 100) / 100}`.replace('.', '\\.')));
    expect(svg).toMatch(/letter-spacing="2"/);
    const plain = add('Plain');
    expect(exportSVG(doc, { ids: [plain] })).not.toMatch(/textLength/);
  });
});

describe('anti-aliasing in raster export', () => {
  function recorder() {
    const calls = [];
    const target = {
      canvas: { width: 50, height: 50 },
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      measureText: (t) => ({ width: String(t).length * 6 }),
    };
    return {
      calls,
      ctx: new Proxy(target, {
        get(t, k) {
          if (k in t) return t[k];
          return (...a) => calls.push([k, ...a]);
        },
        set(t, k, v) {
          t[k] = v;
          return true;
        },
      }),
    };
  }

  it('sets the option on type objects and thickens or hardens their raster letters', () => {
    const id = add('Hello');
    const items = panelMenu('character');
    const aa = items.find((i) => i.label === 'Anti-aliasing');
    expect(aa.items.map((i) => i.label)).toEqual(['None', 'Sharp', 'Crisp', 'Strong']);
    app.commands.run('type.antialias.strong');
    expect(doc.get(id).antialias).toBe('strong');
    expect(app.commands.get('type.antialias.strong').checked(app)).toBe(true);
    const r1 = recorder();
    drawNode(r1.ctx, doc, doc.get(id), { textHints: true, hairline: 1, scale: 1 });
    expect(r1.calls.some(([k]) => k === 'strokeText')).toBe(true);
    // On screen the option does nothing.
    const r2 = recorder();
    drawNode(r2.ctx, doc, doc.get(id), { hairline: 1, scale: 1 });
    expect(r2.calls.some(([k]) => k === 'strokeText')).toBe(false);
    app.commands.run('type.antialias.none');
    const r3 = recorder();
    drawNode(r3.ctx, doc, doc.get(id), { textHints: true, hairline: 1, scale: 1 });
    expect(r3.calls.some(([k]) => k === 'drawImage')).toBe(true);
    app.commands.run('type.antialias.sharp');
    expect(doc.get(id).antialias).toBe(undefined);
  });
});

describe('font height reference', () => {
  it('shows and takes the size as a font height', async () => {
    const id = add('Hello', { char: { fontSize: 20 } });
    const ratio = fontHeightRatio({ ...CHAR, fontSize: 100 }, 'cap');
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(1);
    expect(fontHeightRatio(CHAR, 'em')).toBe(1);
    app.commands.run('type.showFontHeight');
    app.prefs.set('fontSizeReference', 'cap');
    app.openPanel('character');
    const p = app.dock.panels.get('character');
    p.ensureBuilt();
    p.update();
    const sel = p.el.querySelector('select[aria-label="Font height reference"]');
    expect(sel.closest('.ty-row').hidden).toBe(false);
    expect(sel.value).toBe('cap');
    const sizeIn = p.el.querySelector('input[aria-label="Font size"]');
    expect(parseFloat(sizeIn.value)).toBeCloseTo(20 * ratio, 1);
    sizeIn.value = String(10 * ratio);
    sizeIn.dispatchEvent(new Event('change'));
    expect(doc.get(id).char.fontSize).toBeCloseTo(10, 4);
    app.commands.run('type.showFontHeight');
    p.update();
    expect(sel.closest('.ty-row').hidden).toBe(true);
  });
});

describe('vertical type: Roman alignment and tate-chu-yoko', () => {
  const vtext = (text, char = {}, runs) => {
    const n = createText(text, 100, 0, { vertical: true, char: { ...createText('', 0, 0).char, ...CHAR, ...char } });
    return runs ? { ...n, runs } : n;
  };

  it('turns Roman characters sideways with standard vertical Roman alignment', () => {
    const up = layoutText(vtext('Ab'));
    const side = layoutText(vtext('Ab', { verticalRoman: true }));
    // Upright: an em per character. Sideways: the glyph's width.
    expect(up.chars.adv[0]).toBeCloseTo(10);
    expect(side.chars.adv[0]).toBeCloseTo(side.chars.gw[0]);
    const g = glyphPlacements(side)[0];
    expect(g.m[0]).toBeCloseTo(0);
    expect(g.m[1]).toBeGreaterThan(0);
    expect(g.m[2]).toBeLessThan(0);
    // CJK characters stay upright.
    const mixed = glyphPlacements(layoutText(vtext('漢A', { verticalRoman: true })));
    expect(mixed[0].m[0]).toBeCloseTo(1);
    expect(mixed[1].m[0]).toBeCloseTo(0);
  });

  it('sets tate-chu-yoko digits across the column in one em', () => {
    const lay = layoutText(vtext('第12回', {}, [{ len: 1 }, { len: 2, tcy: true }, { len: 1 }]));
    expect(lay.chars.adv[1]).toBeCloseTo(10);
    expect(lay.chars.adv[2]).toBe(0);
    const gs = glyphPlacements(lay);
    const one = gs.find((g) => g.i === 1);
    const two = gs.find((g) => g.i === 2);
    expect(one.m[5]).toBeCloseTo(two.m[5]);
    expect(two.m[4]).toBeGreaterThan(one.m[4]);
    // The group is centered on the column.
    const kanji = gs.find((g) => g.i === 0);
    const gw = lay.chars.gw;
    const center = kanji.m[4] + gw[0] / 2;
    const groupMid = (one.m[4] + two.m[4] + gw[2] * two.m[0]) / 2;
    expect(groupMid).toBeCloseTo(center, 0);
    // The last character follows one em after the group.
    expect(gs.find((g) => g.i === 3).m[5] - one.m[5]).toBeCloseTo(10);
  });

  it('commands toggle the character attributes', () => {
    const id = add('12', { vertical: true });
    app.commands.run('type.tcy');
    expect(doc.get(id).char.tcy).toBe(true);
    app.commands.run('type.verticalRoman');
    expect(doc.get(id).char.verticalRoman).toBe(true);
    const labels = panelMenu('character').map((i) => i.label);
    expect(labels).toContain('Tate-chu-yoko');
    expect(labels).toContain('Standard Vertical Roman Alignment');
  });
});

describe('tsume and aki', () => {
  it('tightens the space beside glyphs and adds space before and after', () => {
    const base = layoutText(createText('国国', 0, 0, { char: { ...createText('', 0, 0).char, ...CHAR } }));
    const tight = layoutText(createText('国国', 0, 0, { char: { ...createText('', 0, 0).char, ...CHAR, tsume: 100 } }));
    expect(tight.chars.adv[0]).toBeLessThan(base.chars.adv[0]);
    const aki = layoutText(createText('国国', 0, 0, { char: { ...createText('', 0, 0).char, ...CHAR, akiBefore: 0.25, akiAfter: 0.5 } }));
    expect(aki.chars.kern[0]).toBeCloseTo(2.5);
    expect(aki.chars.adv[0]).toBeCloseTo(base.chars.adv[0] + 5);
  });

  it('the panel shows East Asian options on request', () => {
    const id = add('国国');
    app.openPanel('character');
    const p = app.dock.panels.get('character');
    p.ensureBuilt();
    p.update();
    const tsume = p.el.querySelector('input[aria-label^="Tsume"]');
    expect(tsume.closest('.ty-row').hidden).toBe(true);
    app.commands.run('type.showEastAsian');
    p.update();
    expect(tsume.closest('.ty-row').hidden).toBe(false);
    tsume.value = '50';
    tsume.dispatchEvent(new Event('change'));
    expect(doc.get(id).char.tsume).toBe(50);
    const aki = p.el.querySelector('select[aria-label^="Aki (space after"]');
    aki.value = '0.25';
    aki.dispatchEvent(new Event('change'));
    expect(doc.get(id).char.akiAfter).toBe(0.25);
  });
});
