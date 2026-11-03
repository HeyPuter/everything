import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';

// Q13 week overview: two trips meeting on one day, items from this device's replicas, and a member's view.
const day = (offset) => { const date = new Date(Date.now() + offset * 86_400_000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const ALICE = '00000000-0000-4000-8000-000000000001';
async function weekPage(w, as) {
  const page = await w.open(as, '#/week');
  await expect(page.locator('.week-view .week-summary')).toBeVisible();
  return page;
}
/** Moves forward until the week holding `date` shows (trips here span at most two weeks). */
async function showDay(page, date) {
  const target = page.locator(`.week-day[data-date="${date}"]`);
  for (let step = 0; step < 2 && !(await target.count()); step++) {
    const heading = await page.locator('.week-title').textContent();
    await page.getByRole('button', { name: 'Next week' }).click();
    await expect(page.locator('.week-title')).not.toHaveText(heading);
  }
  await expect(target).toBeVisible();
  return target;
}

test('the week shows two trips meeting on one day with bookings and to-dos, for the owner and a member', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: day(2), end: day(4) });
    const seed = await w.open('alice', '#/settings/general');
    await seed.evaluate(async ({ ref, dates, me }) => {
      const hook = globalThis.trips;
      await hook.open(ref);
      for (const [index, date] of dates.lisbon.entries()) await hook.create(ref, 'day', { date, order: 'BCD'[index] });
      await hook.create(ref, 'res', { type: 'train', title: 'Train to Porto', status: 'confirmed', legs: [{
        from: { name: 'Lisbon' }, to: { name: 'Porto' }, dep: { date: dates.lisbon[2], time: '10:00' }, arr: { date: dates.lisbon[2], time: '13:00' },
      }] });
      await hook.create(ref, 'todo', { name: 'Buy tram pass', order: 'B', due: dates.lisbon[0], who: me });
      await hook.flush(ref);
      hook.close(ref);
      // Porto is never opened here, so only its dates show.
      await hook.createTrip({ title: 'Porto', start: dates.lisbon[2], end: dates.porto });
    }, { ref: trip.ref, dates: { lisbon: [day(2), day(3), day(4)], porto: day(8) }, me: ALICE });
    await seed.close();

    const alice = await weekPage(w, 'alice');
    await expect(alice.getByRole('heading', { name: /^Week of / })).toBeVisible();
    const todo = await showDay(alice, day(2));
    await expect(todo.locator('.week-item[data-kind="todo"]')).toContainText('Buy tram pass');
    await expect(todo.locator('.week-trip')).toContainText('Day 1 of 3');
    const meeting = await showDay(alice, day(4));
    await expect(meeting.locator('.week-trip')).toHaveCount(2);
    const named = (title) => meeting.locator('.week-trip').filter({ has: alice.locator('.week-trip-title', { hasText: new RegExp(`^${title}$`) }) });
    await expect(named('Lisbon')).toContainText('Day 3 of 3');
    await expect(named('Porto')).toContainText('Day 1 of 5');
    await expect(meeting.locator('.week-item[data-kind="booking"]').first()).toContainText('Train to Porto');
    await expect(alice.getByText('Porto is not on this device yet, so only its dates show.')).toBeVisible();
    await expect(meeting.locator('.week-item[data-kind="booking"] a').first()).toHaveAttribute('href', `#/t/${trip.ref.w}/${trip.ref.s}/bookings`);
    await audit(alice); await noOverflow(alice); await capture(alice, testInfo, 'week-boundary');

    // Keyboard: back to this week, and the heading takes focus.
    const thisWeek = alice.getByRole('button', { name: 'This week' });
    if (await thisWeek.isEnabled()) {
      await thisWeek.focus(); await alice.keyboard.press('Enter');
      await expect(alice.locator('.week-title')).toBeFocused();
      await expect(thisWeek).toBeDisabled();
    }
    await alice.getByRole('button', { name: 'Next week' }).focus();
    await alice.keyboard.press('Enter');
    await expect(alice.locator('.week-view [aria-live="polite"]')).toHaveText(/^Week of /);

    // Bob sees the booking once his replica has it.
    const bobTrip = await w.open('bob', trip.hash('bookings'));
    await expect(bobTrip.getByText('Train to Porto').first()).toBeVisible();
    await bobTrip.close();
    const bob = await weekPage(w, 'bob');
    const bobDay = await showDay(bob, day(4));
    await expect(bobDay.locator('.week-item[data-kind="booking"]').first()).toContainText('Train to Porto');
    await expect(bobDay.locator('.week-trip')).toHaveCount(1);
    await expect((await showDay(bob, day(2))).locator('.week-item[data-kind="todo"]')).toHaveCount(0);
    await audit(bob); await noOverflow(bob);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('an empty week points to the next trip', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const seed = await w.open('alice');
    await expect(seed.locator('html')).toHaveAttribute('data-worker', 'ready');
    await seed.evaluate((meta) => globalThis.trips.createTrip(meta), { title: 'Oslo', start: day(30), end: day(33) });
    await seed.close();
    const page = await weekPage(w, 'alice');
    await expect(page.getByRole('heading', { name: 'Nothing this week', level: 3 })).toBeVisible();
    await expect(page.locator('.week-empty')).toContainText('Next up: Oslo');
    await audit(page); await noOverflow(page); await capture(page, testInfo, 'week-empty');
    await page.getByRole('button', { name: 'Show that week' }).click();
    await expect(page.locator('.week-title')).toBeFocused();
    await expect(page.locator(`.week-day[data-date="${day(30)}"] .week-trip`)).toContainText('Oslo');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
