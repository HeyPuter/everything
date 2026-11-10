import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
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

test('the accessibility report scrolls within its panel', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 500]).drawText('Results', { x: 40, y: 440, size: 18, font });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'plain.pdf',
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
  const last = report.locator('summary').last();
  await expect(last).toHaveText(/Headings/);
  // The report is longer than the window. Its last rows were out of reach of the wheel, and
  // moving the focus to them scrolled the whole editor up, menus and all, out of the window.
  const box = await report.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => report.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await last.focus();
  await expect(last).toBeInViewport();
  expect(await page.locator('.editor').evaluate((node) => node.scrollTop)).toBe(0);
  await expect(page.getByRole('button', { name: 'Tools', exact: true })).toBeInViewport();
});

test('the language fix starts from the language the PDF declares', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  doc.catalog.set(PDFName.of('Lang'), PDFString.of('fr-CA'));
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'french.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Prepare for accessibility', exact: true }).click();
  await pane.getByRole('button', { name: 'Set the document language…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Document language' });
  // It offered the device's language instead, so OK would have replaced French with it.
  await expect(dialog.getByRole('textbox')).toHaveValue('fr-CA');
});

test('a fix with nothing left to do says so', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'plain.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Prepare for accessibility', exact: true }).click();
  await pane.getByRole('button', { name: 'Set tab order' }).click();
  await expect(page.locator('#toast')).toHaveText('Tab order follows the document structure.');
  await settled(page);
  await page.locator('#toast').evaluate((node) => (node.textContent = ''));
  // Chosen again, it changed nothing and said nothing.
  await pane.getByRole('button', { name: 'Set tab order' }).click();
  await expect(page.locator('#toast')).toHaveText(
    'The tab order already follows the document structure.',
  );
});

test('the focus stays in the accessibility report after a fix', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 500]).drawText('Results', { x: 40, y: 440, size: 18, font });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'plain.pdf',
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
  // The Fix button is disabled while it works and the report drawn again, which dropped the
  // focus on the page; the next Tab started again from the top.
  await report.getByRole('button', { name: 'Autotag document: Tagged PDF' }).focus();
  await page.keyboard.press('Enter');
  await settled(page);
  await expect(report.locator('.a11y-rule', { hasText: 'Tagged PDF' }).first()).toHaveClass(
    /is-passed/,
  );
  await expect(report.locator('summary', { hasText: 'Document' })).toBeFocused();
  // A fix that asks first hands the focus back to the report too.
  await report.getByRole('button', { name: 'Set title: Title' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Document title' });
  await dialog.getByRole('textbox').fill('Results');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(report.locator('.a11y-rule', { hasText: 'Title' }).first()).toHaveClass(/is-passed/);
  await expect(report.locator('summary', { hasText: 'Document' })).toBeFocused();
});

test('the title fix starts from the title Document details shows', async ({ page }) => {
  const { setTitle } = await import('../../src/core/accessibility.js');
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  setTitle(doc, 'Annual report 2026');
  // Another editor left an outdated title in the Info dictionary; the XMP metadata, which
  // carries no older date, is the one readers take.
  doc.getInfoDict().set(PDFName.of('Title'), PDFString.of('Draft'));
  doc.getInfoDict().delete(PDFName.of('ModDate'));
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'report.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save({ updateFieldAppearances: false })),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Prepare for accessibility', exact: true }).click();
  await pane.getByRole('button', { name: 'Set the document title…' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Document title' }).getByRole('textbox'),
  ).toHaveValue('Annual report 2026');
});
