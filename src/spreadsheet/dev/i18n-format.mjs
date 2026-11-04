// npm run i18n:format: rewrite every catalog in src/locales the one way the tests expect (keys sorted,
// two-space indent, a final newline), so a catalog edited by hand or by a translation tool diffs cleanly.
// npm run i18n:format -- --check exits 1, changing nothing, when a catalog is not in that form.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src/locales/', import.meta.url).pathname;
const check = process.argv.includes('--check');
let unformatted = 0;
for (const lang of readdirSync(root)) {
  const dir = join(root, lang);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const data = JSON.parse(before);
    const after = `${JSON.stringify(Object.fromEntries(Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2)}\n`;
    if (after === before) continue;
    unformatted++;
    if (check) console.log(`not formatted: ${lang}/${file}`);
    else writeFileSync(path, after);
  }
}
if (check && unformatted) process.exit(1);
