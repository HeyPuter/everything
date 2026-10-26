import { test, expect } from '@playwright/test';
import { USERS, audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';
import { chooseFiles, press, read, seed, synced } from './helpers/trip-tools.js';

const DATES = { start: '2026-11-02', end: '2026-11-04' };
const CONTENT = [
  { type: 'day', fields: { order: 'a', date: '2026-11-02', title: 'Old town' } },
  { type: 'place', fields: { name: 'Belém Tower', lat: 38.6916, lng: -9.216 } },
  { type: 'place', fields: { name: 'São Jorge Castle', lat: 38.7139, lng: -9.1334 } },
  { type: 'pack', fields: { name: 'Rain jacket', list: 'Clothes', order: 'a' } },
];
// A 1×1 PNG, so the move has a file to copy.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

const notice = (page) => page.locator('.transfer-notice');
// Buttons are activated with the keyboard: see press() in helpers/trip-tools.js.
const section = (page) => page.locator('.transfer-section');
const roleOf = (page, user) => page.locator(`.member-row[data-key="${USERS[user].uuid}"] .member-role`);

async function offer(w, trip, to = 'bob') {
  const page = await w.open('alice', trip.hash('members'));
  await press(section(page).getByRole('button', { name: 'Transfer ownership…', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Transfer ownership' });
  await dialog.getByRole('radio', { name: new RegExp(`^${to}`) }).check();
  await press(dialog.getByRole('button', { name: `Offer to ${to}`, exact: true }));
  await expect(page.getByText(`Offer sent to ${to}`)).toBeVisible();
  return { page, dialog };
}

/** A trip with content and one uploaded file; Bob already hosts trips, so a move's first file write is the copy. */
async function movableTrip() {
  const trip = await w.sharedTrip({ title: 'Lisbon', ...DATES, role: { bob: 'editor', carol: 'viewer' } });
  await seed(w, 'alice', trip.ref, CONTENT);
  const files = await w.open('alice', trip.hash('files'));
  await chooseFiles(files, () => files.getByRole('button', { name: 'Upload', exact: true }).first().click(), [{ name: 'map.png', mimeType: 'image/png', buffer: PNG }]);
  // The file's row, not its upload row, and the upload finished: closing the page mid-upload would leave no file to move.
  await expect(files.locator('.file-row').filter({ hasText: 'map.png' })).toBeVisible();
  await expect(files.locator('.file-upload:not([data-status="done"])')).toHaveCount(0);
  await synced(files);
  await files.close();
  const setup = await w.open('bob');
  await setup.evaluate(() => globalThis.trips.deploy());
  await setup.close();
  return trip;
}

let w;
test.afterEach(async () => { expect(w?.errors ?? []).toEqual([]); await w?.close(); w = null; });

test('ownership moves to an editor, resumes after a failure, and members follow to the new trip', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  const trip = await movableTrip();

  const { page: alice, dialog } = await offer(w, trip);
  await expect(dialog).toBeHidden();
  await expect(section(alice)).toContainText(/Offered to bob until /);
  await audit(alice); await noOverflow(alice);

  const carol = await w.open('carol', trip.hash('members'));
  await expect(section(carol)).toContainText('alice offered ownership of this trip to bob.');
  await expect(section(carol).getByRole('button')).toHaveCount(0);

  const bob = await w.open('bob', trip.hash('members'));
  await expect(notice(bob)).toContainText('alice offered you ownership of this trip.');
  await press(notice(bob).getByRole('button', { name: 'Review offer', exact: true }));
  const accept = bob.getByRole('dialog', { name: 'Take over this trip' });
  await expect(accept.getByLabel('alice (current owner, becomes an editor)')).toBeChecked();
  await expect(accept.getByLabel('carol · Viewer')).toBeChecked();
  await audit(bob); await capture(bob, testInfo, 'transfer-accept');

  await press(accept.getByRole('button', { name: 'Accept and move', exact: true }));
  const progress = bob.getByRole('dialog', { name: 'Moving the trip' });
  // Armed while the move waits for the frozen trip to settle, so the next write Bob makes is the file copy.
  await expect(progress.locator('.transfer-step[data-state="now"]')).toContainText('Read the trip');
  w.world.failNext({ method: 'fs.write', as: 'bob', status: 403, code: 'permission_denied' });
  await expect(progress.locator('.transfer-status')).toContainText('The move is paused:', { timeout: 30_000 });
  await expect(progress.locator('.transfer-step[data-state="now"]')).toContainText('Copy files');
  await expect(progress.locator('.transfer-step[data-state="done"]')).toHaveCount(5);
  await audit(bob); await capture(bob, testInfo, 'transfer-paused');

  // The trip is frozen for everyone while the move waits: Alice's edit parks as a conflict.
  await expect(notice(carol)).toContainText('This trip is moving to bob’s Trips. It is read-only until that finishes.');
  await expect(section(alice)).toContainText('bob is moving this trip into their Trips.');
  const lists = await w.open('alice', trip.hash('lists'));
  await lists.getByLabel('Add an item to Clothes').fill('Sun hat');
  await lists.getByLabel('Add an item to Clothes').press('Enter');
  await expect(lists.getByText('1 list change could not be saved as it was.')).toBeVisible();
  await lists.close();

  // Bob closes the tab; the journal brings the paused move back in the Members section.
  await bob.close();
  const resumed = await w.open('bob', trip.hash('members'));
  await expect(section(resumed)).toContainText('The move is paused.');
  await press(section(resumed).getByRole('button', { name: 'Resume', exact: true }));
  const again = resumed.getByRole('dialog', { name: 'Moving the trip' });
  await press(again.getByRole('button', { name: 'Try again', exact: true }));
  await expect(again.locator('.transfer-status')).toHaveText('The trip now lives in your Trips.', { timeout: 60_000 });
  await press(again.getByRole('button', { name: 'Open the trip', exact: true }));
  await resumed.waitForURL((url) => !url.hash.includes(trip.ref.w) && url.hash.includes(trip.ref.s));
  const moved = /#\/t\/([^/]+)\//.exec(new URL(resumed.url()).hash)[1];
  const next = { w: moved, s: trip.ref.s, k: 'trip' };
  expect((await read(w, 'bob', next, ['place', 'pack', 'file'])).file).toEqual(['map.png']);

  // Carol opens the old trip and lands in the new one as a viewer.
  const carolAgain = await w.open('carol', trip.hash('plan'));
  await carolAgain.waitForURL((url) => url.hash.includes(moved));
  await expect(carolAgain.getByText('You are in the moved trip.')).toBeVisible();

  // Alice keeps the old copy as a stub; her parked edit follows her to the new trip.
  const stub = await w.open('alice', trip.hash('members'));
  await expect(notice(stub)).toContainText('This trip moved to bob’s Trips.');
  await audit(stub);
  await press(notice(stub).getByRole('button', { name: 'Go to the new trip', exact: true }));
  await stub.waitForURL((url) => url.hash.includes(moved));
  await expect(stub.getByText('Edits made while the trip was moving were applied: 1.')).toBeVisible();

  const members = await w.open('bob', `#/t/${moved}/${trip.ref.s}/members`);
  await expect(roleOf(members, 'bob')).toHaveAttribute('data-role', 'owner');
  await expect(roleOf(members, 'alice')).toHaveAttribute('data-role', 'editor');
  await expect(roleOf(members, 'carol')).toHaveAttribute('data-role', 'viewer');
  const copied = await read(w, 'bob', next, ['place', 'pack', 'file']);
  expect(copied.place.sort()).toEqual(['Belém Tower', 'São Jorge Castle']);
  expect(copied.pack.sort()).toEqual(['Rain jacket', 'Sun hat']);

  // The old owner deletes the stub from its notice.
  const old = await w.open('alice', trip.hash('members'));
  await press(notice(old).getByRole('button', { name: 'Delete this old copy', exact: true }));
  await press(old.getByRole('dialog', { name: 'Delete the old copy?' }).getByRole('button', { name: 'Delete this old copy', exact: true }));
  await expect(old.getByText('The old copy was deleted')).toBeVisible();
  await old.waitForURL((url) => url.hash.includes(moved));
  await expect.poll(() => w.world.inspectKv('alice')['me:spaces'].map((entry) => entry.ref)).toEqual([next]);
});

test('offers can be declined and withdrawn, and the owner can stop a running move', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  const trip = await movableTrip();

  // Viewers have nothing to offer; only the owner sees the action.
  const carol = await w.open('carol', trip.hash('members'));
  await expect(section(carol)).toBeHidden();

  const { page: alice } = await offer(w, trip);
  const bob = await w.open('bob', trip.hash('plan'));
  await press(notice(bob).getByRole('button', { name: 'Decline', exact: true }));
  await expect(bob.getByText('Offer declined')).toBeVisible();
  await expect(notice(bob)).toBeHidden();
  await expect(section(alice).getByRole('button', { name: 'Transfer ownership…', exact: true })).toBeVisible();

  await press(section(alice).getByRole('button', { name: 'Transfer ownership…', exact: true }));
  const dialog = alice.getByRole('dialog', { name: 'Transfer ownership' });
  // Keyboard only: the first candidate is picked; Tab reaches the offer button.
  await expect(dialog.getByRole('radio', { name: /^bob/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Offer to bob', exact: true }).press('Enter');
  await expect(section(alice).getByRole('button', { name: 'Withdraw offer', exact: true })).toBeVisible();
  await press(section(alice).getByRole('button', { name: 'Withdraw offer', exact: true }));
  await expect(alice.getByText('Offer withdrawn')).toBeVisible();
  const bobAgain = await w.open('bob', trip.hash('plan'));
  await expect(notice(bobAgain)).toBeHidden();

  // A running move that pauses can be stopped by the owner: the trip unfreezes and Bob's copy goes away.
  await offer(w, trip);
  const mover = await w.open('bob', trip.hash('members'));
  await press(notice(mover).getByRole('button', { name: 'Review offer', exact: true }));
  await press(mover.getByRole('dialog', { name: 'Take over this trip' }).getByRole('button', { name: 'Accept and move', exact: true }));
  await expect(mover.getByRole('dialog', { name: 'Moving the trip' }).locator('.transfer-step[data-state="now"]')).toContainText('Read the trip');
  w.world.failNext({ method: 'fs.write', as: 'bob', status: 403, code: 'permission_denied' });
  await expect(mover.getByRole('dialog', { name: 'Moving the trip' }).locator('.transfer-status')).toContainText('The move is paused:', { timeout: 30_000 });

  const owner = await w.open('alice', trip.hash('members'));
  await expect(section(owner)).toContainText('bob is moving this trip into their Trips.');
  await press(section(owner).getByRole('button', { name: 'Stop the move', exact: true }));
  await press(owner.getByRole('dialog', { name: 'Stop moving this trip?' }).getByRole('button', { name: 'Stop the move', exact: true }));
  await expect(owner.getByText('The move was stopped')).toBeVisible();
  await expect(section(owner).getByRole('button', { name: 'Transfer ownership…', exact: true })).toBeVisible();

  // Bob retries his paused move: it learns the offer is gone and keeps nothing.
  const progress = mover.getByRole('dialog', { name: 'Moving the trip' });
  await press(progress.getByRole('button', { name: /^(Try again|Resume)$/ }));
  await expect(progress.locator('.transfer-status')).toHaveText('The owner withdrew the offer, so the move stopped. Nothing was kept in your account.');
  await seed(w, 'alice', trip.ref, [{ type: 'place', fields: { name: 'Time Out Market', lat: 38.7071, lng: -9.1457 } }]);
  expect((await read(w, 'carol', trip.ref, ['place'])).place).toContain('Time Out Market');
});
