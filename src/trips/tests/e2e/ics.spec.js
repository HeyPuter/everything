import { test, expect } from '@playwright/test';
import { USERS, audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';
import { download, routeWorkerFetch, seed, synced, tripMenu, workerGet } from './helpers/trip-tools.js';

const DATES = { start: '2026-11-02', end: '2026-11-04' };
const CONTENT = [
  { key: 'd1', type: 'day', fields: { order: 'a', date: '2026-11-02', title: 'Arrival' } },
  { key: 'd2', type: 'day', fields: { order: 'b', date: '2026-11-03' } },
  { key: 'd3', type: 'day', fields: { order: 'c', date: '2026-11-04' } },
  { key: 'tower', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216, tz: 'Europe/Lisbon', address: 'Av. Brasília' } },
  { key: 'castle', type: 'place', fields: { name: 'São Jorge Castle', lat: 38.7139, lng: -9.1334 } },
  { type: 'visit', fields: { dayId: { $: 'd1' }, placeId: { $: 'tower' }, order: 'a', start: '10:00', end: '11:30' } },
  { type: 'visit', fields: { dayId: { $: 'd2' }, placeId: { $: 'castle' }, order: 'a' } },
  { type: 'res', fields: { type: 'flight', title: 'TP 1234', status: 'confirmed', code: 'ABC123',
    legs: [{ from: { code: 'LHR', name: 'London Heathrow', tz: 'Europe/London' }, to: { code: 'LIS', name: 'Lisbon', tz: 'Europe/Lisbon' },
      dep: { date: '2026-11-02', time: '07:10' }, arr: { date: '2026-11-02', time: '09:45' }, seat: '14C' }] } },
  { type: 'res', fields: { type: 'lodging', title: 'Hotel Avenida', status: 'confirmed', stay: { fromDayId: { $: 'd1' }, toDayId: { $: 'd3' }, checkInFrom: '15:00', checkOut: '11:00' } } },
  { type: 'res', fields: { type: 'restaurant', title: 'Cancelled dinner', status: 'cancelled', start: { date: '2026-11-03', time: '20:00' } } },
  { type: 'todo', fields: { name: 'Book the tram tour', order: 'a', due: '2026-10-30' } },
  { type: 'todo', fields: { name: 'Collect the museum passes', order: 'b', due: '2026-10-31', who: USERS.bob.uuid } },
];

/** VEVENTs as `{NAME: value}` maps (parameters kept in the key, e.g. `DTSTART;TZID=Europe/Lisbon`), plus `alarms`. */
function events(text) {
  expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  const lines = text.replace(/\r\n[ \t]/g, '').split('\r\n');
  const out = [];
  let event = null;
  let alarm = false;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') event = { alarms: [] };
    else if (line === 'END:VEVENT') { out.push(event); event = null; } else if (line === 'BEGIN:VALARM') alarm = true;
    else if (line === 'END:VALARM') alarm = false;
    else if (event) {
      const index = line.indexOf(':');
      const [key, value] = [line.slice(0, index), line.slice(index + 1)];
      if (alarm) { if (key === 'TRIGGER') event.alarms.push(value); } else event[key] = value;
    }
  }
  return out;
}
const named = (list, summary) => list.find((event) => event.SUMMARY === summary);

async function calendarDialog(page) {
  await tripMenu(page, 'Add to calendar…');
  const dialog = page.getByRole('dialog', { name: 'Add to calendar' });
  await expect(dialog.locator('.ics-loading')).toHaveCount(0);
  return dialog;
}
const downloadIcs = async (page, dialog) => download(page, () => dialog.locator('[data-ics=download]').click());

/** The feed as a calendar app sees it; the first request after a change may wait for the worker's snapshot. */
async function feed(w, url, contains) {
  let last;
  await expect.poll(async () => { last = await workerGet(w, url); return last.status === 200 && (!contains || last.text.includes(contains)); }, { timeout: 30_000 }).toBe(true);
  return last;
}

let w;
let restore = () => {};
test.afterEach(async () => { restore(); restore = () => {}; expect(w?.errors ?? []).toEqual([]); await w?.close(); w = null; });

