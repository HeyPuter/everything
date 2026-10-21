import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

// A change the room refused because its author may only view now was followed by a synchronization, awaited inside the
// sending it waited behind: neither could finish. The browser never synchronized again, so it never learned that it
// could only view, and never showed anyone else's changes, while it said nothing was wrong.
it('goes on receiving the others\' changes after the room refuses a change made just as the owner made this person a viewer', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const join = async (user, invite) => {
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token: invite, store: memoryOutbox(), poll: 50, noPeers: true });
    open.push(client);
    await client.open();
    return client;
  };
  const bob = await join(editor, token);
  const alice = await join(owner);
  const s = alice.wb.sheets[0].id;
  await call(env.sdk(owner), SERVER, { op: 'role', room, uuid: editor.uuid, role: 'viewer' });
  const refused = [];
  bob.addEventListener('refused', (e) => refused.push(e.detail.message));
  bob.wb.setInput(s, 0, 0, 'typed as the role changed'); // before bob's browser has heard of it
  await until(() => refused.length, 4000, 'the refusal');
  expect(bob.wb.getValue(s, 0, 0)).toBe(null);
  await until(() => bob.role === 'viewer', 4000, 'the new role');
  alice.wb.setInput(s, 2, 2, 'from alice');
  await until(() => bob.wb.getValue(s, 2, 2) === 'from alice', 4000, 'alice\'s change');
});
