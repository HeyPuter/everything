import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

test.use({ viewport: { width: 1440, height: 900 } });
const ribbon = page => page.locator('.ribbon-card');
const viewTab = async page => { await page.locator('#ribbon-tab-view').click(); return ribbon(page); };
const caret = (input, at) => input.evaluate((el, at) => { const n = at < 0 ? el.value.length : at; el.focus(); el.setSelectionRange(n, n); el.dispatchEvent(new Event('select')); }, at);
const caretAt = (input, text) => input.evaluate((el, text) => { const n = el.value.indexOf(text); el.focus(); el.setSelectionRange(n, n); el.dispatchEvent(new Event('select')); }, text);
async function download(page, info, name) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const path = info.outputPath(`${name}.docx`);
  await (await event).saveAs(path);
  mkdirSync('test-results/document-views', { recursive: true });
  copyFileSync(path, `test-results/document-views/${name}.docx`);
  return path;
}
const parts = path => unzipSync(readFileSync(path));
const settingsXml = path => { const all = parts(path); const name = Object.keys(all).find(n => /^word\/settings\d*\.xml$/.test(n)); return name ? strFromU8(all[name]) : ''; };

async function headings(page) {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(`Introduction\nThe plan in brief. ${'Words to read and enjoy. '.repeat(30)}\nBackground\nWhy the plan matters.\nResults\nThe final plan.`);
  for (const [text, level] of [['Introduction', 1], ['Background', 2], ['Results', 1]]) { await caretAt(input, text); await input.press(`Control+Alt+${level}`); }
  return input;
}

