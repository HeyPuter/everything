import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow, USERS } from './helpers/bridge-world.js';
import { chooseFiles, patientWorld, seed, tripFor } from './helpers/trip-flows.js';

const DATES = { start: '2026-11-02', end: '2026-11-05' };
const FLIGHT = 'Your flight TP 1234 from LIS → OPO on 2026-11-02, departing 09:30 and arriving 10:25. Booking reference ABC123.';
const HOTEL = 'Hotel Avenida\nCheck-in 2026-11-02, check-out 2026-11-04.\nConfirmation: HXAVQZ';
const row = (page, title) => page.locator('.res-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
const card = (dialog, title) => dialog.locator('.bi-card').filter({ has: dialog.page().locator('.bi-card-main', { hasText: title }) });

/** Statuses of the import jobs saved in the page account's IndexedDB. */
const savedImports = (page) => page.evaluate((account) => new Promise((resolve, reject) => {
  const open = indexedDB.open(`trips-v1:${account}`, 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const statuses = [];
    const cursor = open.result.transaction('records', 'readonly').objectStore('records').openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) { open.result.close(); resolve(statuses); return; }
      if (String(item.key).startsWith('import:')) statuses.push(item.value?.status);
      item.continue();
    };
  };
}), USERS.alice.uuid);

/** Opens a card's editor unless it is open already (cards that need a fix start open). */
async function editDetails(card) {
  const details = card.locator('details.bi-card-edit');
  if (!(await details.evaluate((node) => node.open))) await details.locator(':scope > summary').click();
  await expect(details).toHaveAttribute('open', '');
}

async function openImport(page) {
  await page.locator('.bookings-head').getByRole('button', { name: 'Import', exact: true }).click();
  return page.getByRole('dialog', { name: 'Import bookings' });
}

