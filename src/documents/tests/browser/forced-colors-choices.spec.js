import { test, expect } from '@playwright/test';

/*
 * Windows contrast themes (forced colors) drop backgrounds and shadows. A choice marked only by a tint
 * or a ring (the chosen chart type, list style, layout option, pen color, suggestion) then looks like the
 * others; each takes the system highlight outline instead, as the ribbon's chosen style does.
 */
const CHOICES = [
  ['button.insert-special-row', 'aria-selected'], ['button.insert-icon', 'aria-pressed'], ['button.insert-diagram-layout', 'aria-selected'],
  ['button.insert-chart-type', 'aria-selected'], ['button.pic-layout-item', 'aria-checked'], ['button.pic-pane-tab', 'aria-selected'],
  ['button.rv-language', 'aria-selected'], ['div.wcc-mention', 'aria-selected'], ['button.draw-pen-swatch', 'aria-checked'],
  ['div.fmt-listbox-item', 'aria-selected'], ['button.fmt-preset', 'aria-pressed'], ['button.fmt-symbol', 'aria-checked'],
  ['div.fmt-level-item', 'aria-selected'], ['button.fmt-list-tile', 'aria-pressed'], ['button.list-library-tile', 'aria-checked'],
  ['div.mm-format-item', 'aria-selected'], ['div.mm-column-item', 'aria-selected'], ['button.ps-preset', 'aria-pressed'],
  ['button.table-pen-item', 'aria-checked'], ['button.ed-proof-suggestion', 'aria-selected'],
];

test('contrast themes outline the chosen item of every picker that marks it with a tint or a ring', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const unmarked = await page.evaluate(choices => choices.filter(([selector, attribute]) => {
    const [tag, className] = selector.split('.');
    const make = value => { const node = document.createElement(tag); node.className = className; node.setAttribute(attribute, value); node.textContent = 'X'; document.body.append(node); return node; };
    const chosen = getComputedStyle(make('true')), other = getComputedStyle(make('false'));
    return !(chosen.outlineStyle !== 'none' && parseFloat(chosen.outlineWidth) >= 2 && other.outlineStyle === 'none');
  }).map(([selector]) => selector), CHOICES);
  expect(unmarked).toEqual([]);
});

test('in a contrast theme the Columns dialog shows which preset is chosen', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('#ribbon-tab-layout').click();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitem', { name: 'More Columns…' }).click();
  const dialog = page.getByRole('dialog');
  const chosen = dialog.locator('.ps-preset[aria-pressed="true"]').first();
  await expect(chosen).toBeVisible();
  expect(await chosen.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
  expect(await dialog.locator('.ps-preset[aria-pressed="false"]').first().evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');
  await page.keyboard.press('Escape');
});
