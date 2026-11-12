import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, openImage, tool } from './helpers';

// Editing with a soft keyboard (Android): keys arrive as keyCode 229 and the
// edit is described only by the input events, on an empty hidden input.
test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
  await tool(page, 'Horizontal Type Tool');
});

async function state(page: Page) {
  return page.evaluate(async () => {
    const m = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    const s = m.currentSession()!;
    const { plainText } = await import('/src/imaging/text/model.ts');
    return { text: plainText(s.data.content), focus: s.focus };
  });
}
// One soft-keyboard key: keydown 229, beforeinput, input (no native change), keyup.
const softKey = (page: Page, inputType: string, data: string | null = null) =>
  page.evaluate(
    ([inputType, data]) => {
      const el = document.querySelector<HTMLTextAreaElement>('.type-input')!;
      const key = (type: string) => el.dispatchEvent(new KeyboardEvent(type, { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
      key('keydown');
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: inputType!, data, bubbles: true, cancelable: true }));
      el.dispatchEvent(new InputEvent('input', { inputType: inputType!, data, bubbles: true }));
      key('keyup');
    },
    [inputType, data] as const,
  );

test('Backspace, letters and Enter from a soft keyboard edit the text', async ({ page }) => {
  await canvasClick(page, 100, 100);
  await page.keyboard.type('hello world');
  await softKey(page, 'deleteContentBackward');
  expect(await state(page)).toEqual({ text: 'hello worl', focus: 10 });
  await softKey(page, 'insertText', 'd!');
  await softKey(page, 'insertParagraph');
  await softKey(page, 'insertText', 'x');
  expect(await state(page)).toEqual({ text: 'hello world!\nx', focus: 14 });
  await softKey(page, 'deleteContentBackward');
  await softKey(page, 'deleteContentBackward');
  await softKey(page, 'deleteWordBackward');
  expect(await state(page)).toEqual({ text: 'hello ', focus: 6 });
  // Undo steps follow the same grouping as a hardware keyboard: the run of deletions is one.
  await page.keyboard.press('Meta+z');
  expect((await state(page)).text).toBe('hello world!\nx');
});

test('soft-keyboard composition still types one word as one undo step', async ({ page }) => {
  await canvasClick(page, 100, 100);
  await page.keyboard.type('a ');
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('.type-input')!;
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const d of ['w', 'wo', 'wor']) {
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: d, isComposing: true, bubbles: true }));
      el.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: d, isComposing: true, bubbles: true }));
    }
    el.dispatchEvent(new CompositionEvent('compositionend', { data: 'word', bubbles: true }));
  });
  expect((await state(page)).text).toBe('a word');
  await page.keyboard.press('Meta+z');
  expect((await state(page)).text).toBe('a ');
});
