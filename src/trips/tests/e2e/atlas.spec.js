import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow, USERS } from './helpers/bridge-world.js';
import { toastText } from './helpers/spaces.js';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

const FLIGHT = [
  { from: { code: 'LIS', lat: 38.7742, lng: -9.1342 }, to: { code: 'FRA', lat: 50.0379, lng: 8.5622 }, dep: { date: '2025-05-06', time: '08:00' }, arr: { date: '2025-05-06', time: '12:00' } },
  { from: { code: 'FRA', lat: 50.0379, lng: 8.5622 }, to: { code: 'HEL', lat: 60.3172, lng: 24.9633 }, dep: { date: '2025-05-06', time: '13:00' }, arr: { date: '2025-05-06', time: '16:00' } },
];

/**
 * Alice: a past trip (Portugal and Spain, a two-leg flight to Helsinki through Frankfurt, a cancelled flight to Oslo),
 * an upcoming trip to Rome that Bob joins, and an undated trip to Tokyo. Returns the Rome trip ref and its place id.
 */
async function seed(w) {
  const page = await w.open('alice');
  await expect(page.locator('html')).toHaveAttribute('data-worker', 'ready');
  const seeded = await page.evaluate(async (flight) => {
    const past = await trips.createTrip({ title: 'Iberia', start: '2025-05-01', end: '2025-05-06' });
    await trips.open(past);
    await trips.create(past, 'place', { name: 'Belém Tower', lat: 38.6916, lng: -9.2160, cc: 'PT', admin1: 'PT-11' });
    await trips.create(past, 'place', { name: 'Prado', lat: 40.4138, lng: -3.6921 });
    await trips.create(past, 'res', { type: 'flight', title: 'Lisbon to Helsinki', status: 'confirmed', legs: flight });
    await trips.create(past, 'res', { type: 'flight', title: 'Lisbon to Oslo', status: 'cancelled', legs: [{ ...flight[0], to: { code: 'OSL', lat: 60.1976, lng: 11.1004 } }] });
    await trips.flush(past);
    const future = await trips.createTrip({ title: 'Rome', start: '2027-03-01', end: '2027-03-05' });
    await trips.open(future);
    const colosseum = await trips.create(future, 'place', { name: 'Colosseum', lat: 41.8902, lng: 12.4922 });
    await trips.flush(future);
    const undated = await trips.createTrip({ title: 'Someday Japan' });
    await trips.open(undated);
    await trips.create(undated, 'place', { name: 'Senso-ji', lat: 35.7148, lng: 139.7967 });
    await trips.flush(undated);
    const { token } = await trips.invite(future, { role: 'editor' });
    return { future, colosseum, token };
  }, FLIGHT);
  await page.close();
  return seeded;
}

const tile = (page, label) => page.locator('.atlas-stat').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) });
const stat = (page, label) => tile(page, label).locator('dd strong');
const row = (page, name) => page.locator('.atlas-row').filter({ has: page.locator('.atlas-row-name', { hasText: name }) });
const section = (page, title) => page.locator('.atlas-section').filter({ has: page.locator('h3', { hasText: title }) });

async function openAtlas(w, as) {
  const page = await w.open(as, '#/atlas');
  await expect(page.locator('.atlas-stat-loading')).toHaveCount(0);
  return page;
}

