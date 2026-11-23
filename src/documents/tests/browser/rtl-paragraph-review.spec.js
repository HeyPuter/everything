import { test, expect } from '@playwright/test';
import { showAllTools, onTab, downloadDocx } from './helpers/editor-tools.js';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

// Right-to-left paragraphs (ECMA-376 Part 1 §17.3.1.6 bidi) where other commands meet them. The fixture
// is written directly as WordprocessingML by tools/rtl_paragraph_fixture.py; its page is 8.5in wide
// with 1in margins, and its table's first cell runs from x=96 to x=408 CSS pixels.
async function fixture(page) {
  await page.goto('/playground.html'); await showAllTools(page);
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/rtl-paragraphs.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Left to right paragraph/); return input;
}
async function choose(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text'); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
}
/** The horizontal extent of the text ink on the first page between two heights, in CSS pixels. */
async function inkExtent(page, top, bottom) {
  return page.locator('canvas.canvas-page').first().evaluate((canvas, { top, bottom }) => {
    const scale = canvas.width / canvas.clientWidth, ctx = canvas.getContext('2d');
    const y = Math.round(top * scale), height = Math.round((bottom - top) * scale), data = ctx.getImageData(0, y, canvas.width, height).data;
    let min = Infinity, max = -Infinity;
    for (let row = 0; row < height; row++) for (let x = 0; x < canvas.width; x++) {
      const i = (row * canvas.width + x) * 4;
      if (data[i] < 110 && data[i + 1] < 110 && data[i + 2] < 110 && data[i + 3] > 200) { if (x < min) min = x; if (x > max) max = x; }
    }
    return { left: min / scale, right: (max + 1) / scale };
  }, { top, bottom });
}

test('aligns right-to-left cell text to the side the cell alignment grid names', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page);
  await choose(input, 'Cell text');
  const tab = await onTab(page, 'tableLayout');
  const topRight = tab.getByRole('button', { name: 'Align Top Right', exact: true }), topLeft = tab.getByRole('button', { name: 'Align Top Left', exact: true });
  // The cell's paragraph starts at the cell's right edge (w:bidi, no w:jc).
  await expect(topRight).toHaveAttribute('aria-pressed', 'true'); await expect(topLeft).toHaveAttribute('aria-pressed', 'false');
  const before = await inkExtent(page, 406, 426);
  expect(before.right).toBeGreaterThan(380);
  await topLeft.click();
  await expect(topLeft).toHaveAttribute('aria-pressed', 'true'); await expect(topRight).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await inkExtent(page, 406, 426)).left).toBeLessThan(110);
  await topRight.click();
  await expect(topRight).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await inkExtent(page, 406, 426)).right).toBeGreaterThan(380);
  expect(errors).toEqual([]);
});

test('drops the first letter of a right-to-left paragraph at the right margin', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page), arabic = 'هذا نص عربي طويل';
  await choose(input, arabic);
  const ribbon = await onTab(page, 'insert');
  await ribbon.getByRole('button', { name: 'Drop Cap', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Dropped' }).click();
  // The letter moves into its own framed paragraph; laid out from the left, it filled the column and the
  // command failed ("Square-wrapped drawing placement did not converge").
  await expect.poll(() => input.inputValue()).toContain('ه\nذا نص عربي طويل');
  await expect(page.locator('.canvas-message')).toBeHidden();
  // The cap stands at the right margin, beside the paragraph's first lines.
  const cap = await inkExtent(page, 150, 200);
  expect(cap.right).toBeGreaterThan(714); expect(cap.right).toBeLessThan(722);
  expect(errors).toEqual([]);
});

