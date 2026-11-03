// @vitest-environment node
// Builds the published events handler and runs it in a context that has only the events worker's globals.
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'vite';
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { KEYS } from '../../src/lib/notify-out/model.js';

const RUNTIME_GLOBALS = ['console', 'fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File', 'URL', 'URLSearchParams', 'AbortController',
  'AbortSignal', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'CompressionStream', 'DecompressionStream',
  'crypto', 'Crypto', 'SubtleCrypto', 'performance', 'Event', 'EventTarget', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'structuredClone', 'queueMicrotask', 'atob', 'btoa'];
const SPACE = 'a1b2c3d4e5f6g7h8';
const BOB = '0f0e0d0c-0b0a-4000-8000-000000000b0b';

let source;
beforeAll(async () => {
  const output = await build({ configFile: fileURLToPath(new URL('../../worker-notify/vite.config.js', import.meta.url)), logLevel: 'silent', build: { write: false } });
  source = (Array.isArray(output) ? output[0] : output).output.find((chunk) => chunk.type === 'chunk').code;
}, 60_000);

describe('published handler source', () => {
  it('is one function expression under the 64 KB publish limit', () => {
    expect(source.startsWith('async ({ event, ctx, user, fetch }) => {')).toBe(true);
    expect(new TextEncoder().encode(source).length).toBeLessThan(64 * 1024);
    expect(() => new Function(`return (\n${source}\n);`)).not.toThrow();
  });
  it('names no ambient SDK or browser globals', () => {
    // Comments are skipped, as the platform's free-variable scan does.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/(?<![.\w$'"])(window|document|navigator|location|localStorage|sessionStorage|indexedDB|process|require|puter)(?![\w$:'"])/);
    expect(code).not.toMatch(/\bimport\s*\(|\bimport\s+[\w{*]/);
  });
  it('delivers from an isolated context with only the runtime globals', async () => {
    const sandbox = Object.fromEntries(RUNTIME_GLOBALS.filter((name) => name in globalThis).map((name) => [name, globalThis[name]]));
    const handler = vm.runInNewContext(`(\n${source}\n)`, vm.createContext(sandbox));
    const start = Date.UTC(2027, 4, 10, 12);
    const runtime = createFakePuter({ now: () => start });
    const user = runtime.client('alice');
    await user.kv.set(KEYS.prefs, { on: true, channels: { webhook: { on: true } } });
    await user.kv.set(KEYS.secret, { webhookUrl: 'https://hooks.example.org/in', webhookSecret: 's'.repeat(43) }, { disableSharing: true });
    await user.kv.set(`shared:${SPACE}:e:meta:meta`, { title: 'Lisbon' });
    const fetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const value = { rev: 1, at: start, by: BOB, ents: [], del: [], sum: [{ t: 'res', id: 'r1', op: 'put', name: 'Hotel', fields: [] }] };
    const result = await handler({ event: { op: 'set', value }, ctx: { v: 1, k: 'trip', u: 'alice', o: 'https://trips.puter.com', s: SPACE, w: 'trips-abcdefghij' }, user, fetch });
    expect(result.notes).toEqual([`c-${SPACE}-1`]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ type: 'trip.change', trip: { title: 'Lisbon' } });
  });
});
