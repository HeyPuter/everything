import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

const ribbon = (page, name) => page.locator('.ribbon-card').getByRole('button', { name, exact: true });

async function openParagraph(page) {
  await onTab(page, 'home');
  await ribbon(page, 'Paragraph Settings').click();
  return page.getByRole('dialog', { name: 'Paragraph' });
}

test('amounts off the arrow steps (Word’s 1.08 lines, 7.5 pt) are shown as Word shows them and do not block OK', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(ribbon(page, 'Bold')).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('First paragraph');
  // 1.08 is Word's default Normal spacing, line="259" (§17.3.1.33): 259/240 of a line, between the field's hundredths.
  let dialog = await openParagraph(page);
  await dialog.getByLabel('Line spacing', { exact: true }).selectOption('multiple');
  await dialog.getByLabel('Line spacing at').fill('1.08');
  await dialog.getByLabel('Spacing before (pt)').fill('7.5');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);

  dialog = await openParagraph(page);
  await expect(dialog.getByLabel('Line spacing at')).toHaveValue('1.08');
  await expect(dialog.getByLabel('Spacing before (pt)')).toHaveValue('7.5');
  // Another change in the same dialog applies, and the untouched amounts keep their exact values.
  await dialog.getByLabel('Alignment').selectOption('center');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  const format = await page.evaluate(() => {
    const f = window.__docs.current.view.engine.model.paragraphFormatting;
    return { alignment: f.alignment, lineRule: f.lineRule, lineSpacing: f.lineSpacing, spaceBefore: f.spaceBefore };
  });
  expect(format).toEqual({ alignment: 'center', lineRule: 'auto', lineSpacing: 259 / 240, spaceBefore: 7.5 });

  // A typed amount with more places than the arrows step by is taken too, as Word takes it.
  dialog = await openParagraph(page);
  await dialog.getByLabel('Line spacing at').fill('1.333');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  dialog = await openParagraph(page);
  await expect(dialog.getByLabel('Line spacing at')).toHaveValue('1.33');
  // A value out of range is still refused.
  await dialog.getByLabel('Line spacing at').fill('9');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
});
