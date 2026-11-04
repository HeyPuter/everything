import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// Below 1001 pixels the tools pane lies over the page, and below 761 the side panel does too,
// so both start closed there. A window narrowed past those widths while the PDF is open (a
// tablet turned upright, a window snapped to half the screen) closes them the same way,
// rather than leaving the page buried under both.
test('narrowing the window closes the panels that would cover the page', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'a desktop window');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'one.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const tools = page.getByRole('complementary', { name: 'Tools' });
  const pages = page.getByRole('complementary', { name: 'Pages panel' });
  await expect(tools).toBeVisible();
  await expect(pages).toBeVisible();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(tools).toBeHidden();
  // Still docked beside the page at this width, the side panel stays.
  await expect(pages).toBeVisible();
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(pages).toBeHidden();
  await expect(page.getByRole('button', { name: 'Toggle pages panel' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  // Either can be opened again over the page.
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(tools).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(tools).toBeVisible();
});
