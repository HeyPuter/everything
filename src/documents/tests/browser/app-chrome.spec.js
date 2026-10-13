import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const MAC = process.platform === 'darwin';
const text = page => page.getByRole('textbox', { name: 'Document text' });
const menubar = page => page.getByRole('menubar', { name: 'Menu bar' });
const engine = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine;
  return { text: e.model.text, range: [...e.model.range], bold: e.model.runFormatting.bold, italic: e.model.runFormatting.italic, viewOnly: !!e.viewOnly,
    tracking: !!e.session.body.trackChanges, history: e.session.history.length };
});
async function openEditor(page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}
async function select(page, start, end) {
  await text(page).evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); el.dispatchEvent(new Event('select')); }, [start, end]);
}
async function openMenu(page, name) {
  await menubar(page).getByRole('menuitem', { name, exact: true }).click();
  return page.getByRole('menu', { name, exact: true });
}
async function saveDownload(page, info, name, trigger) {
  const pending = page.waitForEvent('download');
  await trigger();
  const path = info.outputPath(name);
  await (await pending).saveAs(path);
  return path;
}

test('the menu bar has the classic menus, moves with the arrow keys and runs commands', async ({ page }) => {
  await openEditor(page);
  await expect(menubar(page).getByRole('menuitem')).toHaveText(['File', 'Edit', 'View', 'Insert', 'Format', 'Tools', 'Table', 'Window', 'Help']);
  const file = await openMenu(page, 'File');
  for (const name of ['New Document', 'Open…', 'Save', 'Save As…', 'Save as Template…', 'Page Setup…', 'Print…', 'Properties…', 'Preferences…']) await expect(file.getByRole('menuitem', { name, exact: true })).toBeVisible();
  // Right moves to the next menu, Escape closes and returns to the menu's name.
  await page.keyboard.press('ArrowRight');
  const edit = page.getByRole('menu', { name: 'Edit', exact: true });
  await expect(edit).toBeVisible();
  await expect(edit.getByRole('menuitem', { name: 'Paste and Match Formatting' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menubar(page).getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
  // Shortcuts show in the items.
  const format = await openMenu(page, 'Format');
  await expect(format.getByRole('menuitem', { name: /^Font…/ })).toContainText(MAC ? 'Cmd+D' : 'Ctrl+D');
  await page.keyboard.press('Escape');
  // Edit > Clear > Formatting removes direct formatting in one undo step.
  await text(page).fill('Plain and bold');
  await select(page, 10, 14);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  expect((await engine(page)).bold).toBe(true);
  await (await openMenu(page, 'Edit')).getByRole('menuitem', { name: 'Clear', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clear Formatting', exact: true }).click();
  expect((await engine(page)).bold).toBe(false);
  await text(page).press('ControlOrMeta+z');
  expect((await engine(page)).bold).toBe(true);
  // Edit > Clear > Contents deletes the selection without the clipboard.
  await select(page, 0, 6);
  await (await openMenu(page, 'Edit')).getByRole('menuitem', { name: 'Clear', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Contents', exact: true }).click();
  expect((await engine(page)).text).toBe('and bold');
});

test('the File view opens over the editor, edits document properties that save into the file, and exports', async ({ page }, info) => {
  await openEditor(page);
  await text(page).fill('Harbour report\nThe tide was high.');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'File' });
  await expect(view).toBeVisible();
  await expect(view.getByRole('tab', { name: 'Info' })).toHaveAttribute('aria-selected', 'true');
  await expect(view.locator('.bs-facts').last()).toContainText('Words');
  await view.getByRole('textbox', { name: 'Title', exact: true }).fill('Harbour Report');
  await view.getByRole('textbox', { name: 'Keywords', exact: true }).fill('tides, harbour');
  await view.getByRole('button', { name: 'Save Properties' }).click();
  await expect(view.getByRole('status')).toContainText('Properties updated');
  // Escape returns to the document.
  await page.keyboard.press('Escape');
  await expect(view).toBeHidden();
  await expect(text(page)).toBeFocused();
  // Export: .docx carries the properties; Markdown and plain text carry the words.
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await view.getByRole('tab', { name: 'Export' }).click();
  const docx = await saveDownload(page, info, 'properties.docx', () => view.getByRole('button', { name: /^Word document/ }).click());
  const parts = unzipSync(readFileSync(docx));
  const core = strFromU8(parts['docProps/core.xml']);
  expect(core).toContain('<dc:title>Harbour Report</dc:title>');
  expect(core).toContain('<cp:keywords>tides, harbour</cp:keywords>');
  expect(core).toMatch(/<dcterms:modified xsi:type="dcterms:W3CDTF">\d{4}-\d\d-\d\dT/);
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await view.getByRole('tab', { name: 'Export' }).click();
  const md = await saveDownload(page, info, 'export.md', () => view.getByRole('button', { name: /^Markdown/ }).click());
  expect(readFileSync(md, 'utf8')).toContain('The tide was high.');
  // New lists the templates; Print previews the pages.
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await view.getByRole('tab', { name: 'New' }).click();
  await expect(view.getByRole('button', { name: /^Blank document/ })).toBeVisible();
  await expect(view.getByRole('button', { name: /^Letter/ })).toBeVisible();
  await view.getByRole('tab', { name: 'Print' }).click();
  await expect(view.locator('.bs-page canvas')).toHaveCount(1);
  await view.getByRole('combobox', { name: 'Pages' }).selectOption('custom');
  await view.getByRole('textbox', { name: 'Page range' }).fill('3-4');
  await view.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('between 1 and 1');
  await view.getByRole('button', { name: 'Back to the document' }).click();
  await expect(view).toBeHidden();
});

test('quick access is customizable and remembered, and undo lists what it will undo', async ({ page }) => {
  await openEditor(page);
  const quick = page.getByRole('toolbar', { name: 'Quick access' });
  await page.getByRole('button', { name: 'Customize Quick Access Toolbar' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'New Document' }).click();
  await expect(quick.getByRole('button', { name: 'New Document' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await expect(quick.getByRole('button', { name: 'New Document' })).toBeVisible();
  // Undo history: each command names its step; choosing a step undoes everything after it too.
  await text(page).fill('Steps');
  await select(page, 0, 5);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await quick.getByRole('button', { name: 'Undo history' }).click();
  const history = page.getByRole('menu', { name: 'Undo history' });
  await expect(history.getByRole('menuitem').first()).toHaveText('Undo Italic');
  await history.getByRole('menuitem', { name: /to Bold/ }).click();
  const state = await engine(page);
  expect([state.bold, state.italic]).toEqual([false, false]);
  expect(state.text).toBe('Steps');
});

test('Editing, Reviewing and Viewing switch track changes and read-only viewing without losing text', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Draft');
  const mode = page.getByRole('button', { name: /^Editing mode/ });
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^Reviewing/ }).click();
  await expect(mode).toHaveAccessibleName('Editing mode: Reviewing');
  expect((await engine(page)).tracking).toBe(true);
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^Viewing/ }).click();
  expect((await engine(page)).viewOnly).toBe(true);
  await text(page).press('End');
  await page.keyboard.type(' more');
  expect((await engine(page)).text).toBe('Draft');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^Editing/ }).click();
  const state = await engine(page);
  expect([state.viewOnly, state.tracking]).toEqual([false, false]);
  await text(page).press('End');
  await page.keyboard.type('!');
  expect((await engine(page)).text).toBe('Draft!');
});

test('command search finds and runs ribbon and menu commands, and falls back to searching the text', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Find the needle here');
  await select(page, 0, 4);
  const search = page.getByRole('combobox', { name: 'Search for commands' });
  await search.click();
  await search.fill('bold');
  await expect(page.getByRole('listbox', { name: 'Commands' }).getByRole('option').first()).toContainText('Bold');
  await search.press('Enter');
  await expect.poll(async () => (await engine(page)).bold).toBe(true);
  await expect(text(page)).toBeFocused();
  // A menu command: Word Count.
  await search.click(); await search.fill('word count'); await search.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Word Count' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Nothing matching a command: search the document.
  await search.click(); await search.fill('needle');
  await page.getByRole('option', { name: /Find “needle” in the document/ }).click();
  await expect(page.getByRole('searchbox').or(page.getByRole('textbox', { name: /Search document/ })).first()).toHaveValue('needle');
});

