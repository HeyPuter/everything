import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote, listNotes } from '../../src/core/notes.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// Escape mid-drag let the drag go on: releasing the pointer still moved the note.
test('Escape during a note drag puts the note back without opening it', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Stay here' });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'note-escape.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const note = page.getByRole('button', { name: 'Edit note: Stay here' });
  const box = await note.boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 60, { steps: 5 });
  await page.keyboard.press('Escape');
  await expect(note).toHaveAttribute('style', expect.not.stringContaining('translate('));
  // Released back over the note: no move, and the note does not open either.
  await page.mouse.move(box.x + 6, box.y + 6, { steps: 3 });
  await page.mouse.up();
  await settled(page);
  await expect(
    page.getByRole('complementary', { name: 'Selection properties' }).locator('textarea'),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled();
  // A drag after that moves it as usual.
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + 5, { steps: 5 });
  await page.mouse.up();
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [kept] = listNotes(saved, 0);
  expect(kept.y).toBeCloseTo(300, 3);
  expect(kept.x).toBeGreaterThan(130);
});
