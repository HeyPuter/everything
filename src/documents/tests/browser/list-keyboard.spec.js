import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const items = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.map(p => [p.runs.map(r => r.text).join(''), p.list ? p.list.level : null]));

test('Tab and Shift+Tab at the start of a list item demote and promote it', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha\nBravo\nCharlie\nAfter');
  await input(page).evaluate(el => { el.setSelectionRange(0, 19); el.dispatchEvent(new Event('select')); });
  await page.getByRole('button', { name: 'Bulleted list', exact: true }).click();
  await input(page).evaluate(el => { el.focus(); el.setSelectionRange(6, 6); el.dispatchEvent(new Event('select')); });
  await input(page).press('Tab');
  expect(await items(page)).toEqual([['Alpha', 0], ['Bravo', 1], ['Charlie', 0], ['After', null]]);
  // Over several whole items, Tab demotes them all.
  await input(page).evaluate(el => { el.setSelectionRange(6, 19); el.dispatchEvent(new Event('select')); });
  await input(page).press('Tab');
  expect(await items(page)).toEqual([['Alpha', 0], ['Bravo', 2], ['Charlie', 1], ['After', null]]);
  await input(page).press('Shift+Tab');
  expect(await items(page)).toEqual([['Alpha', 0], ['Bravo', 1], ['Charlie', 0], ['After', null]]);
  // Inside an item's text, and outside lists, Tab still types a tab.
  await input(page).evaluate(el => { el.setSelectionRange(8, 8); el.dispatchEvent(new Event('select')); });
  await input(page).press('Tab');
  expect((await items(page))[1]).toEqual(['Br\tavo', 1]);
  await input(page).press('End');
  await input(page).press('ControlOrMeta+End');
  await input(page).press('Home');
  await input(page).press('Tab');
  expect((await items(page))[3]).toEqual(['\tAfter', null]);
  // At the top level Shift+Tab leaves the document, as it does elsewhere.
  await input(page).evaluate(el => { el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  await input(page).press('Shift+Tab');
  expect((await items(page))[0]).toEqual(['Alpha', 0]);
  await expect(input(page)).not.toBeFocused();
});

test('Enter on an empty nested list item steps it out a level, then ends the list', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('* Alpha'); await page.keyboard.press('Enter');
  await page.keyboard.press('Tab'); await page.keyboard.type('Inner'); await page.keyboard.press('Enter');
  expect(await items(page)).toEqual([['Alpha', 0], ['Inner', 1], ['', 1]]);
  await page.keyboard.press('Enter');
  expect(await items(page)).toEqual([['Alpha', 0], ['Inner', 1], ['', 0]]);
  await page.keyboard.type('Bravo');
  expect(await items(page)).toEqual([['Alpha', 0], ['Inner', 1], ['Bravo', 0]]);
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  expect(await items(page)).toEqual([['Alpha', 0], ['Inner', 1], ['Bravo', 0], ['', null]]);
});

test('on a Mac, Option+Shift+Arrow selects by word in a list item and Control+Shift+Arrow changes its level', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha bravo\nCharlie');
  await input(page).evaluate(el => { el.setSelectionRange(0, 19); el.dispatchEvent(new Event('select')); });
  await page.getByRole('button', { name: 'Bulleted list', exact: true }).click();
  await input(page).evaluate(el => { el.focus(); el.setSelectionRange(11, 11); el.dispatchEvent(new Event('select')); });
  // Option+Shift+Left selects the word before the caret, as in every Mac text field.
  await input(page).press('Alt+Shift+ArrowLeft');
  expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([6, 11]);
  expect(await items(page)).toEqual([['Alpha bravo', 0], ['Charlie', 0]]);
  // Control+Shift+Right and Left demote and promote the item there, as Control+Shift+Up and Down move paragraphs.
  await input(page).press('Control+Shift+ArrowRight');
  expect(await items(page)).toEqual([['Alpha bravo', 1], ['Charlie', 0]]);
  await input(page).press('Control+Shift+ArrowLeft');
  expect(await items(page)).toEqual([['Alpha bravo', 0], ['Charlie', 0]]);
});

test('elsewhere Alt+Shift+Right and Left change a list item\'s level', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha bravo\nCharlie');
  await input(page).evaluate(el => { el.setSelectionRange(0, 19); el.dispatchEvent(new Event('select')); });
  await page.getByRole('button', { name: 'Bulleted list', exact: true }).click();
  await input(page).evaluate(el => { el.focus(); el.setSelectionRange(11, 11); el.dispatchEvent(new Event('select')); });
  await input(page).press('Alt+Shift+ArrowRight');
  expect(await items(page)).toEqual([['Alpha bravo', 1], ['Charlie', 0]]);
  await input(page).press('Alt+Shift+ArrowLeft');
  expect(await items(page)).toEqual([['Alpha bravo', 0], ['Charlie', 0]]);
});

test('in Viewing mode Tab moves the keyboard on from the document, as from any read-only field', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha\nBravo');
  await input(page).evaluate(el => { el.setSelectionRange(0, 11); el.dispatchEvent(new Event('select')); });
  await page.getByRole('button', { name: 'Bulleted list', exact: true }).click();
  await page.getByRole('button', { name: /^Editing mode/ }).click();
  await page.getByRole('menuitemradio', { name: /^Viewing/ }).click();
  // At the start of a list item, where Tab would demote it while editing.
  await input(page).evaluate(el => { el.focus(); el.setSelectionRange(6, 6); el.dispatchEvent(new Event('select')); });
  await input(page).press('Tab');
  await expect(input(page)).not.toBeFocused();
  expect(await items(page)).toEqual([['Alpha', 0], ['Bravo', 0]]);
});
