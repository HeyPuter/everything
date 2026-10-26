import { test, expect } from '@playwright/test';
import { tripTabs } from '../../src/views/registry/tabs.js';
import { bridgeWorld } from './helpers/bridge-world.js';

// Baseline only: every view mounts for the owner and a joined editor. Module flows and axe live in each module's spec.
const PAGES = [['#/', 'Your trips'], ['#/collections', 'Collections'], ['#/atlas', 'Atlas'], ['#/week', 'Week'], ['#/vacay', 'Vacay'], ['#/journeys', 'Journeys']];

test('the owner and a joined editor open every trip tab and page without errors', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: '2026-11-02', end: '2026-11-05' });
    for (const as of ['alice', 'bob']) {
      for (const { id } of tripTabs) {
        const page = await w.open(as, trip.hash(id));
        await expect(page.getByRole('heading', { name: 'Lisbon' }).first()).toBeVisible();
        await expect(page.locator(`.trip-tab[data-tab="${id}"]`)).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('section.trip-tab-view > *').first()).toBeVisible();
        await expect(page.locator('.view-error')).toHaveCount(0);
        await page.close();
      }
      for (const [hash, heading] of PAGES) {
        const page = await w.open(as, hash);
        await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
        await expect(page.locator('.view-error')).toHaveCount(0);
        await page.close();
      }
    }
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
