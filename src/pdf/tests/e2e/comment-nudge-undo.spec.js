import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// A comment's arrow-key move is saved once the keys rest. An Undo press that outlasted that
// rest saw the save start mid-click and turn Undo off, so the click was lost.
for (const way of ['button', 'slow button'])
  test(`Undo from the ${way} right after a comment's arrow key move undoes it`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]);
    addShapeAnnotation(doc, 0, {
      kind: 'square',
      rect: { x: 100, y: 300, width: 80, height: 60 },
    });
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'comment-nudge-undo.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await settled(page);
    const target = page.getByRole('button', { name: 'Rectangle', exact: true });
    await target.click();
    await expect(target).toBeFocused();
    // An earlier move puts Undo on, as any earlier edit would.
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
    await settled(page);
    await expect(target).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    if (way === 'button') await undo.click();
    else {
      // The press outlasts the keys' rest. A save started then would turn Undo off before the
      // release (a large document's save takes that long, so it is held here until released).
      await page.evaluate(async () => {
        const { blankPdf, validatePdf } = await import('/src/core/document.js');
        const prototype = Object.getPrototypeOf(await validatePdf(await blankPdf()));
        const save = prototype.save;
        prototype.save = async function (...args) {
          prototype.save = save;
          const bytes = await save.apply(this, args);
          await new Promise((resolve) => {
            window.releaseSave = resolve;
          });
          return bytes;
        };
      });
      const box = await undo.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(400);
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => !!window.releaseSave)).toBe(true);
      await page.evaluate(() => window.releaseSave());
    }
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    await expect(redo).toBeEnabled();
    await settled(page);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await pending).path()));
    const [rectangle] = listAnnotations(saved, 0).filter((entry) => entry.subtype === 'Square');
    expect(rectangle.box.x).toBeCloseTo(100, 3);
    expect(rectangle.box.y).toBeGreaterThan(300);
  });
