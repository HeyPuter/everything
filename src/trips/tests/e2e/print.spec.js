import { test, expect } from '@playwright/test';
import { USERS, audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';
import { seed, synced, tripMenu } from './helpers/trip-tools.js';

const DATES = { start: '2026-11-02', end: '2026-11-04' };
const CONTENT = [
  { key: 'd1', type: 'day', fields: { order: 'a', date: '2026-11-02', title: 'Old town', notes: '**Bring** cash for the tram.' } },
  { key: 'd2', type: 'day', fields: { order: 'b', date: '2026-11-03', title: 'Belém' } },
  { key: 'd3', type: 'day', fields: { order: 'c', date: '2026-11-04' } },
  { key: 'castle', type: 'place', fields: { name: 'São Jorge Castle', lat: 38.7139, lng: -9.1334, address: 'R. de Santa Cruz do Castelo' } },
  { key: 'tower', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216 } },
  { type: 'visit', fields: { dayId: { $: 'd1' }, placeId: { $: 'castle' }, order: 'a', start: '10:00', end: '12:00' } },
  { type: 'visit', fields: { dayId: { $: 'd2' }, placeId: { $: 'tower' }, order: 'a' } },
  { type: 'res', fields: { type: 'flight', title: 'TP 1234', status: 'confirmed', code: 'ABC123',
    legs: [{ from: { code: 'LHR' }, to: { code: 'LIS' }, dep: { date: '2026-11-02', time: '07:10' }, arr: { date: '2026-11-02', time: '09:45' } }] } },
  { type: 'pack', fields: { name: 'Rain jacket', list: 'Clothes', order: 'a' } },
  { type: 'exp', fields: { name: 'Museum tickets', amount: 2400, currency: 'EUR', payers: [{ who: USERS.alice.uuid, amount: 2400 }], split: { mode: 'equal', parts: [{ who: USERS.alice.uuid }] } } },
  { type: 'note', fields: { title: 'Tram 28 tips', body: 'Board at Martim Moniz.' } },
];

async function openPrint(page) {
  await tripMenu(page, 'Print or save as PDF');
  const dialog = page.getByRole('dialog', { name: 'Print or save as PDF' });
  await expect(dialog.locator('iframe.print-frame')).toBeAttached();
  return dialog;
}
const paper = (page) => page.frameLocator('iframe.print-frame');
/** Waits until map images settle (the bridge blocks map tiles, so they fall back to route summaries). */
async function ready(dialog) {
  await expect(dialog.locator('.print-status-text')).toContainText('Ready.', { timeout: 75_000 });
}
async function stubPrint(page) {
  await page.evaluate(() => {
    const frame = document.querySelector('iframe.print-frame').contentWindow;
    globalThis.__printed = 0;
    frame.print = () => { globalThis.__printed += 1; };
  });
}

let w;
test.afterEach(async () => { expect(w?.errors ?? []).toEqual([]); await w?.close(); w = null; });

