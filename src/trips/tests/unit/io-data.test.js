// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { newId } from '../../src/shared/ids.js';
import { exportAllData } from '../../src/lib/io/data-export.js';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('download all my data', () => {
  it('zips owned spaces, own private items and indexed personal keys', async () => {
    const trip = newId(); const other = newId(); const fileId = newId(); const failing = newId();
    const kv = new Map([
      ['me:prefs', { theme: 'dark' }],
      ['me:spaces', [{ ref: { w: 'trips-abcdefghij', s: trip, k: 'trip' }, role: 'owner', title: 'Rome' }, { ref: { w: 'trips-zzzzzzzzzz', s: other, k: 'trip' }, role: 'editor', title: 'Bob trip' }]],
      [`me:priv:${trip}:pack`, { x: { id: 'x', name: 'Passport', order: 'a', upd: 1 } }],
      [`me:priv:${other}:exp`, { y: { id: 'y', name: 'Snack', amount: 100, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: ME }] }, upd: 1 } }],
      ['me:cred:device1', { secret: true }],
    ]);
    const puter = { kv: { get: async (key) => kv.get(key) } };
    const calls = [];
    const api = {
      async request(worker, body) {
        const input = JSON.parse(body);
        calls.push(input.op);
        if (input.op === 'space.list') return { ok: true, spaces: [{ id: trip, kind: 'trip' }, { id: failing, kind: 'trip' }] };
        if (input.space === failing) throw Object.assign(new Error('space_too_large'), { status: 413, code: 'space_too_large' });
        return { format: 'trips-export', version: 1, space: trip, rev: 3, kind: 'trip', tombstones: [],
          ents: [{ t: 'meta', id: 'meta', title: 'Rome', currency: 'EUR' }, { t: 'place', id: newId(), name: 'Forum', tags: { [ME]: ['mine'], [BOB]: ['private to bob'] } },
            { t: 'file', id: fileId, name: 'ticket.pdf', mime: 'application/pdf', size: 3, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied' } }],
          members: [{ uuid: ME, role: 'owner', username: 'alice' }, { uuid: BOB, role: 'editor', username: 'bob' }] };
      },
      async download() { return new Blob([new Uint8Array([1, 2, 3])]); },
    };
    const stages = new Set();
    const { blob, name, summary } = await exportAllData({ puter, api, worker: 'trips-abcdefghij', account: { uuid: ME, username: 'alice' }, includeFiles: true, readme: 'Hello',
      onProgress: ({ stage }) => stages.add(stage), now: new Date(2026, 5, 1) });
    expect(name).toBe('trips-data-2026-06-01.zip');
    expect(summary).toMatchObject({ spaces: 1, files: 1, failed: [{ space: failing, code: 'space_too_large' }] });
    expect([...stages]).toEqual(['personal', 'spaces', 'files', 'zip']);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const names = Object.keys(files).sort();
    expect(names).toEqual(['README.txt', 'personal.json', `spaces/trip-rome-${trip}/files/${fileId}-ticket.pdf`, `spaces/trip-rome-${trip}/trip.json`]);
    const personal = JSON.parse(strFromU8(files['personal.json']));
    expect(Object.keys(personal.keys)).toEqual(expect.arrayContaining(['me:prefs', 'me:spaces', `me:priv:${trip}:pack`, `me:priv:${other}:exp`]));
    expect(personal.keys).not.toHaveProperty('me:cred:device1');
    const space = JSON.parse(strFromU8(files[`spaces/trip-rome-${trip}/trip.json`]));
    expect(space).toMatchObject({ format: 'trips-space', exportedBy: ME, private: { pack: [{ name: 'Passport' }] } });
    expect(JSON.stringify(space)).not.toContain('private to bob');
    expect(calls).toEqual(['space.list', 'space.export', 'space.export']);
  });

  it('exports personal data alone without a worker', async () => {
    const puter = { kv: { get: async (key) => (key === 'me:prefs' ? { theme: 'light' } : undefined) } };
    const { blob, summary } = await exportAllData({ puter, account: { uuid: ME } });
    expect(summary.spacesIncluded).toBe(false);
    expect(Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer())))).toEqual(['personal.json']);
  });
});
