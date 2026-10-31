import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow, USERS } from './helpers/bridge-world.js';
import { choose, download, failNextCommit, patientWorld, seed, setOnline, stopFailingCommits, synced, tabTo, tripFor } from './helpers/trip-flows.js';

const DATES = { start: '2026-11-02', end: '2026-11-05' };
const pane = (page, name) => page.locator('.lists-pane').filter({ has: page.getByRole('heading', { name, exact: true, level: 2 }) });
const group = (page, name) => page.locator('.list-group').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) });
const item = (page, name) => page.locator('.lists-row').filter({ has: page.locator('.lists-name', { hasText: new RegExp(`^${name}$`) }) });
const bag = (page, name) => page.locator('.lists-bag').filter({ has: page.getByRole('button', { name, exact: true }) });

async function addList(page, name) {
  await pane(page, 'Packing').getByRole('button', { name: 'Add list' }).first().click();
  const prompt = page.getByRole('dialog', { name: 'New list' });
  await prompt.getByLabel('List name').fill(name);
  await prompt.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(group(page, name)).toBeVisible();
}
async function addItems(page, list, names, { mine = false } = {}) {
  const input = page.getByRole('textbox', { name: mine ? `Add a private item to ${list}` : `Add an item to ${list}`, exact: true });
  for (const name of names) {
    await input.fill(name);
    await input.press('Enter');
    await expect(item(page, name.replace(/^\d+x /, ''))).toBeVisible();
  }
}

const meta = (key, name, order, extra = {}) => ({ key, type: 'listMeta', fields: { kind: 'pack', name, order, color: 1, ...extra } });
const pack = (key, name, list, order, extra = {}) => ({ key, type: 'pack', fields: { name, list, order, owner: USERS.alice.uuid, ...extra } });

