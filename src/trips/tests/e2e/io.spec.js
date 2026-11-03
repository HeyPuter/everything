import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { test, expect } from '@playwright/test';
import { USERS, audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';
import { chooseFiles, download, placeNames, planPane, read, seed, synced, tripMenu } from './helpers/trip-tools.js';

const fixture = (name) => readFileSync(new URL(`../unit/fixtures/io/${name}`, import.meta.url));
const file = (name, buffer, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.from(buffer) });
const ALICE = USERS.alice.uuid;
const DATES = { start: '2026-11-02', end: '2026-11-04' };
const GPX_WAYPOINTS = `<?xml version="1.0"?><gpx version="1.1" creator="Test" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="38.7139" lon="-9.1335"><name>Miradouro da Graça</name><sym>Scenic Area</sym></wpt>
<wpt lat="38.7107" lon="-9.1365"><name>Time Out Market</name><sym>Restaurant</sym></wpt></gpx>`;

// Alice's trip: days, places, visits, a booking, lists, an expense she paid alone, and one private packing item each.
const CONTENT = [
  { key: 'd1', type: 'day', fields: { order: 'a', date: '2026-11-02', title: 'Old town' } },
  { key: 'd2', type: 'day', fields: { order: 'b', date: '2026-11-03' } },
  { key: 'd3', type: 'day', fields: { order: 'c', date: '2026-11-04' } },
  { key: 'tower', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216, cat: 'attraction', address: 'Av. Brasília' } },
  { key: 'castle', type: 'place', fields: { name: 'São Jorge Castle', lat: 38.7139, lng: -9.1334, cat: 'attraction' } },
  { key: 'tasca', type: 'place', fields: { name: 'Tasca do Chico', lat: 38.7116, lng: -9.1445, cat: 'restaurant', web: 'https://example.com/tasca' } },
  { type: 'visit', fields: { dayId: { $: 'd1' }, placeId: { $: 'castle' }, order: 'a', start: '10:00', end: '12:00' } },
  { type: 'visit', fields: { dayId: { $: 'd1' }, placeId: { $: 'tasca' }, order: 'b', start: '20:00' } },
  { type: 'visit', fields: { dayId: { $: 'd2' }, placeId: { $: 'tower' }, order: 'a' } },
  { type: 'res', fields: { type: 'flight', title: 'TP 1234', status: 'confirmed', code: 'ABC123',
    legs: [{ from: { code: 'LHR', name: 'London Heathrow' }, to: { code: 'LIS', name: 'Lisbon' }, dep: { date: '2026-11-02', time: '07:10' }, arr: { date: '2026-11-02', time: '09:45' }, carrier: 'TP', number: 'TP1234' }] } },
  { type: 'pack', fields: { name: 'Rain jacket', list: 'Clothes', order: 'a' } },
  { type: 'todo', fields: { name: 'Book the tram tour', order: 'a', due: '2026-10-30' } },
  { type: 'exp', fields: { name: 'Museum tickets', amount: 2400, currency: 'EUR', date: '2026-11-03', payers: [{ who: ALICE, amount: 2400 }], split: { mode: 'equal', parts: [{ who: ALICE }] } } },
  { type: 'note', fields: { title: 'Tram 28 tips', body: 'Board at Martim Moniz.' } },
  { type: 'pack', private: true, fields: { name: 'Passport (Alice)', order: 'a' } },
];

