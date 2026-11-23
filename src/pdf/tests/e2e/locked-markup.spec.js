import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { addReply, listAnnotations } from '../../src/core/annotations.js';
import { addHighlight, rectQuad } from '../../src/core/highlight.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// A locked or read-only markup takes no change, but its words and its thread were shown
// nowhere: it could not be chosen on the page at all, as a locked note or shape can.
for (const [label, flags] of [
  ['locked', 4 | 128],
  ['read-only', 4 | 64],
])
  test(`a ${label} highlight opens to be read, without its edit controls`, async ({ page }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    addHighlight(doc, 0, {
      quads: [rectQuad({ x: 40, y: 294, width: 120, height: 20 })],
      text: 'Check this figure',
      author: 'Ada',
    });
    const [mark] = listAnnotations(doc, 0);
    addReply(doc, 0, mark.id, { text: 'It is right', author: 'Grace' });
    doc.getPage(0).node.Annots().lookup(0).set(PDFName.of('F'), doc.context.obj(flags));
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'locked.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await settled(page);
    const target = page.getByRole('button', { name: 'Read highlight: Check this figure' });
    await target.click();
    const props = page.getByRole('complementary', { name: 'Selection properties' });
    await expect(props.getByText('Check this figure')).toBeVisible();
    await expect(props.getByRole('list', { name: 'Replies' })).toContainText('It is right');
    await expect(props.getByLabel('Highlight color', { exact: true })).toHaveCount(0);
    await expect(props.getByRole('button', { name: 'Delete highlight' })).toHaveCount(0);
    // The Delete key leaves it too.
    await target.focus();
    await page.keyboard.press('Delete');
    await settled(page);
    await expect(target).toHaveCount(1);
    await expect(page.locator('#toast')).toBeHidden();
  });
