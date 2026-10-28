import { test, expect } from '@playwright/test';

/**
 * Text this editor copies carries its own description of what was copied (a data-documents-fragment attribute), which
 * a paste back here reads instead of the HTML. A web page or Markdown file opened as a document is not such a copy:
 * one that holds the attribute (a copy pasted into a site that keeps data attributes, then saved; or a page made to
 * show one text and open as another) opens as the page reads, not as the description alone.
 */

const input = page => page.getByRole('textbox', { name: 'Document text' });
const EMBEDDED = `<div data-documents-fragment='{"paragraphs":[{"text":"Other text","runs":[{"text":"Other text","format":{}}],"mark":true}]}'><p>Quarterly report</p></div><p>Revenue grew 4%.</p>`;

async function open(page, name, mimeType, source) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name, mimeType, buffer: Buffer.from(source) });
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue(name.replace(/\.\w+$/, ''));
}

test('a web page holding an embedded copy opens as the page reads', async ({ page }) => {
  await open(page, 'page.html', 'text/html', `<!doctype html><html><body>${EMBEDDED}</body></html>`);
  await expect(input(page)).toHaveValue('Quarterly report\nRevenue grew 4%.');
});

test('a Markdown file holding an embedded copy opens as the file reads', async ({ page }) => {
  await open(page, 'notes.md', 'text/markdown', `# Notes\n\n${EMBEDDED}\n\nLast line.\n`);
  await expect(input(page)).toHaveValue('Notes\nQuarterly report\nRevenue grew 4%.\nLast line.');
});

test('Text from File reads a web page holding an embedded copy as the page reads', async ({ page }) => {
  // Wide enough that the Insert tab's Text group shows its buttons with any system font.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await input(page).fill('Start');
  await page.locator('#ribbon-tab-insert').click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Object', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Text from File…' }).click();
  await input(page).press('ControlOrMeta+End');
  await (await chooser).setFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from(`<!doctype html><html><body>${EMBEDDED}</body></html>`) });
  await expect.poll(() => input(page).inputValue()).toMatch(/Quarterly report\nRevenue grew 4%\.$/);
});
