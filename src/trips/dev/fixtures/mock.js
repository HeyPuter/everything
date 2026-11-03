// `mock.html?fixture=large`: seeds the big-trip fixture into the in-page fake world before the app boots, through the
// real deployer and each member's own signed client.
import { createWorkerClient } from '../../src/lib/api.js';
import { createCredentialManager } from '../../src/lib/cred.js';
import { createDeployer } from '../../src/lib/deploy.js';
import { openDatabase } from '../../src/lib/idb.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { FIXTURE_MEMBERS, largeTrip, seedLargeTrip } from './large-trip.js';

function memoryDb(account) {
  const map = new Map();
  return {
    account,
    async get(key) { return structuredClone(map.get(key)); },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async remove(key) { map.delete(key); },
    async update(key, change) { const value = change(structuredClone(map.get(key))); if (value === undefined) map.delete(key); else map.set(key, structuredClone(value)); return value; },
    close() {},
  };
}

/** Extra fake users for the fixture's six members (alice, bob and carol already exist in the mock world). */
export const fixtureUsers = (verified) => FIXTURE_MEMBERS.slice(3).map((member) => ({ ...member, verified }));

/** Returns `{ref, rev, ms, fixture, callers}`; the owner is the first fixture member (alice). */
export async function loadMockFixture(world) {
  const started = performance.now();
  const owner = FIXTURE_MEMBERS[0];
  const ownerPuter = world.client(owner.uuid);
  const { worker } = await createDeployer({ puter: ownerPuter }).ensure();
  // The owner allows `kvShare` at the first invite, so the worker can mint member handles.
  await ownerPuter.perms.request('kvShare', { prefix: 'shared:', access: 'write' });
  const callers = {};
  for (const member of FIXTURE_MEMBERS) {
    const puter = member === owner ? ownerPuter : world.client(member.uuid);
    const credentials = await createCredentialManager({ puter, db: memoryDb(member.uuid) });
    const api = createWorkerClient({ puter, credentials, timeout: 60_000 });
    callers[member.username] = (op, input = {}) => api.request(worker.name, JSON.stringify({ op, ...input }));
  }
  const fixture = largeTrip();
  const { space, rev } = await seedLargeTrip({ callers, fixture, writeOwnerKv: (items) => ownerPuter.kv.set(items) });
  const ref = { w: worker.name, s: space, k: 'trip' };
  const db = await openDatabase(owner.uuid);
  try { await createPersonalStore({ puter: ownerPuter, db }).spaces.upsert({ ref, role: 'owner', title: fixture.meta.title }); }
  finally { db.close(); }
  return { ref, rev, ms: Math.round(performance.now() - started), fixture, callers };
}
