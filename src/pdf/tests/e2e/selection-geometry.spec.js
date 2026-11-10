import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listHighlights } from '../../src/core/highlight.js';

async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
}
async function openPdf(page, doc) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'selection.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
}

for (const zoom of [0.25, 1.5, 4])
  for (const endpoints of ['mark contents', 'parent boundaries', 'element start', 'element end']) {
    test(`search-mark selection uses glyph bounds with ${endpoints} at zoom ${zoom}`, async ({
      page,
    }) => {
      await mockPuter(page);
      await page.goto('/#library');
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      doc.addPage([400, 400]).drawText('alpha beta gamma', { x: 40, y: 300, size: 20, font });
      await openPdf(page, doc);
      const zoomControl = page.getByLabel('Zoom', { exact: true });
      await zoomControl.selectOption(zoom === 0.25 ? '0.5' : String(zoom));
      if (zoom === 0.25) {
        for (const level of ['0.33', '0.25']) {
          await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
          await expect(zoomControl).toHaveValue(level);
          await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
        }
      }
      await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
      await page.getByRole('button', { name: 'Highlight', exact: true }).click();
      await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
      await page.getByRole('combobox', { name: 'Find in PDF', exact: true }).fill('beta');
      const hit = page.locator('.search-hit');
      await expect(hit).toHaveText('beta');
      const selected = await hit.evaluate((el, endpoints) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        if (endpoints === 'parent boundaries') range.selectNode(el);
        if (endpoints === 'element start') range.setEnd(el.firstChild, 2);
        if (endpoints === 'element end') range.setStart(el.firstChild, 2);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return getSelection().toString();
      }, endpoints);
      const text =
        endpoints === 'element start' ? 'be' : endpoints === 'element end' ? 'ta' : 'beta';
      expect(selected).toBe(text);
      await page.getByRole('button', { name: 'Highlight selection', exact: true }).click();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      const result = await PDFDocument.load(await readFile(await (await download).path()));
      const [mark] = listHighlights(result, 0);
      expect(mark.text).toBe(text);
      expect(mark.quads).toHaveLength(1);
      const prefix = endpoints === 'element end' ? 'alpha be' : 'alpha ';
      expect(mark.quads[0][0]).toBeCloseTo(40 + font.widthOfTextAtSize(prefix, 20), 0);
      expect(mark.quads[0][2] - mark.quads[0][0]).toBeCloseTo(font.widthOfTextAtSize(text, 20), 0);
    });
  }

for (const size of [8, 30, 80, 160])
  for (const [text, start, end] of [
    ['אבגדה', 0, 2],
    ['אב abc גד', 3, 6],
  ])
    test(`selected glyph bounds preserve bidirectional order for ${text} at ${size}px`, async ({
      page,
    }) => {
      await mockPuter(page);
      await page.goto('/#library');
      const result = await page.evaluate(
        async ({ text, start, end, size }) => {
          const { selectedTextQuads } = await import('/src/text-selection.js');
          const paper = document.createElement('div');
          Object.assign(paper.style, { position: 'relative', width: '400px', height: '200px' });
          const container = document.createElement('div');
          container.className = 'textLayer';
          const span = document.createElement('span');
          span.textContent = text;
          Object.assign(span.style, {
            font: `${size}px sans-serif`,
            direction: 'rtl',
            left: '40px',
            top: '20px',
            transform: 'none',
          });
          container.append(span);
          paper.append(container);
          document.body.replaceChildren(paper);
          const selection = getSelection(),
            range = document.createRange();
          range.setStart(span.firstChild, start);
          range.setEnd(span.firstChild, end);
          selection.removeAllRanges();
          selection.addRange(range);
          const ctx = document.createElement('canvas').getContext('2d');
          ctx.font = getComputedStyle(span).font;
          const expectedLeft = 40 + ctx.measureText(text.slice(end)).width;
          const expectedWidth = ctx.measureText(text.slice(start, end)).width;
          const measured = selectedTextQuads(
            { textDivs: [span] },
            { width: 400, height: 200, convertToPdfPoint: (x, y) => [x, 200 - y] },
            paper,
          );
          return { measured, expectedLeft, expectedWidth };
        },
        { text, start, end, size },
      );
      expect(result.measured.text).toBe(text.slice(start, end));
      expect(result.measured.quads).toHaveLength(1);
      const [quad] = result.measured.quads;
      expect(Math.abs(quad[0] - result.expectedLeft)).toBeLessThan(0.15);
      expect(Math.abs(quad[2] - quad[0] - result.expectedWidth)).toBeLessThan(0.15);
    });
