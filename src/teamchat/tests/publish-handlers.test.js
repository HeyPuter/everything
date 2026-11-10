import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../handlers/due.js', import.meta.url), 'utf8');
const hash = createHash('sha256').update(source).digest('hex');
const name = 'teamchat-due-v1';

function publish(existingHash, replace = false) {
  const script = `
    const calls = [];
    if (${replace}) process.argv.push('--replace');
    globalThis.fetch = async (url, options = {}) => {
      if (url.includes('/list?')) return { ok: true, json: async () => ({ handlers: [{ name: ${JSON.stringify(name)}, hash: ${JSON.stringify(existingHash)} }] }) };
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ hash: 'published', resumed: 1 }) };
    };
    process.on('beforeExit', () => console.log(JSON.stringify(calls)));
    await import(${JSON.stringify(new URL('../scripts/publish-handlers.mjs', import.meta.url).href)});
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PUTER_TOKEN: 'test-token', PUTER_APP_UID: 'test-app', PUTER_API_ORIGIN: 'https://test.invalid' },
    encoding: 'utf8',
  });
  return JSON.parse(output.trim().split('\n').at(-1));
}

describe('publishing the due handler', () => {
  it('skips unchanged source by default', () => {
    expect(publish(hash)).toEqual([]);
  });

  it('republishes unchanged source with --replace to resume suspended schedules', () => {
    expect(publish(hash, true)).toEqual([{ appUid: 'test-app', name, source, replace: true }]);
  });

  it('uses the existing hash when publishing changed source without --replace', () => {
    expect(publish('old')).toEqual([{ appUid: 'test-app', name, source, ifHash: 'old' }]);
  });
});
