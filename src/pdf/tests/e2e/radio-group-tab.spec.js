import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// Each radio button was a Tab stop of its own, named apart, so screen readers read every one
// as "1 of 1"; a group is one stop, and its buttons are told apart with the arrow keys.
test('Tab stops at a radio group once, and arrow keys choose within it', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('Name').addToPage(sheet, { x: 40, y: 340, width: 200, height: 24 });
  const size = form.createRadioGroup('Size');
  for (const [value, x] of [
    ['Small', 40],
    ['Medium', 80],
    ['Large', 120],
  ])
    size.addOptionToPage(value, sheet, { x, y: 290, width: 16, height: 16 });
  form.createTextField('Email').addToPage(sheet, { x: 40, y: 240, width: 200, height: 24 });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'sizes.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  const name = page.getByRole('textbox', { name: 'Name (on page)' });
  const email = page.getByRole('textbox', { name: 'Email (on page)' });
  const radio = (label) => page.getByRole('radio', { name: `Size: ${label} (on page)` });
  await expect(radio('Small')).toBeVisible();
  // One group: the buttons share a name.
  const names = await page.getByRole('radio').evaluateAll((all) => all.map((r) => r.name));
  expect(new Set(names).size).toBe(1);
  await name.focus();
  await page.keyboard.press('Tab');
  await expect(radio('Small')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(radio('Medium')).toBeFocused();
  await expect(radio('Medium')).toBeChecked();
  await expect(radio('Small')).not.toBeChecked();
  await page.keyboard.press('Tab');
  await expect(email).toBeFocused();
  // Back into the group lands on the button that is on.
  await page.keyboard.press('Shift+Tab');
  await expect(radio('Medium')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(name).toBeFocused();
});