test('Web Layout reflows to the window, edits, saves w:view and reopens in the same view', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await headings(page);
  const tab = await viewTab(page);
  await tab.getByRole('button', { name: 'Web Layout', exact: true }).click();
  const host = page.locator('.canvas-host');
  await expect(host).toHaveClass(/view-web/);
  await expect(tab.getByRole('button', { name: 'Web Layout', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // One continuous strip as wide as the window, no page gap.
  const [hostWidth, canvasWidth, count] = await page.evaluate(() => { const h = document.querySelector('.canvas-host'), c = h.querySelectorAll('canvas.canvas-page'); return [h.clientWidth, c[0].getBoundingClientRect().width, c.length]; });
  expect(count).toBe(1);
  expect(Math.abs(hostWidth - canvasWidth)).toBeLessThan(4);
  await caret(input, -1);
  await input.pressSequentially(' Typed in web layout.');
  await expect(input).toHaveValue(/Typed in web layout\.$/);
  const saved = await download(page, info, 'web-layout');
  expect(settingsXml(saved)).toContain('<w:view w:val="web"/>');
  expect(strFromU8(parts(saved)['word/document.xml'])).toContain('Typed in web layout.');
  await reopenDocx(page, input, saved, await input.inputValue());
  await expect(page.locator('.canvas-host')).toHaveClass(/view-web/);
  await (await viewTab(page)).getByRole('button', { name: 'Print Layout', exact: true }).click();
  await expect(page.locator('.canvas-host')).not.toHaveClass(/view-web/);
  expect(errors).toEqual([]);
});

test('Draft shows breaks as continuous strips, a style area, and saves as normal view', async ({ page }, info) => {
  const input = await headings(page);
  await caretAt(input, 'Background');
  await input.press('ControlOrMeta+Enter');
  const tab = await viewTab(page);
  await tab.getByRole('button', { name: 'Draft', exact: true }).click();
  await expect(page.locator('.canvas-host')).toHaveClass(/view-draft/);
  // The page break starts a new strip; strips are trimmed to their text.
  const heights = await page.evaluate(() => [...document.querySelectorAll('.canvas-host canvas.canvas-page')].map(c => c.getBoundingClientRect().height));
  expect(heights).toHaveLength(2);
  expect(heights[1]).toBeLessThan(300);
  await tab.getByRole('button', { name: 'Style Area', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '1 inch' }).click();
  await expect(page.locator('.view-style-name').first()).toHaveText('Heading 1');
  await expect(page.locator('.view-style-name')).toContainText(['Heading 1', 'Normal', 'Heading 2']);
  await caret(input, -1);
  await input.pressSequentially(' Drafted.');
  const saved = await download(page, info, 'draft');
  expect(settingsXml(saved)).toContain('<w:view w:val="normal"/>');
  expect(strFromU8(parts(saved)['word/document.xml'])).toContain('Drafted.');
});

test('Outline view edits text, levels and order through the Outlining tab, with undo', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await headings(page);
  // The text box of the page view stays in the document while the outline is shown in its place.
  const input = page.locator('textarea.canvas-input');
  await (await viewTab(page)).getByRole('button', { name: 'Outline', exact: true }).click();
  const outline = page.getByRole('tree', { name: 'Document outline' });
  await expect(outline).toBeVisible();
  await expect(page.locator('#ribbon-tab-outlining')).toHaveAttribute('aria-selected', 'true');
  const rows = outline.getByRole('treeitem');
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(2)).toHaveAttribute('aria-level', '2');
  // Show Level 1: only the top headings.
  await ribbon(page).getByRole('button', { name: 'Show Level', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Level 1', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await ribbon(page).getByRole('button', { name: 'Show Level', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'All Levels' }).click();
  await expect(rows).toHaveCount(6);
  // Promote Background to Heading 1 from the tab.
  const background = page.locator('.outline-row', { hasText: 'Background' }).locator('.outline-text');
  await background.click();
  await ribbon(page).getByRole('button', { name: 'Promote', exact: true }).click();
  await expect(page.locator('.outline-row', { hasText: 'Background' })).toHaveAttribute('aria-level', '1');
  // Move Results (with its text) above Background.
  await page.locator('.outline-row', { hasText: 'Results' }).locator('.outline-symbol').click();
  await ribbon(page).getByRole('button', { name: 'Move Up', exact: true }).click();
  expect(await input.inputValue()).toMatch(/Results\nThe final plan\.\nBackground\nWhy the plan matters\./);
  // Typing edits the document.
  const final = page.locator('.outline-row', { hasText: 'The final plan.' }).locator('.outline-text');
  await final.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Really.');
  await expect(input).toHaveValue(/The final plan\. Really\./);
  // Tab demotes, Shift+Tab promotes; Enter splits the paragraph.
  await page.keyboard.press('Enter');
  await page.keyboard.type('Next step');
  await expect(input).toHaveValue(/Really\.\nNext step/);
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.outline-row', { hasText: 'Next step' })).toHaveAttribute('aria-level', '1');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.outline-row', { hasText: 'Next step' })).not.toHaveAttribute('aria-level', '1');
  await ribbon(page).getByRole('button', { name: 'Close Outline View', exact: true }).click();
  await expect(outline).toBeHidden();
  await expect(page.locator('.canvas-host')).toBeVisible();
  const saved = await download(page, info, 'outline');
  const xml = strFromU8(parts(saved)['word/document.xml']);
  expect(xml.indexOf('Results')).toBeLessThan(xml.indexOf('Background'));
  expect(xml).toMatch(/<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>Background/);
  expect(errors).toEqual([]);
});

test('Read Mode turns pages, blocks typing, changes page colour and returns with Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'Across pages', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/Every page/);
  const before = await input.inputValue();
  await (await viewTab(page)).getByRole('button', { name: 'Read Mode', exact: true }).click();
  const toolbar = page.getByRole('toolbar', { name: 'Read Mode' });
  await expect(toolbar).toBeVisible();
  await expect(page.locator('.ed-ribbon')).toBeHidden();
  const counter = page.locator('.read-counter');
  await expect(counter).toHaveText(/of \d+/);
  await page.keyboard.press('Home');
  const first = await counter.textContent();
  await page.keyboard.press('ArrowRight');
  await expect(counter).not.toHaveText(first);
  await page.keyboard.press('ArrowLeft');
  await expect(counter).toHaveText(first);
  await page.keyboard.type('zz');
  expect(await input.inputValue()).toBe(before);
  await toolbar.getByRole('button', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: 'Page Color' }).click();
  await page.getByRole('menuitemradio', { name: 'Sepia' }).click();
  await expect(page.locator('.canvas-host')).toHaveClass(/read-sepia/);
  await toolbar.getByRole('button', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: 'Line Focus' }).click();
  await page.getByRole('menuitemradio', { name: 'Three Lines' }).click();
  await expect(page.locator('.ed-workspace')).toHaveClass(/read-line-focus/);
  await page.keyboard.press('Escape');
  await expect(toolbar).toBeHidden();
  await expect(page.locator('.ed-ribbon')).toBeVisible();
  await expect(page.locator('.canvas-host')).not.toHaveClass(/is-reading/);
});

