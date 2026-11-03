import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow, USERS } from './helpers/bridge-world.js';
import { choose, download, failNextCommit, fakeRates, patientWorld, seed, setOnline, stopFailingCommits, synced, tabTo, tripFor } from './helpers/trip-flows.js';

const DATES = { start: '2026-11-02', end: '2026-11-05' };
const entry = (page, name) => page.locator('.costs-entry').filter({ has: page.locator('.costs-entry-name', { hasText: new RegExp(`^${name}$`) }) });
const stat = (page, label) => page.locator('.costs-stats .stat').filter({ has: page.getByText(label, { exact: true }) }).locator('strong');
const balance = (page, name) => page.locator('.costs-balances .costs-line').filter({ has: page.getByText(name, { exact: true }) }).locator('.costs-balance');
const tab = (page, name) => page.getByRole('tab', { name, exact: true }).click();

/** Fills and saves the new-expense form; `split(form)` can adjust the split section before saving. */
async function addExpense(page, { name, amount, date, category, currency, priv = false, split }) {
  await page.locator('.costs-toolbar').getByRole('button', { name: /^Add (private )?expense$/ }).click();
  const form = page.getByRole('dialog', { name: 'New expense' });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Amount', { exact: true }).fill(amount);
  if (currency) await form.getByLabel('Currency', { exact: true }).selectOption(currency);
  if (date) await form.getByLabel('Date', { exact: true }).fill(date);
  if (category) await form.getByLabel('Category', { exact: true }).selectOption({ label: category });
  if (priv) await form.getByRole('checkbox', { name: /^Private expense/ }).check();
  await split?.(form);
  await form.getByRole('button', { name: 'Add expense', exact: true }).click();
  await expect(form).toBeHidden();
}

const exp = (key, name, amount, payer, people, extra = {}) => ({ key, type: 'exp', fields: {
  name, amount, currency: 'EUR', date: '2026-11-03', cat: 'food', payers: [{ who: payer, amount }], split: { mode: 'equal', parts: people.map((who) => ({ who })) }, ...extra,
} });

