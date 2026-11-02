import { test, expect } from '@playwright/test';

/** Viewing mode turns the editing commands off; coming back to Editing must turn every one of them on again. */
test('leaving Viewing mode brings back the ribbon commands it turned off, and its collapsed groups still open', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Draft');
  const ribbon = page.locator('.ribbon-card');
  const moreStyles = ribbon.getByRole('button', { name: 'More Styles', exact: true });
  const formattingPane = ribbon.getByRole('button', { name: 'Formatting Pane', exact: true });
  await expect(moreStyles).toBeEnabled();
  await expect(formattingPane).toBeEnabled();
  const mode = page.getByRole('button', { name: /^Editing mode/ });
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^Viewing/ }).click();
  await expect(ribbon.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
  // Viewing still zooms: in a window narrow enough to fold the View tab's Zoom group into a button, it opens.
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.locator('#ribbon-tab-view').click();
  const zoomGroup = page.locator('#ribbon-panel-view .ribbon-collapsed[aria-label="Zoom"]');
  await expect(zoomGroup).toBeVisible();
  await expect(zoomGroup).toBeEnabled();
  await page.keyboard.press('Escape');
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^Editing/ }).click();
  await expect(zoomGroup).toBeEnabled();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#ribbon-tab-home').click();
  await expect(ribbon.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await expect(moreStyles).toBeEnabled();
  await expect(formattingPane).toBeEnabled();
  const stillOff = await page.evaluate(() => [...document.querySelectorAll('.ribbon-card .ribbon-collapsed:disabled')].map(b => b.getAttribute('aria-label')));
  expect(stillOff).toEqual([]);
  expect(errors).toEqual([]);
});
