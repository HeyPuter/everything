import { showAllTools, downloadDocx, onTab } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { reopenDocx } from './helpers/reopen-docx.js';

const panel = page => page.getByRole('search', { name: 'Find and replace' });
const query = page => panel(page).getByRole('textbox', { name: 'Find text', exact: true });
const replacement = page => panel(page).getByRole('textbox', { name: 'Replace with', exact: true });
const count = page => panel(page).locator('.canvas-find-count');
const undo = page => page.getByRole('button', { name: 'Undo', exact: true });
const redo = page => page.getByRole('button', { name: 'Redo', exact: true });
async function fixture(page) {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/find-replace.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Find and replace sample/); return input;
}
// Ctrl/Cmd+F searches from the Navigation pane; the Find and Replace panel opens with Replace's chord.
const REPLACE_CHORD = process.platform === 'darwin' ? 'Meta+Shift+h' : 'Control+h';
async function open(page, input) { await input.press(REPLACE_CHORD); await expect(query(page)).toBeFocused(); }
async function close(page) { await panel(page).getByRole('button', { name: 'Close find and replace' }).click(); await expect(panel(page)).toBeHidden(); }
async function download(page, info, name) { const event = page.waitForEvent('download'); await downloadDocx(page); const path = info.outputPath(name); await (await event).saveAs(path); return path; }
async function screenshot(page, info, index, name) { const png = await page.locator('canvas.canvas-page').nth(index).evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(info.outputPath(name), Buffer.from(png, 'base64')); }

test('replaces formatted source text and every original match in one undo step, preserving DOCX structures on reopen', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); const input = await fixture(page), original = await input.inputValue();
  await expect(page.locator('.ribbon-card').getByRole('button', { name: 'Find', exact: true }).locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await open(page, input); await query(page).fill('needle'); await panel(page).getByRole('checkbox', { name: 'Whole words' }).check(); await expect(count(page)).toHaveText('1 of 14');
  const selected = await input.evaluate(el => [el.selectionStart, el.selectionEnd]); await replacement(page).fill('thread'); await panel(page).getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(input).toHaveValue(original.replace('needle', 'thread')); await expect(count(page)).toHaveText('1 of 13');
  await undo(page).click(); await expect(input).toHaveValue(original); expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selected); await redo(page).click();
  await panel(page).getByRole('button', { name: 'Replace all', exact: true }).click(); const expected = original.replace(/\bneedle\b/gi, 'thread');
  await expect(input).toHaveValue(expected); await expect(count(page)).toHaveText('No matches'); await expect(panel(page).locator('.canvas-find-notice')).toHaveText('Replaced 13 matches.');
  await undo(page).click(); await expect(input).toHaveValue(original.replace('needle', 'thread')); await redo(page).click(); await expect(input).toHaveValue(expected);
  const position = await input.evaluate(el => el.selectionStart), positions = [...expected.matchAll(/\bthread\b/g)].map(m => m.index);
  const nextIndex = positions.findIndex(at => at >= position);
  await query(page).fill('thread'); await expect(count(page)).toHaveText(`${(nextIndex < 0 ? 0 : nextIndex) + 1} of 14`); await page.screenshot({ path: info.outputPath('find-replace-panel.png') }); await close(page);
  await screenshot(page, info, 0, 'find-replace-page.png'); await screenshot(page, info, 2, 'find-replace-table.png');
  const saved = await download(page, info, 'find-replace.docx'); await reopenDocx(page, input, saved, expected); await expect(undo(page)).toBeDisabled(); await open(page, input); await query(page).fill('thread'); await panel(page).getByRole('checkbox', { name: 'Whole words' }).check(); await expect(count(page)).toHaveText('1 of 14'); expect(errors).toEqual([]);
});

test('replaces literal dollar syntax in a fresh document and retains the first character formatting', async ({ page }, info) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('fox fox\nFOX boxes\nÁ😀'); await input.evaluate(el => { el.setSelectionRange(0, 3); el.dispatchEvent(new Event('select', { bubbles: true })); }); await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await open(page, input); await expect(query(page)).toHaveValue('fox'); await replacement(page).fill('$&'); await panel(page).getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(input).toHaveValue('$& $&\n$& boxes\nÁ😀'); await close(page);
  const saved = await download(page, info, 'new-find-replace.docx'); await reopenDocx(page, input, saved, '$& $&\n$& boxes\nÁ😀'); await open(page, input); await query(page).fill('$&'); await expect(count(page)).toHaveText('1 of 3'); await close(page); await screenshot(page, info, 0, 'new-find-replace.png');
});