test.describe('booking import', () => {
  test('pasted text and a chosen file become reviewed bookings that the editor sees', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const bob = await w.open('bob', trip.hash('bookings'));
      const alice = await w.open('alice', trip.hash('bookings'));
      const dialog = await openImport(alice);
      await expect(dialog.getByText('Puter mail isn’t available here.')).toBeVisible();
      await dialog.getByLabel('Paste text').fill(FLIGHT);
      await chooseFiles(alice, () => dialog.getByRole('button', { name: 'Choose files' }).click(), [{ name: 'hotel.txt', mimeType: 'text/plain', buffer: Buffer.from(HOTEL) }]);
      await expect(dialog.locator('.bi-files')).toContainText('hotel.txt');
      await expect(dialog.getByText('Reading uses 2 AI requests, billed to your Puter account.')).toBeVisible();
      await audit(alice);
      await dialog.getByRole('button', { name: 'Read 2' }).click();

      await expect(dialog.getByText('2 bookings found')).toBeVisible({ timeout: 20_000 });
      const flight = card(dialog, 'LIS → OPO');
      const hotel = card(dialog, 'Hotel Avenida');
      await expect(flight).toContainText('Will be added');
      await expect(hotel).toContainText('Will be added');
      await audit(alice);
      await noOverflow(alice);
      await capture(alice, testInfo, 'import-review');
      await editDetails(hotel);
      await hotel.getByLabel('Name', { exact: true }).fill('Hotel Avenida Lisboa');
      await editDetails(flight);
      await flight.getByLabel('Name', { exact: true }).fill('Lisbon to Porto');
      await dialog.getByRole('button', { name: 'Add 2 bookings' }).click();
      await expect(dialog).toBeHidden();
      await expect(alice.locator('.toast').filter({ hasText: 'Added 2 bookings.' })).toContainText('They’re marked “Needs review”.');

      for (const page of [alice, bob]) {
        await expect(row(page, 'Lisbon to Porto')).toContainText('Needs review');
        await expect(row(page, 'Lisbon to Porto')).toContainText('ABC123');
        await expect(row(page, 'Hotel Avenida Lisboa')).toContainText('Needs review');
      }
      await expect(row(bob, 'Hotel Avenida Lisboa')).toContainText('1 attachment');
      await row(bob, 'Lisbon to Porto').getByRole('button', { name: 'Lisbon to Porto', exact: true }).click();
      await expect(bob.getByRole('dialog', { name: 'Lisbon to Porto' })).toContainText('LIS → OPO');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('a duplicate updates the existing booking and a card without a date waits for a fix', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      await seed(w, 'alice', trip.ref, [{ type: 'res', fields: {
        type: 'flight', title: 'Porto hop', status: 'confirmed', code: 'ABC123',
        start: { date: '2026-11-02', time: '09:30' }, end: { date: '2026-11-02', time: '10:25' },
        legs: [{ from: { code: 'LIS', name: 'Lisbon', tz: 'Europe/Lisbon' }, to: { code: 'OPO', name: 'Porto', tz: 'Europe/Lisbon' }, dep: { date: '2026-11-02', time: '09:30' }, arr: { date: '2026-11-02', time: '10:25' } }],
      } }]);
      const alice = await w.open('alice', trip.hash('bookings'));
      await alice.evaluate(() => globalThis.__TRIPS_AI__.script({ kind: 'import', match: 'Ferry', reply: { json: { bookings: [{
        type: 'ferry', title: 'Tagus ferry', status: 'confirmed', legs: [{ from: { name: 'Cais do Sodré' }, to: { name: 'Cacilhas' }, dep: { time: '18:00' }, arr: { time: '18:10' } }],
      }] } } }));
      const dialog = await openImport(alice);
      await dialog.getByLabel('Paste text').fill(`${FLIGHT}\n\nFerry ticket for the evening crossing.`);
      await dialog.getByRole('button', { name: 'Read 1' }).click();
      await expect(dialog.getByText('1 booking found')).toBeVisible({ timeout: 20_000 });
      await dialog.getByRole('button', { name: 'Start over' }).or(dialog.getByRole('button', { name: 'Discard import' })).first().click();
      const confirm = alice.getByRole('dialog', { name: 'Discard this import?' });
      if (await confirm.isVisible()) await confirm.getByRole('button', { name: 'Discard import' }).click();

      const again = await openImport(alice);
      await again.getByLabel('Paste text').fill(FLIGHT);
      await again.getByRole('button', { name: 'Read 1' }).click();
      const dup = card(again, 'LIS → OPO');
      await expect(dup).toContainText('Same confirmation code as “Porto hop”, already in this trip.', { timeout: 20_000 });
      await dup.getByRole('radio', { name: 'Update existing' }).click();
      await expect(dup).toContainText('Updates a booking');
      await audit(alice);
      await again.getByRole('button', { name: 'Add 0 bookings' }).or(again.getByRole('button', { name: /^Add/ })).last().click();
      await expect(alice.locator('.toast').filter({ hasText: 'updated 1' })).toBeVisible();
      await expect(alice.locator('.res-row')).toHaveCount(1);

      const ferry = await openImport(alice);
      await ferry.getByLabel('Paste text').fill('Ferry ticket for the evening crossing.');
      await ferry.getByRole('button', { name: 'Read 1' }).click();
      const tagus = card(ferry, 'Tagus ferry');
      await expect(tagus).toContainText('Needs a fix', { timeout: 20_000 });
      await expect(tagus).toContainText('Fix the marked fields before adding this booking.');
      await expect(ferry.getByRole('button', { name: 'Add 0 bookings' })).toBeDisabled();
      await expect(tagus.locator('details.bi-card-edit')).toHaveAttribute('open', '');
      await editDetails(tagus);
      await tagus.getByLabel('Departure date', { exact: true }).fill('2026-11-03');
      await tagus.getByLabel('Arrival date', { exact: true }).fill('2026-11-03');
      await expect(tagus).toContainText('Will be added');
      await ferry.getByRole('button', { name: 'Add 1 booking' }).click();
      await expect(row(alice, 'Tagus ferry')).toContainText('Needs review');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('the job keeps running with the dialog closed, and an AI credit refusal stops it', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const alice = await w.open('alice', trip.hash('bookings'));
      // A reply that waits for a release flag, so the dialog can be closed while the model is "reading".
      await alice.evaluate(() => {
        globalThis.__release = false;
        globalThis.__TRIPS_AI__.script({ kind: 'import', times: 1, reply: async () => {
          while (!globalThis.__release) await new Promise((resolve) => setTimeout(resolve, 50));
          return { json: { bookings: [{ type: 'restaurant', title: 'Dinner at Ramiro', status: 'confirmed', start: { date: '2026-11-03', time: '20:00' } }] } };
        } });
      });
      let dialog = await openImport(alice);
      await dialog.getByLabel('Paste text').fill('Table for two, dinner at Ramiro on 2026-11-03 at 20:00.');
      await dialog.getByRole('button', { name: 'Read 1' }).click();
      await expect(dialog.getByText('You can close this window.', { exact: false })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
      await expect(dialog).toBeHidden();
      await expect(alice.locator('.bi-entry-status')).toHaveText('Importing 0 of 1…');
      await alice.evaluate(() => { globalThis.__release = true; });
      await expect(alice.locator('.bi-entry-status')).toHaveText('1 booking to review');
      dialog = await openImport(alice);
      await expect(card(dialog, 'Dinner at Ramiro')).toBeVisible();
      await dialog.getByRole('button', { name: 'Add 1 booking' }).click();
      await expect(row(alice, 'Dinner at Ramiro')).toBeVisible();
      await expect(alice.locator('.bi-entry-status')).toBeHidden();

      await alice.evaluate(() => globalThis.__TRIPS_AI__.fail('credit'));
      dialog = await openImport(alice);
      await dialog.getByLabel('Paste text').fill(FLIGHT);
      await dialog.getByRole('button', { name: 'Read 1' }).click();
      await expect(dialog.getByText('Your Puter account doesn’t have enough credit for AI', { exact: false })).toBeVisible({ timeout: 20_000 });
      await audit(alice);
      await expect(alice.locator('.bi-entry-status')).toHaveText('Import stopped');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('Puter mail is read after the permission prompt, and a reload mid-run marks the import interrupted', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      let alice = await w.open('alice', trip.hash('bookings'));
      // The fake runtime has no mailbox; this one holds a single confirmation.
      await alice.evaluate((text) => {
        globalThis.__asked = [];
        globalThis.puter.perms = { request: async (kind, options) => { globalThis.__asked.push([kind, options.path]); return true; } };
        globalThis.puter.email = {
          list: async () => ({ items: [{ id: 'm1', subject: 'Your stay at Hotel Avenida', date: '2026-10-20T10:00:00Z', size: 900 }], cursor: null }),
          get: async () => ({ subject: 'Your stay at Hotel Avenida', date: '2026-10-20T10:00:00Z', from: { name: 'Hotel Avenida', address: 'stay@hotel.example' }, text, html: '', attachments: [] }),
        };
      }, HOTEL);
      let dialog = await openImport(alice);
      await expect(dialog).toContainText('Forward confirmations to alice@puter.email, then choose them here.');
      await dialog.getByRole('button', { name: 'Choose messages' }).click();
      await dialog.getByRole('checkbox', { name: /^Your stay at Hotel Avenida/ }).check();
      expect(await alice.evaluate(() => globalThis.__asked)).toEqual([['fs', '~/.mail']]);
      await audit(alice);
      await dialog.getByRole('button', { name: 'Read 1' }).click();
      await expect(card(dialog, 'Hotel Avenida')).toContainText('Will be added', { timeout: 20_000 });
      await dialog.getByRole('button', { name: 'Add 1 booking' }).click();
      await expect(row(alice, 'Hotel Avenida')).toContainText('Needs review');

      await alice.evaluate(() => globalThis.__TRIPS_AI__.script({ kind: 'import', reply: () => new Promise(() => {}) }));
      dialog = await openImport(alice);
      await dialog.getByLabel('Paste text').fill(FLIGHT);
      await dialog.getByRole('button', { name: 'Read 1' }).click();
      await expect(alice.locator('.bi-entry-status')).toHaveText('Importing 0 of 1…');
      await expect.poll(() => savedImports(alice)).toEqual(['running']);
      await alice.close();
      alice = await w.open('alice', trip.hash('bookings'));
      await expect(alice.locator('.bi-entry-status')).toHaveText('Import stopped');
      dialog = await openImport(alice);
      await expect(dialog).toContainText('The page closed before anything was found. Start over to try again.');
      await dialog.getByRole('button', { name: 'Start over' }).click();
      await expect(dialog.getByLabel('Paste text')).toBeVisible();
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });
});
