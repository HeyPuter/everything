import { test, expect } from '@playwright/test';
import { onTab, downloadDocx, showAllTools } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

async function select(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
}
const ribbon = (page, name) => page.locator('.ribbon-card').getByRole('button', { name, exact: true });

test('the Font dialog applies style, size, effects and spacing in one step and keeps mixed values', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Plain words and more words');
  await onTab(page, 'home');
  await select(input, 'words and');
  await input.press('ControlOrMeta+d');
  const dialog = page.getByRole('dialog', { name: 'Font' });
  await expect(dialog.getByRole('combobox', { name: 'Font', exact: true })).toHaveValue('Noto Sans');
  await dialog.getByLabel('Font style').selectOption('boldItalic');
  await dialog.getByLabel('Size', { exact: true }).fill('18');
  await dialog.getByLabel('Small caps').check();
  await dialog.getByLabel('Strikethrough', { exact: true }).check();
  await dialog.getByLabel('Double strikethrough').check();
  await expect(dialog.getByLabel('Strikethrough', { exact: true })).not.toBeChecked();
  await dialog.getByRole('tab', { name: 'Advanced' }).click();
  await dialog.getByLabel('Spacing', { exact: true }).selectOption('expanded');
  await dialog.getByLabel('Spacing by (pt)').fill('2');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(ribbon(page, 'Bold')).toHaveAttribute('aria-pressed', 'true');
  await expect(ribbon(page, 'Italic')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true })).toHaveValue('18');
  // A mixed selection opens with blank fields; leaving them alone keeps each run's own value.
  await select(input, 'Plain words');
  await ribbon(page, 'Font Settings').click();
  await expect(dialog.getByLabel('Size', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Small caps')).toHaveJSProperty('indeterminate', true);
  await dialog.getByLabel('Font color').click();
  await page.getByRole('menu', { name: 'Text color' }).getByRole('menuitemradio').nth(5).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await select(input, 'Plain');
  await expect(page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true })).toHaveValue('12');
  await select(input, 'words and');
  await expect(page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true })).toHaveValue('18');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await select(input, 'words and');
  await expect(page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true })).toHaveValue('12');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const path = info.outputPath('font-dialog.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  await reopenDocx(page, input, path, 'Plain words and more words');
  await select(input, 'words and');
  await showAllTools(page);
  await expect(page.getByRole('button', { name: 'Small caps', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Double strikethrough', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('color buttons in the Font and Borders and Shading dialogs tell a screen reader their color', async ({ page }) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Colored words');
  await onTab(page, 'home');
  await select(input, 'Colored');
  await input.press('ControlOrMeta+d');
  const font = page.getByRole('dialog', { name: 'Font' });
  const color = font.getByRole('button', { name: 'Font color', exact: true });
  await expect(color).toHaveAccessibleDescription('Automatic');
  await color.click();
  await page.getByRole('menu', { name: 'Text color' }).getByRole('menuitemradio').nth(5).click();
  await expect(color).toHaveAccessibleDescription(/^#[0-9A-F]{6}$/i);
  await expect(font.getByRole('button', { name: 'Underline color', exact: true })).toHaveAccessibleDescription('Automatic');
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-root:not(.closing)')).toHaveCount(0);
  await page.locator('.ribbon-card').getByRole('button', { name: 'Border options' }).click();
  await page.getByRole('menuitem', { name: 'Borders and Shading…' }).click();
  const borders = page.getByRole('dialog', { name: 'Borders and Shading' });
  await borders.getByRole('tab', { name: 'Shading' }).click();
  await expect(borders.getByRole('button', { name: 'Fill', exact: true })).toHaveAccessibleDescription('No Color');
});
