import { test, expect } from '@playwright/test';
import { showAllTools } from './helpers/editor-tools.js';

// Chords from keyboards other than US QWERTY, as the browser reports them: `key` is what the layout
// types, `code` the physical key.
const MAC = process.platform === 'darwin';
const MOD = MAC ? { metaKey: true } : { ctrlKey: true };

async function newDocument(page, text) {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  return input;
}
/** Dispatch a keydown on the document; true when the editor took it (the browser would type nothing). */
const press = (input, init) => input.evaluate((el, init) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event.defaultPrevented;
}, init);
const selection = input => input.evaluate(el => [el.selectionStart, el.selectionEnd]);

test('letter chords follow the letter the layout types, not the QWERTY position', async ({ page }) => {
  const input = await newDocument(page, 'Alpha');
  await showAllTools(page);
  await input.press('End');
  await page.keyboard.type(' beta');
  // QWERTZ: Z is on the key where QWERTY has Y, and Y where it has Z.
  await press(input, { key: 'z', code: 'KeyY', ...MOD });
  await expect(input).toHaveValue('Alpha ');
  await press(input, { key: 'y', code: 'KeyZ', ...MOD });
  await expect(input).toHaveValue('Alpha beta');
  // AZERTY: A is on the key where QWERTY has Q, which is Clear Paragraph Formatting elsewhere.
  await input.press('Control+2');
  await expect(page.getByRole('combobox', { name: 'Line spacing' })).toHaveValue('2');
  await press(input, { key: 'a', code: 'KeyQ', ctrlKey: true });
  expect(await selection(input)).toEqual([0, 10]);
  await expect(page.getByRole('combobox', { name: 'Line spacing' })).toHaveValue('2');
  // Dvorak types an apostrophe where QWERTY has Q: no chord at all.
  await input.press('End');
  expect(await press(input, { key: "'", code: 'KeyQ', ctrlKey: true })).toBe(false);
  await expect(page.getByRole('combobox', { name: 'Line spacing' })).toHaveValue('2');
  // Another script keeps the physical key: Cyrillic types ф on the A key.
  await press(input, { key: 'ф', code: 'KeyA', ...MOD });
  expect(await selection(input)).toEqual([0, 10]);
});

/** Run the page as on another platform: the editor reads navigator.platform once, at load. */
const platform = (page, name) => page.addInitScript(name => Object.defineProperty(Navigator.prototype, 'platform', { get: () => name }), name);
const chords = (input, list) => input.evaluate((el, list) => list.map(init => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return `${init.key}:${event.defaultPrevented}`;
}), list);

test('AltGr characters type instead of running Ctrl+Alt shortcuts', async ({ page }) => {
  await platform(page, 'Win32');
  const input = await newDocument(page, 'Title');
  await showAllTools(page);
  await input.press('Control+Alt+1');
  const style = page.getByRole('combobox', { name: 'Paragraph style' });
  await expect(style).toHaveValue('Heading1');
  // Windows reports AltGr as Ctrl+Alt: Polish ó ż ń ś, French @ (AltGr+0), German { (AltGr+7), Hungarian @ (AltGr+V).
  const altGr = (key, code, extra = {}) => ({ key, code, ctrlKey: true, altKey: true, ...extra });
  expect(await chords(input, [altGr('ó', 'KeyO'), altGr('ż', 'KeyZ'), altGr('ń', 'KeyN'), altGr('Ś', 'KeyS', { shiftKey: true }),
    altGr('@', 'Digit0'), altGr('{', 'Digit7'), altGr('@', 'KeyV'), altGr('[', 'KeyF'), altGr('µ', 'KeyM')]))
    .toEqual(['ó:false', 'ż:false', 'ń:false', 'Ś:false', '@:false', '{:false', '@:false', '[:false', 'µ:false']);
  await expect(style).toHaveValue('Heading1');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The same chords on a layout without AltGr are still shortcuts.
  expect(await chords(input, [altGr('0', 'Digit0')])).toEqual(['0:true']);
  await expect(style).toHaveValue('Normal');
});

test('Option characters type instead of running Option shortcuts on a Mac', async ({ page }) => {
  await platform(page, 'MacIntel');
  const input = await newDocument(page, 'Dated');
  await input.press('End');
  // Option+Shift+D, T and P type Î, ˇ and ∏ on a Mac; elsewhere Alt+Shift+D inserts the date.
  expect(await chords(input, [{ key: 'Î', code: 'KeyD', altKey: true, shiftKey: true }, { key: 'ˇ', code: 'KeyT', altKey: true, shiftKey: true },
    { key: '∏', code: 'KeyP', altKey: true, shiftKey: true }])).toEqual(['Î:false', 'ˇ:false', '∏:false']);
  await expect(input).toHaveValue('Dated');
});

test('Alt+Shift+D still inserts the date where Alt types no character', async ({ page }) => {
  await platform(page, 'Win32');
  const input = await newDocument(page, 'Dated');
  await input.press('End');
  expect(await chords(input, [{ key: 'D', code: 'KeyD', altKey: true, shiftKey: true }])).toEqual(['D:true']);
  await expect.poll(() => input.inputValue()).not.toBe('Dated');
});
