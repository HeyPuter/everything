import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';
import { planPane, press, seed, synced, tripMenu } from './helpers/trip-tools.js';

// The assistant runs on the scripted `puter.ai` in mock.html (dev/fake-puter/ai.js): "pack" proposes packing items,
// "to-do" to-dos, "plan" visits on day 1, "dates" a re-date, "summary" reads the trip summary tool.
const DATES = { start: '2026-11-02', end: '2026-11-04' };
const DAYS = [
  { type: 'day', fields: { order: 'a', date: '2026-11-02', title: 'Old town' } },
  { type: 'day', fields: { order: 'b', date: '2026-11-03' } },
  { type: 'day', fields: { order: 'c', date: '2026-11-04' } },
  { type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216 } },
];

async function openPanel(page) {
  await tripMenu(page, 'Ask the trip assistant');
  const panel = page.locator('aside.as-panel');
  await expect(panel.getByRole('heading', { name: 'Assistant' })).toBeVisible();
  return panel;
}
async function ask(panel, text, { keyboard = false } = {}) {
  const input = panel.getByLabel('Message the assistant');
  await input.fill(text);
  if (keyboard) await input.press('Enter');
  else await panel.getByRole('button', { name: 'Send', exact: true }).click();
}
const card = (panel, title) => panel.locator('.as-card', { has: panel.page().locator('.as-card-title', { hasText: title }) }).last();
const listNames = (page) => page.locator('.lists-item-title').allTextContents();
const aiCalls = (page) => page.evaluate(() => globalThis.__TRIPS_AI__.calls());

let w;
test.afterEach(async () => { expect(w?.errors ?? []).toEqual([]); await w?.close(); w = null; });

test('a streamed proposal is applied only after approval, the editor sees it, and Undo reverts it', async ({ browser, baseURL }, testInfo) => {
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  await seed(w, 'alice', trip.ref, DAYS);
  const bob = await w.open('bob', trip.hash('lists'));
  await expect(bob.getByRole('tab', { name: 'Packing' })).toBeVisible();

  const alice = await w.open('alice', trip.hash('settings'));
  await synced(alice);
  const panel = await openPanel(alice);
  await expect(panel.getByText('Ask about this trip', { exact: true })).toBeVisible();
  await expect(panel.locator('.as-hint')).toHaveText('Nothing changes until you approve it. Uses your Puter credit.');
  await audit(alice); await noOverflow(alice); await capture(alice, testInfo, 'assistant-empty');

  await ask(panel, 'What should I pack for this trip?');
  const proposal = card(panel, 'Add to the packing list');
  await expect(proposal).toHaveAttribute('data-status', 'waiting');
  await expect(proposal.locator('.as-row')).toHaveText([
    'Add: New list “Documents”', 'Add: New list “Electronics”', 'Add: New list “Toiletries”',
    'Add: Passport · in “Documents”', 'Add: Phone charger · in “Electronics”', 'Add: Sunscreen · in “Toiletries”',
  ].map((text) => `+${text}`));
  await expect(panel.locator('.as-bot').first()).toHaveText('Here are a few things to pack.');
  const calls = await aiCalls(alice);
  expect(calls[0]).toMatchObject({ kind: 'assistant', stream: true });
  expect(calls[0].tools).toBeGreaterThan(5);
  await audit(alice); await capture(alice, testInfo, 'assistant-proposal');
  // Nothing is written while the card waits.
  expect(await listNames(bob)).toEqual([]);

  await proposal.locator('[data-action=approve]').click();
  await expect(proposal).toHaveAttribute('data-status', 'applied');
  await expect(panel.locator('.as-bot').last()).toHaveText('Done. The change is in the trip.');
  await expect.poll(async () => (await listNames(bob)).sort()).toEqual(['Passport', 'Phone charger', 'Sunscreen']);

  await proposal.locator('[data-action=undo]').click();
  await expect(proposal).toContainText('Undone.');
  await expect.poll(() => listNames(bob)).toEqual([]);
});

