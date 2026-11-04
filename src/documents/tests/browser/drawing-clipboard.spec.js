import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx, menuBarMenu } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

// Cut, Copy and Paste of a shape or text box: the drawing comes back, not nothing (a cut used to lose it).
const input = page => page.getByRole('textbox', { name: 'Document text' });
test.use({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const drawings = page => page.evaluate(() => {
  const m = window.__docs.current.view.engine.model;
  let at = 0; const out = [];
  m.paragraphs.forEach((p, paragraph) => { for (const r of p.runs) { if (r.image) out.push({ paragraph, at, id: r.image.id, order: r.image.anchor?.order, geometry: /prst="(\w+)"/.exec(r.image.shell || '')?.[1], text: [...(r.image.shell || '').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)/g)].map(x => x[1]).join('') }); at += r.text.length; } at++; });
  return out;
});
const caretAtEnd = page => page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.text.length); e.syncInput(); e.paint(); e.onSelection(); e.focus(); });
async function start(page) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 6; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text.`); await page.keyboard.press('Enter'); }
}

test('a shape cut and pasted moves to the caret, and a copy pasted twice makes two more', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Oval', exact: true }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + 300, box.y + 220); await page.mouse.down();
  await page.mouse.move(box.x + 460, box.y + 320, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
  const [drawn] = await drawings(page);
  expect(drawn).toMatchObject({ geometry: 'ellipse' });

  await page.keyboard.press('ControlOrMeta+x');
  await expect.poll(() => drawings(page)).toEqual([]);
  await caretAtEnd(page);
  await page.keyboard.press('ControlOrMeta+v');
  // The oval is back, in the last paragraph, with its own geometry, and selected.
  await expect.poll(async () => (await drawings(page)).map(d => [d.paragraph, d.geometry])).toEqual([[6, 'ellipse']]);
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
  // Pasting again with the oval selected adds another in front of it; it does not replace it.
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await drawings(page)).length).toBe(2);
  const [first, second] = await drawings(page);
  expect(second.id).not.toBe(first.id);
  expect(second.order).toBeGreaterThan(first.order);
  // One undo takes the paste back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await drawings(page)).length).toBe(1);

  const path = info.outputPath('pasted-shape.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['word/document.xml']);
  expect(xml.match(/<wp:anchor /g)).toHaveLength(1);
  expect(xml).toContain('prst="ellipse"');
  await reopenDocx(page, input(page), path, await input(page).inputValue());
  expect((await drawings(page)).map(d => [d.paragraph, d.geometry])).toEqual([[6, 'ellipse']]);
  expect(errors).toEqual([]);
});

test('a text box copied from the Edit menu pastes with its text, and its paragraphs keep unique identifiers', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit drawing text' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').first().press('ControlOrMeta+a');
  await page.keyboard.type('Boxed words');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await input(page).evaluate(el => { const at = el.value.indexOf('￼'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await expect(page.getByRole('tab', { name: 'Shape Format' })).toBeVisible();
  // The Edit menu offers Copy for the text box, as for a picture.
  const copy = (await menuBarMenu(page, 'Edit')).getByRole('menuitem', { name: 'Copy', exact: true });
  await expect(copy).toBeEnabled();
  await copy.click();
  await caretAtEnd(page);
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await drawings(page)).map(d => d.text)).toEqual(['Boxed words', 'Boxed words']);

  const path = info.outputPath('pasted-text-box.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['word/document.xml']);
  expect(xml.match(/<wps:txbx>/g)).toHaveLength(2);
  const ids = [...xml.matchAll(/w14:paraId="([0-9A-F]+)"/g)].map(m => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  const docPr = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map(m => m[1]);
  expect(new Set(docPr).size).toBe(2);
  await reopenDocx(page, input(page), path, await input(page).inputValue());
  expect((await drawings(page)).map(d => d.text)).toEqual(['Boxed words', 'Boxed words']);
  expect(errors).toEqual([]);
});

test('Cut leaves a chart it cannot carry in place, and Copy pastes no stray text, each saying so', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Chart', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Insert Chart' });
  await chart.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(chart).toBeHidden();
  const charts = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image?.kind === 'chart').length);
  expect(await charts()).toBe(1);
  await input(page).evaluate(el => { const at = el.value.indexOf('￼'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.keyboard.press('ControlOrMeta+x');
  await expect(page.getByText('This object can’t be cut and pasted yet.', { exact: false })).toBeVisible();
  expect(await charts()).toBe(1);
  // Copied and pasted, it does not come back as stray text (its title or "[Image]"); the paste says why.
  const text = await input(page).inputValue();
  await page.keyboard.press('ControlOrMeta+c');
  await caretAtEnd(page);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.getByText('This object can’t be copied and pasted yet.', { exact: false })).toBeVisible();
  expect(await input(page).inputValue()).toBe(text);
  // Delete still removes it.
  await input(page).evaluate(el => { const at = el.value.indexOf('\ufffc'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.keyboard.press('Delete');
  await expect.poll(charts).toBe(0);
  expect(errors).toEqual([]);
});

test('an equation cut and pasted stays an equation, and a displayed one pasted among text goes in line', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  const equations = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap((p, paragraph) => p.runs.filter(r => r.math).map(r => ({ paragraph, display: r.math.xml.includes('oMathPara'), fraction: r.math.xml.includes('<m:f>') }))));
  const selectEquation = () => page.evaluate(() => {
    const engine = window.__docs.current.view.engine, model = engine.model;
    let at = 0, found = -1;
    for (const p of model.paragraphs) { for (const run of p.runs) { if (run.math && found < 0) found = at; at += run.text.length; } at++; }
    model.select(found, found + 1); engine.syncInput(); engine.paint(); engine.onSelection(); engine.focus();
  });
  // A displayed equation of its own (Insert Equation in an empty paragraph).
  await caretAtEnd(page);
  await onTab(page, 'insert');
  await page.getByRole('button', { name: 'Equation gallery' }).click();
  await page.getByRole('menuitem', { name: /^Sum of the first n integers/ }).click();
  await expect.poll(async () => (await equations(page)).length).toBe(1);
  const [inserted] = await equations(page);
  expect(inserted).toMatchObject({ display: true, fraction: true });

  await selectEquation();
  await page.keyboard.press('ControlOrMeta+x');
  await expect.poll(equations).toEqual([]);
  // Into the end of the first paragraph's text.
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.text.indexOf('\n')); e.syncInput(); e.paint(); e.onSelection(); e.focus(); });
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(equations).toEqual([{ paragraph: 0, display: false, fraction: true }]);
  expect(await input(page).inputValue()).toMatch(/^Paragraph 1 of the text\.￼\n/);
  // Copied again and pasted into an empty paragraph, it stays as it is.
  await selectEquation();
  await page.keyboard.press('ControlOrMeta+c');
  await caretAtEnd(page);
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await equations(page)).length).toBe(2);

  const path = info.outputPath('pasted-equation.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['word/document.xml']);
  expect(xml.match(/<m:f>/g)).toHaveLength(2);
  await reopenDocx(page, input(page), path, await input(page).inputValue());
  expect((await equations(page)).map(e => e.fraction)).toEqual([true, true]);
  expect(errors).toEqual([]);
});
