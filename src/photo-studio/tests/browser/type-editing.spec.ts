import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, openImage, tool } from './helpers';

// On-canvas text editing with the Horizontal Type tool.
test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
  await tool(page, 'Horizontal Type Tool');
});

async function caret(page: Page) {
  return page.evaluate(async () => {
    // The editor's own module instance (a direct import can be a second copy after hot updates).
    const m = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    const s = m.currentSession()!;
    const { plainText } = await import('/src/imaging/text/model.ts');
    return { text: plainText(s.data.content), anchor: s.anchor, focus: s.focus, x: m.sessionLayout(window.photoStudio)!.caretRect(s.focus).x };
  });
}

test('arrow keys move the caret on screen through right-to-left text', async ({ page }) => {
  await canvasClick(page, 100, 100);
  await page.keyboard.insertText('שלום');
  // The caret ends after the last letter, at the word's left end.
  const end = await caret(page);
  expect(end.focus).toBe(4);
  await page.keyboard.press('ArrowRight');
  const right = await caret(page);
  expect(right.focus).toBe(3);
  expect(right.x).toBeGreaterThan(end.x);
  await page.keyboard.press('ArrowLeft');
  expect((await caret(page)).focus).toBe(4);
  // Shift+Right selects the last letter; Left collapses to the selection's left end.
  await page.keyboard.press('Shift+ArrowRight');
  expect(await caret(page)).toMatchObject({ anchor: 4, focus: 3 });
  await page.keyboard.press('ArrowLeft');
  expect(await caret(page)).toMatchObject({ anchor: 4, focus: 4 });
});
