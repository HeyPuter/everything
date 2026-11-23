import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// Opening a PDF whose read takes a while (a large file, a cloud file on a slow connection)
// changed nothing on screen until the PDF appeared, so the choice seemed to do nothing.
test('a slow open says the PDF is on its way, and the notice goes once it is open', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const bytes = Buffer.from(await doc.save()).toString('base64');
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.puter = {
          env: 'web',
          auth: { isSignedIn: () => true, getUser: async () => ({ username: 'test-user' }) },
          fs: {
            readdir: async () => [{ name: 'slow.pdf', path: 'PDF Editor/slow.pdf', size: 1000, modified: 1700000000 }],
            read: () => new Promise((resolve) => {
              window.finishRead = () => resolve(new Blob([Uint8Array.from(atob(${JSON.stringify(bytes)}), (c) => c.charCodeAt(0))]));
            }),
          },
          ui: {},
        };`,
    }),
  );
  await page.goto('/#library');
  await page.getByRole('button', { name: 'slow.pdf', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Opening slow.pdf…');
  await expect(page.locator('#toast')).toHaveAttribute('role', 'status');
  await page.evaluate(() => window.finishRead());
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('#toast')).toBeHidden();
});

test('no notice outlasts a quick open', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  await page.getByRole('button', { name: 'New blank PDF' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#toast')).toBeHidden();
});
