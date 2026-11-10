import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

test('the accessibility report fits a phone’s narrow panel', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Heading', { x: 72, y: 700, size: 24, font });
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Open a PDF/ })
    .first()
    .click();
  await (
    await chooser
  ).setFiles({
    name: 'report.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Prepare for accessibility', exact: true }).click();
  await pane.getByRole('button', { name: 'Accessibility check', exact: true }).click();
  const report = page.locator('.a11y-report');
  await expect(report.locator('.a11y-chip')).toHaveCount(3);
  await expect(report.locator('.a11y-category-counts').first()).toContainText('1 to check');
  const layout = await report.evaluate((node) => {
    const style = getComputedStyle(node);
    const inner = node.getBoundingClientRect().right - parseFloat(style.paddingRight);
    const counts = [...node.querySelectorAll('.a11y-category-counts')];
    const line = Math.min(...counts.map((c) => c.getBoundingClientRect().height));
    return {
      overflow: node.scrollWidth - node.clientWidth,
      chipsPast:
        Math.max(
          ...[...node.querySelectorAll('.a11y-chip')].map((c) => c.getBoundingClientRect().right),
        ) - inner,
      // "3 failed · 1 to check · 2 passed" stood in a column of single words beside its name.
      tallest: Math.max(...counts.map((c) => c.getBoundingClientRect().height)) / line,
    };
  });
  // On a phone, "1 Needs manual check" ran past the panel's edge and scrolled it sideways.
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.chipsPast).toBeLessThanOrEqual(0.5);
  expect(layout.tallest).toBeLessThanOrEqual(2.05);
});
