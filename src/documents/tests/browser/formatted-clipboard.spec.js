import { test, expect } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { downloadDocx, onTab, showAllTools } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const style = page => page.getByRole('combobox', { name: 'Paragraph style', exact: true });
async function select(page, text, from = 0, length = text.length) {
  await input(page).evaluate((el, [text, from, length]) => { const at = el.value.indexOf(text, from); if (at < 0) throw Error(text); el.focus(); el.setSelectionRange(at, at + length); el.dispatchEvent(new Event('select')); }, [text, from, length]);
}
async function state(page, text, from = 0) {
  await select(page, text, from); await onTab(page, 'home');
  return { style: await style(page).inputValue(), bold: await button(page, 'Bold').getAttribute('aria-pressed'), italic: await button(page, 'Italic').getAttribute('aria-pressed'), bullets: await button(page, 'Bulleted list').getAttribute('aria-pressed') };
}
const paste = (page, html, text) => input(page).evaluate((el, [html, text]) => {
  el.focus(); const data = new DataTransfer(); if (html) data.setData('text/html', html); data.setData('text/plain', text);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, [html, text]);
async function blank(page) {
  await page.goto('/mock.html#/new');
  await expect(button(page, 'Bold')).toBeEnabled();
  await showAllTools(page); // the Paragraph style list is in the Formatting Pane
}

test('copy and paste inside a document keeps headings, lists and text formatting in one undo step', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  try {
    await blank(page);
    await input(page).fill('Plan\nBold start then plain\nFirst item\nSecond item\n');
    await select(page, 'Plan'); await style(page).selectOption('Heading1');
    await select(page, 'Bold start'); await input(page).press('ControlOrMeta+b');
    await select(page, 'then'); await input(page).press('ControlOrMeta+i');
    await select(page, 'First item\nSecond item'); await button(page, 'Bulleted list').click();
    // The whole block, including the last item's paragraph mark.
    await select(page, 'Plan\nBold start then plain\nFirst item\nSecond item\n'); await input(page).press('ControlOrMeta+c');
    const html = await page.evaluate(async () => { const [item] = await navigator.clipboard.read(); return item.types.includes('text/html') ? (await item.getType('text/html')).text() : ''; });
    expect(html).toMatch(/<h1[ >]/); expect(html).toMatch(/<b><span[^>]*>Bold start<\/span><\/b>/); expect(html).toMatch(/<ul><li[ >]/);
    await input(page).press('ControlOrMeta+End'); await input(page).press('ControlOrMeta+v');
    const value = 'Plan\nBold start then plain\nFirst item\nSecond item\n';
    await expect(input(page)).toHaveValue(value + value);
    const second = value.length;
    expect(await state(page, 'Plan', second)).toEqual({ style: 'Heading1', bold: 'true', italic: 'false', bullets: 'false' });
    expect(await state(page, 'Bold start', second)).toMatchObject({ style: 'Normal', bold: 'true', italic: 'false' });
    expect(await state(page, 'then', second)).toMatchObject({ bold: 'false', italic: 'true' });
    expect(await state(page, 'plain', second)).toMatchObject({ bold: 'false', italic: 'false' });
    expect(await state(page, 'Second item', second)).toMatchObject({ bullets: 'true' });
    await input(page).press('ControlOrMeta+z');
    await expect(input(page)).toHaveValue(value);
    // A phrase pasted into a heading takes the heading's formatting, keeping its own emphasis.
    await select(page, 'then'); await input(page).press('ControlOrMeta+c');
    await select(page, 'Plan', 0, 0); await page.keyboard.press('End'); await page.keyboard.type(' ');
    await input(page).press('ControlOrMeta+v');
    await expect(input(page)).toHaveValue(value.replace('Plan', 'Plan then'));
    expect(await state(page, 'then')).toMatchObject({ style: 'Heading1', italic: 'true' });
    // Cut and the Edit menu use the same formatting.
    await select(page, 'Bold start'); await input(page).press('ControlOrMeta+x');
    await select(page, 'plain', 0, 0); await page.keyboard.press('End');
    await page.locator('.ribbon-card').getByRole('button', { name: 'Paste', exact: true }).click();
    await expect(input(page)).toHaveValue(/ then plainBold start\n/);
    expect(await state(page, 'Bold start')).toMatchObject({ bold: 'true' });
  } finally { await context.close(); }
});

test('HTML from another application keeps headings, lists, emphasis, color and links', async ({ page }, info) => {
  await blank(page);
  const docs = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><h2><span style="font-weight:400">Project plan</span></h2>'
    + '<p><span style="font-weight:400">Normal and </span><span style="font-weight:700">bold</span><span> and </span><span style="color:#ff0000;font-style:italic">red italic</span> with a <a href="https://example.com/">link</a>.</p>'
    + '<ul><li><p><span>First item</span></p></li><li><p><span>Second item</span></p></li></ul></b><br class="Apple-interchange-newline">';
  await paste(page, docs, 'ignored plain text');
  await expect(input(page)).toHaveValue('Project plan\nNormal and bold and red italic with a link.\nFirst item\nSecond item');
  expect(await state(page, 'Project plan')).toMatchObject({ style: 'Heading2' });
  expect(await state(page, 'Normal and')).toMatchObject({ style: 'Normal', bold: 'false' });
  expect(await state(page, 'bold')).toMatchObject({ bold: 'true' });
  expect(await state(page, 'red italic')).toMatchObject({ italic: 'true' });
  await expect(page.getByRole('button', { name: 'Text color' })).toHaveAttribute('title', 'Text color: #FF0000');
  for (const item of ['First item', 'Second item']) expect(await state(page, item)).toMatchObject({ bullets: 'true' });
  await select(page, 'link'); await onTab(page, 'insert'); await expect(button(page, 'Insert or edit link')).toHaveAttribute('aria-pressed', 'true');
  await input(page).press('ControlOrMeta+z'); await expect(input(page)).toHaveValue('');
  await input(page).press('ControlOrMeta+Shift+z');
  const download = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath('pasted.docx'); await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
  expect(xml).toContain('<w:pStyle w:val="Heading2"/>'); expect(xml).toContain('<w:hyperlink'); expect(xml).toContain('<w:color w:val="FF0000"/>');
});

