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

test('Enter ends the word before it as a space does: the pronoun i and a fraction are corrected there too', async ({ page }) => {
  await blank(page);
  await page.keyboard.type('so do i');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('So do I\n');
  // Undo takes back the correction alone, leaving the new paragraph.
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('So do i\n');
  await page.keyboard.type('half 1/2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('next');
  await expect(input(page)).toHaveValue('So do i\nHalf ½\nNext');
  // The caret went on in the new paragraph, though the fraction is shorter than what was typed.
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.range)).toEqual([19, 19]);
  // A typed list marker alone is not made a list by Enter.
  await page.keyboard.press('Enter'); await page.keyboard.type('*'); await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('So do i\nHalf ½\nNext\n*\n');
  expect(await page.getByRole('button', { name: 'Bulleted list', exact: true }).getAttribute('aria-pressed')).toBe('false');
});

test('a web or email address at the start of a line stays as typed', async ({ page }) => {
  await blank(page);
  // The first letter is capitalized as the start of a sentence, and goes back to the one typed once the word is an address.
  await page.keyboard.type('john'); await expect(input(page)).toHaveValue('John');
  await page.keyboard.type('@e'); await expect(input(page)).toHaveValue('john@e');
  await page.keyboard.type('xample.com '); await expect(input(page)).toHaveValue('john@example.com ');
  // A host on a well-known domain, when the space or the new line ends it; a scheme and "www." while they are typed.
  await page.keyboard.press('Enter'); await page.keyboard.type('example.com');
  await page.keyboard.press('Enter'); await page.keyboard.type('www.example.org/a is up. sales@example.org wrote. ask them');
  await page.keyboard.press('Enter'); await page.keyboard.type('https://example.net ');
  await expect(input(page)).toHaveValue('john@example.com \nexample.com\nwww.example.org/a is up. sales@example.org wrote. Ask them\nhttps://example.net ');
  expect(await links(page)).toEqual([['john@example.com', 'mailto:john@example.com'], ['example.com', 'https://example.com'],
    ['www.example.org/a', 'https://www.example.org/a'], ['sales@example.org', 'mailto:sales@example.org'], ['https://example.net', 'https://example.net']]);
  // Taking the capital back is a step of its own: Undo returns the capital.
  await page.keyboard.press('Enter'); await page.keyboard.type('mary@x');
  await expect(input(page)).toHaveValue(/\nmary@x$/);
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue(/\nMary@x$/);
  // A capital the writer typed stays, and so do ordinary sentences.
  await page.keyboard.press('Enter'); await page.keyboard.type('Bob@example.com and hello. ok');
  await expect(input(page)).toHaveValue(/\nBob@example\.com and hello\. Ok$/);
});

test('a capital deleted and typed again in lowercase stays lowercase', async ({ page }) => {
  await blank(page);
  await page.keyboard.type('i'); await expect(input(page)).toHaveValue('I');
  await page.keyboard.press('Backspace'); await page.keyboard.type('iphone is here');
  await expect(input(page)).toHaveValue('iphone is here');
  // Typed over while selected, and deleted with Delete.
  await page.keyboard.press('Enter'); await page.keyboard.type('ebay');
  await expect(input(page)).toHaveValue('iphone is here\nEbay');
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.type('e');
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('apple');
  await page.keyboard.press('Home'); await page.keyboard.press('Delete'); await page.keyboard.type('a');
  await expect(input(page)).toHaveValue('iphone is here\nebay\napple');
  // Another letter in its place, or a word deleted by a run of presses and typed again, starts the sentence as usual.
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('x');
  await page.keyboard.press('Backspace'); await page.keyboard.type('yes');
  await page.keyboard.press('Enter'); await page.keyboard.type('teh');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('the');
  await expect(input(page)).toHaveValue('iphone is here\nebay\napple\nYes\nThe');
});