test('the calendar file holds the trip in local zones, with each member\'s own to-dos and options', async ({ browser, baseURL }, testInfo) => {
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  await seed(w, 'alice', trip.ref, CONTENT);
  const alice = await w.open('alice', trip.hash('settings'));
  await synced(alice);
  const dialog = await calendarDialog(alice);
  await expect(dialog.locator('[data-ics=download]')).toBeFocused();
  await audit(alice); await noOverflow(alice); await capture(alice, testInfo, 'ics-dialog');

  const file = await downloadIcs(alice, dialog);
  expect(file.name).toBe('Lisbon.ics');
  await expect(alice.getByText('Calendar file downloaded')).toBeVisible();
  expect(file.text).toContain('BEGIN:VTIMEZONE\r\nTZID:Europe/Lisbon');
  expect(file.text).toContain('TZID:Europe/London');
  const list = events(file.text);
  expect(named(list, 'Lisbon')).toMatchObject({ 'DTSTART;VALUE=DATE': '20261102', 'DTEND;VALUE=DATE': '20261105', TRANSP: 'TRANSPARENT' });
  expect(named(list, 'Belém Tower')).toMatchObject({ 'DTSTART;TZID=Europe/Lisbon': '20261102T100000', 'DTEND;TZID=Europe/Lisbon': '20261102T113000', LOCATION: 'Av. Brasília' });
  expect(named(list, 'Day 1: Arrival')).toMatchObject({ 'DTSTART;VALUE=DATE': '20261102' });
  expect(named(list, 'Day 2')).toMatchObject({ DESCRIPTION: 'São Jorge Castle' });
  expect(named(list, 'TP 1234')).toMatchObject({ 'DTSTART;TZID=Europe/London': '20261102T071000', 'DTEND;TZID=Europe/Lisbon': '20261102T094500', STATUS: 'CONFIRMED', alarms: ['-PT3H'] });
  expect(named(list, 'Hotel Avenida')).toMatchObject({ 'DTSTART;VALUE=DATE': '20261102', DESCRIPTION: expect.stringContaining('Check-in') });
  expect(named(list, 'To-do: Book the tram tour')).toMatchObject({ 'DTSTART;VALUE=DATE': '20261030', alarms: [expect.any(String)] });
  expect(named(list, 'To-do: Collect the museum passes')).toBeUndefined();
  expect(named(list, 'Cancelled dinner')).toBeUndefined();
  expect(file.text).not.toMatch(/ABC123|14C|alice|bob/);

  await dialog.getByLabel('Day events').uncheck();
  await dialog.getByLabel('Reminders').uncheck();
  const bare = events((await downloadIcs(alice, dialog)).text);
  expect(bare.some((event) => /^Day \d/.test(event.SUMMARY))).toBe(false);
  expect(bare.every((event) => event.alarms.length === 0)).toBe(true);
  expect(named(bare, 'Belém Tower')).toBeDefined();

  const bob = await w.open('bob', trip.hash('bookings'));
  const bobFile = events((await downloadIcs(bob, await calendarDialog(bob))).text);
  expect(named(bobFile, 'To-do: Collect the museum passes')).toMatchObject({ 'DTSTART;VALUE=DATE': '20261031' });
  expect(named(bobFile, 'To-do: Book the tram tour')).toBeDefined();
});

