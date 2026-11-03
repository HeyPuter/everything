import { openDatabase } from '../../src/lib/idb.js';
import { createCredentialManager } from '../../src/lib/cred.js';
import { createWorkerClient } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createInvites } from '../../src/lib/invites.js';
import { accountIdentity } from '../../src/lib/puter.js';

// Test-only page: the real client modules against the fake-runtime bridge, with real Chromium IndexedDB.
const WORKER = new URL(location.href).searchParams.get('worker');
let account;
let db;
let api;
let personal;
let inbox;
let space;
let found = [];
const errors = [];

async function boot() {
  await globalThis.__fakePuterBridgeReady;
  account = await accountIdentity(globalThis.puter);
  db = await openDatabase(account.uuid);
  const credentials = await createCredentialManager({ puter: globalThis.puter, db });
  api = createWorkerClient({ puter: globalThis.puter, credentials });
  personal = createPersonalStore({ puter: globalThis.puter, db });
  inbox = createInvites({ puter: globalThis.puter, api, spaces: personal.spaces });
}
const ref = (id) => ({ w: WORKER, s: id, k: 'trip' });
// The fixture is a production build, where path A follows config.json; this page exists to test path A.
const FEATURES = { pathA: true, directFiles: true };
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

window.pathA = {
  uuid: () => account.uuid,
  errors: () => [...errors],
  async createSpace(title) { return (await api.request(WORKER, JSON.stringify({ op: 'space.create', title }))).space; },
  async invite(id, uuid) { return api.call(ref(id), 'invite.create', { named: uuid, role: 'editor' }); },
  async invites() { found = await inbox.list(); return plain(found.map(({ title, ownerName, role }) => ({ title, ownerName, role }))); },
  async accept(index) { const joined = await inbox.accept(found[index]); return { role: joined.role, handles: Boolean(joined.handles) }; },
  async open(id, { owner = false, autoStart = true } = {}) {
    space?.close();
    const cached = (await personal.spaces.list()).find((entry) => entry.ref.s === id);
    space = await openSpace({ ref: ref(id), db, api, puter: globalThis.puter, personal, handles: cached?.handles ?? null, role: cached?.role ?? (owner ? 'owner' : null),
      ownWorker: owner ? WORKER : null, view: 'plan', features: FEATURES, autoStart, onError: (error) => errors.push(error.code ?? error.message) });
    return plain(space.state);
  },
  start: () => space.start(),
  state: () => plain(space.state),
  async create(type, fields) { const op = space.ops.create(type, fields); await space.apply([op]); return op.id; },
  async patch(type, id, set) { await space.apply([space.ops.patch(type, id, { set })]); },
  flush: async () => plain(await space.flush()),
  sync: () => space.sync(),
  get: (type, id) => plain(space.get(type, id)),
  title: () => space.get('meta', 'meta')?.title ?? null,
  names: (type) => space.select[type].all().map((entity) => entity.name ?? entity.title),
  members: () => plain(space.members()),
  close() { space?.close(); space = null; },
};
await boot();
document.documentElement.dataset.pathA = 'ready';
window.addEventListener('pagehide', () => { space?.close(); db?.close(); }, { once: true });