test('navigates with wrapping, case and whole-word options without adding undo entries and keeps zoomed Unicode carets aligned', async ({ page }) => {
  const input = await fixture(page), original = await input.inputValue(); await open(page, input); await query(page).fill('needle'); await expect(count(page)).toHaveText('1 of 15');
  await panel(page).getByRole('checkbox', { name: 'Whole words' }).check(); await expect(count(page)).toHaveText('1 of 14'); await query(page).press('Shift+Enter'); await expect(count(page)).toHaveText('14 of 14');
  expect(await input.evaluate(el => el.selectionStart)).toBe(original.lastIndexOf('needle')); expect(await page.locator('.canvas-host').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await query(page).press('Enter'); await expect(count(page)).toHaveText('1 of 14'); await panel(page).getByRole('checkbox', { name: 'Match case' }).check(); await expect(count(page)).toHaveText('1 of 13');
  await panel(page).getByRole('checkbox', { name: 'Whole words' }).uncheck(); await query(page).fill('Á😀'); await expect(count(page)).toHaveText('1 of 2'); expect(await input.evaluate(el => el.selectionEnd - el.selectionStart)).toBe(4);
  await query(page).press('Escape'); await expect(input).toBeFocused(); await expect(panel(page)).toBeHidden(); await expect(undo(page)).toBeDisabled();
  await input.press('ArrowLeft'); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1.5');
  const caret = await input.evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height), at: el.selectionStart })), surface = await page.locator('.canvas-pages').boundingBox();
  await page.mouse.click(surface.x + caret.left + 1, surface.y + caret.top + caret.height / 2); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at); await input.press('ArrowRight'); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at + 2);
  await expect(input).toHaveValue(original); await expect(undo(page)).toBeDisabled();
});

test('keeps search results current during document editing, undo and composition without stealing focus', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }); await input.fill('word');
  await open(page, input); await query(page).fill('word'); await expect(count(page)).toHaveText('1 of 1'); await input.press('ControlOrMeta+End'); await page.keyboard.insertText(' word'); await expect(input).toBeFocused(); await expect(count(page)).toHaveText('2 matches');
  await input.press('ControlOrMeta+z'); await expect(count(page)).toHaveText('1 match');
  await query(page).fill('absent'); await expect(count(page)).toHaveText('No matches'); await expect(panel(page).getByRole('button', { name: 'Replace', exact: true })).toBeDisabled();
  await query(page).evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart')); el.value = 'word'; el.dispatchEvent(new InputEvent('input', { data: 'word', isComposing: true })); }); await expect(count(page)).toHaveText('No matches');
  await query(page).evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { data: 'word' }))); await expect(count(page)).toHaveText('1 of 1'); await expect(query(page)).toBeFocused();
  await replacement(page).fill('changed'); await replacement(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229 }); await expect(input).toHaveValue('word');
  await query(page).dispatchEvent('keydown', { key: 'Escape', keyCode: 229 }); await expect(panel(page)).toBeVisible(); await close(page);
  await input.dispatchEvent('keydown', { key: 'f', ctrlKey: true, keyCode: 229 }); await expect(panel(page)).toBeHidden();
});

test('repaginates replacements in flowing cells and lays out a header grown too tall to repeat once', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page), original = await input.inputValue(), pages = await page.locator('canvas.canvas-page').count(); await open(page, input); await query(page).fill('Flowing');
  await replacement(page).fill('Many more flowing words that fill the cell'); await panel(page).getByRole('button', { name: 'Replace all', exact: true }).click(); expect(await page.locator('canvas.canvas-page').count()).toBeGreaterThan(pages);
  await undo(page).click(); await expect(input).toHaveValue(original); expect(await page.locator('canvas.canvas-page').count()).toBe(pages); await expect(undo(page)).toBeDisabled();
  // A repeated header that no longer leaves its page room for the table body is not repeated: the
  // replacement is applied, the header row flows once across pages, and one undo restores everything.
  const huge = 'Huge repeated header '.repeat(200);
  await query(page).fill('needle header'); await replacement(page).fill(huge); await panel(page).getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(input).toHaveValue(original.replace('needle header', huge)); await expect(panel(page).getByRole('alert')).toBeHidden();
  await expect.poll(() => page.locator('canvas.canvas-page').count()).toBeGreaterThan(pages); await expect(undo(page)).toBeEnabled(); await expect(redo(page)).toBeDisabled();
  await undo(page).click(); await expect(input).toHaveValue(original); await expect.poll(() => page.locator('canvas.canvas-page').count()).toBe(pages); await expect(undo(page)).toBeDisabled(); await expect(redo(page)).toBeEnabled();
  await replacement(page).fill('Small header'); await panel(page).getByRole('button', { name: 'Replace all', exact: true }).click(); await expect(panel(page).getByRole('alert')).toBeHidden(); await expect(input).toHaveValue(original.replace('needle header', 'Small header'));
  expect(errors).toEqual([]);
});

