import { expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { editor, environment, owner, SERVER, viewer } from './collab-helpers.js';

async function shared() {
  const env = environment();
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb: new Workbook({ sheets: [{ name: 'Plan' }] }), name: 'Plan' });
  for (const [user, role] of [[editor, 'editor'], [viewer, 'viewer']]) await env.service.call(owner, { op: 'invite-user', room, username: user.username, role });
  return { env, room };
}

// Removing someone only forgot their handle: Puter kept it live, so they went on hearing of every change, and it
// held one of the owner's limited handle slots for good.
it('takes back a removed member\'s handle at Puter', async () => {
  const { env, room } = await shared();
  expect((await env.service.call(editor, { op: 'join', room })).events).toEqual({ handle: `handle-${editor.uuid}`, key: 'signal' });
  await env.service.call(owner, { op: 'role', room, uuid: editor.uuid, role: 'removed' });
  expect(env.revoked).toEqual([`handle-${editor.uuid}`]);
  expect(await env.kv.get(`ss:${room}:handle:${editor.uuid}`)).toBeNull();
});

it('takes back every handle when the owner stops sharing', async () => {
  const { env, room } = await shared();
  await env.service.call(editor, { op: 'join', room });
  await env.service.call(viewer, { op: 'join', room });
  await env.service.call(owner, { op: 'stop', room });
  expect(env.revoked.sort()).toEqual([`handle-${editor.uuid}`, `handle-${viewer.uuid}`].sort());
});

// Without the owner's consent every mint is refused, and every member's every join asked again, each spending the
// owner's mint budget.
it('stops minting for everyone after a refusal that holds for every member, until the owner consents', async () => {
  const { env, room } = await shared();
  env.refuse = 'events_kv_handle_not_delegated';
  expect((await env.service.call(editor, { op: 'join', room })).events).toBeNull();
  await env.service.call(viewer, { op: 'join', room });
  await env.service.call(editor, { op: 'events', room });
  expect(env.mints).toEqual([editor.uuid]);
  env.refuse = null;
  await env.service.call(owner, { op: 'events', room, consented: true });
  expect((await env.service.call(viewer, { op: 'events', room })).events.handle).toBe(`handle-${viewer.uuid}`);
});

it('holds back only the member a refusal is about', async () => {
  const { env, room } = await shared();
  env.refuse = 'recipient_not_accepting_shares';
  await env.service.call(editor, { op: 'join', room });
  await env.service.call(editor, { op: 'events', room });
  expect(env.mints).toEqual([editor.uuid]);
  env.refuse = null;
  expect((await env.service.call(viewer, { op: 'join', room })).events.handle).toBe(`handle-${viewer.uuid}`);
});

// Nothing ever asked the owner for this consent, so the people they shared with never got live updates.
it('asks the owner for the consent when they invite someone, and tells the room', async () => {
  const { env, room } = await shared();
  const sdk = env.sdk(owner);
  const request = vi.fn(async () => true);
  Object.assign(sdk, { appID: 'app-sheet', perms: { request } });
  const client = new RoomClient({ puter: sdk, server: SERVER, room, store: memoryOutbox(), noPeers: true });
  await client.open();
  try {
    expect(await client.allowLiveUpdates()).toBe(true);
    expect(request).toHaveBeenCalledWith('permission', { permission: `manage:kv-share:${owner.uuid}:app-sheet:ss` });
    expect(env.calls.at(-1)).toMatchObject({ op: 'events', consented: true });
    sdk.perms.Resource = { KV_SHARE: 'kvShare' };
    await client.allowLiveUpdates();
    expect(request).toHaveBeenLastCalledWith('kvShare', { prefix: 'ss:', access: 'watch' });
  } finally { client.close(); }
});

it('does not ask from a page running as another app, or for a member', async () => {
  const { env, room } = await shared();
  const request = vi.fn(async () => true);
  const other = Object.assign(env.sdk(owner), { appID: 'app-other', perms: { request } });
  const member = Object.assign(env.sdk(editor), { appID: 'app-sheet', perms: { request } });
  const clients = [other, member].map((puter) => new RoomClient({ puter, server: SERVER, room, store: memoryOutbox(), noPeers: true }));
  try {
    for (const c of clients) { await c.open(); expect(await c.allowLiveUpdates()).toBe(false); }
    expect(request).not.toHaveBeenCalled();
  } finally { for (const c of clients) c.close(); }
});
