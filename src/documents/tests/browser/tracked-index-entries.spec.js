import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const ribbon = page => page.locator('#ribbon-panel-references');
const engineText = page => page.evaluate(() => window.__docs.current.view.engine.session.body.text);
const fieldTypes = page => page.evaluate(() => window.__docs.current.view.engine.session.body.paragraphs.flatMap(p => (p.fieldMarkers || []).filter(m => m.type === 'start').map(m => [m.field.instruction.trim().split(/\s+/)[0], m.field.revision?.type || null])));
const reject = page => page.evaluate(() => { const engine = window.__docs.current.view.engine; engine.execute(() => engine.session.body.resolveRevisions(false)); });

async function openEditor(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
}
async function openGroup(page, id) {
  const collapsed = page.locator(`#ribbon-panel-references [data-group="${id}"] .ribbon-collapsed`);
  if (await collapsed.isVisible()) await collapsed.click();
}
async function trackChanges(page) {
  await page.keyboard.press('ControlOrMeta+Shift+e');
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.session.body.trackChanges)).toBe(true);
}

// Mark Entry, Mark Citation, Insert Index and Insert Table of Authorities edited untracked with Track Changes on:
// the entries and tables they added had no change to reject, and Reject All left them in the document.
test('index entries and an index added with Track Changes on are tracked insertions that Reject All removes', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openEditor(page);
  const text = 'Mercury is hot. Venus is cloudy. Mercury is small.';
  await page.keyboard.type(text);
  await expect.poll(() => engineText(page)).toBe(text);
  await trackChanges(page);
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(0, 7); });
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Mark Entry', exact: true }).click();
  const mark = page.getByRole('dialog', { name: 'Mark Index Entry' });
  await expect(mark.getByLabel('Main entry')).toHaveValue('Mercury');
  await mark.getByRole('button', { name: 'Mark All', exact: true }).click();
  await expect(mark.getByText('2 entries marked.')).toBeVisible();
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model, at = m.text.indexOf('Venus'); m.select(at, at + 5); });
  await mark.getByLabel('Subentry').focus();
  await expect(mark.getByLabel('Main entry')).toHaveValue('Venus');
  await mark.getByRole('button', { name: 'Mark', exact: true }).click();
  await mark.getByRole('button', { name: 'Close Mark Index Entry' }).click();
  await expect.poll(() => fieldTypes(page)).toEqual([['XE', 'ins'], ['XE', 'ins'], ['XE', 'ins']]);
  await input(page).press('ControlOrMeta+End'); await page.keyboard.press('Enter');
  await ribbon(page).getByRole('button', { name: 'Insert Index', exact: true }).click();
  await page.getByRole('dialog', { name: 'Index' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => engineText(page)).toContain('\nMercury, 1\nVenus, 1');
  expect((await fieldTypes(page)).find(([type]) => type === 'INDEX')).toEqual(['INDEX', 'ins']);
  // Saved, each entry's field characters and code are inside an insertion (ECMA-376 Part 1 §17.13.5.18).
  const pending = page.waitForEvent('download');
  await downloadDocx(page);
  const path = info.outputPath('tracked-index.docx');
  await (await pending).saveAs(path);
  const xml = strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
  expect(xml.match(/<w:ins\b[^>]*>(?:(?!<\/w:ins>).)*?XE "(?:Mercury|Venus)"/g)).toHaveLength(3);
  const reopened = await page.evaluate(async bytes => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const pkg = await DocxPackage.open(new Uint8Array(bytes));
    return pkg.paragraphs.flatMap(p => (p.fieldMarkers || []).filter(m => m.type === 'start' && /XE/.test(m.field.instruction)).map(m => m.field.revision?.type));
  }, [...readFileSync(path)]);
  expect(reopened).toEqual(['ins', 'ins', 'ins']);
  await reject(page);
  await expect.poll(() => engineText(page)).toBe(text);
  expect(await fieldTypes(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a citation and a table of authorities added with Track Changes on are tracked insertions that Reject All removes', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openEditor(page);
  const text = 'Smith v. Jones decided it.';
  await page.keyboard.type(text);
  await expect.poll(() => engineText(page)).toBe(text);
  await trackChanges(page);
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(0, 14); });
  await onTab(page, 'references');
  await openGroup(page, 'authorities');
  await page.getByRole('button', { name: 'Mark Citation', exact: true }).click();
  const cite = page.getByRole('dialog', { name: 'Mark Citation' });
  await cite.getByRole('button', { name: 'Mark', exact: true }).click();
  await expect(cite.getByText('1 citation marked.')).toBeVisible();
  await cite.getByRole('button', { name: 'Close Mark Citation' }).click();
  await expect.poll(() => fieldTypes(page)).toEqual([['TA', 'ins']]);
  await input(page).press('ControlOrMeta+End'); await page.keyboard.press('Enter');
  await openGroup(page, 'authorities');
  await page.getByRole('button', { name: 'Insert Table of Authorities', exact: true }).click();
  await page.getByRole('dialog', { name: 'Table of Authorities' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => engineText(page)).toContain('\nCases\nSmith v. Jones\t1');
  expect((await fieldTypes(page)).find(([type]) => type === 'TOA')).toEqual(['TOA', 'ins']);
  await reject(page);
  await expect.poll(() => engineText(page)).toBe(text);
  expect(await fieldTypes(page)).toEqual([]);
  expect(errors).toEqual([]);
});