test('keeps search controls reachable on a narrow screen and preserves history for a no-op replacement', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 600 }); const input = await fixture(page); await open(page, input); await query(page).fill('needle'); await panel(page).getByRole('checkbox', { name: 'Match case' }).check(); await replacement(page).fill('needle');
  const all = panel(page).getByRole('button', { name: 'Replace all', exact: true });
  for (const control of [query(page), replacement(page), all]) { await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport(); }
  await expect(panel(page).getByRole('button', { name: 'Close find and replace' })).toBeInViewport();
  expect(await panel(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await all.click(); await expect(panel(page).locator('.canvas-find-notice')).toHaveText('Replaced 0 matches.'); await expect(undo(page)).toBeDisabled(); await panel(page).screenshot({ path: info.outputPath('find-replace-narrow.png') }); await query(page).press('Escape'); await expect(input).toBeFocused();
});

test('docks search beside the document and keeps download and formatting available', async ({ page }, info) => {
  await page.goto('/mock.html#/new');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input.fill('Find this text and keep writing.');
  await open(page, input); await query(page).fill('text');
  await expect(count(page)).toHaveText('1 of 1');
  // The panel sits below the ribbon, beside the pages.
  const bounds = await panel(page).boundingBox(), ribbon = await page.locator('.ed-ribbon').boundingBox(), surface = await page.locator('.canvas-document-surface').boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(ribbon.y + ribbon.height);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(surface.x);
  await download(page, info, 'docked-search.docx');
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('checkbox', { name: 'Whole words' }).check();
  // The Navigation pane takes the place of the panel, and the replace chord brings it back as it was.
  await onTab(page, 'view');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Navigation Pane', exact: true }).click();
  await expect(panel(page)).toBeHidden(); await expect(page.getByRole('complementary', { name: 'Navigation' })).toBeVisible();
  await input.press(REPLACE_CHORD);
  await expect(page.getByRole('complementary', { name: 'Navigation' })).toBeHidden(); await expect(query(page)).toBeFocused();
  await expect(query(page)).toHaveValue('text'); await expect(panel(page).getByRole('checkbox', { name: 'Whole words' })).toBeChecked();
  await onTab(page, 'home');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('docked-search-desktop.png') });
  await page.setViewportSize({ width: 390, height: 640 });
  await expect(panel(page)).toBeVisible();
  await query(page).focus(); await query(page).press('Escape');
  await expect(panel(page)).toBeHidden(); await expect(input).toBeFocused();
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([10, 14]);
});

test('mobile search shares space with the document and switches cleanly between panels', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/mock.html#/new');
    const input = page.getByRole('textbox', { name: 'Document text' });
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await input.fill('Find this text and keep writing.');
    await page.getByRole('button', { name: 'Formatting Pane', exact: true }).tap();
    await expect(page.getByRole('complementary', { name: 'Formatting Pane' })).toBeVisible();
    await input.press(REPLACE_CHORD); await expect(query(page)).toBeFocused();
    await expect(page.getByRole('complementary', { name: 'Formatting Pane' })).toBeHidden();
    await query(page).fill('text'); await expect(count(page)).toHaveText('1 of 1');
    const bounds = await panel(page).boundingBox(), surface = await page.locator('.canvas-document-surface').boundingBox();
    expect(surface.height).toBeGreaterThanOrEqual(130);
    expect(bounds.y).toBeGreaterThanOrEqual(surface.y + surface.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel(page).getByRole('button', { name: 'Replace all', exact: true }).scrollIntoViewIfNeeded();
    await expect(panel(page).getByRole('button', { name: 'Replace all', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('docked-search-mobile.png') });
    await page.getByRole('button', { name: 'Formatting Pane', exact: true }).tap();
    await expect(panel(page)).toBeHidden();
    await input.press(REPLACE_CHORD); await expect(query(page)).toHaveValue('text');
    await input.press('ControlOrMeta+f');
    await expect(panel(page)).toBeHidden(); await expect(page.getByRole('complementary', { name: 'Navigation' })).toBeVisible();
    await input.press(REPLACE_CHORD); await expect(page.getByRole('complementary', { name: 'Navigation' })).toBeHidden();
    await query(page).press('Escape'); await expect(input).toBeFocused();
  } finally { await context.close(); }
});

