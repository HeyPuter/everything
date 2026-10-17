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
