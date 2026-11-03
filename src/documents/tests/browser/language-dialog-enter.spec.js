import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });

async function openEditor(page) {
  await page.goto('/mock.html#/new');
  await expect(page.locator('.ribbon-card').getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Bonjour tout le monde');
  await text(page).press('ControlOrMeta+a');
}

/** Arrow from the chosen language to the next one and press Enter there, as in a list in Word's dialog. */
async function enterOnNextLanguage(page, dialog) {
  await dialog.getByRole('option', { selected: true }).focus();
  await page.keyboard.press('ArrowDown');
  const chosen = dialog.getByRole('option', { selected: true });
  await expect(chosen).toBeFocused();
  const tag = await chosen.getAttribute('data-tag');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  return tag;
}

test('Enter on a language in the status bar’s Language dialog marks the text with it', async ({ page }) => {
  await openEditor(page);
  await page.locator('.ed-status-language').click();
  const tag = await enterOnNextLanguage(page, page.getByRole('dialog', { name: 'Language' }));
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.runFormatting?.fontLanguage)).toBe(tag);
});

test('Enter on a language in Set Proofing Language marks the text with it', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => document.querySelector('.ed-search-input').focus());
  await page.keyboard.type('Set Proofing Language');
  await page.keyboard.press('Enter');
  const tag = await enterOnNextLanguage(page, page.getByRole('dialog', { name: 'Language' }));
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.runFormatting?.fontLanguage)).toBe(tag);
});
