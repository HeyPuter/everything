// The room worker's handles on each room's change signal: minting, backing off after a refusal, and taking them back.
import { afterEach, expect, it, vi } from 'vitest';
import { call } from '../src/collab/api';
import { editor, environment, owner, viewer } from './collab-helpers';
import { closeAll, connect, SERVER, share } from './collab-session-helpers';

afterEach(closeAll);

async function shared() {
  const env = environment();
  const { room } = await share(env);
  for (const [user, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) await env.service.call(owner, { op: 'invite-user', room, username: user.username, role });
  const join = async (user: typeof editor) => (await env.service.call(user, { op: 'join', room })) as { events: { handle?: string } | null };
  return { env, room, join };
}

// Removing someone only forgot their handle: Puter kept it live, so they went on hearing of every change, and it
// held one of the owner's limited handle slots for good.
it("takes back a removed member's handle at Puter", async () => {
  const { env, room, join } = await shared();
  expect((await join(editor)).events).toEqual({ handle: `handle-${editor.uuid}`, key: 'signal' });
  await env.service.call(owner, { op: 'role', room, uuid: editor.uuid, role: 'removed' });
  expect(env.revoked).toEqual([`handle-${editor.uuid}`]);
  expect(await env.kv.get(`ps:${room}:handle:${editor.uuid}`)).toBeNull();
});

it('takes back every handle when the owner stops sharing', async () => {
  const { env, room, join } = await shared();
  await join(editor);
  await join(viewer);
  await env.service.call(owner, { op: 'stop', room });
  expect(env.revoked.sort()).toEqual([`handle-${editor.uuid}`, `handle-${viewer.uuid}`].sort());
});

// Without the owner's consent every mint is refused, and every member's every join asked again, each spending the
// owner's mint budget.
it('stops minting for everyone after a refusal that holds for every member, until the owner consents', async () => {
  const { env, room, join } = await shared();
  env.refuse = 'events_kv_handle_not_delegated';
  expect((await join(editor)).events).toBeNull();
  await join(viewer);
  await env.service.call(editor, { op: 'events', room });
  expect(env.mints).toEqual([editor.uuid]);
  env.refuse = null;
  await env.service.call(owner, { op: 'events', room, consented: true });
  expect((await join(viewer)).events?.handle).toBe(`handle-${viewer.uuid}`);
});

it('holds back only the member a refusal is about', async () => {
  const { env, room, join } = await shared();
  env.refuse = 'recipient_not_accepting_shares';
  await join(editor);
  await env.service.call(editor, { op: 'events', room });
  expect(env.mints).toEqual([editor.uuid]);
  env.refuse = null;
  expect((await join(viewer)).events?.handle).toBe(`handle-${viewer.uuid}`);
});

// Nothing ever asked the owner for this consent, so the people they shared with never got live updates.
it('asks the owner for the consent and tells the room', async () => {
  const { env, room } = await shared();
  const request = vi.fn(async () => true);
  const sdk = env.sdk;
  env.sdk = (user) => Object.assign(sdk(user), { appID: 'app-photo', perms: { request } });
  const a = await connect(env, owner, room);
  expect(await a.client.allowLiveUpdates()).toBe(true);
  expect(request).toHaveBeenCalledWith('permission', { permission: `manage:kv-share:${owner.uuid}:app-photo:ps` });
  expect(env.calls.at(-1)).toMatchObject({ op: 'events', consented: true });
  const b = await connect(env, editor, room);
  expect(await b.client.allowLiveUpdates()).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
  expect(await call(env.sdk(editor), SERVER, { op: 'events', room })).toEqual({ events: { handle: `handle-${editor.uuid}`, key: 'signal' } });
});

it('uses the kvShare resource where the SDK has it, and never asks from a page running as another app', async () => {
  const { env, room } = await shared();
  const request = vi.fn(async () => true);
  const sdk = env.sdk;
  env.sdk = (user) => Object.assign(sdk(user), { appID: 'app-photo', perms: { request, Resource: { KV_SHARE: 'kvShare' } } });
  const a = await connect(env, owner, room);
  await a.client.allowLiveUpdates();
  expect(request).toHaveBeenCalledWith('kvShare', { prefix: 'ps:', access: 'watch' });
  env.sdk = (user) => Object.assign(sdk(user), { appID: 'app-other', perms: { request } });
  const other = await connect(env, owner, room);
  expect(await other.client.allowLiveUpdates()).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});
