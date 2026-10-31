import { test, expect as baseExpect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow, USERS } from './helpers/bridge-world.js';

// Q7 public trip link: the owner turns it on in Members, a signed-out visitor with no account reads it in a fresh
// context, and nothing private reaches the page or the projection.
const expect = baseExpect.configure({ timeout: 15_000 });
test.use({ actionTimeout: 15_000 });

const touch = (testInfo) => Boolean(testInfo.project.use.hasTouch);
// Text that must never reach a visitor, whatever the toggles.
const SECRETS = ['Renew passport', 'Safe combination 2468', 'Secret note', 'Hotel deposit (private)', 'carol@example.com', 'Which beach?', USERS.alice.uuid, USERS.bob.uuid];
// Text that only the matching toggle shows.
const CODE = 'TP1234';
const BOOKING_NOTE = 'Door code 4321';
const CHAT = 'See you at the airport';

/** A trip with a day, a placed visit, a booking with a code, packing, costs, chat, a to-do, a note, a poll, a guest and a private expense. */
async function seed(page, ref) {
  return page.evaluate(async ({ ref, alice, bob }) => {
    const t = globalThis.trips;
    await t.open(ref);
    const day = await t.create(ref, 'day', { order: 'V', date: '2026-11-02' });
    const tower = await t.create(ref, 'place', { name: 'Belém Tower', address: 'Avenida Brasília, 1400-038 Lisboa', lat: 38.6916, lng: -9.216 });
    await t.create(ref, 'visit', { dayId: day, placeId: tower, order: 'V', start: '09:00' });
    await t.create(ref, 'res', { type: 'flight', title: 'Flight to Porto', status: 'confirmed', code: 'TP1234', notes: 'Door code 4321', start: { date: '2026-11-03', time: '10:00', tz: 'Europe/Lisbon' } });
    await t.create(ref, 'pack', { name: 'Sunscreen', order: 'V' });
    await t.create(ref, 'exp', { name: 'Taxi from the airport', amount: 2500, currency: 'EUR', payers: [{ who: alice, amount: 2500 }], split: { mode: 'equal', parts: [{ who: alice }, { who: bob }] } });
    await t.create(ref, 'todo', { name: 'Renew passport', order: 'V' });
    await t.create(ref, 'note', { title: 'Secret note', body: 'Safe combination 2468', author: alice });
    await t.create(ref, 'poll', { question: 'Which beach?', options: ['Cascais', 'Costa da Caparica'], author: alice });
    await t.create(ref, 'msg', { text: 'See you at the airport', author: alice });
    await t.create(ref, 'guest', { name: 'carol@example.com' });
    await t.privateItem(ref, 'exp', { name: 'Hotel deposit (private)', amount: 9000, currency: 'EUR', payers: [{ who: alice, amount: 9000 }], split: { mode: 'equal', parts: [{ who: alice }] } });
    return t.flush(ref);
  }, { ref, alice: USERS.alice.uuid, bob: USERS.bob.uuid });
}
/** The raw projection as a signed-out client fetches it. */
async function projection(w, url) {
  const { hash } = new URL(url);
  const [, , worker, space, token] = hash.split('/');
  const response = await w.world.client(null).workers.exec(`https://${worker}.puter.work/pub/${space}/${token}`, { headers: { 'x-puter-no-auth': '1' } });
  return { status: response.status, text: await response.text() };
}
const sectionTab = (page, name) => page.getByRole('tab', { name, exact: true });
async function noSecrets(page, extra = []) {
  const text = await page.locator('body').innerText();
  for (const secret of [...SECRETS, ...extra]) expect(text, `"${secret}" on the public page`).not.toContain(secret);
}

