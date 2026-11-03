import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow } from './helpers/bridge-world.js';
import { seed, read, isoDay } from './helpers/providers.js';
import { SYNC, day, menuPick, openPlan, planWorld } from './helpers/plan.js';

// P2c time-aware scheduling: estimates, warnings, auto schedule with undo, dwell and fixed times, between two accounts.
const SEED = [
  { key: 'd1', type: 'day', fields: { order: 'V', date: isoDay(30) } },
  { key: 'p1', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216, cc: 'PT', cat: 'attraction' } },
  { key: 'p2', type: 'place', fields: { name: 'Time Out Market', lat: 38.7069, lng: -9.1459, cc: 'PT', cat: 'restaurant' } },
  { key: 'p3', type: 'place', fields: { name: 'Castelo de São Jorge', lat: 38.7139, lng: -9.1335, cc: 'PT', cat: 'attraction' } },
  { key: 'v1', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V' } },
  { key: 'v2', type: 'visit', fields: { dayId: '$d1', placeId: '$p2', order: 'W', start: '12:00', end: '14:00' } },
  { key: 'v3', type: 'visit', fields: { dayId: '$d1', placeId: '$p3', order: 'X', start: '13:00' } },
];
const row = (page, dayId, name) => day(page, dayId).locator('.plan-row', { hasText: name });

test('estimates and warnings show, auto schedule applies times with undo, and dwell and fixed times reach the other editor', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(30) });
    const ids = await seed(w, trip.ref, SEED);
    const alice = await openPlan(w, 'alice', trip);
    // An untimed first visit gets an estimate; the castle overlaps the market's fixed times.
    await expect(row(alice, ids.d1, 'Belém Tower').locator('.sched-meta')).toContainText('About 9:00');
    await expect(row(alice, ids.d1, 'Castelo de São Jorge').locator('.sched-warn')).toContainText('Overlaps Time Out Market.');
    await expect(day(alice, ids.d1).locator('.sched-leg').first()).toContainText('About');
    await audit(alice);

    // Bob marks the castle as a fixed 45-minute visit from the visit form.
    const bob = await openPlan(w, 'bob', trip);
    await menuPick(bob, day(bob, ids.d1).getByRole('button', { name: 'Actions for Castelo de São Jorge' }), 'Edit…');
    const form = bob.getByRole('dialog', { name: 'Castelo de São Jorge' });
    await form.getByLabel('Time here (minutes)').fill('45');
    await form.getByLabel('Fixed time').check();
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await read(w, trip.ref, [['visit', ids.v3]]))[0], SYNC).toMatchObject({ dwell: 45, pinned: true });

    // Alice auto-schedules the day from 08:30 by keyboard; the fixed visits keep their times.
    await menuPick(alice, day(alice, ids.d1).getByRole('button', { name: /^Actions for Day 1/ }), 'Auto schedule…');
    const dialog = alice.getByRole('dialog', { name: /^Auto schedule Day 1/ });
    await dialog.getByLabel('Start at').fill('08:30');
    const preview = dialog.getByRole('list', { name: 'Proposed times' });
    await expect(preview.locator('.sched-preview-item', { hasText: 'Belém Tower' })).toContainText('8:30');
    await expect(preview.locator('.sched-preview-item', { hasText: 'Castelo de São Jorge' })).toContainText('Fixed');
    await audit(alice);
    await dialog.getByRole('button', { name: 'Apply' }).focus();
    await alice.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(row(alice, ids.d1, 'Belém Tower').locator('.plan-time')).toContainText('8:30');
    await expect(row(bob, ids.d1, 'Belém Tower').locator('.plan-time')).toContainText('8:30', SYNC);
    await capture(alice, testInfo, 'schedule-applied');

    await alice.getByRole('status').filter({ hasText: 'Day scheduled.' }).getByRole('button', { name: 'Undo' }).click();
    await expect(row(alice, ids.d1, 'Belém Tower').locator('.plan-time')).toHaveCount(0);
    await expect(row(bob, ids.d1, 'Belém Tower').locator('.plan-time')).toHaveCount(0, SYNC);
    for (const page of [alice, bob]) await noOverflow(page);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a viewer sees estimates but no scheduling actions', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await planWorld(browser, testInfo, baseURL, { users: ['alice', 'carol'] });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(30), role: 'viewer' });
    const ids = await seed(w, trip.ref, SEED);
    const carol = await openPlan(w, 'carol', trip);
    await expect(row(carol, ids.d1, 'Belém Tower').locator('.sched-meta')).toContainText('About 9:00', SYNC);
    await carol.getByRole('button', { name: /^Actions for Day 1/ }).click();
    await expect(carol.getByRole('menu').getByRole('menuitem', { name: 'Auto schedule…' })).toHaveCount(0);
    await expect(carol.getByRole('menu').getByRole('menuitem', { name: 'Clear visit times' })).toHaveCount(0);
    await carol.keyboard.press('Escape');
    await audit(carol);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
