import { describe, it, expect, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { fakeAI, flush } from './generative-helpers.js';
import { createPath, createImage, createCompound, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { MENUS } from '../src/ui/menus.js';
import { normalizeAnswer, rankFonts, traitsOf, normalizeName, similarity } from '../src/features/mockup/font-match.js';
import { matchFontHooks, matchSources, matchTextTargets, matchPrompt, clipRect } from '../src/features/mockup/match-font.js';
import { bundledFamilies } from '../src/features/type/fonts.js';

afterEach(() => {
  matchFontHooks.capture = null;
});

const families = () => bundledFamilies().map((f) => ({ ...f }));

describe('Font ranking', () => {
  it('normalizes names and knows classifications', () => {
    expect(normalizeName('Helvetica Neue LT Std 75')).toBe('helvetica neue');
    expect(normalizeName('Montserrat Bold')).toBe('montserrat');
    expect(normalizeName('Myriad Pro')).toBe('myriad pro');
    expect(traitsOf('Futura PT').category).toBe('sans-serif');
    expect(traitsOf('Futura PT').traits).toContain('geometric');
    expect(traitsOf('Bodoni 72').traits).toContain('didone');
    expect(traitsOf('Unknown Face')).toBeNull();
    expect(similarity({ category: 'serif', traits: ['didone'] }, { category: 'serif', traits: ['didone', 'high-contrast'] })).toBeGreaterThan(0.7);
    expect(similarity({ category: 'serif', traits: [] }, { category: 'monospace', traits: [] })).toBe(0);
  });

  it('puts an identified family that the app has first', () => {
    const ranked = rankFonts({ text: 'Hello', fonts: [{ name: 'Lobster', confidence: 0.9 }], category: 'display', weight: 400 }, families());
    expect(ranked[0].family).toBe('Lobster');
    expect(ranked[0].reason).toBe('Identified typeface');
  });

  it('maps typefaces the app lacks to similar ones', () => {
    const geo = rankFonts({ fonts: [{ name: 'Futura', confidence: 0.8 }], category: 'sans-serif', traits: ['geometric'] }, families());
    expect(['Poppins', 'Montserrat']).toContain(geo[0].family);
    expect(geo[0].reason).toBe('Similar to Futura');
    const didone = rankFonts({ fonts: [{ name: 'Didot', confidence: 0.7 }], category: 'serif' }, families());
    expect(didone[0].family).toBe('Playfair Display');
    const condensed = rankFonts({ fonts: ['Impact'], category: 'display', traits: ['condensed'], weight: 700 }, families());
    expect(['Bebas Neue', 'Oswald']).toContain(condensed[0].family);
    // Monospaced samples never suggest scripts first.
    const mono = rankFonts({ fonts: [{ name: 'Courier New', confidence: 0.6 }], category: 'monospace' }, families());
    expect(['Roboto Mono', 'Source Code Pro']).toContain(mono[0].family);
  });

  it('honours the closest picks from the app list and chooses faces by weight and slant', () => {
    const ranked = rankFonts({ fonts: [{ name: 'Some Rare Face', confidence: 0.4 }], closest: ['Lora'], category: 'serif', weight: 700, italic: true }, families());
    expect(ranked[0].family).toBe('Lora');
    expect(ranked[0].reason).toBe('Closest match among your fonts');
    expect(ranked[0]).toMatchObject({ weight: 700, style: 'italic' });
  });

  it('cleans up the model answer', () => {
    const a = normalizeAnswer({ text: ' Hi\r\nthere ', fonts: ['Arial', { name: 'Inter', confidence: 80 }, { name: '' }], weight: 650, italic: 1, color: '#AABBCC', background: 'white', category: 'Sans' });
    expect(a.text).toBe('Hi\nthere');
    expect(a.fonts.map((f) => f.name)).toEqual(['Arial', 'Inter']);
    expect(a.fonts[1].confidence).toBeCloseTo(0.8);
    expect(a.weight).toBe(700);
    expect(a.italic).toBe(true);
    expect(a.color).toBe('#aabbcc');
    expect(a.background).toBeNull();
    expect(a.category).toBe('sans-serif');
  });

  it('asks for the available fonts by name', () => {
    const p = matchPrompt(['Inter', 'Lora']);
    expect(p).toContain('Inter, Lora');
    expect(p).toContain('"closest"');
  });
});

async function setup({ chat = null, outlined = false } = {}) {
  const app = await bootAppWithFeatures();
  const answer = { text: 'SALE', fonts: [{ name: 'Bebas Neue', confidence: 0.85 }, { name: 'Impact', confidence: 0.4 }], closest: ['Bebas Neue', 'Oswald'], category: 'display', traits: ['condensed', 'caps'], weight: 400, italic: false, color: '#202020', background: '#f0e0c0' };
  app.generativeAI = fakeAI({ chat: chat || (() => JSON.stringify(answer)) });
  app.newDocument();
  const ed = app.editor;
  const doc = ed.doc;
  let source;
  doc.transact('Setup', () => {
    if (outlined) {
      const c = createCompound([], { fill: { type: 'solid', color: '#123456' }, stroke: null });
      const kids = [createPath(rectangle(100, 100, 20, 40), true, {}, { parent: c.id }), createPath(rectangle(130, 100, 20, 40), true, {}, { parent: c.id })];
      c.children = kids.map((k) => k.id);
      doc.insert(c, ed.targetLayer().id, Infinity, kids);
      source = c;
    } else {
      doc.assets.set('sign', { mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' });
      source = createImage('sign', 200, 100, [1, 0, 0, 1, 100, 100]);
      doc.insert(source, ed.targetLayer().id);
    }
  });
  ed.select([source.id]);
  const captures = [];
  matchFontHooks.capture = (d, nodes, rect) => {
    captures.push({ nodes: nodes.map((n) => n.id), rect });
    return 'data:image/png;base64,QUJD';
  };
  return { app, ed, doc, source: source.id, captures };
}

const panelOf = (app) => app.dock.panels.get('matchFont');

describe('Match Font', () => {
  it('sits in the Type menu before Rewrite and has a panel', async () => {
    const { app } = await setup();
    const type = MENUS.find((m) => m.label === 'Type').submenu;
    expect(type.indexOf('type.matchFont')).toBe(type.indexOf('generative.text.rewrite') - 1);
    expect(app.commands.get('type.matchFont').label).toBe('Match Font...');
    expect(panelOf(app)).toBeTruthy();
  });

  it('knows what can be matched and what can be restyled', async () => {
    const { ed, doc, source } = await setup();
    expect(matchSources(ed).map((n) => n.id)).toEqual([source]);
    const t = createText('hello', 10, 10);
    doc.transact('t', () => doc.insert(t, ed.targetLayer().id));
    ed.select([source, t.id]);
    expect(matchSources(ed).map((n) => n.id)).toEqual([source]);
    expect(matchTextTargets(ed).map((n) => n.id)).toEqual([t.id]);
    expect(clipRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({ x: 5, y: 5, w: 5, h: 5 });
    expect(clipRect({ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 })).toBeNull();
  });

  it('sends the selection picture to Puter AI and lists matches with previews', async () => {
    const { app, captures } = await setup();
    await app.commands.run('type.matchFont');
    const panel = panelOf(app);
    expect(captures).toHaveLength(1);
    expect(captures[0].rect).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    const call = app.generativeAI.calls.chat[0];
    expect(call.image).toBe('data:image/png;base64,QUJD');
    expect(call.prompt).toContain('typeface');
    expect(panel.result.suggestions[0].family).toBe('Bebas Neue');
    panel.update();
    const opts = [...panel.el.querySelectorAll('[role="option"]')];
    expect(opts.length).toBeGreaterThan(1);
    expect(opts[0].getAttribute('aria-selected')).toBe('true');
    expect(opts[0].querySelector('.mf-sample').style.fontFamily).toContain('Bebas Neue');
    expect(opts[0].querySelector('.mf-sample').textContent).toBe('SALE');
    expect(panel.el.querySelector('.mf-text').value).toBe('SALE');
    // Arrow keys move through the suggestions.
    panel.list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(panel.chosen).toBe(1);
  });

  it('matches only the drawn region', async () => {
    const { app, captures } = await setup();
    app.openPanel('matchFont');
    await flush();
    const panel = panelOf(app);
    panel.setRegion({ x: 150, y: 120, w: 60, h: 30 });
    await panel.match();
    expect(captures[0].rect).toEqual({ x: 150, y: 120, w: 60, h: 30 });
    panel.setRegion(null);
    expect(panel.region).toBeNull();
  });

  it('replaces image lettering with editable type over a cover, in one undo step', async () => {
    const { app, ed, doc, source } = await setup();
    await app.commands.run('type.matchFont');
    const panel = panelOf(app);
    const layer = ed.targetLayer().id;
    const before = doc.undoStack.length;
    const id = panel.replace();
    expect(doc.undoStack.length).toBe(before + 1);
    const t = doc.get(id);
    expect(t.type).toBe('text');
    expect(t.text).toBe('SALE');
    expect(t.char.fontFamily).toBe('Bebas Neue');
    expect(t.fill.color).toBe('#202020');
    const kids = doc.get(layer).children;
    expect(kids[0]).toBe(source);
    const cover = doc.get(kids[1]);
    expect(cover.name).toBe('Cover');
    expect(cover.fill.color).toBe('#f0e0c0');
    expect(kids[2]).toBe(id);
    expect(ed.topSelection()).toEqual([id]);
    doc.undo();
    expect(doc.get(layer).children).toEqual([source]);
  });

  it('replaces outlined type with editable type in its color', async () => {
    const { app, ed, doc, source } = await setup({ outlined: true });
    await app.commands.run('type.matchFont');
    const panel = panelOf(app);
    expect(panel.coverRow.hidden).toBe(true);
    panel.textInput.value = 'IT';
    panel.choose(1);
    const font = panel.font();
    const id = panel.replace();
    expect(doc.has(source)).toBe(false);
    const t = doc.get(id);
    expect(t.text).toBe('IT');
    expect(t.char.fontFamily).toBe(font.family);
    expect(t.fill.color).toBe('#202020');
    expect(doc.get(ed.targetLayer().id).children).toEqual([id]);
  });

  it('applies the chosen font to selected type', async () => {
    const { app, ed, doc, source } = await setup();
    const t = createText('hello', 10, 10);
    doc.transact('t', () => doc.insert(t, ed.targetLayer().id));
    await app.commands.run('type.matchFont');
    const panel = panelOf(app);
    ed.select([source, t.id]);
    panel.update();
    expect(panel.applyBtn.disabled).toBe(false);
    panel.apply();
    expect(doc.get(t.id).char.fontFamily).toBe('Bebas Neue');
  });

  it('explains when nothing readable came back, and when AI is unavailable', async () => {
    const { app } = await setup({ chat: () => '{"text": "", "fonts": []}' });
    await app.commands.run('type.matchFont');
    const panel = panelOf(app);
    expect(panel.result).toBeNull();
    expect(panel.status.textContent).toMatch(/No readable lettering/);
    app.generativeAI = null;
    app.puter = null;
    await panel.match();
    expect(panel.status.textContent).toMatch(/Puter AI/);
  });
});
