import { test, expect as baseExpect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow, USERS } from './helpers/bridge-world.js';

// P9 members and sharing, Q8 named invites and the role-change refresh, with up to three accounts.
const expect = baseExpect.configure({ timeout: 15_000 });
test.use({ actionTimeout: 15_000 });

const touch = (testInfo) => Boolean(testInfo.project.use.hasTouch);
const row = (page, name) => page.locator('.members-list').first().locator('.member-row', { hasText: name });

/** Alice's trip with nobody else in it yet. */
async function ownTrip(w, { title = 'Lisbon' } = {}) {
  const page = await w.open('alice');
  await expect(page.locator('html')).toHaveAttribute('data-worker', 'ready', { timeout: 30_000 });
  const ref = await page.evaluate((meta) => globalThis.trips.createTrip(meta), { title });
  await page.close();
  return { ref, hash: (tab = 'plan') => `#/t/${ref.w}/${ref.s}/${tab}` };
}
/** Creates a link in the invite dialog and returns its `#/join/…` hash. */
async function createLink(page, { who = 'Anyone with the link', role = 'Editor', label, expiry } = {}) {
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: new RegExp(`^${who}`) }).click();
  if (label) await dialog.getByLabel('Their name or email').fill(label);
  await dialog.getByRole('radio', { name: new RegExp(`^${role}`) }).click();
  if (expiry) await dialog.getByLabel('Link expires after').selectOption(expiry);
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const url = await dialog.locator('.invite-url').inputValue();
  return { dialog, hash: new URL(url).hash };
}
const joinPage = (w, as, hash) => w.open(as, hash);

