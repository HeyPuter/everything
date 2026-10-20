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
