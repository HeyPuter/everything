import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { addReply, addShapeAnnotation, setReviewState } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('the Review status field shows the status a comment has', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const id = addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 200, width: 80, height: 60 },
    text: 'Reviewed',
  });
  setReviewState(doc, 0, id, { state: 'Accepted', author: 'Ada' });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-status.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle: Reviewed', exact: true }).click();
  const props = page.getByRole('complementary', {
    name: 'Selection properties',
  });
  const status = props.getByLabel('Review status');
  await expect(status).toHaveValue('Accepted');

  // A new status stays shown once the comment is drawn again.
  await status.selectOption('Rejected');
  await settled(page);
  await expect(page.locator('#toast')).toContainText('Status set to Rejected.');
  await expect(props.getByLabel('Review status')).toHaveValue('Rejected');
});

// A reply to a reply is part of the thread too, shown beneath the reply it answers.
test('the properties panel shows replies to replies', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const id = addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 200, width: 80, height: 60 },
    text: 'Threaded',
  });
  const reply = addReply(doc, 0, id, { text: 'Agreed', author: 'Grace' });
  addReply(doc, 0, reply, { text: 'Good', author: 'Ada' });
  addReply(doc, 0, id, { text: 'Later', author: 'Lin' });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-thread.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle: Threaded', exact: true }).click();
  const replies = page
    .getByRole('complementary', { name: 'Selection properties' })
    .getByRole('list', { name: 'Replies' });
  await expect(replies.locator(':scope > li')).toHaveCount(2);
  await expect(replies.locator(':scope > li').nth(0)).toContainText('Agreed');
  await expect(replies.locator(':scope > li').nth(0).getByRole('listitem')).toHaveText(/Ada.*Good/);
  await expect(replies.locator(':scope > li').nth(1)).toHaveText(/Lin.*Later/);
});

// A reply's line breaks were run together into one line, and a long link in it ran out of the
// panel, cut off where nobody could read it.
test('a reply keeps its line breaks and wraps a long link', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const id = addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 200, width: 80, height: 60 },
    text: 'Threaded',
  });
  addReply(doc, 0, id, { text: 'First line\nSecond line', author: 'Grace' });
  addReply(doc, 0, id, {
    text: 'https://example.com/a/very/long/path/that/never/breaks/anywhere/along/its/length',
    author: 'Ada',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-reply-lines.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle: Threaded', exact: true }).click();
  const replies = page
    .getByRole('complementary', { name: 'Selection properties' })
    .getByRole('list', { name: 'Replies' })
    .locator(':scope > li');
  await expect(replies).toHaveCount(2);
  const lines = replies.nth(0).locator(':scope > span').nth(1);
  await expect(lines).toHaveText('First line\nSecond line');
  expect(await lines.evaluate((node) => node.innerText)).toBe('First line\nSecond line');
  // The link wraps within the panel instead of running past its edge.
  const link = replies.nth(1).locator(':scope > span').nth(1);
  const [scroll, client] = await link.evaluate((node) => [node.scrollWidth, node.clientWidth]);
  expect(scroll).toBeLessThanOrEqual(client);
});
