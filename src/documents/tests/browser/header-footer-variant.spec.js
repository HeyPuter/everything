import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// With different odd and even pages, a page shows the even footer when its page NUMBER is even
// (§17.10.5), whatever its position in the file. The offset fixture's first page is numbered ii.
const FIXTURE = 'public/fixtures/section-page-numbers-offset.docx';
const engine = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine;
  const shown = e.storyLayout.lines.find(line => line.page === 0 && e.pageStories.stories[line.pageStory]?.kind === 'footer')?.pageStory;
  return { active: e.session.path, shown, body: e.session.body.text };
});

async function open(page) {
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles(FIXTURE);
  await expect(input).toHaveValue(/^Roman start, page 1/);
  await expect(input).toHaveJSProperty('readOnly', false);
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(0); e.focus(); });
}

test('Edit Footer opens the footer the page shows when its number is even', async ({ page }) => {
  await open(page);
  const before = await engine(page);
  expect(before.shown).toBe('word/footer-even.xml');
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Footer', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Footer', exact: true }).click();
  await expect.poll(async () => (await engine(page)).active).toBe('word/footer-even.xml');
});

test('a page number at the bottom of an even-numbered page goes into the footer that page shows', async ({ page }) => {
  await open(page);
  const body = (await engine(page)).body;
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Page Number', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Bottom of Page', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Plain Number 1: Left' }).click();
  await expect.poll(async () => (await engine(page)).active).toBe('word/footer-even.xml');
  expect((await engine(page)).body).toBe(body);
});
