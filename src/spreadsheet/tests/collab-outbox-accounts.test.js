import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { clearOutbox, memoryOutbox, outboxKey } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

async function setup() {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Budget' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Budget', file: null });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const join = async (user, store) => {
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token: user === owner ? undefined : token, store, poll: 50, noPeers: true });
    open.push(client);
    await client.open();
    return client;
  };
  const log = () => [...env.data.entries()].filter(([k]) => k.includes(':log:')).map(([, v]) => ({ user: v.username, changes: JSON.stringify(v.changes) }));
  return { env, room, join, log };
}

it("keeps each account's unsent changes apart: another account signed in on this browser never sends them", async () => {
  const { env, room, join, log } = await setup();
  const store = memoryOutbox(); // this browser's IndexedDB
  const alice = await join(owner, store);
  env.offline = true;
  alice.wb.setInput(alice.wb.sheets[0].id, 0, 0, 'alice private note');
  await until(() => alice.status.state === 'offline', 4000, 'offline');
  alice.close(); // the tab closed while offline
  expect((await store.get(outboxKey(owner.uuid, room))).user).toBe(owner.uuid);
  env.offline = false;
  const bob = await join(editor, store);
  bob.wb.setInput(bob.wb.sheets[0].id, 1, 0, 'bob');
  await until(() => !bob.replica.pending.length, 4000, 'delivery');
  expect(bob.wb.getValue(bob.wb.sheets[0].id, 0, 0)).toBe(null);
  expect(log().some((r) => r.changes.includes('alice private note'))).toBe(false);
  // Alice's changes still wait for her, and reach the room when she opens it again.
  expect(await store.get(outboxKey(owner.uuid, room))).not.toBe(null);
  const again = await join(owner, store);
  await until(() => !again.replica.pending.length, 4000, 'delivery');
  expect(log().find((r) => r.changes.includes('alice private note'))?.user).toBe('alice');
});

it("ignores a record kept under an account's key that names another account", async () => {
  const { room, join, log } = await setup();
  const store = memoryOutbox();
  const first = await join(owner, store);
  const s = first.wb.sheets[0].id;
  first.close();
  await store.put(outboxKey(editor.uuid, room), { room, user: owner.uuid, rev: 0, pending: [{ id: 'abcdefgh12345678', label: 'Edit', ops: [{ t: 'cells', s, v: { '0,0': { v: 'planted' } } }] }], at: Date.now() });
  const bob = await join(editor, store);
  expect(bob.replica.pending.length).toBe(0);
  expect(bob.wb.getValue(s, 0, 0)).toBe(null);
  expect(log()).toEqual([]);
});

it("signing out removes the account's unsent changes and any that name no account, and leaves other accounts'", async () => {
  const store = memoryOutbox();
  await store.put(outboxKey(owner.uuid, 'r1'), { room: 'r1', user: owner.uuid, pending: [] });
  await store.put(outboxKey(owner.uuid, 'r2'), { room: 'r2', user: owner.uuid, pending: [] });
  await store.put(outboxKey(editor.uuid, 'r1'), { room: 'r1', user: editor.uuid, pending: [] });
  await store.put('r3', { room: 'r3', pending: [] }); // kept before records named their account
  await clearOutbox(owner.uuid, store);
  expect((await store.all()).map((r) => r.user)).toEqual([editor.uuid]);
  await clearOutbox(null, store);
  expect(await store.all()).toEqual([]);
});
