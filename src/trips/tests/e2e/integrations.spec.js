import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';
import { fakeNet, placeNames, planPane, press, read, seed, synced, tripMenu } from './helpers/trip-tools.js';
import { exifJpeg } from '../unit/helpers/exif-jpeg.js';

// Every server below is a recorded fixture behind an intercepted `puter.net.fetch`; nothing leaves the machine.
const fixture = (name) => JSON.parse(readFileSync(new URL(`../unit/fixtures/integrations/${name}`, import.meta.url), 'utf8'));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const SERVERS = {
  airtrail: { url: 'https://airtrail.example.com', key: 'air-key' },
  immich: { url: 'https://photos.example.com', key: 'imm-key' },
  dawarich: { url: 'https://dawarich.example.com', key: 'daw-key' },
};
const MAY = { start: '2026-05-01', end: '2026-05-10' };

/** The fake servers. `state.flights` can be swapped to model changes made in AirTrail. */
function servers() {
  const state = { flights: fixture('airtrail-flights-1.json'), pushed: [] };
  const bearer = (request, key) => request.headers.authorization === `Bearer ${key}`;
  const handler = (request) => {
    const { url, method } = request;
    const route = `${method} ${url.host}${url.pathname}`;
    if (url.host === 'airtrail.example.com') {
      if (!bearer(request, SERVERS.airtrail.key)) return { status: 401, json: { error: 'unauthorized' } };
      if (route.endsWith('/api/v1/me')) return { json: { data: { user: { id: 'u-alice', displayName: 'Alice A.' } } } };
      if (route === 'GET airtrail.example.com/api/v1/flights') return { json: url.searchParams.get('cursor') === 'c2' ? fixture('airtrail-flights-2.json') : state.flights };
      if (route === 'POST airtrail.example.com/api/v1/flights') { state.pushed.push(JSON.parse(request.body)); return { json: { data: { id: 900 + state.pushed.length } } }; }
    }
    if (url.host === 'photos.example.com') {
      if (request.headers['x-api-key'] !== SERVERS.immich.key) return { status: 401, json: {} };
      if (route.endsWith('/api/users/me')) return { json: { id: 'imm-1', name: 'Alice' } };
      if (route.endsWith('/api/search/metadata')) {
        const asset = (id, name, at) => ({ id, type: 'IMAGE', originalFileName: name, originalMimeType: 'image/png', localDateTime: at, fileCreatedAt: at, exifInfo: { fileSizeInByte: 68, dateTimeOriginal: at } });
        return { json: { assets: { total: 2, count: 2, nextPage: null, items: [asset('a-1', 'Brooklyn.png', '2026-05-03T09:12:00.000Z'), asset('a-2', 'Bridge.png', '2026-05-04T16:40:00.000Z')] } } };
      }
      if (/\/api\/assets\/a-[12]\/(thumbnail|original)$/.test(url.pathname)) return { base64: PNG, headers: { 'content-type': 'image/png' } };
    }
    if (url.host === 'dawarich.example.com') {
      if (!bearer(request, SERVERS.dawarich.key)) return { status: 401, json: {} };
      if (route.endsWith('/api/v1/users/me')) return { json: { user: { id: 1, email: 'alice@example.com' } } };
      if (route.endsWith('/api/v1/visits')) return { json: fixture('dawarich-visits.json') };
      if (route.endsWith('/api/v1/points')) return { json: [] };
    }
    if (url.host === 'maps.app.goo.gl') return { status: 302, headers: { location: ROUTE }, text: '' };
    return { status: 404, json: { error: 'not found' } };
  };
  return { state, handler };
}
const STOP = (id, lng, lat) => `!1m5!1m1!1s0x${id}:0x${id}!2m2!1d${lng}!2d${lat}`;
const ROUTE = `https://www.google.com/maps/dir/Lisbon,+Portugal/Sintra/Cascais/@38.75,-9.3,11z/data=!3m1!4b1!4m20!4m19${STOP('a1', -9.1393366, 38.7222524)}${STOP('b2', -9.3817, 38.8029)}${STOP('c3', -9.4215, 38.6979)}!3e0`;

/** Stores the user's servers the way Settings does, before their pages load. */
async function connect(w, as, services) {
  const page = await w.open(as);
  await page.evaluate((value) => globalThis.puter.kv.set('me:integrations', value, { disableSharing: true }), { v: 1, ...Object.fromEntries(services.map((name) => [name, SERVERS[name]])) });
  await page.close();
}

