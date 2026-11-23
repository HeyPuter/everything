import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Comparing files or processing a batch of them, like printing or exporting, only reads the
// PDF, yet while either ran the PDF counted as having unsaved changes: closing the tab asked to
// leave the site.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

/** Close the tab, in effect, the moment a dialog showing `text` opens; was leaving refused? */
const askOnLeaving = (page, text) =>
  page.evaluate((text) => {
    const observer = new MutationObserver(() => {
      const open = [...document.querySelectorAll('dialog[open]')].some((node) =>
        node.textContent.includes(text),
      );
      if (!open) return;
      observer.disconnect();
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      window.askedToLeave = event.defaultPrevented;
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, text);

async function pdfBytes(word, font) {
  const doc = await PDFDocument.create();
  const face = await doc.embedFont(font);
  for (let i = 0; i < 3; i++)
    doc
      .addPage([400, 500])
      .drawText(`${word} on page ${i + 1}`, { x: 40, y: 250, size: 30, font: face });
  return Buffer.from(await doc.save());
}

test('a comparison under way is no unsaved change', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const opened = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opened
  ).setFiles({
    name: 'old.pdf',
    mimeType: 'application/pdf',
    buffer: await pdfBytes('Alpha', StandardFonts.Helvetica),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Compare files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare files' });
  const chosen = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (
    await chosen
  ).setFiles({
    name: 'new.pdf',
    mimeType: 'application/pdf',
    buffer: await pdfBytes('Beta', StandardFonts.Courier),
  });
  await askOnLeaving(page, 'Reading both versions');
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.askedToLeave)).toBe(false);
  await expect(page.locator('.compare-docs')).toBeVisible();
});

test('a batch under way is no unsaved change', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const opened = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opened
  ).setFiles({
    name: 'old.pdf',
    mimeType: 'application/pdf',
    buffer: await pdfBytes('Alpha', StandardFonts.Helvetica),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Batch process', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Batch process' });
  await dialog.getByLabel('Rotation').selectOption('270');
  await askOnLeaving(page, 'Starting…');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.askedToLeave)).toBe(false);
  await pending;
});
