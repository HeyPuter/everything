import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// Where the tools pane or the side panel lies over the page, it is a popover: Escape closes it
// and hands the focus back to the control that opened it, as a menu's Escape does.
async function open(page) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  doc.addPage([400, 500]);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'two.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

test.describe('on a narrow screen', () => {
  test.use({ viewport: { width: 700, height: 800 } });

  test('Escape closes the tools pane and returns to the tab that opened it', async ({ page }) => {
    await open(page);
    const pane = page.getByRole('complementary', { name: 'Tools' });
    await expect(pane).toBeHidden();
    const tab = page.getByRole('button', { name: 'Comment', exact: true });
    await tab.click();
    await expect(pane).toBeVisible();
    await pane.getByRole('button', { name: 'Back to all tools' }).focus();
    await page.keyboard.press('Escape');
    await expect(pane).toBeHidden();
    await expect(tab).toBeFocused();
    // Escape from the tab itself closes the pane it opened too.
    await tab.click();
    await expect(pane).toBeVisible();
    await tab.focus();
    await page.keyboard.press('Escape');
    await expect(pane).toBeHidden();
    await expect(tab).toBeFocused();
  });

  test('Escape closes the side panel and returns to its tab in the rail', async ({ page }) => {
    await open(page);
    const tab = page.getByRole('tab', { name: 'Pages', exact: true });
    const panel = page.getByRole('complementary', { name: 'Pages panel' });
    await expect(panel).toBeHidden();
    await tab.click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Close pages panel' }).focus();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(tab).toBeFocused();
    await expect(page.getByRole('button', { name: 'Toggle pages panel' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

test('a docked tools pane stays open on Escape', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the pane overlays the page on a phone');
  await open(page);
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'Close tools panel' }).focus();
  await page.keyboard.press('Escape');
  await expect(pane).toBeVisible();
});
