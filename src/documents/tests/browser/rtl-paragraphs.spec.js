import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { showAllTools } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

// Right-to-left paragraphs (ECMA-376 Part 1 §17.3.1.6 bidi). The fixture is written directly as
// WordprocessingML by tools/rtl_paragraph_fixture.py. The page is 8.5in wide with 1in margins: the
// text area runs from x=96 to x=720 CSS pixels.
const LEFT = 96, RIGHT = 720;

async function fixture(page) {
  await page.goto('/playground.html'); await showAllTools(page);
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/rtl-paragraphs.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Left to right paragraph/); return input;
}
async function choose(input, text, end) {
  await input.evaluate((el, { text, end }) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text'); el.setSelectionRange(at, end ? el.value.indexOf(end) + end.length : at); el.dispatchEvent(new Event('select', { bubbles: true })); }, { text, end });
}
async function download(page, info, name) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name); await (await event).saveAs(path); return path;
}
/** The horizontal extent of the ink on the first page between two heights, in CSS pixels. */
async function inkExtent(page, top, bottom) {
  return page.locator('canvas.canvas-page').first().evaluate((canvas, { top, bottom }) => {
    const scale = canvas.width / canvas.clientWidth, ctx = canvas.getContext('2d');
    const y = Math.round(top * scale), height = Math.round((bottom - top) * scale), data = ctx.getImageData(0, y, canvas.width, height).data;
    let min = Infinity, max = -Infinity;
    for (let row = 0; row < height; row++) for (let x = 0; x < canvas.width; x++) {
      const i = (row * canvas.width + x) * 4;
      // Text ink only: the blue caret and pale selection are not dark on every channel.
      if (data[i] < 110 && data[i + 1] < 110 && data[i + 2] < 110 && data[i + 3] > 200) { if (x < min) min = x; if (x > max) max = x; }
    }
    return { left: min / scale, right: (max + 1) / scale };
  }, { top, bottom });
}
const xml = path => strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
const paragraphXml = (path, text) => xml(path).match(/<w:p[ >].*?<\/w:p>/gs).find(p => p.includes(`>${text}<`));

