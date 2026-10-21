import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('the accessibility report updates after alternate text is saved', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const canvas = createCanvas(200, 120);
  canvas.getContext('2d').fillStyle = '#3366cc';
  canvas.getContext('2d').fillRect(0, 0, 200, 120);
  const picture = await doc.embedPng(await canvas.encode('png'));
  const sheet = doc.addPage([400, 500]);
  sheet.drawText('A chart of the results', { x: 40, y: 440, size: 18, font });
  sheet.drawImage(picture, { x: 40, y: 200, width: 200, height: 120 });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'chart.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Prepare for accessibility', exact: true }).click();
  await pane.getByRole('button', { name: 'Accessibility check', exact: true }).click();
  const report = page.getByRole('tabpanel', { name: 'Accessibility check' });
  await pane.getByRole('button', { name: 'Autotag document', exact: true }).click();
  await settled(page);
  const fix = report.getByRole('button', { name: 'Set alternate text: Figures alternate text' });
  await expect(fix).toBeVisible();

  await fix.click();
  const dialog = page.getByRole('dialog', { name: 'Alternate text' });
  await dialog.getByLabel('Figure 1 on page 1').fill('A blue box');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(fix).toHaveCount(0);
  await expect(report.locator('.a11y-rule', { hasText: 'Figures alternate text' })).toHaveClass(
    /is-passed/,
  );
});
