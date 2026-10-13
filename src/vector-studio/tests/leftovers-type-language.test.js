import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText, DEFAULT_PARA, NEW_PARA } from '../src/model/nodes.js';
import { layoutText } from '../src/model/text-layout.js';
import { hyphenPoints, hyphenationRules } from '../src/model/hyphenate.js';
import { LANGUAGES, languageBase, canSpellCheck } from '../src/model/languages.js';
import { VDocument } from '../src/model/document.js';
import { nodeIssues } from '../src/features/type/spelling.js';
import { styleLists, expectedPara } from '../src/features/type/text-styles.js';

const area = (text, width, para = {}, char = {}) => {
  const n = createText(text, 0, 0, { kind: 'area', width, height: 400 });
  return { ...n, para: { ...n.para, ...para }, char: { ...n.char, ...char } };
};
const lineTexts = (lay) => lay.lines.map((l) => l.text.trimEnd());

describe('text language', () => {
  it('is a character attribute, English by default', () => {
    expect(createText('a', 0, 0).char.language).toBe('en-US');
    expect(LANGUAGES.some((l) => l.code === 'de-DE')).toBe(true);
    expect(languageBase('en-GB')).toBe('en');
    expect(languageBase(undefined)).toBe('en');
    expect(canSpellCheck('en-AU')).toBe(true);
    expect(canSpellCheck('fr-FR')).toBe(false);
    expect(canSpellCheck('none')).toBe(false);
  });

  it('hyphenates languages that have rules; others are left whole', () => {
    expect(hyphenPoints('hyphenation').length).toBeGreaterThan(0);
    expect(hyphenPoints('hyphenation', undefined, 'en-GB').length).toBeGreaterThan(0);
    expect(hyphenPoints('hyphenation', undefined, 'fi-FI')).toEqual([]);
    expect(hyphenPoints('hyphenation', undefined, 'none')).toEqual([]);
    expect(hyphenationRules('ru-RU')).toBeNull();
    for (const composer of ['single', 'every']) {
      const en = layoutText(area('xx hyphenation', 72, { hyphenate: true, composer }));
      expect(en.lines[0].hyphen, composer).toBe(true);
      expect(lineTexts(en)[0], composer).toMatch(/^xx hyph/);
      const fi = layoutText(area('xx hyphenation', 72, { hyphenate: true, composer }, { language: 'fi-FI' }));
      expect(lineTexts(fi), composer).toEqual(['xx', 'hyphenation']);
    }
  });

  it('spell checking skips words in languages without a dictionary', () => {
    const issues = [{ start: 0, end: 4, word: 'Haus', kind: 'spelling' }, { start: 5, end: 9, word: 'teh', kind: 'spelling' }];
    const en = createText('Haus teh', 0, 0);
    expect(nodeIssues(en, issues)).toHaveLength(2);
    const de = { ...en, char: { ...en.char, language: 'de-DE' } };
    expect(nodeIssues(de, issues)).toHaveLength(0);
    // A run in German, the rest English.
    const mixed = { ...en, runs: [{ len: 5, language: 'de-DE' }, { len: 3 }] };
    expect(nodeIssues(mixed, issues).map((i) => i.word)).toEqual(['teh']);
  });
});

describe('Every-line Composer default', () => {
  it('new text composes every line; stored text without a composer stays single-line', () => {
    expect(createText('a', 0, 0).para.composer).toBe('every');
    expect(NEW_PARA.composer).toBe('every');
    expect(DEFAULT_PARA.composer).toBe('single');
    const old = createText('aaa bbbbbbbbbb cc dd', 0, 0, { kind: 'area', width: 70, height: 200 });
    delete old.para.composer;
    const single = layoutText({ ...old, para: { ...old.para, composer: 'single' } });
    expect(lineTexts(layoutText(old))).toEqual(lineTexts(single));
  });

  it('new documents store it on the Normal Paragraph Style; older documents keep the single-line one', () => {
    const doc = VDocument.create();
    expect(expectedPara(styleLists(doc), 'normal').composer).toBe('every');
    const legacy = VDocument.fromJSON({ ...doc.toJSON(), nodes: { ...doc.toJSON().nodes, root: { ...doc.root, paraStyles: undefined } } });
    expect(expectedPara(styleLists(legacy), 'normal').composer).toBe('single');
  });

  it('re-composes for slots of another width (text wrap)', async () => {
    const { textHooks } = await import('../src/model/text-layout.js');
    const n = area('word '.repeat(80), 200);
    const square = [{ x: 60, y: 0 }, { x: 140, y: 0 }, { x: 140, y: 60 }, { x: 60, y: 60 }];
    const prev = textHooks.wraps;
    textHooks.wraps = (node) => (node.id === n.id ? { deps: [square], list: [{ polys: [square], offset: 5, invert: false }] } : null);
    try {
      const lay = layoutText(n);
      const below = lay.lines.find((l) => l.y - l.asc > 70);
      expect(below.width).toBeGreaterThan(150);
    } finally {
      textHooks.wraps = prev;
    }
  });
});

describe('Character panel and character styles', () => {
  let app;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
  });

  it('the Character panel sets the language of the selected text', () => {
    const doc = app.editor.doc;
    const t = createText('Hallo', 100, 100);
    doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
    app.editor.select([t.id]);
    app.openPanel('character');
    const panel = app.dock.panels.get('character');
    panel.update();
    const sel = panel.el.querySelector('select[aria-label="Language"]');
    expect(sel.value).toBe('en-US');
    sel.value = 'de-DE';
    sel.dispatchEvent(new Event('change'));
    expect(doc.get(t.id).char.language).toBe('de-DE');
  });

  it('character styles can set the language', async () => {
    const { CHAR_STYLE_KEYS } = await import('../src/features/type/text-styles.js');
    expect(CHAR_STYLE_KEYS).toContain('language');
  });
});