test.describe('costs', () => {
  test('two members split expenses, see the same balances and settle up; a private expense stays private', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const alice = await w.open('alice', trip.hash('costs'));
      await expect(alice.getByRole('heading', { name: 'No expenses yet' })).toBeVisible();
      await audit(alice);
      await addExpense(alice, { name: 'Dinner', amount: '90', date: '2026-11-02', category: 'Food & drink' });
      await expect(entry(alice, 'Dinner')).toContainText('You lent €45.00');

      const bob = await w.open('bob', trip.hash('costs'));
      await expect(entry(bob, 'Dinner')).toContainText('Paid by alice');
      await expect(stat(bob, 'You owe')).toHaveText('€45.00');
      await addExpense(bob, { name: 'Taxi', amount: '20', date: '2026-11-02', category: 'Transport' });
      await addExpense(bob, { name: 'Souvenirs', amount: '15', date: '2026-11-03', priv: true });
      await expect(entry(bob, 'Souvenirs')).toContainText('Private');
      await expect(bob.locator('.costs-stats')).toContainText('Plus €15.00 private');
      await audit(bob);

      await expect(entry(alice, 'Taxi')).toBeVisible();
      await expect(stat(alice, 'You’re owed')).toHaveText('€35.00');
      await expect(stat(alice, 'Total spend')).toHaveText('€110.00');
      await expect(entry(alice, 'Souvenirs')).toHaveCount(0);

      for (const page of [alice, bob]) await tab(page, 'Balances');
      await expect(balance(alice, 'You')).toHaveText('are owed €35.00');
      await expect(balance(alice, 'bob')).toHaveText('owes €35.00');
      await expect(balance(bob, 'alice')).toHaveText('is owed €35.00');
      await expect(balance(bob, 'You')).toHaveText('owe €35.00');
      await audit(alice);
      await capture(bob, testInfo, 'costs-balances');

      await bob.getByRole('button', { name: 'Show the math' }).click();
      const math = bob.getByRole('dialog', { name: 'How balances are calculated' });
      await expect(math).toContainText('You pays alice €35.00');
      await audit(bob);
      await bob.keyboard.press('Escape');

      await bob.getByRole('button', { name: 'Record payment from You to alice' }).click();
      const pay = bob.getByRole('dialog', { name: 'Record payment' });
      await expect(pay.getByLabel('Amount', { exact: true })).toHaveValue('35.00');
      await pay.getByRole('button', { name: 'Record payment', exact: true }).click();
      await expect(pay).toBeHidden();
      for (const page of [alice, bob]) await expect(page.getByText('Everyone is settled up.')).toBeVisible();
      await expect(alice.locator('.costs-history')).toContainText('bob paid You');
      await expect(stat(alice, 'You’re owed')).toHaveText('€0.00');

      await tab(alice, 'Overview');
      await expect(alice.locator('.costs-bars')).toContainText('Food & drink');
      await expect(alice.locator('.costs-bars')).not.toContainText('Shopping');
      await audit(alice);
      await tab(bob, 'Overview');
      await expect(alice.locator('.costs-totals')).toContainText('€110.00');
      await expect(bob.locator('.costs-totals')).toContainText('€125.00');
      await expect(bob.getByText('Your private expenses: €15.00.')).toBeVisible();
      await noOverflow(bob);
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('shares with a guest, itemised lines and settle all', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const alice = await w.open('alice', trip.hash('costs'));
      await addExpense(alice, { name: 'Boat tour', amount: '100', split: async (form) => {
        await form.getByRole('button', { name: 'Add guest' }).click();
        const prompt = alice.getByRole('dialog', { name: 'Add guest' });
        await prompt.getByLabel('Guest name').fill('Carla');
        await prompt.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(form.getByRole('checkbox', { name: 'Include Carla' })).toBeChecked();
        await form.getByRole('button', { name: 'Shares', exact: true }).click();
        await form.getByLabel('Shares for You').fill('2');
        const shares = form.locator('.costs-share');
        await expect(shares).toHaveText(['€50.00', '€25.00', '€25.00']);
      } });
      await addExpense(alice, { name: 'Market lunch', amount: '30', split: async (form) => {
        await form.getByRole('button', { name: 'Items', exact: true }).click();
        await form.getByRole('button', { name: 'Add line' }).click();
        await form.getByLabel('Line 1 description').fill('Wine');
        await form.getByLabel('Line 1 amount').fill('18');
        await form.getByRole('group', { name: 'Who shares line 1' }).getByRole('checkbox', { name: 'Carla' }).uncheck();
        await form.getByRole('button', { name: 'Add line' }).click();
        await form.getByLabel('Line 2 description').fill('Bread');
        await form.getByLabel('Line 2 amount').fill('12');
      } });

      const bob = await w.open('bob', trip.hash('costs'));
      await bob.locator('.costs-entry-main').filter({ hasText: 'Market lunch' }).click();
      const detail = bob.getByRole('dialog', { name: 'Market lunch' });
      await expect(detail).toContainText('Split · Items');
      await expect(detail.locator('.costs-items')).toContainText('Wine');
      // Wine 18 between Alice and Bob, bread 12 among three: 13 each for them, 4 for Carla.
      await expect(detail.locator('.costs-row').filter({ hasText: 'You' }).first()).toContainText('€13.00');
      await expect(detail.locator('.costs-row').filter({ hasText: 'Carla' }).first()).toContainText('€4.00');
      await audit(bob);
      await bob.keyboard.press('Escape');

      await tab(bob, 'Balances');
      await expect(balance(bob, 'Carla')).toHaveText('owes €29.00');
      await expect(balance(bob, 'You')).toHaveText('owe €38.00');
      await bob.getByRole('button', { name: 'Settle all' }).click();
      await bob.getByRole('dialog', { name: 'Settle all?' }).getByRole('button', { name: 'Settle all' }).click();
      await expect(bob.getByText('Everyone is settled up.')).toBeVisible();
      await tab(alice, 'Balances');
      await expect(alice.getByText('Everyone is settled up.')).toBeVisible();
      await expect(alice.locator('.costs-history .costs-line')).toHaveCount(2);
      await bob.locator('.toast').getByRole('button', { name: 'Undo' }).click();
      await expect(alice.locator('.costs-history .costs-line')).toHaveCount(0);
      await expect(balance(alice, 'You')).toHaveText('are owed €67.00');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('an offline foreign expense waits for its rate, and a stale edit reaches the conflict dialog', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
    try {
      const trip = await tripFor(w, { ...DATES, roles: { bob: 'editor', carol: 'viewer' } });
      await seed(w, 'alice', trip.ref, [exp('lunch', 'Lunch', 4000, USERS.alice.uuid, [USERS.alice.uuid, USERS.bob.uuid])]);
      const aliceContext = await w.context('alice');
      await fakeRates(aliceContext, { USD: { EUR: 0.9 } });
      const alice = await w.open('alice', trip.hash('costs'));
      const bob = await w.open('bob', trip.hash('costs'));
      const carol = await w.open('carol', trip.hash('costs'));
      await expect(entry(alice, 'Lunch')).toBeVisible();

      await setOnline(aliceContext, false);
      await addExpense(alice, { name: 'Museum', amount: '20', currency: 'USD', date: '2026-11-03' });
      await expect(entry(alice, 'Museum')).toContainText('Rate pending');
      await expect(alice.locator('.costs-banners')).toContainText('items are waiting for an exchange rate');
      await expect(alice.locator('.costs-banners')).toContainText('You’re offline.');
      await audit(alice);
      await alice.locator('.costs-entry-main').filter({ hasText: 'Lunch' }).click();
      await alice.getByRole('dialog', { name: 'Lunch' }).getByRole('button', { name: 'Edit', exact: true }).click();
      const mine = alice.getByRole('dialog', { name: 'Edit expense' });
      await mine.getByLabel('Name', { exact: true }).fill('Lunch at Ramiro');
      await mine.getByRole('button', { name: 'Save changes' }).click();
      await expect(mine).toBeHidden();

      // Bob renames the same expense; Carol's page proves the worker has his version before Alice reconnects.
      await bob.locator('.costs-entry-main').filter({ hasText: 'Lunch' }).click();
      await bob.getByRole('dialog', { name: 'Lunch' }).getByRole('button', { name: 'Edit', exact: true }).click();
      const theirs = bob.getByRole('dialog', { name: 'Edit expense' });
      await theirs.getByLabel('Name', { exact: true }).fill('Lunch at Cervejaria');
      await theirs.getByRole('button', { name: 'Save changes' }).click();
      await expect(entry(carol, 'Lunch at Cervejaria')).toBeVisible();
      await expect(entry(carol, 'Museum')).toHaveCount(0);

      await setOnline(aliceContext, true);
      await expect(entry(carol, 'Museum')).toContainText('≈ €18.00');
      await expect(entry(alice, 'Museum')).not.toContainText('Rate pending');
      const banner = alice.locator('.costs-banner').filter({ hasText: 'cost changes could not be saved' });
      await expect(banner).toBeVisible();
      await banner.getByRole('button', { name: 'Review' }).click();
      const conflict = alice.getByRole('dialog', { name: 'Resolve a conflict' });
      await expect(conflict).toContainText('Lunch at Cervejaria');
      await audit(alice);
      await conflict.getByRole('button', { name: 'Keep theirs', exact: true }).click();
      await expect(banner).toHaveCount(0);
      await expect(entry(alice, 'Lunch at Cervejaria')).toBeVisible();
      await synced(alice);
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('a viewer keeps private expenses, the owner exports CSV and turns splitting off, and credit errors show', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
    try {
      const trip = await tripFor(w, { ...DATES, roles: { bob: 'editor', carol: 'viewer' } });
      await seed(w, 'alice', trip.ref, [
        exp('a', 'Coffee; cake', 750, USERS.alice.uuid, [USERS.alice.uuid, USERS.bob.uuid], { order: 'a' }),
        exp('b', 'Tram', 600, USERS.bob.uuid, [USERS.alice.uuid, USERS.bob.uuid], { cat: 'transport', order: 'b' }),
      ]);
      const carol = await w.open('carol', trip.hash('costs'));
      await expect(carol.locator('.costs-banners')).toContainText('You can view shared costs.');
      await expect(carol.locator('.costs-toolbar').getByRole('button', { name: 'Add private expense' })).toBeVisible();
      await addExpense(carol, { name: 'Pastel de nata', amount: '3.50' });
      await expect(entry(carol, 'Pastel de nata')).toContainText('Private');
      await carol.locator('.costs-entry-main').filter({ hasText: 'Tram' }).click();
      const tram = carol.getByRole('dialog', { name: 'Tram' });
      await expect(tram.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await carol.keyboard.press('Escape');
      await audit(carol);
      await noOverflow(carol);

      const alice = await w.open('alice', trip.hash('costs'));
      await expect(entry(alice, 'Tram')).toBeVisible();
      await expect(entry(alice, 'Pastel de nata')).toHaveCount(0);
      const csv = await download(alice, () => choose(alice, alice.getByRole('button', { name: 'More cost actions' }), 'Export CSV'));
      expect(csv.name).toMatch(/\.csv$/);
      expect(csv.text.charCodeAt(0)).toBe(0xfeff);
      const lines = csv.text.slice(1).trim().split(/\r?\n/);
      expect(lines[0].split(';')).toContain('Amount in trip currency (EUR)');
      expect(lines.some((line) => line.includes('"Coffee; cake"'))).toBe(true);
      expect(csv.text).not.toContain('Pastel de nata');

      await choose(alice, alice.getByRole('button', { name: 'More cost actions' }), 'Split costs between people');
      await expect(alice.locator('.costs-stats .stat')).toHaveCount(1);
      await tab(alice, 'Balances');
      await expect(alice.getByRole('heading', { name: 'Splitting is off' })).toBeVisible();
      await audit(alice);
      const bob = await w.open('bob', trip.hash('costs'));
      await expect(bob.locator('.costs-stats .stat')).toHaveCount(1);
      await alice.getByRole('button', { name: 'Split costs', exact: true }).click();
      await expect(bob.locator('.costs-stats .stat')).toHaveCount(4);

      await failNextCommit(bob, 402, 'owner_credit', { times: Infinity });
      await addExpense(bob, { name: 'Ferry', amount: '8' });
      await expect(bob.locator('.costs-banners')).toContainText('Puter credit ran out');
      await audit(bob);
      await stopFailingCommits(bob);
      await bob.locator('.app-sync').getByRole('button', { name: 'Retry' }).click();
      await tab(alice, 'Expenses');
      await expect(entry(alice, 'Ferry')).toBeVisible();
      await expect(bob.locator('.costs-banners')).not.toContainText('Puter credit ran out');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('expenses are added and reordered with the keyboard', async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'Keyboard path runs on the desktop projects');
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      await seed(w, 'alice', trip.ref, [
        exp('a', 'Breakfast', 1200, USERS.alice.uuid, [USERS.alice.uuid, USERS.bob.uuid], { order: 'a' }),
        exp('b', 'Lunch', 2400, USERS.alice.uuid, [USERS.alice.uuid, USERS.bob.uuid], { order: 'b' }),
      ]);
      const bob = await w.open('bob', trip.hash('costs'));
      const alice = await w.open('alice', trip.hash('costs'));
      const names = alice.locator('.costs-entry-name');
      await expect(names).toHaveText(['Breakfast', 'Lunch']);
      await tabTo(alice, alice.locator('.costs-toolbar').getByRole('button', { name: 'Add expense' }));
      await alice.keyboard.press('Enter');
      const form = alice.getByRole('dialog', { name: 'New expense' });
      await expect(form.getByLabel('Name', { exact: true })).toBeFocused();
      await alice.keyboard.type('Gelato');
      await alice.keyboard.press('Tab');
      await alice.keyboard.type('6');
      await alice.keyboard.press('Enter');
      await expect(form).toBeHidden();
      await expect(entry(alice, 'Gelato')).toBeVisible();

      const grip = entry(alice, 'Lunch').locator('[data-sortable-handle]');
      await tabTo(alice, grip);
      await alice.keyboard.press('Alt+ArrowUp');
      await expect(alice.locator('.costs-day').filter({ hasText: 'Tue, Nov 3, 2026' }).locator('.costs-entry-name')).toHaveText(['Lunch', 'Breakfast']);
      await expect(bob.locator('.costs-day').filter({ hasText: 'Tue, Nov 3, 2026' }).locator('.costs-entry-name')).toHaveText(['Lunch', 'Breakfast']);

      await tab(alice, 'Overview');
      await alice.getByRole('button', { name: 'Reorder categories' }).click();
      const order = alice.getByRole('dialog', { name: 'Reorder categories' });
      const handle = order.locator('[data-cat="groceries"] [data-sortable-handle]');
      await handle.focus();
      await alice.keyboard.press('Alt+ArrowUp');
      await expect(order.locator('li[data-cat]').nth(1)).toHaveAttribute('data-cat', 'groceries');
      await order.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(order).toBeHidden();
      await expect(alice.locator('.costs-bars .costs-bar-row').first()).toContainText('Food & drink');
      await synced(alice);
      const later = await w.open('bob', trip.hash('costs'));
      await later.locator('.costs-toolbar').getByRole('button', { name: 'Add expense' }).click();
      await expect(later.getByRole('dialog', { name: 'New expense' }).getByLabel('Category', { exact: true }).locator('option').nth(1)).toHaveText('Groceries');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });
});
