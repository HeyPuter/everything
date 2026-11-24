import { test, expect } from '@playwright/test';

// An empty .docx on the drive (as a desktop's New > Word Document makes one, or a copy that wrote nothing) failed to
// open as "Could not read this DOCX archive: invalid zip data". It opens as a blank document that saves into it, as a
// word processor opens one.
test('an empty .docx opens as a blank document that saves into the same file', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/home');
  await page.waitForFunction(() => !!window.puter?.fs);
  await page.evaluate(() => puter.fs.write('Documents/Empty.docx', new Blob([])));
  await page.evaluate(() => { location.hash = `#/edit/${encodeURIComponent('Documents/Empty.docx')}`; });
  const text = page.getByRole('textbox', { name: 'Document text' });
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await expect(text).toHaveValue('');
  await expect(page.locator('.canvas-message')).not.toContainText('Could not read');
  await text.fill('Written into the empty file');
  await expect.poll(() => page.evaluate(async () => (await puter.fs.read('Documents/Empty.docx')).size)).toBeGreaterThan(0);
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter');
  expect(await page.evaluate(() => window.__docs.current.view.doc.path)).toBe('Documents/Empty.docx');
  await page.reload();
  await expect(text).toHaveValue('Written into the empty file');
  expect(errors).toEqual([]);
});
