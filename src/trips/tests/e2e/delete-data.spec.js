import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';

// Q13 Settings → Delete my data: the member's own trip goes for everyone, the trip they joined stays for its owner.
const day = (offset) => { const date = new Date(Date.now() + offset * 86_400_000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const card = (page, title) => page.locator('[data-trip]').filter({ has: page.getByRole('link', { name: title, exact: true }) });

test('deleting Bob’s data removes his trip for Alice and leaves Alice’s trip in place', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const lisbon = await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const seed = await w.open('bob');
    await expect(seed.locator('html')).toHaveAttribute('data-worker', 'ready');
    const rome = await seed.evaluate((meta) => globalThis.trips.createTrip(meta), { title: 'Rome', start: day(20), end: day(23) });
    const { token } = await seed.evaluate((ref) => globalThis.trips.invite(ref, { role: 'editor' }), rome);
    await seed.close();
    const joining = await w.open('alice', `#/join/${rome.w}/${rome.s}/${token}`);
    await joining.getByRole('button', { name: 'Join trip', exact: true }).click();
    await joining.waitForURL((url) => url.hash.startsWith(`#/t/${rome.w}/${rome.s}`));
    await joining.close();
    // Alice has opened Rome on her device, so its card has a replica to fall back on.
    const romeTab = await w.open('alice', `#/t/${rome.w}/${rome.s}/settings`);
    await expect(romeTab.locator('.trip-settings-head h2')).toHaveText('Rome');
    await romeTab.close();

    const page = await w.open('bob', '#/settings/delete');
    await expect(page.getByRole('heading', { name: 'Delete my data', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Review what will be deleted' }).click();
    const plan = page.locator('.delete-plan');
    await expect(plan.getByRole('heading', { name: 'This will be deleted' })).toBeVisible();
    await expect(plan).toContainText('1 trip you own');
    await expect(plan).toContainText('Rome');
    await expect(plan).toContainText('1 trip you joined');
    await expect(plan).toContainText('Lisbon');
    const run = page.getByRole('button', { name: 'Delete everything' });
    await expect(run).toBeDisabled();
    await audit(page); await noOverflow(page); await capture(page, testInfo, 'delete-plan');
    await page.getByLabel('Type DELETE to confirm').fill('DELET');
    await expect(run).toBeDisabled();
    await page.getByLabel('Type DELETE to confirm').fill('DELETE');
    await run.click();
    await expect(page.getByText('Your Trips data is deleted. Reload to start fresh.')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.delete-step[data-state="failed"]')).toHaveCount(0);
    await expect(page.locator('.delete-step[data-state="done"]').first()).toBeVisible();
    await audit(page); await capture(page, testInfo, 'delete-done');
    expect(Object.keys(w.world.inspectKv('bob'))).toEqual([]);

    await page.getByRole('button', { name: 'Reload Trips' }).click();
    await expect(page.getByRole('button', { name: 'Review what will be deleted' })).toBeVisible();
    await page.getByRole('link', { name: 'Your trips', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Plan your first trip', level: 2 })).toBeVisible();

    const alice = await w.open('alice', '#/');
    await expect(card(alice, 'Lisbon')).toContainText('Upcoming');
    await expect(card(alice, 'Rome')).toContainText('Unavailable');
    const members = await alice.evaluate(async (ref) => { await globalThis.trips.open(ref); await globalThis.trips.sync(ref); return globalThis.trips.members(ref).map((member) => member.name); }, lisbon.ref);
    expect(members).not.toContain('bob');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
