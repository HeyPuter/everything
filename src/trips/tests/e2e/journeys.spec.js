import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow, USERS } from './helpers/bridge-world.js';
import { committed, joinSpace, refFromURL, syncStatus, toastText } from './helpers/spaces.js';
import { publicHash, signedOutViewer } from './helpers/public-viewer.js';
import { exifJpeg } from '../unit/helpers/exif-jpeg.js';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

/** A trip with two dated days and one planned visit on each, made through the mock hook. */
async function seedTrip(w) {
  const page = await w.open('alice');
  await expect(page.locator('html')).toHaveAttribute('data-worker', 'ready');
  await page.evaluate(async () => {
    const trip = await trips.createTrip({ title: 'Lisbon', start: '2026-10-20', end: '2026-10-21' });
    await trips.open(trip);
    const first = await trips.create(trip, 'day', { order: 'V', date: '2026-10-20' });
    const second = await trips.create(trip, 'day', { order: 'k', date: '2026-10-21' });
    const tower = await trips.create(trip, 'place', { name: 'Belém Tower', lat: 38.6916, lng: -9.2160 });
    const alfama = await trips.create(trip, 'place', { name: 'Alfama', lat: 38.7118, lng: -9.1300 });
    await trips.create(trip, 'visit', { dayId: first, placeId: tower, order: 'V' });
    await trips.create(trip, 'visit', { dayId: second, placeId: alfama, order: 'V' });
    await trips.flush(trip);
  });
  await page.close();
}

async function newJourney(page, { fromTrip = true, title } = {}) {
  await page.getByRole('button', { name: 'New journey' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New journey' });
  if (!fromTrip) {
    // Without trips the dialog is the blank form straight away.
    await expect(dialog).toBeVisible();
    if (await dialog.getByRole('button', { name: 'Blank' }).count()) {
      await dialog.getByRole('button', { name: 'Blank' }).click();
      await dialog.getByRole('button', { name: 'Create' }).click();
    }
    const form = page.getByRole('dialog', { name: 'New journey' });
    await form.getByLabel('Title', { exact: true }).fill(title);
    await form.getByRole('button', { name: 'Create' }).click();
  } else await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/#\/j\//);
  await expect(page.locator('h2.jr-title')).toBeVisible();
  return refFromURL(page.url(), 'journey');
}

const entry = (page, title) => page.locator('article.jr-entry').filter({ has: page.locator('.jr-entry-title', { hasText: title }) });

/** A decodable JPEG from the page's canvas with an EXIF block carrying a GPS position. */
async function gpsPhoto(page) {
  const jpeg = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
    const context = canvas.getContext('2d'); context.fillStyle = '#3a7'; context.fillRect(0, 0, 64, 48);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
  const exif = exifJpeg();
  const app1 = exif.subarray(2, 4 + ((exif[4] << 8) | exif[5]));
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from(app1), jpeg.subarray(2)]);
}
/** True when a JPEG has an EXIF block pointing at GPS data (tag 0x8825, either byte order). */
function hasGps(bytes) {
  for (let at = 2; at + 4 < bytes.length && bytes[at] === 0xff;) {
    const marker = bytes[at + 1];
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker === 0xda) return false;
    const segment = bytes.subarray(at + 4, at + 2 + length);
    if (marker === 0xe1 && segment.subarray(0, 4).toString('latin1') === 'Exif') {
      for (let i = 0; i + 1 < segment.length; i++) if ((segment[i] === 0x88 && segment[i + 1] === 0x25) || (segment[i] === 0x25 && segment[i + 1] === 0x88)) return true;
    }
    at += 2 + length;
  }
  return false;
}

