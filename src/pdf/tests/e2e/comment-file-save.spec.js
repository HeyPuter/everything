import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';

/** A page with a paperclip comment holding a file, its name given with the writer's path. */
async function paperclipPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const context = doc.context;
  const file = context.register(
    context.flateStream(new TextEncoder().encode('figures for the page'), {
      Type: 'EmbeddedFile',
      Params: { Size: 20 },
    }),
  );
  const spec = context.register(
    context.obj({
      Type: 'Filespec',
      F: PDFHexString.fromText('C:\\Reports\\figures.csv'),
      EF: { F: file },
    }),
  );
  const clip = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      Rect: [150, 150, 170, 174],
      FS: spec,
      Name: 'PushPin',
      Contents: PDFHexString.fromText('Figures'),
    }),
  );
  page.node.set(PDFName.of('Annots'), context.obj([clip]));
  return doc;
}

// A paperclip comment on the page could be chosen, but its settings had no way to the file it
// holds: only the Attachments panel, which a reader may never think to open, could save it.
test('a paperclip comment’s file is saved from its settings', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'paperclip.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await (await paperclipPdf()).save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Attachment: Figures' }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  const download = page.waitForEvent('download');
  await props.getByRole('button', { name: 'Save figures.csv', exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('figures.csv');
  expect(await readFile(await saved.path(), 'utf8')).toBe('figures for the page');
});
