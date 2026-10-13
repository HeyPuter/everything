// Two people in two browser contexts on one shared document, against the
// real room worker service running in the test process (collab-harness.ts).
import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, openImage, tool } from './helpers';
import { environment, owner, editor } from '../collab-helpers';
import { person, relay } from './collab-harness';

const sharedState = (page: Page) =>
  page.evaluate(async () => {
    const { sharedOf } = await import('/src/features/collab/state.ts');
    const e = window.photoStudio;
    const sh = sharedOf(e.session) as unknown as { role: string; client: { status: { state: string; pending: number } } } | undefined;
    return sh ? { role: sh.role, state: sh.client.status.state, pending: sh.client.status.pending, layers: e.doc.layers.map((l) => l.name) } : null;
  });
const threads = (page: Page) =>
  page.evaluate(async () => {
    const { commentsOf } = await import('/src/features/collab/state.ts');
    return commentsOf(window.photoStudio)
      .threads()
      .map((t) => ({ anchor: t.anchor, texts: t.messages.map((m) => `${m.author.name}: ${m.text}`), resolved: !!t.resolved }));
  });
/** The alpha of the top pixel layer at a document point (0 when transparent). */
const paintedAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([x, y]) => {
      const { readRGBA } = await import('/src/model/tiles.ts');
      const e = window.photoStudio;
      const l = [...e.doc.layers].reverse().find((l) => l.kind === 'pixel' && l.pixels);
      return l ? readRGBA(e.assets.tiles, l.pixels!, { x, y, width: 1, height: 1 }).data[3] : -1;
    },
    [x, y],
  );

test('two people edit and comment on one shared document', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const env = environment();
  const peers = relay();
  const opts = { baseURL: info.project.use.baseURL, viewport: { width: 1280, height: 800 } };
  const ctxA = await browser.newContext(opts),
    ctxB = await browser.newContext(opts);
  const a = await person(env, peers, ctxA, owner);
  await openImage(a.page, 320, 240, '#4070a0', 'shared.png');
  await a.page.evaluate(() => void window.photoStudio.runCommand('layer.new-quick'));
  await idle(a.page);

  // Invite to Edit: start sharing, then create an editor link.
  await a.page.evaluate(() => void window.photoStudio.runCommand('file.invite-to-edit'));
  await a.page.getByRole('button', { name: 'Start Sharing' }).click();
  const access = a.page.locator('dialog .collab-dialog');
  await expect(access).toBeVisible({ timeout: 60_000 });
  await expect(a.page.locator('.collab-bar')).toBeVisible();
  // Nothing to revoke yet, and inviting by username needs a name.
  await expect(access.locator('.collab-invites')).toHaveText('No active invitation links');
  await expect(access.getByRole('button', { name: 'Revoke Invitation Links' })).toBeDisabled();
  await expect(access.getByRole('button', { name: 'Invite', exact: true })).toBeDisabled();
  await access.getByRole('textbox', { name: 'Puter username' }).fill('carol');
  await expect(access.getByRole('button', { name: 'Invite', exact: true })).toBeEnabled();
  await access.getByRole('textbox', { name: 'Puter username' }).fill('');
  await access.locator('select[name="role"]').selectOption('editor');
  await access.getByRole('button', { name: 'Create Link' }).click();
  const linkInput = access.getByRole('textbox', { name: 'Invitation link' });
  await expect(linkInput).toHaveValue(/#ps-server=.*ps-room=.*ps-invite=/);
  const link = new URL(await linkInput.inputValue());
  await expect(access.locator('.collab-members')).toContainText('alice');
  await expect(access.getByRole('button', { name: 'Revoke Invitation Links' })).toBeEnabled();
  await access.getByRole('button', { name: 'Done' }).click();
  expect((await sharedState(a.page))?.role).toBe('owner');

  // The second person opens the invitation in another browser context.
  const b = await person(env, peers, ctxB, editor, link.pathname + link.hash);
  await expect.poll(async () => (await sharedState(b.page))?.layers, { timeout: 60_000 }).toEqual((await sharedState(a.page))!.layers);
  expect((await sharedState(b.page))?.role).toBe('editor');
  // The invitation is removed from the address bar once read.
  expect(new URL(b.page.url()).hash).toBe('');

  // Paint in one; it appears in the other.
  expect(await paintedAt(b.page, 100, 80)).toBe(0);
  await a.page.evaluate(() => {
    const e = window.photoStudio;
    e.setTool('brush');
    e.setForeground('#ff0000');
  });
  await canvasDrag(a.page, [[60, 60], [140, 100], [200, 90]]);
  await expect.poll(() => paintedAt(a.page, 100, 80)).toBeGreaterThan(0);
  await expect.poll(() => paintedAt(b.page, 100, 80), { timeout: 30_000 }).toBeGreaterThan(0);
  // The other person's cursor (presence) reaches the first over the peer link.
  await b.page.mouse.move(400, 400);
  await expect(a.page.locator('#overlay .collab-cursor')).toHaveCount(1, { timeout: 30_000 });
  await expect(a.page.locator('.collab-avatar')).toHaveCount(2);

  // A comment pinned in one; a reply from the other.
  await a.page.evaluate(() => window.photoStudio.setTool('comment'));
  await canvasClick(a.page, 50, 40);
  const draft = a.page.getByRole('textbox', { name: 'New comment' });
  await expect(draft).toBeVisible();
  await draft.fill('Can we warm this up? @bob');
  await a.page.locator('.comment-draft').getByRole('button', { name: 'Comment' }).click();
  await expect.poll(() => threads(b.page), { timeout: 30_000 }).toEqual([{ anchor: { x: 50, y: 40 }, texts: ['alice: Can we warm this up? @bob'], resolved: false }]);
  // Pins are drawn in the canvas overlay (never into the image).
  await expect(b.page.locator('#overlay .comment-pin')).toHaveCount(1);
  await b.page.evaluate(() => window.photoStudio.dock.show('comments'));
  await b.page.locator('.comment-thread').getByRole('button', { name: /Open comment 1/ }).click();
  const reply = b.page.getByRole('textbox', { name: 'Reply' });
  await reply.fill('Done.');
  await b.page.locator('.comment-thread').getByRole('button', { name: 'Reply' }).click();
  await b.page.locator('.comment-thread').getByRole('button', { name: 'Resolve' }).click();
  await expect.poll(async () => (await threads(a.page))[0], { timeout: 30_000 }).toEqual({ anchor: { x: 50, y: 40 }, texts: ['alice: Can we warm this up? @bob', 'bob: Done.'], resolved: true });

  // The people popover: aria-expanded, and Escape returns focus to its button.
  const people = a.page.locator('.collab-bar .collab-people');
  await people.click();
  await expect(people).toHaveAttribute('aria-expanded', 'true');
  await expect(a.page.locator('.collab-popover').getByRole('button', { name: 'Stop Sharing…' })).toBeVisible();
  await a.page.keyboard.press('Escape');
  await expect(a.page.locator('.collab-popover')).toBeHidden();
  await expect(people).toHaveAttribute('aria-expanded', 'false');
  await expect(people).toBeFocused();

  // Both settle with nothing pending and no errors.
  await expect.poll(async () => (await sharedState(a.page))?.pending).toBe(0);
  await expect.poll(async () => (await sharedState(b.page))?.pending).toBe(0);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await ctxA.close();
  await ctxB.close();
});

