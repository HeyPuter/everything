// Text Edit Mode keys run through the Font keymap (rebindable) and typed characters insert text.
import { test, expect } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const body = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return a.doc.curves[a.activeObject.data].body as string;
  });

test('font edit keys: typing, word delete, selection, styles, line breaks', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.text_add');
    a.run('object.mode_set', { mode: 'EDIT' });
  });
  await hoverViewport(page);
  expect(await body(page)).toBe('Text');
  // Ctrl Backspace deletes the previous word, typing inserts
  await page.keyboard.press('Control+Backspace');
  expect(await body(page)).toBe('');
  await page.keyboard.type('Hello world');
  expect(await body(page)).toBe('Hello world');
  // Ctrl Left jumps a word, Shift End selects to the line end, Delete removes the selection
  await page.keyboard.press('Control+ArrowLeft');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Delete');
  expect(await body(page)).toBe('Hello ');
  // Enter breaks the line, Home goes to its start
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  await page.keyboard.press('Home');
  await page.keyboard.type('y');
  expect(await body(page)).toBe('Hello \nyx');
  // Ctrl A + Ctrl B makes everything bold
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+b');
  const bold = await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cu = a.doc.curves[a.activeObject.data];
    return (cu.body_format ?? []).every((f: { use_bold?: boolean; bold?: boolean }) => f.use_bold || f.bold);
  });
  expect(bold).toBe(true);
  // the keymap is a real keymap: a rebind takes effect
  await page.evaluate(async () => {
    const k = await import('/src/app/keymap.ts');
    const it = k.keymaps.Font.find((i: { op?: string; props?: Record<string, unknown> }) => i.op === 'font.line_break');
    it.key = 'F9';
  });
  await page.keyboard.press('End');
  await page.keyboard.press('F9');
  expect(await body(page)).toBe('Hello \nyx\n');
  await expectNoErrors(errors);
});