test('a signed-out visitor reads the public link; toggles, rotation and turning it off apply', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: '2026-11-02', end: '2026-11-05' });
    const setup = await w.open('alice', trip.hash('plan'));
    expect((await seed(setup, trip.ref)).status).toBe('sent');
    await setup.close();
    const bobChat = await w.open('bob', trip.hash('collab'));
    await bobChat.locator('.chat-input').fill('Landing at noon');
    await bobChat.locator('.chat-send').click();
    await expect(bobChat.locator('.chat-msg', { hasText: 'Landing at noon' })).not.toHaveClass(/is-pending/);
    await bobChat.close();

    const alice = await w.open('alice', trip.hash('members'));
    const share = alice.locator('.share-section');
    await share.getByRole('button', { name: 'Create public link' }).click();
    await expect(share.locator('.share-url')).toHaveValue(/#\/s\//);
    const url = await share.locator('.share-url').inputValue();
    await audit(alice);

    // Bob cannot manage the link but sees what is public.
    const bob = await w.open('bob', trip.hash('members'));
    await expect(bob.locator('.share-section')).toContainText('People with it can see: Itinerary, Map and locations, Bookings.');
    await expect(bob.locator('.share-section .share-url')).toHaveCount(0);
    await bob.close();

    // A fresh signed-out context with no account.
    const visitor = await w.open(null, new URL(url).hash);
    expect(await visitor.evaluate(() => puter.auth.isSignedIn())).toBe(false);
    await expect(visitor.getByRole('heading', { name: 'Lisbon', level: 1 })).toBeVisible();
    await expect(visitor.locator('.public-badge')).toHaveText('Read-only');
    await expect(sectionTab(visitor, 'Itinerary')).toBeVisible();
    await expect(sectionTab(visitor, 'Map')).toBeVisible();
    await expect(sectionTab(visitor, 'Chat')).toHaveCount(0);
    await expect(sectionTab(visitor, 'Costs')).toHaveCount(0);
    await expect(visitor.locator('[data-place]').first()).toContainText('Belém Tower');
    await expect(visitor.locator('.public-travelers')).toContainText('c…');
    await sectionTab(visitor, 'Map').click();
    await expect(visitor.locator('.public-map')).toBeVisible();
    await sectionTab(visitor, 'Bookings').click();
    await expect(visitor.getByText('Flight to Porto')).toBeVisible();
    await noSecrets(visitor, [CODE, BOOKING_NOTE, CHAT, 'Taxi from the airport']);
    await audit(visitor);
    await noOverflow(visitor);
    await capture(visitor, testInfo, 'public-viewer');
    let raw = await projection(w, url);
    expect(raw.status).toBe(200);
    for (const secret of [...SECRETS, CODE, BOOKING_NOTE, CHAT, 'Landing at noon', 'Taxi from the airport']) expect(raw.text).not.toContain(secret);

    // Codes, costs and chat on: the visitor sees them after a refresh, still with aliased member ids.
    for (const key of ['codes', 'costs', 'chat']) await share.locator(`[data-focus="share:${key}"]`).check();
    await expect(share.locator('.members-status')).toHaveText('Saved.');
    await visitor.getByRole('button', { name: 'Refresh' }).click();
    await expect(sectionTab(visitor, 'Chat')).toBeVisible();
    await sectionTab(visitor, 'Bookings').click();
    await expect(visitor.getByText(CODE)).toBeVisible();
    await sectionTab(visitor, 'Chat').click();
    await expect(visitor.getByText(CHAT)).toBeVisible();
    await expect(visitor.getByText('Landing at noon')).toBeVisible();
    await sectionTab(visitor, 'Costs').click();
    await expect(visitor.getByText('Taxi from the airport')).toBeVisible();
    await noSecrets(visitor);
    await audit(visitor);
    raw = await projection(w, url);
    for (const secret of SECRETS) expect(raw.text).not.toContain(secret);
    expect(raw.text).toContain(CODE);

    // A new link: the old one stops working at once.
    await share.getByRole('button', { name: 'New link' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'New link' }).click();
    await expect(share.locator('.members-status')).toHaveText('New link created. The old one no longer works.');
    const rotated = await share.locator('.share-url').inputValue();
    expect(rotated).not.toBe(url);
    const stale = await w.open(null, new URL(url).hash);
    await expect(stale.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
    await audit(stale);
    const fresh = await w.open(null, new URL(rotated).hash);
    await expect(fresh.getByRole('heading', { name: 'Lisbon', level: 1 })).toBeVisible();

    // Turning it off.
    await share.getByRole('button', { name: 'Turn off' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
    await expect(share.getByRole('button', { name: 'Create public link' })).toBeVisible();
    const off = await w.open(null, new URL(rotated).hash);
    await expect(off.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
    expect((await projection(w, rotated)).status).toBe(404);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('keyboard only: the visitor moves between sections with the arrow keys', async ({ browser, baseURL }, testInfo) => {
  test.skip(touch(testInfo), 'Keyboard path on the desktop projects.');
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', start: '2026-11-02', end: '2026-11-05' });
    const setup = await w.open('alice', trip.hash('plan'));
    await seed(setup, trip.ref);
    await setup.close();
    const alice = await w.open('alice', trip.hash('members'));
    await alice.locator('.share-section').getByRole('button', { name: 'Create public link' }).click();
    const url = await alice.locator('.share-section .share-url').inputValue();
    const visitor = await w.open(null, new URL(url).hash);
    await expect(visitor.getByRole('heading', { name: 'Lisbon', level: 1 })).toBeFocused();
    await sectionTab(visitor, 'Itinerary').focus();
    await visitor.keyboard.press('ArrowRight');
    await expect(sectionTab(visitor, 'Map')).toBeFocused();
    await visitor.keyboard.press('ArrowRight');
    await expect(sectionTab(visitor, 'Bookings')).toHaveAttribute('aria-selected', 'true');
    await visitor.keyboard.press('Tab');
    await expect(visitor.getByRole('tabpanel', { name: 'Bookings' })).toBeFocused();
    await expect(visitor.getByRole('tabpanel', { name: 'Bookings' })).toContainText('Flight to Porto');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
