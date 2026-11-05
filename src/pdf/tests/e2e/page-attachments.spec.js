import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
test.skip(({ isMobile }) => isMobile, 'desktop side panel');

/** A two-page PDF with a document attachment and a paperclip comment holding a file on page 2. */
async function attachedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('First', { x: 40, y: 200, size: 14, font });
  const second = doc.addPage([300, 300]);
  second.drawText('Second', { x: 40, y: 200, size: 14, font });
  await doc.attach(new TextEncoder().encode('whole document'), 'summary.txt', {
    mimeType: 'text/plain',
  });
  const context = doc.context;
  const file = context.register(
    context.flateStream(new TextEncoder().encode('figures for page two'), {
      Type: 'EmbeddedFile',
      Params: { Size: 20 },
    }),
  );
  const spec = context.register(
    context.obj({
      Type: 'Filespec',
      F: PDFHexString.fromText('figures.csv'),
      UF: PDFHexString.fromText('figures.csv'),
      EF: { F: file },
    }),
  );
  const clip = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      Rect: [250, 250, 270, 274],
      FS: spec,
      Name: 'PushPin',
      Contents: PDFHexString.fromText('Figures'),
    }),
  );
  second.node.set(PDFName.of('Annots'), context.obj([clip]));
  return doc;
}

// A file attached with a paperclip comment on a page was missing from the Attachments panel,
// which lists only the document's own attachments, so it could not be saved.
test('files attached on a page are listed in the Attachments panel with their page', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await attachedPdf();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'attached.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel' }).click();
  await page.getByRole('tab', { name: 'Attachments', exact: true }).click();
  const list = page.getByRole('list', { name: 'Attached files' });
  const rows = list.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('summary.txt');
  await expect(rows.nth(1)).toContainText('figures.csv');
  await expect(rows.nth(1)).toContainText('Page 2');
  const download = page.waitForEvent('download');
  await list.getByRole('button', { name: 'Save figures.csv', exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('figures.csv');
  expect(await readFile(await saved.path(), 'utf8')).toBe('figures for page two');
  // Removing it takes its paperclip off the page, after asking; the document's file stays.
  await list.getByRole('button', { name: 'Remove figures.csv', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove attachment?' });
  await expect(confirm).toContainText('page 2');
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('figures.csv removed.');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('summary.txt');
});
