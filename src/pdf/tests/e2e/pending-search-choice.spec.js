import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

async function prepare(page, phase) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  for (const words of ['apple', 'banana banana', 'cherry', 'banana banana', 'date'])
    doc.addPage([400, 400]).drawText(words, { x: 40, y: 300, size: 18 });
  doc.catalog.set(PDFName.of('Dests'), doc.context.obj({ target: [doc.getPage(4).ref, 'Fit'] }));
  doc.getPage(0).node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 180, 160, 200],
        Dest: PDFString.of('target'),
      }),
    ),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'pending-search.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 5');
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await page.evaluate((phase) => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (
        message?.action === 'GetTextContent' &&
        message.data.pageIndex === 1 &&
        !window.releaseSearchText
      ) {
        this.addEventListener('message', (event) => {
          if (event.data?.streamId === message.streamId && event.data.stream === 3)
            setTimeout(
              () =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    window.heldSearchTextSettled = true;
                  }),
                ),
              0,
            );
        });
        window.releaseSearchText = () => post.call(this, message, ...rest);
        return;
      }
      if (message?.action === 'GetPageIndex')
        this.addEventListener('message', (event) => {
          if (event.data?.callbackId === message.callbackId)
            setTimeout(
              () =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    window.heldSearchLinkSettled = true;
                  }),
                ),
              0,
            );
        });
      if (
        message?.action === (phase === 'name' ? 'GetDestination' : 'GetPageIndex') &&
        !window.releaseSearchLink
      ) {
        window.releaseSearchLink = () => post.call(this, message, ...rest);
        return;
      }
      return post.call(this, message, ...rest);
    };
  }, phase);
  return page.getByRole('combobox', { name: 'Find in PDF', exact: true });
}
async function followLink(page) {
  await page
    .getByRole('button', { name: 'Link to another page', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Go to linked page', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseSearchLink)).toBe('function');
}
for (const phase of ['name', 'index'])
  for (const first of ['link', 'search'])
    for (const action of [
      'typing',
      'Enter',
      'Shift+Enter',
      'Next match',
      'Previous match',
      'none',
      'clear',
    ])
      test(`${action} search choice survives ${phase} lookup with ${first} finishing first`, async ({
        page,
      }) => {
        const input = await prepare(page, phase);
        if (action === 'typing') await followLink(page);
        await input.fill('banana');
        await expect
          .poll(() => page.evaluate(() => typeof window.releaseSearchText))
          .toBe('function');
        if (action !== 'typing') await followLink(page);
        if (action.includes('Enter')) await input.press(action);
        else if (action.endsWith('match'))
          await page.getByRole('button', { name: action, exact: true }).click();
        else if (action === 'clear') await input.fill('');
        const searchWins = !['none', 'clear'].includes(action);
        const backward = ['Shift+Enter', 'Previous match'].includes(action);
        const count =
          action === 'clear' ? '' : !searchWins ? '4 matches' : `${backward ? 4 : 1} of 4`;
        for (const operation of [first, first === 'link' ? 'search' : 'link']) {
          if (operation === 'link') {
            await page.evaluate(() => window.releaseSearchLink());
            await expect.poll(() => page.evaluate(() => window.heldSearchLinkSettled)).toBe(true);
            if (first === 'link') {
              await expect(
                page.getByRole('spinbutton', { name: 'Page number', exact: true }),
              ).toHaveValue(searchWins ? '1' : '5');
            }
          } else {
            await page.evaluate(() => window.releaseSearchText());
            await expect.poll(() => page.evaluate(() => window.heldSearchTextSettled)).toBe(true);
            await expect(page.locator('.search-count')).toHaveText(count);
          }
        }
        await expect(page.locator('.page-caption')).toHaveText(
          `Page ${searchWins ? (backward ? 4 : 2) : 5} of 5`,
        );
        await expect(page.locator('.search-count')).toHaveText(count);
        if (searchWins) await expect(page.locator('.search-hit-current')).toHaveText('banana');
        else await expect(page.locator('.search-hit-current')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
        // Cancellation and lookup retirement must leave later queries fully usable.
        await input.fill('cherry');
        await expect(page.locator('.search-count')).toHaveText('1 of 1');
        await expect(page.locator('.page-caption')).toHaveText('Page 3 of 5');
        await expect(page.locator('.search-hit-current')).toHaveText('cherry');
      });
