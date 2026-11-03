import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow } from './helpers/bridge-world.js';
import { seed, isoDay } from './helpers/providers.js';
import { SYNC, openPlan, planWorld, rowTitles } from './helpers/plan.js';

// R4 road trip between two editors: mode, settings that change the other's schedule, nights by keyboard, End the day here.
const SEED = [
  { key: 'd1', type: 'day', fields: { order: 'V', date: isoDay(30) } },
  { key: 'd2', type: 'day', fields: { order: 'W', date: isoDay(31) } },
  { key: 'p1', type: 'place', fields: { name: 'Lisbon', lat: 38.7223, lng: -9.1393, cc: 'PT' } },
  { key: 'p2', type: 'place', fields: { name: 'Coimbra', lat: 40.2033, lng: -8.4103, cc: 'PT' } },
  { key: 'p3', type: 'place', fields: { name: 'Porto', lat: 41.1579, lng: -8.6291, cc: 'PT' } },
  { key: 'v1', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V' } },
  { key: 'v2', type: 'visit', fields: { dayId: '$d1', placeId: '$p2', order: 'W' } },
  { key: 'v3', type: 'visit', fields: { dayId: '$d1', placeId: '$p3', order: 'X' } },
];

async function openRoad(w, as, trip) {
  const page = await openPlan(w, as, trip);
  await page.getByRole('group', { name: 'Plan view' }).getByRole('button', { name: 'Road trip' }).click();
  await expect(page.locator('.road-host')).toBeVisible();
  return page;
}
const roadDay = (page, id) => page.locator(`.road-day[data-day="${id}"]`);

test('two editors plan a road trip: settings change the other\'s schedule, a night moves by keyboard, and End the day here undoes', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Portugal by car', start: isoDay(30), end: isoDay(31) });
    const ids = await seed(w, trip.ref, SEED);
    const alice = await openRoad(w, 'alice', trip);
    await alice.getByRole('button', { name: 'Turn on road trip mode' }).click();
    await expect(alice.locator('.road-totals')).toContainText('driving');
    await expect(roadDay(alice, ids.d1).locator('.road-node-title')).toHaveText(['Lisbon', 'Coimbra', 'Porto']);
    const bob = await openRoad(w, 'bob', trip);
    await expect(bob.locator('.road-totals')).toContainText('driving', SYNC);

    // Alice limits driving to an hour a day; Bob's schedule gains nights at that limit.
    await alice.getByRole('button', { name: 'Road trip settings' }).first().click();
    const settings = alice.getByRole('dialog', { name: 'Road trip settings' });
    await settings.getByLabel(/^Driving per day/).fill('60');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(bob.locator('.road-night[data-source="daily"]').first()).toBeVisible(SYNC);
    await audit(bob);

    // A suggested night is placed with the slider dialog, by keyboard only.
    const night = alice.locator('.road-night[data-source="daily"]').first();
    await night.getByRole('button', { name: 'Place it' }).focus();
    await alice.keyboard.press('Enter');
    const dialog = alice.getByRole('dialog', { name: 'Where to stop for the night' });
    await expect(dialog.getByRole('slider')).toBeFocused();
    await alice.keyboard.press('Home');
    await alice.keyboard.press('ArrowRight');
    await alice.keyboard.press('Tab');
    while (!(await dialog.getByRole('button', { name: 'Save', exact: true }).evaluate((node) => node === document.activeElement))) await alice.keyboard.press('Tab');
    await alice.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(alice.locator('.road-night[data-source="manual"]')).toHaveCount(1);
    await expect(bob.locator('.road-night[data-source="manual"]')).toHaveCount(1, SYNC);

    // End the day at Coimbra moves Porto to day 2 for both; Undo brings it back.
    await alice.getByRole('button', { name: 'Actions for Coimbra' }).click();
    await alice.getByRole('menuitem', { name: 'End the day here' }).click();
    await expect(roadDay(alice, ids.d2).locator('.road-node-title')).toContainText(['Porto']);
    await bob.getByRole('group', { name: 'Plan view' }).getByRole('button', { name: 'Plan', exact: true }).click();
    await expect(rowTitles(bob, ids.d2)).toHaveText(['Porto'], SYNC);
    await alice.getByRole('status').filter({ hasText: 'Moved 1 stops to the next day.' }).getByRole('button', { name: 'Undo' }).click();
    await expect(roadDay(alice, ids.d1).locator('.road-node-title')).toHaveText(['Lisbon', 'Coimbra', 'Porto']);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Lisbon', 'Coimbra', 'Porto'], SYNC);

    await audit(alice);
    await noOverflow(alice);
    await capture(alice, testInfo, 'road-trip');
    expect(w.traffic.alice.unexpected).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a viewer reads the road trip but cannot change it', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await planWorld(browser, testInfo, baseURL, { users: ['alice', 'carol'] });
  try {
    const trip = await w.sharedTrip({ title: 'Portugal by car', start: isoDay(30), end: isoDay(31), role: 'viewer' });
    await seed(w, trip.ref, SEED);
    const alice = await openRoad(w, 'alice', trip);
    await alice.getByRole('button', { name: 'Turn on road trip mode' }).click();
    await expect(alice.locator('.road-totals')).toContainText('driving');
    const carol = await openRoad(w, 'carol', trip);
    await expect(carol.locator('.road-totals')).toContainText('driving', SYNC);
    await expect(carol.getByText('You can view this road trip. Editors can change it.')).toBeVisible();
    await expect(carol.locator('.road .plan-grip')).toHaveCount(0);
    await carol.getByRole('button', { name: 'Road trip settings' }).first().click();
    const settings = carol.getByRole('dialog', { name: 'Road trip settings' });
    await expect(settings).toContainText('Only editors can change these settings.');
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(settings.getByLabel(/^Driving per day/)).toBeDisabled();
    await audit(carol);
    await settings.getByRole('button', { name: 'Close' }).last().click();
    await expect(settings).toBeHidden();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
