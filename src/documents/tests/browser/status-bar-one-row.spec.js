import { test, expect } from '@playwright/test';

// Editing a header adds "Editing Header · page N" to the status bar. On a desktop the bar wrapped to a second row
// for it, and the pages above moved up and down as the caret went in and out of the header.
test('editing a header keeps the status bar on one row, its words shortened rather than hidden', async ({ page }) => {
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('about:blank');
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Document text' }).fill(Array.from({ length: 1500 }, (_, i) => `word${i}`).join(' '));
    const bar = page.locator('footer.ed-statusbar');
    await expect(bar).toContainText('1500 words');
    const before = await bar.evaluate(el => el.getBoundingClientRect().height);
    await page.getByRole('tab', { name: 'Insert' }).click();
    await page.getByRole('button', { name: 'Header', exact: true }).first().click();
    await page.getByRole('menuitem', { name: /Edit Header/ }).click();
    const area = page.getByRole('combobox', { name: 'Editing area' });
    await expect(area).toBeVisible();
    expect(await bar.evaluate(el => el.getBoundingClientRect().height), `${width}px`).toBe(before);
    // The editing area shows whole; what gave way keeps its words for screen readers.
    expect(await area.evaluate(select => {
      const left = select.closest('.ed-status-left').getBoundingClientRect(), box = select.getBoundingClientRect();
      return box.right <= left.right + 0.5 && box.width >= 90;
    }), `${width}px`).toBe(true);
    await expect(bar.getByRole('button', { name: '1500 words' })).toHaveCount(1);
    await expect(bar.getByRole('button', { name: 'English (United States)' })).toHaveCount(1);
  }
});
