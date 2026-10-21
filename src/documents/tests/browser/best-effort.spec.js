import { test, expect } from '@playwright/test';
import { openReadOnlyPreview } from './helpers/preview.js';
import { showAllTools } from './helpers/editor-tools.js';

test('opens best-effort content, blocks every input path and downloads the original', async ({ page }, info) => {
  await page.goto('/playground.html');
  await openReadOnlyPreview(page, 'public/fixtures/best-effort.docx');
  const input = page.getByRole('textbox', { name: 'Document text' });
  // Tracked deletions keep their document positions until accepted (docs/conformance.md, Tracked changes).
  const expected = 'Best-effort opening\nField result: September 17, 2026\nDeleted wordsInserted words\nStill readable after unsupported content.';
  await expect(input).toHaveValue(expected);
  await input.press('ControlOrMeta+a'); await page.keyboard.insertText('Overwrite');
  await input.press('Backspace'); await input.press('ControlOrMeta+b');
  await input.evaluate(el => {
    const data = new DataTransfer(); data.setData('text/plain', 'Paste');
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value = 'IME'; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText' }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await expect(input).toHaveValue(expected);
  // Ctrl/Cmd+F searches from the Navigation pane; the Find and Replace panel opens with Replace's chord.
  await input.press(process.platform === 'darwin' ? 'Meta+Shift+h' : 'Control+h');
  const finder = page.getByRole('search', { name: 'Find and replace' });
  await finder.getByRole('textbox', { name: 'Find text', exact: true }).fill('words');
  await expect(finder.getByRole('button', { name: 'Replace', exact: true })).toBeDisabled();
  await expect(finder.getByRole('button', { name: 'Replace all', exact: true })).toBeDisabled();
  await finder.getByRole('button', { name: 'Close find and replace', exact: true }).click();
  await page.screenshot({ path: info.outputPath('best-effort.png') });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  await (await download).saveAs(info.outputPath('best-effort.docx'));
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/two-paragraphs.docx');
  await expect(input).toHaveJSProperty('readOnly', false);
  await showAllTools(page);
  await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Editable again. ');
  await expect(input).toHaveValue(/^Editable again\./);
});

test('the app opens unsupported files without attaching an exporter', async ({ page }) => {
  await page.goto('/mock.html');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
  await openReadOnlyPreview(page, 'public/fixtures/best-effort.docx');
  expect(await page.evaluate(() => !!window.__docs.current.view.doc.exporter)).toBe(false);
});

test('the read-only notice is a message bar that can be dismissed', async ({ page }) => {
  await page.goto('/playground.html');
  await openReadOnlyPreview(page, 'public/fixtures/best-effort.docx');
  const notice = page.locator('.canvas-message');
  await expect(notice).toContainText('This document is read-only');
  expect(await notice.evaluate(el => el.offsetHeight)).toBeLessThan(90);
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
  // The next document's notices start visible again.
  await openReadOnlyPreview(page, 'public/fixtures/best-effort.docx');
  await expect(notice).toBeVisible();
});

test('the message bar\'s Dismiss button stays visible on its yellow in the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/playground.html');
  await openReadOnlyPreview(page, 'public/fixtures/best-effort.docx');
  const ratio = await page.locator('.canvas-message').evaluate(bar => {
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = c => c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const fore = lum(rgb(getComputedStyle(bar.querySelector('.canvas-message-close')).color)), back = lum(rgb(getComputedStyle(bar).backgroundColor));
    return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05);
  });
  // The theme's light grey icon measured 1.6:1 on the bar's fixed yellow.
  expect(ratio).toBeGreaterThanOrEqual(3);
});

test('leaving a preview of an imported file says it was not saved, without offering to keep editing', async ({ page }) => {
  await page.goto('/mock.html');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
  await openReadOnlyPreview(page, 'public/fixtures/best-effort.docx');
  await page.evaluate(() => { location.hash = '#/home'; });
  const dialog = page.getByRole('dialog', { name: 'Leave without saving?' });
  await expect(dialog).toContainText('could not be opened for editing, so it has not been saved to Puter. Stay to download a copy');
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveJSProperty('readOnly', true);
});
