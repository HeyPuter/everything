// The costs tab's in-memory space from costs-view.test.js, shared with the extras view test.
import { settleAllEffects } from '../../../src/lib/costs/adapters.js';
import { applyPatch } from '../../../src/shared/operations.js';
import { validateEntity } from '../../../src/shared/schema/index.js';
import { createClock } from '../../../src/shared/hlc.js';
import { newId } from '../../../src/shared/ids.js';
import { can } from '../../../src/shared/perms.js';
import { DOMAIN_OPS } from '../../../src/shared/protocol.js';

export const ALICE = '00000000-0000-4000-8000-000000000001';
export const BOB = '00000000-0000-4000-8000-000000000002';
export const CAROL = '00000000-0000-4000-8000-000000000003';
const clock = createClock();

/** A small in-memory stand-in for `openSpace` with the same op shapes and validation. */
export function stubSpace({ role = 'editor', meta = { title: 'Lisbon', currency: 'EUR' } } = {}) {
  const entities = new Map();
  const listeners = new Set();
  const privates = new Map();
  const stamp = (t, id, fields) => ({ ...structuredClone(fields), id, v: clock.tick(), rev: 1, upd: Date.now(), by: ALICE, cr: Date.now() });
  const store = (t, value) => entities.set(`${t}:${value.id}`, Object.freeze(value));
  store('meta', stamp('meta', 'meta', meta));
  for (const [id, name] of [[ALICE, 'alice'], [BOB, 'bob'], [CAROL, 'carol']]) store('member', stamp('member', id, { name, role: 'editor' }));
  const all = (t) => [...entities.entries()].filter(([key]) => key.startsWith(`${t}:`)).map(([, value]) => value);
  const emit = (types) => { for (const listener of [...listeners]) listener({ changed: new Set(), types: new Set(types), rev: 1 }); };
  const applied = [];
  function applyOne(op) {
    if (op.do) { settleAllEffects(op.args).forEach(applyOne); return; }
    const key = `${op.t}:${op.id}`;
    if (op.put) { validateEntity('trip', op.t, op.put); store(op.t, stamp(op.t, op.id, op.put)); }
    else if (op.del) entities.delete(key);
    else store(op.t, { ...applyPatch('trip', op.t, entities.get(key), op), v: clock.tick() });
  }
  const space = {
    ref: { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' },
    applied,
    select: new Proxy({}, { get: (_, t) => ({ all: () => all(t), get: (id) => entities.get(`${t}:${id}`) ?? null }) }),
    get: (t, id) => entities.get(`${t}:${id}`) ?? null,
    query: (t, { includePrivate = false } = {}) => [...all(t), ...(includePrivate && t === 'exp' ? [...privates.values()].map((item) => ({ ...item, private: true })) : [])],
    can: (action) => can(role, action, {}),
    subscribe(target, listener) { const fn = typeof target === 'function' ? target : listener; listeners.add(fn); return () => listeners.delete(fn); },
    onState: () => () => {},
    state: { sync: 'synced', rev: 3, issue: null },
    conflicts: () => [],
    history: { undo: async () => {} },
    ops: {
      create: (t, fields, { id = newId() } = {}) => ({ opId: newId(), t, id, put: structuredClone(fields) }),
      patch: (t, id, { set, unset } = {}) => ({ opId: newId(), t, id, ...(set && Object.keys(set).length ? { set } : {}), ...(unset?.length ? { unset } : {}) }),
      remove: (t, id) => ({ opId: newId(), t, id, del: true }),
      domain(name, args, newIds) {
        if (!DOMAIN_OPS.includes(name)) throw new Error('invalid_domain_op');
        return { opId: newId(), do: name, args: { ...structuredClone(args), newIds: Object.fromEntries(Object.entries(newIds).map(([key, count]) => [key, Array.from({ length: count }, () => newId())])) } };
      },
    },
    async apply(list) { list.forEach(applyOne); applied.push(...list); emit(list.map((op) => op.t ?? 'settle')); },
    privateItems: () => ({
      list: () => [...privates.values()],
      async put(fields, id) { validateEntity('trip', 'exp', fields); privates.set(id, { ...fields, id, upd: Date.now() }); emit(['exp']); },
      async remove(id) { privates.delete(id); emit(['exp']); },
    }),
  };
  return space;
}

