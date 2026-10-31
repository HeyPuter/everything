import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';
import { toastText } from './helpers/spaces.js';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

// Weekdays in December of the current (calendar) leave year: `day(0)` is the first Monday, `day(5)` that Saturday.
const year = new Date().getFullYear();
function day(offset) {
  const date = new Date(Date.UTC(year, 11, 1));
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
const cell = (page, date) => page.locator(`button.vacay-day[data-date="${date}"]`);
const usedStat = (page) => page.locator('.stat[data-focus="stat-used"] strong');

async function openVacay(w, as) {
  const page = await w.open(as, '#/vacay');
  await expect(page.locator('.vacay-grid-box button.vacay-day').first()).toBeVisible();
  return page;
}

async function invite(page, username, mode) {
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share your vacation plan' });
  await dialog.getByLabel('Puter username').fill(username);
  await dialog.getByRole('radio', { name: new RegExp(`^${mode}`) }).click();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog).toHaveCount(0);
}

test('Alice books days and shares them view-only with Bob and to plan together with Carol, then stops sharing', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    const alice = await openVacay(w, 'alice');
    expect(w.world.inspectKv('alice')['vacay:plan']).toBeTruthy();
    await audit(alice); await noOverflow(alice);

    await cell(alice, day(0)).click();
    await expect(cell(alice, day(0))).toHaveClass(/own-full/);
    await expect(cell(alice, day(0))).toHaveAttribute('aria-pressed', 'true');
    await alice.getByRole('button', { name: 'Half day', exact: true }).click();
    await cell(alice, day(1)).click();
    await expect(cell(alice, day(1))).toHaveClass(/own-half/);
    await alice.getByRole('button', { name: 'Full day', exact: true }).click();
    await cell(alice, day(2)).click();
    await cell(alice, day(4)).click({ modifiers: ['Shift'] });
    for (const offset of [2, 3, 4]) await expect(cell(alice, day(offset))).toHaveClass(/own-full/);
    await expect(usedStat(alice)).toContainText('4.5');
    await cell(alice, day(5)).click();
    await toastText(alice, 'Weekends can’t be booked.');
    await expect(cell(alice, day(5))).not.toHaveClass(/own-/);

    // Bob: a read-only overlay.
    await invite(alice, 'bob', 'View only');
    await toastText(alice, 'Your calendar is shared with bob');
    const bob = await openVacay(w, 'bob');
    const fromAlice = bob.locator('.vacay-invite').filter({ hasText: 'alice' });
    await expect(fromAlice).toContainText('shared their vacation calendar with you');
    await audit(bob);
    await fromAlice.getByRole('button', { name: 'Accept from alice' }).click();
    await expect(bob.locator('.vacay-person[data-peer]')).toContainText('View only');
    await expect(cell(bob, day(0)).locator('.vacay-ring')).toHaveCount(1);
    await expect(cell(bob, day(0))).toHaveAttribute('aria-label', /alice/);

    // Live: Alice books another day and Bob's ring appears without a reload.
    await cell(alice, day(7)).click();
    await expect(cell(bob, day(7)).locator('.vacay-ring')).toHaveCount(1);

    // Carol: plan together. She accepts, and both see each other's days as bars.
    await invite(alice, 'carol', 'Plan together');
    const carol = await openVacay(w, 'carol');
    await carol.getByRole('button', { name: 'Accept from alice' }).click();
    await toastText(carol, 'Invitation accepted');
    await expect(cell(carol, day(0)).locator('.vacay-bar')).toHaveCount(1);
    await cell(carol, day(3)).click();
    await expect(cell(alice, day(3)).locator('.vacay-bar')).toHaveCount(1);
    await expect(alice.locator('.vacay-person[data-peer]').filter({ hasText: 'carol' })).toContainText('Planning together');
    await expect(carol.locator('.vacay-person[data-peer]').filter({ hasText: 'alice' })).toContainText('Planning together');
    for (const page of [alice, bob, carol]) { await audit(page); await noOverflow(page); }
    await capture(alice, testInfo, 'vacay-owner');
    await capture(bob, testInfo, 'vacay-overlay');

    // Alice stops sharing with Bob: his overlay goes away.
    await alice.locator('.vacay-person[data-grant]').filter({ hasText: 'bob' }).getByRole('button', { name: 'Options for bob' }).click();
    await alice.getByRole('menuitem', { name: 'Stop sharing' }).click();
    await alice.getByRole('dialog', { name: 'Stop sharing with bob?' }).getByRole('button', { name: 'Stop sharing' }).click();
    await toastText(alice, 'No longer shared with bob');
    const later = await openVacay(w, 'bob');
    await expect(later.locator('.vacay-person[data-peer]')).toHaveCount(0);
    await expect(cell(later, day(0)).locator('.vacay-ring')).toHaveCount(0);

    // Carol dissolves from her side; Alice no longer sees her.
    await carol.locator('.vacay-person[data-peer]').filter({ hasText: 'alice' }).getByRole('button', { name: 'Options for alice' }).click();
    await carol.getByRole('menuitem', { name: 'Stop planning together' }).click();
    await carol.getByRole('dialog', { name: 'Stop planning with alice?' }).getByRole('button', { name: 'Stop planning together' }).click();
    await toastText(carol, 'You no longer plan with alice');
    const aliceAgain = await openVacay(w, 'alice');
    await expect(aliceAgain.locator('.vacay-person[data-peer]')).toHaveCount(0);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the grid works by keyboard; offline, out-of-credit and no-share states', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    const alice = await openVacay(w, 'alice');
    // One tab stop in the grid; arrows move, Enter books.
    const focusable = alice.locator('.vacay-grid-box button.vacay-day[tabindex="0"]');
    await expect(focusable).toHaveCount(1);
    await focusable.focus();
    const start = await focusable.getAttribute('data-date');
    await alice.keyboard.press('ArrowRight');
    const next = alice.locator('.vacay-grid-box button.vacay-day:focus');
    await expect(next).not.toHaveAttribute('data-date', start);
    await alice.keyboard.press('PageDown');
    await alice.keyboard.press('Home');
    // Step to the first weekday of that week.
    const focused = alice.locator('.vacay-grid-box button.vacay-day:focus');
    for (let step = 0; step < 3 && /is-weekend/.test(await focused.getAttribute('class')); step++) await alice.keyboard.press('ArrowRight');
    let target = await focused.getAttribute('data-date');
    await alice.keyboard.press('Enter');
    await expect(cell(alice, target)).toHaveAttribute('aria-pressed', 'true');
    await expect(alice.locator('.vacay-grid-box button.vacay-day[tabindex="0"]')).toHaveCount(1);
    await alice.keyboard.press('Enter');
    await expect(cell(alice, target)).toHaveAttribute('aria-pressed', 'false');

    // The day panel's radios for a booked day.
    await alice.keyboard.press('Enter');
    const kind = alice.getByRole('radiogroup', { name: 'Kind' });
    await expect(kind.getByRole('radio', { name: 'Vacation' })).toHaveAttribute('aria-checked', 'true');
    await kind.getByRole('radio', { name: /Comp/ }).click();
    await expect(cell(alice, target)).toHaveClass(/own-comp/);
    await audit(alice);

    await alice.context().setOffline(true);
    await expect(alice.locator('[data-banner="offline"]')).toBeVisible();
    target = day(0);
    await cell(alice, target).click();
    await toastText(alice, 'You’re offline. Changes can’t be saved until you reconnect.');
    await expect(cell(alice, target)).toHaveAttribute('aria-pressed', 'false');
    await audit(alice);
    await alice.context().setOffline(false);
    await expect(alice.locator('[data-banner="offline"]')).toHaveCount(0);
    await cell(alice, target).click();
    await expect(cell(alice, target)).toHaveAttribute('aria-pressed', 'true');

    // Bob holds Alice's share; his reads of it run out of credit.
    await invite(alice, 'bob', 'View only');
    const bob = await openVacay(w, 'bob');
    await bob.getByRole('button', { name: 'Accept from alice' }).click();
    await expect(cell(bob, target).locator('.vacay-ring')).toHaveCount(1);
    // Refreshing the shared calendar after reconnecting runs out of credit.
    w.world.failNext({ method: 'kv.get', as: 'bob', status: 402, times: 1000 });
    await bob.context().setOffline(true);
    await bob.context().setOffline(false);
    await expect(bob.locator('.vacay-person[data-peer]')).toContainText('Out of Puter credit');
    await expect(bob.locator('[data-banner="credit"]')).toBeVisible();
    await audit(bob);

    // Carol is out of credit when Vacay first reads her plan: the page says so, and Try again recovers once she has credit.
    w.world.failNext({ method: 'kv.get', as: 'carol', status: 402, times: 40 });
    const retry = await w.open('carol', '#/vacay');
    await expect(retry.getByText('You’re out of Puter credit. Add credit and try again.')).toBeVisible();
    await audit(retry);
    const drain = w.world.client('carol');
    for (let i = 0; i < 40; i++) { try { await drain.kv.get('drain'); break; } catch { /* one failure used up */ } }
    await retry.getByRole('button', { name: 'Try again' }).click();
    await expect(retry.locator('.vacay-grid-box button.vacay-day').first()).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('without share handles Vacay works alone and says sharing is unavailable', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL, { shareHandles: false });
  try {
    const alice = await openVacay(w, 'alice');
    // Listing shares works either way; the first share attempt is what finds sharing off.
    await alice.getByRole('button', { name: 'Invite', exact: true }).click();
    const dialog = alice.getByRole('dialog', { name: 'Share your vacation plan' });
    await dialog.getByLabel('Puter username').fill('bob');
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(dialog.getByLabel('Puter username')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog).toContainText('Sharing isn’t available on this account yet.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(alice.getByText('Sharing isn’t available on this account yet. Your plan works on its own.')).toBeVisible();
    await expect(alice.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0);
    await cell(alice, day(0)).click();
    await expect(cell(alice, day(0))).toHaveAttribute('aria-pressed', 'true');
    await audit(alice); await noOverflow(alice);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
