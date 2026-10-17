import { showAllTools } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { reopenDocx } from './helpers/reopen-docx.js';

async function select(input, text, end = false) {
  await input.evaluate((el, { text, end }) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text'); el.setSelectionRange(at, end ? at + text.length : at); el.dispatchEvent(new Event('select', { bubbles: true })); }, { text, end });
}
async function fixture(page) {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/style-line-spacing.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Shared style/); return input;
}
const control = page => page.getByRole('combobox', { name: 'Line spacing', exact: true }).locator('option:checked');
const mode = d => d.getByRole('combobox', { name: 'Style line spacing rule', exact: true });
const size = d => d.getByRole('spinbutton', { name: 'Style line spacing amount', exact: true });
async function open(page) { await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click(); return page.getByRole('dialog', { name: 'Edit paragraph style', exact: true }); }
async function spacing(page, rule, value) {
  const d = await open(page); await mode(d).selectOption(rule); if (value !== undefined) await size(d).fill(String(value));
  await d.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(d).toHaveCount(0); await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
}
async function download(page, info, name) { const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name); await (await event).saveAs(path); return path; }
async function screenshot(page, info, index, name) { const png = await page.locator('canvas.canvas-page').nth(index).evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(info.outputPath(name), Buffer.from(png, 'base64')); }

test('edits shared spacing with keyboard access, retains direct overrides, and saves reusable styles', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); const input = await fixture(page), text = await input.inputValue(), undo = page.getByRole('button', { name: 'Undo', exact: true });
  const edit = page.getByRole('button', { name: 'Edit paragraph style', exact: true }); await expect(edit.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await select(input, 'Base Á😀', true); const selection = await input.evaluate(el => [el.selectionStart, el.selectionEnd]);
  await edit.focus(); await edit.press('Enter'); const d = page.getByRole('dialog', { name: 'Edit paragraph style', exact: true });
  await expect(mode(d)).toHaveValue('exact'); await expect(size(d)).toHaveValue('24'); await size(d).fill('30.05'); await d.getByRole('button', { name: 'Apply', exact: true }).press('Enter'); await expect(input).toBeFocused();
  await expect(control(page)).toHaveText('Exactly 30.05 pt'); await undo.click(); await expect(control(page)).toHaveText('Exactly 24 pt');
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selection); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await select(input, 'Child follows'); await expect(control(page)).toHaveText('Exactly 30.05 pt');
  await select(input, 'Direct minimum'); await expect(control(page)).toHaveText('At least 18 pt');
  await select(input, 'Reset becomes'); await spacing(page, 'inherit'); await expect(control(page)).toHaveText('Exactly 30.05 pt');
  await select(input, 'Omitted rule'); const auto = await open(page); await expect(mode(auto)).toHaveValue('auto'); await expect(size(auto)).toHaveValue('1.25'); await size(auto).fill('1.333'); await auto.getByRole('button', { name: 'Apply', exact: true }).click();
  await select(input, 'Rule inherits'); const partial = await open(page); await expect(mode(partial)).toHaveValue('keep'); await expect(size(partial)).toBeDisabled(); await partial.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(control(page)).toHaveText('At least 30.05 pt');
  await expect(input).toHaveValue(text); await screenshot(page, info, 0, 'style-spacing-page.png'); await screenshot(page, info, 2, 'style-spacing-table.png');
  const saved = await download(page, info, 'style-line-spacing.docx'); await reopenDocx(page, input, saved, text); await expect(undo).toBeDisabled();
  for (const [label, expected] of [['Child follows', 'Exactly 30.05 pt'], ['Reset becomes', 'Exactly 30.05 pt'], ['Direct minimum', 'At least 18 pt'], ['Rule inherits', 'At least 30.05 pt']]) { await select(input, label); await expect(control(page)).toHaveText(expected); }
  // The cleared child and rule-only style remain responsive after save/reopen.
  await select(input, 'Base A'); await spacing(page, 'exact', 36); await select(input, 'Reset becomes'); await expect(control(page)).toHaveText('Exactly 36 pt'); await select(input, 'Rule inherits'); await expect(control(page)).toHaveText('At least 36 pt');
  expect(errors).toEqual([]);
});

