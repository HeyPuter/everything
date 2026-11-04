import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { addNote } from '../../src/core/notes.js';

async function prepare(page) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const words of ['apple', 'banana banana', 'cherry', 'banana banana', 'apple'])
    doc.addPage([400, 400]).drawText(words, { font, x: 40, y: 300, size: 18 });
  addNote(doc, 2, { x: 40, y: 220, text: 'Destination note' });
  doc.catalog.set(
    PDFName.of('Dests'),
    doc.context.obj({ destination: [doc.getPage(2).ref, 'Fit'] }),
  );
  doc.getPage(0).node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 180, 160, 200],
        Dest: PDFString.of('destination'),
      }),
    ),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'search-navigation.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 5');
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (
        message?.action === 'GetTextContent' &&
        message.data.pageIndex === 1 &&
        !window.releaseSearchText
      ) {
        window.releaseSearchText = () => post.call(this, message, ...rest);
        return;
      }
      if (message?.action === 'GetDestination' && !window.releaseSearchLink) {
        window.releaseSearchLink = () => post.call(this, message, ...rest);
        return;
      }
      return post.call(this, message, ...rest);
    };
  });
  return page.getByRole('combobox', { name: 'Find in PDF', exact: true });
}
async function goTo(page, number) {
  const input = page.getByRole('spinbutton', { name: 'Page number', exact: true });
  await input.fill(String(number));
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText(`Page ${number} of 5`);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
for (const direction of ['forward', 'backward'])
  for (const newer of [
    'none',
    'page',
    'current page',
    'matching page',
    'link',
    'comment',
    'search',
  ])
    test(`pending ${direction} search respects ${newer === 'none' ? 'its original request' : `a newer ${newer} choice`}`, async ({
      page,
    }) => {
      const input = await prepare(page);
      const key = direction === 'forward' ? 'Enter' : 'Shift+Enter';
      await input.fill('banana');
      await input.press(key);
      await expect
        .poll(() => page.evaluate(() => typeof window.releaseSearchText))
        .toBe('function');
      let selectedPage = 1;
      if (['page', 'matching page', 'current page', 'search'].includes(newer)) {
        selectedPage = newer === 'current page' ? 1 : newer === 'matching page' ? 2 : 3;
        await goTo(page, selectedPage);
      } else if (newer === 'link') {
        await page
          .getByRole('button', { name: 'Link to another page', exact: true })
          .click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Go to linked page', exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => typeof window.releaseSearchLink))
          .toBe('function');
      } else if (newer === 'comment') {
        const tabs = page.getByRole('tablist', { name: 'Side panel' });
        if (!(await tabs.isVisible()))
          await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
        await tabs.getByRole('tab', { name: /Comments/ }).click();
        const comment = page
          .getByRole('group', { name: 'Comments', exact: true })
          .getByRole('button', { name: /on page 3: Destination note/ });
        await comment.focus();
        await comment.press('Enter');
        selectedPage = 3;
        await expect(page.locator('.page-caption')).toHaveText('Page 3 of 5');
        await expect(page.getByLabel('Note text', { exact: true })).toBeFocused();
      }
      // A subsequent explicit search choice renews navigation while extraction is pending.
      if (newer === 'search') await input.press(key);
      await page.evaluate(() => window.releaseSearchText());
      if (!['none', 'search'].includes(newer)) {
        await expect(page.locator('.search-count')).toHaveText('4 matches');
        await expect(page.locator('.page-caption')).toHaveText(`Page ${selectedPage} of 5`);
        await expect(page.locator('.search-hit-current')).toHaveCount(0);
        await expect(page.locator('.search-hit')).toHaveCount(selectedPage === 2 ? 2 : 0);
        if (newer === 'comment')
          await expect(page.getByLabel('Note text', { exact: true })).toBeFocused();
        if (newer === 'link') {
          await page.evaluate(() => window.releaseSearchLink());
          selectedPage = 3;
          await expect(page.locator('.page-caption')).toHaveText('Page 3 of 5');
        }
        await input.press(key);
      }
      const first = direction === 'forward' ? (selectedPage > 2 ? 3 : 1) : selectedPage < 2 ? 4 : 2;
      await expect(page.locator('.search-count')).toHaveText(`${first} of 4`);
      await expect(page.locator('.page-caption')).toHaveText(`Page ${first > 2 ? 4 : 2} of 5`);
      await expect(page.locator('.search-hit-current')).toHaveText('banana');
      await input.press(key);
      await expect(page.locator('.search-count')).toHaveText(
        `${first + (direction === 'forward' ? 1 : -1)} of 4`,
      );
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    });