test('opens right-to-left paragraphs for editing and lays them out from the right margin', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page);
  await expect(input).toHaveJSProperty('readOnly', false);
  await expect(page.locator('.canvas-message')).toBeHidden();
  const png = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(info.outputPath('rtl-paragraphs.png'), Buffer.from(png, 'base64'));
  // The first paragraph (left to right) starts at the left margin; the Hebrew one below it ends at the right.
  const first = await inkExtent(page, 96, 116), hebrew = await inkExtent(page, 124, 146);
  expect(first.left).toBeGreaterThan(LEFT - 1); expect(first.left).toBeLessThan(LEFT + 4); expect(first.right).toBeLessThan(400);
  expect(hebrew.right).toBeLessThan(RIGHT + 1); expect(hebrew.right).toBeGreaterThan(RIGHT - 4); expect(hebrew.left).toBeGreaterThan(400);
  const rtl = page.getByRole('button', { name: 'Right-to-Left Text Direction', exact: true });
  const alignLeft = page.getByRole('button', { name: 'Align left', exact: true }), alignRight = page.getByRole('button', { name: 'Align right', exact: true });
  await expect(rtl).toHaveAttribute('aria-pressed', 'false'); await expect(alignLeft).toHaveAttribute('aria-pressed', 'true');
  // A right-to-left paragraph starts at the right: the alignment buttons name the side on the page.
  await choose(input, 'mixed'); await expect(rtl).toHaveAttribute('aria-pressed', 'true');
  await expect(alignRight).toHaveAttribute('aria-pressed', 'true'); await expect(alignLeft).toHaveAttribute('aria-pressed', 'false');
  // w:jc right there is the trailing (left) side.
  await choose(input, 'Trailing side'); await expect(alignLeft).toHaveAttribute('aria-pressed', 'true');
  await choose(input, 'Styled direction'); await expect(rtl).toHaveAttribute('aria-pressed', 'true');
  await choose(input, 'Explicit left to right'); await expect(rtl).toHaveAttribute('aria-pressed', 'false');
  await choose(input, 'Left to right paragraph', 'mixed'); await expect(rtl).toHaveAttribute('aria-pressed', 'mixed');
  // The Format menu lists both directions, with the paragraph's own checked.
  await choose(input, 'mixed');
  await page.getByRole('menuitem', { name: 'Format', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Text Direction', exact: true }).hover();
  const menuRtl = page.getByRole('menuitemradio', { name: 'Right-to-Left', exact: true }), menuLtr = page.getByRole('menuitemradio', { name: 'Left-to-Right', exact: true });
  await expect(menuRtl).toHaveAttribute('aria-checked', 'true'); await expect(menuLtr).toHaveAttribute('aria-checked', 'false');
  // Choosing the direction a paragraph already has keeps it (the ribbon's button is the one that toggles).
  await menuRtl.click(); await expect(rtl).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('menuitem', { name: 'Format', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Text Direction', exact: true }).hover();
  await menuLtr.click(); await expect(rtl).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(rtl).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('changes paragraph direction and alignment from the ribbon, with undo, and saves w:bidi', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page), original = await input.inputValue();
  const rtl = page.getByRole('button', { name: 'Right-to-Left Text Direction', exact: true });
  const alignLeft = page.getByRole('button', { name: 'Align left', exact: true }), alignRight = page.getByRole('button', { name: 'Align right', exact: true }), undo = page.getByRole('button', { name: 'Undo', exact: true });
  await choose(input, 'Left to right paragraph');
  await rtl.click(); await expect(input).toBeFocused();
  await expect(rtl).toHaveAttribute('aria-pressed', 'true'); await expect(alignRight).toHaveAttribute('aria-pressed', 'true');
  // The whole paragraph turns over: it now ends at the right margin.
  await expect.poll(async () => (await inkExtent(page, 96, 116)).right).toBeGreaterThan(RIGHT - 4);
  expect((await inkExtent(page, 96, 116)).left).toBeGreaterThan(400);
  await undo.click(); await expect(rtl).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await inkExtent(page, 96, 116)).left).toBeLessThan(LEFT + 4);
  await rtl.click(); await expect(rtl).toHaveAttribute('aria-pressed', 'true');
  // Align left in a right-to-left paragraph is its trailing side, stored as w:jc right.
  await alignLeft.click(); await expect(alignLeft).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await inkExtent(page, 96, 116)).left).toBeLessThan(LEFT + 4);
  await input.press('ControlOrMeta+r'); await expect(alignRight).toHaveAttribute('aria-pressed', 'true');
  await alignLeft.click();
  // The same button turns a right-to-left paragraph back.
  await choose(input, 'Trailing side'); await expect(rtl).toHaveAttribute('aria-pressed', 'true'); await rtl.click(); await expect(rtl).toHaveAttribute('aria-pressed', 'false');
  // Its stored w:jc right is now the right side of a left-to-right paragraph.
  await expect(alignRight).toHaveAttribute('aria-pressed', 'true');
  const saved = await download(page, info, 'rtl-edited.docx');
  expect(paragraphXml(saved, 'Left to right paragraph')).toContain('<w:pPr><w:bidi w:val="1"/><w:jc w:val="right"/></w:pPr>');
  expect(paragraphXml(saved, 'Trailing side')).toContain('<w:pPr><w:bidi w:val="0"/><w:jc w:val="right"/></w:pPr>');
  expect(xml(saved)).toContain('<w:bidi/></w:sectPr>');
  await reopenDocx(page, input, saved, original);
  await expect(input).toHaveJSProperty('readOnly', false);
  await choose(input, 'Left to right paragraph'); await expect(rtl).toHaveAttribute('aria-pressed', 'true'); await expect(alignLeft).toHaveAttribute('aria-pressed', 'true');
  await choose(input, 'Trailing side'); await expect(rtl).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('moves the caret leftwards with the Left arrow in a right-to-left paragraph and types there', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page);
  const focus = () => input.evaluate(el => el.selectionStart), start = (await input.inputValue()).indexOf('שלום');
  await choose(input, 'שלום');
  // Left goes on through the text, Right comes back; in the left-to-right paragraph above it is the reverse.
  await input.press('ArrowLeft'); await expect.poll(focus).toBe(start + 1);
  await input.press('ArrowLeft'); await expect.poll(focus).toBe(start + 2);
  await input.press('ArrowRight'); await expect.poll(focus).toBe(start + 1);
  await input.press('Shift+ArrowLeft'); expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([start + 1, start + 2]);
  await input.press('Home'); await expect.poll(focus).toBe(start);
  await input.press('End'); await expect.poll(focus).toBe(start + 'שלום עולם mixed 123.'.length);
  // Cmd+Right goes to the line's right end, which is its start here.
  await input.press('Meta+ArrowRight'); await expect.poll(focus).toBe(start);
  await input.press('Meta+ArrowLeft'); await expect.poll(focus).toBe(start + 'שלום עולם mixed 123.'.length);
  await choose(input, 'Left to right paragraph');
  await input.press('ArrowRight'); await expect.poll(focus).toBe(1);
  await input.press('ArrowLeft'); await expect.poll(focus).toBe(0);
  // A new paragraph after a right-to-left one is right-to-left too; typed Hebrew starts at the right margin.
  await choose(input, 'שלום'); await input.press('End'); await input.press('Enter');
  // Typed key by key, as a person does: a Hebrew sentence with a Latin phrase and a number in it.
  for (const key of 'עברית abc def, 12 אב.') await page.keyboard.insertText(key);
  await expect(page.getByRole('button', { name: 'Right-to-Left Text Direction', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await inkExtent(page, 152, 172)).right).toBeGreaterThan(RIGHT - 4);
  const png = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(info.outputPath('rtl-typed.png'), Buffer.from(png, 'base64'));
  const saved = await download(page, info, 'rtl-typed.docx'), typed = paragraphXml(saved, 'עברית ');
  expect(typed).toMatch(/<w:pPr><w:bidi\/>/);
  // The file states each run's direction (w:rtl), so another word processor orders the sentence the same way:
  // Hebrew with its spaces and period right-to-left; the Latin phrase, with the number that follows it, ordinary.
  const runs = [...typed.matchAll(/<w:r>(.*?)<\/w:r>/gs)].map(m => [m[1].match(/<w:t[^>]*>(.*?)<\/w:t>/s)[1], /<w:rtl\/>|<w:rtl w:val="1"\/>/.test(m[1])]);
  expect(runs.filter(r => r[1]).map(r => r[0]).join('|')).toBe('עברית | אב.');
  expect(runs.filter(r => !r[1]).map(r => r[0]).join('|')).toBe('abc def, 12');
  expect(errors).toEqual([]);
});

