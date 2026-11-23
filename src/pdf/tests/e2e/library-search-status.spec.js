import { test, expect } from '@playwright/test';

// Searching the library changes the rows without moving the focus, so screen readers heard
// nothing of what the search found. A status message now says how many PDFs match.
const files = ['Report 1.pdf', 'Report 2.pdf', 'Invoice.pdf'].map((name, i) => ({
  name,
  path: `PDF Editor/${name}`,
  size: 1000,
  modified: Date.UTC(2025, 0, 1 + i),
}));

test('the library search says how many PDFs match', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env:'web', auth:{isSignedIn:()=>true,getUser:async()=>({username:'test-user'})}, fs:{readdir:async()=>${JSON.stringify(files)}}, ui:{onLaunchedWithItems:()=>{},onItemsOpened:()=>{}} };`,
    }),
  );
  await page.goto('/#library');
  await expect(page.locator('.file-row')).toHaveCount(3);
  const status = page.locator('.library').getByRole('status');
  await expect(status).toHaveText('');
  const search = page.getByRole('searchbox', { name: 'Search PDFs', exact: true });
  await search.fill('report');
  await expect(status).toHaveText('2 matching PDFs');
  await search.fill('invoice');
  await expect(status).toHaveText('1 matching PDF');
  await search.fill('letter');
  await expect(status).toHaveText('No matching PDFs');
  await search.fill('');
  await expect(status).toHaveText('');
  await expect(page.locator('.file-row')).toHaveCount(3);
});

test('the library search passes over accents, as its name order does', async ({ page }) => {
  const names = ['Résumé.pdf', 'Café menu.pdf', 'がっこう.pdf', 'かっこう.pdf'];
  const listing = names.map((name, i) => ({
    name,
    path: `PDF Editor/${name}`,
    size: 1000,
    modified: Date.UTC(2025, 0, 1 + i),
  }));
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env:'web', auth:{isSignedIn:()=>true,getUser:async()=>({username:'test-user'})}, fs:{readdir:async()=>${JSON.stringify(listing)}}, ui:{onLaunchedWithItems:()=>{},onItemsOpened:()=>{}} };`,
    }),
  );
  await page.goto('/#library');
  await expect(page.locator('.file-row')).toHaveCount(4);
  const search = page.getByRole('searchbox', { name: 'Search PDFs', exact: true });
  await search.fill('resume');
  await expect(page.locator('.file-open')).toHaveText(['Résumé.pdf']);
  await search.fill('CAFÉ');
  await expect(page.locator('.file-open')).toHaveText(['Café menu.pdf']);
  // Japanese voicing marks still tell two words apart.
  await search.fill('がっこう');
  await expect(page.locator('.file-open')).toHaveText(['がっこう.pdf']);
});
