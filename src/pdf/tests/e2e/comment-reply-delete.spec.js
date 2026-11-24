import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addReply, addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';
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
    name: 'reply-delete.pdf',
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
const contentsOf = (replies) => replies.map((reply) => [reply.contents, contentsOf(reply.replies)]);

// A reply sent by mistake could be taken back only by Undo while the PDF was open; after a
// save it stayed for good. Each reply can be deleted, with the replies to it.
for (const kind of ['note', 'highlight', 'shape'])
  test(`a reply to a ${kind} can be deleted`, async ({ page }) => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]).drawText('Highlighted words', { x: 40, y: 400, size: 18 });
    const id =
      kind === 'note'
        ? addNote(doc, 0, { x: 100, y: 300, text: 'Check the totals', author: 'Ada' })
        : kind === 'highlight'
          ? (addHighlight(doc, 0, {
              quads: [rectQuad({ x: 40, y: 394, width: 150, height: 22 })],
              text: 'Check the totals',
            }),
            listAnnotations(doc, 0)[0].id)
          : addShapeAnnotation(doc, 0, {
              kind: 'square',
              rect: { x: 100, y: 150, width: 120, height: 60 },
              text: 'Check the totals',
            });
    const wrong = addReply(doc, 0, id, { text: 'Sent too soon', author: 'Grace' });
    addReply(doc, 0, wrong, { text: 'Under it', author: 'Ada' });
    addReply(doc, 0, id, { text: 'Done', author: 'Grace' });
    await open(page, doc);
    await page
      .getByRole('button', {
        name: {
          note: 'Edit note: Check the totals',
          highlight: 'Edit highlight: Check the totals',
          shape: 'Rectangle: Check the totals',
        }[kind],
      })
      .click();
    const props = page.getByRole('complementary', { name: 'Selection properties' });
    const replies = props.getByRole('list', { name: 'Replies' });
    await expect(replies).toContainText('Sent too soon');
    await expect(props.getByRole('button', { name: 'Delete reply from Grace' })).toHaveCount(2);
    // Each is named with its reply's words, so a screen reader can tell them apart.
    await expect(
      props.getByRole('button', { name: 'Delete reply from Grace: Done', exact: true }),
    ).toHaveCount(1);
    await props
      .getByRole('button', { name: 'Delete reply from Grace: Sent too soon', exact: true })
      .click();
    await expect(page.locator('#toast')).toHaveText('Reply deleted.');
    await settled(page);
    // The comment stays selected, with what is left of its thread.
    await expect(replies).toContainText('Done');
    await expect(replies).not.toContainText('Sent too soon');
    await expect(replies).not.toContainText('Under it');
    await expect(props.getByLabel('Reply text')).toBeFocused();
    const [kept] = await saved(page);
    expect(kept.contents).toBe('Check the totals');
    expect(contentsOf(kept.replies)).toEqual([['Done', []]]);
  });
