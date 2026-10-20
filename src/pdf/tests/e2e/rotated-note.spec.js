import { test, expect } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

for (const rotation of [0, 90, 180, 270])
  test(`a note clicked onto a page turned ${rotation} degrees hangs from the click`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]).setRotation(degrees(rotation));
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'rotated-note.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await settled(page);
    await page.getByRole('button', { name: 'Note', exact: true }).click();
    const box = await page.locator('.drawing-overlay').boundingBox();
    const click = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
    await page.mouse.click(click.x, click.y);
    const text = page.getByRole('group', { name: 'New note' }).getByLabel('New note text');
    await text.fill('Here');
    await text.press('ControlOrMeta+Enter');
    await settled(page);
    // As on an upright page, the icon's top-left corner is where the page was clicked.
    const icon = await page
      .getByRole('button', { name: 'Edit note: Here', exact: true })
      .boundingBox();
    expect(icon.x).toBeCloseTo(click.x, -1);
    expect(icon.y).toBeCloseTo(click.y, -1);
  });
