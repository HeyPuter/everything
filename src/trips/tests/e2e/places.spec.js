import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow, USERS } from './helpers/bridge-world.js';
import { seed, read, isoDay } from './helpers/providers.js';
import { SYNC, day, menuPick, openPlan, planWorld, rowTitles, showPane } from './helpers/plan.js';

// P2b places pool and Q11 place details, between two accounts.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const DAYS = [
  { key: 'd1', type: 'day', fields: { order: 'V', date: isoDay(30) } },
  { key: 'd2', type: 'day', fields: { order: 'W', date: isoDay(31) } },
];
const row = (page, name) => page.locator('.pl-row', { hasText: name });
async function openPlaces(w, as, trip) {
  const page = await openPlan(w, as, trip);
  await showPane(page, 'Places');
  await expect(page.locator('.pl-pane')).toBeVisible();
  return page;
}
async function openPlace(page, name) {
  await row(page, name).locator('.pl-main').click();
  await expect(page.locator('.pl-detail-title')).toHaveText(name);
}

// Wikidata, Wikipedia and Openverse answers for Q11, plus the photo bytes.
const wikimedia = async (url, route) => {
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  if (url.hostname === 'www.wikidata.org' && url.searchParams.get('action') === 'wbgetentities') {
    return json({ entities: { Q123: { id: 'Q123', labels: { en: { value: 'Belém Tower' } }, descriptions: { en: { value: 'fortified tower in Lisbon' } }, sitelinks: { enwiki: { title: 'Belém Tower' } } } } });
  }
  if (url.hostname === 'www.wikidata.org') return json({ claims: {} });
  if (url.hostname === 'en.wikipedia.org') return json({ extract: 'The Belém Tower is a 16th-century fortification on the Tagus.' });
  if (url.hostname === 'en.wikivoyage.org') return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
  if (url.hostname === 'api.openverse.org') {
    return json({ results: [{ id: 'ov1', url: 'https://images.fixture.test/tower.png', thumbnail: 'https://images.fixture.test/tower-thumb.png', foreign_landing_url: 'https://example.org/tower', license: 'by', license_url: 'https://creativecommons.org/licenses/by/4.0/', title: 'Tower at dusk', creator: 'Ana' }] });
  }
  if (url.hostname === 'images.fixture.test') return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: PNG });
  return false;
};

