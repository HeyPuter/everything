import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// Modules reachable from src/main.ts through static imports end up in the
// startup chunk (docs/performance.md). Modules that only open on demand must
// not be pulled in by a static import from a startup module.
const root = join(__dirname, '..');
function resolve(from: string, spec: string) {
  const base = join(dirname(from), spec);
  for (const file of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(file) && file.endsWith('.ts')) return file;
  return undefined;
}
function startupModules() {
  const seen = new Set<string>();
  const queue = [join(root, 'src/main.ts')];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    // Static value imports and re-exports; `import type` and import() are not loaded with the chunk.
    for (const m of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm)) {
      const next = resolve(file, m[1]);
      if (next) queue.push(next);
    }
  }
  return new Set([...seen].map((f) => relative(root, f)));
}

describe('startup chunk', () => {
  const modules = startupModules();
  it('follows the static import graph', () => {
    expect(modules.has('src/editor.ts')).toBe(true);
    expect(modules.has('src/features/files/start-screen.ts')).toBe(true);
  });
  it('leaves the New Document window to load on demand', () => {
    expect(modules.has('src/features/files/new-document.ts')).toBe(false);
  });
});
