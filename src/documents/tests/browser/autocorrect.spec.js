import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const links = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.link).map(r => [r.text, r.link.target]));
async function blank(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
}

test('typing corrects quotes, dashes, symbols and sentence starts, and links addresses', async ({ page }) => {
  await blank(page);
  await page.keyboard.type('she said "hi" -- it\'s 1/2 done... (c) ok. next see example.com');
  await page.keyboard.press('Enter');
  await page.keyboard.type('mail me@example.org now');
  await expect(input(page)).toHaveValue('She said “hi” — it’s ½ done… © ok. Next see example.com\nMail me@example.org now');
  expect(await links(page)).toEqual([['example.com', 'https://example.com'], ['me@example.org', 'mailto:me@example.org']]);
  // Undo takes back a correction alone, leaving what was typed.
  await page.keyboard.press('Home'); await page.keyboard.press('End'); await page.keyboard.type('. "');
  await expect(input(page)).toHaveValue(/now\. “$/);
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue(/now\. "$/);
  // Addresses keep their own punctuation.
  await page.keyboard.press('Enter'); await page.keyboard.type('Visit https://example.com/a--b... ');
  await expect(input(page)).toHaveValue(/Visit https:\/\/example\.com\/a--b\.\.\. $/);
});

test('the account menu settings turn corrections and links off', async ({ page }) => {
  await blank(page);
  const account = page.locator('.canvas-title-actions .user-btn');
  for (const name of ['Autocorrect as you type', 'Capitalize the first letter of sentences', 'Link web addresses as you type']) {
    await account.click(); await page.getByRole('menuitemcheckbox', { name: new RegExp(`^${name}`) }).click();
  }
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('plain "text" -- see example.com ');
  await expect(input(page)).toHaveValue('plain "text" -- see example.com ');
  expect(await links(page)).toEqual([]);
});

test('a bullet or number typed at the start of a paragraph starts a list', async ({ page }) => {
  await blank(page);
  const pressed = name => page.getByRole('button', { name, exact: true }).getAttribute('aria-pressed');
  await page.keyboard.type('* First'); await page.keyboard.press('Enter'); await page.keyboard.type('Second');
  expect(await pressed('Bulleted list')).toBe('true');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.type('1. One');
  expect(await pressed('Numbered list')).toBe('true');
  await expect(input(page)).toHaveValue('First\nSecond\nOne');
  // Undo takes back the word, then turns the list back into the typed marker.
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('First\nSecond\n');
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('First\nSecond\n1. ');
  expect(await pressed('Numbered list')).toBe('false');
  // Inside a sentence, or in a list already, the characters stay as typed.
  await page.keyboard.press('Enter'); await page.keyboard.type('Pick - or * here');
  await expect(input(page)).toHaveValue(/Pick - or \* here$/);
});

test('the pronoun i becomes a capital once its word ends, and Undo takes that back alone', async ({ page }) => {
  await blank(page);
  await page.keyboard.type("yes i think i'm right, and so do i. it is (i) fine, i.e. good ");
  await expect(input(page)).toHaveValue('Yes I think I’m right, and so do I. It is (i) fine, i.e. good ');
  await page.keyboard.type('and i');
  await page.keyboard.type(' ');
  await expect(input(page)).toHaveValue('Yes I think I’m right, and so do I. It is (i) fine, i.e. good and I ');
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('Yes I think I’m right, and so do I. It is (i) fine, i.e. good and i ');
});