let w;
test.afterEach(async () => { expect(w?.errors ?? []).toEqual([]); await w?.close(); w = null; });

test('Settings connects each server with its own key, warns about http, refuses a wrong key and disconnects', async ({ browser, baseURL }, testInfo) => {
  w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  const { handler } = servers();
  const calls = await fakeNet(await w.context('alice'), handler);
  const page = await w.open('alice', '#/settings/integrations');
  const airtrail = page.locator('[data-service="airtrail"]');
  await expect(airtrail.locator('.int-status')).toHaveText('Not connected');
  await audit(page); await noOverflow(page); await capture(page, testInfo, 'integrations-settings');

  await airtrail.getByLabel('Server address').fill('http://airtrail.example.com/api/v1');
  await expect(airtrail.getByText('This address does not use HTTPS', { exact: false })).toBeVisible();
  await airtrail.getByLabel('Server address').fill('airtrail.example.com/api');
  await expect(airtrail.getByText('This address does not use HTTPS', { exact: false })).toBeHidden();
  await airtrail.getByLabel('API key').fill('wrong');
  await airtrail.getByRole('button', { name: 'Test and save', exact: true }).click();
  await expect(airtrail.locator('.int-status')).toHaveText('AirTrail did not accept the key. Check it, or create a new one.');
  expect(w.world.inspectKv('alice')['me:integrations']).toBeUndefined();
  await airtrail.getByLabel('API key').fill(SERVERS.airtrail.key);
  await airtrail.getByRole('button', { name: 'Test and save', exact: true }).click();
  await expect(airtrail.locator('.int-status')).toHaveText('Connected as Alice A.');
  await expect(page.getByText('AirTrail connected.')).toBeVisible();
  expect(w.world.inspectKv('alice')['me:integrations']).toMatchObject({ v: 1, airtrail: { url: 'https://airtrail.example.com', key: SERVERS.airtrail.key, sync: true } });
  await expect(airtrail.getByLabel('API key')).toHaveAttribute('placeholder', 'Saved key (leave empty to keep it)');
  await airtrail.getByRole('switch', { name: 'Check for new flights while a trip is open' }).click();
  await expect.poll(() => w.world.inspectKv('alice')['me:integrations'].airtrail.sync).toBe(false);

  for (const name of ['immich', 'dawarich']) {
    const section = page.locator(`[data-service="${name}"]`);
    await section.getByLabel('Server address').fill(SERVERS[name].url);
    await section.getByLabel('API key').fill(SERVERS[name].key);
    await section.getByRole('button', { name: 'Test and save', exact: true }).click();
    await expect(section.locator('.int-status')).toContainText(/^Connected/);
  }
  // Keys only ever go to their own server.
  for (const call of calls) {
    const name = Object.keys(SERVERS).find((key) => new URL(SERVERS[key].url).host === call.url.host);
    expect(JSON.stringify(call.headers)).not.toMatch(new RegExp(Object.values(SERVERS).filter((server) => server !== SERVERS[name]).map((server) => server.key).join('|')));
  }

  await airtrail.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('dialog', { name: 'Disconnect AirTrail?' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(airtrail.locator('.int-status')).toHaveText('Not connected');
  expect(w.world.inspectKv('alice')['me:integrations'].airtrail).toBeUndefined();
  expect(w.world.inspectKv('alice')['me:integrations'].immich).toMatchObject({ url: SERVERS.immich.url });
});

test('AirTrail flights enter a trip after review: new, linked, changed and dismissed flights, the badge, write-back and a viewer', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  const { state, handler } = servers();
  const calls = await fakeNet(await w.context('alice'), handler);
  await fakeNet(await w.context('carol'), handler);
  const trip = await w.sharedTrip({ title: 'New York', ...MAY, role: { bob: 'editor', carol: 'viewer' } });
  await seed(w, 'alice', trip.ref, [
    { type: 'res', fields: { type: 'flight', title: 'Flight home', status: 'confirmed', code: 'XK42LM',
      legs: [{ from: { code: 'JFK' }, to: { code: 'FRA' }, dep: { date: '2026-05-09', time: '18:30' }, arr: { date: '2026-05-10', time: '08:10' }, carrier: 'LH', number: 'LH401' }] } },
    { type: 'res', fields: { type: 'flight', title: 'Side trip', status: 'confirmed',
      legs: [{ from: { code: 'JFK' }, to: { code: 'BOS' }, dep: { date: '2026-05-06', time: '08:00' }, arr: { date: '2026-05-06', time: '09:15' }, carrier: 'B6', number: 'B6 1001' }] } },
  ]);
  await connect(w, 'alice', ['airtrail']);
  await connect(w, 'carol', ['airtrail']);

  const viewer = await w.open('carol', trip.hash('bookings'));
  await expect(viewer.locator('.res-row')).toHaveCount(2);
  await expect(viewer.getByRole('button', { name: /^AirTrail/ })).toBeHidden();

  const page = await w.open('alice', trip.hash('bookings'));
  const entry = page.getByRole('button', { name: 'AirTrail: 2 to review' });
  await expect(entry).toBeVisible();
  await entry.click();
  const dialog = page.getByRole('dialog', { name: 'Flights from AirTrail' });
  const fresh = dialog.locator('.int-group', { hasText: 'New flights' });
  await expect(fresh.locator('.int-row')).toHaveCount(2);
  await expect(fresh.locator('.int-row', { hasText: 'FRA' }).first()).toBeVisible();
  const duplicate = fresh.locator('.int-row', { hasText: 'Already in this trip?' });
  await expect(duplicate.getByLabel('What to do')).toHaveValue('link');
  // A possible duplicate starts unchecked; checking it links the flight to the booking made by hand.
  await expect(duplicate.locator('input[type=checkbox]')).not.toBeChecked();
  await duplicate.locator('input[type=checkbox]').check();
  await expect(dialog.getByText('1 flight is outside the trip dates.')).toBeVisible();
  const push = dialog.locator('.int-push');
  await expect(push).toContainText('Send to AirTrail');
  // Both bookings made in Trips could be sent; linking one to its AirTrail flight takes it off this list.
  await expect(push.locator('.int-row')).toHaveCount(2);
  await audit(page); await capture(page, testInfo, 'airtrail-review');

  await dialog.getByRole('button', { name: 'Save 2 flights', exact: true }).click();
  await expect(page.getByText('Added 1 flight. Updated 1 booking.')).toBeVisible();
  await expect(page.locator('.res-row')).toHaveCount(3);
  await expect(entry).toBeHidden();
  const bob = await w.open('bob', trip.hash('bookings'));
  await expect(bob.locator('.res-row')).toHaveCount(3);
  await expect(bob.locator('.res-row', { hasText: 'Flight home' })).toContainText('XK42LM');

  // AirTrail changes a flight: the next review offers the update.
  state.flights = structuredClone(state.flights);
  state.flights.data[0].departure = '2026-05-02T11:45:00.000+02:00';
  state.flights.data[0].arrival = '2026-05-02T14:25:00.000-04:00';
  const again = await w.open('alice', trip.hash('bookings'));
  await again.getByRole('button', { name: /^AirTrail/ }).click();
  const review = again.getByRole('dialog', { name: 'Flights from AirTrail' });
  await review.getByRole('button', { name: 'Refresh', exact: true }).click();
  const changed = review.locator('.int-group', { hasText: 'Changed in AirTrail' });
  await expect(changed.locator('.int-row')).toHaveCount(1);
  await expect(changed).toContainText('Changed');

  // Write-back: the booking made in Trips goes to AirTrail once.
  await expect(review.locator('.int-push .int-row')).toHaveCount(1);
  await review.locator('.int-push input[type=checkbox]').check();
  await press(review.locator('.int-push').getByRole('button', { name: 'Send 1 flight', exact: true }));
  await expect(again.getByText('1 flight sent to AirTrail')).toBeVisible();
  expect(state.pushed).toHaveLength(1);
  expect(JSON.stringify(state.pushed[0])).toContain('BOS');
  await press(review.getByRole('button', { name: 'Save 1 flight', exact: true }));
  await expect(again.getByText('Updated 1 booking.')).toBeVisible();
  await expect(bob.locator('.res-row', { hasText: '11:45' })).toHaveCount(1);
  expect(calls.every((call) => call.url.host === 'airtrail.example.com')).toBe(true);
});

test('Immich photos are copied into the trip files and Dawarich stays become places, with dismissals kept per account', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  w = await bridgeWorld(browser, testInfo, baseURL);
  const { handler } = servers();
  await fakeNet(await w.context('alice'), handler);
  const trip = await w.sharedTrip({ title: 'New York', ...MAY });
  await seed(w, 'alice', trip.ref, ['2026-05-03', '2026-05-04', '2026-05-05'].map((date, index) => ({ type: 'day', fields: { order: 'abc'[index], date } })));
  await connect(w, 'alice', ['immich', 'dawarich']);

  const files = await w.open('alice', trip.hash('files'));
  await files.getByRole('button', { name: 'From Immich', exact: true }).click();
  const picker = files.getByRole('dialog', { name: 'Photos from Immich' });
  await expect(picker.locator('.int-photo')).toHaveCount(2);
  await expect(picker.locator('.int-photo img')).toHaveCount(2);
  await audit(files);
  await picker.locator('.int-photo-check').first().check();
  await picker.locator('.int-photo-check').last().check();
  await picker.getByRole('button', { name: 'Add 2 photos', exact: true }).click();
  await expect(picker).toBeHidden();
  const bobFiles = await w.open('bob', trip.hash('files'));
  await expect(bobFiles.getByText('Brooklyn.png').first()).toBeVisible({ timeout: 15_000 });
  await expect(bobFiles.getByText('Bridge.png').first()).toBeVisible();

  const plan = await w.open('alice', trip.hash('plan'));
  await planPane(plan, 'Places');
  await press(plan.locator('.plan-places-pane').getByRole('button', { name: 'Places options', exact: true }));
  await press(plan.getByRole('menuitem', { name: 'Places from Dawarich', exact: true }));
  const stays = plan.getByRole('dialog', { name: 'Places from Dawarich' });
  await expect(stays.locator('.int-row').first()).toBeVisible();
  await expect(stays.locator('.int-row', { hasText: 'The Metropolitan Museum of Art' })).toBeVisible();
  await audit(plan);
  const first = stays.locator('.int-row', { hasText: 'The Metropolitan Museum of Art' }).locator('input[type=checkbox]');
  const pizza = stays.locator('.int-row', { hasText: 'Joe' }).locator('input[type=checkbox]');
  await expect(first).toBeChecked();
  await pizza.uncheck();
  await press(stays.getByRole('button', { name: /^Add 1 place/ }));
  await expect.poll(async () => (await read(w, 'bob', trip.ref, ['place'])).place).toContain('The Metropolitan Museum of Art');
});