test('Reject leaves the trip alone, a change during review is shown again, and visits and dates go through their flows', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  await seed(w, 'alice', trip.ref, DAYS);
  const alice = await w.open('alice', trip.hash('lists'));
  const bob = await w.open('bob', trip.hash('plan'));
  const panel = await openPanel(alice);

  await ask(panel, 'Which to-dos should we add?', { keyboard: true });
  const todos = card(panel, 'Add to-dos');
  await expect(todos).toHaveAttribute('data-status', 'waiting');
  await press(todos.locator('[data-action=reject]'));
  await expect(todos).toHaveAttribute('data-status', 'declined');
  await expect(panel.locator('.as-bot').last()).toHaveText('All right, I left the trip as it is. What would you like instead?');

  // Bob adds one of the proposed items while Alice reviews: Apply shows the updated proposal first.
  await ask(panel, 'Anything to pack?', { keyboard: true });
  const packing = card(panel, 'Add to the packing list');
  await expect(packing).toHaveAttribute('data-status', 'waiting');
  await seed(w, 'bob', trip.ref, [{ type: 'pack', fields: { name: 'Passport', list: 'Documents', order: 'a' } }]);
  await expect.poll(() => listNames(alice)).toEqual(['Passport']);
  await press(packing.locator('[data-action=approve]'));
  await expect(packing.getByText('The trip changed while you were reviewing. This is the updated change.')).toBeVisible();
  await expect(packing.locator('.as-row').first()).toContainText('Passport is already on the list');
  await press(packing.locator('[data-action=approve]'));
  await expect(packing).toHaveAttribute('data-status', 'applied');
  await expect.poll(async () => (await listNames(alice)).sort()).toEqual(['Passport', 'Phone charger', 'Sunscreen']);

  await ask(panel, 'Plan the first day for us', { keyboard: true });
  const visits = card(panel, 'Add to Day 1');
  await expect(visits.locator('.as-row')).toHaveText([/Walk through the old town · 10:00/, /Lunch at a local market · 12:30/]);
  await press(visits.locator('[data-action=approve]'));
  await expect(visits).toHaveAttribute('data-status', 'applied');
  await planPane(bob, 'Plan');
  await expect(bob.locator('.plan-days-pane')).toContainText('Walk through the old town');
  await expect(bob.locator('.plan-days-pane')).toContainText('Lunch at a local market');

  // A date change is a suggestion: it opens the re-date preview, which applies on confirm.
  await ask(panel, 'Can we move the dates a week later?', { keyboard: true });
  const dates = card(panel, 'New trip dates');
  await expect(dates).toHaveAttribute('data-status', 'waiting');
  await press(dates.getByRole('button', { name: 'Review date change', exact: true }));
  const redate = alice.getByRole('dialog', { name: 'Change trip dates' });
  await expect(redate).toContainText('Nov 9 – 11, 2026');
  await press(redate.getByRole('button', { name: 'Change dates', exact: true }));
  await expect(redate).toBeHidden();
  const bobSettings = await w.open('bob', trip.hash('settings'));
  await expect(bobSettings.locator('.trip-subtitle')).toHaveText('Nov 9 – 11, 2026');
});

test('a viewer can ask but not change the trip, and failures explain themselves', async ({ browser, baseURL }, testInfo) => {
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES, role: 'viewer' });
  await seed(w, 'alice', trip.ref, DAYS);
  const page = await w.open('bob', trip.hash('settings'));
  await synced(page);
  const panel = await openPanel(page);
  await expect(panel.locator('.as-hint')).toHaveText('You can ask questions. Changing the trip needs edit access.');
  await expect(panel.getByRole('button', { name: 'Give me a quick overview of the trip' })).toBeVisible();

  await panel.getByRole('button', { name: 'Give me a quick overview of the trip' }).click();
  await expect(panel.locator('.as-step', { hasText: 'Read the trip summary' })).toHaveAttribute('data-status', 'done');
  await expect(panel.locator('.as-bot').last()).toHaveText('Lisbon has 3 days and 1 saved place.');

  await ask(panel, 'What should I pack?');
  await expect(panel.locator('.as-bot').last()).toHaveText('You can view this trip but not change it, so I can only describe it.');
  expect((await aiCalls(page)).at(-1).tools).toBeGreaterThan(0);
  await expect(panel.locator('.as-card')).toHaveCount(0);

  await page.evaluate(() => globalThis.__TRIPS_AI__.fail('credit', { times: 1 }));
  await ask(panel, 'Summary please');
  await expect(panel.locator('.as-error')).toContainText('You’re out of Puter credit.');
  await expect(panel.locator('.as-error').getByRole('button', { name: 'Try again' })).toHaveCount(0);

  await page.evaluate(() => globalThis.__TRIPS_AI__.fail('usage', { times: 1 }));
  await ask(panel, 'Summary please');
  const limited = panel.locator('.as-error').last();
  await expect(limited).toContainText('You’ve reached an AI usage limit.');
  await audit(page);
  await limited.getByRole('button', { name: 'Try again' }).click();
  await expect(panel.locator('.as-bot').last()).toHaveText('Lisbon has 3 days and 1 saved place.');

  await page.context().setOffline(true);
  await expect(panel.locator('.as-hint')).toHaveText('You’re offline. The assistant needs a connection.');
  await panel.getByLabel('Message the assistant').fill('Anything?');
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.context().setOffline(false);
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('the panel works by keyboard: Enter sends, Shift+Enter adds a line, Escape closes and returns focus', async ({ browser, baseURL }, testInfo) => {
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  await seed(w, 'alice', trip.ref, DAYS);
  const page = await w.open('alice', trip.hash('settings'));
  await synced(page);
  const menu = page.getByRole('button', { name: 'Trip actions', exact: true });
  await menu.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Ask the trip assistant', exact: true }).focus();
  await page.keyboard.press('Enter');
  const panel = page.locator('aside.as-panel');
  const input = panel.getByLabel('Message the assistant');
  if (testInfo.project.use.viewport.width >= 640) await expect(input).toBeFocused();
  else { await expect(panel.getByRole('heading', { name: 'Assistant' })).toBeFocused(); await input.focus(); }

  await page.keyboard.type('Give me a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('summary');
  await expect(input).toHaveValue('Give me a\nsummary');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.as-user')).toHaveText('Give me a\nsummary');
  await expect(panel.locator('.as-bot').last()).toHaveText('Lisbon has 3 days and 1 saved place.');
  await expect(input).toHaveValue('');

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(menu).toBeFocused();
});
