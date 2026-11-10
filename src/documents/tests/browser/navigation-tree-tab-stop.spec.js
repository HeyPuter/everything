import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

test('the Headings tree is one Tab stop, on the heading the keyboard was last on', async ({ page }) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  const headings = ['Introduction', 'Background', 'Method', 'Results', 'Discussion', 'Summary'];
  await input.fill(headings.map(h => `${h}\nBody text.`).join('\n'));
  for (const text of headings) {
    await input.evaluate((el, text) => { const at = el.value.indexOf(text); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
    await input.press('Control+Alt+1');
  }
  await (await onTab(page, 'view')).locator('.ribbon-card').getByRole('button', { name: 'Navigation Pane' }).click();
  const pane = page.getByRole('complementary', { name: 'Navigation' });
  const tree = pane.getByRole('tree', { name: 'Headings' });
  const item = name => tree.getByRole('treeitem', { name: new RegExp(name) });
  await expect(tree.getByRole('treeitem')).toHaveText(headings);
  // Tab from the tabs before the tree enters it once, and the next Tab leaves it.
  await pane.getByRole('tab', { name: 'Headings' }).focus();
  await page.keyboard.press('Tab');
  const first = page.locator(':focus');
  await expect(first).toHaveRole('treeitem');
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).not.toHaveRole('treeitem');
  // Back in, the arrows move; leaving and coming back lands where they left off.
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator(':focus')).toHaveRole('treeitem');
  await item('Introduction').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(item('Method')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(pane.getByRole('tab', { name: 'Headings' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(item('Method')).toBeFocused();
  expect(await tree.getByRole('treeitem').evaluateAll(items => items.filter(node => node.tabIndex === 0).length)).toBe(1);
});
