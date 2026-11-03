import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow } from './helpers/bridge-world.js';
import { seed, read, isoDay } from './helpers/providers.js';
import { SYNC, above, center, day, grip, isNarrow, menuPick, mouseDrag, openPlan, planWorld, rowTitles, showPane, touchDrag } from './helpers/plan.js';

// P2a day planner: days, visits, notes, items, drag and drop, undo and redo, between two accounts.
const LISBON = [
  { key: 'p1', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216, cc: 'PT', cat: 'attraction' } },
  { key: 'p2', type: 'place', fields: { name: 'Time Out Market', lat: 38.7069, lng: -9.1459, cc: 'PT', cat: 'restaurant' } },
  { key: 'p3', type: 'place', fields: { name: 'Castelo de São Jorge', lat: 38.7139, lng: -9.1335, cc: 'PT', cat: 'attraction' } },
];
const dated = (count, from = 30) => Array.from({ length: count }, (_, index) => ({ key: `d${index + 1}`, type: 'day', fields: { order: 'VWXYZ'[index], date: isoDay(from + index) } }));

test('two editors set up days, add visits, notes and items, and undo and redo', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(32) });
    await seed(w, trip.ref, LISBON);
    const alice = await openPlan(w, 'alice', trip);
    await alice.getByRole('button', { name: 'Set up days', exact: true }).click();
    await expect(alice.locator('.plan-day')).toHaveCount(3);
    const bob = await openPlan(w, 'bob', trip);
    await expect(bob.locator('.plan-day')).toHaveCount(3, SYNC);
    const days = await alice.locator('.plan-day').evaluateAll((nodes) => nodes.map((node) => node.dataset.day));

    // Alice adds two places to day 1 from the picker.
    await menuPick(alice, day(alice, days[0]).getByRole('button', { name: /^Add to Day 1/ }), 'Add places…');
    const picker = alice.getByRole('dialog', { name: /^Add places to Day 1/ });
    await picker.getByRole('checkbox', { name: /Belém Tower/ }).click();
    await picker.getByRole('checkbox', { name: /Time Out Market/ }).click();
    await picker.getByRole('button', { name: 'Add selected (2)' }).click();
    await expect(rowTitles(alice, days[0])).toHaveText(['Belém Tower', 'Time Out Market']);
    await expect(rowTitles(bob, days[0])).toHaveText(['Belém Tower', 'Time Out Market'], SYNC);

    // Bob adds a note to day 2 and a timed item without a place to day 3.
    await menuPick(bob, day(bob, days[1]).getByRole('button', { name: /^Add to Day 2/ }), 'Add note…');
    const note = bob.getByRole('dialog', { name: /^Add a note to Day 2/ });
    await note.getByLabel('Title').fill('Buy tram tickets');
    await note.getByRole('radio', { name: 'Ticket' }).click();
    await note.getByRole('button', { name: 'Add', exact: true }).click();
    await menuPick(bob, day(bob, days[2]).getByRole('button', { name: /^Add to Day 3/ }), 'Add item…');
    const item = bob.getByRole('dialog', { name: /^Add an item to Day 3/ });
    await item.getByLabel('Title').fill('Dinner with Ana');
    await item.getByLabel('Start').fill('20:00');
    await item.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(rowTitles(bob, days[1])).toHaveText(['Buy tram tickets']);
    await expect(rowTitles(bob, days[2])).toHaveText(['Dinner with Ana']);
    await expect(rowTitles(alice, days[1])).toHaveText(['Buy tram tickets'], SYNC);
    await expect(day(alice, days[2]).locator('.plan-row', { hasText: 'Dinner with Ana' }).locator('.plan-time')).toHaveText(/8:00|20:00/, SYNC);

    // Undo takes Alice's last change back for both of them; redo restores it.
    await alice.getByRole('button', { name: 'Undo add to day' }).click();
    await expect(rowTitles(alice, days[0])).toHaveCount(0);
    await expect(rowTitles(bob, days[0])).toHaveCount(0, SYNC);
    await alice.locator('.plan-col-title').click();
    await alice.keyboard.press('ControlOrMeta+Shift+z');
    await expect(rowTitles(alice, days[0])).toHaveText(['Belém Tower', 'Time Out Market']);
    await expect(rowTitles(bob, days[0])).toHaveText(['Belém Tower', 'Time Out Market'], SYNC);

    // "What's next" lists timed rows across days.
    await alice.locator('.plan-next summary').click();
    await expect(alice.locator('.plan-next-list')).toContainText('Dinner with Ana');

    for (const page of [alice, bob]) { await audit(page); await noOverflow(page); }
    await capture(alice, testInfo, 'plan-alice');
    await capture(bob, testInfo, 'plan-bob');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('rows move by mouse drag, long press and keyboard, and the other editor sees each move', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(31) });
    const ids = await seed(w, trip.ref, [...dated(2), ...LISBON,
      { key: 'a', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V' } },
      { key: 'b', type: 'visit', fields: { dayId: '$d1', placeId: '$p2', order: 'W' } },
      { key: 'n', type: 'dayNote', fields: { dayId: '$d2', order: 'V', title: 'Pack for the beach' } },
    ]);
    const alice = await openPlan(w, 'alice', trip);
    const bob = await openPlan(w, 'bob', trip);
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Belém Tower', 'Time Out Market']);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Belém Tower', 'Time Out Market'], SYNC);

    // Mouse: on wide layouts onto day 2's list above the note; at phone width onto day 2's rail chip.
    const narrow = isNarrow(testInfo);
    const target = narrow ? alice.locator(`.plan-rail-chip[data-day="${ids.d2}"]`) : day(alice, ids.d2).locator('.plan-row').first();
    await mouseDrag(alice, grip(alice, `visit:${ids.a}`), () => (narrow ? center(target) : above(target)));
    await expect(rowTitles(alice, ids.d2)).toHaveText(narrow ? ['Pack for the beach', 'Belém Tower'] : ['Belém Tower', 'Pack for the beach']);
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Time Out Market']);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Time Out Market'], SYNC);

    // Dragging out of every list and releasing leaves the row where it was.
    await mouseDrag(alice, grip(alice, `visit:${ids.b}`), () => center(alice.locator('.trip-tab[data-tab="plan"]')));
    await expect(alice.locator('body')).not.toHaveClass(/dnd-active/);
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Time Out Market']);
    await expect(alice.locator('.card-placeholder')).toHaveCount(0);

    // With the places pane beside the days, a pool place drags onto a day.
    if (!narrow) {
      await mouseDrag(alice, alice.locator('.pl-row', { hasText: 'Castelo de São Jorge' }), () => above(day(alice, ids.d1).locator('.plan-row').first()));
      await expect(rowTitles(alice, ids.d1)).toHaveText(['Castelo de São Jorge', 'Time Out Market']);
      await expect(rowTitles(bob, ids.d1)).toHaveText(['Castelo de São Jorge', 'Time Out Market'], SYNC);
      await alice.getByRole('button', { name: 'Undo add to day' }).click();
      await expect(rowTitles(alice, ids.d1)).toHaveText(['Time Out Market']);
    }

    // A long press on touch picks the row up without its grip.
    if (narrow) {
      await touchDrag(alice, day(alice, ids.d1).locator('.plan-row-main').first(), () => center(alice.locator(`.plan-rail-chip[data-day="${ids.d2}"]`)));
      await expect(rowTitles(alice, ids.d1)).toHaveCount(0);
      await expect(rowTitles(alice, ids.d2)).toContainText(['Time Out Market']);
      await alice.getByRole('button', { name: /^Undo/ }).first().click();
      await expect(rowTitles(alice, ids.d1)).toHaveText(['Time Out Market']);
    }

    // Keyboard: Alt+Arrow Down past the last row of day 1 goes to the top of day 2, then moves within it.
    await grip(alice, `visit:${ids.b}`).focus();
    await alice.keyboard.press('Alt+ArrowDown');
    await expect(rowTitles(alice, ids.d1)).toHaveCount(0);
    await expect(rowTitles(alice, ids.d2).first()).toHaveText('Time Out Market');
    await expect(grip(alice, `visit:${ids.b}`)).toBeFocused();
    await alice.keyboard.press('Alt+ArrowDown');
    await expect(rowTitles(alice, ids.d2).nth(1)).toHaveText('Time Out Market');
    const moved = await rowTitles(alice, ids.d2).allTextContents();
    await expect(rowTitles(bob, ids.d2)).toHaveText(moved, SYNC);

    // Undo and redo the last keyboard move.
    await alice.keyboard.press('ControlOrMeta+z');
    await expect(rowTitles(alice, ids.d2).first()).toHaveText('Time Out Market');
    await alice.keyboard.press('ControlOrMeta+Shift+z');
    await expect(rowTitles(alice, ids.d2)).toHaveText(moved);

    // Bob moves the note to day 1 with "Move to day…".
    await menuPick(bob, day(bob, ids.d2).getByRole('button', { name: 'Actions for Pack for the beach' }), 'Move to day…');
    await bob.getByRole('dialog', { name: 'Move Pack for the beach to' }).getByRole('button', { name: /^Day 1/ }).click();
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Pack for the beach']);
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Pack for the beach'], SYNC);

    // Days reorder by keyboard on their grip; dated content follows the new date.
    await alice.locator(`[data-focus="dayGrip:${ids.d2}"]`).focus();
    await alice.keyboard.press('Alt+ArrowUp');
    await expect(alice.locator('.plan-day').first()).toContainText('Day 1');
    await expect(day(alice, ids.d2)).toContainText('Day 1');
    await expect(day(bob, ids.d2)).toContainText('Day 1', SYNC);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('an editor removes a day after seeing its impact, and later days move up', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(32) });
    const ids = await seed(w, trip.ref, [...dated(3), ...LISBON,
      { key: 'a', type: 'visit', fields: { dayId: '$d2', placeId: '$p1', order: 'V' } },
      { key: 'n', type: 'dayNote', fields: { dayId: '$d2', order: 'W', title: 'Laundry' } },
    ]);
    const bob = await openPlan(w, 'bob', trip);
    await expect(bob.locator('.plan-day')).toHaveCount(3, SYNC);
    await menuPick(bob, day(bob, ids.d2).getByRole('button', { name: /^Actions for Day 2/ }), 'Remove day');
    const dialog = bob.getByRole('dialog', { name: /^Remove Day 2/ });
    await expect(dialog.locator('.plan-impact')).toContainText('Remove visits from this day: 1');
    await expect(dialog.locator('.plan-impact')).toContainText('Delete day notes: 1');
    await expect(dialog.locator('.plan-impact')).toContainText('Move later days up a day: 1');
    await expect(dialog.locator('.plan-impact')).toContainText('End the trip on');
    await audit(bob);
    await dialog.getByRole('button', { name: 'Remove day', exact: true }).click();
    await expect(bob.locator('.plan-day')).toHaveCount(2);
    const alice = await openPlan(w, 'alice', trip);
    await expect(alice.locator('.plan-day')).toHaveCount(2, SYNC);
    // Day 3 now has day 2's date, the trip ends a day earlier, and the place stays in the pool.
    await expect(day(alice, ids.d3)).toContainText('Day 2');
    expect(await read(w, trip.ref, [['day', ids.d3], ['meta', 'meta']])).toMatchObject([{ date: isoDay(31) }, { end: isoDay(31) }]);
    await showPane(alice, 'Places');
    await expect(alice.locator('.pl-row', { hasText: 'Belém Tower' })).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a viewer reads the plan without edit controls', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await planWorld(browser, testInfo, baseURL, { users: ['alice', 'carol'] });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(31), role: 'viewer' });
    const ids = await seed(w, trip.ref, [...dated(2), ...LISBON,
      { key: 'a', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V', start: '10:00' } },
    ]);
    const carol = await openPlan(w, 'carol', trip);
    await expect(rowTitles(carol, ids.d1)).toHaveText(['Belém Tower'], SYNC);
    await expect(carol.locator('.plan-note')).toHaveText('You can view this plan. Ask an editor or the owner to make changes.');
    await expect(carol.locator('.plan-grip')).toHaveCount(0);
    await expect(carol.getByRole('button', { name: 'Add day' })).toBeHidden();
    await expect(carol.getByRole('button', { name: /^Add to Day/ })).toHaveCount(0);
    await carol.getByRole('button', { name: 'Actions for Belém Tower' }).click();
    const menu = carol.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Show on map', 'Open place']);
    await carol.keyboard.press('Escape');
    // Alt+Arrow on a row does nothing for a viewer.
    await carol.locator(`[data-focus="row:visit:${ids.a}"]`).focus();
    await carol.keyboard.press('Alt+ArrowDown');
    await expect(rowTitles(carol, ids.d1)).toHaveText(['Belém Tower']);
    await audit(carol);
    await noOverflow(carol);
    await capture(carol, testInfo, 'plan-viewer');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('offline edits sync after reconnecting, and a clashing edit opens the conflict review', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(31) });
    const ids = await seed(w, trip.ref, [...dated(2), ...LISBON,
      { key: 'a', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V' } },
    ]);
    const alice = await openPlan(w, 'alice', trip);
    const bob = await openPlan(w, 'bob', trip);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Belém Tower'], SYNC);
    const bobContext = await w.context('bob');
    await bobContext.setOffline(true);
    await expect.poll(() => w.host.stats().offlinePages).toBeGreaterThan(0);

    // Offline: Bob adds a note (no clash) and edits the visit's notes (clashes with Alice below).
    await menuPick(bob, day(bob, ids.d2).getByRole('button', { name: /^Add to Day 2/ }), 'Add note…');
    const note = bob.getByRole('dialog', { name: /^Add a note to Day 2/ });
    await note.getByLabel('Title').fill('Offline note');
    await note.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(rowTitles(bob, ids.d2)).toHaveText(['Offline note']);
    await menuPick(bob, day(bob, ids.d1).getByRole('button', { name: 'Actions for Belém Tower' }), 'Edit…');
    let form = bob.getByRole('dialog', { name: 'Belém Tower' });
    await form.getByLabel('Notes', { exact: true }).fill('Bob: go early');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(day(bob, ids.d1).locator('.plan-row-notes')).toHaveText('Bob: go early');
    await expect(bob.locator('.save-state')).toHaveAttribute('data-state', 'offline');

    await menuPick(alice, day(alice, ids.d1).getByRole('button', { name: 'Actions for Belém Tower' }), 'Edit…');
    form = alice.getByRole('dialog', { name: 'Belém Tower' });
    await form.getByLabel('Notes', { exact: true }).fill('Alice: book tickets');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(day(alice, ids.d1).locator('.plan-row-notes')).toHaveText('Alice: book tickets');
    // Bob reconnects only once Alice's edit is on the worker.
    await expect.poll(async () => (await read(w, trip.ref, [['visit', ids.a]]))[0]?.notes, SYNC).toBe('Alice: book tickets');

    await bobContext.setOffline(false);
    await expect.poll(() => w.host.stats().offlinePages).toBe(0);
    await expect(rowTitles(alice, ids.d2)).toHaveText(['Offline note'], SYNC);
    const banner = bob.locator('.plan-banner-warn');
    await expect(banner).toContainText('Changes that could not be saved: 1', SYNC);
    await audit(bob);
    await capture(bob, testInfo, 'plan-conflict');
    await banner.getByRole('button', { name: 'Review' }).click();
    const review = bob.getByRole('dialog', { name: 'Resolve a conflict' });
    await expect(review).toContainText('Bob: go early');
    await expect(review).toContainText('Alice: book tickets');
    await review.getByRole('button', { name: 'Keep mine' }).click();
    await expect(banner).toHaveCount(0);
    await expect(day(alice, ids.d1).locator('.plan-row-notes')).toHaveText('Bob: go early', SYNC);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('refused writes: low credit pauses sync until retry, and a demoted editor loses edit controls', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(31) });
    const ids = await seed(w, trip.ref, [...dated(2), ...LISBON]);
    const alice = await openPlan(w, 'alice', trip);
    const bob = await openPlan(w, 'bob', trip);
    await expect(bob.locator('.plan-day')).toHaveCount(2, SYNC);

    // 402: Bob's writes wait, the status says why, and Retry sends them once credit is back.
    w.world.failNext({ method: 'workers.exec', as: 'bob', status: 402, code: 'insufficient_funds', times: 3 });
    await menuPick(bob, day(bob, ids.d1).getByRole('button', { name: /^Add to Day 1/ }), 'Add note…');
    const note = bob.getByRole('dialog', { name: /^Add a note to Day 1/ });
    await note.getByLabel('Title').fill('Paid note');
    await note.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(bob.locator('.save-state')).toHaveAttribute('data-state', 'credit', SYNC);
    await expect(bob.locator('.save-state')).toHaveText('Sync paused. Check Puter credit, then retry.');
    await audit(bob);
    await expect.poll(async () => { if (await bob.getByRole('button', { name: 'Retry sync' }).isVisible()) await bob.getByRole('button', { name: 'Retry sync' }).click(); return bob.locator('.save-state').getAttribute('data-state'); }, SYNC).toBe('synced');
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Paid note'], SYNC);

    // 403: Alice makes Bob a viewer while he is offline with a queued edit; the worker refuses it on reconnect.
    const bobContext = await w.context('bob');
    await bobContext.setOffline(true);
    await expect.poll(() => w.host.stats().offlinePages).toBeGreaterThan(0);
    await menuPick(bob, day(bob, ids.d2).getByRole('button', { name: /^Add to Day 2/ }), 'Add note…');
    const late = bob.getByRole('dialog', { name: /^Add a note to Day 2/ });
    await late.getByLabel('Title').fill('Too late');
    await late.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(rowTitles(bob, ids.d2)).toHaveText(['Too late']);
    const bobUuid = (await w.world.user('bob')).uuid;
    await alice.evaluate(([ref, uuid]) => globalThis.trips.call(ref, 'member.role', { uuid, role: 'viewer' }), [trip.ref, bobUuid]);
    await bobContext.setOffline(false);
    await expect(rowTitles(bob, ids.d2)).toHaveCount(0, SYNC);
    await expect(bob.locator('.plan-note')).toHaveText('You can view this plan. Ask an editor or the owner to make changes.', SYNC);
    await expect(bob.locator('.plan-grip')).toHaveCount(0);
    await expect(rowTitles(alice, ids.d2)).toHaveCount(0);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
