import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// On the smallest phones a dialog's two buttons no longer fit one row: Cancel hung at the right
// of a row of its own, over the main button. Buttons now fill the rows they take.
test.skip(({ isMobile }) => isMobile, 'sets its own phone width');

test('a dialog’s buttons fill the rows they take on a small phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'phone.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  for (const [submenu, item, title, action] of [
    ['Insert', 'Watermark…', 'Add watermark', 'Add watermark'],
    [null, 'Print…', 'Print', 'Print'],
  ]) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (submenu) await page.getByRole('menuitem', { name: submenu }).click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title });
    const box = (locator) => locator.evaluate((node) => node.getBoundingClientRect().toJSON());
    const [actions, cancel, main] = await Promise.all([
      box(dialog.locator('.dialog-actions')),
      box(dialog.getByRole('button', { name: 'Cancel', exact: true })),
      box(dialog.getByRole('button', { name: action, exact: true })),
    ]);
    // Each row of buttons reaches from one side of the dialog's actions to the other.
    const rows = cancel.top === main.top ? [[cancel, main]] : [[cancel], [main]];
    for (const row of rows) {
      expect(Math.abs(row[0].left - rows[0][0].left)).toBeLessThan(1);
      expect(Math.abs(row.at(-1).right - (actions.right - 22))).toBeLessThan(1);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
});
