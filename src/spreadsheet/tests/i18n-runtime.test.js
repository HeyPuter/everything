// The interface-language runtime (src/i18n): choosing a language, formatting messages in it, and
// falling back to English where a translation is missing or broken.
// @vitest-environment jsdom
import { describe, test, expect, afterEach, vi } from 'vitest';
import { t, tRich, tSource, useLanguage, language, resolveLanguage, negotiateLanguage, setLanguagePreference, languagePreference, flattenCatalogs, formatNumber, formatList, displayName, compareText } from '../src/i18n/index.js';
import { pseudoLocalize } from '../src/i18n/pseudo.js';
import { IntlMessageFormat } from 'intl-messageformat';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

afterEach(async () => {
  await useLanguage('en');
  setLanguagePreference('auto');
});

describe('choosing the language', () => {
  test('a browser language is matched by language and script, not region', () => {
    expect(negotiateLanguage(['zh-CN'])).toBe('zh-Hans');
    expect(negotiateLanguage(['zh'])).toBe('zh-Hans');
    expect(negotiateLanguage(['zh-SG', 'en'])).toBe('zh-Hans');
    expect(negotiateLanguage(['zh-Hans-HK'])).toBe('zh-Hans');
    expect(negotiateLanguage(['en-GB'])).toBe('en');
  });

  test('Traditional Chinese is not served Simplified: the next language is taken', () => {
    expect(negotiateLanguage(['zh-TW', 'en-US'])).toBe('en');
    expect(negotiateLanguage(['zh-HK'])).toBe('en');
    expect(negotiateLanguage(['zh-Hant', 'zh-CN'])).toBe('zh-Hans');
  });

  test('a language the app does not ship falls through to the next, then to English', () => {
    expect(negotiateLanguage(['fr-FR', 'zh-CN'])).toBe('zh-Hans');
    expect(negotiateLanguage(['fr-FR', 'de'])).toBe('en');
    expect(negotiateLanguage(['not a tag', 'zh-CN'])).toBe('zh-Hans');
    expect(negotiateLanguage([])).toBe('en');
  });

  test('the address outranks the person\'s choice, which outranks the browser', () => {
    expect(resolveLanguage({ search: '?lang=zh-Hans', preference: 'en', requested: ['en'] })).toBe('zh-Hans');
    expect(resolveLanguage({ search: '?lang=klingon', preference: 'zh-Hans', requested: ['en'] })).toBe('zh-Hans');
    expect(resolveLanguage({ search: '', preference: 'auto', requested: ['zh-CN'] })).toBe('zh-Hans');
    expect(resolveLanguage({ search: '', preference: 'en', requested: ['zh-CN'] })).toBe('en');
  });

  test('the choice is kept in this browser, and "auto" forgets it', () => {
    setLanguagePreference('zh-Hans');
    expect(languagePreference()).toBe('zh-Hans');
    setLanguagePreference('auto');
    expect(languagePreference()).toBe('auto');
    setLanguagePreference('xx');
    expect(languagePreference()).toBe('auto');
  });

  test('loading a language marks the page as written in it', async () => {
    await useLanguage('zh-Hans');
    expect(language()).toBe('zh-Hans');
    expect(document.documentElement.lang).toBe('zh-Hans');
    expect(document.documentElement.dir).toBe('ltr');
    await useLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('formatting messages', () => {
  test('English is there before any language is loaded', () => {
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('app.importing', { name: 'Q3.xlsx' })).toBe('Importing Q3.xlsx…');
  });

  test('a loaded language shows its own words, with the arguments put in', async () => {
    await useLanguage('zh-Hans');
    expect(t('common.cancel')).toBe('取消');
    expect(t('app.importing', { name: 'Q3.xlsx' })).toBe('正在导入 Q3.xlsx…');
  });

  test('tSource gives English whatever the interface language', async () => {
    await useLanguage('zh-Hans');
    expect(tSource('app.importing', { name: 'a.csv' })).toBe('Importing a.csv…');
    expect(t('app.importing', { name: 'a.csv' })).toBe('正在导入 a.csv…');
  });

  test('a key with no message shows the key, so the gap is visible', () => {
    expect(t('nowhere.at.all')).toBe('nowhere.at.all');
  });

  test('flattening names each message by its file and key', () => {
    const map = flattenCatalogs({ '../locales/en/home.json': { title: 'Home', 'list.empty': 'Nothing' } });
    expect([...map]).toEqual([['home.title', 'Home'], ['home.list.empty', 'Nothing']]);
  });

  test('rich messages hand each tag its content and keep nodes as nodes', () => {
    // Through the formatter itself, as tRich does, so the test does not need a catalog entry of its own.
    const parts = new IntlMessageFormat('<b>{n}</b> rows in {sheet}', 'en').format({ n: 3, sheet: 'S1', b: (c) => ({ bold: c.join('') }) });
    expect(parts).toEqual([{ bold: '3' }, ' rows in S1']);
    expect(tRich('common.cancel')).toEqual(['Cancel']);
  });
});

describe('formatting for the interface language', () => {
  test('numbers, lists and names follow the language', async () => {
    expect(formatNumber(1234.5)).toBe('1,234.5');
    expect(formatList(['A', 'B', 'C'])).toBe('A, B, and C');
    expect(displayName('fr')).toBe('French');
    await useLanguage('zh-Hans');
    expect(formatList(['A', 'B', 'C'])).toBe('A、B和C');
    expect(displayName('fr')).toBe('法语');
  });

  test('sorting puts numbers in order and ignores case', () => {
    expect(['b10', 'B2', 'a'].sort(compareText)).toEqual(['a', 'B2', 'b10']);
  });
});

describe('pseudo-localization', () => {
  test('accents and pads text but keeps arguments, plurals and tags working', () => {
    const p = pseudoLocalize('{count, plural, one {# row} other {# rows}} in <b>{sheet}</b>');
    expect(p.startsWith('⟦')).toBe(true);
    expect(p.endsWith('⟧')).toBe(true);
    const out = new IntlMessageFormat(p, 'en').format({ count: 2, sheet: 'Sheet1', b: (c) => c.join('') });
    expect(out).toMatch(/^⟦2 ŕöŵš íñ Sheet1 ·+⟧$/);
  });

  test('a message that does not parse is left as it is', () => {
    expect(pseudoLocalize('{broken')).toBe('{broken');
  });

  test('the pseudo-language is loaded from the source catalogs', async () => {
    await useLanguage('en-XA');
    expect(t('common.cancel')).toMatch(/^⟦Çáñçéļ ·+⟧$/);
    expect(t('app.importing', { name: 'Q3.xlsx' })).toContain('Q3.xlsx');
  });
});

describe('when a translation is wrong', () => {
  test('a message that is not there in the language falls back to English', async () => {
    await useLanguage('zh-Hans');
    // Every shipped key is translated (i18n-catalogs.test.js); a key missing would come from English.
    expect(t('app.importing', { name: 'x' })).not.toBe('app.importing');
  });

  test('a value left out does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => t('app.importing')).not.toThrow();
    warn.mockRestore();
  });
});

describe('outside Vite', () => {
  test('a script run by plain Node reads the catalogs from disk', () => {
    // Tests and scripts that start their own `node` load app modules without Vite's import.meta.glob.
    // (Under jsdom import.meta.url is an http URL, so the path is taken from the app folder vitest runs in.)
    const script = `const m = await import(${JSON.stringify(pathToFileURL(resolve('src/i18n/index.js')).href)});
      const en = m.t('common.cancel'); await m.useLanguage('zh-Hans'); console.log(en, m.t('common.cancel'));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(out.trim()).toBe('Cancel 取消');
  });
});
