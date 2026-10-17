import { showAllTools } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

test('edits inherited lists, restarts and nests items, and reopens a validated numbering export', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html'); await showAllTools(page);
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/numbering.docx');
  const input = page.getByRole('textbox', { name: 'Document text' });
  const numbers = page.getByRole('button', { name: 'Numbered list', exact: true });
  const bullets = page.getByRole('button', { name: 'Bulleted list', exact: true });
  const restart = page.getByRole('button', { name: 'Restart numbering at 1', exact: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  const canvases = page.locator('canvas.canvas-page');
  await expect(input).toHaveValue(/^Numbering starts at three/); await expect(canvases).toHaveCount(2);
  for (const button of [numbers, bullets, restart]) {
    await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    const label = await button.getAttribute('aria-label'), shortcut = await button.getAttribute('data-shortcut');
    await expect(button).toHaveAttribute('title', shortcut ? `${label} (${shortcut})` : label);
  }
  await expect(numbers).toHaveAttribute('aria-pressed', 'true');
  const choose = async (text, endText) => input.evaluate((el, [text, endText]) => {
    const start = el.value.indexOf(text), end = endText ? el.value.indexOf(endText) : start;
    el.setSelectionRange(start, end); el.dispatchEvent(new Event('select', { bubbles: true }));
  }, [text, endText]);
  const range = () => input.evaluate(el => [el.selectionStart, el.selectionEnd]);
  const firstPage = canvases.first(); await firstPage.scrollIntoViewIfNeeded();
  const box = await firstPage.boundingBox();
  // Marker clicks resolve to the first editable character, not synthetic label text.
  await page.mouse.click(box.x + 72, box.y + 60); expect(await range()).toEqual([0, 0]);
  await page.keyboard.insertText('Edited ');
  await choose('Second top item'); const originalSelection = await range();
  await restart.focus(); await restart.press('Space'); await expect(input).toBeFocused();
  expect(await range()).toEqual(originalSelection);
  await undo.click(); expect(await range()).toEqual(originalSelection); await redo.click();
  await choose('Nested continuation');
  await input.press('Alt+Shift+ArrowRight');
  const geometry = page.getByRole('button', { name: 'Indents and tabs', exact: true });
  await geometry.click();
  await expect(page.getByRole('spinbutton', { name: 'Left indent (in)', exact: true })).toHaveValue('1.5');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await undo.click(); await redo.click();
  // Removing and restoring an inherited list writes an explicit numId=0 override.
  await choose('Not a list'); await expect(numbers).toHaveAttribute('aria-pressed', 'false');
  await bullets.click(); await expect(bullets).toHaveAttribute('aria-pressed', 'true');
  await bullets.click(); await expect(bullets).toHaveAttribute('aria-pressed', 'false');
  await undo.click(); await expect(bullets).toHaveAttribute('aria-pressed', 'true');
  await redo.click(); await expect(bullets).toHaveAttribute('aria-pressed', 'false');
  const text = await input.inputValue();
  await choose('Continue eight', 'Not a list');
  const selected = await range(); await page.keyboard.insertText('Temporary replacement'); await undo.click();
  await expect(input).toHaveValue(text); expect(await range()).toEqual(selected);
  await firstPage.screenshot({ path: testInfo.outputPath('numbering-page.png'), animations: 'disabled' });
  await page.screenshot({ path: testInfo.outputPath('numbering-toolbar.png'), animations: 'disabled' });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const saved = testInfo.outputPath('numbering.docx'); await (await downloaded).saveAs(saved);
  const original = unzipSync(readFileSync('public/fixtures/numbering.docx')), exported = unzipSync(readFileSync(saved));
  for (const [name, data] of Object.entries(original)) if (!['word/document.xml', 'word/numbering.xml', 'word/settings.xml'].includes(name)) expect(Buffer.from(exported[name]).equals(Buffer.from(data)), name).toBe(true);
  // The text changed, so the saved spelling and grammar completion flags no longer hold (§17.15.1.65).
  expect(strFromU8(exported['word/settings.xml'])).toBe(strFromU8(original['word/settings.xml']).replace('w:spelling="clean" w:grammar="clean"', 'w:spelling="dirty" w:grammar="dirty"'));
  await reopenDocx(page, input, saved, await input.inputValue());
  await expect(input).toHaveValue(text); await expect(undo).toBeDisabled(); await expect(canvases).toHaveCount(2);
  await choose('Nested continuation'); await expect(numbers).toHaveAttribute('aria-pressed', 'true');
  await geometry.click(); await expect(page.getByRole('spinbutton', { name: 'Left indent (in)', exact: true })).toHaveValue('1.5');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await input.press('ControlOrMeta+a'); await expect(numbers).toHaveAttribute('aria-pressed', 'mixed');
  expect(errors).toEqual([]);
});

test('creates bullet and numbered lists, continues and exits items, and restores list state with undo', async ({ page }, testInfo) => {
  await page.goto('/playground.html'); await showAllTools(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  const numbers = page.getByRole('button', { name: 'Numbered list', exact: true });
  const bullets = page.getByRole('button', { name: 'Bulleted list', exact: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await numbers.click(); await page.keyboard.insertText('First item'); await input.press('Enter');
  await page.keyboard.insertText('Second item'); await input.press('Enter');
  await expect(input).toHaveValue('First item\nSecond item\n'); await expect(numbers).toHaveAttribute('aria-pressed', 'true');
  await input.press('Enter'); await expect(numbers).toHaveAttribute('aria-pressed', 'false');
  await undo.click(); await expect(numbers).toHaveAttribute('aria-pressed', 'true');
  await input.press('Backspace'); await expect(numbers).toHaveAttribute('aria-pressed', 'false');
  await bullets.click(); await page.keyboard.insertText('Bullet item'); await expect(bullets).toHaveAttribute('aria-pressed', 'true');
  await input.press('Home'); await input.press('Backspace'); await expect(bullets).toHaveAttribute('aria-pressed', 'false');
  await expect(input).toHaveValue('First item\nSecond item\nBullet item');
  await undo.click(); await expect(bullets).toHaveAttribute('aria-pressed', 'true');
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const saved = testInfo.outputPath('new-lists.docx'); await (await downloaded).saveAs(saved);
  await reopenDocx(page, input, saved, await input.inputValue());
  await expect(input).toHaveValue('First item\nSecond item\nBullet item');
  await input.press('ControlOrMeta+End'); await expect(bullets).toHaveAttribute('aria-pressed', 'true');
  await page.locator('canvas.canvas-page').first().screenshot({ path: testInfo.outputPath('new-lists.png'), animations: 'disabled' });
});