/** Ids out, references in readable form, arrays sorted: two exports of the same trip compare equal. */
function normalize(data) {
  const labels = new Map();
  for (const [type, list] of Object.entries(data.entities)) for (const item of list) labels.set(item.id, `${type}:${item.name ?? item.title ?? item.date ?? item.question ?? ''}`);
  for (const [type, list] of Object.entries(data.private ?? {})) for (const item of list) labels.set(item.id, `private-${type}:${item.name}`);
  const swap = (value) => {
    if (Array.isArray(value)) return value.map(swap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'id').map(([name, item]) => [labels.get(name) ?? name, swap(item)]));
    return typeof value === 'string' && labels.has(value) ? labels.get(value) : value;
  };
  const sorted = (groups) => Object.fromEntries(Object.entries(groups ?? {}).filter(([type]) => type !== 'member').sort(([a], [b]) => a.localeCompare(b))
    .map(([type, list]) => [type, list.map((item) => JSON.stringify(swap(item))).sort()]));
  const { title: _title, ...meta } = data.meta;
  return { kind: data.kind, meta, entities: sorted(data.entities), private: sorted(data.private) };
}

async function exportFile(page, format, scope) {
  await tripMenu(page, 'Export trip…');
  const dialog = page.getByRole('dialog', { name: 'Export trip' });
  await dialog.getByRole('radio', { name: new RegExp(`^${format}`) }).click();
  if (scope) await dialog.getByRole('button', { name: scope, exact: true }).click();
  const file = await download(page, () => dialog.getByRole('button', { name: 'Download', exact: true }).click());
  await expect(dialog).toBeHidden();
  return file;
}

async function importFile(page, upload, label = 'Import into this trip…') {
  await tripMenu(page, label);
  const dialog = page.getByRole('dialog', { name: 'Import' });
  await chooseFiles(page, () => dialog.getByRole('button', { name: 'Choose file', exact: true }).click(), [upload]);
  return dialog;
}

let w;
test.afterEach(async () => { expect(w?.errors ?? []).toEqual([]); await w?.close(); w = null; });

test('a Trips file round-trips into the same trip, without other people\'s private items', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  await seed(w, 'alice', trip.ref, CONTENT);
  await seed(w, 'bob', trip.ref, [{ type: 'pack', private: true, fields: { name: 'Passport (Bob)', order: 'a' } }]);

  // Dialogs are audited over the trip Settings tab; the Plan tab has its own axe findings (A2).
  const page = await w.open('alice', trip.hash('settings'));
  await synced(page);
  await tripMenu(page, 'Export trip…');
  const dialog = page.getByRole('dialog', { name: 'Export trip' });
  await expect(dialog.getByRole('radio', { name: /^Trips file \(JSON\)/ })).toHaveAttribute('aria-checked', 'true');
  await audit(page); await noOverflow(page); await capture(page, testInfo, 'io-export-dialog');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  const exported = await exportFile(page, 'Trips file');
  expect(exported.name).toMatch(/^lisbon-\d{4}-\d{2}-\d{2}\.json$/);
  const original = JSON.parse(exported.text);
  expect(original).toMatchObject({ format: 'trips-space', version: 1, kind: 'trip', exportedBy: ALICE, meta: { title: 'Lisbon', ...DATES } });
  expect(original.entities.place.map((place) => place.name).sort()).toEqual(['Belém Tower', 'São Jorge Castle', 'Tasca do Chico']);
  expect(original.entities.visit).toHaveLength(3);
  expect(original.private.pack.map((item) => item.name)).toEqual(['Passport (Alice)']);
  expect(exported.text).not.toContain('Passport (Bob)');
  expect(original.meta.share).toBeUndefined();

  const importer = await importFile(page, file(exported.name, exported.bytes, 'application/json'));
  await expect(importer.getByText('1 private item of yours is added to your private lists.')).toBeVisible();
  await expect(importer.getByRole('radio', { name: /^A new trip/ })).toHaveAttribute('aria-checked', 'true');
  await audit(page);
  await importer.getByLabel('Trip name').fill('Lisbon again');
  await importer.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Imported “Lisbon again”.')).toBeVisible();
  await page.waitForURL((url) => url.hash.endsWith('/plan') && !url.hash.includes(trip.ref.s));
  await expect(page.getByRole('heading', { name: 'Lisbon again' }).first()).toBeVisible();
  await expect.poll(() => placeNames(page)).toHaveLength(3);

  const copy = JSON.parse((await exportFile(page, 'Trips file')).text);
  expect(copy.meta.title).toBe('Lisbon again');
  expect(normalize(copy)).toEqual(normalize(original));
  await page.close();
});

