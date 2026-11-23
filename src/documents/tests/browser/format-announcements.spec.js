import { test, expect } from '@playwright/test';
import { showAllTools } from './helpers/editor-tools.js';

// The document's text field shows its text, not its formatting: a screen reader heard nothing when a key made it bold.
const spoken = page => page.locator('.toast-root .visually-hidden');

test('screen readers hear what a formatting key did, once per press', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Hello world'); await input.press('ControlOrMeta+a');
  await input.press('ControlOrMeta+b'); await expect(spoken(page)).toHaveText(['Bold on']);
  await input.press('ControlOrMeta+b'); await expect(spoken(page)).toHaveText(['Bold off']);
  await input.press('ControlOrMeta+e'); await expect(spoken(page)).toHaveText(['Centered']);
  await input.press('ControlOrMeta+Shift+x'); await expect(spoken(page)).toHaveText(['Strikethrough on']);
  await input.press('ControlOrMeta+Alt+1'); await expect(spoken(page)).toHaveText(['Heading 1']);
  // Undo and caret moves are not formatting keys.
  await input.press('ControlOrMeta+z'); await input.press('ControlOrMeta+ArrowLeft'); await page.waitForTimeout(100);
  await expect(spoken(page)).toHaveText(['Heading 1']);
});
