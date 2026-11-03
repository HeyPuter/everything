// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOMAIN_OPS } from '../../src/shared/protocol.js';
import { schemas } from '../../src/shared/schema/index.js';
import { domainOps, typeHooks } from '../../worker/ops/index.js';

const root = new URL('../../', import.meta.url).pathname;
const files = readdirSync(join(root, 'worker'), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => relative(root, join(entry.parentPath, entry.name)));
const read = (path) => readFileSync(join(root, path), 'utf8');

describe('worker guards (PLAN §1, §8)', () => {
  it('lists KV only in the scan module', () => {
    expect(files.filter((path) => path !== 'worker/engine/scan.js' && path !== 'worker/engine/store.js' && /\.list\s*\(/.test(read(path)))).toEqual([]);
  });
  it('keeps KV call shapes in the store adapter', () => {
    expect(files.filter((path) => path !== 'worker/engine/store.js' && /\.puter\.kv\s*\./.test(read(path)))).toEqual([]);
  });
  it('never calls workers.exec and never builds HTML', () => {
    // The link-preview op reads (never serves) HTML pages.
    expect(files.filter((path) => /workers\s*\.\s*exec|innerHTML/i.test(read(path)) || (path !== 'worker/ops/trip/unfurl.js' && /text\/html/i.test(read(path))))).toEqual([]);
  });
  it('registers exactly the domain ops the shared protocol lists, and type hooks for real types', () => {
    expect([...DOMAIN_OPS].sort()).toEqual(Object.keys(domainOps).sort());
    for (const def of Object.values(domainOps)) for (const key of ['kinds', 'validate', 'reads', 'plan']) expect(def).toHaveProperty(key);
    for (const key of Object.keys(typeHooks)) {
      const [kind, type] = key.split('/');
      expect(Object.hasOwn(schemas, kind) && Object.hasOwn(schemas[kind], type)).toBe(true);
    }
  });
});
