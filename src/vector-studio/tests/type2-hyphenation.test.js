// Pattern hyphenation for many languages, exception words per language,
// Preferences > Hyphenation and the hyphenation zone of the every-line
// composer.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';
import { layoutText, measure } from '../src/model/text-layout.js';
import { compilePatterns, parseException } from '../src/model/liang.js';
import { hyphenateWord, hyphenPoints, loadHyphenation, hyphenationLoaded, setHyphenationExceptions, englishRules, canHyphenate } from '../src/model/hyphenate.js';
import { PATTERN_FILES, PATTERN_LICENSES, patternKey } from '../src/model/hyphenation/patterns.js';
import { sections } from '../src/features/files/preferences.js';
import { cleanEntry, withException, withoutException, exceptionsEditor } from '../src/features/type/hyphenation.js';
import { typeDefaults } from '../src/features/type/type-ops.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 10 };
const area = (t, width, para = {}, char = {}) => createText(t, 0, 0, { kind: 'area', width, height: 500, char: { ...createText('', 0, 0).char, ...CHAR, ...char }, para: { ...createText('', 0, 0).para, ...para } });
const lineTexts = (lay) => lay.lines.map((l) => l.text.trimEnd());
const loose = { minWord: 4, minBefore: 2, minAfter: 2 };

afterEach(() => setHyphenationExceptions({}));

describe('Liang patterns', () => {
  it('compiles TeX pattern sources and keeps the highest digit at each gap', () => {
    const h = compilePatterns('% a comment\n\\patterns{ 1ba .ab3 a2b }\n\\hyphenation{ ta-ble-top }');
    // ".abab." : .ab3 gives a3 after "ab"; 1ba before every "ba"; a2b even blocks between a and b.
    expect(h('abab')).toEqual([2]);
    expect(h('tabletop')).toEqual([2, 5]);
    expect(parseException('as-so-ciate')).toEqual({ word: 'associate', points: [2, 4] });
    expect(parseException('Puter')).toEqual({ word: 'puter', points: [] });
  });

  it('hyphenates the required languages from their pattern files', async () => {
    const cases = {
      'en-US': ['hyphenation', 'hy-phen-ation'],
      'en-GB': ['hyphenation', 'hy-phen-a-tion'],
      'de-DE': ['Silbentrennung', 'Sil-ben-tren-nung'],
      'fr-FR': ['typographie', 'ty-po-gra-phie'],
      'es-ES': ['ordenador', 'or-de-na-dor'],
      'it-IT': ['sillabazione', 'sil-la-ba-zio-ne'],
      'pt-BR': ['tipografia', 'ti-po-gra-fia'],
      'nl-NL': ['woordafbreking', 'woord-af-bre-king'],
      'sv-SE': ['avstavning', 'av-stav-ning'],
      'da-DK': ['orddeling', 'ord-de-ling'],
      'pl-PL': ['dzielenie', 'dzie-le-nie'],
      'nb-NO': ['orddeling', 'ord-de-ling'],
    };
    for (const [lang, [word, want]] of Object.entries(cases)) {
      expect(await loadHyphenation(lang), lang).toBe(true);
      expect(hyphenationLoaded(lang)).toBe(true);
      expect(hyphenateWord(word, loose, lang), lang).toBe(want);
    }
    // The language's own exception words come with its patterns.
    expect(hyphenateWord('associate', loose, 'en-US')).toBe('as-so-ciate');
    // English without patterns falls back to syllable rules.
    expect(englishRules('computer')).toEqual([3, 5]);
    expect(await loadHyphenation('fi-FI')).toBe(false);
    expect(canHyphenate('fi-FI')).toBe(false);
    expect(canHyphenate('none')).toBe(false);
  });

  it('maps language tags to pattern files', () => {
    expect(patternKey('en-US')).toBe('en-us');
    expect(patternKey('en-CA')).toBe('en-us');
    expect(patternKey('en-AU')).toBe('en-gb');
    expect(patternKey('de-CH')).toBe('de');
    expect(patternKey('pt-PT')).toBe('pt');
    expect(patternKey('nn-NO')).toBe('no');
    expect(patternKey('ja-JP')).toBe(null);
  });

  it('records a permissive license, its notice and the reviewed hash for every bundled file', () => {
    const dir = path.resolve(import.meta.dirname, '../src/model/hyphenation');
    for (const p of Object.values(PATTERN_FILES)) {
      expect(PATTERN_LICENSES).toContain(p.license);
      const data = fs.readFileSync(path.join(dir, p.file));
      expect(data.toString('utf8')).toContain(p.notice);
      expect(createHash('sha256').update(data).digest('hex'), p.file).toBe(p.sha256);
    }
  });
});

