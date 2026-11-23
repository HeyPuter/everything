import { test, expect } from '@playwright/test';
import { PDFDocument, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listLinks } from '../../src/core/links.js';

for (const kind of ['web', 'page'])
  for (const shared of [false, true])
    for (const moved of [false, true])
      test(`${shared ? 'shared' : 'ordinary'} ${kind} link edit ${moved ? 'preserves newer focus' : 'restores link focus'}`, async ({
        page,
      }) => {
        await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
        await page.goto('/#library');
        const doc = await PDFDocument.create();
        const first = doc.addPage([400, 500]);
        doc.addPage([400, 500]);
        const ref = doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [40, 335, 200, 360],
            Border: [0, 0, 0],
            ...(kind === 'web'
              ? { A: { S: 'URI', URI: PDFString.of('https://example.com/') } }
              : { Dest: [doc.getPage(1).ref, 'Fit'] }),
          }),
        );
        first.node.addAnnot(ref);
        if (shared) doc.getPage(1).node.addAnnot(ref);
        const chooser = page.waitForEvent('filechooser');
        await page.keyboard.press('ControlOrMeta+o');
        await (
          await chooser
        ).setFiles({
          name: 'link-focus.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(await doc.save()),
        });
        const original = page.getByRole('button', {
          name: kind === 'web' ? 'Link to example.com' : /^Link to (another page|page \d+)$/,
          exact: true,
        });
        await original.click();
        const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true });
        const address = dialog.getByRole('textbox', { name: 'Web address to link to' });
        await address.fill('https://example.org/updated');
        await page.evaluate(async () => {
          const { blankPdf, validatePdf } = await import('/src/core/document.js');
          const prototype = Object.getPrototypeOf(await validatePdf(await blankPdf()));
          const save = prototype.save;
          prototype.save = async function (...args) {
            prototype.save = save;
            const bytes = await save.apply(this, args);
            await new Promise((resolve) => {
              window.releaseLink = resolve;
            });
            return bytes;
          };
        });
        await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
        await expect.poll(() => page.evaluate(() => !!window.releaseLink)).toBe(true);
        const settings = page.getByRole('button', { name: 'Settings', exact: true });
        if (moved) await settings.focus();
        await page.evaluate(() => window.releaseLink());
        await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
        const edited = page.getByRole('button', {
          name: 'Link to example.org/updated',
          exact: true,
        });
        await expect(edited).toBeVisible();
        await expect(moved ? settings : edited).toBeFocused();
        // The replacement target remains keyboard-editable, including after a shared ID changes.
        if (moved) await edited.focus();
        await page.keyboard.press('Enter');
        await expect(address).toHaveValue('https://example.org/updated');
        await page.keyboard.press('Escape');
        await expect(edited).toBeFocused();
        const exportLinks = async () => {
          const pending = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Download', exact: true }).click();
          const saved = await PDFDocument.load(await readFile(await (await pending).path()));
          return [0, 1].map((index) => listLinks(saved, index).map((link) => link.url));
        };
        const previous = kind === 'web' ? 'https://example.com/' : null;
        const untouched = shared ? [previous] : [];
        expect(await exportLinks()).toEqual([['https://example.org/updated'], untouched]);
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(original).toBeVisible();
        expect(await exportLinks()).toEqual([[previous], untouched]);
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(edited).toBeVisible();
        expect(await exportLinks()).toEqual([['https://example.org/updated'], untouched]);
      });