test('authors shared spacing in a fresh document and retains styles through Unicode paragraph editing', async ({ page }, info) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue('');
  await input.focus(); await page.keyboard.insertText('First Á😀'); await spacing(page, 'auto', 1.375);
  await input.press('ControlOrMeta+End'); await input.press('Enter'); await page.keyboard.insertText('Second'); await expect(control(page)).toHaveText('1.375×');
  await input.press('Home'); await input.press('Backspace'); await expect(input).toHaveValue('First Á😀Second'); await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const text = await input.inputValue(), saved = await download(page, info, 'new-style-line-spacing.docx'); await reopenDocx(page, input, saved, text); await expect(control(page)).toHaveText('1.375×'); await screenshot(page, info, 0, 'new-style-spacing.png');
});

test('preserves inherited and partial no-ops and redo when another style field changes', async ({ page }) => {
  const input = await fixture(page), undo = page.getByRole('button', { name: 'Undo', exact: true });
  for (const [text, value] of [['Child follows', 'inherit'], ['Rule inherits', 'keep'], ['Omitted rule', 'auto']]) {
    await select(input, text); const d = await open(page); await expect(mode(d)).toHaveValue(value); await d.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(undo).toBeDisabled();
  }
  await select(input, 'Rule inherits'); let d = await open(page); await d.getByRole('spinbutton', { name: 'Style space after (pt)', exact: true }).fill('12'); await d.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(control(page)).toHaveText('At least 24 pt');
  await undo.click(); d = await open(page); await d.getByRole('button', { name: 'Apply', exact: true }).click(); await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(page.getByRole('spinbutton', { name: 'Space after paragraph (pt)', exact: true, includeHidden: true })).toHaveValue('12');
  await select(input, 'Base A'); await spacing(page, 'atLeast', 32); await select(input, 'Rule inherits'); await expect(control(page)).toHaveText('At least 32 pt');
});

test('repaginates inherited table styles while preserving zoomed caret and Unicode selection', async ({ page }) => {
  const input = await fixture(page), original = await input.inputValue(), undo = page.getByRole('button', { name: 'Undo', exact: true }); const count = await page.locator('canvas.canvas-page').count();
  await select(input, 'Base A'); await spacing(page, 'atLeast', 42); expect(await page.locator('canvas.canvas-page').count()).toBeGreaterThan(count); await undo.click(); expect(await page.locator('canvas.canvas-page').count()).toBe(count);
  await spacing(page, 'exact', 36); await select(input, 'Á😀'); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1.5');
  const caret = await input.evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height), at: el.selectionStart })), surface = await page.locator('.canvas-pages').boundingBox();
  await page.mouse.click(surface.x + caret.left + 1, surface.y + caret.top + caret.height / 2); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at); await input.press('Shift+ArrowRight'); expect(await input.evaluate(el => el.selectionEnd - el.selectionStart)).toBe(2); await page.keyboard.insertText('X'); await undo.click(); await expect(input).toHaveValue(original);
});

test('rolls back shared heights that cannot fit a page and allows correction without losing history', async ({ page }) => {
  const input = await fixture(page), original = await input.inputValue(), undo = page.getByRole('button', { name: 'Undo', exact: true }); await select(input, 'Base A'); const count = await page.locator('canvas.canvas-page').count(), d = await open(page);
  await size(d).fill('600'); await d.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(d.getByRole('alert')).toContainText('could not be applied'); await expect(undo).toBeDisabled(); await expect(input).toHaveValue(original); expect(await page.locator('canvas.canvas-page').count()).toBe(count); await expect(control(page)).toHaveText('Exactly 24 pt');
  await size(d).fill('28'); await d.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(d).toHaveCount(0); await undo.click(); await expect(undo).toBeDisabled();
});

test('keeps style line controls and Apply reachable on a narrow screen and retains points between rules', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 500 }); const input = await fixture(page); await select(input, 'Base A'); const d = await open(page), apply = d.getByRole('button', { name: 'Apply', exact: true });
  await mode(d).selectOption('atLeast'); await expect(size(d)).toHaveValue('24'); await size(d).focus(); await expect(size(d)).toBeInViewport(); await expect(apply).toBeInViewport(); expect(await d.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true); await d.screenshot({ path: info.outputPath('style-spacing-narrow.png') }); await size(d).fill('24.05'); await apply.click(); await expect(d).toHaveCount(0); await expect(input).toBeFocused();
});
