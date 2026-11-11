import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import opentype from 'opentype.js';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';
import { registerMeasureFont, layoutText } from '../src/model/text-layout.js';
import { styleAt } from '../src/model/text-runs.js';
import { registerOutlineFont } from '../src/features/type/fonts.js';
import { loadShapingFont, fontAlternates } from '../src/features/type/shaping.js';
import { applyCharStyle } from '../src/features/type/type-ops.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { glyphSvg } from '../src/features/type/glyphs-panel.js';

let inter;
let montserrat;

function load(pkg, family) {
  const buf = readFileSync(resolve(process.cwd(), `node_modules/@fontsource/${pkg}/files/${pkg}-latin-400-normal.woff`));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  registerMeasureFont(family, 400, 'normal', font);
  registerOutlineFont(family, 400, 'normal', font);
  return font;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  inter = load('inter', 'Inter');
  montserrat = load('montserrat', 'Montserrat');
});

let app;
function add(node) {
  const doc = app.editor.doc;
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return doc.get(node.id);
}

function editing(text, char = {}) {
  const t = add(createText(text, 100, 100, { char: { fontFamily: 'Inter', fontWeight: 400, fontStyle: 'normal', fontSize: 24, ...char } }));
  app.setTool('type');
  const s = app.tool.editText(t.id, null);
  return { t, s };
}

beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  await loadShapingFont({ fontFamily: 'Inter', fontWeight: 400, fontStyle: 'normal' });
  await loadShapingFont({ fontFamily: 'Montserrat', fontWeight: 400, fontStyle: 'normal' });
});

describe('OpenType panel', () => {
  function panel() {
    const p = app.dock.panels.get('openType');
    p.ensureBuilt();
    p.update();
    return p;
  }

  it('is registered with its command and shortcut', () => {
    expect(app.commands.get('panel.openType')).toBeTruthy();
    expect(app.commands.get('panel.openType').shortcut).toBe('Alt+Shift+Mod+T');
    expect(app.commands.get('panel.glyphs')).toBeTruthy();
  });

  it('toggles features on the selected characters and reflects them', () => {
    const { t, s } = editing('1/2 cup');
    s.setSelection(0, 3);
    const p = panel();
    const frac = p.el.querySelector('[data-key="fractions"]');
    expect(frac.getAttribute('aria-pressed')).toBe('false');
    frac.click();
    const n = app.editor.doc.get(t.id);
    expect(styleAt(n, 0).fractions).toBe(true);
    expect(styleAt(n, 4).fractions).toBe(false);
    p.update();
    expect(frac.getAttribute('aria-pressed')).toBe('true');
    // The layout now shapes the fraction.
    expect(layoutText(n).chars.glyph[0]).not.toBe(inter.charToGlyphIndex('1'));
    // Standard ligatures are on by default; the toggle turns them off.
    const liga = p.el.querySelector('[data-key="ligatures"]');
    expect(liga.getAttribute('aria-pressed')).toBe('true');
    liga.click();
    expect(styleAt(app.editor.doc.get(t.id), 0).ligatures).toBe(false);
  });

  it('sets the figure style and marks features the font lacks', async () => {
    const { t, s } = editing('2024');
    s.selectAll();
    const p = panel();
    const sel = p.el.querySelector('select');
    sel.value = 'tabular-lining';
    sel.dispatchEvent(new Event('change'));
    expect(styleAt(app.editor.doc.get(t.id), 0).figures).toBe('tabular-lining');
    p.update();
    // Inter's latin subset has no swashes or oldstyle figures.
    expect(p.el.querySelector('[data-key="swash"]').classList.contains('unavailable')).toBe(true);
    expect(p.el.querySelector('[data-key="fractions"]').classList.contains('unavailable')).toBe(false);
    expect([...sel.options].find((o) => o.value === 'proportional-oldstyle').disabled).toBe(true);
    applyCharStyle(app, { swash: true });
    p.update();
    expect(p.el.querySelector('.ot-note').textContent).toMatch(/no Swash/);
  });

  it('reports mixed values', () => {
    const { s } = editing('ab');
    s.setSelection(0, 1);
    applyCharStyle(app, { discretionary: true });
    s.setSelection(0, 2);
    const p = panel();
    expect(p.el.querySelector('[data-key="discretionary"]').getAttribute('aria-pressed')).toBe('mixed');
  });
});

