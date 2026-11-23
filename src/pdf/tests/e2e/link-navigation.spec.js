import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { addNote } from '../../src/core/notes.js';

async function openPdf(page, doc, name = 'links.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}
async function prepare(page, missing = false) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([400, 500]);
  doc.catalog.set(
    PDFName.of('Dests'),
    doc.context.obj({
      first: missing ? [99, 'Fit'] : [doc.getPage(1).ref, 'Fit'],
      second: [doc.getPage(2).ref, 'Fit'],
    }),
  );
  for (const [index, dest] of ['first', 'second'].entries())
    doc.getPage(0).node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [40, 300 - index * 80, 160, 320 - index * 80],
          Dest: PDFString.of(dest),
        }),
      ),
    );
  addNote(doc, 2, { x: 40, y: 320, text: 'Destination note' });
  await page.goto('/#library');
  await openPdf(page, doc);
  await expect(page.getByRole('button', { name: /^Link to (another page|page \d+)$/ })).toHaveCount(
    2,
  );
  return doc.getPage(1).ref.objectNumber;
}
async function linkAction(page, entry, index = 0) {
  const link = page.getByRole('button', { name: /^Link to (another page|page \d+)$/ }).nth(index);
  if (entry === 'menu') {
    await link.click({ button: 'right' });
    return page.getByRole('menuitem', { name: 'Go to linked page', exact: true });
  }
  await link.click();
  const action = page
    .getByRole('dialog', { name: 'Edit link', exact: true })
    .getByRole('button', { name: 'Go to linked page', exact: true });
  // Opening the dialog resolves the same destination before following it does.
  // Finish that first lookup before installing the worker delay for the action.
  await expect(action).toBeVisible();
  return action;
}
async function holdDestination(page, phase, ref, missing = false) {
  await page.evaluate(
    ({ phase, ref, missing }) => {
      const post = Worker.prototype.postMessage;
      new MutationObserver(() => {
        if (document.querySelector('#toast').textContent.includes('This link points nowhere'))
          window.obsoleteLinkToast = true;
      }).observe(document.querySelector('#toast'), {
        childList: true,
        subtree: true,
        characterData: true,
      });
      Worker.prototype.postMessage = function (message, ...rest) {
        const named = message?.action === 'GetDestination' && message.data.id === 'first';
        const indexed = message?.action === 'GetPageIndex' && message.data.num === ref;
        // Wait for the final lookup reply, its promise continuations, and the next
        // rendered frame: live-region toasts deliberately populate on that frame.
        if (indexed || (missing && named))
          this.addEventListener('message', (event) => {
            if (event.data?.callbackId === message.callbackId)
              setTimeout(() => {
                Worker.prototype.postMessage = post;
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    window.linkLookupSettled = true;
                  }),
                );
              }, 0);
          });
        if (!window.releaseLinkLookup && (phase === 'name' ? named : indexed)) {
          window.releaseLinkLookup = () => post.call(this, message, ...rest);
          return;
        }
        return post.call(this, message, ...rest);
      };
    },
    { phase, ref, missing },
  );
}
async function goTo(page, number) {
  const input = page.getByLabel('Page number', { exact: true });
  await input.fill(String(number));
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText(`Page ${number} of 3`);
}
for (const phase of ['name', 'index'])
  for (const entry of ['menu', 'dialog'])
    for (const newer of ['none', 'page', 'current', 'link', 'comment', 'document'])
      test(`${entry} link awaiting its ${phase} respects ${newer === 'none' ? 'the original choice' : `a newer ${newer} choice`}`, async ({
        page,
      }) => {
        const ref = await prepare(page);
        const action = await linkAction(page, entry);
        await holdDestination(page, phase, ref);
        await action.click();
        await expect.poll(() => page.evaluate(() => !!window.releaseLinkLookup)).toBe(true);
        if (newer === 'page' || newer === 'current') await goTo(page, newer === 'current' ? 1 : 3);
        else if (newer === 'link') {
          await (await linkAction(page, entry, 1)).click();
          await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
        } else if (newer === 'comment') {
          const tabs = page.getByRole('tablist', { name: 'Side panel' });
          if (!(await tabs.isVisible()))
            await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
          await tabs.getByRole('tab', { name: /Comments/ }).click();
          const comment = page
            .getByRole('group', { name: 'Comments', exact: true })
            .getByRole('button', { name: 'Note on page 3: Destination note', exact: true });
          await comment.focus();
          await comment.press('Enter');
          await expect(page.getByLabel('Note text', { exact: true })).toHaveValue(
            'Destination note',
          );
        } else if (newer === 'document') {
          const replacement = await PDFDocument.create();
          replacement.addPage([500, 500]);
          await openPdf(page, replacement, 'replacement.pdf');
          // Destroying the old worker settles its pending lookup without a worker reply.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          expect(await page.evaluate(() => !!window.obsoleteLinkToast)).toBe(false);
          await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
          return;
        }
        await page.evaluate(() => window.releaseLinkLookup());
        await expect.poll(() => page.evaluate(() => window.linkLookupSettled)).toBe(true);
        const destination = newer === 'none' ? 2 : newer === 'current' ? 1 : 3;
        await expect(page.locator('.page-caption')).toHaveText(`Page ${destination} of 3`);
        await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(
          String(destination),
        );
        expect(await page.evaluate(() => !!window.obsoleteLinkToast)).toBe(false);
        if (newer === 'comment')
          await expect(page.getByLabel('Note text', { exact: true })).toBeFocused();
        await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      });
for (const entry of ['menu', 'dialog'])
  for (const newer of [false, true])
    test(`${entry} missing destination ${newer ? 'stays silent after newer navigation' : 'reports the current error and permits navigation'}`, async ({
      page,
    }) => {
      const ref = await prepare(page, true);
      const action = await linkAction(page, entry);
      await holdDestination(page, 'name', ref, true);
      await action.click();
      await expect.poll(() => page.evaluate(() => !!window.releaseLinkLookup)).toBe(true);
      if (newer) await goTo(page, 3);
      await page.evaluate(() => window.releaseLinkLookup());
      await expect.poll(() => page.evaluate(() => window.linkLookupSettled)).toBe(true);
      expect(await page.evaluate(() => !!window.obsoleteLinkToast)).toBe(!newer);
      if (!newer)
        await expect(page.locator('#toast')).toHaveText('This link points nowhere in the PDF.');
      await expect(page.locator('.page-caption')).toHaveText(`Page ${newer ? 3 : 1} of 3`);
      await goTo(page, 1);
      await (await linkAction(page, entry, 1)).click();
      await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
    });