test('another member imports the file as a new trip: the exporter becomes a guest and keeps their private items', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES, role: 'viewer' });
  await seed(w, 'alice', trip.ref, CONTENT);
  const alice = await w.open('alice', trip.hash('plan'));
  const exported = await exportFile(alice, 'Trips file');

  // A viewer merging into the shared trip finds every group locked.
  const carol = await w.open('carol', trip.hash('plan'));
  const merge = await importFile(carol, file(exported.name, exported.bytes, 'application/json'));
  await merge.getByRole('radio', { name: /^Add to this trip/ }).click();
  await expect(merge.getByText('You can’t change this in this trip.').first()).toBeVisible();
  for (const box of await merge.locator('.io-group input[type=checkbox]').all()) await expect(box).toBeDisabled();
  await merge.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(merge.getByRole('alert')).toHaveText('Choose at least one kind of item to import.');
  await merge.getByRole('button', { name: 'Back', exact: true }).click();
  await merge.locator('.modal-head').getByRole('button', { name: 'Close' }).click();

  // Bob, on his own dashboard, makes his own trip from it.
  const bob = await w.open('bob', '#/settings/data');
  await bob.getByRole('button', { name: 'Import a Trips file…', exact: true }).click();
  const dialog = bob.getByRole('dialog', { name: 'Import' });
  await chooseFiles(bob, () => dialog.getByRole('button', { name: 'Choose file', exact: true }).click(), [file(exported.name, exported.bytes, 'application/json')]);
  await expect(dialog.getByText('Private items in this file belong to whoever exported it and are not imported.')).toBeVisible();
  await expect(dialog.getByRole('radiogroup', { name: 'Import as' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(bob.getByText('Imported “Lisbon”.')).toBeVisible();
  await bob.waitForURL((url) => url.hash.endsWith('/plan') && !url.hash.includes(trip.ref.s));
  const [, worker, space] = /#\/t\/([^/]+)\/([^/]+)\//.exec(new URL(bob.url()).hash);
  expect(worker).not.toBe(trip.ref.w);
  const copy = await read(w, 'bob', { w: worker, s: space, k: 'trip' }, ['guest', 'place', 'pack', 'exp']);
  expect(copy.guest).toEqual(['alice']);
  expect(copy.place.sort()).toEqual(['Belém Tower', 'São Jorge Castle', 'Tasca do Chico']);
  expect(copy.pack).toEqual(['Rain jacket']);
  expect(copy.exp).toEqual(['Museum tickets']);
});

test('GPX, KMZ and KML imports add places and tracks that the editor sees, skip duplicates and undo', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lake trip', ...DATES });
  await seed(w, 'alice', trip.ref, CONTENT.filter((item) => item.type === 'day'));
  const alice = await w.open('alice', trip.hash('settings'));
  const bob = await w.open('bob', trip.hash('plan'));

  const gpx = await importFile(alice, file('hike.gpx', fixture('hike.gpx'), 'application/gpx+xml'));
  await expect(gpx.locator('.io-summary')).toContainText('hike.gpx');
  const names = await gpx.locator('.io-item-name').allTextContents();
  expect(names).toEqual(expect.arrayContaining(['Café & Bakery', 'Viewpoint', 'Ferry', 'Morning loop']));
  await expect(gpx.locator('.io-items input[type=checkbox]:not(:checked)')).toHaveCount(0);
  await audit(alice); await noOverflow(alice); await capture(alice, testInfo, 'io-import-gpx');
  await gpx.getByRole('button', { name: `Import ${names.length} items`, exact: true }).click();
  await expect(alice.getByText(/^Added \d+ places\.$/)).toBeVisible();
  await expect.poll(async () => (await placeNames(bob)).sort()).toEqual([...names].sort());
  await expect(bob.locator('.pl-row', { hasText: 'Morning loop' }).getByLabel('Track')).toHaveCount(1);

  // The same file again: every item is already in the trip and starts unchecked.
  const again = await importFile(alice, file('hike.gpx', fixture('hike.gpx'), 'application/gpx+xml'));
  await expect(again.getByText('Already in this trip')).toHaveCount(names.length);
  await expect(again.locator('.io-items input[type=checkbox]:checked')).toHaveCount(0);
  await expect(again.getByRole('button', { name: 'Import 0 items', exact: true })).toBeDisabled();
  await again.getByRole('button', { name: 'Back', exact: true }).click();
  await again.locator('.modal-head').getByRole('button', { name: 'Close' }).click();

  // KMZ, then the same placemarks as plain KML.
  const kml = fixture('city.kml');
  const kmz = await importFile(alice, file('city.kmz', zipSync({ 'doc.kml': new Uint8Array(kml) }), 'application/vnd.google-earth.kmz'));
  await expect(kmz.locator('.io-summary')).toContainText('city.kmz');
  const cityNames = await kmz.locator('.io-item-name').allTextContents();
  expect(cityNames.length).toBeGreaterThan(0);
  await kmz.getByRole('button', { name: /^Import \d+ items?$/ }).click();
  await expect(alice.getByText(/^Added \d+ places?\.$/)).toBeVisible();
  const plain = await importFile(alice, file('city.kml', kml, 'application/vnd.google-earth.kml+xml'));
  await expect(plain.getByText('Already in this trip')).toHaveCount(cityNames.length);
  await expect(plain.locator('.io-items input[type=checkbox]:checked')).toHaveCount(0);
  await plain.getByRole('button', { name: 'Back', exact: true }).click();
  await plain.locator('.modal-head').getByRole('button', { name: 'Close' }).click();

  // Undo from the toast removes one import in one step, for both users.
  await expect.poll(async () => (await placeNames(bob)).length).toBe(names.length + cityNames.length);
  const before = names.length + cityNames.length;
  const extra = await importFile(alice, file('lisbon.gpx', GPX_WAYPOINTS, 'application/gpx+xml'));
  await extra.getByLabel('Also add to a day').selectOption({ label: 'Day 1 · Old town · Nov 2, 2026' });
  await extra.getByRole('button', { name: 'Import 2 items', exact: true }).click();
  await expect.poll(async () => (await placeNames(bob)).length).toBe(before + 2);
  await planPane(bob, 'Plan');
  await expect(bob.locator('.plan-days-pane')).toContainText('Time Out Market');
  await alice.locator('.toast', { hasText: 'Added 2 places.' }).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await placeNames(bob)).length).toBe(before);
  await expect(bob.locator('.pl-row', { hasText: 'Time Out Market' })).toHaveCount(0);
});

