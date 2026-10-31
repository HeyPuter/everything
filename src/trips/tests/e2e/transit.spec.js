import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow } from './helpers/bridge-world.js';
import { seed, isoDay } from './helpers/providers.js';
import { SYNC, day, openPlan, planWorld, setRole } from './helpers/plan.js';

// R8 transit options in the planner on an intercepted Transitous (MOTIS) plan endpoint.
const SEED = [
  { key: 'd1', type: 'day', fields: { order: 'V', date: isoDay(30) } },
  { key: 'p1', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216, cc: 'PT', tz: 'Europe/Lisbon' } },
  { key: 'p2', type: 'place', fields: { name: 'Praça do Comércio', lat: 38.7075, lng: -9.1364, cc: 'PT', tz: 'Europe/Lisbon' } },
  { key: 'v1', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V', end: '11:00', legMode: 'transit' } },
  { key: 'v2', type: 'visit', fields: { dayId: '$d1', placeId: '$p2', order: 'W' } },
];
const stop = (name, lat, lon) => ({ name, lat, lon, tz: 'Europe/Lisbon' });
/** One tram connection with walks at both ends, starting at the requested time (or none at all). */
function motis(url, { empty = false } = {}) {
  const at = Date.parse(url.searchParams.get('time') ?? new Date().toISOString());
  const iso = (minutes) => new Date(at + minutes * 60_000).toISOString();
  const a = stop('START', 38.6916, -9.216); const b = stop('Belém', 38.6975, -9.2068); const c = stop('Praça do Comércio', 38.7075, -9.1364); const end = stop('END', 38.7075, -9.1364);
  const leg = (mode, from, to, start, finish, extra = {}) => ({ mode, from, to, duration: (finish - start) * 60, startTime: iso(start), endTime: iso(finish), ...extra });
  return {
    requestParameters: {}, debugOutput: {}, from: a, to: end, direct: [],
    itineraries: empty ? [] : [{
      duration: 1500, startTime: iso(2), endTime: iso(27), transfers: 0,
      legs: [
        leg('WALK', a, b, 2, 7),
        leg('TRAM', b, c, 8, 25, { routeShortName: '15E', headsign: 'Praça da Figueira', agencyName: 'Carris', routeColor: 'F2C200', scheduledStartTime: iso(8), scheduledEndTime: iso(25), intermediateStops: [stop('Alcântara', 38.7036, -9.1781)] }),
        leg('WALK', c, end, 25, 27),
      ],
    }],
  };
}
const transitous = ({ empty = false } = {}) => async (url, route) => {
  if (url.hostname !== 'api.transitous.org') return false;
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(motis(url, { empty })) });
  return true;
};

test('an editor adds a transit connection to bookings and the others see it between the visits; a viewer cannot add', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'], providers: { config: { providers: { transit: ['transitous'] } }, extra: transitous() } });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(30) });
    await setRole(w, trip, 'carol', 'viewer');
    const ids = await seed(w, trip.ref, SEED);
    // Carol, a viewer, can search but not add.
    const carol = await openPlan(w, 'carol', trip);
    await day(carol, ids.d1).getByRole('button', { name: 'Public transport options from Belém Tower to Praça do Comércio' }).click({ timeout: 25_000 });
    const view = carol.getByRole('dialog', { name: 'Public transport' });
    await view.locator('.transit-summary').first().click();
    await expect(view).toContainText('Only people who can edit bookings can add a connection.');
    await expect(view.getByRole('button', { name: 'Add to bookings' })).toHaveCount(0);
    await audit(carol);

    const alice = await openPlan(w, 'alice', trip);
    const open = day(alice, ids.d1).getByRole('button', { name: 'Public transport options from Belém Tower to Praça do Comércio' });
    await open.focus();
    await alice.keyboard.press('Enter');
    const dialog = alice.getByRole('dialog', { name: 'Public transport' });
    await expect(dialog.locator('.transit-count')).toHaveText('1 connection');
    await expect(dialog.getByRole('link', { name: 'Google Maps' })).toBeVisible();
    await dialog.locator('.transit-summary').first().click();
    await expect(dialog.locator('.transit-leg-line').first()).toContainText('15E');
    await audit(alice);
    await noOverflow(alice);
    await capture(alice, testInfo, 'transit-dialog');
    await dialog.getByRole('button', { name: 'Add to bookings' }).click();
    await expect(dialog).toBeHidden();
    const kinds = (page) => day(page, ids.d1).locator(':scope .plan-rows > .plan-row').evaluateAll((rows) => rows.map((row) => row.dataset.kind));
    await expect.poll(() => kinds(alice)).toEqual(['visit', 'res', 'visit']);
    const bob = await openPlan(w, 'bob', trip);
    await expect.poll(() => kinds(bob), SYNC).toEqual(['visit', 'res', 'visit']);
    // A booked connection replaces the connector, so its transit button goes.
    await expect(day(bob, ids.d1).locator('.transit-open')).toHaveCount(0);

    expect(w.traffic.alice.unexpected).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('without a transit provider only maps links show; with one, no connections says so', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await planWorld(browser, testInfo, baseURL, {
    providers: (as) => (as === 'bob' ? { config: { providers: { transit: ['transitous'] } }, extra: transitous({ empty: true }) } : {}),
  });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(30) });
    const ids = await seed(w, trip.ref, SEED);
    const alice = await openPlan(w, 'alice', trip);
    await day(alice, ids.d1).getByRole('button', { name: /^Public transport options from/ }).click();
    const plain = alice.getByRole('dialog', { name: 'Public transport' });
    await expect(plain).toContainText('Connection search isn’t available in Trips yet.');
    await expect(plain.getByRole('link', { name: 'Google Maps' })).toHaveAttribute('href', /google\.com/);
    await expect(plain.getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('href', /apple\.com/);
    await expect(plain.locator('.transit-form')).toBeHidden();
    await audit(alice);

    const bob = await openPlan(w, 'bob', trip);
    await day(bob, ids.d1).getByRole('button', { name: /^Public transport options from/ }).click();
    const none = bob.getByRole('dialog', { name: 'Public transport' });
    await expect(none).toContainText('No connections found.', SYNC);
    await expect(none.getByRole('group', { name: 'When' }).or(none.getByRole('button', { name: 'Search' }))).toHaveCount(1);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
