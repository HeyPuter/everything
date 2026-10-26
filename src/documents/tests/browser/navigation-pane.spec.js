import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

async function headingsDocument(page) {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Introduction\nThe plan in brief.\nBackground\nWhy the plan matters.\nResults\nThe final plan.');
  for (const [text, level] of [['Introduction', 1], ['Background', 2], ['Results', 1]]) {
    await input.evaluate((el, text) => { const at = el.value.indexOf(text); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
    await input.press(`Control+Alt+${level}`);
  }
  return input;
}

test('the Navigation pane browses headings, collapses levels and goes to a heading', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await headingsDocument(page);
  await (await onTab(page, 'view')).locator('.ribbon-card').getByRole('button', { name: 'Navigation Pane' }).click();
  const pane = page.getByRole('complementary', { name: 'Navigation' });
  const tree = pane.getByRole('tree', { name: 'Headings' });
  await expect(tree.getByRole('treeitem')).toHaveText(['Introduction', 'Background', 'Results']);
  await pane.getByRole('button', { name: 'Collapse Introduction' }).click();
  await expect(tree.getByRole('treeitem')).toHaveText(['Introduction', 'Results']);
  await pane.getByRole('button', { name: 'Expand Introduction' }).click();
  await tree.getByRole('treeitem', { name: /Background/ }).click();
  await expect(input).toBeFocused();
  expect(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionStart + 10))).toBe('Background');
  await expect(tree.getByRole('treeitem', { name: /Background/ })).toHaveAttribute('aria-current', 'location');
  expect(errors).toEqual([]);
});

test('Ctrl/Cmd+F searches from the pane, lists results in context and pages show as thumbnails', async ({ page }) => {
  const input = await headingsDocument(page);
  await input.evaluate(el => { const at = el.value.indexOf('plan'); el.setSelectionRange(at, at + 4); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await input.press('ControlOrMeta+f');
  const pane = page.getByRole('complementary', { name: 'Navigation' });
  const search = pane.getByRole('searchbox', { name: 'Search document' });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('plan');
  await expect(pane.getByRole('status')).toHaveText('3 results');
  await expect(pane.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
  await expect(pane.locator('.nav-result')).toHaveCount(3);
  await pane.locator('.nav-result').nth(2).click();
  expect(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('plan');
  expect(await input.evaluate(el => el.value.lastIndexOf('plan'))).toBe(await input.evaluate(el => el.selectionStart));
  await search.press('Enter');
  await expect(pane.getByRole('status')).toHaveText('Result 1 of 3');
  await search.fill('nothing like this');
  await expect(pane.getByRole('status')).toHaveText('No matches');
  await pane.getByRole('tab', { name: 'Pages' }).click();
  await expect(pane.getByRole('listitem').getByRole('button', { name: 'Page 1' })).toBeVisible();
  await pane.getByRole('listitem').getByRole('button', { name: 'Page 1' }).click();
  await expect(input).toBeFocused();
  await pane.getByRole('searchbox').press('Escape');
  await pane.getByRole('searchbox').press('Escape');
  await expect(pane).toBeHidden();
});

test('choosing a search result keeps keyboard focus on it, and the count follows edits', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await headingsDocument(page);
  await (await onTab(page, 'view')).locator('.ribbon-card').getByRole('button', { name: 'Navigation Pane' }).click();
  const pane = page.getByRole('complementary', { name: 'Navigation' });
  await pane.getByRole('searchbox', { name: 'Search document' }).fill('plan');
  const results = pane.locator('.nav-result');
  await expect(results).toHaveCount(3);
  await results.nth(1).focus();
  await page.keyboard.press('Enter');
  expect(await input.evaluate(el => el.selectionStart)).toBe(await input.evaluate(el => el.value.indexOf('plan', el.value.indexOf('plan') + 1)));
  await expect(results.nth(1)).toBeFocused();
  await expect(results.nth(1)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Tab');
  await expect(results.nth(2)).toBeFocused();
  await expect(pane.getByRole('status')).toHaveText('Result 2 of 3');
  // Another match typed into the document updates the count.
  await input.focus();
  await input.press('ControlOrMeta+End');
  await page.keyboard.type(' A plan.');
  await expect(results).toHaveCount(4);
  await expect(pane.getByRole('status')).toHaveText('Result 2 of 4');
  expect(errors).toEqual([]);
});

test('the Headings tree moves, expands and collapses with the arrow keys', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await headingsDocument(page);
  await (await onTab(page, 'view')).locator('.ribbon-card').getByRole('button', { name: 'Navigation Pane' }).click();
  const tree = page.getByRole('complementary', { name: 'Navigation' }).getByRole('tree', { name: 'Headings' });
  const item = name => tree.getByRole('treeitem', { name: new RegExp(name) });
  await item('Introduction').focus();
  await page.keyboard.press('ArrowDown');
  await expect(item('Background')).toBeFocused();
  await page.keyboard.press('End');
  await expect(item('Results')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(item('Introduction')).toBeFocused();
  // Left collapses the heading with subheadings, then Right opens it again and steps into it.
  await page.keyboard.press('ArrowLeft');
  await expect(item('Introduction')).toHaveAttribute('aria-expanded', 'false');
  await expect(tree.getByRole('treeitem')).toHaveText(['Introduction', 'Results']);
  await expect(item('Introduction')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(item('Introduction')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(item('Background')).toBeFocused();
  // Left from a subheading goes to its parent.
  await page.keyboard.press('ArrowLeft');
  await expect(item('Introduction')).toBeFocused();
  expect(errors).toEqual([]);
});

test('Shift+Enter in a new search goes to the last result, Enter to the first', async ({ page }) => {
  const input = await headingsDocument(page);
  await input.press('ControlOrMeta+f');
  const pane = page.getByRole('complementary', { name: 'Navigation' });
  const search = pane.getByRole('searchbox', { name: 'Search document' });
  await search.fill('plan');
  await expect(pane.getByRole('status')).toHaveText('3 results');
  await search.press('Shift+Enter');
  await expect(pane.getByRole('status')).toHaveText('Result 3 of 3');
  expect(await input.evaluate(el => el.selectionStart)).toBe(await input.evaluate(el => el.value.lastIndexOf('plan')));
  await search.fill('plan ');
  await search.fill('plan');
  await search.press('Enter');
  await expect(pane.getByRole('status')).toHaveText('Result 1 of 3');
});
