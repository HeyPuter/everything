import { test, expect } from '@playwright/test';
import { audit, noOverflow, USERS } from './helpers/bridge-world.js';
import { patientWorld, seed, tripFor } from './helpers/trip-flows.js';

const DATES = { start: '2026-11-02', end: '2026-11-05' };
const A = USERS.alice.uuid;
const B = USERS.bob.uuid;
const entry = (page, name) => page.locator('.costs-entry').filter({ has: page.locator('.costs-entry-name', { hasText: new RegExp(`^${name}$`) }) });
const pageOf = (scope) => (typeof scope.page === 'function' ? scope.page() : scope);
const balance = (scope, name) => scope.locator('.costs-balances .costs-line').filter({ has: pageOf(scope).getByText(name, { exact: true }) }).locator('.costs-balance');
const tab = (page, name) => page.getByRole('tab', { name, exact: true }).click();
const exp = (name, amount, payer, extra = {}) => ({ type: 'exp', fields: {
  name, amount, currency: 'EUR', date: '2026-11-02', cat: 'accommodation', payers: [{ who: payer, amount }], split: { mode: 'equal', parts: [{ who: A }, { who: B }] }, ...extra,
} });

async function openDetail(page, name) {
  await page.locator('.costs-entry-main').filter({ hasText: name }).click();
  return page.getByRole('dialog', { name });
}

