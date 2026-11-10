import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import { inspectImages } from '../../src/core/image-edit.js';
import { inspectPaths } from '../../src/core/path-edit.js';

function imageFile() {
  const canvas = createCanvas(80, 40);
  const context = canvas.getContext('2d');
  context.strokeStyle = '#123456';
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(5, 30);
  context.lineTo(30, 10);
  context.lineTo(75, 25);
  context.stroke();
  return { name: 'signature.png', mimeType: 'image/png', buffer: canvas.toBuffer('image/png') };
}

for (const kind of ['image', 'typed signature', 'drawn signature', 'uploaded signature', 'stamp'])
  for (const moved of [false, true])
    test(`${kind} insertion ${moved ? 'preserves newer focus' : 'focuses the new object'}`, async ({
      page,
    }) => {
      await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
      await page.goto('/#library');
      const doc = await PDFDocument.create();
      doc.addPage([400, 500]);
      const chooser = page.waitForEvent('filechooser');
      await page.keyboard.press('ControlOrMeta+o');
      await (
        await chooser
      ).setFiles({
        name: 'insert-focus.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await doc.save()),
      });
      await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
      if (kind.includes('signature')) {
        await page.getByRole('button', { name: 'Sign', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Add signature', exact: true });
        if (kind === 'typed signature') {
          await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
          await dialog.getByLabel('Signature text', { exact: true }).fill('Ada');
        } else if (kind === 'uploaded signature') {
          await dialog.getByRole('tab', { name: 'Upload', exact: true }).click();
          await dialog
            .getByLabel('Signature image file', { exact: true })
            .setInputFiles(imageFile());
          await expect(dialog.getByLabel('Uploaded signature preview')).toBeVisible();
        } else {
          const box = await dialog.locator('.signature-pad').boundingBox();
          await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 3 });
          await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 3 });
          await page.mouse.up();
        }
      } else if (kind === 'stamp') {
        const bar = page.getByRole('menubar', { name: 'PDF menus' });
        if (await bar.isVisible())
          await bar.getByRole('menuitem', { name: 'Insert', exact: true }).click();
        else {
          await page.getByRole('button', { name: 'Menu', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Insert', exact: true }).click();
        }
        await page.getByRole('menuitem', { name: 'Stamp…', exact: true }).click();
        await page
          .getByRole('dialog', { name: 'Add stamp' })
          .getByLabel('Text', { exact: true })
          .fill('APPROVED');
      }
      await page.evaluate(async () => {
        const { blankPdf, validatePdf } = await import('/src/core/document.js');
        const prototype = Object.getPrototypeOf(await validatePdf(await blankPdf()));
        const save = prototype.save;
        prototype.save = async function (...args) {
          prototype.save = save;
          const bytes = await save.apply(this, args);
          await new Promise((resolve) => {
            window.releaseInsert = resolve;
          });
          return bytes;
        };
      });
      if (kind === 'image') {
        const file = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Image', exact: true }).click();
        await (await file).setFiles(imageFile());
      } else
        await page
          .getByRole('button', {
            name: `Place ${kind === 'stamp' ? 'stamp' : 'signature'}`,
            exact: true,
          })
          .click();
      await expect.poll(() => page.evaluate(() => !!window.releaseInsert)).toBe(true);
      await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'true');
      const settings = page.getByRole('button', { name: 'Settings', exact: true });
      if (moved) {
        await settings.focus();
        await settings.evaluate((button) => {
          window.newerFocusLost = false;
          button.addEventListener(
            'blur',
            () => {
              window.newerFocusLost = true;
            },
            { once: true },
          );
        });
      }
      await page.evaluate(() => window.releaseInsert());
      await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
      const objectKind =
        kind === 'image' || kind === 'uploaded signature'
          ? 'image'
          : kind.includes('signature')
            ? 'signature'
            : 'stamp';
      const control = page.getByRole('button', {
        name: `Move selected ${objectKind}`,
        exact: true,
      });
      const target = page.getByRole('button', { name: `Select ${objectKind} 1`, exact: true });
      await expect(control).toBeVisible();
      await expect(target).toHaveAttribute('aria-pressed', 'true');
      await expect(moved ? settings : control).toBeFocused();
      if (moved) expect(await page.evaluate(() => window.newerFocusLost)).toBe(false);
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      const saved = await PDFDocument.load(await readFile(await (await pending).path()));
      const inspect = objectKind === 'image' ? inspectImages : inspectPaths;
      expect(inspect(saved, 0)).toHaveLength(1);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(target).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect(target).toBeVisible();
      await target.press('Enter');
      await expect(control).toBeFocused();
    });
