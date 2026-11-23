import { test, expect } from '@playwright/test';
import { createCanvas } from '@napi-rs/canvas';

// Pictures chosen together with files that cannot become pages (a GIF, a text file) made a PDF
// of the pictures alone, and nothing said that the other files had been left out.
const picture = async () => {
  const canvas = createCanvas(4, 3);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d02020';
  ctx.fillRect(0, 0, 4, 3);
  return canvas.encode('png');
};

for (const [label, extra, message] of [
  [
    'one file',
    [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') }],
    'notes.txt was left out. Only PNG and JPEG pictures become pages.',
  ],
  [
    'several files',
    [
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
      { name: 'moving.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') },
    ],
    '2 files were left out. Only PNG and JPEG pictures become pages.',
  ],
])
  test(`pictures opened with ${label} that cannot become a page say so`, async ({ page }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    const buffer = await picture();
    await (
      await chooser
    ).setFiles([
      { name: 'first.png', mimeType: 'image/png', buffer },
      ...extra,
      { name: 'second.png', mimeType: 'image/png', buffer },
    ]);
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
    await expect(page.locator('#toast')).toHaveText(message);
  });

test('pictures alone open without a notice', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'only.png', mimeType: 'image/png', buffer: await picture() });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#toast')).toBeHidden();
});

test('a picture that cannot be read among several is named', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  const buffer = await picture();
  await (
    await chooser
  ).setFiles([
    { name: 'first.png', mimeType: 'image/png', buffer },
    { name: 'broken scan.png', mimeType: 'image/png', buffer: Buffer.from('not a picture') },
    { name: 'third.png', mimeType: 'image/png', buffer },
  ]);
  await expect(page.locator('#toast')).toHaveText(
    'broken scan.png is not a PNG or JPEG picture that can be read. Leave it out and try again.',
  );
  await expect(page.locator('.home')).toBeVisible();
});