test('an invite link brings in a third member; presence, role change and removal reach the others', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    const trip = await ownTrip(w);
    const alice = await w.open('alice', trip.hash('members'));
    await expect(alice.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(row(alice, 'alice')).toContainText('Owner');
    await expect(alice.locator('.members-leave')).toContainText('You own this trip');
    await audit(alice);

    const { dialog, hash } = await createLink(alice, { role: 'Editor' });
    await expect(dialog).toContainText('Your invite link is ready');
    await audit(alice);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(alice.locator('.members-links-body .member-row')).toHaveCount(1);

    const bobJoin = await joinPage(w, 'bob', hash);
    await expect(bobJoin.locator('.join-title')).toHaveText('Lisbon');
    await expect(bobJoin.locator('.join-message')).toHaveText('alice invited you to join as an editor.');
    await audit(bobJoin);
    await noOverflow(bobJoin);
    await capture(bobJoin, testInfo, 'join');
    await bobJoin.getByRole('button', { name: 'Join trip' }).click();
    await bobJoin.waitForURL((url) => url.hash.startsWith(`#/t/${trip.ref.w}/${trip.ref.s}`));
    // The token leaves history: going back does not return to the join page.
    expect(await bobJoin.evaluate(() => location.hash.includes('/join/'))).toBe(false);
    await bobJoin.close();

    const { hash: viewerLink } = await createLink(alice, { role: 'Viewer' });
    await alice.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    const carolJoin = await joinPage(w, 'carol', viewerLink);
    await expect(carolJoin.locator('.join-message')).toHaveText('alice invited you to join as a viewer.');
    await carolJoin.getByRole('button', { name: 'Join trip' }).click();
    await carolJoin.waitForURL((url) => url.hash.startsWith(`#/t/${trip.ref.w}/${trip.ref.s}`));
    await carolJoin.close();

    // Bob on Files: "Here now · Files" for Alice; then she makes him a viewer and his page drops the upload button.
    const bob = await w.open('bob', trip.hash('files'));
    await expect(bob.getByRole('button', { name: 'Upload' }).first()).toBeVisible();
    await expect(row(alice, 'bob')).toContainText('Editor');
    await expect(row(alice, 'carol')).toContainText('Viewer');
    // The view joins presence on the next beat, at most 15 s after the first one.
    await expect(row(alice, 'bob')).toContainText('Here now · Files', { timeout: 30_000 });
    await expect(alice.locator('.members-here')).toContainText('bob');
    await row(alice, 'bob').getByRole('button', { name: 'Actions for bob' }).click();
    await alice.getByRole('menuitemcheckbox', { name: 'Change to Viewer' }).click();
    await expect(alice.getByText('bob is now Viewer')).toBeVisible();
    await expect(row(alice, 'bob')).toContainText('Viewer');
    await expect(bob.getByRole('button', { name: 'Upload' })).toHaveCount(0);
    await expect(bob.locator('.file-empty')).toContainText('Files that editors add to this trip show up here.');

    // Removal: Carol's open trip shows that she no longer has access.
    const carol = await w.open('carol', trip.hash('plan'));
    await row(alice, 'carol').getByRole('button', { name: 'Actions for carol' }).click();
    await alice.getByRole('menuitem', { name: 'Remove from trip' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'Remove from trip' }).click();
    await expect(alice.getByText('carol was removed')).toBeVisible();
    await expect(row(alice, 'carol')).toHaveCount(0);
    // A revoked handle sends no event; the next poll (60 s) or returning to the tab notices.
    await carol.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(carol.locator('.trip-banner')).toContainText('You no longer have access to this trip.', { timeout: 30_000 });
    await audit(alice);
    await noOverflow(alice);
    await capture(alice, testInfo, 'members');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('personal and revoked links explain why they no longer work', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    const trip = await ownTrip(w);
    const alice = await w.open('alice', trip.hash('members'));

    const personal = await createLink(alice, { who: 'One person', label: 'carol@example.com', role: 'Viewer' });
    await expect(personal.dialog).toContainText('carol@example.com');
    await expect(personal.dialog.getByRole('link', { name: 'Email' })).toHaveAttribute('href', /^mailto:carol@example\.com\?/);
    await personal.dialog.getByRole('button', { name: 'Done' }).click();
    await expect(alice.locator('.members-links-body')).toContainText('For carol@example.com');
    const carol = await joinPage(w, 'carol', personal.hash);
    await carol.getByRole('button', { name: 'Join trip' }).click();
    await carol.waitForURL((url) => url.hash.startsWith(`#/t/${trip.ref.w}/${trip.ref.s}`));
    const reused = await joinPage(w, 'bob', personal.hash);
    await expect(reused.locator('.join-message')).toHaveText('This invite has already been used. Ask for a new link.');
    await audit(reused);
    await reused.close();

    const revoked = await createLink(alice, { role: 'Editor' });
    await revoked.dialog.getByRole('button', { name: 'Done' }).click();
    const links = alice.locator('.members-links-body');
    await links.getByRole('button', { name: 'Revoke Invite link' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(alice.getByText('Link revoked')).toBeVisible();
    const refused = await joinPage(w, 'bob', revoked.hash);
    await expect(refused.locator('.join-message')).toHaveText('This invite was revoked. Ask for a new link.');
    await noOverflow(refused);
    // Expiry uses the worker's own clock, which the fake world cannot advance; tests/worker/members.test.js covers it.
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('an invitation by Puter username reaches the inbox and opens the trip; bad names explain themselves', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob'] });
  try {
    const trip = await ownTrip(w);
    const alice = await w.open('alice', trip.hash('members'));
    await alice.getByRole('button', { name: 'Invite people' }).click();
    const dialog = alice.getByRole('dialog');
    await dialog.getByRole('radio', { name: /^A Puter user/ }).click();
    const name = dialog.getByLabel('Puter username');
    const sendButton = dialog.getByRole('button', { name: 'Send invitation' });
    for (const [value, message] of [
      ['alice', 'That is your own username.'],
      ['bob@example.com', 'That looks like an email address.'],
      ['nobody-here', 'No Puter user has that username.'],
    ]) {
      await name.fill(value);
      await sendButton.click();
      await expect(dialog).toContainText(message);
    }
    await audit(alice);
    await name.fill('@bob');
    await dialog.getByRole('radio', { name: /^Viewer/ }).click();
    await sendButton.click();
    await expect(dialog).toContainText('Invitation sent to @bob');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(alice.locator('.members-links-body')).toContainText('bob');

    const bob = await w.open('bob', '#/');
    const inbox = bob.locator('.inbox-button');
    await expect(inbox).toHaveAttribute('aria-label', 'Invitations (1)');
    await inbox.click();
    const list = bob.getByRole('dialog', { name: 'Invitations' });
    await expect(list).toContainText('Lisbon');
    await expect(list).toContainText('alice');
    await audit(bob);
    await list.getByRole('button', { name: 'Accept invitation to Lisbon' }).click();
    await bob.waitForURL((url) => url.hash.startsWith(`#/t/${trip.ref.w}/${trip.ref.s}`));
    await expect(bob.getByRole('heading', { name: 'Lisbon', level: 1 })).toBeVisible();
    await expect(row(alice, 'bob')).toContainText('Viewer');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the permission matrix lets editors invite viewers; guests and leaving', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('members'));
    const bob = await w.open('bob', trip.hash('members'));
    await expect(bob.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(bob.getByRole('button', { name: 'Invite people' })).toBeHidden();
    await expect(bob.locator('.perm-select')).toHaveCount(0);

    const manage = alice.locator('[data-focus="perm:members.manage"]');
    await manage.selectOption('editor');
    await expect(bob.getByRole('button', { name: 'Invite people' })).toBeVisible();
    await bob.getByRole('button', { name: 'Invite people' }).click();
    const dialog = bob.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: /^Viewer/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /^Editor/ })).toHaveCount(0);
    await audit(bob);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await bob.getByRole('button', { name: 'Add guest' }).click();
    await bob.getByRole('dialog').getByLabel('Name').fill('Grandma Rosa');
    await bob.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(alice.locator('.member-row', { hasText: 'Grandma Rosa' })).toContainText('Guest');
    await audit(alice);

    await bob.getByRole('button', { name: 'Leave trip' }).click();
    await bob.getByRole('dialog').getByRole('button', { name: 'Leave trip' }).click();
    await bob.waitForURL((url) => url.hash === '#/');
    await expect(bob.getByText('You left Lisbon')).toBeVisible();
    await expect(row(alice, 'bob')).toHaveCount(0, { timeout: 30_000 });
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('keyboard only: open the invite dialog, pick a role with arrows, create a link and close it', async ({ browser, baseURL }, testInfo) => {
  test.skip(touch(testInfo), 'Keyboard path on the desktop projects.');
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const trip = await ownTrip(w);
    const alice = await w.open('alice', trip.hash('members'));
    const invite = alice.getByRole('button', { name: 'Invite people' });
    await invite.focus();
    await alice.keyboard.press('Enter');
    const dialog = alice.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const anyone = dialog.getByRole('radio', { name: /^Anyone with the link/ });
    await anyone.focus();
    await alice.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('radio', { name: /^One person/ })).toBeFocused();
    await alice.keyboard.press('ArrowUp');
    await expect(anyone).toHaveAttribute('aria-checked', 'true');
    const editor = dialog.getByRole('radio', { name: /^Editor/ });
    await editor.focus();
    await alice.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: /^Viewer/ })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('button', { name: 'Create link' }).focus();
    await alice.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeFocused();
    await expect(dialog.locator('.invite-url')).toHaveValue(/#\/join\//);
    await alice.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(invite).toBeFocused();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('invite errors: out of credit and offline', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const trip = await ownTrip(w);
    const alice = await w.open('alice', trip.hash('members'));
    await expect(alice.locator('.members-links-body')).toContainText('No active invite links.');
    w.world.failNext({ method: 'workers.exec', as: USERS.alice.uuid, status: 402, code: 'insufficient_funds' });
    await alice.getByRole('button', { name: 'Invite people' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
    await expect(alice.getByRole('dialog').locator('.members-alert')).toBeVisible();
    await expect(alice.getByRole('dialog').locator('.members-alert')).toContainText('credit');
    await alice.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await (await w.context('alice')).setOffline(true);
    await alice.getByRole('button', { name: 'Refresh' }).click();
    await expect(alice.locator('.members-links-body')).toContainText('Connect to the internet to see invite links.');
    await (await w.context('alice')).setOffline(false);
    await expect(alice.locator('.members-links-body')).toContainText('No active invite links.');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
