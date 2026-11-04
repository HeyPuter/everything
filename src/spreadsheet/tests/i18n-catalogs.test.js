// The message catalogs (src/locales) hold together: every language has every source message, with
// the same arguments, plurals its language uses, tags and punctuation of its own; every message the
// code asks for exists, and every message exists because the code asks for it.
import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { LANGUAGES, SOURCE_LANGUAGE } from '../src/i18n/languages.js';

const ROOT = new URL('..', import.meta.url).pathname;
const LOCALES = join(ROOT, 'src/locales');

function readCatalogs(lang) {
  const dir = join(LOCALES, lang);
  const out = new Map(); // ns → { key: message }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    out.set(file.slice(0, -5), JSON.parse(readFileSync(join(dir, file), 'utf8')));
  }
  return out;
}

function sourceFiles(dir = join(ROOT, 'src'), out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(join(ROOT, 'src'), path);
    if (/^(vendor|locales|collab\/server|workers)$/.test(rel)) continue;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith('.js') && name !== 'script-runtime.src.js') out.push(path);
  }
  return out;
}

const source = readCatalogs(SOURCE_LANGUAGE);
const flat = (catalogs) => new Map([...catalogs].flatMap(([ns, msgs]) => Object.entries(msgs).map(([k, m]) => [`${ns}.${k}`, m])));
const sourceFlat = flat(source);
const code = sourceFiles().map((path) => [relative(ROOT, path), readFileSync(path, 'utf8')]);

// Keys the code formats with tRich: their tags are markup, so they are read with tags.
const RICH = new Set();
for (const [, text] of code) for (const m of text.matchAll(/\btRich\(\s*'([^']+)'/g)) RICH.add(m[1]);

const parseMessage = (message, key) => parse(message, { ignoreTag: !RICH.has(key), requiresOtherClause: true });

/** What a message needs from the code and the shape a translation has to keep. */
function shapeOf(elements, shape = { args: new Set(), tags: new Set(), plurals: [], selects: new Map() }) {
  for (const e of elements) {
    if (e.type === TYPE.argument || e.type === TYPE.number || e.type === TYPE.date || e.type === TYPE.time) shape.args.add(e.value);
    else if (e.type === TYPE.plural) {
      shape.args.add(e.value);
      shape.plurals.push(Object.keys(e.options));
      for (const o of Object.values(e.options)) shapeOf(o.value, shape);
    } else if (e.type === TYPE.select) {
      shape.args.add(e.value);
      const known = shape.selects.get(e.value) || new Set();
      for (const k of Object.keys(e.options)) known.add(k);
      shape.selects.set(e.value, known);
      for (const o of Object.values(e.options)) shapeOf(o.value, shape);
    } else if (e.type === TYPE.tag) {
      shape.tags.add(e.value);
      shapeOf(e.children, shape);
    }
  }
  return shape;
}

const sorted = (set) => [...set].sort();

describe('catalog files', () => {
  test('no two namespaces differ only in case (a case-insensitive disk keeps one of them)', () => {
    const names = [...source.keys()].map((n) => n.toLowerCase());
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  test('every language has a folder, and every folder is a language', () => {
    const folders = readdirSync(LOCALES).filter((f) => statSync(join(LOCALES, f)).isDirectory()).sort();
    expect(folders).toEqual(LANGUAGES.map((l) => l.id).sort());
  });

  for (const { id } of LANGUAGES) {
    test(`${id}: namespaces and keys are well formed`, () => {
      const problems = [];
      for (const [ns, msgs] of readCatalogs(id)) {
        if (!/^[a-z][A-Za-z0-9]*$/.test(ns)) problems.push(`${ns}.json: a namespace is camelCase`);
        const keys = Object.keys(msgs);
        if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) problems.push(`${ns}.json: keys are kept sorted`);
        for (const [key, message] of Object.entries(msgs)) {
          if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)*$/.test(key)) problems.push(`${ns}.${key}: a key is camelCase segments separated by dots`);
          if (typeof message !== 'string' || !message) problems.push(`${ns}.${key}: a message is non-empty text`);
          else if (message !== message.trim()) problems.push(`${ns}.${key}: no space at either end (spacing belongs to the code that joins messages)`);
        }
      }
      expect(problems).toEqual([]);
    });
  }
});

