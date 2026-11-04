import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// File > Export > Web Page keeps each paragraph's tabs and runs of spaces (p { white-space: pre-wrap } in the page's
// style sheet), and a browser shows them. Opening that page again read the style sheet for emphasis and alignment
// only: the tabs became spaces and leading or repeated spaces went ("Name<tab>Value" came back as "Name Value").
const input = page => page.getByRole('textbox', { name: 'Document text' });
async function importHtml(page, name, html) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name, mimeType: 'text/html', buffer: Buffer.from(html) });
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue(name.replace(/\.\w+$/, ''));
}

test('an exported web page opens again with its tabs and spaces', async ({ page }) => {
  await page.goto('/playground.html');
  await page.locator('.canvas-workspace').first().waitFor();
  const html = await page.evaluate(async () => {
    const { TextDocument, paragraph } = await import('/src/engine/model.js');
    const { documentHtml } = await import('/src/lib/document-export.js');
    const doc = new TextDocument([paragraph('\tIndented by a tab'), paragraph('Name\tValue'), paragraph('  two  spaces   three'), paragraph('Item\tone'), paragraph('Heading\twith tab', { styleId: 'Heading1' })]);
    doc.select(doc.text.indexOf('Item')); doc.toggleList('bullet');
    return documentHtml(doc, { title: 'Spaces' });
  });
  expect(html).toContain('<li>Item\tone</li>'); expect(html).toContain('<h1>Heading\twith tab</h1>');
  await importHtml(page, 'spaces.html', html);
  await expect(input(page)).toHaveValue('\tIndented by a tab\nName\tValue\n  two  spaces   three\nItem\tone\nHeading\twith tab');
});

test('another page’s containers still open as the page shows its paragraphs', async ({ page }) => {
  // White-space on a container is not carried onto it: the source's line breaks and indentation between its
  // paragraphs do not become text or empty paragraphs.
  await importHtml(page, 'layout.html', '<html><head><style>div, td { white-space: pre-wrap }</style></head><body><div>\n  <p>First</p>\n  <p>Second</p>\n</div></body></html>');
  await expect(input(page)).toHaveValue('First\nSecond');
});
