import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';

// Shell integration: presence and the Collab badge in the trip header, the trip menu, the phone More menu and help.
const day = (offset) => { const date = new Date(Date.now() + offset * 86_400_000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
async function tripPage(w, as, hash) {
  const page = await w.open(as, hash);
  await expect(page.getByRole('button', { name: 'Trip actions', exact: true })).toBeEnabled();
  return page;
}

test('presence shows who is here and the Collab badge counts the other member’s activity until Collab opens', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const alice = await tripPage(w, 'alice', trip.hash('bookings'));
    const bob = await tripPage(w, 'bob', trip.hash('bookings'));
    await expect(alice.getByRole('img', { name: 'Here now: bob' })).toBeVisible();
    await expect(bob.getByRole('img', { name: 'Here now: alice' })).toBeVisible();

    // Alice reads Collab once so this device has a read marker, then leaves for another tab.
    await alice.locator('.trip-tab[data-tab="collab"]').click();
    await expect(alice.locator('.trip-tab[data-tab="collab"]')).toHaveAttribute('aria-current', 'page');
    await alice.locator('.trip-tab[data-tab="bookings"]').click();
    const hook = await w.open('bob', '#/settings/general');
    await hook.evaluate(async (ref) => {
      await globalThis.trips.open(ref);
      await globalThis.trips.create(ref, 'note', { title: 'Packing ideas' });
      await globalThis.trips.create(ref, 'link', { title: 'Tram 28', url: 'https://example.org/tram' });
      await globalThis.trips.flush(ref);
    }, trip.ref);
    const badge = alice.locator('.trip-tab[data-tab="collab"] .collab-badge');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge.locator('[aria-hidden="true"]')).toHaveText('1');
    await expect(badge.locator('.sr-only')).toHaveText('1 unread update');
    await audit(alice); await noOverflow(alice); await capture(alice, testInfo, 'trip-shell-badge');
    await alice.locator('.trip-tab[data-tab="lists"]').click();
    await expect(badge).toBeVisible();
    await alice.locator('.trip-tab[data-tab="collab"]').click();
    await expect(badge).toBeHidden();
    await alice.locator('.trip-tab[data-tab="plan"]').click();
    await expect(badge).toBeHidden();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the trip menu works by keyboard, and reminder days set by the owner reach the member', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    const owner = await w.open('alice');
    await expect(owner.locator('html')).toHaveAttribute('data-worker', 'ready');
    const ref = await owner.evaluate((meta) => globalThis.trips.createTrip(meta), { title: 'Lisbon', start: day(10), end: day(14) });
    for (const [as, role] of [['bob', 'editor'], ['carol', 'viewer']]) {
      const { token } = await owner.evaluate(([target, value]) => globalThis.trips.invite(target, { role: value }), [ref, role]);
      const joining = await w.open(as, `#/join/${ref.w}/${ref.s}/${token}`);
      await joining.getByRole('button', { name: 'Join trip', exact: true }).click();
      await joining.waitForURL((url) => url.hash.startsWith(`#/t/${ref.w}/${ref.s}`));
      await joining.close();
    }
    await owner.close();
    const hash = (tab) => `#/t/${ref.w}/${ref.s}/${tab}`;

    // Bookings rather than Plan: the Plan tab's own axe findings belong to its module.
    const alice = await tripPage(w, 'alice', hash('bookings'));
    const menuButton = alice.getByRole('button', { name: 'Trip actions', exact: true });
    await menuButton.focus(); await alice.keyboard.press('Enter');
    const menu = alice.getByRole('menu');
    const items = ['Ask the trip assistant', 'Add to calendar…', 'Print or save as PDF', 'Reminders…', 'Import bookings…', 'Build days from photos…',
      'Import a Google Maps route…', 'Import into this trip…', 'Export trip…', 'Start a journey from this trip'];
    await expect(menu.getByRole('menuitem')).toHaveText(items);
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await audit(alice); await capture(alice, testInfo, 'trip-shell-menu');
    for (let index = 0; index < 3; index++) await alice.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Reminders…' })).toBeFocused();
    await alice.keyboard.press('Enter');
    const dialog = alice.getByRole('dialog', { name: 'Reminders' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'On the first day' }).check();
    await dialog.getByRole('checkbox', { name: '3 days before' }).check();
    await audit(alice); await noOverflow(alice);
    await dialog.getByRole('button', { name: 'Save', exact: true }).focus();
    await alice.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(menuButton).toBeFocused();

    const bob = await w.open('bob', hash('settings'));
    await expect(bob.locator('.trip-details')).toContainText('On the first day, 3 days before');
    await bob.getByRole('button', { name: 'Trip actions', exact: true }).click();
    await bob.getByRole('menuitem', { name: 'Reminders…' }).click();
    const read = bob.getByRole('dialog', { name: 'Reminders' });
    await expect(read.getByRole('checkbox', { name: '3 days before' })).toBeChecked();
    await expect(read.getByRole('checkbox', { name: '3 days before' })).toBeDisabled();
    await expect(read).toContainText('Only people who can edit the trip can change these.');
    await expect(read.locator('.notify-item-body')).toHaveText([/^Starts in 3 days/, /^Starts today/]);
    await bob.keyboard.press('Escape');

    const carol = await tripPage(w, 'carol', hash('bookings'));
    await carol.getByRole('button', { name: 'Trip actions', exact: true }).click();
    const viewerItems = carol.getByRole('menu').getByRole('menuitem');
    await expect(viewerItems).not.toContainText(['Import bookings…']);
    await expect(carol.getByRole('menu').getByRole('menuitem', { name: 'Import bookings…' })).toHaveCount(0);
    await expect(carol.getByRole('menu').getByRole('menuitem', { name: 'Build days from photos…' })).toHaveCount(0);
    await audit(carol);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('help opens from the palette and works by keyboard', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const page = await w.open('alice', '#/');
    await page.getByRole('button', { name: 'Command palette', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('combobox', { name: 'Search commands' }).fill('open help');
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Help' });
    await expect(drawer).toBeVisible();
    await audit(page); await capture(page, testInfo, 'help-drawer');
    // The drawer opens on a topic; All topics leads back to the searchable list.
    const back = drawer.getByRole('button', { name: 'All topics' });
    await back.focus(); await page.keyboard.press('Enter');
    await expect(drawer.locator('.help-topic[aria-current="true"]')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    const search = drawer.getByRole('searchbox', { name: 'Search help' });
    await expect(search).toBeFocused();
    await page.keyboard.type('notifications');
    await expect(drawer.locator('.help-topic')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(drawer.locator('.help-topic[data-topic="reminders"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(drawer.locator('.help-title')).toBeFocused();
    await expect(drawer.locator('.help-title')).toHaveText('Reminders and notifications');
    await audit(page); await noOverflow(page);
    await drawer.locator('.help-link').first().focus();
    await page.keyboard.press('Enter');
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(/#\/week$/);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the phone tab bar puts the rest under More, which works by keyboard', async ({ browser, baseURL }, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, 'The tab bar is phone only');
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const page = await w.open('alice', '#/');
    const bar = page.getByRole('navigation', { name: 'Primary navigation' }).filter({ has: page.locator('.app-nav-more') });
    await expect(bar.getByRole('link')).toHaveCount(4);
    const more = bar.getByRole('button', { name: 'More' });
    await more.focus(); await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
    await audit(page);
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/settings/);
    await expect(more).toHaveAttribute('aria-current', 'page');
    await noOverflow(page);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a removed member gets the access banner and can drop the trip from the list', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const bob = await tripPage(w, 'bob', trip.hash('bookings'));
    const owner = await w.open('alice', '#/settings/general');
    await owner.evaluate((ref) => globalThis.trips.call(ref, 'member.remove', { uuid: '00000000-0000-4000-8000-000000000002' }), trip.ref);
    await bob.reload();
    const banner = bob.locator('.trip-banner').filter({ hasText: 'You no longer have access to this trip.' });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(bob.locator('.save-state')).toHaveAttribute('data-state', 'forbidden');
    await audit(bob); await noOverflow(bob); await capture(bob, testInfo, 'trip-shell-forbidden');
    await banner.getByRole('button', { name: 'Remove from my trips' }).click();
    await expect(bob).toHaveURL(/#\/$/);
    await expect(bob.getByRole('heading', { name: 'Plan your first trip', level: 2 })).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