test('the replace chord opens find and replace with the selection', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Replace this word');
  await input.evaluate(el => { el.setSelectionRange(8, 12); el.dispatchEvent(new Event('select')); });
  await input.press(process.platform === 'darwin' ? 'Meta+Shift+h' : 'Control+h');
  await expect(page.getByRole('textbox', { name: 'Find text', exact: true })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Find text', exact: true })).toHaveValue('this');
  await expect(page.getByRole('textbox', { name: 'Replace with', exact: true })).toBeVisible();
});

test('tints every match while searching, leaves the current one in the selection color and clears the tint on close', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('needle hay needle hay needle');
  // Find tints are the only yellow on a page of black text and blue selection.
  const tinted = () => page.locator('canvas.canvas-page').first().evaluate(c => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 230 && data[i + 1] > 200 && data[i + 2] < 190) n++;
    return n;
  });
  expect(await tinted()).toBe(0);
  await open(page, input); await query(page).fill('needle'); await expect(count(page)).toHaveText('1 of 3');
  await expect.poll(tinted).toBeGreaterThan(0); const two = await tinted();
  await query(page).fill('hay needle hay'); await expect(count(page)).toHaveText('1 of 1'); await expect.poll(tinted).toBe(0);
  await query(page).fill('needle'); await expect.poll(tinted).toBeGreaterThan(0);
  await input.press('ControlOrMeta+End'); await page.keyboard.insertText(' needle'); await expect(count(page)).toHaveText('4 matches'); await expect.poll(tinted).toBeGreaterThan(two * 1.4);
  await close(page); await expect.poll(tinted).toBe(0); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
});

test('searches and replaces in the main document while a footer is being edited', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByLabel('Open DOCX file').setInputFiles('tests/fixtures/page-stories/footer-variants.docx');
  const body = page.getByRole('textbox', { name: 'Document text' });
  await expect(body).toHaveValue('Body page 1\nBody page 2\nBody page 3');
  const story = () => page.evaluate(() => window.__docs.current.view.engine.session.path);
  const editFooter = async () => { await page.evaluate(() => window.__docs.current.view.engine.editStory('word/footer-first.xml', 0)); await expect.poll(story).toBe('word/footer-first.xml'); };
  await editFooter();
  // The Navigation pane lists the body's matches, and a result goes to the body.
  await page.getByRole('textbox', { name: 'Footer text' }).press('ControlOrMeta+f');
  const search = page.getByRole('searchbox', { name: 'Search document' });
  await search.fill('page');
  const results = page.getByRole('list', { name: 'Search results' }).getByRole('button');
  await expect(results).toHaveCount(3);
  await results.nth(1).click();
  await expect.poll(story).toBe(null);
  expect(await body.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd) + '@' + el.selectionStart)).toBe('page@17');
  // Find and Replace in the main document, started from the footer.
  await editFooter();
  await page.getByRole('textbox', { name: 'Footer text' }).press(REPLACE_CHORD);
  await query(page).fill('Body');
  // The first match is selected, in the body.
  await expect(count(page)).toHaveText('1 of 3');
  await expect.poll(story).toBe(null);
  await editFooter();
  await expect(count(page)).toHaveText('3 matches');
  await replacement(page).fill('Main');
  await panel(page).getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(body).toHaveValue('Main page 1\nMain page 2\nMain page 3');
  expect(await page.evaluate(() => window.__docs.current.view.engine.pageStories.stories['word/footer-first.xml'].paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n'))).toBe('First \ufffc');
  // Find Next (Shift+F4) goes on with the Navigation pane's search, in the body.
  await close(page);
  await editFooter();
  await page.getByRole('textbox', { name: 'Footer text' }).press('Shift+F4');
  await expect.poll(story).toBe(null);
  expect(await body.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('page');
});
