import { test, expect } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// The tools pane and its Prepare a form tool are the desktop workspace.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

for (const rotation of [0, 90, 270])
  test(`links and form fields placed at the page center read across a page turned ${rotation} degrees`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).setRotation(degrees(rotation));
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'rotated-center.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await settled(page);
    const overlay = await page.locator('.drawing-overlay').boundingBox();
    const unit = Math.max(overlay.width, overlay.height) / 792;
    const center = { x: overlay.x + overlay.width / 2, y: overlay.y + overlay.height / 2 };
    const expectCentered = (box, width, height) => {
      expect(box.width / unit).toBeCloseTo(width, -1);
      expect(box.height / unit).toBeCloseTo(height, -1);
      expect(box.x + box.width / 2).toBeCloseTo(center.x, -1);
      expect(box.y + box.height / 2).toBeCloseTo(center.y, -1);
    };

    const bar = page.getByRole('menubar', { name: 'PDF menus' });
    await bar.getByRole('menuitem', { name: 'Insert', exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Link…', exact: true }).click();
    await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add link' });
    await dialog.getByRole('textbox', { name: 'Web address to link to' }).fill('example.org');
    await dialog.getByRole('button', { name: 'Add link', exact: true }).click();
    await settled(page);
    expectCentered(
      await page.getByRole('button', { name: 'Link to example.org', exact: true }).boundingBox(),
      160,
      28,
    );

    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Tools' });
    await pane.getByRole('button', { name: 'Prepare a form', exact: true }).click();
    await pane.getByRole('button', { name: 'Text field', exact: true }).click();
    await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
    const properties = page.getByRole('dialog', { name: 'Text field properties' });
    await expect(properties).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(properties).toBeHidden();
    await settled(page);
    expectCentered(await page.locator('.designer-field').first().boundingBox(), 160, 22);
  });
