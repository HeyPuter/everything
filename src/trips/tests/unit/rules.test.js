// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as catalogue from '../../src/lib/i18n/en/index.js';
import { strings } from '../../src/lib/i18n/index.js';

const root = new URL('../../', import.meta.url).pathname;
const files = (dir, pattern) => readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && pattern.test(entry.name))
  .map((entry) => relative(root, join(entry.parentPath, entry.name)))
  .filter((path) => !path.includes('node_modules') && !/(^|\/)dist(-mock)?\//.test(path));
const source = files('src', /\.(js|css)$/);
const code = [...source, ...['dev', 'tests', 'scripts', 'tools', 'worker-geo'].flatMap((dir) => files(dir, /\.(js|mjs|css)$/))];
const read = (path) => readFileSync(join(root, path), 'utf8');
const offenders = (paths, pattern, allowed = () => false) => paths.filter((path) => !allowed(path) && pattern.test(read(path)));

describe('PLAN §1 and architecture §17 guards', () => {
  it('calls workers.exec only from src/lib/api.js', () => {
    expect(offenders(source.filter((path) => path.endsWith('.js')), /workers\s*\.\s*exec\b/, (path) => path === 'src/lib/api.js')).toEqual([]);
  });
  it('never renders HTML strings', () => {
    expect(offenders(source, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/)).toEqual([]);
  });
  it('lists KV only in the sync layer', () => {
    expect(offenders(source, /kv\s*\.\s*list\s*\(/, (path) => path.startsWith('src/lib/sync/'))).toEqual([]);
  });
  it('keeps literal colors in tokens.css', () => {
    expect(offenders(source, /#[0-9a-f]{3,8}\b(?![-\w])|\b(rgba?|hsla?|oklch|oklab)\(/i, (path) => path === 'src/styles/tokens.css')).toEqual([]);
  });
  it('uses logical CSS properties (RTL-safe)', () => {
    const physical = /(^|[\s;{])(margin|padding|border|inset|scroll-margin|scroll-padding)-(left|right)\b|(^|[\s;{])(left|right)\s*:|\b(text-align|float|clear)\s*:\s*(left|right)\b|border-(top|bottom)-(left|right)-radius|background-position(-x)?\s*:[^;}]*\b(left|right)\b/m;
    expect(offenders(source.filter((path) => path.endsWith('.css')), physical)).toEqual([]);
    // Four-value shorthands whose left and right differ (`padding: 6px 6px 6px 2px`); safe-area tokens are physical on purpose.
    const sides = /(^|[\s;{])(margin|padding|inset|scroll-margin|scroll-padding)\s*:\s*([-\w.%]+)\s+([-\w.%]+)\s+([-\w.%]+)\s+(?!\4\s*[;}!])[-\w.%]+\s*[;}!]/m;
    expect(offenders(source.filter((path) => path.endsWith('.css')), sides)).toEqual([]);
    // Floating layers placed at viewport coordinates (menus, drag ghosts) are the only physical inline styles.
    const inline = /\.style\.(left|right|marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|textAlign)\b|\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight)\s*:|\b(left|right)\s*:\s*`/;
    expect(offenders(source.filter((path) => path.endsWith('.js')), inline, (path) => ['src/ui/menu.js', 'src/ui/dnd.js'].includes(path))).toEqual([]);
  });
  it('passes no null or false children to native DOM insertion (they would render as text)', () => {
    // The top-level text of a call's arguments, without nested brackets or strings.
    const args = (text, start) => {
      let depth = 1; let quote = null; let out = '';
      for (let i = start; i < text.length && depth; i++) {
        const c = text[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
        if (c === "'" || c === '"' || c === '`') quote = c;
        else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (depth === 1) out += c;
      }
      return out;
    };
    const risky = /:\s*(null|undefined|false)\s*(,|$)|&&|\?\?\s*(null|undefined)/;
    const unsafe = (path) => { const text = read(path); return [...text.matchAll(/\.(replaceChildren|append|prepend|before|after)\(/g)].some((match) => risky.test(args(text, match.index + match[0].length))); };
    expect(source.filter((path) => path.endsWith('.js') && path !== 'src/ui/dom.js' && unsafe(path))).toEqual([]);
  });
});

describe('translations', () => {
  it('namespaces each module file by its name without duplicates', () => {
    const seen = new Set();
    for (const [module, entries] of Object.entries(catalogue)) {
      for (const key of Object.keys(entries)) {
        expect(key.startsWith(`${module}.`), key).toBe(true);
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });
  it('defines every literal key used in source and registries', () => {
    const keys = [...source.filter((path) => path.endsWith('.js')), 'dev/kit.js', 'dev/mock-boot.js'].flatMap((path) => [...read(path).matchAll(/\b(?:t\(|labelKey:\s*)'([a-z][\w-]*\.[\w.-]+)'/g)].map((match) => [path, match[1]]));
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.filter(([, key]) => !Object.hasOwn(strings, key))).toEqual([]);
  });
});
