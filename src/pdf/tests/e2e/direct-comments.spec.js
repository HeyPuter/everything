import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote, listNotes } from '../../src/core/notes.js';
import { addHighlight, listHighlights, rectQuad } from '../../src/core/highlight.js';
import { addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

// Some writers put annotation dictionaries straight into the page's /Annots array instead of
// referring to indirect objects.
async function directPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Direct note' });
  addHighlight(doc, 0, {
    kind: 'highlight',
    text: 'Direct highlight',
    quads: [rectQuad({ x: 100, y: 150, width: 120, height: 24 })],
  });
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 220, y: 40, width: 80, height: 60 },
    text: 'Direct box',
  });
  const annots = page.node.Annots();
  const direct = annots
    .asArray()
    .map((ref) => doc.context.lookup(ref))
    .filter((dict) => dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Popup'));
  for (const dict of direct) dict.delete(PDFName.of('Popup'));
  page.node.set(PDFName.of('Annots'), doc.context.obj(direct));
  return doc;
}
async function openPdf(page, doc) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'direct.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
}
async function exported(page) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return PDFDocument.load(await readFile(await (await download).path()));
}

test('comments written directly into the page annotation list can be selected and edited', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  await openPdf(page, await directPdf());
  const note = page.getByRole('button', { name: 'Edit note: Direct note', exact: true });
  await note.click();
  await page.getByLabel('Note text', { exact: true }).fill('Changed note');
  await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
  const highlight = page.getByRole('button', {
    name: 'Edit highlight: Direct highlight',
    exact: true,
  });
  await highlight.click();
  await page.getByLabel('Highlight color', { exact: true }).fill('#1144cc');
  // Its first reply makes it an object of its own, which a reply must point at; it stays
  // selected with its thread.
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  await props.getByLabel('Reply text').fill('Agreed');
  await props.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(props.getByRole('list', { name: 'Replies' })).toContainText('Agreed');
  await expect(props.getByLabel('Highlight color')).toHaveValue('#1144cc');
  await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
  const saved = await exported(page);
  expect(listNotes(saved, 0).map((n) => n.text)).toEqual(['Changed note']);
  expect(listHighlights(saved, 0)[0]).toMatchObject({ hex: '#1144cc', text: 'Direct highlight' });
  const [mark] = listAnnotations(saved, 0).filter((entry) => entry.subtype === 'Highlight');
  expect(mark.replies.map((entry) => entry.contents)).toEqual(['Agreed']);
  await page.getByRole('button', { name: 'Edit note: Changed note', exact: true }).click();
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(page.getByRole('button', { name: /Edit note/ })).toHaveCount(0);
  expect(listNotes(await exported(page), 0)).toEqual([]);
});

test('a shape written directly into the page annotation list can be selected, replied to and deleted', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  await openPdf(page, await directPdf());
  const settled = () => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await settled();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle: Direct box', exact: true }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  const width = props.getByLabel('Line width', { exact: true });
  await width.selectOption('3');
  await settled();
  await expect(width).toHaveValue('3');
  const reply = props.getByLabel('Reply text');
  await reply.fill('Looks right');
  await reply.press('ControlOrMeta+Enter');
  await settled();
  await expect(props.getByRole('list', { name: 'Replies' })).toContainText('Looks right');
  await props.getByLabel('Review status').selectOption('Accepted');
  await settled();
  await expect(props.getByLabel('Review status')).toHaveValue('Accepted');
  const box = () => listAnnotations(saved, 0).find((entry) => entry.subtype === 'Square');
  let saved = await exported(page);
  expect(box()).toMatchObject({ width: 3, state: 'Accepted', contents: 'Direct box' });
  expect(box().replies.map((entry) => entry.contents)).toEqual(['Looks right']);
  await page.getByRole('button', { name: 'Rectangle: Direct box', exact: true }).click();
  await page.keyboard.press('Delete');
  await settled();
  await expect(page.getByRole('button', { name: 'Rectangle: Direct box' })).toHaveCount(0);
  saved = await exported(page);
  expect(box()).toBeUndefined();
});

test('the Comments panel opens comments written directly into the page annotation list', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  await openPdf(page, await directPdf());
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  const list = page.getByRole('group', { name: 'Comments', exact: true });
  // A phone's panel hides once a comment is chosen; it is opened again for the next.
  const choose = async (name) => {
    if (!(await list.isVisible())) {
      if (!(await tabs.isVisible()))
        await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
      await tabs.getByRole('tab', { name: /Comments/ }).click();
    }
    await list.getByRole('button', { name }).click();
  };
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  await choose(/Direct note/);
  await expect(props.getByLabel('Note text', { exact: true })).toHaveValue('Direct note');
  await choose(/Direct highlight/);
  await expect(props.getByLabel('Highlight color', { exact: true })).toBeVisible();
  await choose(/Direct box/);
  await expect(page.getByRole('button', { name: 'Rectangle: Direct box' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(props.getByLabel('Line width', { exact: true })).toBeVisible();
});
