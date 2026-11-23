import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { protectPdf } from '../../src/core/security.js';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('the accessibility report offers no fixes a PDF that does not allow editing refuses', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 500]).drawText('Locked report', { x: 40, y: 440, size: 18, font });
  const bytes = await protectPdf(await doc.save(), {
    open: '',
    permissions: 'owner',
    allow: { edit: false },
  });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({ name: 'locked.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Prepare for accessibility', exact: true }).click();
  // The tools pane's own fixes are unavailable here.
  await expect(pane.getByRole('button', { name: 'Autotag document', exact: true })).toBeDisabled();
  await pane.getByRole('button', { name: 'Accessibility check', exact: true }).click();
  const report = page.getByRole('tabpanel', { name: 'Accessibility check' });
  await expect(report.locator('.a11y-rule.is-failed').first()).toBeVisible();
  // Its rules fail, but no Fix button leads to an edit the PDF refuses.
  await expect(report.locator('.a11y-fix')).toHaveCount(0);
});
