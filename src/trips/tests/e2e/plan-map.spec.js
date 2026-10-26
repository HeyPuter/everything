import { test, expect } from '@playwright/test';
import { audit, capture, noOverflow } from './helpers/bridge-world.js';
import { seed, isoDay } from './helpers/providers.js';
import { SYNC, openPlan, planWorld, rowTitles, showPane } from './helpers/plan.js';

// P3 planner map on intercepted styles and tiles: summary, optimize and undo, search to place, layers, viewer, offline.
const PLACES = [
  { key: 'd1', type: 'day', fields: { order: 'V', date: isoDay(30) } },
  { key: 'd2', type: 'day', fields: { order: 'W', date: isoDay(31) } },
  { key: 'p1', type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216, cc: 'PT', cat: 'attraction' } },
  { key: 'p2', type: 'place', fields: { name: 'Castelo de São Jorge', lat: 38.7139, lng: -9.1335, cc: 'PT', cat: 'attraction' } },
  { key: 'p3', type: 'place', fields: { name: 'Time Out Market', lat: 38.7069, lng: -9.1459, cc: 'PT', cat: 'restaurant' } },
  // Belém, then the castle in the east, then back west to the market: optimize swaps the last two.
  { key: 'v1', type: 'visit', fields: { dayId: '$d1', placeId: '$p1', order: 'V' } },
  { key: 'v2', type: 'visit', fields: { dayId: '$d1', placeId: '$p2', order: 'W' } },
  { key: 'v3', type: 'visit', fields: { dayId: '$d1', placeId: '$p3', order: 'X' } },
];
const PHOTON = [{ name: 'Miradouro da Graça', lat: 38.7166, lng: -9.1316, osm: ['N', 4242], key: 'tourism', value: 'viewpoint' }];
const POIS = [{ name: 'Tasca do Chico', osm: ['N', 77], key: 'amenity', value: 'restaurant' }];

async function openMap(w, as, trip) {
  const page = await openPlan(w, as, trip);
  await showPane(page, 'Map');
  await expect(page.locator('.planmap-canvas canvas')).toBeVisible();
  await expect(page.locator('.planmap-loading')).toHaveCount(0);
  await expect(page.locator('.planmap-summary')).toBeVisible();
  return page;
}

test('the map follows the day, optimizes with undo, and a searched spot becomes a place for both editors', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await planWorld(browser, testInfo, baseURL, { providers: { photon: PHOTON, pois: POIS } });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(31) });
    const ids = await seed(w, trip.ref, PLACES);
    const alice = await openMap(w, 'alice', trip);
    expect(w.traffic.alice.styles).toContain(testInfo.project.use.colorScheme === 'dark' ? 'dark' : 'positron');
    expect(w.traffic.alice.tiles).toBeGreaterThan(0);
    const summary = alice.locator('.planmap-summary');
    await expect(summary.locator('.planmap-summary-head')).toContainText('Whole trip:');

    // Picking day 1 in the summary shows its route and the optimize action.
    if (!(await summary.locator('.planmap-summary-body').isVisible())) await summary.locator('.planmap-summary-head').click();
    await summary.locator(`[data-key="day-${ids.d1}"]`).click();
    await expect(summary.locator('.planmap-summary-head')).not.toContainText('Whole trip');
    await summary.getByRole('button', { name: 'Optimize order' }).click();
    const proposal = alice.getByRole('region', { name: 'Shorter stop order' });
    await expect(proposal).toBeVisible();
    await audit(alice);
    await proposal.getByRole('button', { name: 'Apply order' }).click();
    await showPane(alice, 'Plan');
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Belém Tower', 'Time Out Market', 'Castelo de São Jorge']);
    const bob = await openPlan(w, 'bob', trip);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Belém Tower', 'Time Out Market', 'Castelo de São Jorge'], SYNC);
    await alice.getByRole('status').getByRole('button', { name: 'Undo' }).click();
    await expect(rowTitles(alice, ids.d1)).toHaveText(['Belém Tower', 'Castelo de São Jorge', 'Time Out Market']);
    await expect(rowTitles(bob, ids.d1)).toHaveText(['Belém Tower', 'Castelo de São Jorge', 'Time Out Market'], SYNC);

    // Keyboard search: type, arrow to the Photon result, Enter, then add it as a place.
    await showPane(alice, 'Map');
    const search = alice.getByRole('combobox', { name: 'Search the map' });
    await search.click();
    await search.pressSequentially('Mira');
    const option = alice.getByRole('option', { name: /Miradouro da Graça/ });
    await expect(option).toBeVisible();
    await search.press('ArrowDown');
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await search.press('Enter');
    const card = alice.getByRole('region', { name: 'Miradouro da Graça' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Add place' }).click();
    const form = alice.getByRole('dialog', { name: 'New place' });
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Miradouro da Graça');
    await form.getByRole('button', { name: 'Add place', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
    await showPane(bob, 'Places');
    await expect(bob.locator('.pl-row', { hasText: 'Miradouro da Graça' })).toBeVisible(SYNC);

    // Explore pills search the viewport through Photon.
    await showPane(alice, 'Map');
    await alice.getByRole('group', { name: 'Explore nearby' }).getByRole('button', { name: 'Restaurants' }).click();
    await expect(alice.locator('.planmap-explore-status')).toHaveText('Places found: 1');

    // Satellite imagery from the layers menu.
    await alice.getByRole('button', { name: 'Map layers' }).click();
    await alice.getByRole('menuitemcheckbox', { name: 'Satellite imagery' }).click();
    await expect.poll(() => w.traffic.alice.imagery).toBeGreaterThan(0);
    await audit(alice);
    await noOverflow(alice);
    await capture(alice, testInfo, 'plan-map');
    expect(w.traffic.alice.unexpected).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a viewer gets no add or optimize actions, and the map says when it is offline', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await planWorld(browser, testInfo, baseURL, { users: ['alice', 'carol'], providers: { photon: PHOTON } });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: isoDay(30), end: isoDay(31), role: 'viewer' });
    const ids = await seed(w, trip.ref, PLACES);
    const carol = await openMap(w, 'carol', trip);
    const summary = carol.locator('.planmap-summary');
    if (!(await summary.locator('.planmap-summary-body').isVisible())) await summary.locator('.planmap-summary-head').click();
    await summary.locator(`[data-key="day-${ids.d1}"]`).click({ timeout: 25_000 });
    await expect(summary.locator('.planmap-summary-head')).not.toContainText('Whole trip');
    await expect(summary.getByRole('button', { name: 'Optimize order' })).toHaveCount(0);
    await expect(summary.getByRole('button', { name: 'Directions' })).toBeVisible();

    const search = carol.getByRole('combobox', { name: 'Search the map' });
    await search.fill('Mira');
    await carol.getByRole('option', { name: /Miradouro da Graça/ }).click();
    const card = carol.getByRole('region', { name: 'Miradouro da Graça' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Add place' })).toHaveCount(0);
    await carol.keyboard.press('Escape');
    await audit(carol);

    await (await w.context('carol')).setOffline(true);
    await expect(carol.locator('.planmap-offline')).toBeVisible();
    await expect(carol.locator('.planmap-offline')).toHaveText('Offline: map tiles and search may be limited');
    await capture(carol, testInfo, 'plan-map-viewer-offline');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
