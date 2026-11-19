// Tooltips and help text show shortcuts the way this platform types them
// (⌘Z on macOS, Ctrl+Z elsewhere) through formatShortcut, never the internal
// "Mod+Z" spelling that command definitions use.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', 'src');

function files(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** What is left of a line once shortcut definitions, comments and regular
 * expressions (which spell "Mod+" on purpose) are taken out. */
function visible(line: string) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return '';
  return (
    line
      .replace(/\/\/.*$/, '')
      .replace(/formatShortcut\([^)]*\)/g, '')
      // A string literal that is only a shortcut, e.g. shortcut: 'Mod+Shift+Z'.
      .replace(/'Mod\+[^'\s]*'|"Mod\+[^"\s]*"/g, '')
      .replace(/\/\^?Mod\\\+[^/]*\//g, '')
      .replace(/startsWith\('Mod\+'\)/g, '')
  );
}

describe('shortcut labels', () => {
  it('no user-visible string spells a shortcut as "Mod+…"', () => {
    const list = files(SRC);
    expect(list.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const f of list) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bMod\+/.test(visible(line))) hits.push(`${path.relative(SRC, f)}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
