import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote, listNotes } from '../../src/core/notes.js';

async function showComments(page) {
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await tabs.getByRole('tab', { name: /Comments/ }).click();
}
const comment = (page, index, text) =>
  page
    .getByRole('group', { name: 'Comments', exact: true })
    .getByRole('button', { name: `Note on page ${index + 1}: ${text}`, exact: true });

for (const shared of [false, true])
  for (const editedPage of [0, 1])
    for (const samePage of [false, true])
      for (const moved of [false, true])
        test(`${shared ? 'shared' : 'separate'} note edited on page ${editedPage + 1} reopens on ${samePage ? 'the same' : 'the other'} page with ${moved ? 'newer' : 'editor'} focus`, async ({
          page,
        }) => {
          await page.route('https://js.puter.com/**', (route) => route.abort());
          const doc = await PDFDocument.create();
          doc.addPage([400, 500]);
          doc.addPage([400, 500]);
          addNote(doc, 0, { x: 40, y: 320, text: 'Original' });
          if (shared)
            doc.getPage(1).node.set(PDFName.of('Annots'), doc.getPage(0).node.Annots().clone());
          else addNote(doc, 1, { x: 40, y: 320, text: 'Original' });
          await page.goto('/#library');
          const chooser = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: /^Open a PDF/ }).click();
          await (
            await chooser
          ).setFiles({
            name: 'comment-identity.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from(await doc.save()),
          });
          await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
          if (editedPage) {
            await page.getByRole('button', { name: 'Next page', exact: true }).click();
            await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
          }
          await showComments(page);
          const target = page.getByRole('button', { name: 'Edit note: Original', exact: true });
          await target.focus();
          await target.press('Enter');
          const input = page.getByLabel('Note text', { exact: true });
          await input.fill('Updated');
          await page.evaluate(async () => {
            const { blankPdf, validatePdf } = await import('/src/core/document.js');
            const prototype = Object.getPrototypeOf(await validatePdf(await blankPdf()));
            const save = prototype.save;
            prototype.save = async function (...args) {
              prototype.save = save;
              const bytes = await save.apply(this, args);
              await new Promise((resolve) => {
                window.releaseCommentIdentity = resolve;
              });
              return bytes;
            };
          });
          const destination = samePage ? editedPage : 1 - editedPage;
          const selected = comment(page, destination, 'Original');
          await selected.focus();
          await selected.press('Enter');
          await expect.poll(() => page.evaluate(() => !!window.releaseCommentIdentity)).toBe(true);
          const settings = page.getByRole('button', { name: 'Settings', exact: true });
          if (moved) {
            await settings.focus();
            await settings.evaluate((node) =>
              node.addEventListener('blur', () => {
                window.commentIdentityBlurred = true;
              }),
            );
          }
          await page.evaluate(() => window.releaseCommentIdentity());
          await expect(page.locator('.page-caption')).toHaveText(`Page ${destination + 1} of 2`);
          // The edited note's panel stays, inert, until its edit is saved; the note chosen in
          // the list opens after that.
          await expect(page.locator('.note-editor[inert]')).toHaveCount(0);
          await expect(input).toHaveValue(samePage ? 'Updated' : 'Original');
          await expect(moved ? settings : input).toBeFocused();
          if (moved) expect(await page.evaluate(() => !!window.commentIdentityBlurred)).toBe(false);
          // Reopened properties must point at the current note, not its obsolete shared ID.
          await input.fill('Final');
          await input.press('ControlOrMeta+Enter');
          await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
          const final = ['Original', 'Original'];
          final[editedPage] = 'Updated';
          final[destination] = 'Final';
          const check = async (expected) => {
            const download = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Download', exact: true }).click();
            const saved = await PDFDocument.load(await readFile(await (await download).path()));
            expect([0, 1].map((index) => listNotes(saved, index)[0].text)).toEqual(expected);
          };
          await check(final);
          await showComments(page);
          await comment(page, destination, 'Final').focus();
          // Undo/redo of detaching a shared note changes its ID in both directions.
          // The comments list must retain focus on the same page's instance.
          for (const [shortcut, text] of [
            ['ControlOrMeta+z', samePage ? 'Updated' : 'Original'],
            ['ControlOrMeta+z', 'Original'],
            ['ControlOrMeta+Shift+z', samePage ? 'Updated' : 'Original'],
            ['ControlOrMeta+Shift+z', 'Final'],
          ]) {
            await page.keyboard.press(shortcut);
            await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
            await expect(comment(page, destination, text)).toBeFocused();
          }
          await check(final);
        });
