import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow } from './helpers/bridge-world.js';
import { seed, isoDay } from './helpers/providers.js';
import { SYNC, day, openPlan, planWorld, showPane } from './helpers/plan.js';

// Q6 weather and holidays on intercepted MET Norway, NASA POWER, Nager.Date and OpenHolidays answers.
const NEAR = isoDay(1);
const FAR = isoDay(40);
const lisbon = [
  { key: 'd1', type: 'day', fields: { order: 'V', date: NEAR } },
  { key: 'd2', type: 'day', fields: { order: 'W', date: FAR } },
  { key: 'p1', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216, cc: 'PT' } },
  { key: 'v1', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V' } },
  { key: 'v2', type: 'visit', fields: { dayId: '$d2', placeId: '$p1', order: 'V' } },
];

async function openPanel(page, dayId) {
  await day(page, dayId).locator('.plan-day-title').click();
  await showPane(page, 'Map');
  const panel = page.getByRole('region', { name: 'Day details' });
  await expect(panel).toBeVisible();
  return panel;
}

test('a near day shows the forecast and its strip, a far day typical values, and a holiday warns about closures', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const holidays = [{ date: NEAR, name: 'Test Liberty Day', cc: 'PT' }];
  const school = [{ start: FAR, end: FAR, name: 'Autumn break', cc: 'PT' }];
  const w = await planWorld(browser, testInfo, baseURL, { providers: { holidays, school } });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: NEAR, end: FAR });
    const ids = await seed(w, trip.ref, lisbon);
    const alice = await openPlan(w, 'alice', trip);
    await expect(day(alice, ids.d1).locator('.wx-head')).toContainText('°');
    await expect(day(alice, ids.d1).locator('.wx-head .wx-typical')).toHaveCount(0);
    await expect(day(alice, ids.d2).locator('.wx-head .wx-typical')).toHaveText('typical');
    await expect(day(alice, ids.d1).locator('.wx-info')).toContainText('Test Liberty Day');
    await expect(day(alice, ids.d2).locator('.wx-info')).toContainText('School holidays');
    expect(w.traffic.alice.weather).toBeGreaterThan(0);
    expect(w.traffic.alice.normals).toBeGreaterThan(0);

    const panel = await openPanel(alice, ids.d1);
    await expect(panel.locator('.wx-where')).toHaveText('Forecast for Belém Tower');
    await expect(panel.getByRole('list', { name: 'Through the day' }).getByRole('listitem').first()).toBeVisible();
    await expect(panel).toContainText('Chance of precipitation 30%');
    await expect(panel).toContainText('Wind up to');
    await expect(panel).toContainText('Sunrise');
    await expect(panel).toContainText('Public holiday in Portugal');
    await expect(panel).toContainText('Check opening hours for the stops planned this day (1).');
    await expect(panel.locator('.wx-credit').first()).toContainText('MET Norway');
    await audit(alice);
    await noOverflow(alice);
    await capture(alice, testInfo, 'weather-forecast');

    await showPane(alice, 'Plan');
    const far = await openPanel(alice, ids.d2);
    await expect(far.locator('.wx-where')).toContainText('Typical for');
    await expect(far).toContainText('Climate averages.');
    await expect(far).toContainText('School holidays in Portugal');

    // The other editor's planner computes the same from the shared plan.
    const bob = await openPlan(w, 'bob', trip);
    await expect(day(bob, ids.d1).locator('.wx-info')).toContainText('Test Liberty Day', SYNC);
    await audit(bob);
    expect(w.traffic.alice.unexpected).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a failed forecast says so and Retry loads it; a regional holiday follows the place\'s region', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  let down = true;
  const holidays = [{ date: NEAR, name: 'Bavarian Day', cc: 'DE', regions: ['DE-BY'] }];
  const extra = async (url, route) => {
    // Without a forecast the panel falls back to typical values, so both providers fail here.
    if (['api.met.no', 'power.larc.nasa.gov'].includes(url.hostname) && down) { await route.abort('connectionfailed'); return true; }
    return false;
  };
  const w = await planWorld(browser, testInfo, baseURL, { providers: { holidays, extra } });
  try {
    const trip = await w.sharedTrip({ title: 'Munich', start: NEAR, end: NEAR });
    const ids = await seed(w, trip.ref, [
      { key: 'd1', type: 'day', fields: { order: 'V', date: NEAR } },
      { key: 'p1', type: 'place', fields: { name: 'Marienplatz', lat: 48.1374, lng: 11.5755, cc: 'DE' } },
      { key: 'v1', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V' } },
    ]);
    const alice = await openPlan(w, 'alice', trip);
    const panel = await openPanel(alice, ids.d1);
    await expect(panel).toContainText('Weather is not available right now.', SYNC);
    await audit(alice);
    down = false;
    await panel.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.locator('.wx-where')).toHaveText('Forecast for Marienplatz', SYNC);

    // Munich resolves to Bavaria from the bundled boundaries, or the panel asks for the region.
    const choose = panel.getByRole('button', { name: 'Choose region' });
    await expect(panel.getByText('Holiday in Bavaria').or(panel.getByText('Holiday in DE-BY')).or(choose)).toBeVisible(SYNC);
    if (await choose.isVisible()) {
      await choose.click();
      const dialog = alice.getByRole('dialog', { name: 'Holiday regions' });
      await dialog.getByRole('combobox').selectOption('DE-BY');
      await dialog.getByRole('button', { name: 'Save' }).click();
    }
    await expect(panel).toContainText('Bavarian Day', SYNC);
    await expect(day(alice, ids.d1).locator('.wx-info')).toContainText('Bavarian Day');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
