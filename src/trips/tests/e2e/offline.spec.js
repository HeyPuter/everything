import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';

// P11 and the shell's offline boot: Work offline, kept trips, queued edits and the conflict list.
const day = (offset) => { const date = new Date(Date.now() + offset * 86_400_000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
async function offlineSettings(page) {
  await expect(page.getByRole('heading', { name: 'Offline', exact: true })).toBeVisible();
  await expect(page.locator('.offline-settings [aria-busy="true"]')).toHaveCount(0);
}
const tripRow = (page, title) => page.locator('.offline-trip').filter({ has: page.locator('.pref-label', { hasText: title }) });

test('Work offline survives a reload: the dashboard and a kept trip open, and the edit syncs after', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(5), end: day(9) });
    const first = await w.open('alice', trip.hash('settings'));
    await expect(first.locator('.trip-settings-head h2')).toHaveText('Lisbon');
    await first.close();
    const bob = await w.open('bob', trip.hash('settings'));

    const page = await w.open('alice', '#/settings/offline');
    await offlineSettings(page);
    await expect(tripRow(page, 'Lisbon')).toContainText('Kept automatically');
    await audit(page); await noOverflow(page); await capture(page, testInfo, 'offline-settings');
    const force = page.getByRole('switch', { name: 'Work offline', exact: true });
    await force.click();
    await expect(force).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Working offline. Nothing syncs until you turn this off.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Download all now' })).toBeDisabled();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready');
    await offlineSettings(page);
    await expect(force).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.app-offline').first()).toBeVisible();
    await page.getByRole('link', { name: 'Your trips', exact: true }).first().click();
    await expect(page.locator('[data-trip]').filter({ hasText: 'Lisbon' })).toBeVisible();
    await page.goto(`${baseURL}/mock.html${trip.hash('settings')}`);
    await expect(page.locator('.trip-settings-head h2')).toHaveText('Lisbon');
    await page.getByRole('button', { name: 'Edit trip' }).click();
    const form = page.getByRole('dialog', { name: 'Edit trip' });
    await form.getByLabel('Trip name').fill('Lisbon offline');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Lisbon offline', level: 1 })).toBeVisible();
    await expect(page.locator('.save-state')).toHaveAttribute('data-state', 'offline');
    await capture(page, testInfo, 'offline-trip-edit');

    await page.goto(`${baseURL}/mock.html#/settings/offline`);
    await offlineSettings(page);
    await expect(page.getByText('1 change is waiting to sync.')).toBeVisible();
    await expect(tripRow(page, 'Lisbon')).toContainText('Unsent changes');
    await expect(bob.getByRole('heading', { name: 'Lisbon', level: 1 })).toBeVisible();
    await force.click();
    await expect(page.getByText('All changes are synced.')).toBeVisible({ timeout: 20_000 });
    await expect(bob.getByRole('heading', { name: 'Lisbon offline', level: 1 })).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a conflicting offline edit shows in Settings → Offline and Keep mine reaches the member', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(5), end: day(9) });
    // Hook pages stay off the trip route so the app does not open the same space alongside the hook.
    const alice = await w.open('alice', '#/settings/general');
    const placeId = await alice.evaluate(async (ref) => {
      await globalThis.trips.open(ref);
      const id = await globalThis.trips.create(ref, 'place', { name: 'Belém Tower', notes: 'Tickets online' });
      await globalThis.trips.flush(ref);
      return id;
    }, trip.ref);
    const bob = await w.open('bob', '#/settings/general');
    await bob.evaluate(async (ref) => { await globalThis.trips.open(ref); await globalThis.trips.sync(ref); }, trip.ref);

    const context = await w.context('alice');
    await context.setOffline(true);
    await alice.evaluate(([ref, id]) => globalThis.trips.patch(ref, 'place', id, { notes: 'Go early' }, { base: true }), [trip.ref, placeId]);
    await bob.evaluate(async ([ref, id]) => { await globalThis.trips.patch(ref, 'place', id, { notes: 'Closed on Mondays' }, { base: true }); await globalThis.trips.flush(ref); }, [trip.ref, placeId]);
    await context.setOffline(false);
    await expect.poll(async () => alice.evaluate(async (ref) => { await globalThis.trips.flush(ref).catch(() => {}); return globalThis.trips.conflicts(ref).length; }, trip.ref)).toBe(1);
    await alice.evaluate((ref) => globalThis.trips.close(ref), trip.ref);

    const tripPage = await w.open('alice', trip.hash('settings'));
    await expect(tripPage.locator('.save-state')).toHaveAttribute('data-state', 'conflict');
    await expect(tripPage.locator('.save-state')).toHaveText('Some changes need your attention before syncing can continue.');
    await tripPage.close();

    const page = await w.open('alice', '#/settings/offline');
    await offlineSettings(page);
    await expect(tripRow(page, 'Lisbon')).toContainText('Needs your attention');
    const block = page.getByRole('region', { name: 'Conflicts in Lisbon' });
    await expect(block).toContainText('Belém Tower');
    await audit(page);
    await block.getByRole('button', { name: /Review/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Resolve a conflict' });
    await expect(dialog).toContainText('Go early');
    await expect(dialog).toContainText('Closed on Mondays');
    await audit(page); await capture(page, testInfo, 'offline-conflict');
    await dialog.getByRole('button', { name: 'Keep mine', exact: true }).click();
    await expect(page.getByText('Conflict resolved.')).toBeVisible();
    await expect(page.getByText('Nothing needs your attention.')).toBeVisible();
    await expect.poll(() => bob.evaluate(async ([ref, id]) => { await globalThis.trips.sync(ref); return globalThis.trips.get(ref, 'place', id).notes; }, [trip.ref, placeId])).toBe('Go early');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('an ended trip can be kept on the device, and Clear cache asks first', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const seed = await w.open('alice');
    await expect(seed.locator('html')).toHaveAttribute('data-worker', 'ready');
    await seed.evaluate((meta) => globalThis.trips.createTrip(meta), { title: 'Kyoto', start: day(-40), end: day(-35) });
    await seed.close();
    const page = await w.open('alice', '#/settings/offline');
    await offlineSettings(page);
    const kyoto = tripRow(page, 'Kyoto');
    await expect(kyoto).toContainText('Not kept: this trip has ended');
    const keep = page.getByRole('switch', { name: 'Keep Kyoto offline' });
    await keep.focus(); await page.keyboard.press('Space');
    await expect(kyoto).toContainText('Kept on this device');
    await expect(keep).toBeFocused();
    await page.reload();
    await offlineSettings(page);
    await expect(keep).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Clear cache', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Clear the cache?' });
    await audit(page);
    await confirm.getByRole('button', { name: 'Clear cache', exact: true }).click();
    await expect(page.getByText('Cache cleared.')).toBeVisible();
    await audit(page); await noOverflow(page);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a kept trip\'s attachment opens offline from the downloaded copy', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const seed = await w.open('alice');
    await expect(seed.locator('html')).toHaveAttribute('data-worker', 'ready');
    const ref = await seed.evaluate((meta) => globalThis.trips.createTrip(meta), { title: 'Porto', start: day(3), end: day(6) });
    await seed.close();
    const files = await w.open('alice', `#/t/${ref.w}/${ref.s}/files`);
    const chooser = files.waitForEvent('filechooser');
    await files.locator('.files-actions').getByRole('button', { name: 'Upload' }).click();
    await (await chooser).setFiles([{ name: 'ferry.txt', mimeType: 'text/plain', buffer: Buffer.from('Ferry leaves at 09:40 from Ribeira.') }]);
    await expect(files.locator('.file-row')).toHaveCount(1);
    await files.close();

    const page = await w.open('alice', '#/settings/offline');
    await offlineSettings(page);
    await page.getByRole('button', { name: 'Download Porto now' }).click();
    await expect(tripRow(page, 'Porto')).toContainText(/Files \d/, { timeout: 30_000 });
    await page.getByRole('switch', { name: 'Work offline', exact: true }).click();
    await page.goto(`${baseURL}/mock.html#/t/${ref.w}/${ref.s}/files`);
    await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready');
    const row = page.locator('.file-row', { hasText: 'ferry.txt' });
    await expect(row).toBeVisible();
    // The browser goes offline too, so only the downloaded copy can answer.
    const context = await w.context('alice');
    await context.setOffline(true);
    await row.getByRole('button', { name: 'Preview ferry.txt' }).click();
    await expect(page.getByRole('dialog').locator('.file-text-view')).toContainText('Ferry leaves at 09:40');
    await audit(page);
    await context.setOffline(false);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