test('plain text and unsupported destinations keep the plain-text paste', async ({ page }) => {
  await blank(page);
  await paste(page, '', 'Just text\nTwo lines');
  await expect(input(page)).toHaveValue('Just text\nTwo lines');
  // Inside a table cell the plain text goes in as before.
  await input(page).press('ControlOrMeta+End'); await page.keyboard.press('Enter');
  await onTab(page, 'insert'); await button(page, 'Insert table').click(); await page.getByRole('menu', { name: 'Insert table' }).getByRole('menuitem', { name: '2 columns, 2 rows' }).click();
  await paste(page, '<h1>Heading</h1>', 'Cell text');
  await expect(input(page)).toHaveValue(/Cell text/);
});

test('Paste without formatting inserts only the text, from the keyboard or the Edit menu', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  try {
    await blank(page);
    await page.evaluate(async () => navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['Rich words'], { type: 'text/plain' }), 'text/html': new Blob(['<h1><b>Rich</b> words</h1>'], { type: 'text/html' }) })]));
    await input(page).focus();
    await input(page).press('ControlOrMeta+Shift+v');
    await expect(input(page)).toHaveValue('Rich words');
    expect(await state(page, 'Rich')).toMatchObject({ style: 'Normal', bold: 'false' });
    await input(page).press('ControlOrMeta+End');
    await page.getByRole('button', { name: 'Paste options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Keep Text Only', exact: true }).click();
    await expect(input(page)).toHaveValue('Rich wordsRich words');
    expect(await state(page, 'Rich', 5)).toMatchObject({ style: 'Normal', bold: 'false' });
    // The ordinary paste keeps the character formatting; one block joins the current paragraph.
    await input(page).press('ControlOrMeta+End'); await input(page).press('ControlOrMeta+v');
    await expect(input(page)).toHaveValue('Rich wordsRich wordsRich words');
    expect(await state(page, 'Rich', 12)).toMatchObject({ style: 'Normal', bold: 'true' });
  } finally { await context.close(); }
});

test('a note reference copies as the mark it shows, and pasting back adds no stray object character', async ({ page }) => {
  await page.goto('/playground.html');
  const field = input(page), previous = await field.elementHandle();
  await page.getByLabel('Open DOCX file').setInputFiles('tests/fixtures/footnote-recovery/chicago.docx');
  await expect.poll(() => previous.evaluate(e => e.isConnected)).toBe(false);
  await expect(field).toHaveJSProperty('readOnly', false);
  const objects = async () => [...await field.inputValue()].filter(c => c === '￼').length;
  const before = await objects();
  // The claim and the note reference after it.
  await select(page, 'First annotated claim', 0, 'First annotated claim'.length + 1);
  const copied = await field.evaluate(el => { const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })); return data.getData('text/plain'); });
  expect(copied).toBe('First annotated claim‡');
  await field.press('ControlOrMeta+End');
  await paste(page, '', copied + '￼');
  await expect(field).toHaveValue(/First annotated claim‡$/);
  expect(await objects()).toBe(before);
});

test('a copied phone or email link stays a link in the HTML other applications paste', async ({ page }) => {
  await blank(page);
  await input(page).fill('Call us or write');
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(0, 7); e.setHyperlink('tel:+1-555-0100'); e.model.select(11, 16); e.setHyperlink('mailto:team@example.com'); });
  await select(page, 'Call us or write');
  const html = await input(page).evaluate(el => { const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })); return data.getData('text/html'); });
  expect(html).toContain('<a href="tel:+1-555-0100">');
  expect(html).toContain('<a href="mailto:team@example.com">');
});

test('tabs and runs of spaces stay in the HTML a copy gives other applications', async ({ page }) => {
  await blank(page);
  await input(page).fill('Name\tQty   (three spaces)\nPens\t2');
  await select(page, 'Name\tQty   (three spaces)\nPens\t2');
  const html = await input(page).evaluate(el => {
    const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/html');
  });
  // Another web application's rich-text field takes the HTML as it is.
  const pasted = await page.evaluate(html => {
    const box = document.createElement('div'); box.contentEditable = 'true'; document.body.append(box); box.focus();
    document.execCommand('insertHTML', false, html);
    const lines = [...box.querySelectorAll('p')].map(p => p.innerText); box.remove(); return lines;
  }, html);
  expect(pasted).toEqual(['Name\tQty   (three spaces)', 'Pens\t2']);
});
