import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

test.setTimeout(150000);
const ribbon = (page, name) => page.locator('.ribbon-card').getByRole('button', { name, exact: true });
async function select(input, text, from = 0) {
  await input.evaluate((el, [text, from]) => { const at = el.value.indexOf(text, from); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, [text, from]);
}
const selection = input => input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd));
async function blank(page, text, init) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  await onTab(page, 'home');
  return { input, errors };
}

test('Select menu: similar formatting highlights every passage and selects the first', async ({ page }) => {
  const { input, errors } = await blank(page, 'one bold two bold three bold');
  for (const from of [0, 9, 18]) { await select(input, 'bold', from); await ribbon(page, 'Bold').click(); }
  await select(input, 'bold', 9);
  await ribbon(page, 'Select').click();
  await page.getByRole('menuitem', { name: 'Select All Text With Similar Formatting' }).click();
  expect(await selection(input)).toBe('bold');
  expect(await input.evaluate(el => el.selectionStart)).toBe(4);
  await expect(page.getByText('3 passages with similar formatting highlighted', { exact: false })).toBeVisible();
  // Select Objects reports when there is nothing to select.
  await ribbon(page, 'Select').click();
  await page.getByRole('menuitem', { name: 'Select Objects' }).click();
  await expect(page.getByText(/no pictures, shapes or text boxes/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('Format Painter: copy and paste formatting from the keyboard, sticky with a double click', async ({ page }) => {
  const { input, errors } = await blank(page, 'Source plain one plain two');
  await select(input, 'Source');
  await ribbon(page, 'Bold').click(); await ribbon(page, 'Italic').click();
  await input.press('ControlOrMeta+Shift+c');
  await expect(page.getByText(/Formatting copied/)).toBeVisible();
  await select(input, 'one');
  await input.press('ControlOrMeta+Shift+v');
  await expect(ribbon(page, 'Bold')).toHaveAttribute('aria-pressed', 'true');
  await expect(ribbon(page, 'Italic')).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveValue('Source plain one plain two');
  // A double click keeps the painter on until Escape.
  await select(input, 'Source');
  await ribbon(page, 'Format Painter').dblclick();
  await expect(ribbon(page, 'Format Painter')).toHaveAttribute('aria-pressed', 'true');
  await input.press('Escape');
  await expect(ribbon(page, 'Format Painter')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('Dictate inserts recognized speech at the caret and shows that it is listening', async ({ page }) => {
  // A scripted recognizer stands in for the browser's speech service.
  const { input, errors } = await blank(page, 'Start', () => {
    class FakeRecognition {
      start() { window.__recognizer = this; }
      stop() { this.onend?.(); }
    }
    window.SpeechRecognition = FakeRecognition; window.webkitSpeechRecognition = FakeRecognition;
    window.__say = (text, isFinal = true) => {
      const result = Object.assign([{ transcript: text }], { isFinal });
      window.__recognizer.onresult({ resultIndex: 0, results: [result] });
    };
  });
  await input.evaluate(el => { el.setSelectionRange(5, 5); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await ribbon(page, 'Dictate').click();
  await expect(ribbon(page, 'Dictate')).toHaveAttribute('aria-pressed', 'true');
  const banner = page.locator('.dictate-banner');
  await expect(banner).toBeVisible();
  await page.evaluate(() => window.__say('hello wor', false));
  await expect(banner.locator('.dictate-interim')).toHaveText('hello wor');
  await page.evaluate(() => window.__say('hello world period'));
  await expect(input).toHaveValue('Start hello world.');
  await page.keyboard.press('Escape');
  await expect(banner).toBeHidden();
  await expect(ribbon(page, 'Dictate')).toHaveAttribute('aria-pressed', 'false');
  // One undo removes the dictated phrase.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue('Start');
  expect(errors).toEqual([]);
});
