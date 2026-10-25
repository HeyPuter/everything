import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { editor, environment, owner, SERVER, viewer } from './collab-helpers.js';

const HOUR = 3_600_000;

async function shared() {
  const env = environment();
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb: new Workbook({ sheets: [{ name: 'Plan' }] }), name: 'Plan' });
  for (const [user, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
    await env.service.call(owner, { op: 'invite-user', room, username: user.username, role });
    await env.service.call(user, { op: 'join', room });
  }
  const orphan = (handle, age = HOUR) => env.minted.set(handle, { prefix: `ss:${room}:ev:`, createdAt: Math.floor((env.now - age) / 1000), revokedAt: null });
  const look = async (at = room) => { await env.kv.del('ss:~sweep-due'); await env.service.call(owner, { op: 'join', room: at }); };
  return { env, room, orphan, look };
}

// Removals used to forget a handle without revoking it, so Puter kept handles no record names, each holding one of
// the owner's limited handle slots for good.
it('revokes handles no member record names, but not one minted moments ago', async () => {
  const { env, orphan, look } = await shared();
  env.now += HOUR;
  orphan('handle-forgotten');
  orphan('handle-new', 60_000);
  await look();
  expect(env.revoked).toEqual(['handle-forgotten']);
});

it("revokes an expired member's handle and forgets it, and keeps everyone else's", async () => {
  const { env, room, look } = await shared();
  await env.service.call(owner, { op: 'role', room, uuid: viewer.uuid, expires: env.now + 1000 });
  env.now += HOUR;
  await look();
  expect(env.revoked).toEqual([`handle-${viewer.uuid}`]);
  expect(await env.kv.get(`ss:${room}:handle:${viewer.uuid}`)).toBeNull();
  expect(await env.kv.get(`ss:${room}:handle:${editor.uuid}`)).toBe(`handle-${editor.uuid}`);
});

it('revokes what a closed room left behind', async () => {
  const { env, room, look } = await shared();
  await env.kv.set(`ss:${room}:meta`, { ...(await env.kv.get(`ss:${room}:meta`)), closed: env.now });
  const other = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb: new Workbook({ sheets: [{ name: 'Other' }] }), name: 'Other' });
  env.now += HOUR;
  await look(other);
  expect(env.revoked.sort()).toEqual([`handle-${editor.uuid}`, `handle-${viewer.uuid}`].sort());
});

it('looks at most every few hours, a few pages at a time, carrying on where it stopped', async () => {
  const { env, room, orphan, look } = await shared();
  env.now += HOUR;
  for (let i = 0; i < 12; i++) orphan(`handle-old-${i}`);
  await env.service.call(owner, { op: 'join', room });
  const first = env.revoked.length;
  expect(first).toBeGreaterThan(0);
  await env.service.call(owner, { op: 'join', room });
  expect(env.revoked).toHaveLength(first);
  await look();
  expect(env.revoked.filter((h) => h.startsWith('handle-old-')).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `handle-old-${i}`).sort());
  expect(env.minted.get(`handle-${editor.uuid}`).revokedAt).toBeNull();
});

it('never looks for a member, only for the owner', async () => {
  const { env, room, orphan } = await shared();
  env.now += HOUR;
  orphan('handle-forgotten');
  await env.kv.del('ss:~sweep-due');
  await env.service.call(editor, { op: 'join', room });
  expect(env.listings).toBe(0);
});
