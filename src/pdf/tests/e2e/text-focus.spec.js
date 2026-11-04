import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

for (const action of ['keyboard', 'download', 'save', 'tool'])
  for (const moved of [false, true])
    for (const fails of [false, true])
      test(`text ${action} ${fails ? 'failure' : 'commit'} ${moved ? 'preserves newer focus' : 'restores expected focus'}`, async ({
        page,
      }) => {
        await page.route('https://js.puter.com/**', (route) =>
          route.fulfill({
            body: `window.puter = {
            env:'web', auth:{isSignedIn:()=>true,getUser:async()=>({username:'test-user'})},
            fs:{readdir:async()=>[],write:async(path,blob)=>{
              window.savedTextPdf = [...new Uint8Array(await blob.arrayBuffer())];
              return {path};
            }}, ui:{onLaunchedWithItems(){},onItemsOpened(){}}
          };`,
          }),
        );
        await page.goto('/#library');
        const doc = await PDFDocument.create();
        doc.addPage([400, 500]);
        const chooser = page.waitForEvent('filechooser');
        await page.keyboard.press('ControlOrMeta+o');
        await (
          await chooser
        ).setFiles({
          name: 'text-focus.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(await doc.save()),
        });
        await page.getByRole('button', { name: 'Text', exact: true }).click();
        await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
        const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
        await input.fill('Keep this draft');
        await page.evaluate(async (fails) => {
          const { blankPdf, validatePdf } = await import('/src/core/document.js');
          const prototype = Object.getPrototypeOf(await validatePdf(await blankPdf()));
          const save = prototype.save;
          prototype.save = async function (...args) {
            prototype.save = save;
            const bytes = await save.apply(this, args);
            await new Promise((resolve) => {
              window.releaseText = resolve;
            });
            if (fails) throw new Error('Delayed text save failed.');
            return bytes;
          };
        }, fails);
        const download = page.getByRole('button', { name: 'Download', exact: true });
        const save = page.getByRole('button', { name: /^Save(?: to Puter)?$/, exact: true });
        const pending = action === 'download' && !fails ? page.waitForEvent('download') : null;
        if (action === 'keyboard') await input.press('ControlOrMeta+Enter');
        else {
          const button =
            action === 'tool'
              ? page.getByRole('button', { name: 'Select', exact: true })
              : action === 'save'
                ? save
                : download;
          await button.focus();
          await button.press('Enter');
        }
        await expect.poll(() => page.evaluate(() => !!window.releaseText)).toBe(true);
        const settings = page.getByRole('button', { name: 'Settings', exact: true });
        if (moved) await settings.focus();
        await page.evaluate(() => window.releaseText());
        let bytes;
        if (pending) bytes = await readFile(await (await pending).path());
        if (action === 'save' && !fails) {
          await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
          bytes = new Uint8Array(await page.evaluate(() => window.savedTextPdf));
        }
        await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
        if (fails)
          await expect(page.locator('.text-edit-error')).toHaveText('Delayed text save failed.');
        else await expect(input).toHaveCount(0);
        await expect(
          moved
            ? settings
            : fails
              ? input
              : action === 'download'
                ? download
                : action === 'save'
                  ? save
                  : action === 'tool'
                    ? // The tool pressed keeps the focus, as it does with no draft open.
                      page.getByRole('button', { name: 'Select', exact: true })
                    : page.locator('.drawing-overlay'),
        ).toBeFocused();
        if (fails) {
          await expect(input).toHaveValue('Keep this draft');
          await input.press('ControlOrMeta+Enter');
          await expect(input).toHaveCount(0);
        }
        const target = page.getByRole('button', {
          name: 'Edit text: Keep this draft',
          exact: true,
        });
        await expect(target).toBeVisible();
        if (!bytes) {
          const output = page.waitForEvent('download');
          await download.click();
          bytes = await readFile(await (await output).path());
        }
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
        let text;
        try {
          const pdf = await task.promise;
          const content = await (await pdf.getPage(1)).getTextContent();
          text = content.items.map((item) => item.str).join('');
        } finally {
          await task.destroy();
        }
        expect(text).toBe('Keep this draft');
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(target).toHaveCount(0);
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(target).toBeVisible();
      });
