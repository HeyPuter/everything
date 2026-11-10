import { test, expect } from '@playwright/test';

// The exported web page as a browser shows it: runs of spaces and tabs typed to line text up stay as typed.
test('an exported web page keeps the spaces and tabs typed in the text', async ({ page }) => {
  await page.goto('/playground.html');
  await page.locator('.canvas-workspace').first().waitFor();
  const html = await page.evaluate(async () => {
    const { TextDocument, paragraph } = await import('/src/engine/model.js');
    const { documentHtml } = await import('/src/lib/document-export.js');
    const doc = new TextDocument([paragraph()]);
    doc.replace('Name:    Alice\tSmith');
    return documentHtml(doc, { title: 'Spaces' });
  });
  await page.setContent(html);
  const shown = await page.locator('p').first().evaluate(p => p.innerText);
  expect(shown).toBe('Name:    Alice\tSmith');
  // Only the text keeps its whitespace: the page has no blank lines around its blocks.
  expect(await page.evaluate(() => document.body.innerText.trim())).toBe('Name:    Alice\tSmith');
});
