import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// Highlights are comments like any other: the Comments panel, comment summaries, and other
// readers show who made each one and when.
test('highlights record who made them and when', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]).drawText('Keep these selected words', { x: 40, y: 300, size: 20 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);

  // Selected words, then an area placed from the keyboard.
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await page.locator('.textLayer').evaluate((layer) => {
    const span = [...layer.querySelectorAll('span')].find(
      (s) => s.textContent === 'Keep these selected words',
    );
    const range = document.createRange();
    range.setStart(span.firstChild, 5);
    range.setEnd(span.firstChild, 10);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  await page.getByRole('button', { name: 'Highlight selection', exact: true }).click();
  await settled(page);
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await settled(page);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const marks = listAnnotations(saved, 0);
  expect(marks.map((mark) => [mark.subtype, mark.author])).toEqual([
    ['Highlight', 'test-user'],
    ['Highlight', 'test-user'],
  ]);
  for (const mark of marks) {
    expect(mark.created).toBeInstanceOf(Date);
    expect(Math.abs(mark.modified - Date.now())).toBeLessThan(10 * 60 * 1000);
  }
});
