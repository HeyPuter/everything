import { test, expect } from '@playwright/test';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';

test.setTimeout(150000);
const ribbon = (page, name) => page.locator('.ribbon-card').getByRole('button', { name, exact: true });
async function select(input, text, end = text) {
  await input.evaluate((el, [text, end]) => { const at = el.value.indexOf(text), to = el.value.indexOf(end) + end.length; el.setSelectionRange(at, to); el.dispatchEvent(new Event('select', { bubbles: true })); }, [text, end]);
}
async function blank(page, text) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  await onTab(page, 'home');
  return { input, errors };
}
async function save(page, info, name) {
  const path = info.outputPath(name);
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  return { path, xml: part => strFromU8(unzipSync(readFileSync(path))[part]) };
}

test('Styles pane: apply, new from formatting, select instances, delete; Style Inspector and Reveal Formatting', async ({ page }, info) => {
  const { input, errors } = await blank(page, 'Chapter one\nBody text here\nChapter two\nMore body text');
  const pane = page.getByRole('complementary', { name: 'Styles pane' });
  await ribbon(page, 'Styles Pane').click();
  await expect(pane).toBeVisible();
  await screenshotPane(page, info, 'styles-pane.png');
  // Apply Heading 1 to both chapter lines.
  for (const line of ['Chapter one', 'Chapter two']) {
    await select(input, line);
    await pane.getByRole('button', { name: /^Apply Heading 1/ }).click();
  }
  await expect(pane.locator('.styles-pane-current-name')).toHaveText('Heading 1');
  await expect(pane.getByRole('button', { name: 'Select All 2 Instances' })).toBeEnabled();
  await pane.getByRole('button', { name: 'Select All 2 Instances' }).click();
  await expect(page.getByText(/2 instances highlighted/)).toBeVisible();
  // New style from formatting.
  await select(input, 'Body text here');
  await page.getByRole('button', { name: 'Align right', exact: true }).click();
  await pane.getByRole('button', { name: 'New Style…' }).click();
  const create = page.getByRole('dialog', { name: 'Create New Style from Formatting' });
  await create.getByLabel('Name').fill('Aside');
  await create.getByRole('button', { name: 'OK' }).click();
  await expect(pane.locator('.styles-pane-current-name')).toHaveText('Aside');
  await select(input, 'More body text');
  await pane.getByRole('button', { name: /^Apply Aside/ }).click();
  await expect(page.getByRole('button', { name: 'Align right', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Style Inspector: direct formatting shows and clears separately.
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await pane.getByRole('tab', { name: 'Style Inspector' }).click();
  await expect(pane.getByText('Plus: bold')).toBeVisible();
  await pane.getByRole('button', { name: 'Clear Character Formatting' }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'false');
  // Reveal Formatting links into the dialogs.
  await pane.getByRole('tab', { name: 'Reveal Formatting' }).click();
  await expect(pane.getByRole('button', { name: 'Alignment' })).toBeVisible();
  await screenshotPane(page, info, 'reveal-formatting.png');
  await pane.getByRole('button', { name: 'Alignment' }).click();
  await expect(page.getByRole('dialog', { name: 'Paragraph' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Paragraph' }).getByRole('button', { name: 'Cancel' }).click();
  let saved = await save(page, info, 'styles-pane.docx');
  expect(saved.xml('word/styles.xml')).toMatch(/<w:name w:val="Aside"\/>/);
  // Delete the custom style: its paragraphs return to Normal.
  await pane.getByRole('tab', { name: 'Styles' }).click();
  await pane.getByRole('button', { name: 'Aside options' }).click();
  await page.getByRole('menuitem', { name: 'Delete Aside…' }).click();
  await page.getByRole('dialog', { name: 'Delete style' }).getByRole('button', { name: 'Delete' }).click();
  await expect(pane.getByRole('button', { name: /^Apply Aside/ })).toHaveCount(0);
  saved = await save(page, info, 'styles-deleted.docx');
  expect(saved.xml('word/styles.xml')).not.toMatch(/Aside/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(pane.getByRole('button', { name: /^Apply Aside/ })).toHaveCount(1);
  await reopenDocx(page, input, saved.path, 'Chapter one\nBody text here\nChapter two\nMore body text');
  expect(errors).toEqual([]);
});

test('Apply Styles box and the Style dialog', async ({ page }) => {
  const { input, errors } = await blank(page, 'make me a heading\nsecond line');
  await select(input, 'make me a heading');
  await input.press('ControlOrMeta+Shift+S');
  const box = page.getByRole('dialog', { name: 'Apply Styles' });
  await box.getByLabel('Style name').fill('Heading 2');
  await box.getByLabel('Style name').press('Enter');
  await expect(box).toHaveCount(0);
  await expect(page.locator('.ribbon-style[aria-selected="true"] .ribbon-style-name')).toHaveText('Heading 2');
  // A new name creates a style from the selection.
  await select(input, 'second line');
  await input.press('ControlOrMeta+Shift+S');
  await box.getByLabel('Style name').fill('Closing note');
  await box.getByRole('button', { name: 'Apply' }).click();
  await expect(box).toHaveCount(0);
  // The Style dialog (Format → Style…, or Manage Styles in the pane) describes and applies styles.
  await ribbon(page, 'Styles Pane').click();
  await page.getByRole('complementary', { name: 'Styles pane' }).getByRole('button', { name: 'Manage Styles…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Style' });
  await dialog.getByRole('option', { name: /Closing note/ }).click();
  await expect(dialog.locator('.fmt-style-description')).toContainText('Based on');
  await dialog.getByRole('option', { name: /^Heading 1/ }).click();
  await expect(dialog.locator('.fmt-style-description')).toContainText('Keep with next');
  await select(input, 'second line');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.ribbon-style[aria-selected="true"] .ribbon-style-name')).toHaveText('Heading 1');
  expect(errors).toEqual([]);
});

test('Styles pane keeps keyboard focus on a control whose change redraws the pane', async ({ page }) => {
  const { input, errors } = await blank(page, 'Plain words here');
  await ribbon(page, 'Styles Pane').click();
  const pane = page.getByRole('complementary', { name: 'Styles pane' });
  const preview = pane.getByLabel('Show styles as they look');
  await preview.focus();
  await page.keyboard.press('Space');
  await expect(preview).not.toBeChecked();
  await expect(preview).toBeFocused();
  const list = pane.getByLabel('List', { exact: true });
  await list.focus();
  await list.selectOption('all');
  await expect(list).toBeFocused();
  await pane.getByRole('tab', { name: 'Reveal Formatting' }).click();
  const distinguish = pane.getByLabel('Distinguish direct formatting from styles');
  await distinguish.focus();
  await page.keyboard.press('Space');
  await expect(distinguish).toBeFocused();
  expect(errors).toEqual([]);
});

test('Modify Style refuses a name another style already has', async ({ page }, info) => {
  const { errors } = await blank(page, 'Plain words here');
  await ribbon(page, 'Styles Pane').click();
  const pane = page.getByRole('complementary', { name: 'Styles pane' });
  await pane.getByRole('button', { name: 'Heading 2 options' }).click();
  await page.getByRole('menuitem', { name: 'Modify…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit paragraph style' });
  await dialog.getByLabel('Style name').fill('heading 1');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('A style named “heading 1” already exists. Choose another name.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const { xml } = await save(page, info, 'unique-style-names.docx');
  expect(xml('word/styles.xml')).toMatch(/w:styleId="Heading2"><w:name w:val="Heading 2"\/>/);
  expect(errors).toEqual([]);
});

async function screenshotPane(page, info, name) {
  await page.screenshot({ path: info.outputPath(name) });
}
