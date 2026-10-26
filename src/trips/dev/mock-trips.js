// mock.html test hook (`globalThis.trips`): the real deployer, worker client, stores and sync on the fake runtime.
// Nothing runs until a method is called.
import { createWorkerClient } from '../src/lib/api.js';
import { createCredentialManager } from '../src/lib/cred.js';
import { createDeployer, createWorkerGate, ensureShareConsent } from '../src/lib/deploy.js';
import { openDatabase } from '../src/lib/idb.js';
import { accountIdentity } from '../src/lib/puter.js';
import { openSpace } from '../src/lib/store/index.js';
import { createPersonalStore } from '../src/lib/store/personal.js';
import { newId } from '../src/shared/ids.js';

const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

export function createMockTrips(puter = globalThis.puter) {
  let ready;
  let own = null;
  const open = new Map();
  const errors = [];

  function context() {
    ready ??= (async () => {
      const account = await accountIdentity(puter);
      const db = await openDatabase(account.uuid);
      const credentials = await createCredentialManager({ puter, db });
      const deployer = createDeployer({ puter });
      const api = createWorkerClient({ puter, credentials, gate: createWorkerGate({ puter, ownWorker: () => own }) });
      return { account, db, deployer, api, personal: createPersonalStore({ puter, db }) };
    })();
    return ready;
  }
  async function ownWorker() {
    const { deployer } = await context();
    own ??= (await deployer.current())?.name ?? null;
    return own;
  }
  function space(ref) {
    const found = open.get(ref.s);
    if (!found) throw new Error('space_not_open');
    return found;
  }

  return {
    async uuid() { return (await context()).account.uuid; },
    errors: () => [...errors],
    /** Deploys or updates this account's worker exactly as the app will. */
    async deploy() {
      const { deployer } = await context();
      const { worker, health, created, updated } = await deployer.ensure();
      own = worker.name;
      return { worker: worker.name, build: health.build, builtAt: health.builtAt, created, updated };
    },
    async createTrip({ title = 'Trip', currency = 'EUR', start, end } = {}) {
      const { api, personal } = await context();
      const { worker } = await this.deploy();
      const meta = { title, currency, ...(start ? { start } : {}), ...(end ? { end } : {}) };
      const created = await api.request(worker, JSON.stringify({ op: 'space.create', kind: 'trip', meta, space: newId() }));
      const ref = { w: worker, s: created.space, k: 'trip' };
      await personal.spaces.upsert({ ref, role: 'owner', title, ...(start ? { start } : {}), ...(end ? { end } : {}) });
      return ref;
    },
    /** Asks for the share consent first, as the invite dialog does. */
    async invite(ref, { role = 'editor' } = {}) {
      const { api, account, db } = await context();
      await ensureShareConsent({ puter, db, uid: account.uuid });
      const { invite, token } = await api.call(ref, 'invite.create', { role });
      return { id: invite.id, role: invite.role, token };
    },
    async join(ref, token) {
      const { api, personal } = await context();
      const joined = await api.call(ref, 'join', { token });
      const handles = joined.handles ? { read: joined.handles.read, write: joined.handles.write } : undefined;
      await personal.spaces.upsert({ ref, role: joined.role, title: '', ...(handles ? { handles } : {}), ...(joined.files ? { files: joined.files } : {}) });
      return { role: joined.role, rev: joined.rev, handles: Boolean(handles), files: joined.files };
    },
    /** `path: 'C'` opens without handles and never asks for them. */
    async open(ref, { path } = {}) {
      const { db, api, personal } = await context();
      open.get(ref.s)?.close();
      const cached = (await personal.spaces.list()).find((entry) => entry.ref.s === ref.s);
      const opened = await openSpace({
        ref, db, api, puter, personal, ownWorker: await ownWorker(), view: 'plan',
        handles: path === 'C' ? null : cached?.handles ?? null, files: cached?.files ?? null, role: cached?.role ?? null, open: path !== 'C',
        onError: (error) => errors.push(error.code ?? error.message),
      });
      open.set(ref.s, opened);
      return plain(opened.state);
    },
    state: (ref) => plain(space(ref).state),
    /** Files block in use: `{mode: 'direct', …}` with `files=direct` (verified owners), else proxied. */
    access: async (ref) => plain(await space(ref).fileAccess()),
    async create(ref, type, fields) {
      const target = space(ref);
      const op = target.ops.create(type, fields);
      await target.apply([op]);
      return op.id;
    },
    /** `{base: true}` sends a conflict-checked patch (conflict-checked types only). */
    async patch(ref, type, id, set, options = {}) { const target = space(ref); await target.apply([target.ops.patch(type, id, { set }, options)]); },
    /** A private item (`pack` or `exp`) in this account's personal store; it never reaches the worker. */
    privateItem: async (ref, type, fields) => space(ref).privateItems(type).put(fields),
    /** One of the caller's private items (`pack` or `exp`), kept in their personal KV. */
    async putPrivate(ref, type, fields) { const id = newId(); await space(ref).privateItems(type).put(fields, id); return id; },
    /** Sends everything pending. One store flush sends one batch, or joins the batch a background flush has in flight. */
    async flush(ref) {
      const target = space(ref);
      let result = await target.flush();
      for (let round = 0; round < 50 && result?.status === 'sent' && target.state.pending > 0; round++) result = await target.flush();
      return plain(result);
    },
    sync: (ref) => space(ref).sync(),
    get: (ref, type, id) => plain(space(ref).get(type, id)),
    names: (ref, type) => space(ref).select[type].all().map((entity) => entity.name ?? entity.title),
    list: (ref, type) => plain(space(ref).select[type].all()),
    conflicts: (ref) => plain(space(ref).conflicts()),
    members: (ref) => plain(space(ref).members()),
    /** Any worker op, for steps without a client helper (member.remove, leave, …). */
    async call(ref, op, input = {}) { return plain(await (await context()).api.call(ref, op, input)); },
    close(ref) { open.get(ref.s)?.close(); open.delete(ref.s); },
  };
}
