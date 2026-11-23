import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { addReply, addShapeAnnotation } from '../../src/core/annotations.js';
import { addNote } from '../../src/core/notes.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
const rtl = (locator) => locator.evaluate((node) => node.matches(':dir(rtl)'));

// Comments written in Hebrew or Arabic were laid out left to right wherever they were shown
// or edited, so their punctuation and any Latin words or numbers landed at the wrong end.
test('comments in right-to-left scripts read right to left where they are shown and edited', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const note = addNote(doc, 0, { x: 50, y: 450, text: 'מה דעתך על PDF?' });
  addReply(doc, 0, note, { text: 'نعم، موافق.' });
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 200, width: 80, height: 60 },
    text: 'Checked 3 times.',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'rtl.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);

  await page.getByRole('button', { name: /^Edit note:/ }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  expect(await rtl(props.getByLabel('Note text', { exact: true }))).toBe(true);
  expect(await rtl(props.locator('.reply-text'))).toBe(true);
  // A reply typed in Arabic turns its box around as it is written.
  const reply = props.getByLabel('Reply text');
  expect(await rtl(reply)).toBe(false);
  await reply.fill('شكرا');
  expect(await rtl(reply)).toBe(true);

  await page.getByRole('button', { name: 'Rectangle: Checked 3 times.' }).click();
  expect(await rtl(props.getByLabel('Comment', { exact: true }))).toBe(false);

  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await tabs.getByRole('tab', { name: /Comments/ }).click();
  const list = page.getByRole('group', { name: 'Comments', exact: true });
  expect(await rtl(list.locator('.comment-text').first())).toBe(true);
  expect(await rtl(list.locator('.comment-text').nth(1))).toBe(false);
});
