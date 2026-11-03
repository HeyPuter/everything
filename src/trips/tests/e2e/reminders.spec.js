import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';

// Q13 in-app reminders: shown once per account (toast when visible, browser notification when hidden), one tab only.
const ALICE = '00000000-0000-4000-8000-000000000001';
const local = (date) => ({ date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` });
const FIRED = `trips:notify:fired:${ALICE}`;

/**
 * Seeds a trip with a booking starting in 30 minutes (inside its 1-hour reminder) into Alice's replica. The seeding
 * page holds the reminders lock so its own notifier never shows (and marks) the reminder first.
 */
async function seedDueBooking(w, baseURL, title) {
  const context = await w.context('alice');
  const seed = await context.newPage();
  await seed.addInitScript((uid) => { void navigator.locks.request(`trips-reminders-${uid}`, () => new Promise(() => {})); }, ALICE);
  await seed.goto(`${baseURL}/mock.html#/settings/general`);
  await expect(seed.locator('html')).toHaveAttribute('data-worker', 'ready');
  const start = local(new Date(Date.now() + 30 * 60_000));
  const day = local(new Date());
  await seed.evaluate(async ({ title, start, day }) => {
    const hook = globalThis.trips;
    const ref = await hook.createTrip({ title: 'Lisbon', start: day.date, end: day.date });
    await hook.open(ref);
    await hook.create(ref, 'res', { type: 'event', title, status: 'confirmed', start: { date: start.date, time: start.time } });
    await hook.flush(ref);
    hook.close(ref);
  }, { title, start, day });
  await seed.close();
}
async function weekWith(w, as, title) {
  const page = await w.open(as, '#/week');
  await expect(page.locator('.week-reminders .notify-item').filter({ hasText: title })).toBeVisible();
  // Lets a toast queued in the same pass as the list render land before negative checks.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  return page;
}
const fired = (page) => page.evaluate((key) => Object.keys(JSON.parse(localStorage.getItem(key) ?? '{}')).length, FIRED);

test('a due booking reminder toasts once, not again after a reload, and a second tab does not repeat it', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    await seedDueBooking(w, baseURL, 'Fado show');
    const page = await w.open('alice', '#/week');
    const reminder = page.locator('.toast').filter({ hasText: /^Fado show: in \d+ minutes, .+ · Lisbon/ });
    await expect(reminder).toBeVisible();
    await expect(reminder.getByRole('button', { name: 'Open' })).toBeVisible();
    expect(await fired(page)).toBe(1);
    await audit(page); await noOverflow(page); await capture(page, testInfo, 'reminders-toast');

    const second = await weekWith(w, 'alice', 'Fado show');
    await expect(second.locator('.toast').filter({ hasText: 'Fado show' })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.week-reminders .notify-item').filter({ hasText: 'Fado show' })).toBeVisible();
    await page.close();
    // The second tab takes over the lock once the first is gone, and the reminder stays shown once.
    await second.reload();
    await expect(second.locator('.week-reminders .notify-item').filter({ hasText: 'Fado show' })).toBeVisible();
    await second.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    await expect(second.locator('.toast').filter({ hasText: 'Fado show' })).toHaveCount(0);
    expect(await fired(second)).toBe(1);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a hidden tab with notifications allowed shows a browser notification once', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    await seedDueBooking(w, baseURL, 'Night tram');
    const context = await w.context('alice');
    await context.addInitScript(() => {
      globalThis.__notes = [];
      globalThis.Notification = class {
        static permission = 'granted';
        static requestPermission = async () => 'granted';
        constructor(title, options) { globalThis.__notes.push({ title, ...options }); }
        close() {}
      };
      Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (localStorage.getItem('test:hidden') ? 'hidden' : 'visible') });
      localStorage.setItem('trips:notify', JSON.stringify({ browser: true, offer: 'dismissed' }));
    });
    const page = await context.newPage();
    await page.addInitScript(() => { if (!sessionStorage.getItem('test:shown')) localStorage.setItem('test:hidden', '1'); });
    await page.goto(`${baseURL}/mock.html#/week`);
    await expect.poll(() => page.evaluate(() => globalThis.__notes.map((note) => note.title))).toEqual(['Night tram']);
    expect(await page.evaluate(() => globalThis.__notes[0].body)).toMatch(/^in \d+ minutes, .+ · Lisbon$/);
    await expect(page.locator('.toast')).toHaveCount(0);
    // Back in view, nothing is repeated, and a reload does not notify again.
    await page.evaluate(() => { sessionStorage.setItem('test:shown', '1'); localStorage.removeItem('test:hidden'); document.dispatchEvent(new Event('visibilitychange')); });
    await page.reload();
    await expect(page.locator('.week-reminders .notify-item').filter({ hasText: 'Night tram' })).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    expect(await page.evaluate(() => globalThis.__notes.length)).toBe(0);
    await expect(page.locator('.toast').filter({ hasText: 'Night tram' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Browser notifications' })).toHaveAttribute('aria-checked', 'true');
    await audit(page);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
