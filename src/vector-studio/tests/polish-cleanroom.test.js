// Clean-room check: no product or vendor names of other editors and none of
// their distinctive feature names in the source, tests, docs or UI strings.
// The terms are stored encoded so this file does not contain them either.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const TERMS = atob(
  'YWRvYmV8aWxsdXN0cmF0b3J8cGhvdG9zaG9wfGluZGVzaWdufGNyZWF0aXZlIGNsb3VkfGZpcmVmbHl8bGl2ZSBwYWludHxpbWFnZSB0cmFjZXxsaXZlIHRyYWNlfGludGVydHdpbmV8cHVwcGV0IHdhcnB8c2hhcGVyfHNtYXJ0IGd1aWRlfHRvdWNoIHR5cGV8cmVjb2xvciBhcnR3b3JrfGdlbmVyYXRpdmUgcmVjb2xvcnxncmFkaWVudCBhbm5vdGF0b3J8c25hcCB0byBnbHlwaHxjb250ZXh0dWFsIHRhc2sgYmFyfGVzc2VudGlhbHMgY2xhc3NpY3xibG9iIGJydXNofHR5cGVraXR8YmVoYW5jZXxrdWxlcnx0ZXh0IHRvIHZlY3RvcnxyZXR5cGU=',
).split('|');
const PATTERN = new RegExp(`\\b(${TERMS.join('|')})s?\\b`, 'i');

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.(js|mjs|css|html|json|md|svg|txt)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('clean-room names', () => {
  it('appear nowhere in src, tests, README, index.html or the manifest', () => {
    const list = [...files(path.join(ROOT, 'src')), ...files(path.join(ROOT, 'tests')), ...['README.md', 'index.html', 'package.json', 'public/manifest.json'].map((f) => path.join(ROOT, f))].filter((f) => fs.existsSync(f));
    expect(list.length).toBeGreaterThan(300);
    const hits = [];
    for (const f of list) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const readme = path.basename(f) === 'README.md';
      lines.forEach((line, i) => {
        // The README may say which products this is an alternative to.
        if (readme && line.includes('open-source alternative to')) return;
        // File-format identifiers (the PostScript header comment, vendor MIME types, the standard XMP
        // namespace URIs PDF/X metadata requires) are interop, not names.
        const m = PATTERN.exec(line.replace(/%!PS-\w+-/g, '').replace(/vnd\\?\.\w+\\?\.\w+/g, '').replace(/https?:\/\/ns\.\w+\.com\/[\w./-]*\//g, ''));
        if (m) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${m[0]}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
