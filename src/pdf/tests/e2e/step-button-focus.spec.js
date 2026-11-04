import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// Pressed from the keyboard to the end of its range, a page or zoom button used to be disabled
// under the focus, which then fell to the page body.
async function openPages(page, count) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([300, 300]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'steps.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption').first()).toHaveText(`Page 1 of ${count}`);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

test('page buttons keep the focus at the first and last pages', async ({ page }) => {
  await openPages(page, 3);
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  const previous = page.getByRole('button', { name: 'Previous page', exact: true });
  const pageField = page.locator('.page-navigation input');
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(pageField).toHaveValue('2');
  await page.keyboard.press('Enter');
  await expect(pageField).toHaveValue('3');
  await expect(next).toBeDisabled();
  await expect(next).toBeFocused();
  // Pressing it again does nothing.
  await page.keyboard.press('Enter');
  await expect(pageField).toHaveValue('3');
  await expect(next).toBeFocused();
  // Once the focus moves on, the button is left out of the keyboard order as before.
  await page.keyboard.press('Shift+Tab');
  await expect(next).toHaveAttribute('disabled', '');
  await expect(next).not.toHaveAttribute('aria-disabled', /./);

  await previous.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(pageField).toHaveValue('1');
  await expect(previous).toBeDisabled();
  await expect(previous).toBeFocused();
  // Moving away from the end makes it an ordinary button again.
  await page.keyboard.press('Alt+ArrowRight');
  await expect(pageField).toHaveValue('2');
  await expect(previous).toBeEnabled();
  await expect(previous).not.toHaveAttribute('aria-disabled', /./);
  await expect(previous).toBeFocused();
});

test('zoom buttons keep the focus at the largest and smallest zoom', async ({ page }) => {
  await openPages(page, 1);
  const zoom = page.getByLabel('Zoom', { exact: true });
  for (const [name, end] of [
    ['Zoom in', '4'],
    ['Zoom out', '0.25'],
  ]) {
    const button = page.getByRole('button', { name, exact: true });
    await button.focus();
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Enter');
      if ((await zoom.inputValue()) === end) break;
    }
    await expect(zoom).toHaveValue(end);
    await expect(button).toBeDisabled();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(zoom).toHaveValue(end);
    await expect(button).toBeFocused();
  }
});
