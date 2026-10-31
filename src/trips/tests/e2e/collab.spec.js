import { test, expect as baseExpect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow, USERS } from './helpers/bridge-world.js';

// P8 collab and the Q13 feed and link previews, with two or three members on one bridge world.
const expect = baseExpect.configure({ timeout: 15_000 });
test.use({ actionTimeout: 15_000 });

const tab = (page, name) => page.getByRole('tab', { name, exact: true });
async function section(page, name) {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
}
const message = (page, text) => page.locator('.chat-msg').filter({ has: page.locator('.chat-text', { hasText: text }) });
const sent = (page, text) => expect(message(page, text)).not.toHaveClass(/is-pending/);
const touch = (testInfo) => Boolean(testInfo.project.use.hasTouch);
/** Message actions show on hover with a mouse and stay visible on touch screens. */
async function messageAction(page, text, name, testInfo) {
  const row = message(page, text);
  if (!touch(testInfo)) await row.hover();
  await row.getByRole('button', { name, exact: true }).click();
}
async function send(page, text) {
  await page.locator('.chat-input').fill(text);
  await page.locator('.chat-send').click();
}

test('chat between the owner and an editor: send, reply, react, edit and delete', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('collab'));
    const bob = await w.open('bob', trip.hash('collab'));
    await expect(alice.getByRole('heading', { name: 'No messages yet' })).toBeVisible();
    await audit(alice);

    await send(alice, 'Hello Bob, **tram 28** at nine?');
    await expect(message(bob, 'Hello Bob')).toBeVisible();
    await expect(message(bob, 'Hello Bob').locator('strong')).toHaveText('tram 28');

    await messageAction(bob, 'Hello Bob', 'Reply', testInfo);
    await expect(bob.locator('.chat-context')).toContainText('alice');
    await send(bob, 'Sounds good');
    await expect(message(alice, 'Sounds good').locator('.chat-quote')).toContainText('Hello Bob');

    await messageAction(bob, 'Hello Bob', 'Add reaction', testInfo);
    await bob.locator('.chat-reactbar').getByRole('button', { name: '👍' }).click();
    await expect(message(alice, 'Hello Bob').locator('.chat-reaction')).toHaveAttribute('aria-label', /👍.*bob/);
    // Both reactions stay: per-user paths.
    await message(alice, 'Hello Bob').locator('.chat-reaction').click();
    await expect(message(bob, 'Hello Bob').locator('.chat-reaction .num')).toHaveText('2');

    await send(alice, '🎉');
    await expect(message(bob, '🎉').locator('.chat-text')).toHaveClass(/chat-jumbo/);

    await messageAction(alice, 'Hello Bob', 'Message actions', testInfo);
    await alice.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(alice.locator('.chat-context')).toBeVisible();
    await alice.locator('.chat-input').fill('Hello Bob, tram 28 at ten?');
    await alice.locator('.chat-send').click();
    await expect(message(bob, 'at ten?')).toBeVisible();

    // The owner deletes another member's message.
    await messageAction(alice, 'Sounds good', 'Message actions', testInfo);
    await alice.getByRole('menuitem', { name: 'Delete' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(message(bob, 'Sounds good')).toHaveCount(0);
    await expect(message(alice, 'Sounds good')).toHaveCount(0);

    await audit(alice);
    await audit(bob);
    await noOverflow(bob);
    await capture(bob, testInfo, 'collab-chat');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('notes, polls and links reach the other member; results stay hidden until voting', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('collab'));
    const bob = await w.open('bob', trip.hash('collab'));

    await section(alice, 'Notes');
    await expect(alice.getByRole('heading', { name: 'No notes yet' })).toBeVisible();
    await audit(alice);
    await alice.getByRole('button', { name: 'New note' }).first().click();
    const form = alice.getByRole('dialog');
    await form.getByLabel('Title').fill('Pastel de nata');
    await form.getByLabel('Text', { exact: true }).fill('Try **Manteigaria** <img src=x onerror=alert(1)>');
    await form.getByLabel('Category').fill('Food');
    await form.getByRole('radio', { name: /Orange/ }).click();
    await form.getByRole('button', { name: 'Add note' }).click();
    await expect(form).toBeHidden();
    await section(bob, 'Notes');
    const card = bob.locator('.note-card', { hasText: 'Pastel de nata' });
    await expect(card).toBeVisible();
    await expect(card.locator('strong')).toHaveText('Manteigaria');
    await expect(card.locator('img')).toHaveCount(0);
    await expect(card).toHaveAttribute('data-color', /[1-6]/);
    await expect(bob.locator('.collab-filter', { hasText: 'Food' })).toBeVisible();
    await audit(bob);

    await section(bob, 'Polls');
    await expect(bob.getByRole('heading', { name: 'No polls yet' })).toBeVisible();
    await bob.getByRole('button', { name: 'New poll' }).first().click();
    const poll = bob.getByRole('dialog');
    await poll.getByLabel('Question').fill('Dinner on Friday?');
    await poll.getByLabel('Option 1').fill('Alfama');
    await poll.getByLabel('Option 2').fill('Bairro Alto');
    await poll.getByRole('button', { name: 'Create poll' }).click();
    await expect(poll).toBeHidden();
    await section(alice, 'Polls');
    const question = (page) => page.locator('.poll-card', { hasText: 'Dinner on Friday?' });
    await expect(question(alice)).toBeVisible();
    await expect(question(alice).locator('.poll-count')).toHaveCount(0);
    await question(alice).locator('button.poll-option', { hasText: 'Alfama' }).click();
    await expect(question(alice).locator('button.poll-option', { hasText: 'Alfama' })).toHaveAttribute('aria-pressed', 'true');
    await expect(question(alice).locator('.poll-count').first()).toHaveText('100%');
    await expect(question(bob).locator('.poll-count')).toHaveCount(0);
    await question(bob).locator('button.poll-option', { hasText: 'Bairro Alto' }).click();
    await expect(question(alice).locator('.poll-summary')).toHaveText('2 people voted');
    await audit(alice);

    await section(alice, 'Links');
    await alice.getByLabel('Web address').fill('https://www.visitlisboa.com/en');
    await alice.getByLabel('Title').fill('Visit Lisboa');
    await alice.getByRole('button', { name: 'Add link' }).click();
    await section(bob, 'Links');
    await expect(bob.locator('.link-list')).toContainText('Visit Lisboa');
    await audit(bob);
    await noOverflow(bob);
    await capture(alice, testInfo, 'collab-links');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the unread badge counts the other member’s activity and clears on opening Collab', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('plan'));
    const bob = await w.open('bob', trip.hash('collab'));
    // One commit per message: each one is sent before the next is written.
    await send(bob, 'Booked the tram tickets');
    await sent(bob, 'Booked the tram tickets');
    await send(bob, 'And the castle');
    const badge = alice.locator('.trip-tab[data-tab="collab"] .collab-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('2');
    await expect(badge.locator('.sr-only')).toHaveText('2 unread updates');
    // The hidden label sits past the phone's width in an unscrolled strip; the strip must contain it.
    expect(await badge.locator('.sr-only').evaluate((node) => node.closest('.trip-tabs').contains(node.offsetParent))).toBe(true);
    await noOverflow(alice);
    await alice.locator('.trip-tab[data-tab="collab"]').click();
    await expect(message(alice, 'And the castle')).toBeVisible();
    await expect(badge).toBeHidden();

    await section(alice, 'Activity');
    await expect(alice.locator('.feed-note')).toContainText('30 days');
    await expect(alice.locator('.feed-item').first()).toBeVisible();
    await expect(alice.locator('.feed-list')).toContainText('bob');
    await audit(alice);
    await noOverflow(alice);

    // The dashboard shows the count from local data once the trip was opened, and it stays cleared after reading.
    await send(bob, 'One more');
    const dashboard = await w.open('alice', '#/');
    await expect(dashboard.locator(`[data-trip="${trip.ref.s}"] .trip-unread`).first()).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a viewer reads chat, notes and polls without write controls', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon', role: 'viewer' });
    const alice = await w.open('alice', trip.hash('collab'));
    await send(alice, 'Welcome aboard');
    const bob = await w.open('bob', trip.hash('collab'));
    await expect(message(bob, 'Welcome aboard')).toBeVisible();
    await expect(bob.locator('.chat-composer')).toBeHidden();
    await expect(bob.locator('.chat-readonly')).toBeVisible();
    await expect(message(bob, 'Welcome aboard').getByRole('button', { name: 'Add reaction' })).toHaveCount(0);
    await section(bob, 'Notes');
    await expect(bob.getByRole('button', { name: 'New note' })).toHaveCount(0);
    await section(bob, 'Polls');
    await expect(bob.getByRole('button', { name: 'New poll' })).toHaveCount(0);
    await section(bob, 'Links');
    await expect(bob.locator('form.link-add')).toBeHidden();
    await audit(bob);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a message written offline is sent after reconnecting; a note edited on both sides reaches the conflict list', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    // Bob writes the note, so both he (the author) and Alice (the owner) may edit it.
    const bob = await w.open('bob', trip.hash('collab'));
    await section(bob, 'Notes');
    await bob.getByRole('button', { name: 'New note' }).first().click();
    await bob.getByRole('dialog').getByLabel('Title').fill('Day trip');
    await bob.getByRole('dialog').getByRole('button', { name: 'Add note' }).click();
    const alice = await w.open('alice', trip.hash('collab'));
    await section(alice, 'Notes');
    await expect(alice.locator('.note-card', { hasText: 'Day trip' })).toBeVisible();

    const bobContext = await w.context('bob');
    await bobContext.setOffline(true);
    await expect.poll(() => w.host.stats().offlinePages).toBeGreaterThan(0);
    await bob.locator('.note-card', { hasText: 'Day trip' }).getByRole('button', { name: /^Actions for / }).click();
    await bob.getByRole('menuitem', { name: 'Edit' }).click();
    await bob.getByRole('dialog').getByLabel('Title').fill('Sintra day');
    await bob.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(bob.locator('.note-card', { hasText: 'Sintra day' })).toBeVisible();

    await section(bob, 'Chat');
    await send(bob, 'Written on the train');
    await expect(message(bob, 'Written on the train').locator('.chat-status')).toHaveText('Waiting for a connection');

    await alice.locator('.note-card', { hasText: 'Day trip' }).getByRole('button', { name: /^Actions for / }).click();
    await alice.getByRole('menuitem', { name: 'Edit' }).click();
    await alice.getByRole('dialog').getByLabel('Title').fill('Cascais day');
    await alice.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(alice.locator('.note-card', { hasText: 'Cascais day' })).toBeVisible();

    await bobContext.setOffline(false);
    await section(alice, 'Chat');
    await expect(message(alice, 'Written on the train')).toBeVisible({ timeout: 20_000 });
    const conflicts = bob.locator('.collab-conflicts');
    await expect(conflicts).toBeVisible({ timeout: 20_000 });
    await expect(conflicts.getByRole('heading', { name: 'Changes that could not be saved' })).toBeVisible();
    await audit(bob);
    await conflicts.getByRole('button', { name: 'Review' }).click();
    const dialog = bob.getByRole('dialog');
    await expect(dialog).toContainText('Sintra day');
    await expect(dialog).toContainText('Cascais day');
    await dialog.getByRole('button', { name: 'Keep mine' }).click();
    await expect(conflicts).toBeHidden();
    await section(alice, 'Notes');
    await expect(alice.locator('.note-card', { hasText: 'Sintra day' })).toBeVisible({ timeout: 20_000 });
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('chat images: upload from the composer, the four-image cap, and the thumbnail opening the preview', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('collab'));
    const bob = await w.open('bob', trip.hash('collab'));
    const png = await alice.evaluate(async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 40, height: 30 });
      const context = canvas.getContext('2d'); context.fillStyle = '#c0392b'; context.fillRect(0, 0, 40, 30);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    const images = Array.from({ length: 5 }, (_, index) => ({ name: `tile-${index + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(png) }));
    // A paste of five images: four are staged and the fifth is refused.
    await alice.locator('.chat-input').focus();
    await alice.evaluate((files) => {
      const data = new DataTransfer();
      for (const file of files) data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: 'image/png' }));
      document.querySelector('.chat-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, images.map((image) => ({ name: image.name, bytes: [...image.buffer] })));
    await expect(alice.getByText('A message can carry up to 4 images.')).toBeVisible();
    await expect(alice.locator('.chat-staged-chip:not(.is-uploading)')).toHaveCount(4, { timeout: 20_000 });
    await alice.locator('.chat-send').click();
    await expect(alice.getByText('Write a message to send with the images.')).toBeVisible();
    await send(alice, 'Azulejos');
    await expect(message(bob, 'Azulejos').locator('.chat-image')).toHaveCount(4);
    await message(bob, 'Azulejos').locator('.chat-image').first().click();
    const preview = bob.getByRole('dialog');
    await expect(preview).toBeVisible();
    await expect(preview.locator('img').first()).toBeVisible();
    await audit(bob);
    await bob.keyboard.press('Escape');
    await expect(preview).toBeHidden();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a chat link gets a preview from the worker; private addresses are never fetched', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  // The trip worker runs in this Node process, so its page fetches are stubbed here.
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    fetches.push(url.href);
    if (url.href === 'https://www.visitlisboa.com/en/places/belem-tower') {
      return new Response('<html><head><title>Belém Tower</title><meta property="og:title" content="Belém Tower"><meta property="og:description" content="A 16th-century fortification on the Tagus."></head><body></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return Response.error();
  };
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('collab'));
    const bob = await w.open('bob', trip.hash('collab'));
    await send(alice, 'Tickets: https://www.visitlisboa.com/en/places/belem-tower');
    const card = message(bob, 'Tickets').locator('.chat-preview-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Belém Tower');
    await expect(card).toContainText('16th-century');
    await send(alice, 'Router: http://192.168.1.1/admin');
    await expect(message(bob, 'Router')).toBeVisible();
    await expect(message(bob, 'Router').locator('.chat-preview-card')).toHaveCount(0);
    expect(fetches.filter((url) => url.includes('192.168.'))).toEqual([]);
    expect(fetches).toContain('https://www.visitlisboa.com/en/places/belem-tower');
    await audit(bob);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
    globalThis.fetch = realFetch;
  }
});

test('keyboard only: switch to Notes, add a note and post a chat message with Enter', async ({ browser, baseURL }, testInfo) => {
  test.skip(touch(testInfo), 'Keyboard path on the desktop projects.');
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('collab'));
    await expect(alice.locator('.chat-input')).toBeVisible();
    await tab(alice, 'Chat').focus();
    await alice.keyboard.press('ArrowRight');
    await expect(tab(alice, 'Notes')).toBeFocused();
    await expect(tab(alice, 'Notes')).toHaveAttribute('aria-selected', 'true');
    await alice.keyboard.press('Tab');
    await expect(alice.getByRole('tabpanel', { name: 'Notes' })).toBeFocused();
    await alice.keyboard.press('Tab');
    await expect(alice.getByRole('button', { name: 'New note' }).first()).toBeFocused();
    await alice.keyboard.press('Enter');
    await expect(alice.getByRole('dialog').getByLabel('Title')).toBeFocused();
    await alice.keyboard.type('Packing for Sintra');
    await alice.keyboard.press('Enter');
    await expect(alice.getByRole('dialog')).toBeHidden();
    await expect(alice.locator('.note-card', { hasText: 'Packing for Sintra' })).toBeVisible();
    await tab(alice, 'Notes').focus();
    await alice.keyboard.press('ArrowLeft');
    await expect(tab(alice, 'Chat')).toHaveAttribute('aria-selected', 'true');
    await alice.locator('.chat-input').focus();
    await alice.keyboard.type('Leaving at eight');
    await alice.keyboard.press('Enter');
    await expect(message(alice, 'Leaving at eight')).toBeVisible();
    await expect(alice.locator('.chat-input')).toBeFocused();
    await expect(alice.locator('.chat-input')).toHaveValue('');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a refused write shows the credit message and the composer keeps working', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const bob = await w.open('bob', trip.hash('collab'));
    await expect(bob.locator('.chat-input')).toBeVisible();
    w.world.failNext({ method: 'workers.exec', as: 'bob', status: 402, code: 'owner_credit' });
    await send(bob, 'Is anyone there?');
    await expect(bob.locator('.save-state')).toHaveAttribute('data-state', 'credit');
    await expect(bob.locator('.save-state')).toHaveText('Sync paused. Check Puter credit, then retry.');
    await expect(message(bob, 'Is anyone there?')).toHaveClass(/is-pending/);
    await bob.getByRole('button', { name: 'Retry sync' }).click();
    await sent(bob, 'Is anyone there?');
    const alice = await w.open('alice', trip.hash('collab'));
    await expect(message(alice, 'Is anyone there?')).toBeVisible({ timeout: 30_000 });
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('polls close at their deadline and by hand; notes pin and open in full; Activity filters by area and person', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('collab'));
    const bob = await w.open('bob', trip.hash('collab'));
    // A poll whose deadline passes while both have it open.
    await alice.evaluate(async ({ ref, uid }) => {
      const t = globalThis.trips;
      await t.open(ref);
      await t.create(ref, 'poll', { question: 'Lunch spot?', options: ['Time Out Market', 'Cervejaria Ramiro'], deadline: Date.now() + 6000, author: uid });
      await t.create(ref, 'poll', { question: 'Fado night?', options: ['Yes', 'No'], author: uid });
      await t.create(ref, 'note', { title: 'Tram tips', body: 'Board at **Martim Moniz**.', author: uid });
      return t.flush(ref);
    }, { ref: trip.ref, uid: USERS.alice.uuid });
    await section(bob, 'Polls');
    const lunch = bob.locator('.poll-card', { hasText: 'Lunch spot?' });
    await expect(lunch.locator('button.poll-option')).toHaveCount(2);
    await expect(lunch).toHaveClass(/is-closed/, { timeout: 20_000 });
    await expect(lunch).toContainText('Ended');
    await expect(lunch.locator('button.poll-option')).toHaveCount(0);

    await section(alice, 'Polls');
    const fado = alice.locator('.poll-card', { hasText: 'Fado night?' });
    await fado.getByRole('button', { name: 'Actions for Fado night?' }).click();
    await alice.getByRole('menuitem', { name: 'Close poll' }).click();
    await expect(bob.locator('.poll-card', { hasText: 'Fado night?' })).toContainText('Closed');
    await fado.getByRole('button', { name: 'Actions for Fado night?' }).click();
    await alice.getByRole('menuitem', { name: 'Delete' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(bob.locator('.poll-card', { hasText: 'Fado night?' })).toHaveCount(0);

    await section(alice, 'Notes');
    const tips = alice.locator('.note-card', { hasText: 'Tram tips' });
    await tips.getByRole('button', { name: 'Pin' }).click();
    await section(bob, 'Notes');
    await expect(bob.locator('.note-card', { hasText: 'Tram tips' }).locator('.note-pinned')).toBeVisible();
    await bob.locator('.note-card', { hasText: 'Tram tips' }).getByRole('button', { name: 'Tram tips', exact: true }).click();
    const view = bob.getByRole('dialog', { name: 'Tram tips' });
    await expect(view.locator('strong')).toHaveText('Martim Moniz');
    await audit(bob);
    await bob.keyboard.press('Escape');

    await section(bob, 'Activity');
    await expect(bob.locator('.feed-entry').first()).toBeVisible();
    await bob.locator('.feed-filter').first().selectOption('collab');
    await bob.locator('.feed-filter').nth(1).selectOption('me');
    await expect(bob.locator('.feed-entry')).toHaveCount(0);
    await bob.locator('.feed-filter').nth(1).selectOption('others');
    await expect(bob.locator('.feed-entry').first()).toContainText('alice');
    await audit(bob);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('chat loads older pages past the newest 200 messages', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const setup = await w.open('alice', trip.hash('plan'));
    await setup.evaluate(async ({ ref, uid }) => {
      const t = globalThis.trips;
      await t.open(ref);
      for (let index = 1; index <= 230; index++) {
        await t.create(ref, 'msg', { text: `Message ${index}`, author: uid });
        if (index % 50 === 0) await t.flush(ref);
      }
      return t.flush(ref);
    }, { ref: trip.ref, uid: USERS.alice.uuid });
    await setup.close();
    const bob = await w.open('bob', trip.hash('collab'));
    await expect(message(bob, 'Message 230')).toBeVisible({ timeout: 30_000 });
    await expect(bob.locator('.chat-msg')).toHaveCount(100);
    const older = bob.getByRole('button', { name: 'Load older messages' });
    await older.click();
    await expect(bob.locator('.chat-msg')).toHaveCount(200);
    await older.click();
    await expect(bob.locator('.chat-msg')).toHaveCount(230, { timeout: 30_000 });
    await expect(message(bob, /^Message 1$/)).toBeAttached();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
