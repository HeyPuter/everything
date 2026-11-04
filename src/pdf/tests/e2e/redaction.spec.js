import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('Apply redactions counts what it removed in words that agree with the numbers', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([300, 300]);
  sheet.drawText('X', { x: 40, y: 200, size: 16, font });
  sheet.drawRectangle({ x: 100, y: 100, width: 50, height: 50, color: rgb(0.2, 0.4, 0.8) });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'one.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Redact pages…' }).click();
  await page
    .getByRole('dialog', { name: 'Redact pages' })
    .getByRole('button', { name: 'Mark pages' })
    .click();
  await settled(page);
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Apply redactions' });
  await confirm.getByLabel(/Also remove hidden information/).uncheck();
  await confirm.getByRole('button', { name: 'Apply', exact: true }).click();
  await settled(page);
  await expect(page.locator('#toast')).toContainText(
    'Redactions applied: removed 1 character, 1 drawing.',
  );
});

test('Find text and redact lists its matches with the dialogs’ own check boxes', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Call 555-123-4567', { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'call.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Find text and redact…' }).click();
  const finder = page.getByRole('dialog', { name: 'Find text and redact' });
  const pattern = finder.getByLabel('Phone numbers');
  await pattern.check();
  await finder.getByRole('button', { name: 'Search' }).click();
  const match = finder.getByRole('checkbox', { name: 'Page 1: 555-123-4567' });
  await expect(match).toBeChecked();
  // The match boxes were the browser's small blue default beside the red pattern boxes.
  const look = (box) =>
    box.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.accentColor, node.getBoundingClientRect().width];
    });
  expect(await look(match)).toEqual(await look(pattern));
});

test('the redaction tool’s hint names its own command, not Highlight', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Account 12345678', { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'account.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: /Redact text and images/ }).click();
  const hint = page.locator('.tool-hint');
  // It read "Select text, then choose Highlight selection", a button the tool does not show.
  await expect(hint).toHaveText(
    'Select text, then choose Mark selection for redaction. Choose Area to drag over pictures or any part of the page.',
  );
  await page.getByRole('combobox', { name: 'Highlight mode' }).selectOption('area');
  await expect(hint).toHaveText('Drag over an area to mark it for redaction.');
});

test('marks waiting to be applied have names that tell them apart', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([300, 300]);
  sheet.drawText('Call 555-123-4567', { x: 40, y: 200, size: 14, font });
  sheet.drawText('Fax 555-987-6543', { x: 40, y: 150, size: 14, font });
  doc.addPage([300, 300]).drawText('Call 555-222-3333', { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'calls.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  // Each search marks what it finds on a page as one mark.
  for (const query of ['555-123-4567', '555-987-6543', '555-222-3333']) {
    await pane.getByRole('button', { name: 'Find text and redact…' }).click();
    const finder = page.getByRole('dialog', { name: 'Find text and redact' });
    await finder.getByLabel('Find text').fill(query);
    await finder.getByRole('button', { name: 'Search' }).click();
    await expect(finder.getByRole('status')).toHaveText(/^1 match found/);
    await finder.getByRole('button', { name: 'Mark selected' }).click();
    await expect(finder).toBeHidden();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  }
  await expect(pane.getByText('3 marks to apply')).toBeVisible();
  // Both marks on page 1 were "Remove mark on page 1", with nothing to tell them apart.
  await expect(pane.getByRole('button', { name: /^Remove mark/ })).toHaveText([
    'Remove mark 1 on page 1',
    'Remove mark 2 on page 1',
    'Remove mark on page 2',
  ]);
});
