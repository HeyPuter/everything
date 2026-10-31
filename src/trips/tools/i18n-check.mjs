// Checks locale files against English: keys, placeholders and plural forms.
//   node tools/i18n-check.mjs [<tag> [<module>…]] [--identical] [--refs] [--write-untranslated] [--write-index]
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { LOCALES } from '../src/lib/i18n/locales.js';
import { CATEGORIES, integerCategories, isPlural, placeholders, selector } from '../src/lib/i18n/plural.js';

const dir = fileURLToPath(new URL('../src/lib/i18n/', import.meta.url));
const TAGS = LOCALES.map((entry) => entry.tag).filter((tag) => tag !== 'en');
const moduleFiles = (tag) => (existsSync(join(dir, tag)) ? readdirSync(join(dir, tag)).filter((name) => /^[a-z]\w*\.js$/i.test(name) && name !== 'index.js').map((name) => name.slice(0, -3)).sort() : []);
const load = async (tag, module) => (await import(pathToFileURL(join(dir, tag, `${module}.js`)).href)).default;

export async function english() {
  const result = {};
  for (const module of moduleFiles('en')) result[module] = await load('en', module);
  return result;
}
export async function untranslatedList() {
  return (await import(pathToFileURL(join(dir, 'untranslated.js')).href)).default;
}
/** True when `key` is listed as English-only for `tag` (exact key, or a module prefix ending in "."). */
export function listed(list, tag, key) {
  return [...(list['*'] ?? []), ...(list[tag] ?? [])].some((entry) => (entry.endsWith('.') ? key.startsWith(entry) : key === entry));
}
const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));
// Per locale: the categories it allows and the ones whole numbers need (slow to compute, asked for every plural value).
const categories = new Map();
function pluralCategories(tag) {
  if (!categories.has(tag)) categories.set(tag, { allowed: new Intl.PluralRules(tag).resolvedOptions().pluralCategories, integer: integerCategories(tag) });
  return categories.get(tag);
}

function checkValue(tag, key, source, value, errors) {
  const want = new Set(placeholders(source));
  if (typeof value === 'string') {
    if (!value.trim() && source.trim()) errors.push(`${key}: empty`);
    const got = new Set(placeholders(value));
    if (!sameSet(want, got)) errors.push(`${key}: placeholders {${[...got].join('}, {')}} should be {${[...want].join('}, {')}}`);
    return;
  }
  if (!isPlural(value)) { errors.push(`${key}: must be a string or a plural object with "other"`); return; }
  const { allowed, integer } = pluralCategories(tag);
  for (const category of Object.keys(value)) {
    if (!CATEGORIES.includes(category) || !allowed.includes(category)) errors.push(`${key}: "${category}" is not a ${tag} plural category (${allowed.join(', ')})`);
    else if (typeof value[category] !== 'string' || !value[category].trim()) errors.push(`${key}.${category}: must be a non-empty string`);
  }
  for (const category of integer) if (typeof value[category] !== 'string') errors.push(`${key}: plural form "${category}" is missing`);
  // Same choice as the runtime: {count}, else {n}, else the first placeholder of the `other` form.
  const pick = selector(value);
  if (!pick || !want.has(pick)) { errors.push(`${key}: plural forms need a number placeholder ({count}, {n}, or another first in "other")`); return; }
  for (const [category, form] of Object.entries(value)) {
    if (typeof form !== 'string') continue;
    const got = new Set(placeholders(form));
    const missing = [...want].filter((name) => !got.has(name) && !(name === pick && category !== 'other'));
    const extra = [...got].filter((name) => !want.has(name));
    if (missing.length || extra.length) errors.push(`${key}.${category}: placeholders {${[...got].join('}, {')}} should be {${[...want].join('}, {')}}${category === 'other' ? '' : ` ({${pick}} optional)`}`);
  }
}

