import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openFiles } from './helpers';

async function png(page: Page, name: string, w: number, h: number) {
  const bytes = await page.evaluate(
    async ({ w, h }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d')!.fillRect(0, 0, w, h);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!)));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { w, h },
  );
  return { name, mimeType: 'image/png', buffer: Buffer.from(bytes) };
}

/** Nothing on the start screen sticks out of its box or the window. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#empty')!;
    const main = host.querySelector<HTMLElement>('.start-main')!;
    return (
      host.scrollWidth > host.clientWidth + 1 ||
      main.scrollWidth > main.clientWidth + 1 ||
      document.documentElement.scrollWidth > window.innerWidth
    );
  });
}

test('the start screen covers the document area with a rail and home sections', async ({
  page,
}) => {
  await boot(page);
  const home = page.locator('#empty');
  await expect(home).toBeVisible();
  // No stray document tab or rulers show through: the home screen sits over them.
  const covered = await page.evaluate(() => {
    const tabs = document.querySelector('.document-tabs')!.getBoundingClientRect();
    const hit = document.elementFromPoint(tabs.left + 20, tabs.top + tabs.height / 2);
    return !!hit?.closest('#empty');
  });
  expect(covered).toBe(true);
  const rail = page.getByRole('navigation', { name: 'Start' });
  await expect(rail.getByRole('button', { name: 'New document', exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Open an image', exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  for (const region of ['Describe an edit', 'New from a preset', 'Recent documents', 'Learn'])
    await expect(page.getByRole('region', { name: region })).toBeVisible();
  // No recent files yet: an empty state instead of a blank gap.
  await expect(page.locator('.start-recent-empty')).toContainText('No recent files');
  // The styles load with the start screen, not with File → New.
  expect(
    await page.locator('.start-preset-row').evaluate((el) => getComputedStyle(el).display),
  ).toBe('grid');
  expect(await overflow(page)).toBe(false);

  // Learn shows the tutorials with what each covers; Home brings everything back.
  await rail.getByRole('button', { name: 'Learn' }).click();
  await expect(home).toHaveAttribute('data-start', 'learn');
  await expect(page.getByRole('region', { name: 'Describe an edit' })).toBeHidden();
  await expect(page.locator('.start-learn-summary').first()).toBeVisible();
  await rail.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('region', { name: 'Describe an edit' })).toBeVisible();
  await expect(page.locator('.start-learn-summary').first()).toBeHidden();

  // A preset makes a document and the home screen steps aside.
  await page
    .getByRole('region', { name: 'New from a preset' })
    .getByRole('button', { name: /Square social post/ })
    .click();
  await expect(home).toBeHidden();
  await idle(page);
  await expect(page.locator('#tab-size')).toHaveText('1080 × 1080 px');
});

test('recent files show as a grid or a list, and the Recent files view lists them all', async ({
  page,
}) => {
  await boot(page);
  for (let i = 1; i <= 7; i++) await openFiles(page, await png(page, `Photo ${i}.png`, 40 + i, 30));
  // Close every document to come back to the start screen.
  await page.evaluate(async () => {
    while (window.photoStudio.hasDocument) await window.photoStudio.runCommand('file.close');
  });
  await expect(page.locator('#empty')).toBeVisible();
  const recent = page.getByRole('region', { name: 'Recent documents' });
  // Home shows the six most recent and offers the rest.
  await expect(recent.locator('.start-recent-item')).toHaveCount(6);
  await expect(recent.locator('.start-recent-name').first()).toHaveText('Photo 7.png');
  await recent.getByRole('button', { name: 'Show as list' }).click();
  await expect(recent.locator('.start-recent-grid')).toHaveClass(/as-list/);
  await expect(recent.locator('.start-recent-kind').first()).toHaveText('PNG');
  await expect(recent.getByRole('button', { name: 'Show as list' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The layout is remembered.
  expect(await page.evaluate(() => localStorage.getItem('photo-studio-start-recent-layout'))).toBe(
    'list',
  );
  await recent.getByRole('button', { name: 'View all 7' }).click();
  await expect(page.locator('#empty')).toHaveAttribute('data-start', 'files');
  await expect(recent.locator('.start-recent-item')).toHaveCount(7);
  await expect(page.getByRole('region', { name: 'Learn' })).toBeHidden();
  await recent.getByRole('button', { name: 'Show as grid' }).click();
  await expect(recent.locator('.start-recent-grid')).not.toHaveClass(/as-list/);
  // Opening an entry from the list.
  await recent.locator('.start-recent-item').filter({ hasText: 'Photo 3.png' }).click();
  await expect
    .poll(() => page.evaluate(() => window.photoStudio.session.fileName))
    .toBe('Photo 3.png');
  await expect(page.locator('#empty')).toBeHidden();
});

test('the start screen fits a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await boot(page);
  await expect(page.locator('#empty')).toBeVisible();
  expect(await overflow(page)).toBe(false);
  await expect(
    page
      .getByRole('navigation', { name: 'Start' })
      .getByRole('button', { name: 'New document', exact: true }),
  ).toBeVisible();
});