describe('Glyphs panel', () => {
  async function panel() {
    const p = app.dock.panels.get('glyphs');
    p.ensureBuilt();
    p.visible = true;
    p.update();
    for (let k = 0; k < 5 && !p.font; k++) await tick();
    return p;
  }

  it('shows the glyphs of the current text font with categories and blocks', async () => {
    editing('Hello');
    const p = await panel();
    expect(p.family).toBe('Inter');
    expect(p.font).toBe(inter);
    const cells = p.grid.querySelectorAll('.gl-cell');
    expect(cells.length).toBe(inter.numGlyphs - 1);
    p.setFilter('numbers');
    const nums = [...p.grid.querySelectorAll('.gl-cell')].map((c) => Number(c.dataset.glyph));
    expect(nums).toContain(inter.charToGlyphIndex('7'));
    expect(nums).not.toContain(inter.charToGlyphIndex('A'));
    const blocks = [...p.show.querySelectorAll('optgroup option')].map((o) => o.textContent);
    expect(blocks).toContain('Basic Latin');
    // Glyphs with alternates are marked; cells draw from the font's outlines.
    const one = p.grid.querySelector(`[data-glyph="${inter.charToGlyphIndex('1')}"]`);
    expect(one.classList.contains('has-alts')).toBe(true);
    p.paint(one);
    expect(one.querySelector('path').getAttribute('d').length).toBeGreaterThan(10);
  });

  it('draws every glyph with valid path data at every zoom', () => {
    // Composite glyphs such as Ǟ have coordinates a hair off whole numbers, which opentype.js's toPathData turned into NaN.
    const bad = [];
    for (const size of [24, 32, 40, 52, 68]) {
      for (let i = 0; i < inter.numGlyphs; i++) if (glyphSvg(inter, i, size).includes('NaN')) bad.push(`${i}@${size}`);
    }
    expect(bad).toEqual([]);
    expect(glyphSvg(inter, inter.charToGlyphIndex('Ǟ'), 40)).toMatch(/^<svg[^>]*><path d="M[\d.]+ [\d.]+L[-\dLMQCZ. ]+" fill/);
  });

  it('inserts a glyph at the insertion point and remembers it', async () => {
    const { t, s } = editing('ab');
    s.setSelection(1, 1);
    const p = await panel();
    p.insert(inter.charToGlyphIndex('Z'));
    expect(app.editor.doc.get(t.id).text).toBe('aZb');
    expect(s.caret).toBe(2);
    expect(app.prefs.get('glyphsRecent')[0]).toMatchObject({ family: 'Inter', glyph: inter.charToGlyphIndex('Z') });
    expect(p.recentRow.children.length).toBe(1);
    // Undo removes it in one step.
    app.editor.doc.undo();
    expect(app.editor.doc.get(t.id).text).toBe('ab');
  });

  it('inserts an unencoded alternate as its character with the glyph chosen', async () => {
    const { t, s } = editing('x');
    s.setSelection(1, 1);
    const p = await panel();
    const one = inter.charToGlyphIndex('1');
    const alt = fontAlternates(inter).alts.get(one).find((a) => inter.glyphs.get(a.glyph).unicode == null).glyph;
    p.select(one, { focus: false });
    expect(p.altRow.hidden).toBe(false);
    expect(p.altRow.querySelectorAll('.gl-cell').length).toBeGreaterThan(0);
    p.insert(alt);
    const n = app.editor.doc.get(t.id);
    expect(n.text).toBe('x1');
    expect(styleAt(n, 1).altGlyph).toBe(alt);
    expect(layoutText(n).chars.glyph[1]).toBe(alt);
    // Typing after it does not repeat the alternate.
    s.insert('2');
    expect(styleAt(app.editor.doc.get(t.id), 2).altGlyph).toBe(null);
  });

  it('lists alternates of the selected characters', async () => {
    const { s } = editing('a1');
    s.setSelection(1, 2);
    const p = await panel();
    p.setFilter('alternates');
    const gl = [...p.grid.querySelectorAll('.gl-cell')].map((c) => Number(c.dataset.glyph));
    expect(gl[0]).toBe(inter.charToGlyphIndex('1'));
    expect(gl.length).toBeGreaterThan(1);
  });

  it('follows the text font and moves with the keyboard', async () => {
    editing('Hi', { fontFamily: 'Montserrat' });
    const p = await panel();
    expect(p.family).toBe('Montserrat');
    const first = Number(p.grid.querySelector('.gl-cell').dataset.glyph);
    p.select(first, { focus: false });
    p.grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(p.focus).toBe(Number(p.grid.querySelectorAll('.gl-cell')[1].dataset.glyph));
    expect(p.status.textContent).toMatch(/U\+|unencoded|alternate/);
  });

  it('asks for an insertion point when not editing', async () => {
    const p = await panel();
    const msgs = [];
    app.notify = (m) => msgs.push(m);
    p.insert(5);
    expect(msgs[0]).toMatch(/insert/);
  });
});

describe('SVG export of OpenType features', () => {
  it('writes font-feature-settings for styled text', () => {
    add(createText('1/2', 10, 50, { char: { fontFamily: 'Montserrat', fontWeight: 400, fontStyle: 'normal', fontSize: 24, fractions: true, stylisticSets: [2] } }));
    add(createText('plain', 10, 90, { char: { fontFamily: 'Montserrat', fontWeight: 400, fontStyle: 'normal', fontSize: 24 } }));
    const svg = exportSVG(app.editor.doc, { rect: { x: 0, y: 0, w: 200, h: 200 } });
    expect(svg).toMatch(/<style>\.vs-ff1\{font-feature-settings:&quot;ss02&quot; 1, &quot;frac&quot; 1\}<\/style>/);
    expect(svg).toMatch(/class="vs-ff1"/);
    expect(svg.match(/class="/g).length).toBe((svg.match(/class="vs-ff1"/g) || []).length);
  });
});