/** `{errors, warnings, missing, identical}` for one locale; `modules` limits the check. */
export async function checkLocale(tag, { modules, source } = {}) {
  const en = source ?? await english();
  const list = await untranslatedList();
  const present = new Set(moduleFiles(tag));
  const errors = []; const warnings = []; const missing = []; const identical = [];
  for (const file of present) if (!Object.hasOwn(en, file)) errors.push(`${file}.js: no English module of that name`);
  for (const [module, strings] of Object.entries(en)) {
    if (modules && !modules.includes(module)) continue;
    let table = {};
    if (present.has(module)) {
      try { table = await load(tag, module); } catch (error) { errors.push(`${module}.js: ${error.message}`); continue; }
      if (!table || typeof table !== 'object') { errors.push(`${module}.js: default export must be an object`); continue; }
    }
    const keys = Object.keys(strings);
    for (const key of Object.keys(table)) if (!Object.hasOwn(strings, key)) errors.push(`${key}: not an English key`);
    for (const key of keys) {
      if (!Object.hasOwn(table, key)) { missing.push(key); continue; }
      checkValue(tag, key, strings[key], table[key], errors);
      if (table[key] === strings[key] && /[a-z]{3}/i.test(strings[key])) identical.push(key);
    }
    const order = Object.keys(table).filter((key) => Object.hasOwn(strings, key));
    const expected = keys.filter((key) => Object.hasOwn(table, key));
    if (order.join('\n') !== expected.join('\n')) warnings.push(`${module}.js: keys are not in English order`);
  }
  const unlisted = missing.filter((key) => !listed(list, tag, key));
  for (const key of unlisted) errors.push(`${key}: missing (translate it or list it in untranslated.js)`);
  const stale = (list[tag] ?? []).filter((entry) => !entry.endsWith('.') && !missing.includes(entry) && (!modules || modules.includes(entry.split('.')[0])));
  for (const key of stale) errors.push(`${key}: translated but still listed in untranslated.js`);
  return { errors, warnings, missing, identical };
}

/** Strings that name other labels ("Settings → Your data", “Add to day…”) without that label's translation. */
export async function references(tag, { source } = {}) {
  const en = Object.assign({}, ...Object.values(source ?? await english()));
  const table = {};
  for (const module of moduleFiles(tag)) Object.assign(table, await load(tag, module));
  const bare = (text) => text.trim().replace(/…$/, '');
  const byValue = new Map();
  for (const [key, value] of Object.entries(en)) if (!value.includes('→') && value.length < 40) byValue.set(bare(value), [...(byValue.get(bare(value)) ?? []), key]);
  const found = [];
  for (const [key, value] of Object.entries(en)) {
    if (typeof table[key] !== 'string') continue;
    const parts = [...(value.includes(' → ') ? value.split(' → ') : []), ...[...value.matchAll(/“([^”]+)”/g)].map((match) => match[1])];
    for (const part of parts) {
      const names = [...new Set((byValue.get(bare(part)) ?? []).filter((other) => other !== key).map((other) => table[other]).filter((text) => typeof text === 'string').map(bare))];
      if (names.length && !names.some((name) => table[key].includes(name))) found.push(`${key}: "${table[key]}" should contain "${names.join('" or "')}"`);
    }
  }
  return found;
}

async function writeUntranslated() {
  const en = await english();
  const list = await untranslatedList();
  const next = { '*': list['*'] ?? [] };
  for (const tag of TAGS) {
    const { missing } = await checkLocale(tag, { source: en });
    const keys = missing.filter((key) => !listed({ '*': next['*'] }, tag, key));
    if (keys.length) next[tag] = keys;
  }
  const body = Object.entries(next).map(([tag, keys]) => `  ${JSON.stringify(tag)}: [\n${keys.map((key) => `    ${JSON.stringify(key)},`).join('\n')}\n  ],`).join('\n');
  writeFileSync(join(dir, 'untranslated.js'), `// Keys shown in English, by locale ("*": every locale). Entries ending in "." cover a whole module.\n// Regenerate with \`node tools/i18n-check.mjs --write-untranslated\` after adding English strings.\nexport default {\n${body}\n};\n`);
}
function writeIndex(tag) {
  const lines = moduleFiles(tag).map((module) => `export { default as ${module} } from './${module}.js';`);
  writeFileSync(join(dir, tag, 'index.js'), `${lines.join('\n')}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  const [tag, ...modules] = args.filter((arg) => !arg.startsWith('--'));
  if (flags.has('--write-index')) for (const each of tag ? [tag] : TAGS) if (existsSync(join(dir, each))) writeIndex(each);
  if (flags.has('--write-untranslated')) await writeUntranslated();
  let failed = false;
  for (const each of tag ? [tag] : TAGS) {
    if (!TAGS.includes(each)) { console.error(`Unknown locale ${each}`); process.exit(2); }
    const report = await checkLocale(each, { modules: modules.length ? modules : undefined });
    const status = report.errors.length ? 'FAIL' : 'ok';
    console.log(`${each}: ${status} (${report.errors.length} errors, ${report.missing.length} missing, ${report.identical.length} same as English)`);
    for (const line of report.errors) console.log(`  error   ${line}`);
    for (const line of report.warnings) console.log(`  warning ${line}`);
    if (flags.has('--identical')) for (const key of report.identical) console.log(`  same    ${key}`);
    if (flags.has('--refs')) for (const line of await references(each)) console.log(`  ref     ${line}`);
    failed ||= report.errors.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
