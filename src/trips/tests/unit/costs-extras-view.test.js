import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '../../src/views/trip/costs/index.js';
import { ALICE, BOB, CAROL, stubSpace } from './helpers/costs-space.js';

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
const hotel = { name: 'Hotel', amount: 90000, currency: 'EUR', payers: [{ who: ALICE, amount: 30000 }], due: '2099-12-01', split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }, { who: CAROL }] } };

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const { controller, cleanup } of open.splice(0)) { controller.abort(); cleanup?.(); }
  document.body.replaceChildren();
});

describe('cost extras in the costs tab', () => {
  it('shows what is due and records the rest as paid', async () => {
    const { space, container } = await view();
    await space.apply([space.ops.create('exp', hotel)]);
    await tick();
    expect(container.querySelector('.costs-entry-chips').textContent).toContain('€600.00 due');
    byText(container, 'Overview', '[role=tab]').click();
    expect(container.querySelector('.cx-due').textContent).toContain('€600.00 left of €900.00');
    byText(container.querySelector('.cx-due'), 'Record a payment').click();
    const form = dialog().querySelector('form');
    form.querySelector('select').value = BOB;
    form.requestSubmit();
    await tick(); await tick();
    const [expense] = space.select.exp.all();
    expect(expense.payers).toEqual([{ who: ALICE, amount: 30000 }, { who: BOB, amount: 60000 }]);
    expect(expense.due).toBeUndefined();
  });

  it('sets a payment plan from the expense detail', async () => {
    const { space, container } = await view();
    await space.apply([space.ops.create('exp', { ...hotel, payers: [{ who: ALICE, amount: 90000 }], due: undefined })]);
    await tick();
    container.querySelector('.costs-entry-main').click();
    byText(dialog(), 'Pay in parts…').click();
    const form = dialog().querySelector('form');
    type(form.querySelector('input[aria-label="Paid so far by You"]'), '100');
    form.querySelector('input[type=date]').value = '2099-01-10';
    form.requestSubmit();
    await tick(); await tick();
    expect(space.select.exp.all()[0]).toMatchObject({ payers: [{ who: ALICE, amount: 10000 }], due: '2099-01-10' });
  });

  it('plans a budget and compares it with spend', async () => {
    const { space, container } = await view();
    await space.apply([space.ops.create('exp', { name: 'Dinner', amount: 12000, currency: 'EUR', cat: 'food', payers: [{ who: ALICE, amount: 12000 }], split: { mode: 'equal', parts: [{ who: ALICE }] } })]);
    await tick();
    byText(container, 'Overview', '[role=tab]').click();
    byText(container, 'Plan a budget').click();
    const form = dialog().querySelector('form');
    type(form.querySelector('input[aria-label="Whole trip"]'), '1000');
    type(form.querySelector('input[aria-label="Food & drink"]'), '100');
    form.requestSubmit();
    await tick(); await tick();
    expect(space.select.budget.all().map((item) => [item.cat ?? '', item.amount]).sort()).toEqual([['', 100000], ['food', 10000]]);
    const block = container.querySelector('.cx-budget');
    expect(block.textContent).toContain('€120.00 of €1,000.00');
    expect(block.textContent).toContain('€20.00 over');
  });

  it('switches balances to one block per currency', async () => {
    const { space, container } = await view();
    await space.apply([
      space.ops.create('exp', { name: 'Taxi', amount: 3000, currency: 'EUR', payers: [{ who: ALICE, amount: 3000 }], split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }] } }),
      space.ops.create('exp', { name: 'Ramen', amount: 4000, currency: 'JPY', rate: '0.0062', payers: [{ who: BOB, amount: 4000 }], split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }] } }),
    ]);
    await tick();
    byText(container, 'Balances', '[role=tab]').click();
    container.querySelector('[data-focus="bycur"]').click();
    const blocks = container.querySelector('.cx-currencies').textContent;
    expect(blocks).toContain('Balances in EUR');
    expect(blocks).toContain('Balances in JPY');
    expect(blocks).toContain('¥2,000');
  });
});