test('sets the font, bold and italic that right-to-left text shows from the Font dialog', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page), arabic = 'هذا نص عربي طويل';
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, arabic);
  await onTab(page, 'home');
  await input.press('ControlOrMeta+d');
  const dialog = page.getByRole('dialog', { name: 'Font' });
  // Arabic letters are shown in the complex script font (w:rFonts/@w:cs), which Font alone leaves as it was.
  const cs = dialog.getByRole('combobox', { name: 'Complex script font', exact: true });
  await cs.fill('Oswald');
  await dialog.getByLabel('Font style').selectOption('bold');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(dialog).toBeHidden();
  const event = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath('rtl-font.docx'); await (await event).saveAs(path);
  const xml = strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
  const run = xml.split('<w:r>').find(r => r.includes(arabic.slice(0, 3)));
  expect(run).toMatch(/w:cs="Oswald"/); expect(run).toMatch(/<w:bCs\/>|<w:bCs w:val="1"\/>/);
  // Left-to-right text offers no such field.
  await choose(input, 'Left to right paragraph');
  await input.press('ControlOrMeta+d');
  await expect(dialog.getByRole('combobox', { name: 'Font', exact: true })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Complex script font', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

/** Whether a text element shows its last character left of its first, as right-to-left text does. */
const readsRightToLeft = locator => locator.evaluate(el => {
  const text = el.firstChild, at = i => { const r = document.createRange(); r.setStart(text, i); r.setEnd(text, i + 1); return r.getBoundingClientRect().left; };
  return at(text.length - 1) < at(0);
});

test('shows right-to-left headings and paragraphs right-to-left in the Navigation pane and Outline view', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('מה חדש?\nגוף הטקסט.\nWhat is new?');
  await input.evaluate(el => { el.setSelectionRange(0, el.value.indexOf('What')); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await (await onTab(page, 'home')).getByRole('button', { name: 'Right-to-Left Text Direction', exact: true }).click();
  for (const text of ['מה חדש?', 'What is new?']) {
    await choose(input, text); await input.press('Control+Alt+1');
  }
  await (await onTab(page, 'view')).locator('.ribbon-card').getByRole('button', { name: 'Navigation Pane' }).click();
  const tree = page.getByRole('complementary', { name: 'Navigation' }).getByRole('tree', { name: 'Headings' });
  await expect(tree.getByRole('treeitem')).toHaveText(['מה חדש?', 'What is new?']);
  // The question mark ends the Hebrew heading at its left, as the page shows it.
  expect(await readsRightToLeft(tree.getByRole('treeitem').first().locator('span'))).toBe(true);
  expect(await readsRightToLeft(tree.getByRole('treeitem').nth(1).locator('span'))).toBe(false);
  await (await onTab(page, 'view')).locator('.ribbon-card').getByRole('button', { name: 'Outline', exact: true }).click();
  const row = text => page.locator('.outline-row', { hasText: text }).locator('.outline-text');
  await expect(row('גוף הטקסט.')).toHaveAttribute('dir', 'rtl');
  expect(await readsRightToLeft(row('גוף הטקסט.'))).toBe(true);
  await expect(row('What is new?')).not.toHaveAttribute('dir', 'rtl');
  expect(errors).toEqual([]);
});

test('lists a Hebrew comment right-to-left, as its card shows it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Alpha beta gamma.');
  await input.evaluate(el => { el.setSelectionRange(6, 10); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await onTab(page, 'review');
  await page.locator('#ribbon-panel-review').getByRole('button', { name: 'New Comment', exact: true }).click();
  await page.locator('.ed-comment-draft textarea').fill('מה דעתך?');
  await page.locator('.ed-comment-draft').getByRole('button', { name: 'Post' }).click();
  expect(await readsRightToLeft(page.locator('.ed-comment-card .wcc-text'))).toBe(true);
  await page.getByRole('button', { name: 'Show Comments options' }).filter({ visible: true }).first().click();
  await page.getByRole('menuitemradio', { name: 'List' }).click();
  const text = page.getByRole('list', { name: 'Comments' }).locator('.rv-comment-text');
  await expect(text).toHaveText('מה דעתך?');
  // The question mark ends the comment at its left.
  expect(await readsRightToLeft(text)).toBe(true);
  expect(errors).toEqual([]);
});