test('GPX, KML and KMZ exports hold the trip\'s places, days and categories', async ({ browser, baseURL }, testInfo) => {
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  await seed(w, 'alice', trip.ref, CONTENT);
  const bob = await w.open('bob', trip.hash('plan'));
  await expect.poll(() => placeNames(bob)).toHaveLength(3);

  const gpx = await exportFile(bob, 'GPX');
  expect(gpx.name).toMatch(/^lisbon-.*\.gpx$/);
  expect(gpx.text).toMatch(/^<\?xml[^>]*\?>\s*<gpx[^>]+version="1\.1"/);
  expect(gpx.text).toContain('<name>Belém Tower</name>');
  expect(gpx.text).toMatch(/<wpt lat="38\.6916" lon="-9\.216">/);
  expect(gpx.text).toContain('<sym>Scenic Area</sym><type>Attraction</type>');
  expect(gpx.text).toContain('href="https://example.com/tasca"');
  expect(gpx.text).toMatch(/<rte>\s*<name>Day 1 · Old town[^<]*<\/name>/);
  expect(gpx.text).not.toContain('ABC123');

  const places = await exportFile(bob, 'GPX', 'Places only');
  expect(places.text).toContain('<wpt');
  expect(places.text).not.toContain('<rte>');

  const kml = await exportFile(bob, 'KML');
  expect(kml.text).toContain('<kml');
  expect(kml.text).toMatch(/<Folder>\s*<name>Places<\/name>/);
  expect(kml.text).toContain('<name>São Jorge Castle</name>');
  expect(kml.text).toMatch(/<coordinates>-9\.1334,38\.7139/);

  const kmz = await exportFile(bob, 'KMZ');
  const entries = unzipSync(new Uint8Array(kmz.bytes));
  expect(Object.keys(entries)).toEqual(['doc.kml']);
  expect(strFromU8(entries['doc.kml'])).toBe(kml.text);
});

