import { test, expect } from '@playwright/test';

// Fonts, sizes and colours reach the message that is sent: when chosen at a
// caret and typed after, and after Undo and Redo, which replay the browser's
// own steps.

const sentHtml = (raw) => {
  const part = raw.split(/Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/)[1].split('\r\n--')[0];
  return Buffer.from(part.replace(/\r\n/g, ''), 'base64').toString();
};

test('a colour and a size chosen at the caret colour and size what is typed next, in order', async ({ page }) => {
  let raw = '';
  await page.route('**/test-api/email/send', async (route) => {
    raw = route.request().postData();
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/tests/browser/composer.html');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.getByRole('combobox', { name: 'To', exact: true }).fill('alex@example.com');
  await page.getByRole('combobox', { name: 'To', exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Colours');
  const body = page.getByRole('textbox', { name: 'Message body' });
  await body.click();
  await page.keyboard.type('Hello ');
  await page.getByRole('button', { name: 'Text colour' }).click();
  await page.getByRole('menuitemradio', { name: 'Red' }).click();
  await page.keyboard.type('red words');
  await page.getByRole('button', { name: 'Size' }).click();
  await page.getByRole('menuitemradio', { name: 'Huge' }).click();
  await page.keyboard.type(' big');
  await expect(body).toHaveText('Hello red words big');
  await body.press('ControlOrMeta+Enter');
  await expect.poll(() => raw).not.toBe('');
  const html = sentHtml(raw);
  expect(html).toMatch(/color[^>]*>red words/);
  expect(html).toMatch(/font-size: 26px[^>]*>(&nbsp;| )big/);
});

test('redo after undoing a colour keeps the colour in what is saved and sent', async ({ page }) => {
  let raw = '';
  await page.route('**/test-api/email/send', async (route) => {
    raw = route.request().postData();
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/tests/browser/composer.html');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.getByRole('combobox', { name: 'To', exact: true }).fill('alex@example.com');
  await page.getByRole('combobox', { name: 'To', exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Colours');
  const body = page.getByRole('textbox', { name: 'Message body' });
  await body.fill('Important deadline');
  await body.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Text colour' }).click();
  await page.getByRole('menuitemradio', { name: 'Red' }).click();
  await body.press('ControlOrMeta+z');
  await body.press('ControlOrMeta+Shift+z');
  await body.press('ControlOrMeta+Enter');
  await expect.poll(() => raw).not.toBe('');
  // The words are red on screen, so they must be red in what was sent.
  expect(sentHtml(raw)).toMatch(/color[^>]*>Important deadline/);
});

test('a colour chosen and undone sends plain text, and Redo of a size keeps the size', async ({ page }) => {
  let raw = '';
  await page.route('**/test-api/email/send', async (route) => {
    raw = route.request().postData();
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/tests/browser/composer.html');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Message body' });
  await body.fill('Big news');
  await body.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Size' }).click();
  await page.getByRole('menuitemradio', { name: 'Huge' }).click();
  await body.press('ControlOrMeta+z');
  await body.press('ControlOrMeta+Shift+z');
  await expect(body.locator('span[style*="font-size: 26px"]', { hasText: 'Big' })).toHaveText('Big news');
  await body.press('ControlOrMeta+z');
  await page.getByRole('combobox', { name: 'To', exact: true }).fill('alex@example.com');
  await page.getByRole('combobox', { name: 'To', exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('News');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => raw).not.toBe('');
  expect(raw).not.toContain('text/html');
});

test('a word composed with an input method after a colour is kept whole, and coloured', async ({ page }) => {
  await page.goto('/tests/browser/composer.html');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Message body' });
  await body.click();
  await page.keyboard.type('Hello ');
  await page.getByRole('button', { name: 'Text colour' }).click();
  await page.getByRole('menuitemradio', { name: 'Red' }).click();
  const cdp = await page.context().newCDPSession(page);
  for (const text of ['n', 'に', 'にh', 'にほ', 'にほn', 'にほん']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await cdp.send('Input.insertText', { text: '日本' });
  await page.keyboard.type('!');
  await expect(body).toHaveText('Hello 日本!');
  await expect(body.locator('span[style*="color"]')).toHaveText('日本!');
  await expect(body.locator('font')).toHaveCount(0);
});
