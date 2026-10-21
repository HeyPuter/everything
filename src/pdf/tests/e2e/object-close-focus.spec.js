import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectImages } from '../../src/core/image-edit.js';
import { inspectPaths } from '../../src/core/path-edit.js';

for (const kind of ['image', 'shape'])
  for (const pending of [false, true])
    for (const moved of pending ? [false, true] : [false])
      test(`closing a ${pending ? 'pending' : 'unchanged'} ${kind} ${moved ? 'preserves newer focus' : 'restores object focus'}`, async ({
        page,
      }) => {
        await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
        await page.goto('/#library');
        const doc = await PDFDocument.create();
        const sheet = doc.addPage([400, 500]);
        if (kind === 'image') {
          const image = await doc.embedPng(
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
              'base64',
            ),
          );
          sheet.drawImage(image, { x: 40, y: 220, width: 80, height: 60 });
        } else sheet.drawRectangle({ x: 40, y: 220, width: 80, height: 60 });
        const inspect = kind === 'image' ? inspectImages : inspectPaths;
        const buffer = Buffer.from(await doc.save());
        const initial = inspect(await PDFDocument.load(buffer), 0)[0].transform;
        const chooser = page.waitForEvent('filechooser');
        await page.keyboard.press('ControlOrMeta+o');
        await (
          await chooser
        ).setFiles({
          name: 'object-focus.pdf',
          mimeType: 'application/pdf',
          buffer,
        });
        const target = page.getByRole('button', { name: `Select ${kind} 1`, exact: true });
        await target.press('Enter');
        if (pending) {
          await page.getByRole('button', { name: `Move selected ${kind}`, exact: true }).focus();
          await page.keyboard.down('ArrowRight');
          // Let the preview finish serializing before holding the real PDF transaction.
          await expect(page.locator('.image-preview canvas')).toHaveCount(2);
          await page.evaluate(async () => {
            const { blankPdf, validatePdf } = await import('/src/core/document.js');
            const prototype = Object.getPrototypeOf(await validatePdf(await blankPdf()));
            const save = prototype.save;
            prototype.save = async function (...args) {
              prototype.save = save;
              const bytes = await save.apply(this, args);
              await new Promise((resolve) => {
                window.releaseObjectClose = resolve;
              });
              return bytes;
            };
          });
        }
        const close = page.getByRole('button', { name: `Close ${kind} editor`, exact: true });
        await close.focus();
        await close.press('Enter');
        const settings = page.getByRole('button', { name: 'Settings', exact: true });
        if (pending) {
          await page.keyboard.up('ArrowRight');
          await expect.poll(() => page.evaluate(() => !!window.releaseObjectClose)).toBe(true);
          await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'true');
          if (moved) await settings.focus();
          await page.evaluate(() => window.releaseObjectClose());
        }
        await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
        await expect(page.getByRole('group', { name: `Edit ${kind}`, exact: true })).toHaveCount(0);
        await expect(moved ? settings : target).toBeFocused();
        if (moved) await target.focus();
        await page.keyboard.press('Enter');
        const move = page.getByRole('button', { name: `Move selected ${kind}`, exact: true });
        await expect(move).toBeFocused();
        await move.press('Escape');
        await expect(target).toBeFocused();
        const verifyExport = async (expected) => {
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Download', exact: true }).click();
          const objects = inspect(
            await PDFDocument.load(await readFile(await (await download).path())),
            0,
          );
          expect(objects).toHaveLength(1);
          objects[0].transform.forEach((value, index) =>
            expect(value).toBeCloseTo(expected[index], 6),
          );
        };
        const edited = initial.map((value, index) => value + (pending && index === 4 ? 1 : 0));
        await verifyExport(edited);
        if (!pending)
          await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
        else {
          await page.getByRole('button', { name: 'Undo', exact: true }).click();
          await expect(target).toBeVisible();
          await verifyExport(initial);
          await page.getByRole('button', { name: 'Redo', exact: true }).click();
          await expect(target).toBeVisible();
          await verifyExport(edited);
        }
      });

for (const kind of ['image', 'shape'])
  for (const how of ['Delete key', 'Delete button'])
    test(`deleting a ${kind} with the ${how} keeps the keyboard focus on the page`, async ({
      page,
    }) => {
      await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
      await page.goto('/#library');
      const doc = await PDFDocument.create();
      const sheet = doc.addPage([400, 500]);
      if (kind === 'image') {
        const image = await doc.embedPng(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
            'base64',
          ),
        );
        sheet.drawImage(image, { x: 40, y: 220, width: 80, height: 60 });
      } else sheet.drawRectangle({ x: 40, y: 220, width: 80, height: 60 });
      const chooser = page.waitForEvent('filechooser');
      await page.keyboard.press('ControlOrMeta+o');
      await (
        await chooser
      ).setFiles({
        name: 'object-delete.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await doc.save()),
      });
      await page.getByRole('button', { name: `Select ${kind} 1`, exact: true }).press('Enter');
      if (how === 'Delete key')
        await page
          .getByRole('button', { name: `Move selected ${kind}`, exact: true })
          .press('Delete');
      else await page.getByRole('button', { name: `Delete ${kind}`, exact: true }).click();
      await expect(page.getByRole('button', { name: `Select ${kind} 1`, exact: true })).toHaveCount(
        0,
      );
      await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
      // The focus stays on the page, so the keyboard carries on there: Undo brings it back.
      await expect(page.locator('.drawing-overlay')).toBeFocused();
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.getByRole('button', { name: `Select ${kind} 1`, exact: true })).toHaveCount(
        1,
      );
    });
