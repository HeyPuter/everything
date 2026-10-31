import { test, expect } from '@playwright/test';
import { audit, noOverflow, USERS } from './helpers/bridge-world.js';
import { choose, chooseFiles, failNextCommit, patientWorld, seed, tripFor } from './helpers/trip-flows.js';

const row = (page, title) => page.locator('.res-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
const entry = (page, name) => page.locator('.costs-entry').filter({ has: page.locator('.costs-entry-name', { hasText: new RegExp(`^${name}$`) }) });
const PDF = { name: 'voucher.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% voucher\n%%EOF\n') };

function stay(key, title, days) {
  return { key, type: 'res', fields: { type: 'lodging', title, status: 'confirmed', start: { date: '2026-11-02' }, end: { date: '2026-11-04' }, stay: { fromDayId: days[0], toDayId: days[2] } } };
}
const expense = (name, res) => ({ type: 'exp', fields: {
  name, amount: 24000, currency: 'EUR', date: '2026-11-02', cat: 'accommodation', links: [{ t: 'res', id: { $: res } }],
  payers: [{ who: USERS.alice.uuid, amount: 24000 }], split: { mode: 'equal', parts: [{ who: USERS.alice.uuid }, { who: USERS.bob.uuid }] },
} });

async function startMove(page, title, target) {
  await choose(page, row(page, title).getByRole('button', { name: `Actions for ${title}` }), 'Move to another trip…');
  const dialog = page.getByRole('dialog', { name: 'Move booking' });
  await dialog.getByLabel('Move to').selectOption({ label: target });
  return dialog;
}

test.describe('moving a booking', () => {
  test('a stay with its file and expense moves to another trip for both members', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(200_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const lisbon = await tripFor(w, { title: 'Lisbon', start: '2026-11-02', end: '2026-11-05' });
      const porto = await tripFor(w, { title: 'Porto', start: '2026-11-05', end: '2026-11-08' });
      await seed(w, 'alice', lisbon.ref, [stay('casa', 'Casa do Largo', lisbon.days), expense('Casa do Largo stay', 'casa')]);

      const alice = await w.open('alice', lisbon.hash('bookings'));
      await choose(alice, row(alice, 'Casa do Largo').getByRole('button', { name: 'Actions for Casa do Largo' }), 'Edit');
      const form = alice.getByRole('dialog', { name: 'Edit booking' });
      await form.getByRole('button', { name: 'Add files' }).click();
      const picker = alice.getByRole('dialog', { name: 'Attach files to this booking' });
      await chooseFiles(alice, () => picker.getByRole('button', { name: 'Upload from device' }).click(), [PDF]);
      await expect(picker.getByRole('checkbox', { name: /voucher\.pdf/ })).toHaveAttribute('aria-checked', 'true');
      await picker.getByRole('button', { name: 'Done', exact: true }).click();
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(row(alice, 'Casa do Largo')).toContainText('1 attachment');

      const bobLisbon = await w.open('bob', lisbon.hash('bookings'));
      const bobPorto = await w.open('bob', porto.hash('bookings'));
      await expect(row(bobLisbon, 'Casa do Largo')).toBeVisible();

      const dialog = await startMove(alice, 'Casa do Largo', 'Porto');
      await expect(dialog.getByRole('checkbox', { name: 'Copy the attached file to Porto' })).toBeChecked();
      await expect(dialog.getByRole('checkbox', { name: 'Move the linked expense to Porto' })).toBeChecked();
      await expect(dialog).toContainText('This booking is outside the dates of Porto');
      await audit(alice);
      await noOverflow(alice);
      await dialog.getByRole('button', { name: 'Move booking' }).click();
      await expect(alice.locator('.toast').filter({ hasText: 'Moved “Casa do Largo” to Porto.' })).toBeVisible({ timeout: 20_000 });
      await expect(row(alice, 'Casa do Largo')).toHaveCount(0);

      await expect(row(bobLisbon, 'Casa do Largo')).toHaveCount(0);
      await expect(row(bobPorto, 'Casa do Largo')).toContainText('1 attachment');
      const costs = await w.open('bob', porto.hash('costs'));
      await expect(entry(costs, 'Casa do Largo stay')).toBeVisible();
      const oldCosts = await w.open('bob', lisbon.hash('costs'));
      await expect(oldCosts.getByRole('heading', { name: 'No expenses yet' })).toBeVisible();
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('an unfinished move offers Finish and Keep both, and a booking can move to a new trip', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(200_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const lisbon = await tripFor(w, { title: 'Lisbon', start: '2026-11-02', end: '2026-11-05' });
      const porto = await tripFor(w, { title: 'Porto', start: '2026-11-05', end: '2026-11-08' });
      await seed(w, 'alice', lisbon.ref, [
        stay('casa', 'Casa do Largo', lisbon.days),
        { type: 'res', fields: { type: 'event', title: 'Fado night', status: 'confirmed', start: { date: '2026-11-03', time: '21:00' } } },
        { type: 'res', fields: { type: 'tour', title: 'Sintra tour', status: 'pending', start: { date: '2026-11-04', time: '09:00' } } },
      ]);
      const alice = await w.open('alice', lisbon.hash('bookings'));
      const bobPorto = await w.open('bob', porto.hash('bookings'));

      // The copy reaches Porto, then the removal from Lisbon is cut off.
      await failNextCommit(alice, 0, 'offline', { match: 'res.moveToTrip' });
      let dialog = await startMove(alice, 'Casa do Largo', 'Porto');
      await dialog.getByRole('button', { name: 'Move booking' }).click();
      await expect(dialog.locator('.move-error')).toContainText('could not be removed here', { timeout: 20_000 });
      await alice.keyboard.press('Escape');
      const notice = alice.locator('.move-notice').filter({ hasText: 'Casa do Largo' });
      await expect(notice).toContainText('“Casa do Largo” was copied to Porto but is still here too.');
      await expect(row(bobPorto, 'Casa do Largo')).toBeVisible();
      await audit(alice);
      await notice.getByRole('button', { name: 'Finish move' }).click();
      await expect(row(alice, 'Casa do Largo')).toHaveCount(0);
      await expect(notice).toHaveCount(0);

      await failNextCommit(alice, 0, 'offline', { match: 'res.moveToTrip' });
      dialog = await startMove(alice, 'Fado night', 'Porto');
      await dialog.getByRole('button', { name: 'Move booking' }).click();
      await expect(dialog.locator('.move-error')).toBeVisible({ timeout: 20_000 });
      await alice.keyboard.press('Escape');
      const second = alice.locator('.move-notice').filter({ hasText: 'Fado night' });
      await second.getByRole('button', { name: 'Keep both' }).click();
      await expect(second).toHaveCount(0);
      await expect(row(alice, 'Fado night')).toBeVisible();
      await expect(row(bobPorto, 'Fado night')).toBeVisible();

      dialog = await startMove(alice, 'Sintra tour', 'A new trip…');
      await dialog.getByLabel('New trip name').fill('Sintra');
      await dialog.getByRole('button', { name: 'Move booking' }).click();
      const moved = alice.locator('.toast').filter({ hasText: 'Moved “Sintra tour” to Sintra.' });
      await expect(moved).toBeVisible({ timeout: 30_000 });
      await moved.getByRole('button', { name: 'Open trip' }).click();
      await expect(alice.getByRole('heading', { name: 'Sintra', level: 1 })).toBeVisible();
      await expect(row(alice, 'Sintra tour')).toBeVisible();
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });
});