test('switching through every view leaves the saved document unchanged', async ({ page }, info) => {
  const input = await headings(page);
  const before = await download(page, info, 'before-views');
  for (const name of ['Web Layout', 'Draft', 'Outline', 'Read Mode', 'Print Layout']) {
    if (name === 'Print Layout') { await page.keyboard.press('Escape'); await (await viewTab(page)).getByRole('button', { name, exact: true }).click(); }
    else await (await viewTab(page)).getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(150);
  }
  await expect(page.locator('.canvas-host')).not.toHaveClass(/view-(web|draft|outline|read)|is-reading/);
  await caret(input, 0);
  const after = await download(page, info, 'after-views');
  expect(parts(after)).toEqual(parts(before));
});

test('Navigation pane headings drag to reorder sections and promote from their menu', async ({ page }) => {
  const input = await headings(page);
  await (await viewTab(page)).getByRole('button', { name: 'Navigation Pane' }).click();
  const tree = page.getByRole('tree', { name: 'Headings' });
  await expect(tree.getByRole('treeitem')).toHaveText(['Introduction', 'Background', 'Results']);
  await tree.getByRole('treeitem', { name: /Results/ }).dragTo(tree.getByRole('treeitem', { name: /Introduction/ }), { targetPosition: { x: 10, y: 2 } });
  await expect(tree.getByRole('treeitem')).toHaveText(['Results', 'Introduction', 'Background']);
  expect(await input.inputValue()).toMatch(/^Results\nThe final plan\.\nIntroduction/);
  await tree.getByRole('treeitem', { name: /Background/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Promote' }).click();
  await expect(tree.getByRole('treeitem', { name: /Background/ })).toHaveAttribute('aria-level', '1');
  await tree.getByRole('treeitem', { name: /Results/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New Heading After' }).click();
  await page.keyboard.type('Appendix');
  await expect(tree.getByRole('treeitem')).toHaveText(['Results', 'Appendix', 'Introduction', 'Background']);
  await input.press('ControlOrMeta+z');
  await input.press('ControlOrMeta+z');
  await expect(tree.getByRole('treeitem')).toHaveText(['Results', 'Introduction', 'Background']);
});

test('zoom: dialog presets, many pages, text width and Ctrl + wheel', async ({ page }) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'Across pages', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue(/Every page/);
  const slider = page.getByRole('slider', { name: 'Zoom slider' });
  await (await viewTab(page)).getByRole('button', { name: 'Zoom', exact: true }).click();
  // A closing dialog lingers for its exit animation; use the open one.
  const dialog = page.locator('.modal-root:not(.closing)').getByRole('dialog', { name: 'Zoom' });
  await dialog.getByText('75%').click();
  await expect(slider).toHaveValue('75');
  await dialog.getByRole('gridcell', { name: '2 by 1 pages' }).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.canvas-pages')).toHaveClass(/is-multipage/);
  const tops = await page.evaluate(() => [...document.querySelectorAll('canvas.canvas-page')].map(c => Math.round(c.getBoundingClientRect().top)));
  expect(tops[0]).toBe(tops[1]);
  await (await viewTab(page)).getByRole('button', { name: 'Zoom', exact: true }).click();
  await dialog.getByText('Text width').click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  expect(Number(await slider.inputValue())).toBeGreaterThan(110);
  await page.getByRole('button', { name: '100%', exact: true }).click();
  await expect(slider).toHaveValue('100');
  await page.locator('.canvas-host').hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 200);
  await page.keyboard.up('Control');
  await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(100);
  // Cancel restores the zoom it opened with.
  const now = await slider.inputValue();
  await (await viewTab(page)).getByRole('button', { name: 'Zoom', exact: true }).click();
  await dialog.getByText('200%').click();
  await expect(slider).toHaveValue('200');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(slider).toHaveValue(now);
});

test('side-to-side page movement, gridlines and split', async ({ page }) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'Across pages', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/Every page/);
  const tab = await viewTab(page);
  await tab.getByRole('button', { name: 'Side to Side', exact: true }).click();
  await expect(page.locator('.canvas-pages')).toHaveClass(/is-side-to-side/);
  const tops = await page.evaluate(() => [...document.querySelectorAll('.canvas-host canvas.canvas-page')].map(c => Math.round(c.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await tab.getByRole('button', { name: 'Thumbnails', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Page thumbnails' }).getByRole('listitem')).toHaveCount(tops.length);
  await tab.getByRole('button', { name: 'Vertical', exact: true }).click();
  await expect(page.locator('.canvas-pages')).not.toHaveClass(/is-side-to-side/);
  await tab.getByLabel('Gridlines').check();
  await expect(tab.getByLabel('Gridlines')).toBeChecked();
  await tab.getByRole('button', { name: 'Split', exact: true }).click();
  const pane = page.locator('.view-split-pane');
  await expect(pane.locator('canvas')).toHaveCount(tops.length);
  // A click in the second pane puts the caret there in the document.
  await caret(input, 0);
  const box = await pane.locator('canvas').first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.2);
  expect(await input.evaluate(el => el.selectionStart)).toBeGreaterThan(0);
  await (await viewTab(page)).getByRole('button', { name: 'Split', exact: true }).click();
  await expect(pane).toHaveCount(0);
});

test('New Window shows a live copy that follows edits', async ({ page, context }) => {
  const input = await headings(page);
  const opened = context.waitForEvent('page');
  await (await viewTab(page)).getByRole('button', { name: 'New Window', exact: true }).click();
  const second = await opened;
  await second.waitForLoadState();
  await expect(second.locator('canvas.canvas-page').first()).toBeVisible();
  await expect(second.locator('.mirror-status')).toHaveText(/Updated/);
  const textOf = () => second.locator('textarea.canvas-input').inputValue();
  expect(await textOf()).toContain('Introduction');
  await caret(input, -1);
  await input.pressSequentially(' Seen in the other window.');
  await expect.poll(textOf, { timeout: 8000 }).toContain('Seen in the other window.');
});

test('a document saved in Outline view opens there and its direct level promotes', async ({ page }, info) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles('tests/fixtures/document-views/outline.docx');
  const outline = page.getByRole('tree', { name: 'Document outline' });
  await expect(outline).toBeVisible();
  await expect(outline.getByRole('treeitem')).toHaveCount(10);
  const note = page.locator('.outline-row', { hasText: 'A direct level three note' });
  await expect(note).toHaveAttribute('aria-level', '3');
  await note.locator('.outline-text').click();
  await page.keyboard.press('Shift+Tab');
  await expect(note).toHaveAttribute('aria-level', '2');
  // Collapse Plan: its subtree hides; Show First Line Only keeps headings whole.
  await page.locator('.outline-row', { hasText: 'Plan' }).first().locator('.outline-symbol').dblclick();
  await expect(outline.getByRole('treeitem')).toHaveCount(4);
  const saved = await download(page, info, 'outline-fixture');
  expect(settingsXml(saved)).toContain('<w:view w:val="outline"/>');
  expect(strFromU8(parts(saved)['word/document.xml'])).toMatch(/<w:pStyle w:val="Heading2"\/><\/w:pPr><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>A direct level three note/);
});