test('each member gets their own feed link: create, another device, rotate and turn off', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES, role: { bob: 'editor', carol: 'viewer' } });
  await seed(w, 'alice', trip.ref, CONTENT);

  const alice = await w.open('alice', trip.hash('settings'));
  const dialog = await calendarDialog(alice);
  await dialog.locator('[data-ics=create]').click();
  const url = dialog.locator('.ics-feed-url');
  await expect(url).toHaveValue(new RegExp(`^https://${trip.ref.w}\\.puter\\.work/ics/${trip.ref.s}/${USERS.alice.uuid}/[0-9a-f]{32}\\.ics$`));
  await expect(dialog.locator('[data-ics=webcal]')).toHaveAttribute('href', /^webcal:\/\//);
  await expect(dialog.locator('[data-ics=google]')).toHaveAttribute('href', /^https:\/\/calendar\.google\.com\/calendar\/render\?cid=webcal%3A%2F%2F/);
  await audit(alice); await capture(alice, testInfo, 'ics-feed');
  const aliceUrl = await url.inputValue();
  const aliceFeed = await feed(w, aliceUrl, 'SUMMARY:Lisbon');
  expect(aliceFeed.type).toMatch(/^text\/calendar/);
  expect(aliceFeed.text).not.toContain('Collect the museum passes');
  expect((await workerGet(w, aliceUrl, { 'if-none-match': aliceFeed.etag })).status).toBe(304);

  // Without day events the link carries `days=0`.
  await dialog.getByLabel('Day events').uncheck();
  await expect(url).toHaveValue(`${aliceUrl}?days=0`);
  expect((await feed(w, `${aliceUrl}?days=0`)).text).not.toContain('SUMMARY:Day 1');
  await dialog.getByLabel('Day events').check();

  const bob = await w.open('bob', trip.hash('bookings'));
  const bobDialog = await calendarDialog(bob);
  await bobDialog.locator('[data-ics=create]').click();
  const bobUrl = await bobDialog.locator('.ics-feed-url').inputValue();
  expect(bobUrl).toContain(`/${USERS.bob.uuid}/`);
  expect((await feed(w, bobUrl, 'SUMMARY:Lisbon')).text).toContain('Collect the museum passes');

  const carol = await w.open('carol', trip.hash('bookings'));
  const carolDialog = await calendarDialog(carol);
  await carolDialog.locator('[data-ics=create]').click();
  const carolUrl = await carolDialog.locator('.ics-feed-url').inputValue();
  expect(carolUrl).toContain(`/${USERS.carol.uuid}/`);
  await feed(w, carolUrl, 'SUMMARY:Lisbon');

  // Feeds follow the worker's snapshot, rebuilt after 200 revisions or 10 minutes (tests/worker/ics.test.js covers changes).

  // Another of Alice's devices only knows a link exists; getting a new one retires the first.
  const laptop = await w.open('alice', trip.hash('settings'), { device: 2 });
  const elsewhere = await calendarDialog(laptop);
  await elsewhere.locator('[data-ics=create]').click();
  await expect(elsewhere.getByText('You already have a subscription link, created on another device.', { exact: false })).toBeVisible();
  expect((await workerGet(w, aliceUrl)).status).toBe(200);
  await audit(laptop);
  await elsewhere.locator('[data-ics=renew]').click();
  await expect(laptop.getByText('New subscription link ready')).toBeVisible();
  const renewed = await elsewhere.locator('.ics-feed-url').inputValue();
  expect(renewed).not.toBe(aliceUrl);
  await feed(w, renewed, 'SUMMARY:Lisbon');
  expect((await workerGet(w, aliceUrl)).status).toBe(404);
  expect((await workerGet(w, bobUrl)).status).toBe(200);

  await elsewhere.locator('[data-ics=rotate]').click();
  await laptop.getByRole('dialog', { name: 'Replace the subscription link?' }).getByRole('button', { name: 'New link', exact: true }).click();
  await expect(elsewhere.locator('.ics-feed-url')).not.toHaveValue(renewed);
  const rotated = await elsewhere.locator('.ics-feed-url').inputValue();
  expect((await workerGet(w, renewed)).status).toBe(404);
  await feed(w, rotated);

  await elsewhere.locator('[data-ics=revoke]').click();
  await laptop.getByRole('dialog', { name: 'Turn off the subscription link?' }).getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(laptop.getByText('Subscription link turned off')).toBeVisible();
  await expect(elsewhere.locator('[data-ics=create]')).toBeVisible();
  expect((await workerGet(w, rotated)).status).toBe(404);
  expect((await workerGet(w, carolUrl)).status).toBe(200);
});