test('Dawarich dismissals follow the account to another device; offline is explained', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  w = await bridgeWorld(browser, testInfo, baseURL);
  const { handler } = servers();
  await fakeNet(await w.context('alice'), handler);
  await fakeNet(await w.context('alice', 2), handler);
  const trip = await w.sharedTrip({ title: 'New York', ...MAY });
  await seed(w, 'alice', trip.ref, ['2026-05-03', '2026-05-04', '2026-05-05'].map((date, index) => ({ type: 'day', fields: { order: 'abc'[index], date } })));
  await connect(w, 'alice', ['dawarich', 'immich']);
  // Dismiss a stay on one device; the other device hides it too, and it can be restored there.
  const openStays = async (page) => {
    await planPane(page, 'Places');
    await press(page.locator('.plan-places-pane').getByRole('button', { name: 'Places options', exact: true }));
    await press(page.getByRole('menuitem', { name: 'Places from Dawarich', exact: true }));
    const dialog = page.getByRole('dialog', { name: 'Places from Dawarich' });
    await expect(dialog.locator('.int-row').first()).toBeVisible();
    return dialog;
  };
  const stays = await openStays(await w.open('alice', trip.hash('plan')));
  const checked = stays.locator('.int-row input[type=checkbox]:checked');
  while (await checked.count()) await checked.first().uncheck();
  await stays.locator('.int-row', { hasText: 'Joe' }).locator('input[type=checkbox]').check();
  await press(stays.getByRole('button', { name: 'Dismiss', exact: true }));
  await expect(stays.locator('.int-row', { hasText: 'Joe' })).toHaveCount(0);
  await expect.poll(() => JSON.stringify(w.world.inspectKv('alice')['me:dawarich'] ?? null)).toContain('dismissed');

  const elsewhere = await openStays(await w.open('alice', trip.hash('plan'), { device: 2 }));
  await expect(elsewhere.locator('.int-row', { hasText: 'Joe' })).toHaveCount(0);
  await elsewhere.getByLabel('Show dismissed stays').check();
  const dismissed = elsewhere.locator('.int-row', { hasText: 'Joe' });
  await expect(dismissed).toContainText('Dismissed');
  await press(dismissed.getByRole('button', { name: 'Restore', exact: true }));
  await expect(dismissed).not.toContainText('Dismissed');

  // Offline, the Immich picker says why it cannot search.
  const files = await w.open('alice', trip.hash('files'));
  const entry = files.getByRole('button', { name: 'From Immich', exact: true });
  await expect(entry).toBeVisible();
  await files.context().setOffline(true);
  await expect(entry).toBeDisabled();
});

