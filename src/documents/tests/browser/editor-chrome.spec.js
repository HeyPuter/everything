import { test, expect } from '@playwright/test';
import { onTab, fileCommand } from './helpers/editor-tools.js';

const tab = (page, name) => page.getByRole('tab', { name, exact: true });
const item = (page, name) => page.getByRole('menuitem', { name, exact: true });
const text = page => page.getByRole('textbox', { name: 'Document text' });
const ribbon = page => page.locator('.ribbon-card');
async function openEditor(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}

test('opens on the Home tab of a word-processor ribbon with every everyday command in view', async ({ page }, info) => {
  await openEditor(page);
  await expect(page.getByRole('tablist', { name: 'Ribbon tabs' }).getByRole('tab')).toHaveText(['Home', 'Insert', 'Draw', 'Design', 'Layout', 'References', 'Mailings', 'Review', 'View']);
  await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
  for (const name of ['Paste', 'Cut', 'Copy', 'Bold', 'Italic', 'Underline', 'Strikethrough', 'Superscript', 'Subscript', 'Text color', 'Text highlight',
    'Bulleted list', 'Numbered list', 'Decrease Indent', 'Increase Indent', 'Align left', 'Align center', 'Align right', 'Justify', 'Find', 'Replace',
    'Format Painter', 'Change Case', 'Sort', 'Show Formatting Marks', 'Multilevel List', 'Text Effects']) {
    await expect(ribbon(page).getByRole('button', { name, exact: true })).toBeInViewport();
  }
  await expect(page.getByRole('listbox', { name: 'Styles' }).getByRole('option', { name: 'Normal' })).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Table Design', 'Table Layout', 'Picture Format', 'Shape Format']) await expect(tab(page, name)).toBeHidden();
  await expect(page.locator('.canvas-advanced')).toBeHidden();
  expect(await page.locator('.canvas-header').evaluate(el => el.offsetHeight)).toBeLessThan(90);
  expect(await page.locator('.ed-ribbon').evaluate(el => el.offsetHeight)).toBeLessThan(100);
  // The app saves to the cloud: no download button in its title bar.
  await expect(page.getByRole('button', { name: 'Download .docx', exact: true })).toHaveCount(0);
  await expect(page.locator('.ed-statusbar')).toContainText('Page 1 of 1');
  await page.screenshot({ path: info.outputPath('editor-desktop.png'), animations: 'disabled' });
});

