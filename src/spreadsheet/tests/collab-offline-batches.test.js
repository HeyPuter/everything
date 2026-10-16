import { afterEach, describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { MAX_BATCH, MAX_CHANGE } from '../src/collab/ops.js';
import { environment, owner, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

async function setup() {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Data', file: null });
  const join = async () => {
    const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 50, noPeers: true });
    open.push(client);
    await client.open();
    return client;
  };
  const commits = () => env.calls.filter((c) => c.op === 'commit');
  return { env, join, commits };
}

/** Edits made while offline, then the connection comes back. */
async function offline(env, client, edit) {
  env.offline = true;
  edit();
  await until(() => client.status.state === 'offline', 4000, 'offline');
  env.offline = false;
  await client.flush();
  await client.settled();
}

describe('sending a long spell of offline edits', () => {
  it('delivers more edits than one commit carries, in several commits', async () => {
    const { env, join, commits } = await setup();
    const a = await join();
    const refused = [];
    a.addEventListener('refused', (e) => refused.push(e.detail.message));
    const s = a.wb.sheets[0].id;
    await offline(env, a, () => { for (let r = 0; r < 1100; r++) a.wb.setInput(s, r, 0, `row ${r}`); });
    expect(refused).toEqual([]);
    expect(a.replica.pending.length).toBe(0);
    const sent = commits().filter((c) => c.changes.length);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.every((c) => c.changes.length <= MAX_BATCH)).toBe(true);
    const b = await join();
    expect(b.wb.getValue(s, 0, 0)).toBe('row 0');
    expect(b.wb.getValue(s, 1099, 0)).toBe('row 1099');
  });

  it('keeps each commit within the size the room accepts', async () => {
    const { env, join, commits } = await setup();
    const a = await join();
    const refused = [];
    a.addEventListener('refused', (e) => refused.push(e.detail.message));
    const s = a.wb.sheets[0].id;
    const text = 'x'.repeat(200);
    // Three pastes of about 1.6 million characters each: together over the limit, each well under it.
    await offline(env, a, () => {
      for (let k = 0; k < 3; k++) a.wb.setCells(s, Array.from({ length: 7000 }, (_, r) => ({ r, c: k, cell: { v: `${text}${r}` } })), 'Paste');
    });
    expect(refused).toEqual([]);
    expect(a.replica.pending.length).toBe(0);
    const sent = commits().filter((c) => c.changes.length);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.every((c) => JSON.stringify(c.changes).length <= MAX_CHANGE)).toBe(true);
    const b = await join();
    expect(b.wb.getValue(s, 6999, 2)).toBe(`${text}6999`);
  });

  it('still delivers the edits made before one the room refuses', async () => {
    const { env, join } = await setup();
    const a = await join();
    // The room refuses any commit holding this one edit (as it would a malformed change).
    const commit = env.service.commit.bind(env.service);
    env.service.commit = (room, meta, user, member, input) => (JSON.stringify(input.changes).includes('refuse me')
      ? Promise.reject(Object.assign(new Error('Invalid change.'), { status: 400 }))
      : commit(room, meta, user, member, input));
    const refused = [];
    a.addEventListener('refused', (e) => refused.push(e.detail.message));
    const s = a.wb.sheets[0].id;
    await offline(env, a, () => {
      for (let r = 0; r < 600; r++) a.wb.setInput(s, r, 0, r === 450 ? 'refuse me' : `row ${r}`);
    });
    expect(refused).toEqual(['Invalid change.']);
    expect(a.replica.pending.length).toBe(0);
    const b = await join();
    expect(b.wb.getValue(s, 0, 0)).toBe('row 0');
    expect(b.wb.getValue(s, 449, 0)).toBe('row 449');
    expect(b.wb.getValue(s, 450, 0)).toBe(null);
    // This browser shows the room's state.
    expect(a.wb.getValue(s, 449, 0)).toBe('row 449');
    expect(a.wb.getValue(s, 450, 0)).toBe(null);
  });
});
