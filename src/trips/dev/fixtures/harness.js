// Loads the big-trip fixture into the worker test harness (tests/worker/harness.js).
import { webcrypto } from 'node:crypto';
import { createCredentialManager } from '../../src/lib/cred.js';
import { createWorkerClient } from '../../src/lib/api.js';
import { USERS, WORKER, memoryDb } from '../../tests/worker/harness.js';
import { FIXTURE_MEMBERS, largeTrip, seedLargeTrip } from './large-trip.js';

/** Signed worker callers for the six fixture members; erin and frank are added to the harness world. */
export async function fixtureCallers(h) {
  const known = new Set(Object.values(USERS).map((user) => user.uuid));
  const callers = {};
  const clients = {};
  for (const member of FIXTURE_MEMBERS) {
    if (!known.has(member.uuid)) h.world.user(member);
    const puter = h.world.client(member.uuid);
    const credentials = await createCredentialManager({ puter, db: memoryDb(member.uuid), crypto: webcrypto, now: h.now });
    const api = createWorkerClient({ puter, credentials, timeout: 60_000 });
    clients[member.username] = { uuid: member.uuid, puter, api };
    callers[member.username] = (op, input = {}) => api.request(WORKER, JSON.stringify({ op, ...input }));
  }
  return { callers, clients };
}

/** Seeds the fixture into a harness whose worker belongs to alice. Returns `{space, rev, fixture, callers, clients}`. */
export async function loadLargeTrip(h, { fixture = largeTrip(), onProgress } = {}) {
  const { callers, clients } = await fixtureCallers(h);
  const owner = h.world.client(FIXTURE_MEMBERS[0].uuid);
  const { space, rev } = await seedLargeTrip({ callers, fixture, onProgress, writeOwnerKv: (items) => owner.kv.set(items) });
  await h.settle();
  return { space, rev, fixture, callers, clients };
}