test('two editors add, rate and tag a place; tags stay private and ratings average', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(31) });
    const ids = await seed(w, trip.ref, DAYS);
    const alice = await openPlaces(w, 'alice', trip);
    const bob = await openPlaces(w, 'bob', trip);

    await alice.locator('.pl-head').getByRole('button', { name: 'Add place' }).click();
    const form = alice.getByRole('dialog', { name: 'New place' });
    await form.getByLabel('Name', { exact: true }).fill('Pastéis de Belém');
    await form.getByLabel('Latitude').fill('38.6975');
    await form.getByLabel('Longitude').fill('-9.2033');
    await form.getByRole('button', { name: 'Add place', exact: true }).click();
    // Saving looks up the zone and region first.
    await expect(form).toBeHidden({ timeout: 15_000 });
    await expect(row(alice, 'Pastéis de Belém')).toBeVisible();
    await expect(row(bob, 'Pastéis de Belém')).toBeVisible(SYNC);

    // Alice rates 4 and tags "pastry"; Bob rates 5 and tags "lunch". Each sees only their own tag.
    await openPlace(alice, 'Pastéis de Belém');
    await alice.getByRole('radio', { name: '4 of 5 stars' }).click();
    await alice.getByLabel('New tag').fill('pastry');
    await alice.getByLabel('New tag').press('Enter');
    await expect(alice.locator('.pl-tag')).toHaveText(['pastry']);
    await openPlace(bob, 'Pastéis de Belém');
    await expect(bob.getByText(/^Average 4(\.0)?, ratings: 1$/)).toBeVisible(SYNC);
    await bob.getByRole('radio', { name: '5 of 5 stars' }).click();
    await bob.getByLabel('New tag').fill('lunch');
    await bob.getByLabel('New tag').press('Enter');
    await expect(bob.locator('.pl-tag')).toHaveText(['lunch']);
    await expect(alice.getByText('Average 4.5, ratings: 2', { exact: true })).toBeVisible(SYNC);
    await expect(alice.locator('.pl-tag')).toHaveText(['pastry']);

    // "Create expense" opens the costs form linked to the place; "Attach files" opens the picker for it.
    await alice.locator('.pl-detail').getByRole('button', { name: 'Create expense' }).click();
    const expense = alice.getByRole('dialog', { name: 'New expense' });
    await expect(expense.getByLabel('Name', { exact: true })).toHaveValue('Pastéis de Belém');
    await expense.getByLabel('Amount', { exact: true }).fill('9.60');
    await expense.getByRole('button', { name: 'Add expense' }).click();
    await expect(expense).toBeHidden();
    await expect(alice.locator('.pl-linked')).toContainText('Pastéis de Belém');
    await expect(bob.locator('.pl-linked')).toContainText('Pastéis de Belém', SYNC);
    await alice.locator('.pl-detail').getByRole('button', { name: 'Attach files' }).click();
    await expect(alice.getByRole('dialog', { name: 'Attach files' })).toBeVisible();
    await alice.keyboard.press('Escape');

    // Add to day from the detail, then the Planned scope lists it.
    await alice.locator('.pl-detail').getByRole('button', { name: 'Add to day' }).click();
    await alice.getByRole('menu').getByRole('menuitem').first().click();
    await alice.getByRole('button', { name: 'Back to places' }).click();
    await showPane(alice, 'Plan');
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Pastéis de Belém']);
    await showPane(bob, 'Plan');
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Pastéis de Belém'], SYNC);
    await showPane(alice, 'Places');
    await alice.getByRole('group', { name: 'Places to show' }).getByRole('button', { name: 'Unplanned' }).click();
    await expect(alice.locator('.pl-row')).toHaveCount(0);
    await alice.getByRole('group', { name: 'Places to show' }).getByRole('button', { name: 'Planned', exact: true }).click();
    await expect(alice.locator('.pl-row')).toHaveCount(1);

    for (const page of [alice, bob]) { await audit(page); await noOverflow(page); }
    await capture(alice, testInfo, 'places-alice');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('pasted coordinates and map links offer to add a place, by keyboard; short links ask for the full link', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await planWorld(browser, testInfo, baseURL, { providers: { reverse: { name: 'Rossio', lat: 38.7139, lng: -9.1394 } } });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await openPlaces(w, 'alice', trip);
    // "/" focuses the search; typing coordinates offers an add.
    await alice.locator('.pl-title').click();
    await alice.keyboard.press('/');
    await expect(alice.locator('.pl-pane').getByLabel('Search places')).toBeFocused();
    await alice.keyboard.type('38.7139, -9.1394');
    await alice.keyboard.press('Enter');
    let form = alice.getByRole('dialog', { name: 'New place' });
    await expect(form.getByLabel('Latitude')).toHaveValue('38.7139');
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Rossio');
    await alice.keyboard.press('Escape');
    await expect(form).toBeHidden();

    await alice.locator('.pl-pane').getByLabel('Search places').fill('https://www.google.com/maps/place/Elevador+de+Santa+Justa/@38.712,-9.1394,17z');
    await alice.getByRole('button', { name: 'Add “Elevador de Santa Justa”' }).click();
    form = alice.getByRole('dialog', { name: 'New place' });
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Elevador de Santa Justa');
    await form.getByRole('button', { name: 'Add place', exact: true }).click();
    // Saving looks up the zone and region first.
    await expect(form).toBeHidden({ timeout: 15_000 });
    await alice.locator('.pl-pane').getByLabel('Search places').fill('');
    await expect(row(alice, 'Elevador de Santa Justa')).toBeVisible();

    await alice.locator('.pl-pane').getByLabel('Search places').fill('https://maps.app.goo.gl/AbCdEf123');
    await alice.getByRole('button', { name: 'Read this map link' }).click();
    await expect(alice.getByRole('status').filter({ hasText: 'Trips cannot open short links here.' })).toBeVisible();

    // N opens the form from anywhere outside a text field.
    await alice.locator('.pl-title').click();
    await alice.keyboard.press('n');
    await expect(alice.getByRole('dialog', { name: 'New place' })).toBeVisible();
    await audit(alice);
    await alice.keyboard.press('Escape');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('bulk actions set a category, mark visited and delete places with their visits and linked expenses', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(31) });
    const alice = USERS.alice.uuid;
    const ids = await seed(w, trip.ref, [...DAYS,
      { key: 'p1', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216 } },
      { key: 'p2', type: 'place', fields: { name: 'Time Out Market', lat: 38.7069, lng: -9.1459 } },
      { key: 'p3', type: 'place', fields: { name: 'Castelo', lat: 38.7139, lng: -9.1335 } },
      { key: 'v1', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V' } },
      { key: 'e1', type: 'exp', fields: { name: 'Tower tickets', amount: 1800, currency: 'EUR', payers: [{ who: alice, amount: 1800 }], split: { mode: 'equal', parts: [{ who: alice }] }, links: [{ t: 'place', id: '$p1' }] } },
    ]);
    const page = await openPlaces(w, 'alice', trip);
    const bob = await openPlan(w, 'bob', trip);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Belém Tower'], SYNC);

    await menuPick(page, page.getByRole('button', { name: 'Places options' }), 'Select places');
    await page.getByRole('checkbox', { name: 'Select Belém Tower' }).check();
    await page.getByRole('checkbox', { name: 'Select Time Out Market' }).check();
    await expect(page.locator('.pl-bulk-count')).toHaveText('2 selected');
    await menuPick(page, page.getByRole('button', { name: 'Set category' }), 'Restaurant');
    await expect(row(page, 'Belém Tower').locator('.pl-meta')).toContainText('Restaurant');
    await page.getByRole('button', { name: 'Mark visited' }).click();
    await expect(row(page, 'Time Out Market').getByLabel('Visited')).toBeVisible();
    await audit(page);

    await page.locator('.pl-bulk').getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete 2 places?' });
    await expect(dialog).toContainText('1 linked expenses keep their amounts and lose the link.');
    await dialog.getByRole('checkbox', { name: /Also delete the 1 expenses/ }).check();
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.pl-row')).toHaveCount(1);
    await expect(row(page, 'Castelo')).toBeVisible();
    await expect(rowTitles(bob, ids.d1)).toHaveCount(0, SYNC);
    expect(await read(w, trip.ref, [['exp', ids.e1], ['visit', ids.v1]])).toEqual([null, null]);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a viewer rates, tags and marks places visited but cannot edit them', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await planWorld(browser, testInfo, baseURL, { users: ['alice', 'carol'] });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(31), role: 'viewer' });
    await seed(w, trip.ref, [...DAYS, { key: 'p1', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216, cc: 'PT' } }]);
    const carol = await openPlaces(w, 'carol', trip);
    await expect(row(carol, 'Belém Tower')).toBeVisible(SYNC);
    await expect(carol.locator('.pl-head').getByRole('button', { name: 'Add place' })).toBeHidden();
    await expect(carol.locator('.pl-grip')).toHaveCount(0);
    await carol.getByRole('button', { name: 'More for Belém Tower' }).click();
    await expect(carol.getByRole('menu').getByRole('menuitem')).toHaveText(['Open', 'Show on map', 'Mark as visited', 'Save to collection']);
    await carol.keyboard.press('Escape');

    await openPlace(carol, 'Belém Tower');
    await expect(carol.locator('.pl-detail').getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(carol.locator('.pl-detail').getByRole('button', { name: 'Add to day' })).toHaveCount(0);
    await carol.getByRole('radio', { name: '3 of 5 stars' }).click();
    await carol.locator('.pl-detail').getByRole('button', { name: 'Visited' }).click();
    await expect(carol.locator('.pl-detail').getByRole('button', { name: 'Visited' })).toHaveAttribute('aria-pressed', 'true');
    await carol.getByLabel('New tag').fill('sunset');
    await carol.getByLabel('New tag').press('Enter');
    await audit(carol);
    await capture(carol, testInfo, 'places-viewer');

    const alice = await openPlaces(w, 'alice', trip);
    await openPlace(alice, 'Belém Tower');
    await expect(alice.getByText(/^Average 3(\.0)?, ratings: 1$/)).toBeVisible(SYNC);
    await expect(alice.locator('.pl-tag')).toHaveCount(0);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('an offline edit to a place deleted meanwhile comes back through the conflict review', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const ids = await seed(w, trip.ref, [{ key: 'p1', type: 'place', fields: { name: 'Castelo', lat: 38.7139, lng: -9.1335 } }]);
    const bob = await openPlaces(w, 'bob', trip);
    const alice = await openPlaces(w, 'alice', trip);
    await expect(row(bob, 'Castelo')).toBeVisible(SYNC);
    const bobContext = await w.context('bob');
    await bobContext.setOffline(true);
    await expect.poll(() => w.host.stats().offlinePages).toBeGreaterThan(0);
    await menuPick(bob, bob.getByRole('button', { name: 'More for Castelo' }), 'Edit');
    const form = bob.getByRole('dialog', { name: 'Edit place' });
    await form.getByLabel('Name', { exact: true }).fill('Castelo de São Jorge');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row(bob, 'Castelo de São Jorge')).toBeVisible();

    await menuPick(alice, alice.getByRole('button', { name: 'More for Castelo' }), 'Delete');
    await alice.getByRole('dialog', { name: /^Delete/ }).getByRole('button', { name: 'Delete' }).click();
    await expect(alice.locator('.pl-row')).toHaveCount(0);
    await expect.poll(async () => (await read(w, trip.ref, [['place', ids.p1]]))[0], SYNC).toBeNull();

    await bobContext.setOffline(false);
    const bar = bob.locator('.pl-notice');
    await expect(bar).toContainText('1 place changes could not be saved.', SYNC);
    await audit(bob);
    await bar.getByRole('button', { name: 'Review' }).click();
    const review = bob.getByRole('dialog', { name: 'Resolve a conflict' });
    await expect(review).toContainText('was deleted after your edit');
    await review.getByRole('button', { name: 'Save mine as a copy' }).click();
    await expect(bar).toBeHidden();
    await expect(row(alice, 'Castelo de São Jorge')).toBeVisible(SYNC);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('place details show a description and an Openverse photo; the AI summary saves to notes after confirming', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL, { providers: { extra: wikimedia } });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const ids = await seed(w, trip.ref, [{ key: 'p1', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216, cc: 'PT', ids: { wikidata: 'Q123' } } }]);
    const alice = await openPlaces(w, 'alice', trip);
    await openPlace(alice, 'Belém Tower');
    const about = alice.locator('.pd-root');
    // Several throttled Wikimedia requests run first.
    await expect(about).toContainText('The Belém Tower is a 16th-century fortification on the Tagus.', SYNC);
    await expect(about).toContainText('From Wikipedia');
    await expect(about).toContainText('Ana');
    await expect(about.locator('img').first()).toBeVisible();
    await audit(alice);

    // A 402 from puter.ai shows the credit message; the next try writes the summary.
    await alice.evaluate(() => globalThis.__TRIPS_AI__.fail('credit', { times: 1 }));
    await about.getByRole('button', { name: 'Summarize' }).click();
    await expect(about).toContainText('Your Puter account is out of AI credit.');
    await about.getByRole('button', { name: 'Summarize' }).click();
    await expect(about.locator('.pd-ai-text')).toContainText('scripted test summary');
    await about.getByRole('button', { name: 'Save to notes' }).click();
    const confirm = alice.getByRole('dialog', { name: 'Add the summary to the notes?' });
    await confirm.getByRole('button', { name: 'Add to notes' }).click();
    await expect(about.getByRole('button', { name: 'Saved to notes' })).toBeDisabled();
    await expect.poll(async () => (await read(w, trip.ref, [['place', ids.p1]], 'bob'))[0]?.notes ?? '', SYNC).toContain('AI summary');

    // Offline with nothing cached for another place says so.
    await capture(alice, testInfo, 'place-details');
    expect(w.traffic.alice.unexpected).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
