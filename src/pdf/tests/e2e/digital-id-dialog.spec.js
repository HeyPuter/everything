import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test('pressing Enter twice creates one digital ID, not two', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({
    name: 'id.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Use a certificate', exact: true }).click();
  await pane.getByRole('button', { name: /Certify/ }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose a digital ID' });
  await chooser.getByLabel('Create a new digital ID').check();
  await chooser.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  const password = chooser.getByLabel('Password for the ID file');
  await password.fill('secret-123');
  const files = [];
  page.on('download', (download) => files.push(download.suggestedFilename()));
  await password.press('Enter');
  await password.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Certify document' })).toBeVisible();
  // Give a second key pair time to be made and offered, as it was.
  await page.waitForTimeout(1500);
  expect(files).toEqual(['Ada Lovelace digital ID.p12']);
});

test('cancelling while a new digital ID is made neither downloads nor uses it', async ({
  page,
}) => {
  // Hold key generation until the test lets it go.
  await page.addInitScript(() => {
    const generate = crypto.subtle.generateKey.bind(crypto.subtle);
    crypto.subtle.generateKey = (...args) =>
      new Promise((resolve) => {
        window.releaseKey = () => resolve(generate(...args));
      });
  });
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({
    name: 'id.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Use a certificate', exact: true }).click();
  await pane.getByRole('button', { name: /Certify/ }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose a digital ID' });
  await chooser.getByLabel('Create a new digital ID').check();
  await chooser.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await chooser.getByLabel('Password for the ID file').fill('secret-123');
  const files = [];
  page.on('download', (download) => files.push(download.suggestedFilename()));
  await chooser.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseKey)).toBe('function');
  await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(chooser).toHaveCount(0);
  await page.evaluate(() => window.releaseKey());
  await page.waitForTimeout(1500);
  expect(files).toEqual([]);
  await expect(page.getByRole('dialog', { name: 'Certify document' })).toHaveCount(0);
});

async function openChooser(page) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({
    name: 'id.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Use a certificate', exact: true }).click();
  await pane.getByRole('button', { name: /Certify/ }).click();
  return page.getByRole('dialog', { name: 'Choose a digital ID' });
}

test('each digital ID choice sits beside its radio button', async ({ page }) => {
  const chooser = await openChooser(page);
  for (const name of ['Use a digital ID file (.pfx or .p12)', 'Create a new digital ID']) {
    const radio = await chooser.getByRole('radio', { name }).boundingBox();
    const label = await chooser.getByText(name, { exact: true }).boundingBox();
    // The words were pushed to the far side of the dialog, away from the button they name.
    expect(label.x - (radio.x + radio.width)).toBeLessThan(24);
  }
});