test('the status bar counts the selection, picks a language that saves into the file, and is customizable', async ({ page }, info) => {
  await openEditor(page);
  await text(page).fill('one two three');
  await select(page, 0, 7);
  const bar = page.locator('.ed-statusbar');
  await expect(bar.locator('.ed-word-count')).toHaveText('2 of 3 words');
  await bar.locator('.ed-status-language').click();
  const dialog = page.getByRole('dialog', { name: 'Language' });
  await dialog.getByRole('searchbox', { name: 'Search languages' }).fill('fr-FR');
  await dialog.getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await select(page, 1, 2);
  await expect(bar.locator('.ed-status-language')).toContainText('French');
  // Right-click chooses what shows.
  await bar.click({ button: 'right', position: { x: 300, y: 10 } });
  await page.getByRole('menuitemcheckbox', { name: 'Word Count' }).click();
  await expect(bar.locator('.ed-word-count')).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await expect(page.locator('.ed-word-count')).toBeHidden();
  // The language is written as w:lang.
  await text(page).fill('Bonjour');
  await select(page, 0, 7);
  await page.locator('.ed-status-language').click();
  await page.getByRole('dialog', { name: 'Language' }).getByRole('searchbox').fill('de-DE');
  await page.getByRole('dialog', { name: 'Language' }).getByRole('option').first().click();
  await page.getByRole('dialog', { name: 'Language' }).getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('dialog', { name: 'File' }).getByRole('tab', { name: 'Export' }).click();
  const path = await saveDownload(page, info, 'language.docx', () => page.getByRole('dialog', { name: 'File' }).getByRole('button', { name: /^Word document/ }).click());
  expect(strFromU8(unzipSync(readFileSync(path))['word/document.xml'])).toContain('<w:lang w:val="de-DE"/>');
});

