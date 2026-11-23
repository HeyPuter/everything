import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// Enter saves a field's value, which redraws the page; the boxes were disabled meanwhile, so
// keys typed right after Enter were lost, a Tab did nothing, and the keys went to the page's
// shortcuts instead (H for the Hand tool).
test('keys typed while a field’s value is saved still go to the fields', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  doc.getForm().createTextField('A').addToPage(sheet, { x: 40, y: 300, width: 300, height: 24 });
  doc.getForm().createTextField('B').addToPage(sheet, { x: 40, y: 250, width: 300, height: 24 });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'form.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  const a = page.getByRole('textbox', { name: 'A (on page)' });
  const b = page.getByRole('textbox', { name: 'B (on page)' });
  await a.click();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('hv');
  await page.keyboard.press('Tab');
  await page.keyboard.type('two');
  await settled(page);
  await expect(a).toHaveValue('onehv');
  await expect(b).toHaveValue('two');
  await expect(b).toBeFocused();
  // Still the Select tool: the keys did not reach the shortcuts.
  await expect(page.locator('.form-layer')).toBeVisible();
  // Both are saved with the PDF.
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(saved.getForm().getTextField('A').getText()).toBe('onehv');
  expect(saved.getForm().getTextField('B').getText()).toBe('two');
});