describe('hyphenation exceptions', () => {
  it('replace the rules of a word in one language', async () => {
    await loadHyphenation('en-US');
    expect(hyphenateWord('hyphenation', loose, 'en-US')).toBe('hy-phen-ation');
    setHyphenationExceptions({ 'en-US': ['hyphen-ation', 'Puter'] });
    expect(hyphenateWord('hyphenation', loose, 'en-US')).toBe('hyphen-ation');
    expect(hyphenateWord('Hyphenation', loose, 'en-US')).toBe('Hyphen-ation');
    expect(hyphenPoints('puter', { minWord: 2, minBefore: 1, minAfter: 1 }, 'en-US')).toEqual([]);
    // Other languages keep their rules.
    expect(hyphenateWord('hyphenation', loose, 'en-GB')).not.toBe('hyphen-ation');
    setHyphenationExceptions({});
    expect(hyphenateWord('hyphenation', loose, 'en-US')).toBe('hy-phen-ation');
  });

  it('cleans entries and edits lists purely', () => {
    expect(cleanEntry(' ty~po~graph ')).toBe('ty-po-graph');
    expect(cleanEntry('two words')).toBe('');
    expect(cleanEntry('-ab--cd-')).toBe('ab-cd');
    let all = withException({}, 'de-DE', 'Sil-ben');
    all = withException(all, 'de-DE', 'Silben');
    expect(all['de-DE']).toEqual(['Silben']);
    expect(withoutException(all, 'de-DE', 'Silben')).toEqual({});
  });

  it('the editor previews breaks and adds and deletes words', async () => {
    await loadHyphenation('en-US');
    const ed = exceptionsEditor({ 'en-US': ['Pu-ter'] }, 'en-US');
    document.body.append(ed.el);
    const entry = ed.el.querySelector('input');
    entry.value = 'hyphenation';
    entry.dispatchEvent(new Event('input'));
    expect(ed.el.querySelector('.hx-preview').textContent).toContain('hy-phen-ation');
    entry.value = 'hyphen-ation';
    entry.dispatchEvent(new Event('input'));
    [...ed.el.querySelectorAll('button')].find((b) => b.textContent === 'Add').click();
    expect(ed.value()['en-US']).toEqual(['hyphen-ation', 'Pu-ter']);
    ed.el.querySelector('[data-word="Pu-ter"]').click();
    [...ed.el.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
    expect(ed.value()['en-US']).toEqual(['hyphen-ation']);
    ed.el.remove();
  });
});

describe('hyphenation zone in the every-line composer', () => {
  it('keeps ragged lines whole when they end inside the zone', async () => {
    await loadHyphenation('en-US');
    const t = 'xx hyphenation';
    const wide = layoutText(area(t, 60, { hyphenate: true, composer: 'every', hyphenation: { zone: 50 } }));
    expect(lineTexts(wide)).toEqual(['xx', 'hyphenation']);
    const none = layoutText(area(t, 60, { hyphenate: true, composer: 'every', hyphenation: { zone: 0 } }));
    expect(none.lines[0].hyphen).toBe(true);
    // Justified text ignores the zone.
    const just = layoutText(area(t, 60, { hyphenate: true, composer: 'every', align: 'justify', hyphenation: { zone: 50 } }));
    expect(just.lines[0].hyphen).toBe(true);
  });
});

describe('Preferences > Hyphenation', () => {
  it('sets the language of new type and stores exceptions that take effect', async () => {
    const app = await bootAppWithFeatures();
    expect(sections(app).map((s) => s.id)).toContain('hyphenation');
    expect(app.commands.get('edit.preferences.hyphenation')).toBeTruthy();
    const done = app.commands.run('edit.preferences.hyphenation');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    expect(dlg.querySelector('.prefs-tab[aria-selected="true"]').textContent).toBe('Hyphenation');
    const lang = [...dlg.querySelectorAll('.form-row')].find((r) => r.textContent.startsWith('Default Language')).querySelector('select');
    lang.value = 'de-DE';
    const panel = dlg.querySelector('#prefs-p-hyphenation');
    const exSel = panel.querySelector('.hx-editor select');
    exSel.value = 'de-DE';
    exSel.dispatchEvent(new Event('change'));
    const entry = panel.querySelector('.hx-editor input');
    entry.value = 'Vektor-studio';
    entry.dispatchEvent(new Event('input'));
    [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Add').click();
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(app.prefs.get('defaultLanguage')).toBe('de-DE');
    expect(typeDefaults(app).char.language).toBe('de-DE');
    expect(app.prefs.get('hyphenationExceptions')).toEqual({ 'de-DE': ['Vektor-studio'] });
    expect(hyphenPoints('Vektorstudio', loose, 'de-DE')).toEqual([6]);
  });

  it('loads a missing language when text needs it and lays the text out again', async () => {
    const app = await bootAppWithFeatures();
    const st = { ...createText('', 0, 0).char, ...CHAR };
    const node = area('xx avstavningsregler', measure('xx avstav-', st) + 0.5, { hyphenate: true, composer: 'single', hyphenation: { zone: 0 } }, { language: 'sv-SE' });
    let lay = layoutText(node);
    if (!hyphenationLoaded('sv-SE')) {
      expect(lay.lines[0].hyphen).toBe(false);
      for (let i = 0; i < 50 && !hyphenationLoaded('sv-SE'); i++) await tick(5);
    }
    expect(hyphenationLoaded('sv-SE')).toBe(true);
    lay = layoutText(node);
    expect(lay.lines[0].hyphen).toBe(true);
    expect(app.textFontsReady).toBeTypeOf('function');
  });

  it('the Custom Dictionary opens the exception list', async () => {
    const app = await bootAppWithFeatures();
    const done = app.commands.run('type.spelling.dictionary');
    await tick();
    const btn = [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Hyphenation Exceptions...');
    expect(btn).toBeTruthy();
    btn.click();
    await tick();
    const dlgs = [...document.querySelectorAll('dialog[open]')];
    const ex = dlgs.find((d) => d.textContent.includes('Exceptions for'));
    expect(ex).toBeTruthy();
    [...ex.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await tick();
    [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Done').click();
    await done;
  });
});
