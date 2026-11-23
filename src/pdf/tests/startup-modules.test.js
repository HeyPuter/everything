import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_FILE_SIZE, MAX_IMAGE_SIZE, safeName } from '../src/core/file-limits.js';
import * as document from '../src/core/document.js';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** Every module the app evaluates before its first dynamic import(): the static import graph. */
function staticGraph(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.endsWith('.js')) return;
    const code = readFileSync(file, 'utf8');
    for (const [, spec] of code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gms)) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      else seen.add(spec);
    }
    for (const [, spec] of code.matchAll(/^import\s+'([^']+)'/gm))
      if (spec.startsWith('.')) seen.add(resolve(dirname(file), spec));
  };
  visit(entry);
  return [...seen].map((file) => (file.startsWith(src) ? file.slice(src.length + 1) : file));
}

describe('app startup', () => {
  it('loads neither pdf-lib nor the editor before a PDF is opened', () => {
    const graph = staticGraph(resolve(src, 'main.js'));
    expect(graph).toContain('core/file-limits.js');
    expect(graph).not.toContain('core/document.js');
    expect(graph).not.toContain('editor.js');
    expect(graph.filter((spec) => /^(pdf-lib|pdfjs-dist|@pdf-lib)/.test(spec))).toEqual([]);
  });
  it('keeps the limits and the file-name rule document.js has always exported', () => {
    expect(document.MAX_FILE_SIZE).toBe(MAX_FILE_SIZE);
    expect(document.MAX_IMAGE_SIZE).toBe(MAX_IMAGE_SIZE);
    expect(document.safeName).toBe(safeName);
    expect(safeName('a/b.pdf')).toBe('a b.pdf');
  });
});
