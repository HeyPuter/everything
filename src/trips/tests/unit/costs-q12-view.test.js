import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../src/views/trip/costs/index.js';
import { applyPatch } from '../../src/shared/operations.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { newId } from '../../src/shared/ids.js';
import { can } from '../../src/shared/perms.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const CAROL = '00000000-0000-4000-8000-000000000003';
const clock = createClock();

function stubSpace({ presets = [] } = {}) {
  const entities = new Map();
  const listeners = new Set();
  const stamp = (id, fields) => ({ ...structuredClone(fields), id, v: clock.tick(), rev: 1, upd: Date.now(), by: ALICE, cr: Date.now() });
  const store = (t, value) => entities.set(`${t}:${value.id}`, Object.freeze(value));
  store('meta', stamp('meta', { title: 'Lisbon', currency: 'EUR' }));
  for (const [id, name] of [[ALICE, 'alice'], [BOB, 'bob'], [CAROL, 'carol']]) store('member', stamp(id, { name, role: 'editor' }));
  for (const preset of presets) store('splitPreset', stamp(preset.id, { name: preset.name, weights: preset.weights }));
  const all = (t) => [...entities.entries()].filter(([key]) => key.startsWith(`${t}:`)).map(([, value]) => value);
  const applied = [];
  const space = {
    ref: { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' },
    applied,
    select: new Proxy({}, { get: (_, t) => ({ all: () => all(t), get: (id) => entities.get(`${t}:${id}`) ?? null }) }),
    get: (t, id) => entities.get(`${t}:${id}`) ?? null,
    query: (t) => all(t),
    can: (action) => can('editor', action, {}),
    subscribe(target, listener) { const fn = typeof target === 'function' ? target : listener; listeners.add(fn); return () => listeners.delete(fn); },
    onState: () => () => {},
    state: { sync: 'synced', rev: 3, issue: null },
    conflicts: () => [],
    history: { undo: async () => {} },
    ops: {
      create: (t, fields, { id = newId() } = {}) => ({ opId: newId(), t, id, put: structuredClone(fields) }),
      patch: (t, id, { set, unset } = {}) => ({ opId: newId(), t, id, ...(set ? { set } : {}), ...(unset?.length ? { unset } : {}) }),
      remove: (t, id) => ({ opId: newId(), t, id, del: true }),
    },
    async apply(list) {
      for (const op of list) {
        if (op.put) { validateEntity('trip', op.t, op.put); store(op.t, stamp(op.id, op.put)); }
        else if (op.del) entities.delete(`${op.t}:${op.id}`);
        else store(op.t, { ...applyPatch('trip', op.t, entities.get(`${op.t}:${op.id}`), op), v: clock.tick() });
      }
      applied.push(...list);
      for (const listener of [...listeners]) listener({ changed: new Set(), types: new Set(list.map((op) => op.t)), rev: 1 });
    },
    privateItems: () => ({ list: () => [], put: async () => {}, remove: async () => {} }),
  };
  return space;
}

const open = [];
async function view({ presets, puter } = {}) {
  const space = stubSpace({ presets });
  const controller = new AbortController();
  const container = document.createElement('div');
  document.body.append(container);
  const cleanup = await mount(container, { space, session: { services: {} }, account: { uuid: ALICE }, signal: controller.signal, personal: null, puter });
  open.push({ controller, cleanup });
  return { space, container };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const dialog = () => [...document.querySelectorAll('[role=dialog]')].at(-1);
const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
const labelled = (root, text) => document.getElementById([...root.querySelectorAll('label')].find((node) => node.textContent.trim() === text)?.htmlFor);

afterEach(() => {
  for (const { controller, cleanup } of open.splice(0)) { controller.abort(); cleanup?.(); }
  document.body.replaceChildren();
  localStorage.clear();
});

describe('weight presets in the expense form', () => {
  it('applies a preset from equal mode and saves a shares split', async () => {
    const { space, container } = await view({ presets: [{ id: 'p000000000000001', name: 'Couple + one', weights: { [ALICE]: 2, [BOB]: 1 } }] });
    byText(container, 'Add expense').click();
    const form = dialog();
    type(labelled(form, 'Name'), 'Dinner');
    type(labelled(form, 'Amount'), '30');
    const picker = labelled(form, 'Weight preset');
    expect(picker.closest('.presets-bar').hidden).toBe(false);
    picker.value = 'p000000000000001';
    picker.dispatchEvent(new Event('change'));
    expect([...form.querySelectorAll('[aria-pressed="true"]')].map((node) => node.textContent)).toContain('Shares');
    form.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    const exp = space.applied.find((op) => op.t === 'exp')?.put;
    expect(exp.split).toEqual({ mode: 'shares', parts: [{ who: ALICE, value: 2 }, { who: BOB, value: 1 }] });
  });

  it('saves the current shares as a preset', async () => {
    const { space, container } = await view();
    byText(container, 'Add expense').click();
    const form = dialog();
    byText(form, 'Shares').click();
    const inputs = [...form.querySelectorAll('.costs-value')];
    type(inputs[0], '3');
    byText(form, 'Save as preset').click();
    const prompt = dialog();
    type(prompt.querySelector('input'), 'Family');
    prompt.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(space.applied.find((op) => op.t === 'splitPreset')?.put).toEqual({ name: 'Family', weights: { [ALICE]: 3, [BOB]: 1, [CAROL]: 1 } });
  });
});

describe('receipt scanning', () => {
  it('reads a receipt and opens the expense form prefilled for review', async () => {
    const chat = vi.fn().mockResolvedValue({ message: { content: '{"merchant":"Blue Fern","total":14.6,"currency":"EUR","date":"2020-05-09","category":"food","items":[],"confidence":0.9}' } });
    const { space, container } = await view({ puter: { ai: { chat } } });
    expect(byText(container, 'Scan receipt')).toBeTruthy();
    const { openReceiptDialog } = await import('../../src/views/trip/costs/receipt/index.js');
    const { readModel, createPeople } = await import('../../src/views/trip/costs/shared.js');
    const { openExpenseForm } = await import('../../src/views/trip/costs/form.js');
    const people = createPeople({ space, me: ALICE });
    const getModel = () => readModel(space, ALICE);
    const track = (value) => value;
    openReceiptDialog({ file: new File([new Uint8Array([0xff, 0xd8, 0xff])], 'r.jpg', { type: 'image/jpeg' }), space, getModel, people, session: {}, puter: { ai: { chat } }, track,
      openForm: (extra) => openExpenseForm({ space, model: getModel(), people, session: {}, track, ...extra }) });
    for (let index = 0; index < 5 && !byText(dialog(), 'Review expense'); index++) await tick();
    expect(dialog().textContent).toContain('Blue Fern');
    byText(dialog(), 'Review expense').click();
    const form = dialog();
    expect(labelled(form, 'Name').value).toBe('Blue Fern');
    expect(labelled(form, 'Amount').value).toBe('14.60');
    expect(labelled(form, 'Date').value).toBe('2020-05-09');
    expect(space.applied).toEqual([]);
  });
});