describe('the source language', () => {
  test('every message parses as ICU MessageFormat', () => {
    const problems = [];
    for (const [key, message] of sourceFlat) {
      try { parseMessage(message, key); } catch (e) { problems.push(`${key}: ${e.message}`); }
    }
    expect(problems).toEqual([]);
  });

  test('every message the code asks for exists', () => {
    const problems = [];
    // Only where t() is the catalogs' own: elsewhere a local t (a loop variable, say) is something else.
    for (const [file, text] of code.filter(([, text]) => /from '[./]*\/i18n\/index\.js'/.test(text))) {
      for (const m of text.matchAll(/\bt(?:Rich|Source)?\(\s*(['"])([^'"]+)\1/g)) if (!sourceFlat.has(m[2])) problems.push(`${file}: ${m[2]}`);
      // A key put together at run time cannot be checked here, nor found by a translator: name each in full.
      for (const m of text.matchAll(/\bt(?:Rich|Source)?\(\s*`[^`]*\$\{/g)) problems.push(`${file}: a key built at run time (${m[0]}…)`);
    }
    expect(problems).toEqual([]);
  });

  test('every message is used by the code', () => {
    // Named in full anywhere in the code, as a t() argument or as a key in a table the code formats from.
    const named = new Set();
    for (const [, text] of code) for (const m of text.matchAll(/(['"`])([a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+)\1/g)) named.add(m[2]);
    expect([...sourceFlat.keys()].filter((k) => !named.has(k))).toEqual([]);
  });
});

/** Words a translation keeps in Latin letters: names of products and formats, and code. */
const KEPT_WORDS = new Set(`
  Puter Excel Microsoft Google Sheets Apple Numbers LibreOffice OpenOffice OpenDocument Office Lotus WPS
  SmartArt WordArt Power Query Pivot DAX VBA Unicode ASCII UTF Markdown JavaScript JSON XML HTML CSS SVG
  PNG JPEG GIF WebP EMF WMF PDF CSV TSV XLSX XLSM XLS ODS TXT PRN DIF SYLK URL URI HTTP HTTPS API IME RGB
  HSL HEX CMYK GPU CPU ISO ANSI IEEE Ctrl Shift Alt Option Cmd Command Enter Esc Tab Space Home End PgUp
  PgDn Fn Delete Backspace Insert Num Lock Caps Scroll Calibri Cambria Carlito Caladea Arial Aptos AutoSum
  OLAP OData SQL ODBC LAMBDA LET Wingdings Webdings Symbol Web True False
`.split(/\s+/).filter(Boolean));

const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/** The text a person reads in a message: its literal parts, without arguments, keywords or tag names. */
function literalText(elements) {
  let out = '';
  for (const e of elements) {
    if (e.type === TYPE.literal) out += e.value;
    else if (e.type === TYPE.argument || e.type === TYPE.number || e.type === TYPE.date || e.type === TYPE.time || e.type === TYPE.pound) out += '\u0000';
    else if (e.type === TYPE.plural || e.type === TYPE.select) out += Object.values(e.options).map((o) => literalText(o.value)).join('\u0001');
    else if (e.type === TYPE.tag) out += literalText(e.children);
  }
  return out;
}

for (const { id } of LANGUAGES.filter((l) => l.id !== SOURCE_LANGUAGE)) {
  describe(`${id} translation`, () => {
    const catalogs = readCatalogs(id);
    const messages = flat(catalogs);
    const categories = new Set(new Intl.PluralRules(id).resolvedOptions().pluralCategories);
    const ordinals = new Set(new Intl.PluralRules(id, { type: 'ordinal' }).resolvedOptions().pluralCategories);

    test('has every namespace and every message of the source, and nothing else', () => {
      const missing = [...sourceFlat.keys()].filter((k) => !messages.has(k));
      const extra = [...messages.keys()].filter((k) => !sourceFlat.has(k));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    test('keeps each message\'s arguments, tags and choices, with the plural forms of its language', () => {
      const problems = [];
      for (const [key, message] of messages) {
        const en = sourceFlat.get(key);
        if (en === undefined) continue;
        let ast;
        try { ast = parseMessage(message, key); } catch (e) { problems.push(`${key}: does not parse (${e.message})`); continue; }
        const want = shapeOf(parseMessage(en, key));
        const got = shapeOf(ast);
        if (sorted(got.args).join() !== sorted(want.args).join()) problems.push(`${key}: arguments {${sorted(got.args)}} should be {${sorted(want.args)}}`);
        if (sorted(got.tags).join() !== sorted(want.tags).join()) problems.push(`${key}: tags <${sorted(got.tags)}> should be <${sorted(want.tags)}>`);
        for (const [arg, options] of want.selects) {
          const mine = got.selects.get(arg) || new Set();
          for (const o of options) if (!mine.has(o)) problems.push(`${key}: select {${arg}} has no "${o}" case`);
        }
        const walk = (els) => {
          for (const e of els) {
            if (e.type === TYPE.plural) {
              const allowed = e.pluralType === 'ordinal' ? ordinals : categories;
              for (const k of Object.keys(e.options)) if (!k.startsWith('=') && !allowed.has(k)) problems.push(`${key}: "${k}" is not a plural form of ${id} (it has ${[...allowed].join(', ')})`);
            }
            if (e.options) for (const o of Object.values(e.options)) walk(o.value);
            if (e.children) walk(e.children);
          }
        };
        walk(ast);
      }
      expect(problems).toEqual([]);
    });

    if (id.startsWith('zh')) {
      test('is written in Chinese, with Chinese punctuation and a space between Chinese and Latin text', () => {
        const problems = [];
        for (const [key, message] of messages) {
          let text;
          try { text = literalText(parseMessage(message, key)); } catch { continue; }
          const words = (text.match(/[A-Za-z]{3,}/g) || []).filter((w) => !KEPT_WORDS.has(w) && !/^[A-Z0-9]+$/.test(w));
          if (!CJK.test(text) && words.length) problems.push(`${key}: not translated ("${message}")`);
          if (/[一-鿿][,;!?]|[一-鿿][.:](\s|$)|[一-鿿]\(|[,;!?]\s*[一-鿿]/.test(text)) problems.push(`${key}: ASCII punctuation in Chinese text, use ，；！？。：（） ("${message}")`);
          if (/[一-鿿][A-Za-z0-9]|[A-Za-z0-9][一-鿿]/.test(text)) problems.push(`${key}: put a space between Chinese and Latin letters or digits ("${message}")`);
        }
        expect(problems).toEqual([]);
      });
    }
  });
}
