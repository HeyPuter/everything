import { test, expect } from '@playwright/test';
import { showAllTools } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const runs = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.map(r => [r.text, !!r.link, r.color, r.underlineStyle]));
async function link(page, address) {
  await input(page).press('ControlOrMeta+k');
  await page.getByLabel('Link address', { exact: true }).fill(address);
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
}

test('a new link is blue and underlined, and typing after it continues as plain text', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Read the guide. See ');
  await input(page).evaluate(el => { el.setSelectionRange(9, 14); el.dispatchEvent(new Event('select')); });
  await link(page, 'https://example.com/guide');
  await input(page).press('ControlOrMeta+End');
  await link(page, 'https://example.com');
  await page.keyboard.type(' too');
  expect(await runs(page)).toEqual([
    ['Read the ', false, 'auto', 'none'], ['guide', true, '0563C1', 'single'], ['. See ', false, 'auto', 'none'],
    ['https://example.com', true, '0563C1', 'single'], [' too', false, 'auto', 'none']]);
  // Changing where a link goes keeps the way it looks.
  await input(page).evaluate(el => { el.setSelectionRange(10, 10); el.dispatchEvent(new Event('select')); });
  await link(page, 'https://example.org/');
  expect((await runs(page))[1]).toEqual(['guide', true, '0563C1', 'single']);
  // Creating a link and its look is one undo step.
  // Undo the address change, then " too" (two word steps), then the inserted link.
  for (let i = 0; i < 3; i++) await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('Read the guide. See https://example.com');
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('Read the guide. See ');
  expect(await runs(page)).toEqual([['Read the ', false, 'auto', 'none'], ['guide', true, '0563C1', 'single'], ['. See ', false, 'auto', 'none']]);
  await input(page).press('ControlOrMeta+z');
  expect(await runs(page)).toEqual([['Read the guide. See ', false, 'auto', 'none']]);
});

test('links pasted or imported without their own color look like links', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).evaluate(el => {
    el.focus(); const data = new DataTransfer(); data.setData('text/html', '<p>Visit <a href="https://example.com/">the site</a> now</p>'); data.setData('text/plain', 'Visit the site now');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect(await runs(page)).toEqual([['Visit ', false, 'auto', 'none'], ['the site', true, '0563C1', 'single'], [' now', false, 'auto', 'none']]);
});

const caret = (page, at) => input(page).evaluate((el, at) => { el.focus(); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); }, at);
// An address typed on a line of its own is linked by the new line; another is linked inside a sentence.
async function typeAddresses(page) {
  await input(page).focus();
  await page.keyboard.type('john@example.com'); await page.keyboard.press('Enter'); await page.keyboard.type('Write to mary@example.com today');
  await expect(input(page)).toHaveValue('john@example.com\nWrite to mary@example.com today');
}

test('removing a link takes the look of a link off its text, in one undo step', async ({ page }) => {
  // Each paragraph's text in stretches of one look: [text, linked, color, underline].
  const looks = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.map(p => p.runs.reduce((all, r) => {
    const look = [!!r.link, r.color, r.underlineStyle], last = all.at(-1);
    if (last && String(last.slice(1)) === String(look)) last[0] += r.text; else all.push([r.text, ...look]);
    return all;
  }, [])));
  await page.goto('/mock.html#/new'); await showAllTools(page);
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await typeAddresses(page);
  const linked = [[['john@example.com', true, '0563C1', 'single']],
    [['Write to ', false, 'auto', 'none'], ['mary@example.com', true, '0563C1', 'single'], [' today', false, 'auto', 'none']]];
  expect(await looks()).toEqual(linked);
  const unlink = page.getByRole('button', { name: 'Remove link', exact: true });
  await caret(page, 4); await unlink.click();
  expect(await looks()).toEqual([[['john@example.com', false, 'auto', 'none']], linked[1]]);
  await caret(page, 30); await unlink.click();
  const plain = [[['john@example.com', false, 'auto', 'none']], [['Write to mary@example.com today', false, 'auto', 'none']]];
  expect(await looks()).toEqual(plain);
  // The link and its look come back together.
  await input(page).press('ControlOrMeta+z');
  expect(await looks()).toEqual([[['john@example.com', false, 'auto', 'none']], linked[1]]);
  await input(page).press('ControlOrMeta+z');
  expect(await looks()).toEqual(linked);
});

test('a document downloaded after removing typed links has neither the links nor their look', async ({ page }, info) => {
  await page.goto('/playground.html'); await showAllTools(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  await typeAddresses(page);
  const save = async name => {
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const path = info.outputPath(name); await (await event).saveAs(path);
    return [path, strFromU8(unzipSync(readFileSync(path))['word/document.xml'])];
  };
  const [, before] = await save('typed-addresses.docx');
  expect(before.match(/<w:hyperlink /g)).toHaveLength(2); expect(before).toContain('w:val="0563C1"');
  const unlink = page.getByRole('button', { name: 'Remove link', exact: true });
  await caret(page, 4); await unlink.click(); await caret(page, 30); await unlink.click();
  const text = await input(page).inputValue(), [path, after] = await save('unlinked-addresses.docx');
  expect(after).not.toContain('<w:hyperlink'); expect(after).not.toContain('0563C1'); expect(after).not.toContain('w:val="single"');
  expect(after).toContain('john@example.com'); expect(after).toContain('mary@example.com');
  await reopenDocx(page, input(page), path, text);
});