test('shows and sets direction in the Paragraph dialog and mirrors the ruler', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page);
  await choose(input, 'Label');
  // w:ind left=1440 hanging=720 is measured from the right margin: the handles sit 1in and 0.5in inside it.
  const handle = name => page.locator('.canvas-ruler-handle').and(page.getByRole('slider', { name, exact: true }));
  const offset = async name => Number.parseFloat(await handle(name).evaluate(el => el.style.left));
  expect(await offset('Right indent')).toBeCloseTo(RIGHT - 96, 0);
  expect(await offset('First line indent')).toBeCloseTo(RIGHT - 48, 0);
  expect(await offset('Left indent')).toBeCloseTo(LEFT, 0);
  await input.press('ControlOrMeta+Alt+m');
  const dialog = page.getByRole('dialog', { name: 'Paragraph' }), direction = dialog.getByRole('combobox', { name: 'Direction', exact: true }), alignment = dialog.getByRole('combobox', { name: 'Alignment', exact: true });
  await expect(direction).toHaveValue('rtl'); await expect(alignment).toHaveValue('right');
  await expect(dialog.locator('.field-label').getByText('Before text', { exact: true })).toBeVisible();
  // Switching direction keeps the stored alignment: the side shown flips with the paragraph.
  await direction.selectOption('ltr'); await expect(alignment).toHaveValue('left'); await expect(dialog.locator('.field-label').getByText('Left', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'OK', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Right-to-Left Text Direction', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Align left', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await offset('Left indent')).toBeCloseTo(LEFT + 96, 0);
  expect(await offset('Right indent')).toBeCloseTo(RIGHT, 0);
  expect(errors).toEqual([]);
});