test('the dialog works by keyboard and explains offline, credit and rate-limit failures', async ({ browser, baseURL }, testInfo) => {
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  const bob = await w.open('bob', trip.hash('bookings'));
  await synced(bob);

  const menu = bob.getByRole('button', { name: 'Trip actions', exact: true });
  await menu.focus();
  await bob.keyboard.press('Enter');
  await bob.getByRole('menuitem', { name: 'Add to calendar…', exact: true }).focus();
  await bob.keyboard.press('Enter');
  const dialog = bob.getByRole('dialog', { name: 'Add to calendar' });
  await expect(dialog.locator('[data-ics=download]')).toBeFocused();
  const file = await download(bob, () => bob.keyboard.press('Enter'));
  expect(file.text).toContain('SUMMARY:Lisbon');
  await expect(dialog.locator('[data-ics=create]')).toBeEnabled();

  w.world.failNext({ method: 'workers.exec', as: 'bob', status: 402, code: 'insufficient_funds' });
  await dialog.locator('[data-ics=create]').click();
  await expect(dialog.locator('.ics-alert')).toHaveText('You’re out of Puter credit. Add credit and try again.');
  w.world.failNext({ method: 'workers.exec', as: 'bob', status: 429, code: 'rate_limited' });
  await dialog.locator('[data-ics=create]').click();
  await expect(dialog.locator('.ics-alert')).toHaveText('Too many link changes. Try again later.');

  await bob.context().setOffline(true);
  await expect(dialog.getByText('You’re offline. Connect to manage the subscription link.')).toBeVisible();
  await expect(dialog.locator('[data-ics=create]')).toBeDisabled();
  await audit(bob);
  await bob.context().setOffline(false);
  await expect(dialog.locator('[data-ics=create]')).toBeEnabled();
  await dialog.locator('[data-ics=create]').click();
  await expect(dialog.locator('.ics-feed-url')).toHaveValue(/\.ics$/);
  await expect(dialog.locator('.ics-alert')).toBeHidden();

  await bob.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
});

test('the all-trips calendar merges trips from two workers and can be rotated and turned off', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  w = await bridgeWorld(browser, testInfo, baseURL);
  restore = routeWorkerFetch(w);
  const lisbon = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  const porto = await w.sharedTrip({ title: 'Porto', start: '2026-12-10', end: '2026-12-12', owner: 'bob', members: ['alice'] });
  await seed(w, 'alice', lisbon.ref, CONTENT.slice(0, 3));
  await seed(w, 'bob', porto.ref, [{ type: 'day', fields: { order: 'a', date: '2026-12-10', title: 'Ribeira' } }]);

  const page = await w.open('alice', '#/settings/calendar');
  const section = page.locator('.settings-ics-all');
  await expect(section).not.toHaveAttribute('aria-busy', 'true');
  await audit(page); await noOverflow(page);

  await page.context().setOffline(true);
  await section.getByRole('button', { name: 'Create calendar link', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('You are offline. Try again when you are connected.');
  await page.context().setOffline(false);
  await section.getByRole('button', { name: 'Create calendar link', exact: true }).click();
  const link = section.getByLabel('Calendar link');
  await expect(link).toHaveValue(new RegExp(`^https://${lisbon.ref.w}\\.puter\\.work/feed/[0-9a-f]{32}\\.ics$`));
  await expect(section.locator('.ics-all-list a')).toHaveCount(2);
  expect((await section.locator('.ics-all-list a').allTextContents()).sort()).toEqual(['Lisbon', 'Porto']);
  await audit(page); await capture(page, testInfo, 'ics-all-trips');
  const first = await link.inputValue();
  const merged = await feed(w, first, 'SUMMARY:Porto');
  expect(merged.text).toContain('SUMMARY:Lisbon');
  expect(merged.text).toContain('SUMMARY:Day 1: Ribeira');

  await section.getByRole('button', { name: 'Get a new link', exact: true }).click();
  await page.getByRole('dialog', { name: 'Get a new link?' }).getByRole('button', { name: 'Get a new link', exact: true }).click();
  await expect(link).not.toHaveValue(first);
  const second = await link.inputValue();
  expect((await workerGet(w, first)).status).toBe(404);
  await feed(w, second, 'SUMMARY:Lisbon');

  await section.getByRole('button', { name: 'Turn off', exact: true }).click();
  await page.getByRole('dialog', { name: 'Turn off the calendar for all trips?' }).getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Calendar link turned off')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Create calendar link', exact: true })).toBeVisible();
  expect((await workerGet(w, second)).status).toBe(404);
});
