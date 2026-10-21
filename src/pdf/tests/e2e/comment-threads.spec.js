import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addReply, listAnnotations, setReviewState } from '../../src/core/annotations.js';
import { addNote } from '../../src/core/notes.js';
import { addHighlight, rectQuad } from '../../src/core/highlight.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

async function open(page, doc) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'threads.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
}
async function saved(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return listAnnotations(await PDFDocument.load(await readFile(await (await pending).path())), 0);
}
const repliesOf = (entry) => entry.replies.map((reply) => reply.contents);

// Sticky notes and text markups show their thread as every other comment does: the review
// status, the replies other editors made, and a box to reply.
test('a sticky note shows its replies and status and takes new ones', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const note = addNote(doc, 0, { x: 100, y: 400, text: 'Check the totals', author: 'Ada' });
  addReply(doc, 0, addReply(doc, 0, note, { text: 'Done', author: 'Grace' }), {
    text: 'Thanks',
    author: 'Ada',
  });
  setReviewState(doc, 0, note, { state: 'Accepted', author: 'Grace' });
  await open(page, doc);
  await page.getByRole('button', { name: 'Edit note: Check the totals' }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  await expect(props.getByLabel('Review status')).toHaveValue('Accepted');
  const replies = props.getByRole('list', { name: 'Replies' });
  await expect(replies).toContainText('Grace');
  await expect(replies).toContainText('Done');
  await expect(replies.getByRole('listitem').getByRole('listitem')).toContainText('Thanks');

  // A reply sent while the note's own text was being changed keeps that change too.
  await props.getByLabel('Note text').fill('Check the totals again');
  await props.getByLabel('Reply text').fill('Will do');
  await props.getByLabel('Reply text').press('ControlOrMeta+Enter');
  await settled(page);
  await expect(props.getByRole('list', { name: 'Replies' })).toContainText('Will do');
  await expect(props.getByLabel('Reply text')).toBeFocused();
  await expect(props.getByLabel('Reply text')).toHaveValue('');
  await props.getByLabel('Review status').selectOption('Completed');
  await settled(page);
  await expect(props.getByLabel('Review status')).toHaveValue('Completed');
  await expect(props.getByLabel('Review status')).toBeFocused();
  const [kept] = await saved(page);
  expect(kept.contents).toBe('Check the totals again');
  expect(kept.state).toBe('Completed');
  expect(repliesOf(kept)).toEqual(['Done', 'Will do']);

  // Deleting the note takes its thread with it, and one Undo brings all of it back.
  await page.getByRole('button', { name: 'Edit note: Check the totals again' }).click();
  await props.getByRole('button', { name: 'Delete note' }).click();
  await settled(page);
  expect(await saved(page)).toEqual([]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  const [restored] = await saved(page);
  expect(repliesOf(restored)).toEqual(['Done', 'Will do']);
  expect(restored.replies[0].replies.map((reply) => reply.contents)).toEqual(['Thanks']);
  expect(restored.state).toBe('Completed');
});

test('a highlight shows its replies and status and takes new ones', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]).drawText('Highlighted words', { x: 40, y: 400, size: 18 });
  addHighlight(doc, 0, {
    quads: [rectQuad({ x: 40, y: 394, width: 150, height: 22 })],
    text: 'Highlighted words',
  });
  const [mark] = listAnnotations(doc, 0);
  addReply(doc, 0, mark.id, { text: 'Why this?', author: 'Grace' });
  await open(page, doc);
  await page.getByRole('button', { name: 'Edit highlight: Highlighted words' }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  await expect(props.getByRole('list', { name: 'Replies' })).toContainText('Why this?');
  await expect(props.getByLabel('Review status')).toHaveValue('None');
  await props.getByLabel('Reply text').fill('It matters');
  await props.getByRole('button', { name: 'Reply', exact: true }).click();
  await settled(page);
  // The highlight stays selected, its thread brought up to date.
  await expect(props.getByLabel('Highlight color')).toBeVisible();
  await expect(props.getByRole('list', { name: 'Replies' })).toContainText('It matters');
  await props.getByLabel('Review status').selectOption('Rejected');
  await settled(page);
  await expect(props.getByLabel('Review status')).toHaveValue('Rejected');
  const [kept] = await saved(page);
  expect(repliesOf(kept)).toEqual(['Why this?', 'It matters']);
  expect(kept.state).toBe('Rejected');
});
