// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseBanner } from '../../src/lib/deploy.js';
import { fetchHealth } from '../../src/lib/api.js';
import { ORIGIN, WORKER, createHarness, id } from './harness.js';

async function bundle() {
  const { build } = await import('vite');
  process.env.TRIPS_BUILD = 'build42';
  process.env.TRIPS_BUILT_AT = '1790000000000';
  try {
    const result = await build({ configFile: fileURLToPath(new URL('../../vite.worker.config.js', import.meta.url)), logLevel: 'silent', build: { write: false } });
    return (Array.isArray(result) ? result[0] : result).output.find((output) => output.type === 'chunk').code;
  } finally {
    delete process.env.TRIPS_BUILD;
    delete process.env.TRIPS_BUILT_AT;
  }
}

describe('built worker bundle', () => {
  it('starts with the build banner and runs in the fake runtime with lexical router and me', async () => {
    const source = await bundle();
    expect(source.split('\n')[0]).toBe('/*! trips-worker build=build42 at=1790000000000 protocol=1 */');
    const banner = parseBanner(source);
    expect(banner).toEqual({ build: 'build42', builtAt: 1_790_000_000_000, protocol: 1 });
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\(/);
    const h = await createHarness({ source });
    const bob = await h.client('bob');
    const health = await bob.puter.workers.exec(`${ORIGIN}/health`, { headers: { 'x-puter-no-auth': '1' } });
    expect(await health.json()).toEqual({ ok: true, build: 'build42', builtAt: 1_790_000_000_000, protocol: 1 });
    // The deployer compares the parsed banner with /health exactly.
    expect(await fetchHealth(bob.puter, WORKER)).toMatchObject({ build: banner.build, builtAt: banner.builtAt, protocol: banner.protocol });
    const space = await h.team({ bob: 'editor' });
    const result = await bob.in(space).call('commit', { ops: [{ opId: id('o'), t: 'place', id: id('p'), put: { name: 'Bundled' } }] });
    expect(result.rev).toBe(3);
    expect(globalThis.router).toBeUndefined();
  }, 30_000);
});
