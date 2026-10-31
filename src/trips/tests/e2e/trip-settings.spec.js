import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';

// P1: the trip Settings tab, edited by the owner and read by an editor and a viewer.
const day = (offset) => { const date = new Date(Date.now() + offset * 86_400_000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
async function settingsTab(w, as, trip) {
  const page = await w.open(as, trip.hash('settings'));
  await expect(page.locator('.trip-settings-head h2')).toBeVisible();
  return page;
}
async function join(w, owner, ref, as, role) {
  const { token } = await owner.evaluate(([target, value]) => globalThis.trips.invite(target, { role: value }), [ref, role]);
  const page = await w.open(as, `#/join/${ref.w}/${ref.s}/${token}`);
  await page.getByRole('button', { name: 'Join trip', exact: true }).click();
  await page.waitForURL((url) => url.hash.startsWith(`#/t/${ref.w}/${ref.s}`));
  await page.close();
}

test('the owner edits the details, an editor sees them live and a viewer gets a read-only page', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    const owner = await w.open('alice');
    await expect(owner.locator('html')).toHaveAttribute('data-worker', 'ready');
    const ref = await owner.evaluate((meta) => globalThis.trips.createTrip(meta), { title: 'Lisbon', start: day(10), end: day(14) });
    await join(w, owner, ref, 'bob', 'editor');
    await join(w, owner, ref, 'carol', 'viewer');
    await owner.close();
    const trip = { ref, hash: (tab) => `#/t/${ref.w}/${ref.s}/${tab}` };
    const alice = await settingsTab(w, 'alice', trip);
    const bob = await settingsTab(w, 'bob', trip);
    await expect(bob.getByRole('note')).toHaveText('Only the owner can change these details.');
    await expect(bob.getByRole('button', { name: 'Edit trip' })).toHaveCount(0);

    await alice.getByRole('button', { name: 'Edit trip' }).click();
    const form = alice.getByRole('dialog', { name: 'Edit trip' });
    await form.getByLabel('Description').fill('Bring **sunscreen**, see the [guide](https://example.org) and [this](javascript:alert(1))');
    await form.getByLabel('Tags').fill('beach'); await form.getByLabel('Tags').press('Enter');
    await form.getByRole('checkbox', { name: '7 days before' }).check();
    await audit(alice); await capture(alice, testInfo, 'trip-settings-form');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);

    const details = bob.locator('.trip-details');
    await expect(details).toContainText('beach');
    await expect(details).toContainText('7 days before');
    await expect(bob.locator('.trip-settings-section strong')).toHaveText('sunscreen');
    await expect(bob.getByRole('link', { name: 'guide' })).toHaveAttribute('href', /^https:\/\/example.org/);
    await expect(bob.getByRole('link', { name: 'this' })).toHaveCount(0);
    await audit(bob); await noOverflow(bob);

    const carol = await settingsTab(w, 'carol', trip);
    await expect(carol.getByRole('note')).toHaveText('You can view this trip. Ask the owner if you need to make changes.');
    await expect(carol.locator('.trip-details')).toContainText('beach');
    const actions = carol.getByRole('region', { name: 'Trip actions' }).or(carol.locator('.trip-settings-actions'));
    await expect(actions.getByRole('button', { name: 'Leave trip' })).toBeVisible();
    for (const name of ['Edit trip', 'Archive', 'Delete trip', 'Transfer ownership…']) await expect(carol.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(carol.getByRole('switch', { name: 'Road trip mode' })).toBeDisabled();
    await audit(carol); await noOverflow(carol); await capture(carol, testInfo, 'trip-settings-viewer');
    await audit(alice); await noOverflow(alice); await capture(alice, testInfo, 'trip-settings-owner');
    // Keyboard: open the form, close it, and focus returns to the button.
    const editButton = alice.getByRole('button', { name: 'Edit trip' });
    await editButton.focus(); await alice.keyboard.press('Enter');
    await expect(form.getByLabel('Trip name')).toBeFocused();
    await alice.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    await expect(editButton).toBeFocused();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('shrinking the dates shows the impact and the member sees the new length', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const alice = await settingsTab(w, 'alice', trip);
    await alice.evaluate(async ({ ref, dates }) => {
      await globalThis.trips.open(ref);
      // The mock hook creates trips without days; lay them out as the app does.
      const ids = [];
      for (const [index, date] of dates.entries()) ids.push(await globalThis.trips.create(ref, 'day', { date, order: 'ABCDE'[index] }));
      await globalThis.trips.create(ref, 'dayNote', { dayId: ids.at(-1), order: 'V', title: 'Fado night' });
      await globalThis.trips.create(ref, 'place', { name: 'Belém Tower', lat: 38.6916, lng: -9.216 });
      await globalThis.trips.flush(ref);
      globalThis.trips.close(ref);
    }, { ref: trip.ref, dates: [10, 11, 12, 13, 14].map(day) });
    const bob = await settingsTab(w, 'bob', trip);
    await expect(bob.locator('.trip-settings-dates')).toContainText('5 days');

    await alice.getByRole('button', { name: 'Edit trip' }).click();
    const form = alice.getByRole('dialog', { name: 'Edit trip' });
    // Moving the start keeps the trip's length.
    await form.getByLabel('Start date').fill(day(11));
    await expect(form.getByLabel('End date')).toHaveValue(day(15));
    await form.getByLabel('Start date').fill(day(10));
    await form.getByLabel('End date').fill(day(12));
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    const impact = alice.getByRole('dialog', { name: 'Change trip dates' });
    await expect(impact).toContainText('2 days will be removed:');
    await expect(impact).toContainText('1 day note will be deleted.');
    await audit(alice); await capture(alice, testInfo, 'trip-settings-redate');
    await impact.getByRole('button', { name: 'Change dates', exact: true }).click();
    await expect(impact).toHaveCount(0);
    await expect(form).toHaveCount(0);
    await expect(alice.locator('.trip-settings-dates')).toContainText('3 days');
    await expect(bob.locator('.trip-settings-dates')).toContainText('3 days');
    const days = await alice.evaluate(async (ref) => { await globalThis.trips.open(ref); await globalThis.trips.sync(ref); return { days: globalThis.trips.list(ref, 'day').length, places: globalThis.trips.names(ref, 'place'), notes: globalThis.trips.list(ref, 'dayNote').length }; }, trip.ref);
    expect(days).toEqual({ days: 3, places: ['Belém Tower'], notes: 0 });
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('moving the dates can shift bookings with the trip, and the member gets the new booking date', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const alice = await settingsTab(w, 'alice', trip);
    await alice.evaluate(async ({ ref, dates, booking }) => {
      await globalThis.trips.open(ref);
      for (const [index, date] of dates.entries()) await globalThis.trips.create(ref, 'day', { date, order: 'ABCDE'[index] });
      await globalThis.trips.create(ref, 'res', { type: 'event', title: 'Fado night', status: 'confirmed', start: { date: booking, time: '21:00' } });
      await globalThis.trips.flush(ref);
      globalThis.trips.close(ref);
    }, { ref: trip.ref, dates: [10, 11, 12, 13, 14].map(day), booking: day(11) });
    await alice.getByRole('button', { name: 'Edit trip' }).click();
    const form = alice.getByRole('dialog', { name: 'Edit trip' });
    await form.getByLabel('Start date').fill(day(12));
    await expect(form.getByLabel('End date')).toHaveValue(day(16));
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    const impact = alice.getByRole('dialog', { name: 'Change trip dates' });
    const keep = impact.getByRole('radio', { name: /^Keep bookings on their dates/ });
    await expect(keep).toHaveAttribute('aria-checked', 'true');
    // Arrow keys move the radio choice, and the impact follows it.
    await keep.focus(); await alice.keyboard.press('ArrowDown');
    await expect(impact.getByRole('radio', { name: /^Move bookings with the trip/ })).toHaveAttribute('aria-checked', 'true');
    await expect(impact).toContainText('1 booking will move with the trip.');
    await audit(alice); await capture(alice, testInfo, 'trip-settings-redate-shift');
    await impact.getByRole('button', { name: 'Change dates', exact: true }).click();
    await expect(impact).toHaveCount(0);
    const bob = await w.open('bob', '#/settings/general');
    await expect.poll(() => bob.evaluate(async (ref) => { await globalThis.trips.open(ref); await globalThis.trips.sync(ref); return globalThis.trips.list(ref, 'res')[0]?.start?.date; }, trip.ref)).toBe(day(13));
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('an offline edit stays on the device and reaches the member after reconnect', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const alice = await settingsTab(w, 'alice', trip);
    const bob = await settingsTab(w, 'bob', trip);
    const context = await w.context('alice');
    await context.setOffline(true);
    await expect(alice.locator('.app-offline').first()).toBeVisible();
    await alice.getByRole('button', { name: 'Edit trip' }).click();
    const form = alice.getByRole('dialog', { name: 'Edit trip' });
    await form.getByLabel('Trip name').fill('Lisbon offline');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(alice.getByRole('heading', { name: 'Lisbon offline', level: 1 })).toBeVisible();
    await expect(alice.locator('.save-state')).toHaveAttribute('data-state', 'offline');
    await capture(alice, testInfo, 'trip-settings-offline');
    await expect(bob.getByRole('heading', { name: 'Lisbon', level: 1 })).toBeVisible();
    await context.setOffline(false);
    await expect(alice.locator('.save-state')).toHaveAttribute('data-state', 'synced');
    await expect(bob.getByRole('heading', { name: 'Lisbon offline', level: 1 })).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('changing the trip currency pins a rate on shared expenses', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const context = await w.context('alice');
    await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({ json: [{ date: day(0), base: 'EUR', quote: 'USD', rate: 1.25 }] }));
    const alice = await settingsTab(w, 'alice', trip);
    await alice.evaluate(async ({ ref, me, other }) => {
      await globalThis.trips.open(ref);
      await globalThis.trips.create(ref, 'exp', { name: 'Dinner', amount: 6000, currency: 'EUR', payers: [{ who: me, amount: 6000 }], split: { mode: 'equal', parts: [{ who: me }, { who: other }] } });
      await globalThis.trips.flush(ref);
      globalThis.trips.close(ref);
    }, { ref: trip.ref, me: '00000000-0000-4000-8000-000000000001', other: '00000000-0000-4000-8000-000000000002' });
    await alice.reload();
    await alice.getByRole('button', { name: 'Edit trip' }).click();
    const form = alice.getByRole('dialog', { name: 'Edit trip' });
    await form.getByLabel('Trip currency').selectOption('USD');
    await expect(form.getByText('Expenses keep their value: each one gets a rate to the new currency at today’s exchange rate.')).toBeVisible();
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(alice.locator('.trip-details')).toContainText('USD');
    const bob = await settingsTab(w, 'bob', trip);
    await expect(bob.locator('.trip-details')).toContainText('USD');
    const expense = await bob.evaluate(async (ref) => { await globalThis.trips.open(ref); await globalThis.trips.sync(ref); return globalThis.trips.list(ref, 'exp')[0]; }, trip.ref);
    expect(expense).toMatchObject({ currency: 'EUR', rate: '1.25' });
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a cover uploaded or picked from image search shows for the member', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const alice = await settingsTab(w, 'alice', trip);
    const bob = await settingsTab(w, 'bob', trip);
    const cover = (page) => page.locator('figure.trip-settings-cover img');

    await alice.getByRole('button', { name: 'Edit trip' }).click();
    const form = alice.getByRole('dialog', { name: 'Edit trip' });
    await form.getByRole('button', { name: 'Choose image' }).click();
    const picker = alice.getByRole('dialog', { name: 'Cover image' });
    await audit(alice);
    const png = readFileSync(new URL('../../public/icons/icon-192.png', import.meta.url));
    await picker.locator('input[type=file]').setInputFiles({ name: 'tram.png', mimeType: 'image/png', buffer: png });
    await expect(picker).toHaveCount(0);
    await expect(form.locator('.cover-preview img')).toBeVisible();
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(cover(alice)).toHaveJSProperty('naturalWidth', 192);
    await expect(cover(bob)).toHaveJSProperty('naturalWidth', 192);

    const photo = 'https://images.example.org/alfama.png';
    for (const as of ['alice', 'bob']) await (await w.context(as)).route(photo, (route) => route.fulfill({ contentType: 'image/png', body: png }));
    await (await w.context('alice')).route('https://api.openverse.org/**', (route) => route.fulfill({ json: { results: [{
      id: 'p1', url: photo, thumbnail: photo, foreign_landing_url: 'https://example.org/photo', license: 'by',
      license_url: 'https://creativecommons.org/licenses/by/4.0/', title: 'Alfama rooftops', creator: 'Ana',
    }] } }));
    await alice.getByRole('button', { name: 'Edit trip' }).click();
    await form.getByRole('button', { name: 'Choose image' }).click();
    await picker.getByRole('group', { name: 'Image source' }).getByRole('button', { name: 'Search' }).click();
    await picker.getByLabel('Search free photos').fill('Lisbon rooftops');
    await picker.getByRole('button', { name: 'Search', exact: true }).last().click();
    await expect(picker.locator('.cover-status')).toHaveText('1 photo. It shows its author and license.');
    await audit(alice); await capture(alice, testInfo, 'trip-settings-cover-search');
    await picker.getByRole('button', { name: 'Use Alfama rooftops' }).click();
    await expect(form.getByText(/^Photo: .*Ana/)).toBeVisible();
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(bob.locator('figure.trip-settings-cover figcaption')).toHaveText(/^Photo: .*Ana/);
    await expect(cover(bob)).toHaveAttribute('src', photo);
    await expect(cover(bob)).toHaveJSProperty('naturalWidth', 192);
    await audit(bob); await noOverflow(bob); await capture(bob, testInfo, 'trip-settings-cover');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
