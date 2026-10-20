import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

async function openSearchDocument(page, pages = ['apple apple', 'banana banana', 'apple banana']) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const words of pages)
    doc.addPage([400, 400]).drawText(words, { font, x: 40, y: 300, size: 18, lineHeight: 24 });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'search.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${pages.length}`);
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  return page.getByRole('searchbox', { name: 'Find in PDF', exact: true });
}

test('changing or clearing a query immediately retires its old matches', async ({ page }) => {
  const input = await openSearchDocument(page);
  await input.fill('apple');
  await expect(page.locator('.search-count')).toHaveText('1 of 3');
  await expect(page.locator('.search-hit')).toHaveCount(2);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await input.fill('banana');
  await expect(page.locator('.search-count')).toHaveText('Searching…');
  await expect(page.locator('.search-hit')).toHaveCount(0);
  await input.fill('');
  await expect(page.locator('.search-count')).toHaveText('');
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await page.clock.runFor(300);
  await expect(page.locator('.search-count')).toHaveText('');
});

test('Enter searches the current query immediately instead of advancing old results', async ({
  page,
}) => {
  const input = await openSearchDocument(page);
  await input.fill('apple');
  await expect(page.locator('.search-count')).toHaveText('1 of 3');
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await input.fill('missing');
  await input.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('No matches');
  await expect(page.locator('.search-hit')).toHaveCount(0);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await input.fill('apple');
  await input.press('Shift+Enter');
  await expect(page.locator('.search-count')).toHaveText('2 of 3');
  await expect(page.locator('.search-hit-current')).toHaveText('apple');
  await page.clock.runFor(300);
  await expect(page.locator('.search-count')).toHaveText('2 of 3');
});

test('an unfinished search cannot navigate partial results or publish into a newer query', async ({
  page,
}) => {
  const input = await openSearchDocument(page);
  // Hold extraction of the second page so the first page has matches while the full
  // document is still being searched. This models a slow or complex PDF deterministically.
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    const held = [];
    window.heldSearchPages = 0;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.action === 'GetTextContent' && message.data.pageIndex === 1) {
        held.push(() => post.call(this, message, ...rest));
        window.heldSearchPages++;
      } else post.call(this, message, ...rest);
    };
    window.releaseSearchPages = () => {
      Worker.prototype.postMessage = post;
      held.forEach((release) => release());
    };
  });
  await input.fill('apple');
  await expect.poll(() => page.evaluate(() => window.heldSearchPages)).toBe(1);
  await input.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('Searching…');
  await expect(page.locator('.search-hit')).toHaveCount(0);
  await input.fill('banana');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.heldSearchPages)).toBe(2);
  await page.evaluate(() => window.releaseSearchPages());
  await expect(page.locator('.search-count')).toHaveText('1 of 3');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect(page.locator('.search-hit')).toHaveText(['banana', 'banana']);
  await input.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('2 of 3');
  await input.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('3 of 3');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
});

test('IME confirmation and cancellation belong to the search input composition', async ({
  page,
}) => {
  const input = await openSearchDocument(page);
  await input.fill('apple');
  await expect(page.locator('.search-count')).toHaveText('1 of 3');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(page.locator('.search-count')).toHaveText('1 of 3');
  await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('apple');
  await input.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('2 of 3');
  await input.press('Escape');
  await expect(input).toBeHidden();
});

