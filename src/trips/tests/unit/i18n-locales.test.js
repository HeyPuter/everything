// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import * as lucide from 'lucide';
import { checkLocale, english } from '../../tools/i18n-check.mjs';
import { LOCALES, formatLocale, localeDir, matchLocale, matchTag } from '../../src/lib/i18n/locales.js';
import { numeric, pickForm } from '../../src/lib/i18n/plural.js';
import { pseudo } from '../../src/lib/i18n/pseudo.js';

const dir = new URL('../../src/lib/i18n/', import.meta.url);
const tags = LOCALES.map((entry) => entry.tag).filter((tag) => tag !== 'en');

describe('locale files', () => {
  // Each check imports every module of a locale, which a loaded machine slows well past the 5 s default.
  let source;
  beforeAll(async () => { source = await english(); }, 30_000);
  it.each(tags)('%s has every English key with matching placeholders and valid plurals', async (tag) => {
    const report = await checkLocale(tag, { source });
    expect(report.errors).toEqual([]);
  }, 30_000);
  it.each(tags)('%s index.js exports every module file', (tag) => {
    const files = readdirSync(new URL(`${tag}/`, dir)).filter((name) => name.endsWith('.js') && name !== 'index.js').map((name) => name.slice(0, -3)).sort();
    const index = readFileSync(new URL(`${tag}/index.js`, dir), 'utf8');
    const exported = [...index.matchAll(/export \{ default as (\w+) \} from '\.\/(\w+)\.js';/g)].map((match) => { expect(match[1]).toBe(match[2]); return match[1]; }).sort();
    expect(exported).toEqual(files);
  });
  it('has a loader for every locale', () => {
    const source = readFileSync(new URL('index.js', dir), 'utf8');
    for (const tag of tags) expect(source).toContain(`'${tag}': () => import('./${tag}/index.js')`.replace(/^'([a-z]+)'/, '$1'));
  });
});

describe('plural forms', () => {
  const ru = { one: '{count} день', few: '{count} дня', many: '{count} дней', other: '{count} дня' };
  it('picks the CLDR category of the count', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 101].map((count) => pickForm(ru, { count }, 'ru'))).toEqual(['{count} день', '{count} дня', '{count} дней', '{count} дней', '{count} день', '{count} дня', '{count} дней', '{count} день']);
    expect(pickForm(ru, { count: '1,5' }, 'ru', 'ru')).toBe('{count} дня');
    const ar = { zero: 'z', one: 'o', two: 't', few: 'f {count}', many: 'm {count}', other: 'x {count}' };
    expect([0, 1, 2, 3, 11, 100].map((count) => pickForm(ar, { count }, 'ar'))).toEqual(['z', 'o', 't', 'f {count}', 'm {count}', 'x {count}']);
  });
  it('reads counts already formatted for the locale', () => {
    expect(numeric('1,234', 'en')).toEqual({ value: 1234, fraction: 0 });
    expect(numeric('1.234,5', 'de')).toEqual({ value: 1234.5, fraction: 1 });
    expect(numeric('٢٣', 'ar')).toEqual({ value: 23, fraction: 0 });
    expect(numeric('2 500', 'fr')).toEqual({ value: 2500, fraction: 0 });
    expect(numeric('n/a', 'en')).toBeNull();
  });
  it('falls back to "other" without a usable number', () => {
    expect(pickForm(ru, {}, 'ru')).toBe(ru.other);
    expect(pickForm({ one: '{days} día', other: '{days} días' }, { days: 1 }, 'es')).toBe('{days} día');
  });
});

describe('locale matching', () => {
  it('maps browser tags to supported locales', () => {
    expect(matchTag('de-AT')).toBe('de');
    expect(matchTag('pt-PT')).toBe('pt-BR');
    expect(matchTag('zh-HK')).toBe('zh-TW');
    expect(matchTag('zh-Hans-SG')).toBe('zh-CN');
    expect(matchTag('iw')).toBe('he');
    expect(matchTag('nb-NO')).toBeNull();
    expect(matchLocale(['fi-FI', 'sv-FI'])).toBe('sv');
    expect(matchLocale(['fi-FI'])).toBe('en');
    expect(localeDir('he')).toBe('rtl');
  });
  it('formats in the UI language, keeping the browser region', () => {
    expect(formatLocale('de', ['de-AT'])).toBe('de-AT');
    expect(formatLocale('en', ['de-DE'])).toBe('en-DE');
    expect(formatLocale('ar', [])).toBe('ar');
    expect(formatLocale('zh-CN', ['zh-TW'])).toBe('zh-CN');
  });
});

describe('pseudo-locale', () => {
  it('accents and lengthens text but keeps placeholders', () => {
    const text = pseudo('Signed in as {name}');
    expect(text).toContain('{name}');
    expect(text.replace('{name}', '')).not.toMatch(/[a-z]/);
    expect(text.length).toBeGreaterThan('Signed in as {name}'.length * 1.3);
    expect(pseudo('{keys}')).toBe('{keys}');
  });
});

describe('RTL icons', () => {
  it('mirrors directional icons by their current lucide path data', () => {
    const css = readFileSync(new URL('../../src/styles/base.css', import.meta.url), 'utf8');
    const icons = { ChevronLeft: 0, ChevronRight: 0, ArrowLeft: 0, ArrowRight: 1, Undo2: 0, Redo2: 0, SendHorizontal: 1, Send: 1, Reply: 0, LogOut: 0 };
    for (const [name, index] of Object.entries(icons)) expect(css, name).toContain(`path[d="${lucide[name][index][1].d}"]`);
  });
});
