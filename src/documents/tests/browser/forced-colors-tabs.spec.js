import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

/*
 * Windows contrast themes paint every border in the text color, a tab's clear underline included: every tab of the
 * Navigation and Styles panes and the Font and Paragraph dialogs looked chosen. Only the chosen tab keeps an underline
 * there; the Styles pane's current style and the chosen Preferences section, marked by a ring or a tint, are outlined.
 */
const underline = el => { const s = getComputedStyle(el); return s.borderBottomStyle !== 'none' && parseFloat(s.borderBottomWidth) > 0 && s.borderBottomColor !== 'rgba(0, 0, 0, 0)'; };

test('in a contrast theme only the chosen tab is underlined, and the current style is outlined', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await onTab(page, 'home');
  await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Styles Pane', exact: true }).click();
  await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.locator('.styles-pane .styles-pane-item.is-current')).toBeVisible();
  const tabs = () => page.evaluate(src => {
    const underline = new Function(`return ${src}`)();
    return [...document.querySelectorAll('[role=tab]:is(.nav-tab, .styles-pane-tab, .ed-font-tab)')].filter(t => t.getClientRects().length)
      .map(t => `${t.className}:${t.getAttribute('aria-selected')}:${underline(t)}`);
  }, underline.toString());
  const shown = await tabs();
  expect(shown.filter(t => t.startsWith('nav-tab')).length).toBeGreaterThan(1);
  expect(shown.filter(t => t.startsWith('styles-pane-tab')).length).toBeGreaterThan(1);
  for (const t of shown) expect(t.endsWith(':true:true') || t.endsWith(':false:false'), t).toBe(true);
  const current = await page.locator('.styles-pane .styles-pane-item.is-current').evaluate(el => getComputedStyle(el).outlineStyle);
  expect(current).not.toBe('none');
  expect(await page.locator('.styles-pane .styles-pane-item:not(.is-current)').first().evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');

  await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Font Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Font' })).toBeVisible();
  const font = (await tabs()).filter(t => t.startsWith('ed-font-tab'));
  expect(font.length).toBe(2);
  for (const t of font) expect(t.endsWith(':true:true') || t.endsWith(':false:false'), t).toBe(true);
});

test('in a contrast theme the picture tabs and Preferences sections mark only the chosen one', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const wrong = await page.evaluate(src => {
    const underline = new Function(`return ${src}`)();
    const make = (className, selected) => { const b = document.createElement('button'); b.className = className; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(selected)); b.textContent = 'Tab'; document.body.append(b); return b; };
    const out = [];
    for (const c of ['pic-dialog-tab', 'pic-pane-tab']) if (!underline(make(c, true)) || underline(make(c, false))) out.push(c);
    const pref = [make('pref-tab', true), make('pref-tab', false)].map(b => getComputedStyle(b).outlineStyle);
    if (pref[0] === 'none' || pref[1] !== 'none') out.push('pref-tab');
    return out;
  }, underline.toString());
  expect(wrong).toEqual([]);
});