test('a Google Maps route link and a set of photos become stops on the right days', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  w = await bridgeWorld(browser, testInfo, baseURL);
  const { handler } = servers();
  const calls = await fakeNet(await w.context('alice'), handler);
  const trip = await w.sharedTrip({ title: 'Portugal', start: '2026-05-01', end: '2026-05-04' });
  await seed(w, 'alice', trip.ref, ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04'].map((date, index) => ({ type: 'day', fields: { order: 'abcd'[index], date } })));
  const bob = await w.open('bob', trip.hash('plan'));
  const page = await w.open('alice', trip.hash('settings'));
  await synced(page);

  await tripMenu(page, 'Import a Google Maps route…');
  const route = page.getByRole('dialog', { name: 'Import a Google Maps route' });
  await route.getByLabel('Directions link').fill('https://maps.app.goo.gl/abc123');
  await press(route.getByRole('button', { name: 'Read link', exact: true }));
  await expect(route.locator('.route-import-stop')).toHaveCount(3);
  expect(calls.map((call) => call.url.host)).toContain('maps.app.goo.gl');
  await expect(route.locator('.route-import-stop').first()).toContainText('Lisbon, Portugal');
  await expect(route.locator('.route-import-stop').nth(1)).toContainText('38.8029, -9.3817');
  await audit(page); await capture(page, testInfo, 'route-import');
  await route.getByLabel('Add to day').selectOption({ index: 1 });
  await press(route.getByRole('button', { name: 'Add 3 stops', exact: true }));
  await expect(page.getByText('3 stops added')).toBeVisible();
  await planPane(bob, 'Plan');
  await expect(bob.locator('.plan-days-pane')).toContainText('Sintra');
  await expect.poll(async () => (await placeNames(bob)).sort()).toEqual(['Cascais', 'Lisbon, Portugal', 'Sintra']);

  const photos = [
    { name: 'IMG_0001.jpg', date: '2026:05:02 10:00:00', lat: [38, 42, 0], lng: [9, 8, 24] },
    { name: 'IMG_0002.jpg', date: '2026:05:02 10:40:00', lat: [38, 42, 1], lng: [9, 8, 25] },
    { name: 'IMG_0003.jpg', date: '2026:05:03 15:10:00', lat: [38, 47, 15], lng: [9, 23, 26] },
  ].map(({ name, ...exif }) => ({ name, mimeType: 'image/jpeg', buffer: Buffer.from(exifJpeg(exif)) }));
  await tripMenu(page, 'Build days from photos…');
  const days = page.getByRole('dialog', { name: 'Build days from photos' });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), press(days.getByRole('button', { name: 'Choose photos on this device', exact: true }))]);
  await chooser.setFiles(photos);
  await expect(days.getByText('3 photos, 2 stops')).toBeVisible();
  await expect(days.locator('.photo-days-stop')).toHaveCount(2);
  await audit(page);
  await press(days.getByRole('button', { name: 'Name stops with AI', exact: true }));
  await expect(days.getByText('Names suggested by AI. Check them before adding.')).toBeVisible();
  const names = await days.locator('.photo-days-stop input.input').evaluateAll((inputs) => inputs.map((input) => input.value));
  expect(names.every(Boolean)).toBe(true);
  await days.locator('.photo-days-stop input.input').first().fill('Alfama walk');
  await press(days.getByRole('button', { name: 'Add 2 stops', exact: true }));
  await expect(page.getByText('2 stops added to the plan')).toBeVisible();
  await expect(bob.locator('.plan-days-pane')).toContainText('Alfama walk');
  await expect(bob.locator('.plan-days-pane')).toContainText(names[1]);
});
