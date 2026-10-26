import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow } from './helpers/bridge-world.js';
import { seed, isoDay } from './helpers/providers.js';
import { SYNC, day, menuPick, openPlan, planWorld, rowTitles } from './helpers/plan.js';

// R10 Plan B: alternatives for a day, edited, compared and switched with undo, between two accounts.
const SEED = [
  { key: 'd1', type: 'day', fields: { order: 'V', date: isoDay(30) } },
  { key: 'p1', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216 } },
  { key: 'p2', type: 'place', fields: { name: 'Time Out Market', lat: 38.7069, lng: -9.1459 } },
  { key: 'p3', type: 'place', fields: { name: 'Castelo de São Jorge', lat: 38.7139, lng: -9.1335 } },
  { key: 'v1', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V' } },
  { key: 'v2', type: 'visit', fields: { dayId: '$d1', placeId: '$p2', order: 'W' } },
];
const openPlans = async (page, dayId) => {
  await menuPick(page, day(page, dayId).getByRole('button', { name: /^Actions for Day 1/ }), 'Plan B and alternatives…');
  const dialog = page.getByRole('dialog', { name: /^Plans for Day 1/ });
  await expect(dialog).toBeVisible();
  return dialog;
};

test('an editor copies the day as Plan B, edits and compares it, then switches and undoes for both editors', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(30) });
    const ids = await seed(w, trip.ref, SEED);
    const alice = await openPlan(w, 'alice', trip);
    const bob = await openPlan(w, 'bob', trip);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Belém Tower', 'Time Out Market'], SYNC);

    const dialog = await openPlans(alice, ids.d1);
    await dialog.getByRole('button', { name: 'Copy the main plan as an alternative' }).click();
    await expect(dialog.getByRole('tab', { name: 'Plan B' })).toHaveAttribute('aria-selected', 'true');
    const panel = dialog.getByRole('tabpanel');
    await panel.getByRole('button', { name: 'Remove Time Out Market' }).click();
    await expect(panel.locator('.alt-stop-name')).toHaveText(['Belém Tower']);
    await panel.getByLabel('Place', { exact: true }).selectOption({ label: 'Castelo de São Jorge' });
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(panel.locator('.alt-stop-name')).toHaveText(['Belém Tower', 'Castelo de São Jorge']);
    await panel.getByRole('button', { name: 'Move Castelo de São Jorge up' }).focus();
    await alice.keyboard.press('Enter');
    await expect(panel.locator('.alt-stop-name')).toHaveText(['Castelo de São Jorge', 'Belém Tower']);
    // Its up button is now disabled, so focus stays on the same stop.
    await expect(panel.getByRole('button', { name: 'Move Castelo de São Jorge down' })).toBeFocused();
    await expect(panel.getByLabel('Place', { exact: true })).toHaveValue('');
    await audit(alice);

    // Compare: each side marks the stops only it has.
    await dialog.getByRole('tab', { name: 'Compare' }).click();
    const main = dialog.getByRole('region', { name: 'Main plan' });
    const planB = dialog.getByRole('region', { name: 'Plan B' });
    await expect(main.locator('[data-unique="true"] .alt-stop-name')).toHaveText(['Time Out Market']);
    await expect(planB.locator('[data-unique="true"] .alt-stop-name')).toHaveText(['Castelo de São Jorge']);
    await noOverflow(alice);
    await capture(alice, testInfo, 'plan-b-compare');

    // The main plan is untouched and the day shows a Plan B chip, for Bob too.
    await expect(day(bob, ids.d1).locator('.alt-chip')).toBeVisible(SYNC);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Belém Tower', 'Time Out Market']);

    await dialog.getByRole('tab', { name: 'Plan B' }).click();
    await dialog.getByRole('tabpanel').getByRole('button', { name: 'Use this plan' }).click();
    const confirm = alice.getByRole('dialog', { name: 'Use “Plan B” as the main plan?' });
    await confirm.getByRole('button', { name: 'Use this plan' }).click();
    await expect(alice.getByRole('status').filter({ hasText: '“Plan B” is now the main plan' })).toBeVisible();
    await alice.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Castelo de São Jorge', 'Belém Tower']);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Castelo de São Jorge', 'Belém Tower'], SYNC);

    await alice.getByRole('status').filter({ hasText: '“Plan B” is now the main plan' }).getByRole('button', { name: 'Undo' }).click();
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Belém Tower', 'Time Out Market']);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Belém Tower', 'Time Out Market'], SYNC);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a viewer compares plans without edit controls', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await planWorld(browser, testInfo, baseURL, { users: ['alice', 'carol'] });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(30), role: 'viewer' });
    const ids = await seed(w, trip.ref, [...SEED,
      { key: 'alt', type: 'alt', fields: { name: 'Rainy day', order: 'V', dayId: '$d1' } },
      { key: 'a1', type: 'visit', fields: { dayId: '$d1', placeId: '$p3', order: 'V', alt: '$alt' } },
    ]);
    const carol = await openPlan(w, 'carol', trip);
    await expect(day(carol, ids.d1).locator('.alt-chip')).toBeVisible(SYNC);
    // Alternative stops stay out of the main timeline.
    await expect(rowTitles(carol, ids.d1)).toHaveText(['Belém Tower', 'Time Out Market']);
    await day(carol, ids.d1).locator('.alt-chip').click();
    const dialog = carol.getByRole('dialog', { name: /^Plans for Day 1/ });
    await expect(dialog.getByRole('button', { name: 'Copy the main plan as an alternative' })).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'Rainy day' }).click();
    const panel = dialog.getByRole('tabpanel');
    await expect(panel).toContainText('You can compare plans; changing them needs edit access.');
    await expect(panel.getByRole('button', { name: 'Use this plan' })).toHaveCount(0);
    await expect(panel.locator('input[type="time"]')).toBeDisabled();
    await audit(carol);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