test('a review link opens the review view; reviewers comment but cannot edit', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const env = environment();
  const peers = relay();
  const opts = { baseURL: info.project.use.baseURL, viewport: { width: 1280, height: 720 } };
  const ctxA = await browser.newContext(opts),
    ctxR = await browser.newContext(opts);
  const a = await person(env, peers, ctxA, owner);
  await openImage(a.page, 320, 240, '#a07040', 'review.png');
  await a.page.evaluate(() => void window.photoStudio.runCommand('file.share-for-review'));
  await a.page.getByRole('button', { name: 'Start Sharing' }).click();
  const dialog = a.page.locator('dialog .collab-dialog');
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  // Review links give comment or view access only.
  await expect(dialog.locator('select[name="role"] option')).toHaveText(['Can comment', 'Can view']);
  await dialog.getByRole('button', { name: 'Create Link' }).click();
  const link = new URL(await dialog.getByRole('textbox', { name: 'Invitation link' }).inputValue());
  expect(link.hash).toContain('ps-review=1');
  await dialog.getByRole('button', { name: 'Done' }).click();

  const r = await person(env, peers, ctxR, editor, link.pathname + link.hash);
  await expect(r.page.locator('html.review-mode')).toHaveCount(1, { timeout: 60_000 });
  await expect(r.page.locator('.review-header')).toContainText('Review · you can comment');
  await expect(r.page.locator('.toolbar')).toBeHidden();
  await expect(r.page.locator('.collab-status')).toContainText('Comment only');
  // Edits are refused in the editor (and by the worker, see the unit tests).
  const before = await r.page.evaluate(() => window.photoStudio.doc.layers.length);
  await r.page.evaluate(() => window.photoStudio.runCommand('layer.new-quick'));
  expect(await r.page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(before);
  // The reviewer pins a comment on a region; the owner sees it.
  await r.page.locator('.review-header').getByRole('button', { name: 'Comment' }).click();
  await canvasDrag(r.page, [[40, 40], [120, 100]]);
  await r.page.getByRole('textbox', { name: 'New comment' }).fill('Crop tighter here');
  await r.page.locator('.comment-draft').getByRole('button', { name: 'Comment' }).click();
  await expect.poll(async () => (await threads(a.page)).map((t) => t.texts), { timeout: 30_000 }).toEqual([['bob: Crop tighter here']]);
  const anchor = (await threads(a.page))[0].anchor;
  expect(anchor.width).toBeGreaterThan(50);
  expect(r.errors).toEqual([]);
  expect(a.errors).toEqual([]);
  await ctxA.close();
  await ctxR.close();
});

test('the Comment tool puts the cursor in the new comment, even when the panel was closed', async ({ page }) => {
  await boot(page);
  await openImage(page, 320, 240, '#808080', 'local.png');
  expect(await page.evaluate(() => window.photoStudio.dock.isVisible('comments'))).toBe(false);
  await tool(page, 'Comment Tool');
  await canvasClick(page, 100, 80);
  const draft = page.getByRole('textbox', { name: 'New comment' });
  await expect(draft).toBeFocused();
  // Typing goes into the comment, not to tool shortcuts.
  await page.keyboard.type('hello');
  await expect(draft).toHaveValue('hello');
  expect(await page.evaluate(() => window.photoStudio.activeTool?.id)).toBe('comment');
  // While drafting the panel shows the draft without the empty-state text.
  await expect(page.locator('.comments-panel')).not.toContainText('No comments yet');
  await expect(page.locator('.comment-draft').getByRole('button', { name: 'Comment' })).toHaveAttribute('title', /Post the comment/);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await expect(page.locator('.comment-thread')).toHaveCount(1);
});
