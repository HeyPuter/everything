import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// The bar above the page holds the tool's hint beside its options. With the tools pane and the
// side panel open on a desktop window the hint must stay readable, and the options must not
// push it out of sight or run off the bar.
async function open(page, width) {
  await page.setViewportSize({ width, height: 800 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'one.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
const bar = (page) =>
  page.locator('.contextbar').evaluate((node) => {
    const hint = node.querySelector('.tool-hint');
    return {
      hint: hint.textContent,
      shown: hint.clientWidth,
      cut: hint.scrollHeight > hint.clientHeight + 1 || hint.scrollWidth > hint.clientWidth + 1,
      overflow: node.scrollWidth - node.clientWidth,
      height: node.offsetHeight,
    };
  });

test.beforeEach(({ isMobile }) => test.skip(isMobile, 'desktop widths'));

test('every tool hint is readable in full at 1280 pixels', async ({ page }) => {
  await open(page, 1280);
  const tools = page.getByRole('toolbar', { name: 'PDF tools' });
  for (const name of ['Select', 'Text', 'Highlight', 'Draw', 'Shape', 'Note']) {
    await tools.getByRole('button', { name, exact: true }).click();
    const state = await bar(page);
    expect(state.cut, `${name}: ${state.hint}`).toBe(false);
    expect(state.overflow).toBeLessThanOrEqual(0);
    // The page below never moves as the bar's contents change.
    expect(state.height).toBe(42);
  }
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more', exact: true }).click();
  await pane.getByRole('button', { name: 'Measure', exact: true }).click();
  await pane.getByRole('button', { name: 'Perimeter', exact: true }).click();
  const scale = page.getByLabel('Scale: one page unit stands for', { exact: true });
  await expect(scale).toBeVisible();
  expect((await scale.boundingBox()).width).toBeLessThanOrEqual(90);
  const state = await bar(page);
  expect(state.cut, state.hint).toBe(false);
  expect(state.height).toBe(42);
});

test('a narrower window keeps the highlight hint in view beside its options', async ({ page }) => {
  await open(page, 1100);
  await page
    .getByRole('toolbar', { name: 'PDF tools' })
    .getByRole('button', { name: 'Highlight', exact: true })
    .click();
  const state = await bar(page);
  expect(state.shown).toBeGreaterThan(150);
  expect(state.overflow).toBeLessThanOrEqual(0);
  // The option buttons keep their names for assistive technology.
  await expect(
    page.getByRole('button', { name: 'Place at page center', exact: true }),
  ).toBeVisible();
});