test('visited, planned and per-person marks; search, mark, hide and regions by two users', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const { future, colosseum, token } = await seed(w);

    // Bob joins the Rome trip and marks the Colosseum visited: Italy counts for him only.
    const join = await w.open('bob', `#/join/${future.w}/${future.s}/${token}`);
    await join.getByRole('button', { name: 'Join trip', exact: true }).click();
    await join.waitForURL((url) => url.hash.startsWith(`#/t/${future.w}/${future.s}`));
    await join.evaluate(async ([ref, id, uuid]) => {
      await trips.deploy();
      await trips.open(ref);
      await trips.patch(ref, 'place', id, { [`visited.${uuid}`]: true });
      await trips.flush(ref);
    }, [future, colosseum, USERS.bob.uuid]);
    await join.close();

    const alice = await openAtlas(w, 'alice');
    await expect(stat(alice, 'Countries')).toHaveText('3');
    await expect(tile(alice, 'Countries')).toContainText('+1 planned');
    await expect(section(alice, 'Visited').locator('.atlas-row-name')).toHaveText(['Spain', 'Finland', 'Portugal']);
    await expect(section(alice, 'Planned').locator('.atlas-row-name')).toHaveText(['Italy']);
    // The layover and the undated trip stay out.
    await expect(row(alice, 'Germany')).toHaveCount(0);
    await expect(row(alice, 'Japan')).toHaveCount(0);
    await expect(stat(alice, 'Trips')).toHaveText('1');
    await expect(stat(alice, 'Places')).toHaveText('2');
    await audit(alice); await noOverflow(alice);
    await capture(alice, testInfo, 'atlas-owner');

    const bob = await openAtlas(w, 'bob');
    await expect(stat(bob, 'Countries')).toHaveText('1');
    await expect(section(bob, 'Visited').locator('.atlas-row-name')).toHaveText(['Italy']);
    await audit(bob);

    // Show planned off hides Italy for Alice.
    await alice.getByRole('switch', { name: 'Show planned' }).click();
    await expect(section(alice, 'Planned')).toHaveCount(0);
    await alice.getByRole('switch', { name: 'Show planned' }).click();

    // Keyboard: search, open a row, mark, Escape back to the row.
    const search = alice.getByRole('searchbox', { name: 'Find a country' });
    await search.focus();
    await alice.keyboard.type('cote');
    await expect(row(alice, 'Côte d’Ivoire')).toBeVisible();
    await alice.keyboard.press('Tab');
    await expect(row(alice, 'Côte d’Ivoire')).toBeFocused();
    await alice.keyboard.press('Enter');
    await expect(alice.locator('.atlas-detail-title')).toBeFocused();
    await expect(alice.locator('.atlas-detail-title')).toHaveText('Côte d’Ivoire');
    await audit(alice);
    await alice.getByRole('button', { name: 'Mark as visited' }).click();
    await toastText(alice, 'Marked Côte d’Ivoire as visited.');
    await expect(stat(alice, 'Countries')).toHaveText('4');
    await alice.getByRole('button', { name: 'Remove my mark' }).focus();
    await alice.keyboard.press('Escape');
    await expect(row(alice, 'Côte d’Ivoire')).toBeFocused();

    // A second tab of Alice sees the mark; Bob's atlas does not.
    const again = await openAtlas(w, 'alice');
    await expect(stat(again, 'Countries')).toHaveText('4');
    await again.close();
    await expect(stat(bob, 'Countries')).toHaveText('1');

    // Hide an auto-detected country, then show it again.
    await search.fill('');
    await row(alice, 'Spain').click();
    await alice.getByRole('button', { name: 'Hide from atlas' }).click();
    await toastText(alice, 'Hid Spain.');
    await alice.getByRole('button', { name: 'All countries' }).click();
    await expect(section(alice, 'Hidden').locator('.atlas-row-name')).toHaveText(['Spain']);
    await expect(stat(alice, 'Countries')).toHaveText('3');
    await alice.getByRole('button', { name: 'Show Spain in the atlas' }).click();
    await expect(section(alice, 'Hidden')).toHaveCount(0);
    await expect(stat(alice, 'Countries')).toHaveText('4');

    // Regions: Lisbon is visited from the trip; mark another by hand.
    await row(alice, 'Portugal').click();
    const lisbon = alice.locator('.atlas-region[data-code="PT-11"]');
    await expect(lisbon).toHaveAttribute('data-status', 'visited');
    await expect(alice.locator('.atlas-subhead').filter({ hasText: 'Regions' })).toContainText(/1 of \d+/);
    await alice.getByRole('button', { name: 'Mark Porto as visited' }).click();
    await expect(alice.locator('.atlas-region[data-code="PT-13"]')).toHaveAttribute('data-status', 'visited');
    await expect(alice.locator('.atlas-subhead').filter({ hasText: 'Regions' })).toContainText(/2 of \d+/);
    await audit(alice); await noOverflow(alice);
    await capture(alice, testInfo, 'atlas-country');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('bucket list and flights', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    await seed(w);
    const alice = await openAtlas(w, 'alice');

    await alice.getByRole('button', { name: 'Flights', exact: true }).click();
    await expect(alice.getByRole('heading', { name: 'Flights', level: 2 })).toBeVisible();
    const facts = alice.locator('.atlas-facts');
    await expect(facts.locator('div').filter({ hasText: 'Flights' }).locator('dd')).toHaveText('2');
    await expect(facts.locator('div').filter({ hasText: 'Airports' }).locator('dd')).toHaveText('3');
    await expect(tile(alice, 'Distance flown')).toContainText('2 flights');
    await audit(alice); await noOverflow(alice);

    await alice.getByRole('button', { name: 'Bucket list', exact: true }).click();
    await expect(alice.getByRole('heading', { name: 'Your bucket list is empty' })).toBeVisible();
    await audit(alice);
    await alice.getByRole('button', { name: 'Add to bucket list' }).click();
    const dialog = alice.getByRole('dialog', { name: 'Add to bucket list' });
    await dialog.getByLabel('Name', { exact: true }).fill('Machu Picchu');
    await dialog.getByLabel('Coordinates').fill('-13.1631, -72.5450');
    await dialog.getByLabel('Coordinates').blur();
    await expect(dialog.getByLabel('Country')).toHaveValue('PE');
    await audit(alice);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await toastText(alice, 'Saved to your bucket list.');
    await expect(section(alice, 'Want to go')).toContainText('Machu Picchu');

    // A whole country with no name.
    await alice.getByRole('button', { name: 'Add to bucket list' }).click();
    await dialog.getByLabel('Country').selectOption('NZ');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(section(alice, 'Want to go')).toContainText('New Zealand');

    await alice.getByRole('button', { name: 'Mark Machu Picchu as visited' }).click();
    await toastText(alice, 'Marked Machu Picchu as visited.');
    await expect(section(alice, 'Been there')).toContainText('Machu Picchu');
    await expect(stat(alice, 'Countries')).toHaveText('4');
    await audit(alice); await noOverflow(alice);
    await capture(alice, testInfo, 'atlas-bucket');

    await alice.getByRole('button', { name: 'Countries', exact: true }).click();
    await row(alice, 'Peru').click();
    await expect(alice.locator('.atlas-status')).toContainText('From your bucket list');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('offline and out-of-credit writes are refused with a message', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const alice = await openAtlas(w, 'alice');
    await expect(alice.getByRole('heading', { name: 'Your atlas is empty' })).toBeVisible();
    await audit(alice);
    const search = alice.getByRole('searchbox', { name: 'Find a country' });
    await search.fill('Chile');
    await row(alice, 'Chile').click();

    w.world.failNext({ method: 'kv.update', as: 'alice', status: 402 });
    await alice.getByRole('button', { name: 'Mark as visited' }).click();
    await toastText(alice, 'Your Puter account is out of credit, so the change wasn’t saved.');
    await expect(alice.getByRole('button', { name: 'Mark as visited' })).toBeVisible();

    await alice.context().setOffline(true);
    await expect(alice.getByText('You’re offline. The atlas shows what’s on this device.')).toBeVisible();
    await alice.getByRole('button', { name: 'Mark as visited' }).click();
    await toastText(alice, 'You’re offline. Try again when you’re connected.');
    await audit(alice);
    await alice.context().setOffline(false);
    await alice.getByRole('button', { name: 'Mark as visited' }).click();
    await toastText(alice, 'Marked Chile as visited.');
    await expect(stat(alice, 'Countries')).toHaveText('1');

    await alice.getByRole('button', { name: 'Bucket list', exact: true }).click();
    w.world.failNext({ method: 'kv.set', as: 'alice', status: 402 });
    w.world.failNext({ method: 'kv.update', as: 'alice', status: 402 });
    await alice.getByRole('button', { name: 'Add to bucket list' }).click();
    const dialog = alice.getByRole('dialog', { name: 'Add to bucket list' });
    await dialog.getByLabel('Name', { exact: true }).fill('Patagonia');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(alice.locator('.toast').filter({ hasText: /credit/i }).first()).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