test('the ribbon collapses to its tabs and shows KeyTips for the keyboard', async ({ page }) => {
  await openEditor(page);
  const card = page.locator('.ed-ribbon');
  await text(page).fill('Tabs');
  await select(page, 0, 4);
  await page.locator('#ribbon-tab-home').dblclick();
  await expect(card).toBeHidden();
  // A tab click shows the commands over the document; running one puts them away.
  await page.locator('#ribbon-tab-home').click();
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(card).toBeHidden();
  expect((await engine(page)).bold).toBe(true);
  // The chord brings the ribbon back.
  await text(page).press(MAC ? 'Meta+Alt+r' : 'Control+F1');
  await expect(card).toBeVisible();
  // KeyTips: Alt alone labels the tabs; a letter opens one.
  await text(page).focus();
  await page.keyboard.press('Alt');
  await expect(page.locator('.ed-keytip', { hasText: /^N$/ })).toBeVisible();
  await page.keyboard.press('n');
  await expect(page.locator('#ribbon-tab-insert')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.ed-keytip').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ed-keytip')).toHaveCount(0);
});

test('the right-click menu fits a link, and Edit > Links lists and removes links', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.replace('Visit the site today'); e.model.select(6, 14); e.setHyperlink('https://example.com', null, { appearance: true }); e.model.select(8); e.syncInput(); e.onSelection(); });
  const canvas = page.locator('canvas.canvas-page').first();
  await canvas.click({ button: 'right', position: { x: 155, y: 110 } });
  const menu = page.getByRole('menu', { name: 'Document menu' });
  for (const name of ['Edit link…', 'Open link', 'Copy link', 'Remove link']) await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await (await openMenu(page, 'Edit')).getByRole('menuitem', { name: 'Links…', exact: true }).click();
  const links = page.getByRole('dialog', { name: 'Links' });
  await expect(links).toContainText('https://example.com');
  await links.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(links).toContainText('This document has no links.');
  expect(await canvas.count()).toBeGreaterThan(0);
});

test('copy and paste formatting, Repeat, and Customize Keyboard bindings', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Source target other');
  await select(page, 0, 6);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await text(page).press('ControlOrMeta+Shift+c');
  await select(page, 7, 13);
  await text(page).press('ControlOrMeta+Shift+v');
  expect((await engine(page)).bold).toBe(true);
  // Repeat runs the last command again (F4).
  await select(page, 14, 19);
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await select(page, 0, 6);
  await text(page).press('F4');
  expect((await engine(page)).italic).toBe(true);
  // A binding of your own: Underline on Ctrl/Cmd+Alt+J.
  await (await openMenu(page, 'Tools')).getByRole('menuitem', { name: 'Customize Keyboard…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Customize Keyboard' });
  await dialog.getByRole('searchbox', { name: 'Search commands' }).fill('underline');
  await dialog.getByRole('option', { name: /^Underline/ }).first().click();
  await dialog.getByRole('textbox', { name: 'New shortcut' }).click();
  await page.keyboard.press('ControlOrMeta+Alt+j');
  await expect(dialog.getByRole('textbox', { name: 'New shortcut' })).toHaveValue(MAC ? 'Cmd+Option+J' : 'Ctrl+Alt+J');
  await dialog.getByRole('button', { name: 'Assign' }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await select(page, 14, 19);
  await text(page).press('ControlOrMeta+Alt+j');
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.runFormatting.underline)).toBe(true);
  // The help sheet lists it.
  await text(page).press('ControlOrMeta+/');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('Underline');
});

test('a saved document keeps versions to restore and publishes a web page from the File view', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Version one');
  await text(page).press('ControlOrMeta+s');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'File' });
  const versions = view.locator('#bs-versions');
  await versions.getByRole('button', { name: 'Save a Version Now' }).click();
  await expect(versions.getByRole('button', { name: 'Restore' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await text(page).press('ControlOrMeta+End');
  await page.keyboard.type(' and two');
  await text(page).press('ControlOrMeta+s');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  // The newest entry is the snapshot just before this save's: restore the one holding "Version one".
  await versions.getByRole('button', { name: 'Restore' }).last().click();
  await page.getByRole('dialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore' }).click();
  await expect(text(page)).toHaveValue('Version one');
  // Share: publish a read-only page and get its link.
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await view.getByRole('tab', { name: 'Share' }).click();
  await view.getByRole('button', { name: 'Publish to the Web' }).click();
  await expect(view.locator('.bs-share-status a')).toHaveAttribute('href', /^https:\/\/.+\.puter\.site/);
  await expect(view.getByRole('button', { name: 'Stop Publishing' })).toBeVisible();
});
