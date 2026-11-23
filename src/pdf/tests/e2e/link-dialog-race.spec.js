import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote, listNotes } from '../../src/core/notes.js';
import { listLinks } from '../../src/core/links.js';

for (const pending of ['name', 'index', 'draft'])
  for (const newer of ['none', 'Settings', 'Keyboard shortcuts', 'About PDF Editor'])
    test(`link editor awaiting ${pending} ${newer === 'none' ? 'opens normally' : `respects newer ${newer}`}`, async ({
      page,
    }) => {
      await page.route('https://js.puter.com/**', (route) => route.abort());
      const doc = await PDFDocument.create();
      doc.addPage([400, 500]);
      doc.addPage([400, 500]);
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({ target: [doc.getPage(1).ref, 'Fit'] }),
      );
      doc.getPage(0).node.addAnnot(
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [40, 300, 160, 320],
            Dest: PDFString.of('target'),
          }),
        ),
      );
      if (pending === 'draft') addNote(doc, 0, { x: 40, y: 220, text: 'Original' });
      await page.goto('/#library');
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: /^Open a PDF/ }).click();
      await (
        await chooser
      ).setFiles({
        name: 'link-dialog.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await doc.save()),
      });
      await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
      if (pending === 'draft') {
        await page.getByRole('button', { name: 'Edit note: Original', exact: true }).click();
        await page.getByLabel('Note text', { exact: true }).fill('Updated');
      }
      await page.evaluate(async (pending) => {
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, ...rest) {
          // The page-index reply is the final destination lookup. Its microtasks
          // finish before the next task observes whether the editor opened.
          if (message?.action === 'GetPageIndex')
            this.addEventListener('message', (event) => {
              if (event.data?.callbackId === message.callbackId)
                setTimeout(() => {
                  Worker.prototype.postMessage = post;
                  window.linkDialogSettled = true;
                }, 0);
            });
          if (
            pending !== 'draft' &&
            message?.action === (pending === 'name' ? 'GetDestination' : 'GetPageIndex') &&
            !window.releaseLinkDialog
          ) {
            window.releaseLinkDialog = () => post.call(this, message, ...rest);
            return;
          }
          return post.call(this, message, ...rest);
        };
        if (pending === 'draft') {
          const { blankPdf, validatePdf } = await import('/src/core/document.js');
          const prototype = Object.getPrototypeOf(await validatePdf(await blankPdf()));
          const save = prototype.save;
          prototype.save = async function (...args) {
            prototype.save = save;
            const bytes = await save.apply(this, args);
            await new Promise((resolve) => {
              window.releaseLinkDialog = resolve;
            });
            return bytes;
          };
        }
      }, pending);
      const link = page.getByRole('button', { name: /^Link to (another page|page \d+)$/ });
      await link.click();
      await expect.poll(() => page.evaluate(() => !!window.releaseLinkDialog)).toBe(true);
      if (newer !== 'none') {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        if (newer !== 'Settings') {
          await page
            .getByRole('dialog', { name: 'Settings', exact: true })
            .getByRole('button', { name: newer, exact: true })
            .click();
          await expect(
            page.getByRole('dialog', { name: 'Settings', exact: true, includeHidden: true }),
          ).toHaveCount(0);
        }
        await expect(page.getByRole('dialog', { name: newer, exact: true })).toBeVisible();
        await page.evaluate(() => {
          window.newerDialogFocus = document.activeElement;
          document.activeElement.addEventListener('blur', () => {
            window.newerDialogBlurred = true;
          });
        });
      }
      await page.evaluate(() => window.releaseLinkDialog());
      await expect.poll(() => page.evaluate(() => window.linkDialogSettled)).toBe(true);
      const editor = page.getByRole('dialog', { name: 'Edit link', exact: true });
      if (newer !== 'none') {
        await expect(editor).toHaveCount(0);
        const dialog = page.getByRole('dialog', { name: newer, exact: true });
        await expect(dialog).toBeVisible();
        expect(
          await page.evaluate(
            () => document.activeElement === window.newerDialogFocus && !window.newerDialogBlurred,
          ),
        ).toBe(true);
        await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
        // Wait for the close handler to remove the dialog and restore focus before retrying.
        await expect(
          page.getByRole('dialog', { name: newer, exact: true, includeHidden: true }),
        ).toHaveCount(0);
        // A cancelled opening must release its lock so an explicit retry still works.
        await link.focus();
        await link.press('Enter');
      }
      await expect(editor).toBeVisible();
      await expect(editor.getByLabel('Page to link to', { exact: true })).toHaveValue('2');
      await expect(editor.getByLabel('Page to link to', { exact: true })).toBeFocused();
      await editor
        .getByLabel('Web address to link to', { exact: true })
        .fill('https://example.com/updated');
      await editor.getByRole('button', { name: 'Save link', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Link to example.com/updated', exact: true }),
      ).toBeVisible();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      const saved = await PDFDocument.load(await readFile(await (await download).path()));
      expect(listLinks(saved, 0)[0].url).toBe('https://example.com/updated');
      expect(listNotes(saved, 0).map((note) => note.text)).toEqual(
        pending === 'draft' ? ['Updated'] : [],
      );
    });