test('the print view previews the trip on light paper, follows its options and the other member\'s edits, and prints', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  const ids = await seed(w, 'alice', trip.ref, CONTENT);
  const page = await w.open('bob', trip.hash('settings'));
  await synced(page);
  const dialog = await openPrint(page);
  const doc = paper(page);
  await expect(doc.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(doc.locator('.pr-cover .pr-title')).toHaveText('Lisbon');
  await expect(doc.locator('.pr-stat', { hasText: 'Days' }).locator('dd')).toHaveText('3');
  await expect(doc.locator('.pr-stat', { hasText: 'Places' }).locator('dd')).toHaveText('2');
  await expect(doc.locator('.pr-stat', { hasText: 'Bookings' }).locator('dd')).toHaveText('1');
  await expect(doc.locator('.pr-day')).toHaveCount(3);
  await expect(doc.locator('.pr-day').first()).toContainText('Old town');
  await expect(doc.locator('.pr-day').first()).toContainText('São Jorge Castle');
  await expect(doc.locator('.pr-day').first()).toContainText('R. de Santa Cruz do Castelo');
  await expect(doc.locator('.pr-day-notes strong')).toHaveText('Bring');
  await expect(doc.locator('.pr-bookings')).toContainText('TP 1234');
  await ready(dialog);
  await expect(dialog.getByRole('button', { name: 'Print', exact: true })).toHaveAttribute('aria-busy', 'false');
  await audit(page); await noOverflow(page); await capture(page, testInfo, 'print-view');

  // Sections, day range, detail, orientation and text size.
  await dialog.getByLabel('Bookings').uncheck();
  await expect(doc.locator('.pr-bookings')).toHaveCount(0);
  await dialog.getByLabel('Packing list').check();
  await dialog.getByLabel('Costs summary').check();
  await dialog.getByLabel('Notes').check();
  await expect(doc.locator('.pr-packing')).toContainText('Rain jacket');
  await expect(doc.locator('.pr-costs')).toContainText('Total spend: €24.00');
  await expect(doc.locator('.pr-notes')).toContainText('Tram 28 tips');
  await dialog.getByLabel('From').selectOption({ index: 1 });
  await expect(doc.locator('.pr-day')).toHaveCount(2);
  await expect(doc.locator('.print-doc')).not.toContainText('Old town');
  await dialog.getByRole('button', { name: 'All days', exact: true }).click();
  await expect(doc.locator('.pr-day')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Compact', exact: true }).click();
  await expect(doc.locator('.print-doc')).toHaveAttribute('data-detail', 'compact');
  await expect(doc.locator('.print-doc')).not.toContainText('R. de Santa Cruz do Castelo');
  await expect(dialog.getByLabel('Place photos')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Landscape', exact: true }).click();
  await dialog.getByRole('button', { name: 'Large', exact: true }).click();
  await expect(doc.locator('.print-doc')).toHaveAttribute('data-font', 'large');
  expect(await doc.locator('head style').last().textContent()).toContain('size: landscape');

  // Alice's edit reaches Bob's open preview.
  await seed(w, 'alice', trip.ref, [{ type: 'place', key: 'market', fields: { name: 'Time Out Market', lat: 38.7071, lng: -9.1457 } },
    { type: 'visit', fields: { dayId: ids.d2, placeId: { $: 'market' }, order: 'b', start: '13:00' } }]);
  await expect(doc.locator('.pr-day').nth(1)).toContainText('Time Out Market', { timeout: 15_000 });

  await stubPrint(page);
  // Footer buttons by keyboard: see press() in helpers/trip-tools.js.
  await dialog.getByRole('button', { name: 'Print', exact: true }).press('Enter');
  await expect.poll(() => page.evaluate(() => globalThis.__printed)).toBe(1);
  await page.keyboard.press('ControlOrMeta+p');
  await expect.poll(() => page.evaluate(() => globalThis.__printed)).toBe(2);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Trip actions', exact: true })).toBeFocused();
  // Options are kept on this device.
  const later = await w.open('bob', trip.hash('settings'));
  const again = await openPrint(later);
  await expect(again.getByRole('button', { name: 'Landscape', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(again.getByLabel('Notes')).toBeChecked();
});

test('offline, the print view summarizes routes; phones switch between options and preview; Mod+P opens it', async ({ browser, baseURL }, testInfo) => {
  w = await bridgeWorld(browser, testInfo, baseURL);
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES });
  await seed(w, 'alice', trip.ref, CONTENT);
  const page = await w.open('alice', trip.hash('settings'));
  await synced(page);
  // The view loads on first use; load it once online.
  await openPrint(page);
  await page.keyboard.press('Escape');
  await page.context().setOffline(true);

  await page.getByRole('heading', { name: 'Lisbon', level: 2 }).click();
  await page.keyboard.press('ControlOrMeta+p');
  const dialog = page.getByRole('dialog', { name: 'Print or save as PDF' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.print-status-text')).toContainText('Map images need a connection, so route summaries are shown instead.');
  await expect(paper(page).locator('.pr-map-section')).toContainText('Map images need a connection. The route is summarized below.');

  if (testInfo.project.use.isMobile) {
    const show = dialog.getByRole('group', { name: 'Show' });
    await expect(dialog.locator('.print-layout')).toHaveAttribute('data-show', 'options');
    await show.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(dialog.locator('.print-layout')).toHaveAttribute('data-show', 'preview');
    expect(await dialog.locator('form.print-options').evaluate((node) => node.inert)).toBe(true);
    await capture(page, testInfo, 'print-phone-preview');
  }
  await audit(page);
  await stubPrint(page);
  await dialog.getByRole('button', { name: 'Print', exact: true }).press('Enter');
  await expect.poll(() => page.evaluate(() => globalThis.__printed)).toBe(1);
  await dialog.locator('.modal-head').getByRole('button', { name: 'Close' }).press('Enter');
  await expect(dialog).toBeHidden();
});
