import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });

test('Copy from the menus writes the same text as the keyboard, without placeholder characters', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await input(page).fill('Before after');
    // A picture between the words: the document holds it as one placeholder character.
    await page.evaluate(async () => {
      const e = window.__docs.current.view.engine; e.model.select(7); e.syncInput();
      const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4; canvas.getContext('2d').fillRect(0, 0, 4, 4);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      await e.insertImageFile(new File([blob], 'dot.png', { type: 'image/png' }));
    });
    const selectAll = () => page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(0, e.model.text.length); e.syncInput(); e.onSelection(); });
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await selectAll();
    await input(page).press('ControlOrMeta+c');
    const keyboard = await clipboard();
    expect(keyboard).toBe('Before [Image]after');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.locator('canvas.canvas-page').first().click({ button: 'right', position: { x: 150, y: 110 } });
    await selectAll();
    await page.getByRole('menu', { name: 'Document menu' }).getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await expect.poll(clipboard).toBe(keyboard);
  } finally { await context.close(); }
});