test('download all my data zips the owner\'s trips and personal data without credentials', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  await seed(w, 'alice', trip.ref, CONTENT);
  const plan = await w.open('alice', trip.hash('settings'));
  const tracks = await importFile(plan, file('hike.gpx', fixture('hike.gpx'), 'application/gpx+xml'));
  await tracks.getByRole('button', { name: /^Import \d+ items$/ }).click();
  await expect(plan.getByText(/^Added \d+ places\.$/)).toBeVisible();
  await expect.poll(async () => (await read(w, 'bob', trip.ref, ['place'])).place).toContain('Morning loop');

  const page = await w.open('alice', '#/settings/data');
  await expect(page.getByRole('heading', { name: 'Download all my data' })).toBeVisible();
  await audit(page); await noOverflow(page); await capture(page, testInfo, 'io-your-data');

  w.world.failNext({ method: 'workers.exec', as: 'alice', status: 402, code: 'insufficient_funds' });
  await page.getByRole('button', { name: 'Download my data', exact: true }).click();
  await expect(page.locator('.io-error')).toContainText('The trip owner’s Puter account is out of credit.');

  const zip = await download(page, () => page.locator('.io-error').getByRole('button', { name: 'Try again' }).click());
  expect(zip.name).toMatch(/^trips-data-.*\.zip$/);
  const entries = unzipSync(new Uint8Array(zip.bytes));
  const names = Object.keys(entries);
  const folder = `spaces/trip-lisbon-${trip.ref.s}`;
  expect(names).toEqual(expect.arrayContaining(['personal.json', 'README.txt', `${folder}/trip.json`]));
  expect(names.some((name) => name.includes('/files/'))).toBe(false);
  const personal = JSON.parse(strFromU8(entries['personal.json']));
  expect(personal).toMatchObject({ format: 'trips-personal', version: 1, account: { uuid: ALICE, username: 'alice' } });
  expect(Object.keys(personal.keys)).toEqual(expect.arrayContaining(['me:spaces', 'me:worker', `me:priv:${trip.ref.s}:pack`]));
  expect(Object.keys(personal.keys).filter((key) => /^me:(cred|integrations)/.test(key))).toEqual([]);
  expect(JSON.stringify(personal.keys[`me:priv:${trip.ref.s}:pack`])).toContain('Passport (Alice)');
  const exported = JSON.parse(strFromU8(entries[`${folder}/trip.json`]));
  expect(exported).toMatchObject({ format: 'trips-space', meta: { title: 'Lisbon' } });
  expect(exported.entities.place.map((place) => place.name)).toEqual(expect.arrayContaining(['Belém Tower', 'Morning loop']));
  await expect(page.locator('.io-result')).toContainText('1 trip or collection included.');

  await page.getByLabel(/^Include uploaded files/).check();
  const withFiles = unzipSync(new Uint8Array((await download(page, () => page.getByRole('button', { name: 'Download my data', exact: true }).click())).bytes));
  expect(Object.keys(withFiles).filter((name) => name.startsWith(`${folder}/files/`)).length).toBeGreaterThan(0);
  await expect(page.locator('.io-result')).toContainText(/\d+ files? included\./);

  // Bob owns nothing here: his zip has his personal data only.
  const bob = await w.open('bob', '#/settings/data');
  const bobZip = unzipSync(new Uint8Array((await download(bob, () => bob.getByRole('button', { name: 'Download my data', exact: true }).click())).bytes));
  expect(Object.keys(bobZip).some((name) => name.startsWith('spaces/'))).toBe(false);
  expect(JSON.parse(strFromU8(bobZip['personal.json'])).account.username).toBe('bob');
});

