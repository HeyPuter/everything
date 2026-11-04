import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote, listNotes } from '../../src/core/notes.js';

async function goTo(page, number) {
  const input = page.getByRole('spinbutton', { name: 'Page number', exact: true });
  await input.fill(String(number));
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText(`Page ${number} of 3`);
}
async function prepare(page, kind, comments) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  for (const words of ['apple', 'banana banana', 'cherry'])
    doc.addPage([400, 400]).drawText(words, { x: 40, y: 300, size: 18 });
  if (kind === 'note') addNote(doc, 0, { x: 40, y: 200, text: 'Original note' });
  addNote(doc, 2, { x: 40, y: 200, text: 'Destination note' });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'search-refresh.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  await input.fill('banana');
  await expect(page.locator('.search-count')).toHaveText('1 of 2');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await goTo(page, 1);
  if (comments) {
    const tabs = page.getByRole('tablist', { name: 'Side panel' });
    if (!(await tabs.isVisible()))
      await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
    await tabs.getByRole('tab', { name: /Comments/ }).click();
  }
  await page.getByRole('button', { name: kind === 'text' ? 'Text' : 'Note', exact: true }).click();
  const target = page.getByRole('button', {
    name: kind === 'text' ? 'Edit text: apple' : 'Edit note: Original note',
    exact: true,
  });
  await target.focus();
  await target.press('Enter');
  await page
    .getByRole('textbox', { name: kind === 'text' ? 'Edit text' : 'Note text', exact: true })
    .fill(kind === 'text' ? 'Updated apple' : 'Updated note');
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      // Page 2 is offscreen: this extraction belongs to the post-save search refresh.
      if (
        message?.action === 'GetTextContent' &&
        message.data.pageIndex === 1 &&
        !window.releaseRefresh
      ) {
        this.addEventListener('message', (event) => {
          if (event.data?.streamId === message.streamId && event.data.stream === 3)
            setTimeout(
              () =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    window.refreshTextSettled = true;
                  }),
                ),
              0,
            );
        });
        window.releaseRefresh = () => post.call(this, message, ...rest);
        return;
      }
      return post.call(this, message, ...rest);
    };
  });
  return input;
}
async function verifySavedEdit(page, kind) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = new Uint8Array(await readFile(await (await download).path()));
  const doc = await PDFDocument.load(bytes);
  expect(listNotes(doc, 2).map((note) => note.text)).toEqual(['Destination note']);
  if (kind === 'note') expect(listNotes(doc, 0).map((note) => note.text)).toEqual(['Updated note']);
  else {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
        .pathname,
    });
    try {
      const content = await (await (await task.promise).getPage(1)).getTextContent();
      expect(content.items.map((item) => item.str || '').join('')).toBe('Updated apple');
    } finally {
      await task.destroy();
    }
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.search-count')).toHaveText('1 of 2');
  await goTo(page, 1);
  await page.getByRole('button', { name: kind === 'text' ? 'Text' : 'Note', exact: true }).click();
  await expect(
    page.getByRole('button', {
      name: kind === 'text' ? 'Edit text: apple' : 'Edit note: Original note',
      exact: true,
    }),
  ).toBeVisible();
}
for (const kind of ['text', 'note'])
  for (const choice of ['current', 'page', 'comment', 'none'])
    for (const resume of choice === 'none' ? [false] : [false, true])
      test(`${kind} edit search refresh respects ${choice} navigation${resume ? ' and a resumed search' : ''}`, async ({
        page,
      }) => {
        const input = await prepare(page, kind, choice === 'comment');
        if (choice === 'comment') {
          const comment = page
            .getByRole('group', { name: 'Comments', exact: true })
            .getByRole('button', { name: /on page 3: Destination note/ });
          await comment.focus();
          await comment.press('Enter');
        } else if (choice === 'none')
          await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
        else await goTo(page, choice === 'current' ? 1 : 3);
        await expect.poll(() => page.evaluate(() => typeof window.releaseRefresh)).toBe('function');
        const destination = ['current', 'none'].includes(choice) ? 1 : 3;
        await expect(page.locator('.page-caption')).toHaveText(`Page ${destination} of 3`);
        await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
        if (choice === 'comment')
          await expect(page.getByLabel('Note text', { exact: true })).toBeFocused();
        if (resume) await input.press(kind === 'text' ? 'Enter' : 'Shift+Enter');
        await page.evaluate(() => window.releaseRefresh());
        await expect.poll(() => page.evaluate(() => window.refreshTextSettled)).toBe(true);
        const searching = resume || choice === 'none';
        await expect(page.locator('.search-count')).toHaveText(
          searching ? `${resume && kind === 'note' ? 2 : 1} of 2` : '2 matches',
        );
        await expect(
          page.getByRole('spinbutton', { name: 'Page number', exact: true }),
        ).toHaveValue(String(searching ? 2 : destination));
        await expect(page.locator('.page-caption')).toHaveText(
          `Page ${searching ? 2 : destination} of 3`,
        );
        if (!searching) {
          await expect(page.locator('.search-hit-current')).toHaveCount(0);
          if (choice === 'comment')
            await expect(page.getByLabel('Note text', { exact: true })).toBeFocused();
          await input.press('Enter');
          await expect(page.locator('.search-count')).toHaveText('1 of 2');
          await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
        }
        await expect(page.locator('.search-hit-current')).toHaveText('banana');
        await verifySavedEdit(page, kind);
      });
