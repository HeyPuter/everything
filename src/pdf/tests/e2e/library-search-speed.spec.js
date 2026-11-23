import { test, expect } from '@playwright/test';

// With 2,000 PDFs, each keystroke in Search PDFs rebuilt and laid out every row (about 100 ms a
// key). A row is now built once per listing and only the rows on screen are laid out.
const files = Array.from({ length: 2000 }, (_, i) => ({
  name: `Report ${i}.pdf`,
  path: `/test-user/Documents/Report ${i}.pdf`,
  size: 1000 + i,
  modified: Date.UTC(2025, 0, 1) + i * 3600e3,
}));

test('searching a long library reuses its rows and lays out only those on screen', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env:'web', auth:{isSignedIn:()=>true,getUser:async()=>({username:'test-user'})}, fs:{readdir:async()=>${JSON.stringify(files)}}, ui:{onLaunchedWithItems:()=>{},onItemsOpened:()=>{}} };`,
    }),
  );
  await page.goto('/#library');
  const rows = page.locator('.file-row');
  await expect(rows).toHaveCount(2000);
  // Mark one row's element; a rebuilt row would come back without the mark.
  await rows.filter({ hasText: 'Report 1500.pdf' }).evaluate((row) => (row.searchMarked = true));
  const search = page.getByRole('searchbox', { name: 'Search PDFs', exact: true });
  await search.fill('report 15');
  await expect(rows).toHaveCount(111);
  await search.fill('report 150');
  await expect(rows).toHaveCount(11);
  await expect(page.locator('.file-open').first()).toHaveText('Report 1509.pdf');
  const marked = rows.filter({ hasText: 'Report 1500.pdf' });
  expect(await marked.evaluate((row) => row.searchMarked === true)).toBe(true);
  // Clearing the search brings every row back, the last one far below the window.
  await search.fill('');
  await expect(rows).toHaveCount(2000);
  expect(await rows.last().evaluate((row) => getComputedStyle(row).contentVisibility)).toBe('auto');
  // A row far down still opens its options when reached.
  await page.getByRole('button', { name: 'Options for Report 0.pdf' }).click();
  await expect(page.getByRole('dialog', { name: 'Report 0.pdf' })).toBeVisible();
});