test.describe('lists', () => {
  test('Alice builds lists and bags, Bob pledges and checks his own, and Carol keeps a private list', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
    try {
      const trip = await tripFor(w, { ...DATES, roles: { bob: 'editor', carol: 'viewer' } });
      const alice = await w.open('alice', trip.hash('lists'));
      await expect(alice.getByRole('heading', { name: 'Nothing to pack yet' })).toBeVisible();
      await audit(alice);
      await addList(alice, 'Clothes');
      await addItems(alice, 'Clothes', ['3x Socks', 'Jacket']);
      await expect(item(alice, 'Socks')).toContainText('×3');

      await alice.getByRole('button', { name: 'Add bag' }).click();
      const bagForm = alice.getByRole('dialog', { name: 'Add bag' });
      await bagForm.getByLabel('Bag name').fill('Carry-on');
      await bagForm.getByLabel(/^Weight limit/).fill('15');
      await bagForm.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(bag(alice, 'Carry-on')).toBeVisible();
      await item(alice, 'Jacket').getByRole('button', { name: 'Jacket', exact: true }).click();
      const edit = alice.getByRole('dialog', { name: 'Edit item' });
      await edit.getByLabel(/^Weight each/).fill('2.5');
      await edit.getByLabel('Bag', { exact: true }).selectOption({ label: 'Carry-on' });
      await audit(alice);
      await edit.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(bag(alice, 'Carry-on')).toContainText('2.5 lb of 15 lb');
      await choose(alice, alice.getByRole('button', { name: 'More packing actions' }), 'Everyone checks their own items');

      const bob = await w.open('bob', trip.hash('lists'));
      await expect(item(bob, 'Socks')).toContainText('0 of 3 packed');
      await bob.getByRole('checkbox', { name: 'Packed: Socks' }).check();
      await expect(bob.locator('.lists-progress')).toContainText('You packed 1 of 2');
      await choose(bob, bob.getByRole('button', { name: 'Actions for Jacket' }), 'I can bring this');
      await expect(item(alice, 'Socks')).toContainText('1 of 3 packed');
      await expect(item(alice, 'Jacket')).toContainText('bob can bring it');
      await expect(alice.getByRole('checkbox', { name: 'Packed: Socks' })).not.toBeChecked();

      const carol = await w.open('carol', trip.hash('lists'));
      await expect(pane(carol, 'Packing').getByRole('button', { name: 'Add list' })).toBeHidden();
      await expect(carol.getByRole('textbox', { name: 'Add an item to Clothes' })).toHaveCount(0);
      await carol.getByRole('checkbox', { name: 'Packed: Socks' }).check();
      await expect(item(bob, 'Socks')).toContainText('2 of 3 packed');
      await carol.getByRole('button', { name: 'My list', exact: true }).click();
      await addItems(carol, 'Clothes', ['Sunglasses'], { mine: true });
      await expect(item(carol, 'Sunglasses')).toContainText('Private');
      await audit(carol);
      await noOverflow(carol);
      await capture(carol, testInfo, 'lists-viewer');

      for (const page of [alice, bob]) {
        await page.getByRole('button', { name: 'My list', exact: true }).click();
        await expect(item(page, 'Sunglasses')).toHaveCount(0);
        await page.getByRole('button', { name: 'Shared', exact: true }).click();
        await expect(item(page, 'Sunglasses')).toHaveCount(0);
      }
      await bag(bob, 'Carry-on').getByRole('button', { name: 'Carry-on', exact: true }).click();
      await expect(bob.locator('.lists-rows .lists-row')).toHaveCount(1);
      await expect(item(bob, 'Jacket')).toBeVisible();
      await audit(bob);
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('offline adds and checks sync on reconnect, and a stale item edit reaches the conflict dialog', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      await seed(w, 'alice', trip.ref, [meta('c', 'Clothes', 'a'), pack('s', 'Socks', 'Clothes', 'a'), pack('j', 'Jacket', 'Clothes', 'b')]);
      const alice = await w.open('alice', trip.hash('lists'));
      const bob = await w.open('bob', trip.hash('lists'));
      await expect(item(bob, 'Jacket')).toBeVisible();

      const aliceContext = await w.context('alice');
      await setOnline(aliceContext, false);
      await addItems(alice, 'Clothes', ['Charger']);
      await alice.getByRole('checkbox', { name: 'Packed: Socks' }).check();
      await expect(item(bob, 'Charger')).toHaveCount(0);
      await setOnline(aliceContext, true);
      await expect(item(bob, 'Charger')).toBeVisible();
      await expect(bob.getByRole('checkbox', { name: 'Packed: Socks' })).toBeChecked();
      await synced(alice);

      // Bob renames Jacket while Alice has it open; her save then parks a conflict instead of overwriting.
      await item(alice, 'Jacket').getByRole('button', { name: 'Jacket', exact: true }).click();
      const mine = alice.getByRole('dialog', { name: 'Edit item' });
      await item(bob, 'Jacket').getByRole('button', { name: 'Jacket', exact: true }).click();
      const theirs = bob.getByRole('dialog', { name: 'Edit item' });
      await theirs.getByLabel('Name', { exact: true }).fill('Rain jacket');
      await theirs.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(item(alice, 'Rain jacket')).toBeVisible();
      await mine.getByLabel('Name', { exact: true }).fill('Warm jacket');
      await mine.getByRole('button', { name: 'Save', exact: true }).click();
      const banner = alice.locator('.lists-banner');
      await expect(banner).toContainText('1 list change could not be saved as it was.');
      await audit(alice);
      await banner.getByRole('button', { name: 'Review' }).click();
      const conflict = alice.getByRole('dialog', { name: 'Resolve a conflict' });
      await expect(conflict).toContainText('Rain jacket');
      await conflict.getByRole('button', { name: 'Keep mine', exact: true }).click();
      await expect(banner).toBeHidden();
      await expect(item(bob, 'Warm jacket')).toBeVisible();
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('pasted rows bring new lists and bags, starter and saved templates apply, and a template downloads', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const alice = await w.open('alice', trip.hash('lists'));
      await pane(alice, 'Packing').getByRole('button', { name: 'Import', exact: true }).click();
      let dialog = alice.getByRole('dialog', { name: 'Import packing items' });
      await dialog.getByRole('tab', { name: 'Paste or file' }).click();
      await dialog.getByLabel('Items', { exact: true }).fill('List;Name;Weight;Bag;Checked\nClothes;2x Shirts;300g;Carry-on;\nToiletries;Toothbrush;50g;Wash bag;x');
      await expect(dialog.locator('.lists-preview').first()).toHaveText('2 items · 2 lists · 2 bags');
      await audit(alice);
      await dialog.getByRole('button', { name: 'Add items' }).click();
      await expect(alice.locator('.toast').filter({ hasText: '2 items added' })).toBeVisible();

      const bob = await w.open('bob', trip.hash('lists'));
      await expect(group(bob, 'Toiletries')).toBeVisible();
      await expect(bob.getByRole('checkbox', { name: 'Packed: Toothbrush' })).toBeChecked();
      await expect(bag(bob, 'Wash bag')).toContainText('1 item');
      await expect(item(bob, 'Shirts')).toContainText('×2');

      await pane(alice, 'Packing').getByRole('button', { name: 'Import', exact: true }).click();
      dialog = alice.getByRole('dialog', { name: 'Import packing items' });
      await dialog.getByRole('radio', { name: /^Beach/ }).click();
      await dialog.getByRole('button', { name: 'Add items' }).click();
      await expect(group(bob, 'Beach')).toBeVisible();
      await expect(item(bob, 'Sunscreen')).toBeVisible();

      await choose(alice, alice.getByRole('button', { name: 'More packing actions' }), 'Save as template');
      const save = alice.getByRole('dialog', { name: 'Save as template' });
      await save.getByLabel('Template name').fill('Lisbon packing');
      const file = await download(alice, () => save.getByRole('button', { name: 'Download as a file' }).click());
      const template = JSON.parse(file.text);
      expect(file.name).toMatch(/\.json$/);
      expect(JSON.stringify(template)).toContain('Toothbrush');
      await save.getByRole('button', { name: 'Save template' }).click();
      await expect(alice.locator('.toast').filter({ hasText: 'Template “Lisbon packing” saved' })).toBeVisible();

      const other = await tripFor(w, { title: 'Porto', roles: {} });
      const porto = await w.open('alice', other.hash('lists'));
      await porto.getByRole('button', { name: 'Apply a template' }).click();
      dialog = porto.getByRole('dialog', { name: 'Import packing items' });
      await dialog.getByRole('radio', { name: /^Lisbon packing/ }).click();
      await dialog.getByRole('button', { name: 'Add items' }).click();
      await expect(item(porto, 'Toothbrush')).toBeVisible();
      await expect(item(porto, 'Sunscreen')).toBeVisible();
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('to-dos with an assignee, due date and priority remind the assignee and filter', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const alice = await w.open('alice', trip.hash('lists'));
      await alice.getByRole('tab', { name: 'To-dos' }).click();
      const todos = pane(alice, 'To-dos');
      await expect(todos.getByRole('heading', { name: 'No to-dos yet' })).toBeVisible();
      await audit(alice);
      await todos.getByRole('button', { name: 'Add list' }).first().click();
      await alice.getByRole('dialog', { name: 'New list' }).getByLabel('List name').fill('Before');
      await alice.getByRole('dialog', { name: 'New list' }).getByRole('button', { name: 'Add', exact: true }).click();
      const input = todos.getByRole('textbox', { name: 'Add a to-do to Before' });
      for (const name of ['Buy insurance', 'Check in online']) { await input.fill(name); await input.press('Enter'); }
      await todos.getByRole('button', { name: 'Buy insurance', exact: true }).click();
      const detail = alice.getByRole('dialog', { name: 'To-do' });
      await detail.getByLabel('Due date').fill('2026-01-10');
      await detail.getByLabel('Due date').blur();
      await detail.getByRole('button', { name: 'P1', exact: true }).click();
      await detail.getByLabel('Assigned to').selectOption({ label: 'bob' });
      await detail.getByLabel('Notes', { exact: true }).fill('**Policy** number in the [portal](https://example.com)');
      await detail.getByLabel('Notes', { exact: true }).blur();
      await detail.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(detail.locator('strong')).toHaveText('Policy');
      await expect(detail.getByRole('link', { name: /portal/ })).toHaveAttribute('href', 'https://example.com/');
      await audit(alice);
      await alice.keyboard.press('Escape');
      await expect(todos.locator('.lists-row').filter({ hasText: 'Buy insurance' })).toContainText('Overdue');

      const bob = await w.open('bob', trip.hash('lists'));
      await expect(bob.locator('.toast').filter({ hasText: '1 to-do is due' })).toBeVisible();
      await expect(bob.locator('.lists-badge')).toHaveText('1');
      await bob.getByRole('tab', { name: /^To-dos/ }).click();
      const bobTodos = pane(bob, 'To-dos');
      await expect(bobTodos.locator('.lists-row .lists-name')).toHaveText(['Buy insurance', 'Check in online']);
      await bobTodos.getByRole('button', { name: 'Mine', exact: true }).click();
      await expect(bobTodos.locator('.lists-row')).toHaveText([/Buy insurance/]);
      await bobTodos.getByRole('button', { name: 'All', exact: true }).click();
      await bobTodos.getByLabel('Sort by').selectOption({ label: 'Priority' });
      await expect(bobTodos.locator('.lists-row .lists-name')).toHaveText(['Buy insurance', 'Check in online']);
      await bobTodos.getByRole('checkbox', { name: 'Done: Buy insurance' }).check();
      await expect(alice.getByRole('checkbox', { name: 'Done: Buy insurance' })).toBeChecked();
      await expect(bob.locator('.lists-badge')).toBeHidden();
      await audit(bob);
      await noOverflow(bob);
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('items and lists reorder with Alt+Arrow from the keyboard', async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'Keyboard path runs on the desktop projects');
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      await seed(w, 'alice', trip.ref, [meta('c', 'Clothes', 'a'), meta('t', 'Toiletries', 'b'), pack('s', 'Socks', 'Clothes', 'a'), pack('j', 'Jacket', 'Clothes', 'b'), pack('b', 'Toothbrush', 'Toiletries', 'a')]);
      const bob = await w.open('bob', trip.hash('lists'));
      const alice = await w.open('alice', trip.hash('lists'));
      await expect(group(alice, 'Clothes').locator('.lists-name')).toHaveText(['Socks', 'Jacket']);
      await tabTo(alice, item(alice, 'Jacket').locator('[data-sortable-handle]'));
      await alice.keyboard.press('Alt+ArrowUp');
      await expect(group(alice, 'Clothes').locator('.lists-name')).toHaveText(['Jacket', 'Socks']);
      await expect(group(bob, 'Clothes').locator('.lists-name')).toHaveText(['Jacket', 'Socks']);
      await tabTo(alice, group(alice, 'Toiletries').locator('.list-group-grip'), { back: true });
      await alice.keyboard.press('Alt+ArrowUp');
      await expect(bob.locator('.list-group-title')).toHaveText(['Toiletries', 'Clothes']);
      await tabTo(alice, alice.getByRole('textbox', { name: 'Add an item to Toiletries' }));
      await alice.keyboard.type('Floss');
      await alice.keyboard.press('Enter');
      await expect(group(bob, 'Toiletries').locator('.lists-name')).toHaveText(['Toothbrush', 'Floss']);
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('credit and offline states reach the lists through the sync footer', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      await seed(w, 'alice', trip.ref, [meta('c', 'Clothes', 'a')]);
      const alice = await w.open('alice', trip.hash('lists'));
      const bob = await w.open('bob', trip.hash('lists'));
      await failNextCommit(bob, 402, 'owner_credit', { times: Infinity });
      await addItems(bob, 'Clothes', ['Umbrella']);
      await expect(bob.locator('.app-sync .save-state')).toHaveAttribute('data-state', 'credit');
      await expect(item(alice, 'Umbrella')).toHaveCount(0);
      await stopFailingCommits(bob);
      await bob.locator('.app-sync').getByRole('button', { name: 'Retry' }).click();
      await expect(item(alice, 'Umbrella')).toBeVisible();
      await failNextCommit(bob, 403, 'forbidden');
      await bob.getByRole('checkbox', { name: 'Packed: Umbrella' }).check();
      await expect(bob.locator('.toast').filter({ hasText: 'A change was refused' })).toBeVisible();
      await expect(bob.getByRole('checkbox', { name: 'Packed: Umbrella' })).not.toBeChecked();
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });
});
