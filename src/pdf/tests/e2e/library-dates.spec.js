import { test, expect } from '@playwright/test';

const files = [
  { name: 'Old milliseconds.pdf', size: 4000, modified: Date.UTC(2024, 0, 15, 12) },
  { name: 'Newest seconds.pdf', size: 1000, modified: Date.UTC(2026, 6, 20, 12) / 1000 },
  { name: 'Middle milliseconds.pdf', size: 3000, modified: String(Date.UTC(2025, 2, 18, 12)) },
  { name: 'Older seconds.pdf', size: 2000, modified: String(Date.UTC(2023, 5, 10, 12) / 1000) },
];

test('last-modified order agrees with displayed dates across seconds and milliseconds', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env:'web', auth:{isSignedIn:()=>true,getUser:async()=>({username:'test-user'})}, fs:{readdir:async()=>${JSON.stringify(files)}}, ui:{onLaunchedWithItems:()=>{},onItemsOpened:()=>{}} };`,
    }),
  );
  await page.goto('/#library');
  await expect(page.locator('.file-open')).toHaveText([
    'Newest seconds.pdf',
    'Middle milliseconds.pdf',
    'Old milliseconds.pdf',
    'Older seconds.pdf',
  ]);
  await expect(page.locator('.file-date')).toHaveText([/2026/, /2025/, /2024/, /2023/]);
  await page.getByLabel('Sort PDFs', { exact: true }).selectOption('name');
  await expect(page.locator('.file-open')).toHaveText([
    'Middle milliseconds.pdf',
    'Newest seconds.pdf',
    'Old milliseconds.pdf',
    'Older seconds.pdf',
  ]);
  await page.getByLabel('Sort PDFs', { exact: true }).selectOption('size');
  await expect(page.locator('.file-open')).toHaveText([
    'Old milliseconds.pdf',
    'Middle milliseconds.pdf',
    'Older seconds.pdf',
    'Newest seconds.pdf',
  ]);
  await page.getByRole('searchbox', { name: 'Search PDFs', exact: true }).fill('seconds');
  await page.getByLabel('Sort PDFs', { exact: true }).selectOption('modified');
  await expect(page.locator('.file-open')).toHaveText([
    'Newest seconds.pdf',
    'Middle milliseconds.pdf',
    'Old milliseconds.pdf',
    'Older seconds.pdf',
  ]);
  await page.getByRole('searchbox', { name: 'Search PDFs', exact: true }).fill('Newest');
  await expect(page.locator('.file-open')).toHaveText(['Newest seconds.pdf']);
});

test('a PDF without a modified date says so and is listed after the dated ones', async ({
  page,
}) => {
  const listed = [{ name: 'Undated.pdf', size: 500 }, ...files.slice(0, 2)];
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env:'web', auth:{isSignedIn:()=>true,getUser:async()=>({username:'test-user'})}, fs:{readdir:async()=>${JSON.stringify(listed)}}, ui:{onLaunchedWithItems:()=>{},onItemsOpened:()=>{}} };`,
    }),
  );
  await page.goto('/#library');
  // Last modified puts it last, so its date must not claim it is the newest.
  await expect(page.locator('.file-open')).toHaveText([
    'Newest seconds.pdf',
    'Old milliseconds.pdf',
    'Undated.pdf',
  ]);
  await expect(page.locator('.file-date')).toHaveText([/2026/, /2024/, 'Unknown']);
});