test.describe('cost extras', () => {
  test('a deposit with the rest due counts only what was paid until the payment is recorded', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      await seed(w, 'alice', trip.ref, [exp('Villa', 60000, A)]);
      const alice = await w.open('alice', trip.hash('costs'));
      const bob = await w.open('bob', trip.hash('costs'));
      let detail = await openDetail(alice, 'Villa');
      await detail.getByRole('button', { name: 'Pay in parts…' }).click();
      const plan = alice.getByRole('dialog', { name: 'Payment plan for Villa' });
      await plan.getByLabel('Rest due on').fill('2026-12-01');
      await plan.getByLabel('Paid so far by You').fill('200');
      await expect(plan.locator('.costs-status')).toHaveText('€200.00 paid, €400.00 left');
      await audit(alice);
      await plan.getByRole('button', { name: 'Save plan' }).click();
      await expect(plan).toBeHidden();
      await expect(detail.locator('.cx-payment')).toContainText('Paid €200.00 of €600.00');
      await alice.keyboard.press('Escape');
      await expect(detail).toBeHidden();
      await expect(entry(bob, 'Villa')).toContainText('€400.00 due');

      await tab(bob, 'Balances');
      await expect(balance(bob, 'You')).toHaveText('owe €100.00');
      await tab(bob, 'Overview');
      const due = bob.locator('.cx-due');
      await expect(due).toContainText('€400.00 left of €600.00');
      await due.getByRole('button', { name: 'Record a payment' }).click();
      const record = bob.getByRole('dialog', { name: 'Record a payment for Villa' });
      await record.getByLabel('Paid by').selectOption({ label: 'You' });
      await record.getByLabel('Amount', { exact: true }).fill('400');
      await audit(bob);
      await record.getByRole('button', { name: 'Record payment' }).click();
      await expect(bob.locator('.toast').filter({ hasText: 'Paid in full' })).toBeVisible();
      await expect(due).not.toContainText('Villa');

      await tab(alice, 'Balances');
      await expect(balance(alice, 'You')).toHaveText('owe €100.00');
      await expect(balance(alice, 'bob')).toHaveText('is owed €100.00');
      await tab(bob, 'Balances');
      await expect(balance(bob, 'You')).toHaveText('are owed €100.00');
      await tab(alice, 'Expenses');
      detail = await openDetail(alice, 'Villa');
      await expect(detail.locator('.cx-payment')).toHaveCount(0);
      await expect(detail).toContainText('€200.00');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('balances per currency settle each currency on its own', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      await seed(w, 'alice', trip.ref, [exp('Hotel', 10000, A), exp('Diner', 5000, B, { currency: 'USD', rate: '0.9', cat: 'food' })]);
      const alice = await w.open('alice', trip.hash('costs'));
      await tab(alice, 'Balances');
      // In trip currency: Alice paid 100, Bob paid 45; each owes 72.50.
      await expect(balance(alice, 'bob')).toHaveText('owes €27.50');
      await alice.getByRole('switch', { name: 'Per currency' }).click();
      const eur = alice.locator('.costs-block').filter({ hasText: 'Balances in EUR' });
      const usd = alice.locator('.costs-block').filter({ hasText: 'Balances in USD' });
      await expect(balance(eur, 'bob')).toHaveText('owes €50.00');
      await expect(balance(usd, 'You')).toHaveText('owe $25.00');
      await audit(alice);
      await noOverflow(alice);
      await usd.getByRole('button', { name: 'Record' }).click();
      const pay = alice.getByRole('dialog', { name: 'Record payment' });
      await expect(pay.getByLabel('Currency', { exact: true })).toHaveValue('USD');
      await expect(pay.getByLabel('Amount', { exact: true })).toHaveValue('25.00');
      await pay.getByLabel('Exchange rate').fill('0.9');
      await pay.getByRole('button', { name: 'Record payment', exact: true }).click();
      await expect(usd).toContainText('Everyone is even in USD.');
      await expect(balance(eur, 'bob')).toHaveText('owes €50.00');

      const bob = await w.open('bob', trip.hash('costs'));
      await tab(bob, 'Balances');
      await expect(bob.getByRole('switch', { name: 'Per currency' })).toHaveAttribute('aria-checked', 'false');
      await expect(balance(bob, 'You')).toHaveText('owe €50.00');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('an expense split across two trips and a budget seen by the other member', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const lisbon = await tripFor(w, { title: 'Lisbon', ...DATES });
      const porto = await tripFor(w, { title: 'Porto', start: '2026-11-05', end: '2026-11-08' });
      await seed(w, 'alice', lisbon.ref, [exp('Rail pass', 12000, A, { cat: 'transport' })]);
      const alice = await w.open('alice', lisbon.hash('costs'));
      const detail = await openDetail(alice, 'Rail pass');
      await detail.getByRole('button', { name: 'Split across trips…' }).click();
      const across = alice.getByRole('dialog', { name: 'Split Rail pass across trips' });
      await across.getByRole('checkbox', { name: 'Porto' }).check();
      await audit(alice);
      await across.getByRole('button', { name: 'Split across 2 trips' }).click();
      await expect(alice.locator('.toast').filter({ hasText: 'Split across 2 trips' })).toBeVisible({ timeout: 20_000 });
      await expect(entry(alice, 'Rail pass')).toContainText('Across 2 trips');
      await expect(entry(alice, 'Rail pass')).toContainText('€60.00');

      const bob = await w.open('bob', porto.hash('costs'));
      await expect(entry(bob, 'Rail pass')).toContainText('€60.00');
      await expect(entry(bob, 'Rail pass')).toContainText('Across 2 trips');

      await tab(alice, 'Overview');
      await alice.getByRole('button', { name: 'Plan a budget' }).click();
      const budget = alice.getByRole('dialog', { name: 'Budget for this trip' });
      await budget.getByLabel('Whole trip').fill('500');
      await budget.getByLabel('Transport', { exact: true }).fill('100');
      await audit(alice);
      await noOverflow(alice);
      await budget.getByRole('button', { name: 'Save', exact: true }).click();
      const section = alice.locator('.cx-budget');
      await expect(section).toContainText('€60.00 of €500.00');
      await expect(section).toContainText('€440.00 left');
      await expect(section.locator('.costs-bar-row').filter({ hasText: 'Transport' })).toContainText('€40.00 left');

      const bobLisbon = await w.open('bob', lisbon.hash('costs'));
      await tab(bobLisbon, 'Overview');
      await expect(bobLisbon.locator('.cx-budget')).toContainText('€60.00 of €500.00');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });
});
