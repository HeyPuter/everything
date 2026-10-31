import { test, expect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';
import { committed, joinSpace, refFromURL } from './helpers/spaces.js';
import { createPeerRelay } from './helpers/peer-relay.js';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

/** Alice: a blank journey with one entry and a photo book filled from it. Returns the journey ref. */
async function journeyWithBook(w) {
  const alice = await w.open('alice', '#/journeys');
  await alice.getByRole('button', { name: 'New journey' }).first().click();
  const form = alice.getByRole('dialog', { name: 'New journey' });
  await form.getByLabel('Title', { exact: true }).fill('Azores');
  await form.getByRole('button', { name: 'Create' }).click();
  await alice.waitForURL(/#\/j\//);
  const ref = refFromURL(alice.url(), 'journey');
  await alice.evaluate(async (target) => {
    await trips.deploy();
    await trips.open(target);
    await trips.create(target, 'entry', { type: 'moment', title: 'Sete Cidades', date: '2026-09-01', order: 'V', story: 'Two lakes, one blue and one green.' });
    await trips.flush(target);
  }, ref);
  await alice.getByRole('tab', { name: 'Photo book' }).click();
  await alice.getByRole('button', { name: 'Create photo book' }).click();
  await alice.getByRole('dialog', { name: 'New photo book' }).getByRole('button', { name: 'Create book' }).click();
  await expect(alice.locator('.bk-editor')).toBeVisible();
  return { alice, ref };
}

async function openBook(w, as, ref) {
  const page = await w.open(as, `#/j/${ref.w}/${ref.s}/book`);
  await expect(page.locator('.bk-editor')).toBeVisible();
  return page;
}

/** Opens a rail section; on phones the rail is a sheet behind a button. */
async function railTab(page, name) {
  const tab = page.getByRole('tab', { name, exact: true });
  if (!await tab.isVisible()) await page.locator('.bk-editor').getByRole('button', { name: /tools|pages/i }).first().click();
  await tab.click();
}

/** On phones the rail is a sheet over the page; close it before touching the page. */
async function closeSheet(page) {
  const sheet = page.getByRole('dialog', { name: 'Book tools' });
  if (await sheet.isVisible()) { await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0); }
}

const stageElements = (page, kind) => page.locator(`.bk-stage .bk-el${kind ? `[data-kind="${kind}"]` : ''}`);

test('two editors see each other’s edits, cursors and selections; a viewer cannot edit', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  const relay = createPeerRelay();
  for (const as of ['alice', 'bob', 'carol']) await relay.attach(await w.context(as));
  try {
    const { alice, ref } = await journeyWithBook(w);
    await joinSpace(w, alice, ref, 'bob', 'editor');
    await joinSpace(w, alice, ref, 'carol', 'viewer');
    const bob = await openBook(w, 'bob', ref);
    const before = await stageElements(alice).count();
    await expect(stageElements(bob)).toHaveCount(before);
    await audit(alice); await noOverflow(alice);

    // Live cursors over the fake peer network.
    await expect(alice.locator('.bk-live')).toHaveAttribute('data-status', 'live');
    await expect(bob.locator('.bk-live')).toHaveAttribute('data-status', 'live');
    const sheet = bob.locator('.bk-stage .bk-page, .bk-stage .bk-sheet').first();
    await sheet.scrollIntoViewIfNeeded();
    const box = await sheet.boundingBox();
    await bob.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await bob.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
    // Members poll for each other's invites every 10 s.
    await expect(alice.locator('.bk-cursor')).toContainText('bob', { timeout: 25_000 });
    await stageElements(bob).first().click();
    await expect(stageElements(bob).first()).toHaveAttribute('aria-pressed', 'true');
    await expect(alice.locator('.bk-peer-select')).toContainText('bob');
    await expect(alice.locator('.bk-badge').first()).toBeAttached();
    await expect(alice.locator('.bk-live .sr-only')).toHaveText('Editing now: bob');
    await capture(alice, testInfo, 'book-cursors');

    // Bob adds a rectangle; Alice sees it.
    await bob.keyboard.press('Escape');
    await railTab(bob, 'Elements');
    await bob.getByRole('button', { name: 'Rectangle' }).click();
    await closeSheet(bob);
    await expect(stageElements(bob, 'shape')).toHaveCount(1);
    await expect(stageElements(alice, 'shape')).toHaveCount(1);
    // Alice deletes it; Bob sees it go.
    await stageElements(alice, 'shape').click();
    await alice.keyboard.press('Delete');
    await expect(stageElements(alice, 'shape')).toHaveCount(0);
    await expect(stageElements(bob, 'shape')).toHaveCount(0);
    await alice.keyboard.press('ControlOrMeta+z');
    await expect(stageElements(bob, 'shape')).toHaveCount(1);

    // Keyboard: Tab onto the shape, nudge it with an arrow, delete it and undo; Bob sees each step.
    const shape = stageElements(alice, 'shape');
    await shape.focus();
    await expect(shape).toHaveAttribute('aria-pressed', 'true');
    // Elements are placed with logical insets.
    const inset = (locator) => locator.evaluate((node) => node.style.insetInlineStart);
    const start = await inset(shape);
    expect(start).toMatch(/%$/);
    await alice.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => inset(shape)).not.toBe(start);
    await expect.poll(() => inset(stageElements(bob, 'shape'))).not.toBe(start);
    await expect.poll(async () => await inset(stageElements(bob, 'shape')) === await inset(shape)).toBe(true);
    await alice.keyboard.press('Delete');
    await expect(stageElements(bob, 'shape')).toHaveCount(0);
    await alice.keyboard.press('ControlOrMeta+z');
    await expect(stageElements(bob, 'shape')).toHaveCount(1);

    // Carol only looks.
    const carol = await openBook(w, 'carol', ref);
    await expect(stageElements(carol, 'shape')).toHaveCount(1);
    await expect(carol.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await railTab(carol, 'Layouts');
    await expect(carol.locator('.bk-layout').first()).toBeDisabled();
    await closeSheet(carol);
    await stageElements(carol, 'shape').click();
    await carol.keyboard.press('Delete');
    await expect(stageElements(alice, 'shape')).toHaveCount(1);
    for (const page of [alice, bob, carol]) { await audit(page); await noOverflow(page); }
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a stale layout change from two users parks a conflict to review; pages export as PNG', async ({ browser, baseURL }, testInfo) => {
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const { alice, ref } = await journeyWithBook(w);
    await joinSpace(w, alice, ref, 'bob', 'editor');
    const bob = await openBook(w, 'bob', ref);
    await expect(bob.locator('.bk-live')).toHaveAttribute('data-status', 'off');

    await bob.context().setOffline(true);
    await railTab(bob, 'Layouts');
    await bob.getByRole('button', { name: 'Apply layout: Title page' }).click();
    await expect(bob.locator('.bk-layout[aria-pressed="true"]')).toHaveAttribute('aria-label', 'Apply layout: Title page');
    await closeSheet(bob);

    await railTab(alice, 'Layouts');
    await alice.getByRole('button', { name: 'Apply layout: Framed photo' }).click();
    await expect(alice.locator('.bk-layout[aria-pressed="true"]')).toHaveAttribute('aria-label', 'Apply layout: Framed photo');
    await closeSheet(alice);
    await expect.poll(() => committed(w.world, 'alice', ref.s, 'bookPage').some((page) => page.layout === 'cover-framed')).toBe(true);

    await bob.context().setOffline(false);
    const issue = bob.locator('.bk-issue');
    // The outbox retries on its own backoff after reconnecting.
    await expect(issue).toBeVisible({ timeout: 20_000 });
    await expect(issue).toContainText('1 page edit clashed with someone else’s');
    await audit(bob);
    await issue.getByRole('button', { name: 'Review' }).click();
    const dialog = bob.getByRole('dialog', { name: 'Resolve a conflict' });
    await expect(dialog.getByRole('button', { name: 'Keep theirs' })).toBeVisible();
    await audit(bob);
    await capture(bob, testInfo, 'book-conflict');
    await dialog.getByRole('button', { name: 'Keep theirs' }).click();
    await expect(issue).toBeHidden();
    await railTab(bob, 'Layouts');
    await expect(bob.locator('.bk-layout[aria-pressed="true"]')).toHaveAttribute('aria-label', 'Apply layout: Framed photo');
    await closeSheet(bob);

    // PNG export of the current page.
    await alice.getByRole('button', { name: 'More book actions' }).click();
    await alice.getByRole('menuitem', { name: 'Save pages as images' }).click();
    const exporter = alice.getByRole('dialog', { name: 'Save pages as images' });
    await expect(exporter.getByRole('button', { name: 'Save images' })).toBeVisible();
    await audit(alice);
    const download = alice.waitForEvent('download');
    await exporter.getByRole('button', { name: 'Save images' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.(png|zip)$/);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
