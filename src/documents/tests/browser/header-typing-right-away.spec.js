import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Choosing a header or footer design opens that story before anything is awaited: keys typed right after the
// click go into the header (or footer), not into the body behind it.
const stories = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine;
  return { body: e.session.body.text, path: e.session.path, others: [...e.session.models.entries()].filter(([path]) => path !== null).map(([, m]) => m.text) };
});

test('keys typed right after Insert > Header > Blank go into the header', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.focus();
  await page.keyboard.insertText('Body');
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Blank: One line/ }).click();
  await page.keyboard.insertText('HEAD');
  await expect.poll(async () => (await stories(page)).others).toContain('HEAD');
  expect((await stories(page)).body).toBe('Body');
});

test('with odd and even headers, keys typed right after Insert > Footer > Blank go into the footer', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.focus();
  await page.keyboard.insertText('Body');
  await page.evaluate(() => window.__docs.current.view.commands.headerItems('header').find(item => item.label === 'Edit Header').onSelect());
  await expect.poll(async () => (await stories(page)).path).not.toBeNull();
  await page.getByRole('checkbox', { name: 'Different Odd & Even Pages' }).check();
  await page.getByRole('button', { name: 'Close Header and Footer' }).click();
  await expect.poll(async () => (await stories(page)).path).toBeNull();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Footer', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Blank: One line/ }).click();
  await page.keyboard.insertText('FOOT');
  await expect.poll(async () => (await stories(page)).others).toContain('FOOT');
  expect((await stories(page)).body).toBe('Body');
});