test('viewers cannot import, offline waypoints queue until reconnect and tracks report the failure, by keyboard', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob'] });
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES, role: 'viewer' });
  const viewer = await w.open('bob', trip.hash('plan'));
  const refused = await importFile(viewer, file('lisbon.gpx', GPX_WAYPOINTS, 'application/gpx+xml'));
  await expect(refused.getByRole('alert')).toHaveText('You don’t have permission to do that in this trip.');
  await refused.locator('.modal-head').getByRole('button', { name: 'Close' }).click();

  const alice = await w.open('alice', trip.hash('settings'));
  // The dialogs load on first use; offline, only a cached chunk opens (the PWA's service worker does that in production).
  await (await importFile(alice, file('lisbon.gpx', GPX_WAYPOINTS, 'application/gpx+xml'))).locator('.modal-head').getByRole('button', { name: 'Close' }).click();
  await synced(alice);
  await alice.context().setOffline(true);
  await expect.poll(() => w.host.stats().offlinePages).toBeGreaterThan(0);
  // Keyboard only: the trip menu, the import item, the file chooser and the import button.
  const menu = alice.getByRole('button', { name: 'Trip actions', exact: true });
  await menu.focus();
  await alice.keyboard.press('Enter');
  await expect(alice.getByRole('menu')).toBeVisible();
  await alice.getByRole('menuitem', { name: 'Import into this trip…', exact: true }).focus();
  await alice.keyboard.press('Enter');
  const dialog = alice.getByRole('dialog', { name: 'Import' });
  await expect(dialog.getByRole('button', { name: 'Choose file', exact: true })).toBeFocused();
  await chooseFiles(alice, () => alice.keyboard.press('Enter'), [file('lisbon.gpx', GPX_WAYPOINTS, 'application/gpx+xml')]);
  await expect(dialog.getByLabel('Select all')).toBeFocused();
  await dialog.getByRole('button', { name: 'Import 2 items', exact: true }).focus();
  await alice.keyboard.press('Enter');
  await expect(alice.getByText('Added 2 places.')).toBeVisible();
  await expect(alice.locator('.app-sync .save-state')).toHaveAttribute('data-state', 'offline');
  expect(await placeNames(viewer)).toEqual([]);

  const tracks = await importFile(alice, file('hike.gpx', fixture('hike.gpx'), 'application/gpx+xml'));
  await expect(tracks.locator('.io-summary')).toContainText('hike.gpx');
  await tracks.locator('.io-item', { hasNotText: 'Morning loop' }).locator('input').evaluateAll((boxes) => boxes.forEach((box) => { if (box.checked) box.click(); }));
  await tracks.getByRole('button', { name: 'Import 1 item', exact: true }).click();
  await expect(tracks.getByRole('alert')).toContainText('You’re offline. Connect and try again.');
  await tracks.getByRole('button', { name: 'Back', exact: true }).click();
  await tracks.locator('.modal-head').getByRole('button', { name: 'Close' }).click();

  await alice.context().setOffline(false);
  await expect.poll(async () => (await placeNames(viewer)).sort()).toEqual(['Miradouro da Graça', 'Time Out Market']);
});
