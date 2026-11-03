import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow, USERS } from './helpers/bridge-world.js';
import { committed, joinSpace, refFromURL, syncStatus, toastText } from './helpers/spaces.js';
import { publicHash, signedOutViewer } from './helpers/public-viewer.js';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

/** Alice creates a collection from the list page and lands on it. */
async function createCollection(page, name) {
  await page.getByRole('button', { name: 'New collection' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New collection' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/#\/c\//);
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
  return refFromURL(page.url(), 'collection');
}

/** Adds a saved place through the place form. */
async function addPlace(page, { name, lat, lng }) {
  await page.getByRole('button', { name: 'Add place' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New place' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Latitude').fill(String(lat));
  await dialog.getByLabel('Longitude').fill(String(lng));
  await dialog.getByRole('button', { name: 'Add place', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, name)).toBeVisible();
}

/** A row menu item; status items are checkable. */
const menuItem = (page, name) => page.getByRole('menu').getByRole('menuitemcheckbox', { name, exact: true }).or(page.getByRole('menu').getByRole('menuitem', { name, exact: true }));
const row = (page, name) => page.locator('.col-row').filter({ has: page.locator('.col-row-name', { hasText: name }) });

test('an owner shares a collection with an editor and a viewer, and each sees the others’ changes', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    const alice = await w.open('alice', '#/collections');
    await expect(alice.getByRole('heading', { name: 'No collections yet' })).toBeVisible();
    await audit(alice); await noOverflow(alice);

    // Keyboard only: create, name and submit.
    await alice.getByRole('button', { name: 'New collection' }).first().focus();
    await alice.keyboard.press('Enter');
    const form = alice.getByRole('dialog', { name: 'New collection' });
    await expect(form).toBeVisible();
    await form.getByLabel('Name').focus();
    await alice.keyboard.type('Lisbon food');
    await alice.keyboard.press('Enter');
    await alice.waitForURL(/#\/c\//);
    await expect(alice.getByRole('heading', { name: 'Lisbon food', level: 2 })).toBeVisible();
    const ref = refFromURL(alice.url(), 'collection');

    // Bob joins through an invite link made in the sharing dialog.
    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const sharing = alice.getByRole('dialog', { name: 'Share Lisbon food' });
    await expect(sharing.locator('.member-row')).toHaveCount(1);
    await audit(alice);
    await sharing.getByRole('button', { name: 'Invite', exact: true }).click();
    const invite = alice.getByRole('dialog', { name: 'Invite people' });
    await invite.getByRole('button', { name: 'Create link' }).click();
    const link = await invite.getByLabel('Invite link').inputValue();
    expect(link).toContain(`#/join/${ref.w}/${ref.s}/`);
    await alice.keyboard.press('Escape');
    await alice.keyboard.press('Escape');
    await expect(alice.getByRole('dialog')).toHaveCount(0);

    const bob = await w.open('bob', new URL(link).hash);
    await bob.getByRole('button', { name: 'Join trip', exact: true }).click();
    await bob.waitForURL((url) => url.hash.startsWith(`#/c/${ref.w}/${ref.s}`));
    await expect(bob.getByRole('heading', { name: 'Lisbon food', level: 2 })).toBeVisible();
    await expect(bob.locator('.col-sub')).toContainText('You can edit');

    await addPlace(bob, { name: 'Time Out Market', lat: 38.7069, lng: -9.1459 });
    await expect(row(alice, 'Time Out Market')).toBeVisible();
    await expect(alice.locator('.col-sub')).toContainText('Shared with 1');

    // Carol views: no editing, but her own rating and visited mark.
    const carol = await joinSpace(w, alice, ref, 'carol', 'viewer');
    await expect(row(carol, 'Time Out Market')).toBeVisible();
    await expect(carol.locator('.col-sub')).toContainText('View only');
    await expect(carol.getByRole('button', { name: 'Add place' })).toHaveCount(0);
    await row(carol, 'Time Out Market').locator('.col-row-main').click();
    const sheet = carol.getByRole('dialog', { name: 'Time Out Market' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await audit(carol);
    await sheet.getByRole('radio', { name: '4 of 5 stars' }).click();
    await sheet.getByRole('button', { name: 'Mark as visited by you' }).click();
    await expect(sheet.getByRole('button', { name: 'You have been here' })).toHaveAttribute('aria-pressed', 'true');
    await carol.keyboard.press('Escape');
    await expect(row(carol, 'Time Out Market').locator('.col-row-visited')).toBeVisible();

    await expect(row(alice, 'Time Out Market').locator('.col-row-rating')).toContainText('4');
    await expect(row(bob, 'Time Out Market').locator('.col-row-rating')).toContainText('4');
    // Visited is per person.
    await expect(row(alice, 'Time Out Market').locator('.col-row-visited')).toHaveCount(0);

    // Alice changes the status; both others see it.
    await row(alice, 'Time Out Market').getByRole('button', { name: 'More for Time Out Market' }).click();
    await menuItem(alice, 'Visited').click();
    await expect(row(bob, 'Time Out Market').locator('.col-status')).toHaveAttribute('data-status', 'visited');
    await expect(row(carol, 'Time Out Market').locator('.col-status')).toHaveAttribute('data-status', 'visited');

    for (const page of [alice, bob, carol]) { await audit(page); await noOverflow(page); }
    await capture(alice, testInfo, 'collection-owner');
    await capture(carol, testInfo, 'collection-viewer');

    const list = await w.open('bob', '#/collections');
    await expect(list.locator(`.col-card[data-id="${ref.s}"]`)).toContainText('Lisbon food');
    await expect(list.locator(`.col-card[data-id="${ref.s}"]`)).toContainText('You can edit');
    await audit(list); await noOverflow(list);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('offline edits sync on reconnect and a deleted place parks a conflict to review', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const alice = await w.open('alice', '#/collections');
    const ref = await createCollection(alice, 'Porto');
    await addPlace(alice, { name: 'Livraria Lello', lat: 41.1468, lng: -8.6149 });
    await addPlace(alice, { name: 'Majestic Café', lat: 41.1471, lng: -8.6066 });
    const bob = await joinSpace(w, alice, ref, 'bob', 'editor');
    await expect(row(bob, 'Majestic Café')).toBeVisible();

    await bob.context().setOffline(true);
    await syncStatus(bob, 'Sync is paused while offline.');
    for (const name of ['Livraria Lello', 'Majestic Café']) {
      await row(bob, name).getByRole('button', { name: `More for ${name}` }).click();
      await menuItem(bob, 'Go again').click();
      await expect(row(bob, name).locator('.col-status')).toHaveAttribute('data-status', 'revisit');
    }

    // Meanwhile Alice deletes one of them.
    await row(alice, 'Livraria Lello').getByRole('button', { name: 'More for Livraria Lello' }).click();
    await menuItem(alice, 'Delete').click();
    await alice.getByRole('dialog', { name: 'Delete Livraria Lello?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(row(alice, 'Livraria Lello')).toHaveCount(0);
    await expect.poll(() => committed(w.world, 'alice', ref.s, 'saved').map((item) => item.name)).toEqual(['Majestic Café']);

    await bob.context().setOffline(false);
    await expect(row(alice, 'Majestic Café').locator('.col-status')).toHaveAttribute('data-status', 'revisit');
    const issue = bob.locator('.col-issue');
    await expect(issue).toBeVisible();
    await expect(issue).toContainText('1');
    await audit(bob);
    await issue.getByRole('button', { name: 'Review' }).click();
    const dialog = bob.getByRole('dialog', { name: 'Resolve a conflict' });
    await expect(dialog.getByRole('button', { name: 'Keep theirs' })).toBeVisible();
    await audit(bob);
    await capture(bob, testInfo, 'collection-conflict');
    await dialog.getByRole('button', { name: 'Keep theirs' }).click();
    await expect(issue).toBeHidden();
    await expect(row(bob, 'Livraria Lello')).toHaveCount(0);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a refused write is undone and out-of-credit sync is reported', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const alice = await w.open('alice', '#/collections');
    const ref = await createCollection(alice, 'Madrid');
    await addPlace(alice, { name: 'Prado', lat: 40.4138, lng: -3.6921 });
    const bob = await joinSpace(w, alice, ref, 'bob', 'editor');
    await expect(row(bob, 'Prado')).toBeVisible();

    w.world.failNext({ method: 'workers.exec', as: 'bob', status: 403, code: 'forbidden' });
    await row(bob, 'Prado').getByRole('button', { name: 'More for Prado' }).click();
    await menuItem(bob, 'Idea').click();
    await toastText(bob, 'A change was refused because you no longer have permission. It was undone.');
    await expect(row(bob, 'Prado').locator('.col-status')).toHaveAttribute('data-status', 'want');

    w.world.failNext({ method: 'workers.exec', as: 'bob', status: 402, times: 50 });
    await row(bob, 'Prado').getByRole('button', { name: 'More for Prado' }).click();
    await menuItem(bob, 'Visited').click();
    await syncStatus(bob, 'Sync paused. Check Puter credit, then retry.');
    await audit(bob);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the public link shows places signed out without ratings, tags or member ids, and stops after rotate and off', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const alice = await w.open('alice', '#/collections');
    await createCollection(alice, 'Kyoto temples');
    await addPlace(alice, { name: 'Kinkaku-ji', lat: 35.0394, lng: 135.7292 });
    await row(alice, 'Kinkaku-ji').locator('.col-row-main').click();
    const sheet = alice.getByRole('dialog', { name: 'Kinkaku-ji' });
    const tags = sheet.locator('input[list]');
    await tags.fill('secret-tag');
    await tags.press('Enter');
    await expect(sheet.locator('.pl-tag-chips')).toContainText('secret-tag');
    await sheet.getByRole('radio', { name: '5 of 5 stars' }).click();
    await expect(row(alice, 'Kinkaku-ji').locator('.col-row-rating')).toContainText('5');
    await alice.keyboard.press('Escape');
    await expect(row(alice, 'Kinkaku-ji').locator('.col-row-sub')).toContainText('secret-tag');

    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const sharing = alice.getByRole('dialog', { name: 'Share Kyoto temples' });
    await sharing.getByRole('switch', { name: 'Share a read-only link' }).click();
    const urlBox = sharing.locator('.col-public-url');
    await expect(urlBox).toHaveValue(/#\/s\//);
    const first = await urlBox.inputValue();
    await audit(alice);

    const viewer = await signedOutViewer(browser, testInfo, baseURL, w.world, publicHash(first));
    try {
      await expect(viewer.page.getByRole('heading', { name: 'Kyoto temples', level: 1 })).toBeVisible();
      await expect(viewer.page.locator('.col-public-row')).toHaveCount(1);
      await expect(viewer.page.locator('.col-public-row')).toContainText('Kinkaku-ji');
      await expect(viewer.page.locator('body')).not.toContainText('secret-tag');
      const [body] = viewer.json();
      expect(body.kind).toBe('collection');
      const text = JSON.stringify(body);
      for (const leak of ['secret-tag', USERS.alice.uuid, '"rating"', '"tags"', '"visited"', '"src"']) expect(text).not.toContain(leak);
      await audit(viewer.page); await noOverflow(viewer.page);
      await capture(viewer.page, testInfo, 'collection-public');

      await sharing.getByRole('button', { name: 'New link' }).click();
      await expect(urlBox).not.toHaveValue(first);
      const second = await urlBox.inputValue();
      await viewer.page.reload();
      await expect(viewer.page.getByRole('alert')).toBeVisible();
      await expect(viewer.page.getByRole('heading', { name: 'Kyoto temples' })).toHaveCount(0);

      await viewer.page.goto(`${baseURL}/index.html${publicHash(second)}`);
      await expect(viewer.page.getByRole('heading', { name: 'Kyoto temples', level: 1 })).toBeVisible();
      await sharing.getByRole('switch', { name: 'Share a read-only link' }).click();
      await toastText(alice, 'The public link is off.');
      await viewer.page.reload();
      await expect(viewer.page.getByRole('alert')).toBeVisible();
      expect(viewer.errors).toEqual([]);
    } finally { await viewer.context.close(); }
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('saving a trip’s places skips duplicates, and a place copies to another collection', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const setup = await w.open('alice');
    await expect(setup.locator('html')).toHaveAttribute('data-worker', 'ready');
    const trip = await setup.evaluate(async () => {
      const ref = await trips.createTrip({ title: 'Lisbon trip', start: '2026-11-02', end: '2026-11-04' });
      await trips.open(ref);
      await trips.create(ref, 'place', { name: 'Time Out Market', lat: 38.7069, lng: -9.1459 });
      await trips.create(ref, 'place', { name: 'LX Factory', lat: 38.7036, lng: -9.1786 });
      await trips.flush(ref);
      return ref;
    });
    await setup.close();

    const alice = await w.open('alice', '#/collections');
    const food = await createCollection(alice, 'Lisbon food');
    await addPlace(alice, { name: 'Time Out Market', lat: 38.7069, lng: -9.1459 });
    const second = await w.open('alice', '#/collections');
    await createCollection(second, 'Porto');

    // From the trip's places pane: one of the two is already saved.
    const plan = await w.open('alice', `#/t/${trip.w}/${trip.s}/plan`);
    await expect(plan.getByText('LX Factory').first()).toBeAttached();
    // Phones show the Plan tab's panes one at a time.
    const pane = plan.getByRole('button', { name: 'Places', exact: true });
    if (await pane.isVisible()) await pane.click();
    await plan.getByRole('button', { name: 'Places options' }).first().click();
    await plan.getByRole('menuitem', { name: 'Save places to a collection' }).click();
    const save = plan.getByRole('dialog', { name: 'Save 2 places' });
    await save.getByLabel('Collection').selectOption({ label: 'Lisbon food' });
    await expect(save).toContainText('1 will be saved; 1 are already in it.');
    await audit(plan);
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(save).toHaveCount(0);

    const list = await w.open('alice', `#/c/${food.w}/${food.s}/places`);
    await expect(list.locator('.col-row')).toHaveCount(2);
    await row(list, 'LX Factory').getByRole('button', { name: 'More for LX Factory' }).click();
    await menuItem(list, 'Copy to…').click();
    const pick = list.getByRole('dialog', { name: 'Copy 1 places to' });
    await expect(pick.getByRole('button', { name: 'Porto' })).toBeVisible();
    await audit(list);
    await pick.getByRole('button', { name: 'Porto' }).click();
    await toastText(list, 'Porto');
    const porto = await w.open('alice', '#/collections');
    await porto.locator('.col-card').filter({ hasText: 'Porto' }).locator('a').click();
    await expect(row(porto, 'LX Factory')).toBeVisible();
    await noOverflow(porto);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
