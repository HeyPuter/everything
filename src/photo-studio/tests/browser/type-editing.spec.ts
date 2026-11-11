import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, openImage, tool } from './helpers';

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

test('an IME composition is one undo step and ends the redo history', async ({ page }) => {
  await canvasClick(page, 100, 100);
  await page.keyboard.type('ab cd');
  // Undo the last word, then compose over a selection of "ab".
  await page.keyboard.press('Meta+z');
  expect((await caret(page)).text).toBe('ab ');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '日本' });
  await expect.poll(async () => (await caret(page)).text).toBe('日本 ');
  // Redo has nothing left to bring back: the composition replaced it.
  await page.keyboard.press('Meta+Shift+z');
  expect((await caret(page)).text).toBe('日本 ');
  // One undo restores the selected "ab".
  await page.keyboard.press('Meta+z');
  expect(await caret(page)).toMatchObject({ text: 'ab ', anchor: 0, focus: 2 });
});

test('each paste is its own undo step', async ({ page }) => {
  await canvasClick(page, 100, 100);
  await page.keyboard.type('ab');
  const paste = (text: string) =>
    page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      document.querySelector('.type-input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
  await paste('cd');
  await paste('ef');
  expect((await caret(page)).text).toBe('abcdef');
  await page.keyboard.press('Meta+z');
  expect((await caret(page)).text).toBe('abcd');
  await page.keyboard.press('Meta+z');
  expect((await caret(page)).text).toBe('ab');
});

test('moving text with Mod-drag while editing is undoable and kept on commit', async ({ page }) => {
  await canvasClick(page, 100, 100);
  await page.keyboard.type('Move');
  await page.keyboard.press('Escape');
  await idle(page);
  const place = () => page.evaluate(() => [Math.round(window.photoStudio.layer!.transform.x), Math.round(window.photoStudio.layer!.transform.y)]);
  const [x0, y0] = await place();
  // Edit the text again, then drag it by (60, 50) without changing it.
  await canvasClick(page, x0 + 8, y0 + 12);
  await canvasDrag(page, [[x0 + 8, y0 + 12], [x0 + 68, y0 + 62]], 6, ['ControlOrMeta']);
  expect(await place()).toEqual([x0 + 60, y0 + 50]);
  await page.keyboard.press('Meta+z');
  expect(await place()).toEqual([x0, y0]);
  await page.keyboard.press('Meta+Shift+z');
  expect(await place()).toEqual([x0 + 60, y0 + 50]);
  await page.keyboard.press('Escape');
  await idle(page);
  expect(await place()).toEqual([x0 + 60, y0 + 50]);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(['Type Tool', 'Edit Type Layer']);
});