test('find matches supplementary-plane letters in either case without splitting their highlights', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('A B end', { font, x: 40, y: 700, size: 18 });
  await doc.flush();
  // Map two stand-in glyphs to a Deseret uppercase/lowercase pair, as an embedded font would.
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
    /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
    /CMapName /Test def /CMapType 2 def
    1 begincodespacerange <00> <FF> endcodespacerange
    2 beginbfchar <41> <D801DC00> <42> <D801DC28> endbfchar
    endcmap CMapName currentdict /CMap defineresource pop end end`;
  doc.context
    .lookup(font.ref)
    .set(PDFName.of('ToUnicode'), doc.context.register(doc.context.flateStream(cmap)));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'unicode.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const input = page.getByRole('searchbox', { name: 'Find in PDF', exact: true });
  for (const query of ['\u{10400}', '\u{10428}']) {
    await input.fill(query);
    await expect(page.locator('.search-count')).toHaveText('1 of 2');
    await expect(page.locator('.search-hit')).toHaveText(['\u{10400}', '\u{10428}']);
    await input.press('Enter');
    await expect(page.locator('.search-count')).toHaveText('2 of 2');
    await expect(page.locator('.search-hit-current')).toHaveText('\u{10428}');
  }
  await input.fill('end');
  await expect(page.locator('.search-hit')).toHaveText(['end']);
});

for (const replacement of ['', 'app']) {
  test(`obsolete search stops before extraction when query becomes ${replacement || 'empty'}`, async ({
    page,
  }) => {
    // Comments also fetch page metadata on open, so intercept before the document loads.
    // The last page stays offscreen and does not need text for rendering a thumbnail.
    await page.addInitScript(() => {
      const post = Worker.prototype.postMessage;
      window.lastPageExtractions = 0;
      Worker.prototype.postMessage = function (message, ...rest) {
        if (message?.action === 'GetTextContent' && message.data.pageIndex === 22) {
          this.addEventListener('message', (event) => {
            // PDF.js CLOSE (3) ends this text stream. The next task runs after the
            // search consumes it and starts waiting for the held page.
            if (event.data?.streamId === message.streamId && event.data.stream === 3)
              setTimeout(() => {
                window.searchWaitingForLastPage = true;
              }, 0);
          });
        }
        if (message?.action === 'GetTextContent' && message.data.pageIndex === 23)
          window.lastPageExtractions++;
        if (
          message?.action === 'GetPage' &&
          message.data.pageIndex === 23 &&
          !window.releaseSearchPage
        ) {
          this.addEventListener('message', (event) => {
            if (event.data?.callbackId === message.callbackId)
              setTimeout(() => {
                window.searchPageReleased = true;
              }, 0);
          });
          window.releaseSearchPage = () => post.call(this, message, ...rest);
          return;
        }
        return post.call(this, message, ...rest);
      };
    });
    const input = await openSearchDocument(
      page,
      Array.from({ length: 24 }, (_, index) => (index === 23 ? 'banana' : 'apple')),
    );
    await input.fill('apple');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => typeof window.releaseSearchPage)).toBe('function');
    await expect.poll(() => page.evaluate(() => window.searchWaitingForLastPage)).toBe(true);
    await input.fill(replacement);
    if (replacement) await input.press('Enter');
    await page.evaluate(() => window.releaseSearchPage());
    await expect.poll(() => page.evaluate(() => window.searchPageReleased)).toBe(true);
    await expect(page.locator('.search-count')).toHaveText(replacement ? '1 of 23' : '');
    expect(await page.evaluate(() => window.lastPageExtractions)).toBe(replacement ? 1 : 0);
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 24');
    await expect(page.locator('.search-hit')).toHaveCount(replacement ? 1 : 0);
    if (replacement) await expect(page.locator('.search-hit')).toHaveText('app');
    // Cancellation must still allow a later query to search the formerly held page.
    await input.fill('banana');
    await input.press('Enter');
    await expect(page.locator('.search-count')).toHaveText('1 of 1');
    await expect(page.locator('.page-caption')).toHaveText('Page 24 of 24');
    await expect(page.locator('.search-hit')).toHaveText('banana');
  });
}

test('a word hyphenated at the end of a line is found whole', async ({ page }) => {
  const input = await openSearchDocument(page, ['Here is an exam-\nple of a hyphenated word']);
  await input.fill('example');
  await expect(page.locator('.search-count')).toHaveText('1 of 1');
  // Both halves are marked on the page, and the hyphen between them is not.
  await expect(page.locator('.search-hit-current')).toHaveText(['exam', 'ple']);
});

test('accents are ignored, as PDF readers ignore them', async ({ page }) => {
  const input = await openSearchDocument(page, ['Le Café Crème', 'cafe creme']);
  await input.fill('cafe');
  await expect(page.locator('.search-count')).toHaveText('1 of 2');
  await expect(page.locator('.search-hit-current')).toHaveText('Café');
  await input.fill('crème');
  await expect(page.locator('.search-count')).toHaveText('1 of 2');
  await expect(page.locator('.search-hit-current')).toHaveText('Crème');
});
