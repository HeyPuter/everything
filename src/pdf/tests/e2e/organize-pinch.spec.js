import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

// A pinch over the page grid (two fingers, or a trackpad, which sends Ctrl + wheel) used to
// magnify the whole application, pushing the toolbar off screen, while the page view zooms
// the pages instead. It now resizes the tiles, as the size slider does.
test('a pinch in Organize pages resizes the tiles instead of the application', async ({
  page,
  isMobile,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 6; i++) doc.addPage([400, 500]);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'grid.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 6');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  const slider = page.getByRole('slider', { name: 'Page tile size' });
  await expect(grid.getByRole('option')).toHaveCount(6);
  const start = Number(await slider.inputValue());
  const width = async () =>
    (await grid.getByRole('option', { name: 'Page 1', exact: true }).boundingBox())?.width ?? 0;
  const before = await width();
  const box = await grid.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const pinch = (scaleFactor) =>
    cdp.send('Input.synthesizePinchGesture', {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      scaleFactor,
      gestureSourceType: isMobile ? 'touch' : 'mouse',
    });
  await pinch(1.6);
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(start);
  await expect.poll(width).toBeGreaterThan(before + 20);
  // The application is drawn at its own size still, its toolbar in view.
  expect(await page.evaluate(() => visualViewport.scale)).toBeCloseTo(1, 2);
  await expect(page.getByRole('toolbar', { name: 'Organize pages' })).toBeInViewport();
  const larger = Number(await slider.inputValue());
  await pinch(0.6);
  await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(larger);
  expect(await page.evaluate(() => visualViewport.scale)).toBeCloseTo(1, 2);
});
