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
