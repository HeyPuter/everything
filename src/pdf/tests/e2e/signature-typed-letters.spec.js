import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// The script font writes Latin and Cyrillic. Other letters showed in the browser's own font in
// the preview, as if they would be placed, and were refused only on Place signature.
test('a typed signature names a letter its font lacks while it is typed', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'sign.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  if (await bar.isVisible())
    await bar.getByRole('menuitem', { name: 'Insert', exact: true }).click();
  else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Insert', exact: true }).click();
  }
  await page.getByRole('menu').getByRole('menuitem', { name: 'Signature…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await dialog.getByRole('tab', { name: 'Type' }).click();
  const name = dialog.getByLabel('Signature text');
  await name.fill('Ἀλέξανδρος');
  await expect(name).toHaveAccessibleDescription(
    'The signature font has no "Ἀ". Try Latin or Cyrillic letters.',
  );
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await name.fill('Иван Петров');
  await expect(name).toHaveAccessibleDescription('');
  await expect(name).not.toHaveAttribute('aria-invalid');
  await dialog.getByRole('button', { name: 'Place signature' }).click();
  await expect(dialog).toBeHidden();
});
