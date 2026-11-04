import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

async function prepare(page) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  for (const words of ['apple apple', 'banana', 'cherry'])
    doc.addPage([400, 400]).drawText(words, { x: 40, y: 300, size: 18 });
  doc.catalog.set(PDFName.of('Dests'), doc.context.obj({ target: [doc.getPage(2).ref, 'Fit'] }));
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
    name: 'search-pending-navigation.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  await input.fill('apple');
  await expect(page.locator('.search-count')).toHaveText('1 of 2');
  return input;
}
async function linkAction(page, entry) {
  const link = page.getByRole('button', { name: 'Link to another page', exact: true });
  if (entry === 'menu') {
    await link.click({ button: 'right' });
    return page.getByRole('menuitem', { name: 'Go to linked page', exact: true });
  }
  await link.click();
  const action = page
    .getByRole('dialog', { name: 'Edit link', exact: true })
    .getByRole('button', { name: 'Go to linked page', exact: true });
  // Opening the editor performs its own lookup. Hold only the later navigation.
  await expect(action).toBeVisible();
  return action;
}
async function holdLink(page, phase) {
  await page.evaluate((phase) => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.action === 'GetPageIndex')
        this.addEventListener('message', (event) => {
          if (event.data?.callbackId === message.callbackId)
            setTimeout(() => {
              Worker.prototype.postMessage = post;
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  window.searchLinkSettled = true;
                }),
              );
            }, 0);
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
}
for (const phase of ['name', 'index'])
  for (const entry of ['menu', 'dialog'])
    for (const action of ['none', 'Next match', 'Previous match', 'Enter', 'Shift+Enter'])
      test(`${entry} link awaiting its ${phase} respects ${action === 'none' ? 'its original request' : `a newer same-page ${action}`}`, async ({
        page,
      }) => {
        const input = await prepare(page);
        const follow = await linkAction(page, entry);
        await holdLink(page, phase);
        await follow.click();
        await expect
          .poll(() => page.evaluate(() => typeof window.releaseSearchLink))
          .toBe('function');
        if (action !== 'none') {
          if (action.endsWith('match'))
            await page.getByRole('button', { name: action, exact: true }).click();
          else await input.press(action);
          await expect(page.locator('.search-count')).toHaveText('2 of 2');
          await expect(page.locator('.search-hit-current')).toHaveText('apple');
        }
        await page.evaluate(() => window.releaseSearchLink());
        // Wait for the final worker reply and its navigation continuations before
        // checking that the old destination cannot change the page number or view.
        await expect.poll(() => page.evaluate(() => window.searchLinkSettled)).toBe(true);
        await expect(
          page.getByRole('spinbutton', { name: 'Page number', exact: true }),
        ).toHaveValue(action === 'none' ? '3' : '1');
        await expect(page.locator('.page-caption')).toHaveText(
          action === 'none' ? 'Page 3 of 3' : 'Page 1 of 3',
        );
        await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
        if (action !== 'none') {
          await expect(page.locator('.search-count')).toHaveText('2 of 2');
          await expect(page.locator('.search-hit-current')).toHaveText('apple');
          if (action.includes('Enter')) await expect(input).toBeFocused();
          await input.press('Enter');
          await expect(page.locator('.search-count')).toHaveText('1 of 2');
          // Retiring a lookup must not prevent the user from following the link later.
          await (await linkAction(page, entry)).click();
          await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
        }
      });
