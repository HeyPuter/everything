import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { environment, owner, editor, SERVER, until, wait } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

async function joined() {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const client = new RoomClient({ puter: env.sdk(editor), server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true });
  open.push(client);
  await client.open();
  return { env, room, client };
}

it('says once that the owner stopped sharing, and stops asking the room', async () => {
  const { env, room, client } = await joined();
  const notices = [];
  client.addEventListener('closed', (e) => notices.push(e.detail.message));
  await call(env.sdk(owner), SERVER, { op: 'stop', room });
  await until(() => notices.length, 4000, 'the notice');
  const asked = env.calls.filter((c) => c.user === editor.uuid).length;
  await wait(600); // a dozen polls at this client's pace
  expect(notices).toEqual(['The owner stopped sharing this workbook.']);
  expect(env.calls.filter((c) => c.user === editor.uuid).length).toBe(asked);
  expect(client.status.state).toBe('error');
});

it('says once that this person was removed', async () => {
  const { env, room, client } = await joined();
  const notices = [];
  client.addEventListener('closed', (e) => notices.push(e.detail.message));
  await call(env.sdk(owner), SERVER, { op: 'role', room, uuid: editor.uuid, role: 'removed' });
  await until(() => notices.length, 4000, 'the notice');
  await wait(600);
  expect(notices).toHaveLength(1);
});
