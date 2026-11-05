import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const names = ['mail-notify-v1', 'mail-snooze-v1'];
const sources = ['notify-handler.js', 'snooze-handler.js'].map((name) =>
  readFileSync(resolve('src/workers', name), 'utf8'));
const hashes = sources.map((source) => createHash('sha256').update(source).digest('hex'));
const publish = (handlers) => {
  const script = `const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      if (url.includes('/list?')) return { ok: true, json: async () => ({ handlers: ${JSON.stringify(handlers)} }) };
      const body = JSON.parse(options.body);
      calls.push({ name: body.name, ifHash: body.ifHash, source: typeof body.source });
      return { ok: true, json: async () => ({ hash: 'published-hash' }) };
    };
    process.on('beforeExit', () => console.log(JSON.stringify(calls)));
    await import(${JSON.stringify(pathToFileURL(resolve('scripts/publish-notify-handler.mjs')).href)});`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PUTER_TOKEN: 'test-token', PUTER_APP_UID: 'test-app', PUTER_API_ORIGIN: 'https://test.invalid' },
    encoding: 'utf8',
  });
  return JSON.parse(output.trim().split('\n').at(-1));
};

describe('publishing the two app handlers', () => {
  it('publishes both self-contained sources', () => {
    expect(publish([])).toEqual(names.map((name) => ({ name, source: 'string' })));
  });

  it('skips each matching hash independently', () => {
    expect(publish([{ name: names[0], hash: hashes[0] }, { name: names[1], hash: 'old' }]))
      .toEqual([{ name: names[1], ifHash: 'old', source: 'string' }]);
  });

  it('makes no writes when both hashes match', () => {
    expect(publish(names.map((name, i) => ({ name, hash: hashes[i] })))).toEqual([]);
  });
});
