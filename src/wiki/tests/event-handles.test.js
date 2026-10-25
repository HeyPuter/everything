import { beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fakePuter, alice, bob, cam } from './helpers/puter.js';
import { encode } from '../src/collab/protocol.js';
import { addPage } from '../src/data/tree.js';
import { grantEvents } from '../src/collab/consent.js';
import { DOCS } from '../worker/service.js';

const ROOM = 'room0000abcd';
beforeEach(() => DOCS.clear());

async function shared(refuse) {
  const env = fakePuter();
  const tree = new Y.Doc();
  addPage(tree, { title: 'Handbook' });
  const mints = [];
  const fetcher = async (_url, options) => {
    const { granteeUid } = JSON.parse(options.body);
    mints.push(granteeUid);
    if (refuse.code) return { ok: false, status: 403, json: async () => ({ code: refuse.code }) };
    return { ok: true, json: async () => ({ handle: `h-${granteeUid}` }) };
  };
  const call = (user, input) => env.service({ fetcher }).call(user, { room: ROOM, ...input });
  await call(alice, { op: 'create', docs: { tree: encode(Y.encodeStateAsUpdate(tree)) }, title: 'Handbook' });
  const { token } = await call(alice, { op: 'invite', role: 'editor' });
  return {
    mints,
    join: async (user) => (await call(user, { op: 'join', token })).events,
    events: async (user, extra = {}) => (await call(user, { op: 'events', ...extra })).events,
  };
}

// Without the account's consent every mint is refused, and every member asked again on each join, each spending
// the account's mint budget.
it('pauses minting for everyone after a refusal that holds for every member, until the account consents', async () => {
  const refuse = { code: 'events_kv_handle_not_delegated' };
  const { mints, join, events } = await shared(refuse);
  expect(await join(bob)).toBeNull();
  await join(cam);
  await events(bob);
  expect(mints).toEqual([bob.uuid]);
  refuse.code = null;
  await events(alice, { consented: true });
  expect(await events(cam)).toEqual({ handle: `h-${cam.uuid}`, key: 'signal' });
});

it('holds back only the member a refusal is about', async () => {
  const refuse = { code: 'recipient_not_accepting_shares' };
  const { mints, join, events } = await shared(refuse);
  await join(bob);
  await events(bob);
  expect(mints).toEqual([bob.uuid]);
  refuse.code = null;
  expect((await join(cam)).handle).toBe(`h-${cam.uuid}`);
});

it('asks only the account the server runs as, and tells the space once granted', async () => {
  const request = vi.fn(async () => true);
  const space = { ownerUuid: alice.uuid, eventDescriptor: { app: 'app-wiki', key: 'wk:r:ev:signal' }, request: vi.fn(async () => ({})) };
  const puter = { appID: 'app-wiki', perms: { request } };
  expect(await grantEvents(puter, space)).toBe(true);
  expect(request).toHaveBeenCalledWith('permission', { permission: `manage:kv-share:${alice.uuid}:app-wiki:wk` });
  expect(space.request).toHaveBeenCalledWith('events', { consented: true });
  puter.perms.Resource = { KV_SHARE: 'kvShare' };
  await grantEvents(puter, space);
  expect(request).toHaveBeenLastCalledWith('kvShare', { prefix: 'wk:', access: 'watch' });
  // A manager who is not that account gets a handle, not the app's own subject, and is never asked.
  request.mockClear();
  expect(await grantEvents(puter, { ...space, eventDescriptor: { handle: 'h', key: 'signal' } })).toBe(false);
  expect(await grantEvents({ ...puter, appID: 'app-other' }, space)).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
