import { test, expect } from '@playwright/test';

const LONG = 'Quarterly planning notes for the regional operations review 2026 final version';

test('a document name cut short in a narrow list shows in full under the pointer', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto('/mock.html#/home');
  await page.evaluate(async (names) => {
    for (const name of names) await window.puter.fs.write(`Documents/${name}.docx`, new Blob(['x']));
  }, [LONG, 'Memo']);
  await page.reload();
  const row = name => page.getByRole('listitem').filter({ hasText: name }).locator('.file-main');
  await expect(row(LONG)).toBeVisible();
  expect(await row(LONG).locator('.file-name').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await row(LONG).hover();
  await expect(row(LONG)).toHaveAttribute('title', LONG);
  // A name that fits needs no tooltip repeating it.
  await row('Memo').hover();
  await expect(row('Memo')).not.toHaveAttribute('title', /./);
  // Wide enough for the whole name, the tooltip goes.
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.mouse.move(0, 0);
  await row(LONG).hover();
  await expect(row(LONG)).not.toHaveAttribute('title', /./);
});
