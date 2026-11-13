import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  const fontErrors = [];
  page.on('console', (message) => {
    if (
      /Failed to load font|Out of bounds subrIndex|Unable to detect correct font/.test(
        message.text(),
      )
    )
      fontErrors.push(message.text());
  });
  page.on('pageerror', (error) => fontErrors.push(error.message));
  page.fontErrors = fontErrors;
});
test.afterEach(async ({ page }) => {
  expect(page.fontErrors).toEqual([]);
});

async function openPdf(page, bytes) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'korean-subset.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
}

for (const face of ['Regular', 'Bold']) {
  test(`Korean ${face} subset edits preview, save, and reopen`, async ({ page }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(
      await readFile(new URL(`../fixtures/fonts/NotoSansKR-${face}.ttf`, import.meta.url)),
      { subset: true },
    );
    doc.addPage([500, 300]).drawText('회원가입', { font, x: 30, y: 180, size: 22 });
    await openPdf(page, await doc.save());
    await page.getByRole('button', { name: 'Edit text: 회원가입', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await input.fill('① 회원정보 수정');
    await expect(input).toHaveCSS('font-family', /Puter CJK KR/);
    await clickAway(page);
    await expect(input).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Edit text: ① 회원정보 수정', exact: true }),
    ).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const bytes = await readFile(await (await download).path());
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, bytes);
    await page.getByRole('button', { name: 'Edit text: ① 회원정보 수정', exact: true }).click();
    await input.fill('② 대표자 변경');
    await clickAway(page);
    await expect(
      page.getByRole('button', { name: 'Edit text: ② 대표자 변경', exact: true }),
    ).toBeVisible();
  });
}

test('new Korean text loads the Korean preview font and can be saved', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]);
  await openPdf(page, await doc.save());
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await input.fill('새로운 사용자');
  await expect(input).toHaveCSS('font-family', /Puter CJK KR/);
  await clickAway(page);
  await expect(
    page.getByRole('button', { name: 'Edit text: 새로운 사용자', exact: true }),
  ).toBeVisible();
});

test('new Chinese text previews and saves in the Chinese face', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  const downloads = [];
  page.on('requestfinished', (request) => {
    if (request.url().includes('/fonts/')) downloads.push(new URL(request.url()).pathname);
  });
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]);
  await openPdf(page, await doc.save());
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await input.fill('这是由中文写成的文字');
  await expect(input).toHaveCSS('font-family', /Puter CJK (SC|TC|JP|KR)/);
  // The browser accepts the TrueType font built from the slices.
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some((f) => /Puter CJK/.test(f.family) && f.status === 'loaded'),
      ),
    )
    .toBe(true);
  await clickAway(page);
  await expect(
    page.getByRole('button', { name: 'Edit text: 这是由中文写成的文字', exact: true }),
  ).toBeVisible();
  // Only slices of the CJK data load, never a whole face.
  expect(downloads.some((path) => path.includes('/fonts/cjk/'))).toBe(true);
  expect(downloads.every((path) => !/\.ttf$/.test(path) || /NotoSans-/.test(path))).toBe(true);
});

test('a failed Korean font download preserves the draft and can be retried', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  let failing = true;
  await page.route('**/fonts/cjk/**', (route) =>
    failing ? route.fulfill({ status: 503, body: '' }) : route.continue(),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]);
  await openPdf(page, await doc.save());
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await input.fill('회원정보 수정');
  await clickAway(page);
  await expect(page.locator('.text-edit-error')).toHaveText(
    'Could not load the text font. Please retry.',
  );
  await expect(input).toHaveValue('회원정보 수정');
  failing = false;
  await clickAway(page);
  await expect(
    page.getByRole('button', { name: 'Edit text: 회원정보 수정', exact: true }),
  ).toBeVisible();
});

test('typing Chinese downloads only the weight it is drawn in', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  const slices = [];
  page.on('requestfinished', (request) => {
    const match = /\/fonts\/cjk\/(regular|bold)\//.exec(request.url());
    if (match) slices.push(match[1]);
  });
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]);
  await openPdf(page, await doc.save());
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await input.fill('我们今天去公园散步');
  await clickAway(page);
  await expect(
    page.getByRole('button', { name: 'Edit text: 我们今天去公园散步', exact: true }),
  ).toBeVisible();
  expect(slices).toContain('regular');
  expect(slices).not.toContain('bold');
  // Bold text takes the bold slices.
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await input.fill('公园');
  await clickAway(page);
  await expect(page.getByRole('button', { name: 'Edit text: 公园', exact: true })).toBeVisible();
  expect(slices).toContain('bold');
});
