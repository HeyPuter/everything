import { test, expect } from '@playwright/test';
import { onTab, menuBarMenu } from './helpers/editor-tools.js';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { openReadOnlyPreview } from './helpers/preview.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const slider = (page, name) => page.getByRole('slider', { name, exact: true });
async function open(page) {
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/ruler.docx');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue(/^Ruler fixture/);
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuenow', '-360');
}
async function drag(page, name, dx, dy = 0, cancel = false) {
  const box = await slider(page, name).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 4 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}
async function save(page, info, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const path = info.outputPath(name); await (await pending).saveAs(path); return path;
}

test('edge ruler drags commit once, cancel cleanly, preserve leaders and round-trip margins and indents', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await open(page);
  await expect(page.getByRole('group', { name: 'Horizontal ruler' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Vertical ruler' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await page.getByRole('combobox', { name: 'Zoom' }).focus();
  await drag(page, 'First line indent', 24, 0, true);
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuenow', '-360');
  await expect(undo).toBeDisabled();
  await drag(page, 'First line indent', 24);
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuenow', '0');
  await undo.click(); await expect(undo).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await drag(page, 'Hanging indent', 24);
  await expect(slider(page, 'Left indent')).toHaveAttribute('aria-valuenow', '1080');
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuenow', '-360');
  await drag(page, 'Left indent', 24);
  await expect(slider(page, 'Left indent')).toHaveAttribute('aria-valuenow', '1440');
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuenow', '-360');
  await drag(page, 'Right indent', -24);
  await expect(slider(page, 'Right indent')).toHaveAttribute('aria-valuenow', '720');
  await drag(page, 'left tab stop', 24);
  await expect(slider(page, 'left tab stop')).toHaveAttribute('aria-valuenow', '1800');
  await drag(page, 'Left margin', 24);
  await drag(page, 'Top margin', 0, 24);
  await expect(slider(page, 'Top margin')).toHaveAttribute('aria-valuenow', '1800');
  const input = page.getByRole('textbox', { name: 'Document text' });
  const text = await input.inputValue();
  const saved = await save(page, info, 'ruler-edited.docx');
  const parts = unzipSync(readFileSync(saved)), xml = strFromU8(parts['word/document.xml']);
  expect(xml).toMatch(/w:left="1440"/); expect(xml).toMatch(/w:top="1800"/); expect(xml).toMatch(/w:gutter="360"/);
  expect(xml).toMatch(/w:pos="1800"/); expect(xml).toMatch(/w:leader="dot"/);
  expect(parts['customXml/ruler-provenance.xml']).toEqual(unzipSync(readFileSync('public/fixtures/ruler.docx'))['customXml/ruler-provenance.xml']);
  await reopenDocx(page, input, saved, text);
  await expect(slider(page, 'Left indent')).toHaveAttribute('aria-valuenow', '1440');
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuenow', '-360');
  await expect(slider(page, 'left tab stop')).toHaveAttribute('aria-valuenow', '1800');
  await page.screenshot({ path: info.outputPath('rulers.png') });
  expect(errors).toEqual([]);
});

test('tabs, keyboard edits, units, zoom, scroll and visibility', async ({ page }, info) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await open(page);
  const ruler = page.getByRole('group', { name: 'Horizontal ruler' });
  const canvas = page.locator('.canvas-page').first();
  await page.getByRole('button', { name: /^Left tab stop ·/ }).click();
  const box = await ruler.boundingBox();
  await page.mouse.click(box.x + 96 + 3 * 96, box.y + 10);
  await expect(slider(page, 'center tab stop')).toHaveCount(2);
  const stop = page.locator('.canvas-ruler-handle[data-kind="tab"][data-position="4320"]');
  await stop.focus(); await stop.press('ArrowRight');
  await expect(page.locator('.canvas-ruler-handle[data-position="4410"]')).toHaveCount(1);
  await expect(page.locator('.canvas-ruler-handle[data-position="4410"]')).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(slider(page, 'center tab stop')).toHaveCount(1);
  await drag(page, 'decimal tab stop', 0, 65);
  await expect(slider(page, 'decimal tab stop')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(slider(page, 'decimal tab stop')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Zoom' }).selectOption('1.5');
  await expect.poll(async () => (await ruler.boundingBox()).width).toBe(1224);
  const assertAligned = async () => {
    const rb = await ruler.boundingBox(), cb = await canvas.boundingBox();
    expect(Math.abs(rb.x - cb.x)).toBeLessThan(1); expect(rb.width).toBeCloseTo(cb.width, 0);
  };
  await assertAligned();
  await drag(page, 'First line indent', 36);
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('.canvas-host').evaluate(el => { el.scrollLeft = 170; el.scrollTop = 400; });
  await expect.poll(async () => (await ruler.boundingBox()).x).toBeLessThan(0);
  await assertAligned();
  const vertical = await page.getByRole('group', { name: 'Vertical ruler' }).boundingBox();
  expect(vertical.y).toBeCloseTo((await canvas.boundingBox()).y, 0);
  await page.locator('.canvas-host').evaluate(el => { el.scrollTop = 1660; });
  await expect.poll(async () => Math.abs((await page.getByRole('group', { name: 'Vertical ruler' }).boundingBox()).y - (await page.locator('.canvas-page').nth(1).boundingBox()).y)).toBeLessThan(1);
  await menuBarMenu(page, 'View');
  await page.getByRole('menuitemcheckbox', { name: 'Ruler', exact: true }).click();
  await expect(ruler).toBeHidden();
  await menuBarMenu(page, 'View');
  await page.getByRole('menuitemcheckbox', { name: 'Ruler', exact: true }).click();
  await expect(ruler).toBeVisible();
  await page.getByRole('checkbox', { name: 'Text mode' }).check(); await expect(ruler).toBeHidden();
  await page.getByRole('checkbox', { name: 'Text mode' }).uncheck(); await expect(ruler).toBeVisible();
  await menuBarMenu(page, 'View');
  await page.getByRole('menu', { name: 'View', exact: true }).getByRole('menuitem', { name: 'Units', exact: true }).hover();
  await page.getByRole('menuitemradio', { name: 'Centimeters' }).click();
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuetext', '-0.64 cm');
  await slider(page, 'First line indent').press('ArrowRight');
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuenow', '-303');
  await save(page, info, 'ruler-keyboard.docx');
});


test('exact settings, invalid edits and read-only documents remain safe', async ({ page }, info) => {
  await open(page);
  await slider(page, 'First line indent').dblclick();
  await expect(page.getByRole('dialog', { name: 'Indents and tabs' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await slider(page, 'Left margin').dblclick();
  await expect(page.getByRole('dialog', { name: 'Page setup' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await drag(page, 'First line indent', 1000);
  await expect(slider(page, 'First line indent')).toHaveAttribute('aria-valuenow', '-360');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await openReadOnlyPreview(page, 'public/fixtures/best-effort.docx');
  // Every ruler handle is disabled; the status bar's zoom slider stays usable in a preview.
  const handles = page.getByRole('group', { name: /^(Horizontal|Vertical) ruler$/ }).getByRole('slider');
  expect(await handles.count()).toBeGreaterThan(0);
  for (const h of await handles.all()) await expect(h).toBeDisabled();
  const saved = await save(page, info, 'ruler-readonly.docx');
  expect(readFileSync(saved)).toEqual(readFileSync('public/fixtures/best-effort.docx'));
});

test('phones start without rulers until View > Ruler shows them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await expect(page.getByRole('group', { name: 'Horizontal ruler' })).toBeHidden();
  await (await onTab(page, 'view')).getByRole('checkbox', { name: 'Ruler', exact: true }).isVisible();
  await expect(page.getByRole('checkbox', { name: 'Ruler', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Ruler', exact: true }).check();
  await expect(page.getByRole('group', { name: 'Horizontal ruler' })).toBeVisible();
  // A wider window follows the default until the user chooses; here the choice stays.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('group', { name: 'Horizontal ruler' })).toBeVisible();
});

test('a phone-sized window that grows shows the rulers by default', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('group', { name: 'Horizontal ruler' })).toBeVisible();
});

test('contrast themes keep the ruler\'s marks, indent markers and text area visible', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await open(page);
  // Contrast themes replace backgrounds with the window color; whatever is drawn as a fill must keep a color of its own.
  const fills = await page.evaluate(() => {
    const ruler = document.querySelector('.canvas-ruler-horizontal');
    const ground = getComputedStyle(ruler).backgroundColor;
    const fill = node => node ? getComputedStyle(node).backgroundColor : null;
    return {
      ground,
      tick: fill(ruler.querySelector('.canvas-ruler-tick.half')),
      firstLine: fill(ruler.querySelector('[data-kind="firstLine"]')),
      hanging: fill(ruler.querySelector('[data-kind="hanging"]')),
      // The text area is told from the margins by an edge when fills are gone.
      writingEdge: getComputedStyle(ruler.querySelector('.canvas-ruler-writing')).borderLeftStyle,
    };
  });
  for (const part of ['tick', 'firstLine', 'hanging']) expect(fills[part], part).not.toBe(fills.ground);
  expect(fills.writingEdge).not.toBe('none');
});
