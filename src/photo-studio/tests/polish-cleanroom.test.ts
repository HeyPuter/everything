// Clean-room check: no product or vendor names of other editors and none of
// their distinctive feature names in the source, tests, docs or UI strings.
// The terms are stored encoded so this file does not contain them either.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const TERMS = atob(
  'YWRvYmV8cGhvdG9zaG9wfGxpZ2h0cm9vbXxjYW1lcmEgcmF3fGZpcmVmbHl8Y29udGVudC1hd2FyZXxzbWFydCBvYmplY3R8c21hcnQgZmlsdGVyfHNtYXJ0IHNoYXJwZW58c21hcnQgYmx1cnxwdXBwZXQgd2FycHxnZW5lcmF0aXZlIGZpbGx8Z2VuZXJhdGl2ZSBleHBhbmR8bmV1cmFsIGZpbHRlcnxwaG90b21lcmdlfGNyZWF0aXZlIGNsb3VkfHR5cGVraXR8YmVoYW5jZXxrdWxlcnxzbWFydCBndWlkZXxhZGFwdGl2ZSB3aWRlIGFuZ2xlfGNvbnRleHR1YWwgdGFzayBiYXJ8Y29udGVudCBjcmVkZW50aWFsc3xzYXZlIGZvciB3ZWJ8bWVyZ2UgdG8gaGRyIHByb3xjb250YWN0IHNoZWV0IGlp',
).split('|');
const PATTERN = new RegExp(`\\b(${TERMS.join('|')})s?\\b`, 'i');

function files(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.(ts|js|mjs|css|html|json|md|svg|txt)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('clean-room names', () => {
  it('appear nowhere in src, tests, docs, scripts, index.html or the manifest', () => {
    const list = [
      ...files(path.join(ROOT, 'src')),
      ...files(path.join(ROOT, 'tests')),
      ...files(path.join(ROOT, 'docs')),
      ...files(path.join(ROOT, 'scripts')),
      ...['README.md', 'index.html', 'package.json', 'public/manifest.json'].map((f) => path.join(ROOT, f)),
    ].filter((f) => fs.existsSync(f));
    expect(list.length).toBeGreaterThan(300);
    const hits: string[] = [];
    for (const f of list) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const readme = path.basename(f) === 'README.md' && path.dirname(f) === ROOT;
      lines.forEach((line, i) => {
        // The README may say which product this is an alternative to, and carries the trademark notice.
        if (readme && (line.includes('open-source alternative to') || line.includes('trademarks of'))) return;
        // File-format identifiers (vendor MIME types, the standard XMP namespace and PNG keyword) are interop, not names.
        const cleaned = line
          .replace(/vnd\\?\.\w+\\?\.\w+/g, '')
          .replace(/https?:\/\/ns\.\w+\.com\/[\w./-]*\//g, '')
          .replace(/XML:com\.\w+\.xmp/g, '');
        const m = PATTERN.exec(cleaned);
        if (m) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${m[0]}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
