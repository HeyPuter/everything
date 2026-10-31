import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow, USERS } from './helpers/bridge-world.js';
import { arrowTo, choose, chooseFiles, failNextCommit, patientWorld, seed, setOnline, stopFailingCommits, synced, tabTo, tripFor } from './helpers/trip-flows.js';

const DATES = { start: '2026-11-02', end: '2026-11-05' };
const addButton = (page) => page.locator('.bookings-head').getByRole('button', { name: 'Add booking', exact: true });
const row = (page, title) => page.locator('.res-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
const PDF = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF\n`) });

/** Types into an airport combobox and picks the suggestion for `code`. */
async function airport(scope, label, code) {
  const input = scope.getByRole('combobox', { name: label, exact: true });
  await input.fill(code);
  const option = scope.page().getByRole('option').filter({ hasText: new RegExp(`^${code} · `) }).first();
  await option.dispatchEvent('pointerdown');
  await expect(input).toHaveValue(new RegExp(`^${code} · `));
}

const dinner = { type: 'res', key: 'dinner', fields: { type: 'restaurant', title: 'Dinner', status: 'pending', start: { date: '2026-11-03', time: '20:00' }, people: [USERS.alice.uuid] } };
const train = { type: 'res', key: 'train', fields: {
  type: 'train', title: 'Lisbon to Porto', status: 'confirmed', code: 'XYZ789', people: [USERS.bob.uuid],
  start: { date: '2026-11-04', time: '09:00' }, end: { date: '2026-11-04', time: '11:49' },
  legs: [{ from: { name: 'Lisboa Santa Apolónia', tz: 'Europe/Lisbon' }, to: { name: 'Porto Campanhã', tz: 'Europe/Lisbon' }, dep: { date: '2026-11-04', time: '09:00' }, arr: { date: '2026-11-04', time: '11:49' }, number: 'AP 123' }],
} };

test.describe('bookings', () => {
  test('a two-leg flight from the airport picker and a stay appear for the other member', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const bob = await w.open('bob', trip.hash('bookings'));
      await expect(bob.getByRole('heading', { name: 'No bookings yet' })).toBeVisible();
      await audit(bob);

      const alice = await w.open('alice', trip.hash('bookings'));
      await choose(alice, addButton(alice), 'Flight');
      const form = alice.getByRole('dialog', { name: 'New booking' });
      await audit(alice);
      await form.getByLabel('Name', { exact: true }).fill('Lisbon to New York');
      await airport(form, 'From', 'LIS');
      await airport(form, 'To', 'MAD');
      await form.getByLabel('Departure date', { exact: true }).fill('2026-11-02');
      await form.getByLabel('Departure time', { exact: true }).fill('08:00');
      await form.getByLabel('Arrival time', { exact: true }).fill('10:15');
      await form.getByLabel('Flight number', { exact: true }).fill('TP1026');
      await form.getByRole('button', { name: 'Add connecting leg' }).click();
      const second = form.locator('fieldset.res-leg').nth(1);
      await expect(second.locator('legend')).toHaveText('Leg 2');
      await airport(second, 'To', 'JFK');
      await second.getByLabel('Departure date', { exact: true }).fill('2026-11-02');
      await second.getByLabel('Departure time', { exact: true }).fill('12:00');
      await second.getByLabel('Arrival time', { exact: true }).fill('14:30');
      // Madrid to New York, east to west: 8 h 30 min in the air for 2 h 30 min on the clocks.
      await expect(second.locator('.res-leg-info')).toContainText('8 hr 30 min');
      await form.getByLabel('Confirmation code', { exact: true }).fill('ABC123');
      await form.getByRole('button', { name: 'Add booking', exact: true }).click();
      await expect(form).toBeHidden();

      const flight = row(bob, 'Lisbon to New York');
      await expect(flight).toBeVisible();
      await expect(flight.locator('.res-legs-summary li')).toHaveCount(2);
      await expect(flight.locator('.res-legs-summary li').first()).toContainText('LIS → MAD');
      await expect(flight.locator('.res-legs-summary li').nth(1)).toContainText('MAD → JFK');
      await expect(flight).toContainText('ABC123');

      await choose(bob, addButton(bob), 'Lodging');
      const stay = bob.getByRole('dialog', { name: 'New booking' });
      await stay.getByLabel('Name', { exact: true }).fill('Casa do Largo');
      await stay.getByLabel('Check-in date', { exact: true }).fill('2026-11-02');
      await stay.getByLabel('Check-out date', { exact: true }).fill('2026-11-04');
      await stay.getByLabel('Check-in from', { exact: true }).fill('15:00');
      await stay.getByRole('radio', { name: 'Confirmed' }).click();
      await stay.getByRole('button', { name: 'Add booking', exact: true }).click();
      await expect(stay).toBeHidden();

      await expect(row(alice, 'Casa do Largo')).toBeVisible();
      await alice.getByRole('button', { name: 'By day', exact: true }).click();
      const days = alice.locator('.bookings-group');
      await expect(days).toHaveCount(4);
      await expect(days.nth(0)).toContainText('Lisbon to New York');
      await expect(days.nth(0).locator('.res-entry').filter({ hasText: 'Casa do Largo' })).toContainText('Check-in');
      await expect(days.nth(1).locator('.res-entry').filter({ hasText: 'Casa do Largo' })).toContainText('Stay');
      await expect(days.nth(2).locator('.res-entry').filter({ hasText: 'Casa do Largo' })).toContainText('Check-out');
      await expect(days.nth(3)).toContainText('Nothing booked');
      await audit(alice);
      await noOverflow(alice);
      await capture(alice, testInfo, 'bookings-days');

      await alice.getByRole('button', { name: 'Casa do Largo', exact: true }).first().click();
      const details = alice.getByRole('dialog', { name: 'Casa do Largo' });
      await expect(details).toContainText('Check-in from');
      await audit(alice);
      await alice.keyboard.press('Escape');
      await expect(details).toBeHidden();
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('a viewer reads bookings with hidden codes and filters them by traveler', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
    try {
      const trip = await tripFor(w, { ...DATES, roles: { bob: 'editor', carol: 'viewer' } });
      await seed(w, 'alice', trip.ref, [dinner, train]);

      const settings = await w.open('carol', '#/settings/general');
      const blur = settings.getByRole('switch', { name: 'Hide booking codes' });
      await blur.click();
      await expect(blur).toHaveAttribute('aria-checked', 'true');
      await settings.close();

      const carol = await w.open('carol', trip.hash('bookings'));
      await expect(carol.getByText('You can view bookings on this trip but not change them.')).toBeVisible();
      await expect(addButton(carol)).toBeHidden();
      await expect(carol.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
      const porto = row(carol, 'Lisbon to Porto');
      await expect(porto).not.toContainText('XYZ789');
      await porto.getByRole('button', { name: 'Show confirmation code for Lisbon to Porto' }).click();
      await expect(porto).toContainText('XYZ789');
      await choose(carol, porto.getByRole('button', { name: 'Actions for Lisbon to Porto' }), 'Details');
      const details = carol.getByRole('dialog', { name: 'Lisbon to Porto' });
      await expect(details.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await carol.keyboard.press('Escape');
      await porto.getByRole('button', { name: 'Actions for Lisbon to Porto' }).click();
      await expect(carol.getByRole('menu').getByRole('menuitem')).toHaveText(['Details']);
      await carol.keyboard.press('Escape');

      await carol.getByLabel('Traveler', { exact: true }).selectOption({ label: 'bob' });
      await expect(carol.locator('.res-row')).toHaveCount(1);
      await expect(porto).toBeVisible();
      await carol.getByLabel('Traveler', { exact: true }).selectOption({ label: 'Everyone' });
      await carol.getByRole('button', { name: 'Stays and bookings', exact: true }).click();
      await expect(carol.locator('.res-row')).toHaveCount(1);
      await expect(row(carol, 'Dinner')).toBeVisible();
      await carol.getByLabel('Type', { exact: true }).selectOption({ label: 'Lodging' });
      await expect(carol.getByText('No bookings match these filters.')).toBeVisible();
      await carol.getByRole('button', { name: 'Clear filters' }).click();
      await expect(carol.locator('.res-row')).toHaveCount(2);
      await audit(carol);
      await noOverflow(carol);
      await capture(carol, testInfo, 'bookings-viewer');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('an offline edit syncs on reconnect and a concurrent edit reaches the conflict dialog', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      await seed(w, 'alice', trip.ref, [dinner]);
      const alice = await w.open('alice', trip.hash('bookings'));
      const bob = await w.open('bob', trip.hash('bookings'));
      await expect(row(alice, 'Dinner')).toBeVisible();
      await expect(row(bob, 'Dinner')).toBeVisible();

      const aliceContext = await w.context('alice');
      await setOnline(aliceContext, false);
      await expect(alice.locator('.app-sync .save-state')).toHaveAttribute('data-state', 'offline');
      await choose(alice, addButton(alice), 'Event');
      const event = alice.getByRole('dialog', { name: 'New booking' });
      await event.getByLabel('Name', { exact: true }).fill('Fado night');
      await event.getByLabel('Start date', { exact: true }).fill('2026-11-04');
      await event.getByRole('button', { name: 'Add booking', exact: true }).click();
      await expect(alice.locator('.toast').filter({ hasText: 'Saved on this device' })).toBeVisible();
      await expect(alice.getByText('Offline. Changes stay on this device and are sent when you reconnect.')).toBeVisible();
      await choose(alice, row(alice, 'Dinner').getByRole('button', { name: 'Actions for Dinner' }), 'Mark confirmed');
      await expect(alice.locator('.bookings-group').filter({ hasText: 'Confirmed' })).toContainText('Dinner');
      await expect(row(bob, 'Fado night')).toHaveCount(0);
      await setOnline(aliceContext, true);
      await expect(row(bob, 'Fado night')).toBeVisible();
      await expect(bob.locator('.bookings-group').filter({ hasText: 'Confirmed (1)' })).toContainText('Dinner');
      await synced(alice);

      // Bob saves while Alice has the same booking open; her save then parks a conflict instead of overwriting.
      await choose(alice, row(alice, 'Dinner').getByRole('button', { name: 'Actions for Dinner' }), 'Edit');
      const mine = alice.getByRole('dialog', { name: 'Edit booking' });
      await choose(bob, row(bob, 'Dinner').getByRole('button', { name: 'Actions for Dinner' }), 'Edit');
      const theirs = bob.getByRole('dialog', { name: 'Edit booking' });
      await theirs.getByLabel('Name', { exact: true }).fill('Dinner at Cervejaria');
      await theirs.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(row(alice, 'Dinner at Cervejaria')).toBeVisible();
      await mine.getByLabel('Name', { exact: true }).fill('Dinner at Ramiro');
      await mine.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(mine).toBeHidden();
      const banner = alice.locator('.bookings-conflicts');
      await expect(banner).toContainText('A booking edit conflicts with someone else’s change.');
      await audit(alice);
      await banner.getByRole('button', { name: 'Review' }).click();
      const conflict = alice.getByRole('dialog', { name: 'Resolve a conflict' });
      await expect(conflict).toContainText('Dinner at Cervejaria');
      await audit(alice);
      await conflict.getByRole('button', { name: 'Keep mine', exact: true }).click();
      await expect(conflict).toBeHidden();
      await expect(banner).toHaveCount(0);
      await expect(row(bob, 'Dinner at Ramiro')).toBeVisible();
      await synced(alice);
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('credit and access refusals show in the tab', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const bob = await w.open('bob', trip.hash('bookings'));
      await expect(addButton(bob)).toBeVisible();
      await failNextCommit(bob, 402, 'owner_credit', { times: Infinity });
      await choose(bob, addButton(bob), 'Tour');
      const tour = bob.getByRole('dialog', { name: 'New booking' });
      await tour.getByLabel('Name', { exact: true }).fill('Sintra tour');
      await tour.getByRole('button', { name: 'Add booking', exact: true }).click();
      await expect(bob.getByText('Saving is paused because the trip owner is out of Puter credit.')).toBeVisible();
      await audit(bob);
      await stopFailingCommits(bob);
      await bob.locator('.app-sync').getByRole('button', { name: 'Retry' }).click();
      await expect(bob.getByText('Saving is paused because the trip owner is out of Puter credit.')).toBeHidden();
      await synced(bob);

      await failNextCommit(bob, 403, 'forbidden');
      await choose(bob, row(bob, 'Sintra tour').getByRole('button', { name: 'Actions for Sintra tour' }), 'Mark confirmed');
      await expect(bob.locator('.toast').filter({ hasText: 'A change was refused because you no longer have permission for it, so it was undone.' })).toBeVisible();
      await expect(bob.locator('.bookings-group').filter({ hasText: 'Pending (1)' })).toContainText('Sintra tour');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('a booking can be added and confirmed with the keyboard alone', async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'Keyboard path runs on the desktop projects');
    test.setTimeout(120_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const alice = await w.open('alice', trip.hash('bookings'));
      await expect(alice.getByRole('heading', { name: 'No bookings yet' })).toBeVisible();
      await tabTo(alice, addButton(alice));
      await alice.keyboard.press('Enter');
      await arrowTo(alice, 'Other booking');
      const form = alice.getByRole('dialog', { name: 'New booking' });
      await expect(form.getByLabel('Start date', { exact: true })).toBeFocused();
      await tabTo(alice, form.getByLabel('Name', { exact: true }), { back: true });
      await alice.keyboard.type('Tram 28 pass');
      await tabTo(alice, form.getByLabel('Confirmation code', { exact: true }));
      await alice.keyboard.type('T28-4411');
      await alice.keyboard.press('Control+Enter');
      await expect(form).toBeHidden();
      const pass = row(alice, 'Tram 28 pass');
      await expect(pass).toContainText('T28-4411');
      await tabTo(alice, pass.getByRole('button', { name: 'Actions for Tram 28 pass' }));
      await alice.keyboard.press('Enter');
      await arrowTo(alice, 'Mark confirmed');
      await expect(alice.locator('.bookings-group').filter({ hasText: 'Confirmed (1)' })).toContainText('Tram 28 pass');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('files uploaded from the booking form, and the same file linked to two bookings at once', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      await seed(w, 'alice', trip.ref, [dinner, train]);
      const alice = await w.open('alice', trip.hash('bookings'));
      await choose(alice, row(alice, 'Dinner').getByRole('button', { name: 'Actions for Dinner' }), 'Edit');
      const form = alice.getByRole('dialog', { name: 'Edit booking' });
      await form.getByRole('button', { name: 'Add files' }).click();
      const picker = alice.getByRole('dialog', { name: 'Attach files to this booking' });
      await chooseFiles(alice, () => picker.getByRole('button', { name: 'Upload from device' }).click(), [PDF('tickets.pdf')]);
      await expect(picker.getByRole('checkbox', { name: /tickets\.pdf/ })).toHaveAttribute('aria-checked', 'true');
      await audit(alice);
      await picker.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(form.locator('.res-file')).toContainText('tickets.pdf');
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(row(alice, 'Dinner')).toContainText('1 attachment');

      const bob = await w.open('bob', trip.hash('bookings'));
      await expect(row(bob, 'Dinner')).toContainText('1 attachment');
      // Alice and Bob each link the same file to another booking at the same moment; both links stay.
      await choose(alice, row(alice, 'Lisbon to Porto').getByRole('button', { name: 'Actions for Lisbon to Porto' }), 'Edit');
      await choose(bob, row(bob, 'Dinner').getByRole('button', { name: 'Actions for Dinner' }), 'Duplicate');
      const aliceForm = alice.getByRole('dialog', { name: 'Edit booking' });
      const bobForm = bob.getByRole('dialog', { name: 'New booking' });
      await bobForm.getByLabel('Name', { exact: true }).fill('Second dinner');
      for (const [page, dialog] of [[alice, aliceForm], [bob, bobForm]]) {
        await dialog.getByRole('button', { name: 'Add files' }).click();
        const pick = page.getByRole('dialog', { name: 'Attach files to this booking' });
        await pick.getByRole('checkbox', { name: /tickets\.pdf/ }).click();
        await pick.getByRole('button', { name: 'Done', exact: true }).click();
      }
      await Promise.all([aliceForm.getByRole('button', { name: 'Save', exact: true }).click(), bobForm.getByRole('button', { name: 'Add booking', exact: true }).click()]);
      for (const page of [alice, bob]) {
        for (const title of ['Dinner', 'Lisbon to Porto', 'Second dinner']) await expect(row(page, title)).toContainText('1 attachment');
      }
      await synced(alice);
      await synced(bob);
      const fresh = await w.open('bob', trip.hash('bookings'));
      for (const title of ['Dinner', 'Lisbon to Porto', 'Second dinner']) await expect(row(fresh, title)).toContainText('1 attachment');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });
});
