import { openReadOnlyPreview } from './helpers/preview.js';
import { showAllTools, onTab } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
const TARGET = 'https://example.com/guide?q=one%20two&lang=en#section';
async function choose(input, text, collapsed = false) { await input.evaluate((el, { text, collapsed }) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text'); el.setSelectionRange(collapsed ? at + 1 : at, collapsed ? at + 1 : at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, { text, collapsed }); }
async function download(page, info, name) { const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name); await (await event).saveAs(path); return path; }
async function dialog(page, input) { await input.focus(); await input.press('ControlOrMeta+k'); await expect(page.getByRole('dialog')).toBeVisible(); }
async function apply(page) { await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused(); }
async function stubOpen(page) { await page.addInitScript(() => { window.linkOpens = []; window.open = (...args) => { window.linkOpens.push(args); return null; }; }); }

test('edits shared external links with undo, retains formatting, removes a link and reopens the downloaded DOCX', async ({ page }, info) => {
  await stubOpen(page); await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/hyperlinks.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }), button = (await onTab(page, 'insert')).getByRole('button', { name: 'Insert or edit link', exact: true }); await expect(input).toHaveValue(/^External hyperlinks/); const text = await input.inputValue();
  await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true'); await choose(input, 'Read the guide', true); const range = await input.evaluate(el => [el.selectionStart, el.selectionEnd]);
  await dialog(page, input); await expect(page.getByRole('textbox', { name: 'Link address', exact: true })).toHaveValue(TARGET); await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('https://example.com/edited#new');
  await page.getByRole('dialog').screenshot({ path: info.outputPath('hyperlink-dialog.png'), animations: 'disabled' }); await apply(page); expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(range);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await dialog(page, input); await expect(page.getByRole('textbox', { name: 'Link address', exact: true })).toHaveValue(TARGET); await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await choose(input, 'Email us'); await page.getByRole('button', { name: 'Remove link', exact: true }).click(); await expect(button).toHaveAttribute('aria-pressed', 'false'); await expect((await onTab(page, 'home')).getByRole('button', { name: 'Underline', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const path = await download(page, info, 'hyperlinks.docx'); await reopenDocx(page, input, path, text); await choose(input, 'Read the guide', true); await dialog(page, input); await expect(page.getByRole('textbox', { name: 'Link address', exact: true })).toHaveValue('https://example.com/edited#new'); await page.getByRole('dialog').getByRole('button', { name: 'Open link', exact: true }).click();
  expect(await page.evaluate(() => window.linkOpens)).toEqual([['https://example.com/edited#new', '_blank', 'noopener,noreferrer']]); await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await choose(input, 'Same destination'); await dialog(page, input); await expect(page.getByRole('textbox', { name: 'Link address', exact: true })).toHaveValue(TARGET);
});

test('creates links using the keyboard and at an empty caret, validates addresses and exports plain source text', async ({ page }, info) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(''); await input.fill('New link á😀\nPlain\n'); await choose(input, 'New link á😀'); await dialog(page, input);
  await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('javascript:alert(1)'); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Only absolute'); await expect(input).toHaveValue('New link á😀\nPlain\n'); await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('https://example.com/new'); await apply(page);
  await input.press('ControlOrMeta+End'); await dialog(page, input); await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('mailto:new@example.com'); await page.getByRole('textbox', { name: 'Link text', exact: true }).fill('Mail'); await apply(page); await expect(input).toHaveValue('New link á😀\nPlain\nMail'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(input).toHaveValue('New link á😀\nPlain\n'); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const text = await input.inputValue(), path = await download(page, info, 'new-hyperlinks.docx'); await reopenDocx(page, input, path, text); await choose(input, 'Mail'); await dialog(page, input); await expect(page.getByRole('textbox', { name: 'Link address', exact: true })).toHaveValue('mailto:new@example.com'); await page.getByRole('dialog').getByRole('button', { name: 'Remove link', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(input).toHaveValue(text); await expect((await onTab(page, 'insert')).getByRole('button', { name: 'Insert or edit link', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('the link dialog completes a typed web or email address as typing it in the text would', async ({ page }, info) => {
  await page.goto('/playground.html'); await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' }); await input.fill('Visit\n');
  await choose(input, 'Visit'); await dialog(page, input);
  await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('example.com/docs'); await apply(page);
  await input.press('ControlOrMeta+End'); await dialog(page, input);
  await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('joe@example.com'); await apply(page);
  // With no selection the link shows the address as it was typed.
  await expect(input).toHaveValue('Visit\njoe@example.com');
  const rels = strFromU8(unzipSync(readFileSync(await download(page, info, 'completed-links.docx')))['word/_rels/document.xml.rels']);
  expect(rels).toContain('Target="https://example.com/docs"');
  expect(rels).toContain('Target="mailto:joe@example.com"');
});

test('Edit > Links keeps keyboard focus in its list while links are removed', async ({ page }) => {
  await page.goto('/playground.html'); await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' }); await input.fill('First link and second link');
  for (const [text, address] of [['First', 'https://a.example.com/'], ['second', 'https://b.example.com/']]) {
    await choose(input, text); await dialog(page, input);
    await page.getByRole('textbox', { name: 'Link address', exact: true }).fill(address); await apply(page);
  }
  await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Links…', exact: true }).click();
  const links = page.getByRole('dialog', { name: 'Links' });
  await links.getByRole('button', { name: 'Remove', exact: true }).first().focus();
  await page.keyboard.press('Enter');
  await expect(links.getByRole('listitem')).toHaveCount(1);
  await expect(links.getByRole('button', { name: 'Remove', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(links.getByRole('listitem')).toHaveCount(0);
  await expect(links.getByRole('button', { name: 'Close', exact: true }).last()).toBeFocused();
  await expect(links.getByRole('button', { name: 'Remove All Links' })).toBeDisabled();
});

test('Edit > Links opens with the keyboard on a control in the dialog', async ({ page }) => {
  await page.goto('/playground.html'); await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' }); await input.fill('No links yet');
  const openLinks = async () => {
    await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Links…', exact: true }).click();
    return page.getByRole('dialog', { name: 'Links' });
  };
  // Without links, Remove All Links is unavailable: the focus is on Close, not on the page body.
  let links = await openLinks();
  await expect(links.getByText('This document has no links.')).toBeVisible();
  await expect(links.getByRole('button', { name: 'Close', exact: true }).last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(links).toHaveCount(0);
  // With links, it starts on the first one rather than on Remove All Links.
  await choose(input, 'links'); await dialog(page, input);
  await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('https://a.example.com/'); await apply(page);
  links = await openLinks();
  await expect(links.getByRole('button', { name: /^links/ })).toBeFocused();
});

test('ordinary clicks select text while modified clicks open wrapped, picture and repeated-header links at zoom', async ({ page }, info) => {
  await stubOpen(page); const errors = []; page.on('pageerror', e => errors.push(e.message)); await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/hyperlinks.docx'); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^External hyperlinks/);
  const targets = await page.evaluate(async () => {
    const { DocxPackage } = await import('/src/engine/docx.js'), { layoutDocument, selectionRects } = await import('/src/engine/layout.js'), { hyperlinkRanges } = await import('/src/engine/hyperlinks.js'), { pageGeometry } = await import('/src/engine/page-settings.js'), { fontMetrics } = await import('/src/engine/font-metrics.js'), { setCanvasTextStyle } = await import('/src/engine/canvas-text.js');
    const p = await DocxPackage.open(new Uint8Array(await (await fetch('/fixtures/hyperlinks.docx')).arrayBuffer())), c = document.createElement('canvas').getContext('2d');
    const layout = layoutDocument(p.paragraphs, (text, style) => { setCanvasTextStyle(c, style); return { ...fontMetrics(style), width: c.measureText(text).width }; }, pageGeometry(p.pageSettings), p.numbering, p.tables);
    return ['guide?', '/wrapped', '/picture', '/header'].map(s => { const link = hyperlinkRanges(p.paragraphs).find(r => r.link.target.includes(s)), rects = selectionRects(layout, link.start, link.end); return { ...rects.at(-1), target: link.link.target, count: rects.length }; });
  }); expect(targets[1].count).toBeGreaterThan(1); expect(targets[3].count).toBeGreaterThan(1);
  const png = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(info.outputPath('hyperlinks.png'), Buffer.from(png, 'base64'));
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1.5');
  for (const t of targets) {
    const canvas = page.locator(`canvas[data-page="${t.page}"]`); await canvas.evaluate((c, y) => { const h = c.closest('.canvas-host'); h.scrollTop = c.offsetTop + y * 1.5 - h.clientHeight / 2; }, t.y + t.height / 2);
    const b = await canvas.boundingBox(), x = b.x + (t.x + t.width / 2) * 1.5, y = b.y + (t.y + t.height / 2) * 1.5;
    const before = await page.evaluate(() => window.linkOpens.length); await page.mouse.click(x, y); expect(await page.evaluate(() => window.linkOpens.length)).toBe(before); const selection = await input.evaluate(el => [el.selectionStart, el.selectionEnd]);
    await page.keyboard.down('ControlOrMeta'); await page.mouse.click(x, y); await page.keyboard.up('ControlOrMeta'); expect(await page.evaluate(() => window.linkOpens.at(-1))).toEqual([t.target, '_blank', 'noopener,noreferrer']); expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selection);
  }
  expect(errors).toEqual([]);
});

test('typing inside links extends them while typing at either edge and past paragraph breaks stays unlinked', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(''); await input.fill('abcdef'); await choose(input, 'bcde'); await dialog(page, input); await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('https://example.com/type'); await apply(page);
  await choose(input, 'bcde', true); await input.focus(); await page.keyboard.insertText('X'); await expect(input).toHaveValue('abXcdef'); await choose(input, 'bXcde'); await expect((await onTab(page, 'insert')).getByRole('button', { name: 'Insert or edit link', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await input.press('ArrowLeft'); await page.keyboard.insertText('L'); await choose(input, 'L'); await expect((await onTab(page, 'insert')).getByRole('button', { name: 'Insert or edit link', exact: true })).toHaveAttribute('aria-pressed', 'false'); await choose(input, 'bXcde'); await input.press('ArrowRight'); await page.keyboard.insertText('R'); await choose(input, 'R'); await expect((await onTab(page, 'insert')).getByRole('button', { name: 'Insert or edit link', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await choose(input, 'Xc', true); await input.press('Enter'); await page.keyboard.insertText('New'); await choose(input, 'New'); await expect((await onTab(page, 'insert')).getByRole('button', { name: 'Insert or edit link', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('previews broken, nested and active-script links as read-only with the original available', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^A small beginning/); const text = await input.inputValue();
  for (const kind of ['empty', 'nested', 'missing', 'script', 'CDATA']) {
    const parts = unzipSync(readFileSync('public/fixtures/hyperlinks.docx'));
    if (kind === 'script') parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('https://example.com/guide?q=one%20two&amp;lang=en#section', 'javascript:alert(1)'));
    else if (kind === 'CDATA') parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('</w:hyperlink>', '<![CDATA[unmodelled]]></w:hyperlink>'));
    else { const xml = strFromU8(parts['word/document.xml']); parts['word/document.xml'] = strToU8(kind === 'empty' ? xml.replace(/(<w:hyperlink r:id=")[^"]+/, '$1') : kind === 'missing' ? xml.replace(/(<w:hyperlink r:id=")[^"]+/, '$1missing') : xml.replace('</w:hyperlink>', '<w:hyperlink/></w:hyperlink>')); }
    await openReadOnlyPreview(page, { name: `${kind}-link.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });
  }
});

test('combining marks and emoji joins remain one linked caret position during native text input', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(''); await input.fill('a😀😀'); await choose(input, 'a'); await dialog(page, input); await page.getByRole('textbox', { name: 'Link address', exact: true }).fill('https://example.com/combining'); await apply(page); await input.press('ArrowRight'); await page.keyboard.insertText('\u0301'); expect(await input.evaluate(el=>el.selectionStart)).toBe(2); await choose(input,'á'); await expect((await onTab(page,'insert')).getByRole('button',{name:'Insert or edit link',exact:true})).toHaveAttribute('aria-pressed','true');
  await input.evaluate(el=>{el.setSelectionRange(2,4);el.dispatchEvent(new Event('select',{bubbles:true}));}); await dialog(page,input); await page.getByRole('textbox',{name:'Link address',exact:true}).fill('https://example.com/emoji'); await apply(page); await input.press('ArrowRight'); await page.keyboard.insertText('\u200d'); await expect(input).toHaveValue('á😀\u200d😀'); expect(await input.evaluate(el=>[el.selectionStart,el.selectionEnd])).toEqual([7,7]); await input.press('ArrowLeft'); expect(await input.evaluate(el=>el.selectionStart)).toBe(2); await input.press('ArrowRight'); expect(await input.evaluate(el=>el.selectionStart)).toBe(7); await page.getByRole('button',{name:'Undo',exact:true}).click(); await expect(input).toHaveValue('á😀😀');
});

test('finishes native composition before editing its link and keeps composition and link changes separately undoable', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }), button = (await onTab(page, 'insert')).getByRole('button', { name: 'Insert or edit link', exact: true }); await expect(input).toHaveValue(''); await input.fill('Link alpha'); await choose(input,'alpha'); await dialog(page,input); await page.getByRole('textbox',{name:'Link address',exact:true}).fill('https://example.com/ime'); await apply(page); await choose(input,'alpha',true);
  await input.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));el.setRangeText('한',el.selectionStart,el.selectionEnd,'end');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'한',isComposing:true}));});
  await button.click(); await expect(page.getByRole('textbox',{name:'Link address',exact:true})).toHaveValue('https://example.com/ime'); await page.getByRole('textbox',{name:'Link address',exact:true}).fill('https://example.com/ime-edited'); await apply(page); await expect(input).toHaveValue('Link a한lpha'); await page.getByRole('button',{name:'Undo',exact:true}).click(); await expect(input).toHaveValue('Link a한lpha'); await dialog(page,input); await expect(page.getByRole('textbox',{name:'Link address',exact:true})).toHaveValue('https://example.com/ime'); await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await page.getByRole('button',{name:'Undo',exact:true}).click(); await expect(input).toHaveValue('Link alpha'); await page.getByRole('button',{name:'Redo',exact:true}).click(); await page.getByRole('button',{name:'Redo',exact:true}).click(); await expect(input).toHaveValue('Link a한lpha'); await dialog(page,input); await expect(page.getByRole('textbox',{name:'Link address',exact:true})).toHaveValue('https://example.com/ime-edited');
});
