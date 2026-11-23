import { test, expect } from '@playwright/test';

// The find box offers tools as well as finding words in the PDF.
test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.keyboard.press('ControlOrMeta+f');
});

const option = (page, label) =>
  page.getByRole('option', { name: `Open tool: ${label}`, exact: true });

test('several words find a tool whose words are not side by side', async ({ page }) => {
  const find = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  // Organize pages deletes pages, and Edit a PDF changes text: neither says so in those words.
  await find.fill('delete page');
  await expect(option(page, 'Organize pages')).toBeVisible();
  await find.fill('edit text');
  await expect(option(page, 'Edit a PDF')).toBeVisible();
  await find.fill('pages delete');
  await expect(option(page, 'Organize pages')).toBeVisible();
  // Every word must still be found, from its start.
  await find.fill('delete otter');
  await expect(page.getByRole('listbox', { name: 'Matching tools' })).toBeHidden();
  await expect(find).toHaveAttribute('aria-expanded', 'false');
});

test('the everyday names of formats and tasks offer their tools', async ({ page }) => {
  const find = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  for (const [words, tool] of [
    ['word', 'Export a PDF'],
    ['docx', 'Export a PDF'],
    ['excel', 'Export a PDF'],
    ['powerpoint', 'Export a PDF'],
    ['jpg', 'Export a PDF'],
    ['encrypt', 'Protect a PDF'],
    ['remove password', 'Protect a PDF'],
    ['reduce size', 'Compress a PDF'],
    ['hyperlink', 'Edit a PDF'],
    ['metadata', 'Document properties'],
  ]) {
    await find.fill(words);
    await expect(option(page, tool)).toBeVisible();
  }
});

// A command the tools pane holds was not found by its own name: "shape" or "underline" found
// nothing although Add comments offers them, and "draw" found only Measure.
test("a tool's own commands find it, after the tools named for the words", async ({ page }) => {
  const find = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  const options = page.getByRole('listbox', { name: 'Matching tools' }).getByRole('option');
  for (const [words, tool] of [
    ['shape', 'Add comments'],
    ['arrow', 'Add comments'],
    ['underline', 'Add comments'],
    ['strikethrough', 'Add comments'],
    ['pencil', 'Add comments'],
    ['callout', 'Add comments'],
    ['blank page', 'Organize pages'],
    ['remove page', 'Organize pages'],
    ['detect fields', 'Prepare a form'],
    ['lock', 'Protect a PDF'],
  ]) {
    await find.fill(words);
    await expect(option(page, tool)).toBeVisible();
  }
  await find.fill('draw');
  await expect(options.first()).toHaveAccessibleName('Open tool: Add comments');
  // Tools named for the words still come first.
  await find.fill('delete page');
  await expect(options.first()).toHaveAccessibleName('Open tool: Organize pages');
  await find.fill('rotate');
  await expect(options.first()).toHaveAccessibleName('Open tool: Organize pages');
});

// Commands the menus hold but no tool does (Download, Full screen, Go to page) were not found
// at all: the find box offered only tools.
test('the find box offers menu commands after the tools', async ({ page }) => {
  const find = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  const list = page.getByRole('listbox', { name: 'Matching tools' });
  for (const [words, command] of [
    ['download', 'Download'],
    ['full screen', 'Full screen mode'],
    ['read aloud', 'Read this page'],
    ['dark pages', 'Dark page colors'],
    ['go to page', 'Go to page…'],
    ['bookmarks', 'Outline panel'],
    ['attachments', 'Attachments panel'],
  ]) {
    await find.fill(words);
    await expect(list.getByRole('option', { name: command, exact: true })).toBeVisible();
  }
  // Tools still come first.
  await find.fill('compress');
  await expect(list.getByRole('option').first()).toHaveAccessibleName('Open tool: Compress a PDF');
  // Choosing a command runs it, as the menu would.
  await find.fill('dark pages');
  await page.keyboard.press('ArrowDown');
  await expect(
    list.getByRole('option', { name: 'Dark page colors', selected: true }),
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(find).toBeHidden();
  await expect(page.locator('.editor')).toHaveClass(/dark-pages/);
  await page.keyboard.press('ControlOrMeta+f');
  await find.fill('attachments');
  await list.getByRole('option', { name: 'Attachments panel', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