test('a journey from a trip shared with an editor and a viewer: suggestions, entries and members-only', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    await seedTrip(w);
    const alice = await w.open('alice', '#/journeys');
    await expect(alice.getByRole('heading', { name: 'No journeys yet' }).or(alice.locator('.empty h3'))).toBeVisible();
    await audit(alice); await noOverflow(alice);
    const ref = await newJourney(alice);
    await expect(entry(alice, 'Belém Tower')).toHaveClass(/is-suggestion/);
    await expect(entry(alice, 'Alfama')).toHaveClass(/is-suggestion/);
    await expect(alice.locator('.jr-facts')).not.toContainText('[object');
    await audit(alice); await noOverflow(alice);

    const bob = await joinSpace(w, alice, ref, 'bob', 'editor');
    const carol = await joinSpace(w, alice, ref, 'carol', 'viewer');

    // Bob writes up one suggestion and dismisses the other.
    await entry(bob, 'Belém Tower').getByRole('button', { name: 'Write about it' }).click();
    const editor = bob.getByRole('dialog', { name: 'Write about it' });
    await editor.getByLabel('Story').fill('Pastéis de nata **next door**.');
    await audit(bob);
    await editor.getByRole('button', { name: 'Add to journey' }).click();
    await expect(editor).toHaveCount(0);
    await expect(entry(alice, 'Belém Tower')).not.toHaveClass(/is-suggestion/);
    await expect(entry(alice, 'Belém Tower')).toContainText('Pastéis de nata next door.');
    await entry(bob, 'Alfama').getByRole('button', { name: 'Dismiss' }).click();
    await expect(entry(alice, 'Alfama')).toHaveCount(0);

    // A members-only entry by Bob.
    await bob.getByRole('button', { name: 'New entry' }).click();
    const fresh = bob.getByRole('dialog', { name: 'New entry' });
    await fresh.getByLabel('Title').fill('Fado night');
    await fresh.getByLabel('Date').fill('2026-10-21');
    await fresh.getByLabel('Members only').check();
    await fresh.getByRole('button', { name: 'Add to journey' }).click();
    await expect(entry(alice, 'Fado night')).toContainText('Members only');

    // Keyboard only: Alice adds an entry.
    const add = alice.getByRole('button', { name: 'New entry' });
    await add.focus();
    await alice.keyboard.press('Enter');
    const typed = alice.getByRole('dialog', { name: 'New entry' });
    await expect(typed.getByLabel('Title')).toBeVisible();
    await typed.getByLabel('Title').focus();
    await alice.keyboard.type('Tram 28');
    await typed.getByLabel('Date').fill('2026-10-21');
    await typed.getByRole('button', { name: 'Add to journey' }).focus();
    await alice.keyboard.press('Enter');
    await expect(typed).toHaveCount(0);
    await expect(entry(bob, 'Tram 28')).toBeVisible();

    // Carol reads only.
    await expect(entry(carol, 'Fado night')).toBeVisible();
    await expect(carol.getByRole('button', { name: 'New entry' })).toBeHidden();
    await expect(carol.getByRole('button', { name: 'Write about it' })).toHaveCount(0);
    await expect(carol.locator('.jr-facts')).toContainText('View only');

    for (const page of [alice, bob, carol]) { await audit(page); await noOverflow(page); }
    await capture(alice, testInfo, 'journey-timeline');
    for (const tab of ['Map', 'Gallery', 'Stats']) {
      await alice.getByRole('tab', { name: tab }).click();
      await expect(alice.getByRole('tabpanel', { name: tab })).toBeVisible();
      await expect(alice.locator('.view-error')).toHaveCount(0);
      await audit(alice); await noOverflow(alice);
    }
    await capture(alice, testInfo, 'journey-stats');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the public journey link signed out: no members-only entries, suggestions, coordinates or photo GPS unless the map is on', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    await seedTrip(w);
    const alice = await w.open('alice', '#/journeys');
    const ref = await newJourney(alice);
    await alice.evaluate(async (target) => {
      await trips.deploy();
      await trips.open(target);
      await trips.create(target, 'entry', { type: 'moment', title: 'Harbor walk', date: '2026-10-20', order: 'V', loc: { name: 'Cais', lat: 38.7071, lng: -9.1366 } });
      await trips.create(target, 'entry', { type: 'moment', title: 'Private dinner', date: '2026-10-20', order: 'k', vis: 'members' });
      await trips.flush(target);
    }, ref);
    await expect(entry(alice, 'Harbor walk')).toBeVisible();

    // A photo with GPS in its EXIF block on the shared entry.
    await entry(alice, 'Harbor walk').getByRole('button', { name: 'Edit Harbor walk' }).click();
    const editor = alice.getByRole('dialog', { name: 'Edit entry' });
    const chooser = alice.waitForEvent('filechooser');
    await editor.getByRole('button', { name: 'Add photos' }).click();
    await (await chooser).setFiles({ name: 'harbor.jpg', mimeType: 'image/jpeg', buffer: await gpsPhoto(alice) });
    await expect(editor.locator('.jr-media-edit li')).toHaveCount(1);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);

    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const sharing = alice.getByRole('dialog').filter({ hasText: 'Public link' });
    await sharing.getByRole('button', { name: 'Create a public link' }).click();
    const urlBox = sharing.locator('.jr-public-url');
    await expect(urlBox).toHaveValue(/#\/s\//);
    const first = await urlBox.inputValue();
    await audit(alice);

    const viewer = await signedOutViewer(browser, testInfo, baseURL, w.world, publicHash(first));
    try {
      await expect(viewer.page.getByRole('heading', { name: 'Lisbon', level: 1 })).toBeVisible();
      await expect(viewer.page.getByRole('heading', { name: 'Harbor walk' })).toBeVisible();
      await expect(viewer.page.getByText('Private dinner')).toHaveCount(0);
      await expect(viewer.page.getByText('Belém Tower')).toHaveCount(0);
      const body = viewer.json().find((item) => item.kind === 'journey');
      const text = JSON.stringify(body);
      for (const leak of ['Private dinner', 'Belém Tower', '"lat"', '"lng"', USERS.alice.uuid, '"src"', '"vis"']) expect(text).not.toContain(leak);
      // The gallery shows the photo; every image served carries no GPS.
      await viewer.page.getByRole('tab', { name: 'Gallery' }).click();
      await expect(viewer.page.getByRole('tabpanel', { name: 'Gallery' }).locator('.jr-tile img')).toHaveCount(1);
      await expect.poll(() => viewer.served.filter((item) => item.type.startsWith('image/')).length).toBeGreaterThan(0);
      for (const image of viewer.served.filter((item) => item.type === 'image/jpeg')) expect(hasGps(image.body)).toBe(false);
      await audit(viewer.page); await noOverflow(viewer.page);
      await capture(viewer.page, testInfo, 'journey-public');

      // With the map on, entry coordinates are shared.
      await sharing.getByRole('checkbox', { name: 'Map' }).check();
      await expect(sharing.getByText('Saved')).toBeVisible();
      viewer.served.length = 0;
      await viewer.page.reload();
      await expect(viewer.page.getByRole('heading', { name: 'Harbor walk' })).toBeVisible();
      expect(JSON.stringify(viewer.json().find((item) => item.kind === 'journey'))).toContain('"lat"');

      await sharing.getByRole('button', { name: 'New link' }).click();
      await alice.getByRole('dialog', { name: 'Make a new link?' }).getByRole('button', { name: 'New link' }).click();
      await expect(urlBox).not.toHaveValue(first);
      await viewer.page.reload();
      await expect(viewer.page.getByRole('alert')).toBeVisible();
      await viewer.page.goto(`${baseURL}/index.html${publicHash(await urlBox.inputValue())}`);
      await expect(viewer.page.getByRole('heading', { name: 'Harbor walk' })).toBeVisible();
      await sharing.getByRole('button', { name: 'Turn off' }).click();
      await alice.getByRole('dialog', { name: 'Turn off the public link?' }).getByRole('button', { name: 'Turn off' }).click();
      await viewer.page.reload();
      await expect(viewer.page.getByRole('alert')).toBeVisible();
      expect(viewer.errors).toEqual([]);
    } finally { await viewer.context.close(); }
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('offline edits, a deleted-entry conflict and a refused write', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const alice = await w.open('alice', '#/journeys');
    const ref = await newJourney(alice, { fromTrip: false, title: 'Azores' });
    await alice.evaluate(async (target) => {
      await trips.deploy();
      await trips.open(target);
      await trips.create(target, 'entry', { type: 'moment', title: 'Sete Cidades', date: '2026-09-01', order: 'V' });
      await trips.create(target, 'entry', { type: 'moment', title: 'Furnas', date: '2026-09-02', order: 'V' });
      await trips.flush(target);
    }, ref);
    const bob = await joinSpace(w, alice, ref, 'bob', 'editor');
    await expect(entry(bob, 'Furnas')).toBeVisible();

    await bob.context().setOffline(true);
    await syncStatus(bob, 'Sync is paused while offline.');
    for (const [title, next] of [['Sete Cidades', 'Sete Cidades lakes'], ['Furnas', 'Furnas hot springs']]) {
      await entry(bob, title).getByRole('button', { name: `Edit ${title}` }).click();
      const dialog = bob.getByRole('dialog', { name: 'Edit entry' });
      await dialog.getByLabel('Title').fill(next);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(entry(bob, next)).toBeVisible();
    }
    await expect(bob.locator('.jr-issue')).toContainText('You are offline.');
    await audit(bob);

    await entry(alice, 'Sete Cidades').getByRole('button', { name: 'Actions for Sete Cidades' }).click();
    await alice.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(entry(alice, 'Sete Cidades')).toHaveCount(0);
    await expect.poll(() => committed(w.world, 'alice', ref.s, 'entry').map((item) => item.title)).toEqual(['Furnas']);

    await bob.context().setOffline(false);
    await expect(entry(alice, 'Furnas hot springs')).toBeVisible();
    const issue = bob.locator('.jr-issue');
    await expect(issue).toContainText('1 changes conflict');
    await issue.getByRole('button', { name: 'Review' }).click();
    const dialog = bob.getByRole('dialog', { name: 'Resolve a conflict' });
    await expect(dialog.getByRole('button', { name: 'Keep theirs' })).toBeVisible();
    await audit(bob);
    await capture(bob, testInfo, 'journey-conflict');
    await dialog.getByRole('button', { name: 'Keep theirs' }).click();
    await expect(issue).toBeHidden();

    w.world.failNext({ method: 'workers.exec', as: 'bob', status: 403, code: 'forbidden' });
    await entry(bob, 'Furnas hot springs').getByRole('button', { name: 'Edit Furnas hot springs' }).click();
    const edit = bob.getByRole('dialog', { name: 'Edit entry' });
    await edit.getByLabel('Title').fill('Furnas again');
    await edit.getByRole('button', { name: 'Save' }).click();
    await toastText(bob, 'A change was refused and undone.');
    await expect(entry(bob, 'Furnas hot springs')).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
