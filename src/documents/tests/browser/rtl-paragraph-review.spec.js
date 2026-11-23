import { test, expect } from '@playwright/test';
import { showAllTools, onTab } from './helpers/editor-tools.js';

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
