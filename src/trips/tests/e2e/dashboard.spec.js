import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';

// P1: the dashboard with trips, created and changed from the UI by the owner and seen by a member.
const day = (offset) => { const date = new Date(Date.now() + offset * 86_400_000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const card = (page, title) => page.locator('[data-trip]').filter({ has: page.getByRole('link', { name: title, exact: true }) });
async function tripMenu(page, title) {
  await page.getByRole('button', { name: `Actions for ${title}`, exact: true }).first().click();
  return page.getByRole('menu');
}
async function dashboard(w, as) {
  const page = await w.open(as, '#/');
  await expect(page.getByRole('heading', { name: 'Your trips', exact: true })).toBeVisible();
  await expect(page.locator('.trip-grid[aria-busy="true"]')).toHaveCount(0);
  return page;
}
async function createTrip(page, { title, start, end }) {
  await page.getByRole('button', { name: 'New trip', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New trip' });
  await dialog.getByLabel('Trip name').fill(title);
  await dialog.getByLabel('Start date').fill(start);
  await dialog.getByLabel('End date').fill(end);
  await dialog.getByRole('button', { name: 'Create trip', exact: true }).click();
  return dialog;
}

test('the owner creates a trip from the empty dashboard and a joined member sees it', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const page = await dashboard(w, 'alice');
    await expect(page.getByRole('heading', { name: 'Plan your first trip', level: 2 })).toBeVisible();
    await expect(page.getByRole('note').getByRole('heading', { name: 'Welcome to Trips' })).toBeVisible();
    await audit(page); await noOverflow(page); await capture(page, testInfo, 'dashboard-empty');
    const dialog = await createTrip(page, { title: 'Porto', start: day(20), end: day(23) });
    await expect(dialog.locator('.trip-progress')).toContainText(/trip server|Creating your trip/);
    await page.waitForURL(/#\/t\/[^/]+\/[^/]+\/plan$/);
    await expect(page.getByRole('heading', { name: 'Porto', level: 1 })).toBeVisible();
    const hash = new URL(page.url()).hash;
    const [, worker, space] = /^#\/t\/([^/]+)\/([^/]+)/.exec(hash);
    await page.close();

    const home = await dashboard(w, 'alice');
    await expect(home.locator('.spotlight')).toContainText('Next trip');
    await expect(home.locator('.spotlight')).toContainText('Starts in 20 days');
    await expect(card(home, 'Porto')).toContainText('Upcoming');
    await audit(home); await noOverflow(home); await capture(home, testInfo, 'dashboard-one-trip');
    const { token } = await home.evaluate(([w, s]) => globalThis.trips.invite({ w, s, k: 'trip' }, { role: 'editor' }), [worker, space]);
    const joining = await w.open('bob', `#/join/${worker}/${space}/${token}`);
    await joining.getByRole('button', { name: 'Join trip', exact: true }).click();
    await joining.waitForURL((url) => url.hash.startsWith(`#/t/${worker}/${space}`));
    await joining.close();

    const bob = await dashboard(w, 'bob');
    await expect(card(bob, 'Porto')).toContainText('Upcoming');
    const menu = await tripMenu(bob, 'Porto');
    await expect(menu.getByRole('menuitem', { name: 'Leave trip' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete trip' })).toHaveCount(0);
    await bob.keyboard.press('Escape');
    await audit(bob);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the owner edits, filters, copies, archives and deletes trips; the member sees the edit and leaves', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const alice = await dashboard(w, 'alice');
    await alice.evaluate((meta) => globalThis.trips.createTrip(meta), { title: 'Kyoto', start: day(-40), end: day(-35) });
    await alice.reload();
    await expect(card(alice, 'Kyoto')).toContainText('Completed');

    await (await tripMenu(alice, 'Lisbon')).getByRole('menuitem', { name: 'Edit trip' }).click();
    const edit = alice.getByRole('dialog', { name: 'Edit trip' });
    await edit.getByLabel('Trip name').fill('Lisbon and Sintra');
    await edit.getByLabel('Tags').fill('coast'); await edit.getByLabel('Tags').press('Enter');
    await audit(alice);
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(card(alice, 'Lisbon and Sintra')).toContainText('coast');

    const bob = await dashboard(w, 'bob');
    await expect(card(bob, 'Lisbon and Sintra')).toBeVisible();

    const filter = alice.getByRole('group', { name: 'Show trips' });
    await filter.getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(alice.locator('[data-trip]')).toHaveCount(1);
    await expect(card(alice, 'Kyoto')).toBeVisible();
    await filter.getByRole('button', { name: 'Planned', exact: true }).click();
    await expect(card(alice, 'Lisbon and Sintra')).toBeVisible();
    await expect(card(alice, 'Kyoto')).toHaveCount(0);
    // Arrow keys move the filter and keep focus on it across the re-render.
    await filter.getByRole('button', { name: 'Planned', exact: true }).press('ArrowLeft');
    await expect(filter.getByRole('button', { name: 'All', exact: true })).toBeFocused();
    await expect(filter.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const tags = alice.getByRole('group', { name: 'Filter by tag' });
    await tags.getByRole('button', { name: 'coast' }).click();
    await expect(alice.locator('[data-trip]')).toHaveCount(1);
    await tags.getByRole('button', { name: 'coast' }).click();

    await alice.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'List' }).click();
    await expect(alice.locator('li.trip-row')).toHaveCount(2);
    await audit(alice); await noOverflow(alice); await capture(alice, testInfo, 'dashboard-list');
    await alice.reload();
    await expect(alice.locator('li.trip-row')).toHaveCount(2);

    await (await tripMenu(alice, 'Kyoto')).getByRole('menuitem', { name: 'Archive' }).click();
    await expect(alice.getByText('Trip archived.')).toBeVisible();
    await expect(card(alice, 'Kyoto')).toHaveCount(0);
    await filter.getByRole('button', { name: 'Archived', exact: true }).click();
    await expect(card(alice, 'Kyoto')).toContainText('Archived');
    await filter.getByRole('button', { name: 'All', exact: true }).click();

    await (await tripMenu(alice, 'Lisbon and Sintra')).getByRole('menuitem', { name: 'Copy trip' }).click();
    const copy = alice.getByRole('dialog', { name: 'Copy trip' });
    await expect(copy.getByLabel('Name of the copy')).toHaveValue('Copy of Lisbon and Sintra');
    await copy.getByRole('checkbox', { name: 'Packing lists' }).uncheck();
    await audit(alice);
    await copy.getByRole('button', { name: 'Copy', exact: true }).click();
    await alice.waitForURL(/\/plan$/);
    await expect(alice.getByRole('heading', { name: 'Copy of Lisbon and Sintra', level: 1 })).toBeVisible();

    await alice.getByRole('link', { name: 'Your trips', exact: true }).first().click();
    await filter.getByRole('button', { name: 'Archived', exact: true }).click();
    await (await tripMenu(alice, 'Kyoto')).getByRole('menuitem', { name: 'Delete trip' }).click();
    await alice.getByRole('dialog', { name: 'Delete “Kyoto”?' }).getByRole('button', { name: 'Delete trip', exact: true }).click();
    await expect(alice.getByText('Trip deleted.')).toBeVisible();
    await expect(card(alice, 'Kyoto')).toHaveCount(0);

    await (await tripMenu(bob, 'Lisbon and Sintra')).getByRole('menuitem', { name: 'Leave trip' }).click();
    await bob.getByRole('dialog', { name: 'Leave “Lisbon and Sintra”?' }).getByRole('button', { name: 'Leave trip', exact: true }).click();
    await expect(card(bob, 'Lisbon and Sintra')).toHaveCount(0);
    await expect(bob.getByRole('heading', { name: 'Plan your first trip', level: 2 })).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the first create explains a missing credit and an unverified email, then succeeds on retry', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const page = await dashboard(w, 'alice');
    w.world.failNext({ method: 'workers.create', as: 'alice', status: 402 });
    const dialog = await createTrip(page, { title: 'Oslo', start: day(30), end: day(32) });
    await expect(dialog.getByRole('alert')).toHaveText('Your Puter credit has run out. Add credit, then try again.');
    const retry = dialog.getByRole('button', { name: 'Try again', exact: true });
    await expect(retry).toBeVisible();
    await audit(page); await capture(page, testInfo, 'dashboard-create-credit');
    w.world.failNext({ method: 'workers.create', as: 'alice', status: 403, code: 'email_not_confirmed' });
    await retry.click();
    await expect(dialog.getByRole('alert')).toHaveText(/^Verify your Puter email address first\./);
    await retry.click();
    await page.waitForURL(/\/plan$/);
    await expect(page.getByRole('heading', { name: 'Oslo', level: 1 })).toBeVisible();
    expect(w.world.counters().calls['workers.create']).toBe(3);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('#/new opens the create dialog by keyboard, and the welcome tip stays dismissed', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const page = await w.open('alice', '#/new');
    const dialog = page.getByRole('dialog', { name: 'New trip' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Trip name')).toBeFocused();
    await audit(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/#\/$/);
    const dismiss = page.getByRole('button', { name: 'Got it', exact: true });
    await dismiss.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('note')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New trip', exact: true })).toBeFocused();
    await expect.poll(() => w.world.inspectKv('alice')['me:prefs']?.tips).toEqual({ dashboard: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Plan your first trip', level: 2 })).toBeVisible();
    await expect(page.getByRole('note')).toHaveCount(0);
    // Keyboard only: the create button, then the form, submitted with Enter.
    await page.getByRole('button', { name: 'New trip', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByLabel('Trip name')).toBeFocused();
    await page.keyboard.type('Rome');
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Start date')).toBeFocused();
    await dialog.getByLabel('Start date').fill(day(40)); await dialog.getByLabel('End date').fill(day(41));
    await dialog.getByLabel('Trip name').press('Enter');
    await page.waitForURL(/\/plan$/);
    await expect(page.getByRole('heading', { name: 'Rome', level: 1 })).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the spotlight, widgets and upcoming bookings reflect an ongoing trip', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(-1), end: day(3) });
    const context = await w.context('alice');
    const rates = [];
    const perEuro = { EUR: 1, USD: 1.1, JPY: 160 };
    await context.route('https://api.frankfurter.dev/**', (route) => {
      const base = new URL(route.request().url()).searchParams.get('base');
      rates.push(base);
      return route.fulfill({ json: Object.keys(perEuro).filter((quote) => quote !== base).map((quote) => ({ date: day(0), base, quote, rate: perEuro[quote] / perEuro[base] })) });
    });
    const seed = await w.open('alice', trip.hash('plan'));
    await seed.evaluate(async ({ ref, date }) => {
      await globalThis.trips.open(ref);
      await globalThis.trips.create(ref, 'res', { type: 'flight', title: 'TP 1350', status: 'confirmed', legs: [{
        from: { code: 'LIS', tz: 'Europe/Lisbon' }, to: { code: 'OPO', tz: 'Europe/Lisbon' },
        dep: { date, time: '09:30' }, arr: { date, time: '10:25' }, carrier: 'TAP', number: '1950', seat: '14C',
      }] });
      await globalThis.trips.flush(ref);
    }, { ref: trip.ref, date: day(2) });
    await seed.close();

    const page = await dashboard(w, 'alice');
    const spotlight = page.locator('.spotlight');
    await expect(spotlight).toContainText('Happening now');
    await expect(spotlight).toContainText('Day 2 of 5');
    await expect(spotlight).toContainText('With bob');
    await expect(spotlight.getByRole('link', { name: 'Next transport: TP 1350' })).toContainText('Seat 14C');
    const widgets = page.getByRole('complementary', { name: 'Widgets' });
    await expect(widgets.getByRole('region', { name: 'Upcoming bookings' }).getByRole('link')).toContainText('TP 1350');
    const fx = widgets.getByRole('region', { name: 'Currency converter' });
    await expect(fx).toContainText('Change the amount or currencies to convert.');
    expect(rates).toEqual([]);
    await fx.getByLabel('Amount').fill('50');
    await fx.getByLabel('From').selectOption('EUR');
    await fx.getByLabel('To').selectOption('JPY');
    await expect(fx.locator('.fx-result')).toHaveText(/€50\.00 = ¥8,000/);
    await expect(fx).toContainText('Frankfurter');
    await fx.getByRole('button', { name: 'Swap currencies' }).click();
    await expect(fx.getByLabel('From')).toHaveValue('JPY');
    await expect(fx.locator('.fx-result')).toHaveText('¥50 = €0.31');
    const clocks = widgets.getByRole('region', { name: 'Time zones' });
    await clocks.getByLabel('Add a time zone').selectOption('Asia/Tokyo');
    await clocks.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(clocks.getByRole('button', { name: 'Remove Tokyo' })).toBeVisible();
    await audit(page); await noOverflow(page); await capture(page, testInfo, 'dashboard-ongoing');
    await page.reload();
    await expect(clocks.getByRole('button', { name: 'Remove Tokyo' })).toBeVisible();
    await expect(fx.locator('.fx-result')).toHaveText('¥50 = €0.31');
    await clocks.getByRole('button', { name: 'Remove Tokyo' }).click();
    await expect(clocks.getByRole('button', { name: 'Remove Tokyo' })).toHaveCount(0);

    // Settings → Dashboard in another tab hides and reorders the tiles here.
    const settings = await w.open('alice', '#/settings/dashboard');
    await settings.getByRole('switch', { name: 'Currency converter' }).click();
    await expect(fx).toHaveCount(0);
    const grip = settings.locator('[data-widget=clocks] [data-sortable-handle]');
    await grip.focus(); await settings.keyboard.press('Alt+ArrowUp'); await settings.keyboard.press('Alt+ArrowUp');
    await expect(widgets.locator('.dash-widget').first()).toHaveClass(/dash-widget-clocks/);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the large trip fixture lists on the dashboard and opens', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort('blockedbyclient'));
  await page.goto('/mock.html?as=alice&reset=1&fixture=large');
  await expect(page.locator('html')).toHaveAttribute('data-fixture', 'ready', { timeout: 120_000 });
  await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready');
  const trip = card(page, 'Grand tour of Europe');
  await expect(trip).toContainText('Upcoming');
  await expect(page.locator('.spotlight')).toContainText('Grand tour of Europe');
  await noOverflow(page);
  await trip.getByRole('link', { name: 'Grand tour of Europe' }).click();
  await expect(page.getByRole('heading', { name: 'Grand tour of Europe', level: 1 })).toBeVisible();
  await expect(page.locator('.trip-tab[data-tab="plan"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('section.trip-tab-view > *').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.view-error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Trip actions' })).toBeEnabled({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