test('styles from the gallery and the Formatting Pane apply to the selection and undo', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Keep this selection'); await text(page).press('ControlOrMeta+a');
  await page.getByRole('listbox', { name: 'Styles' }).getByRole('option', { name: 'Heading 1' }).click();
  await expect(page.getByRole('listbox', { name: 'Styles' }).getByRole('option', { name: 'Heading 1' })).toHaveAttribute('aria-selected', 'true');
  await expect(text(page)).toBeFocused();
  expect(await text(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 19]);
  await page.getByRole('button', { name: 'Formatting Pane', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Formatting Pane' })).toBeVisible();
  await page.getByRole('button', { name: 'Character spacing', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Character spacing (pt)', exact: true }).fill('1.5');
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Character spacing', exact: true })).toHaveAttribute('title', 'Character spacing: 1.5 pt');
  await page.getByRole('button', { name: 'Close Formatting Pane' }).click();
  await expect(page.locator('.canvas-advanced')).toBeHidden();
  await text(page).press('ControlOrMeta+z'); await text(page).press('ControlOrMeta+z');
  await expect(page.getByRole('listbox', { name: 'Styles' }).getByRole('option', { name: 'Normal' })).toHaveAttribute('aria-selected', 'true');
});

test('moves through tabs and commands with the keyboard and returns to the document', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Keyboard selection'); await text(page).press('ControlOrMeta+a');
  await tab(page, 'Home').focus(); await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Insert')).toBeFocused(); await expect(tab(page, 'Insert')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft'); await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true');
  const bold = page.getByRole('button', { name: 'Bold', exact: true }); await bold.focus(); await bold.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(tab(page, 'Home')).toBeFocused();
  const size = page.getByRole('spinbutton', { name: 'Font size (pt)' }); await size.focus();
  await page.keyboard.press('Tab'); await expect(size).not.toBeFocused();
  await page.keyboard.press('Escape'); await expect(text(page)).toBeFocused();
  expect(await text(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 18]);
  // File opens the File view over the editor; Escape returns to the document.
  const file = page.getByRole('button', { name: 'File', exact: true });
  await file.click(); await expect(page.getByRole('dialog', { name: 'File' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'File' })).toBeHidden();
  await expect(text(page)).toBeFocused();
});

test('uses File menu actions to rename, save and start a document', async ({ page }) => {
  await openEditor(page); await text(page).fill('Saved through the menu');
  await (await fileCommand(page, 'Rename…')).click();
  const title = page.getByRole('textbox', { name: 'Document name' });
  await expect(title).toBeFocused(); await title.fill('Quarterly notes'); await title.press('Enter');
  await expect(title).toHaveAttribute('title', 'Quarterly notes — Rename');
  await expect(text(page)).toBeFocused();
  await (await fileCommand(page, 'Save')).click();
  await expect(page.locator('.canvas-save-status')).toHaveText('Saved to Puter');
  await page.reload(); await expect(title).toHaveValue('Quarterly notes'); await expect(text(page)).toHaveValue('Saved through the menu');
  await title.fill('Cancelled name'); await title.press('Escape'); await expect(title).toHaveValue('Quarterly notes');
  await (await fileCommand(page, 'New Document')).click();
  await expect(text(page)).toHaveValue(''); await expect(title).toHaveValue('Untitled document');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('shows the table tabs inside a table and keeps their commands working', async ({ page }) => {
  await openEditor(page);
  await expect(tab(page, 'Table Layout')).toBeHidden();
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menu', { name: 'Insert table' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(tab(page, 'Table Design')).toBeVisible(); await expect(tab(page, 'Table Layout')).toBeVisible();
  await tab(page, 'Table Layout').click();
  const rows = () => page.evaluate(() => window.__docs.current.view.engine.model.tables[0].rows.length);
  const before = await rows();
  await ribbon(page).getByRole('button', { name: 'Insert Below', exact: true }).click();
  expect(await rows()).toBe(before + 1);
  await expect(text(page)).toBeFocused();
  await ribbon(page).getByRole('button', { name: 'Delete', exact: true }).click(); await item(page, 'Delete Table').click();
  await expect(tab(page, 'Table Layout')).toBeHidden(); await expect(tab(page, 'Insert')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('checkbox', { name: 'Text mode', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Text mode', exact: true })).toBeChecked();
});

test('lays the page out from the Layout tab and undoes it in one step', async ({ page }) => {
  await openEditor(page);
  const settings = () => page.evaluate(() => { const p = window.__docs.current.view.engine.model.pageSettings; return [p.orientation, p.width, p.height, p.left, p.top]; });
  await tab(page, 'Layout').click();
  await ribbon(page).getByRole('button', { name: 'Margins', exact: true }).click(); await page.getByRole('menuitemradio', { name: /^Narrow/ }).click();
  expect(await settings()).toEqual(['portrait', 12240, 15840, 720, 720]);
  await ribbon(page).getByRole('button', { name: 'Orientation', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Landscape' }).click();
  expect(await settings()).toEqual(['landscape', 15840, 12240, 720, 720]);
  await text(page).press('ControlOrMeta+z');
  expect(await settings()).toEqual(['portrait', 12240, 15840, 720, 720]);
});

test('keeps the title, tabs and commands reachable in a narrow window and dark theme', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 600 }); await openEditor(page);
  const title = page.getByRole('textbox', { name: 'Document name' });
  await title.fill('A very long document name that should leave room for the account and save status'); await title.press('Enter');
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeInViewport();
  await expect(await fileCommand(page, 'Download a Copy')).toBeEnabled();
  await expect(item(page, 'Download a Copy')).toBeInViewport();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The commands form one row that scrolls sideways.
  const panel = page.locator('#ribbon-panel-home');
  expect(await panel.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await panel.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(page.getByRole('button', { name: 'Formatting Pane', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('editor-narrow.png'), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: info.outputPath('editor-narrow-dark.png'), animations: 'disabled' });
});

test('gives touch screens fingertip-sized tabs and commands', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 750 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await openEditor(page);
    await tab(page, 'Insert').tap(); await expect(tab(page, 'Insert')).toHaveAttribute('aria-selected', 'true');
    await tab(page, 'Home').tap();
    for (const name of ['Bold', 'Italic', 'Underline']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await text(page).fill('Everyday formatting'); await text(page).press('ControlOrMeta+a');
    for (const name of ['Italic', 'Underline']) {
      const button = page.getByRole('button', { name, exact: true });
      await button.tap(); await expect(button).toHaveAttribute('aria-pressed', 'true');
    }
    expect(await text(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 19]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test('keeps the sign-in action visible beside a narrow title and saves after signing in', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/mock.html?signedout#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const status = page.locator('.canvas-save-status');
  await expect(status.locator('.save-label')).toBeVisible();
  await expect(status).toHaveText('Sign in to save');
  await expect(status).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await text(page).fill('Save these local edits');
  await status.click();
  await expect(status).toHaveText('Saved to Puter');
  await expect(text(page)).toHaveValue('Save these local edits');
});

test('the playground\'s sample links stay readable in the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/playground.html');
  await page.locator('.playground-samples summary').click();
  const ratios = await page.locator('.playground-nav').evaluate(nav => {
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const back = lum(rgb(getComputedStyle(nav).backgroundColor));
    return [...nav.querySelectorAll('a')].map(a => { const fore = lum(rgb(getComputedStyle(a).color)); return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05); });
  });
  expect(ratios.length).toBeGreaterThan(1);
  // The brand blue the light theme uses measured 2.8:1 on the dark bar.
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test('the File view\'s current section keeps its white name readable in both themes', async ({ page }) => {
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await openEditor(page);
    await page.getByRole('button', { name: 'File', exact: true }).first().click();
    const current = page.getByRole('dialog', { name: 'File' }).getByRole('tab', { name: 'Info' });
    await expect(current).toHaveAttribute('aria-selected', 'true');
    const ratio = await current.evaluate(tab => {
      const rgba = value => { const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number); return { r, g, b, a }; };
      const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
      const lum = c => [c.r, c.g, c.b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const back = over(rgba(getComputedStyle(tab).backgroundColor), rgba(getComputedStyle(tab.closest('.bs-side')).backgroundColor));
      const fore = lum(rgba(getComputedStyle(tab).color)), ground = lum(back);
      return (Math.max(fore, ground) + 0.05) / (Math.min(fore, ground) + 0.05);
    });
    // A white wash over the light theme's accent column measured 3.8:1.
    expect(ratio, colorScheme).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('Escape');
  }
});
