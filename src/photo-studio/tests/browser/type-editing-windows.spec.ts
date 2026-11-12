import { expect, test } from '@playwright/test';
import { boot, canvasClick, openImage, tool } from './helpers';

// Text editing keys with Windows and Linux modifiers (Ctrl instead of Cmd/Option).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
  await tool(page, 'Horizontal Type Tool');
});

const text = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const m = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    const s = m.currentSession()!;
    const { plainText } = await import('/src/imaging/text/model.ts');
    return { text: plainText(s.data.content), focus: s.focus };
  });

test('Ctrl+Backspace and Ctrl+Delete delete one word', async ({ page }) => {
  await canvasClick(page, 100, 100);
  await page.keyboard.type('hello brave world');
  await page.keyboard.press('Control+Backspace');
  expect(await text(page)).toEqual({ text: 'hello brave ', focus: 12 });
  await page.keyboard.press('Home');
  await page.keyboard.press('Control+Delete');
  expect(await text(page)).toEqual({ text: ' brave ', focus: 0 });
});
