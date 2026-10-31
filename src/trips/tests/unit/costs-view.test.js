import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../src/views/trip/costs/index.js';
import { settleAllEffects } from '../../src/lib/costs/adapters.js';
import { applyPatch } from '../../src/shared/operations.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { newId } from '../../src/shared/ids.js';
import { can } from '../../src/shared/perms.js';
import { DOMAIN_OPS } from '../../src/shared/protocol.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const CAROL = '00000000-0000-4000-8000-000000000003';
const clock = createClock();

/** A small in-memory stand-in for `openSpace` with the same op shapes and validation. */
function stubSpace({ role = 'editor', meta = { title: 'Lisbon', currency: 'EUR' } } = {}) {
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

const open = [];
async function view(options) {
  const space = stubSpace(options);
  const controller = new AbortController();
  const container = document.createElement('div');
  document.body.append(container);
  const cleanup = await mount(container, { space, session: { services: {} }, account: { uuid: ALICE }, signal: controller.signal, personal: null });
  open.push({ controller, cleanup });
  return { space, container };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const dialog = () => [...document.querySelectorAll('[role=dialog]')].at(-1);
const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const { controller, cleanup } of open.splice(0)) { controller.abort(); cleanup?.(); }
  document.body.replaceChildren();
});

describe('costs tab', () => {
  it('adds an expense split three ways and settles everyone up', async () => {
    const { space, container } = await view();
    expect(container.textContent).toContain('No expenses yet');
    byText(container, 'Add expense').click();
    const form = dialog().querySelector('form');
    type(form.querySelector('input.input'), 'Dinner');
    type(form.querySelectorAll('input.input')[1], '90');
    form.requestSubmit();
    await tick(); await tick();
    const [expense] = space.select.exp.all();
    expect(expense).toMatchObject({ name: 'Dinner', amount: 9000, currency: 'EUR', payers: [{ who: ALICE, amount: 9000 }] });
    expect(expense.split.parts.map((part) => part.who)).toEqual([ALICE, BOB, CAROL]);
    await tick();
    expect(container.textContent).toContain('Dinner');
    expect(container.querySelector('.costs-stats').textContent).toContain('60.00');

    byText(container, 'Balances', '[role=tab]').click();
    expect(container.textContent).toContain('are owed €60.00');
    byText(container, 'Settle all').click();
    byText(dialog(), 'Settle all').click();
    await tick(); await tick();
    expect(space.select.settle.all()).toHaveLength(2);
    expect(container.textContent).toContain('Everyone is settled up.');
  });

  it('marks a share as paid back from the detail view', async () => {
    const { space, container } = await view();
    await space.apply([space.ops.create('exp', { name: 'Taxi', amount: 3000, currency: 'EUR', payers: [{ who: ALICE, amount: 3000 }], split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }] } })]);
    await tick();
    container.querySelector('.costs-entry-main').click();
    byText(dialog(), 'Mark paid').click();
    await tick();
    expect(space.select.exp.all()[0].split.parts[1]).toEqual({ who: BOB, paid: 1500 });
  });

  it('keeps private expenses out of balances and lets viewers add them', async () => {
    const { space, container } = await view({ role: 'viewer' });
    expect(container.textContent).toContain('You can view shared costs');
    byText(container, 'Add private expense').click();
    const form = dialog().querySelector('form');
    type(form.querySelector('input.input'), 'Souvenir');
    type(form.querySelectorAll('input.input')[1], '12,5');
    form.requestSubmit();
    await tick(); await tick();
    expect(space.select.exp.all()).toEqual([]);
    expect(space.privateItems('exp').list()).toMatchObject([{ name: 'Souvenir', amount: 1250, payers: [{ who: ALICE, amount: 1250 }] }]);
    await tick();
    expect(container.textContent).toContain('Souvenir');
    expect(container.textContent).toContain('Private');
  });

  it('flags a foreign-currency expense without a rate as pending', async () => {
    const { space, container } = await view();
    await space.apply([space.ops.create('exp', { name: 'Museum', amount: 2000, currency: 'USD', rate: null, payers: [{ who: BOB, amount: 2000 }], split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }] } })]);
    await tick();
    expect(container.textContent).toContain('Rate pending');
    expect(container.textContent).toContain('waiting for an exchange rate');
    byText(container, 'Overview', '[role=tab]').click();
    expect(container.textContent).toContain('Nothing spent yet');
  });

  it('records a suggested payment, shows the math, orders categories and exports CSV', async () => {
    const { space, container } = await view();
    await space.apply([space.ops.create('exp', { name: 'Hotel', amount: 20_000, currency: 'EUR', cat: 'accommodation', payers: [{ who: BOB, amount: 20_000 }], split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }] } })]);
    await tick();
    byText(container, 'Balances', '[role=tab]').click();
    byText(container, 'Show the math').click();
    expect(dialog().textContent).toContain('How the payments were chosen');
    dialog().querySelector('.modal-head .icon-btn').click();
    container.querySelector('[data-focus^="rec:"]').click();
    dialog().querySelector('form').requestSubmit();
    await tick(); await tick();
    expect(space.select.settle.all()).toMatchObject([{ from: ALICE, to: BOB, amount: 10_000, currency: 'EUR' }]);

    byText(container, 'Overview', '[role=tab]').click();
    expect(container.textContent).toContain('Accommodation');
    byText(container, 'Reorder categories').click();
    byText(dialog(), 'Save').click();
    await tick();
    expect(space.select.costCat.all()).toHaveLength(14);

    const urls = [];
    URL.createObjectURL = (blob) => { urls.push(blob); return 'blob:x'; };
    URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    container.querySelector('[data-focus="more"]').click();
    byText(document.body, 'Export CSV').click();
    expect(urls).toHaveLength(1);
    const text = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(urls[0]); });
    expect(text.replace(/^\uFEFF/, '').startsWith('Type;Date;Name')).toBe(true);
    expect(text).toContain('Hotel');
  });
});

