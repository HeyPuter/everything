import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote, listNotes } from '../../src/core/notes.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc, name = 'test.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}
async function exportedNotes(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  return listNotes(doc, 0).map(({ text, hex, author, x, y }) => ({ text, hex, author, x, y }));
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('the Note tool leaves a sticky note that can be read, edited, recolored, and deleted', async ({
  page,
  isMobile,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  // A touch screen is tapped, and its hint says so.
  await expect(page.locator('.tool-hint')).toContainText(
    `${isMobile ? 'Tap' : 'Click'} where the note should go`,
  );
  const box = await page.locator('.drawing-overlay').boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.25);
  const editor = page.getByRole('group', { name: 'New note' });
  await expect(editor).toBeVisible();
  const text = editor.getByLabel('New note text');
  await expect(text).toBeFocused();
  await text.fill('Check this figure');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await text.press('ControlOrMeta+Enter');
  await settled(page);
  await expect(editor).toHaveCount(0);
  const target = page.getByRole('button', { name: 'Edit note: Check this figure', exact: true });
  await expect(target).toBeVisible();
  expect(await exportedNotes(page)).toEqual([
    { text: 'Check this figure', hex: '#f2c438', author: 'test-user', x: 100, y: 300 },
  ]);
  // In Select the note opens for reading and editing.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await target.click();
  const edit = page.getByRole('group', { name: 'Edit note' });
  await expect(edit.locator('.note-meta')).toContainText('test-user');
  await expect(edit.getByLabel('Note text')).toHaveValue('Check this figure');
  await edit.getByLabel('Note text').fill('Changed my mind');
  await edit.getByLabel('Note color').fill('#1144cc');
  await clickAway(page);
  await settled(page);
  expect(await exportedNotes(page)).toMatchObject([{ text: 'Changed my mind', hex: '#1144cc' }]);
  await page.getByRole('button', { name: 'Edit note: Changed my mind', exact: true }).click();
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await settled(page);
  await expect(page.locator('.note-target')).toHaveCount(0);
  expect(await exportedNotes(page)).toEqual([]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit note: Changed my mind', exact: true }),
  ).toBeVisible();
});

test('empty or unchanged notes close without an edit and Escape cancels a draft', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  const box = await page.locator('.drawing-overlay').boundingBox();
  await page.mouse.click(box.x + 60, box.y + 60);
  const editor = page.getByRole('group', { name: 'New note' });
  await expect(editor).toBeVisible();
  await editor.getByLabel('New note text').fill('Never mind');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.save-status')).toHaveText('Local file');
  // Undo discards a draft the same way instead of adding the note and putting it on Redo.
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await editor.getByLabel('New note text').fill('Not this either');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.note-target')).toHaveCount(0);
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await expect(editor).toBeVisible();
  await clickAway(page);
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('notes from other editors show an icon, open with their author, and stay editable', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([400, 400]);
  pdfPage.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [50, 330, 70, 350],
        Contents: PDFHexString.fromText('From another reader\n'),
        T: PDFHexString.fromText('Reviewer'),
        C: [1, 0, 0],
        F: 28,
        Name: 'Comment',
      }),
    ),
  );
  await openPdf(page, doc);
  const target = page.getByRole('button', { name: 'Edit note: From another reader', exact: true });
  await expect(target).toBeVisible();
  // Without an appearance of its own the note gets an icon from the app.
  await expect(target.locator('svg')).toBeVisible();
  await target.click();
  const edit = page.getByRole('group', { name: 'Edit note' });
  await expect(edit.locator('.note-meta')).toContainText('Reviewer');
  await expect(edit.getByLabel('Note color')).toHaveValue('#ff0000');
  // Opening a note whose text ends in a newline is not an edit.
  await expect(edit.getByLabel('Note text')).toHaveValue('From another reader');
  await expect(page.locator('.save-status')).toHaveText('Local file');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await edit.getByLabel('Note text').fill('Answered');
  await clickAway(page);
  await settled(page);
  expect(await exportedNotes(page)).toEqual([
    { text: 'Answered', hex: '#ff0000', author: 'Reviewer', x: 50, y: 350 },
  ]);
  // The edited note now carries an appearance and no longer needs the stand-in icon.
  await expect(page.locator('.note-target svg')).toHaveCount(0);
});

test('content-locked notes can be read, recolored, and removed without editing their text', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Locked words' });
  const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict.set(PDFName.of('F'), PDFNumber.of(4 | 512));
  dict.set(PDFName.of('Contents'), PDFHexString.fromText(' Locked words\n'));
  const richText = '<body xmlns="http://www.w3.org/1999/xhtml"><p>Locked words</p></body>';
  dict.set(PDFName.of('RC'), PDFString.of(richText));
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Edit note: Locked words', exact: true }).click();
  const panel = page.getByRole('group', { name: 'Edit note', exact: true });
  await expect(panel.getByLabel('Note text')).toHaveAttribute('readonly', '');
  await expect(panel.getByLabel('Note text')).toHaveValue('Locked words');
  await panel.getByLabel('Note color').fill('#1144cc');
  await panel.getByRole('button', { name: 'Close note', exact: true }).click();
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const note = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
  expect(note.lookup(PDFName.of('Contents')).decodeText()).toBe(' Locked words\n');
  expect(note.lookup(PDFName.of('RC')).decodeText()).toBe(richText);
  expect(listNotes(saved, 0)[0].hex).toBe('#1144cc');
  await page.getByRole('button', { name: 'Edit note: Locked words', exact: true }).click();
  await panel.getByRole('button', { name: 'Delete note', exact: true }).click();
  await settled(page);
  await expect(page.locator('.note-target')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit note: Locked words', exact: true }),
  ).toBeVisible();
});

test('a note with locked properties still permits text edits, export, undo and redo', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
  const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict.set(PDFName.of('F'), PDFNumber.of(4 | 128));
  dict.set(PDFName.of('Rect'), doc.context.obj([100, 250, 160, 300]));
  await openPdf(page, doc);
  await page.getByRole('button', { name: /note: Original words$/ }).click();
  const text = page.getByLabel('Note text', { exact: true });
  await expect(text).toBeEditable();
  await expect(page.getByLabel('Note color', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete note', exact: true })).toHaveCount(0);
  await text.fill('Updated words');
  await text.press('ControlOrMeta+Enter');
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(listNotes(saved, 0)[0]).toMatchObject({
    text: 'Updated words',
    x: 100,
    y: 300,
    width: 60,
    height: 50,
    hex: '#f2c438',
  });
  const exported = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
  expect(exported.lookup(PDFName.of('F')).asNumber()).toBe(4 | 128);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit note: Original words', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit note: Updated words', exact: true }),
  ).toBeVisible();
});

for (const flags of [64, 128 | 512]) {
  test(`notes with flags ${flags} remain fully read-only`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    dict.set(PDFName.of('F'), PDFNumber.of(4 | flags));
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Read note: Original words', exact: true }).click();
    const panel = page.getByRole('group', { name: 'Read note', exact: true });
    await expect(panel.getByLabel('Note text')).toHaveAttribute('readonly', '');
    await expect(panel.getByLabel('Note color')).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Delete note', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Close note', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });
}

for (const flags of [0, 512]) {
  for (const [kind, contents] of [
    ['empty', '  \n'],
    ['long', 'x'.repeat(5001)],
  ]) {
    test(`an imported ${kind} note with flags ${flags} can change color without rewriting text`, async ({
      page,
    }) => {
      await mockPuter(page);
      await page.goto('/#library');
      const doc = await PDFDocument.create();
      doc.addPage([400, 400]);
      addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
      const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
      dict.set(PDFName.of('F'), PDFNumber.of(4 | flags));
      dict.set(PDFName.of('Contents'), PDFHexString.fromText(contents));
      await openPdf(page, doc);
      await page.locator('.note-target').click();
      const panel = page.getByRole('group', { name: 'Edit note', exact: true });
      await panel.getByLabel('Note color').fill('#1144cc');
      await panel.getByRole('button', { name: 'Close note', exact: true }).click();
      await expect(panel).toHaveCount(0);
      await settled(page);
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      const saved = await PDFDocument.load(await readFile(await (await pending).path()));
      const exported = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
      expect(exported.lookup(PDFName.of('Contents')).decodeText()).toBe(contents);
      expect(listNotes(saved, 0)[0].hex).toBe('#1144cc');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await settled(page);
      expect((await exportedNotes(page))[0].hex).toBe('#f2c438');
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await settled(page);
      expect((await exportedNotes(page))[0].hex).toBe('#1144cc');
    });
  }
}

test('editing custom note text preserves its icon, size, and popup through export and history', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
  const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict.set(PDFName.of('F'), PDFNumber.of(4));
  dict.set(PDFName.of('Rect'), doc.context.obj([100, 250, 160, 300]));
  const stream = doc.context.flateStream('0 0 1 rg 0 0 m 60 0 l 30 50 l h f', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 60, 50],
  });
  dict.set(PDFName.of('AP'), doc.context.obj({ N: doc.context.register(stream) }));
  dict.lookup(PDFName.of('Popup')).set(PDFName.of('Rect'), doc.context.obj([180, 100, 350, 280]));
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Edit note: Original words', exact: true }).click();
  const text = page.getByLabel('Note text', { exact: true });
  await text.fill('Updated words');
  await text.press('ControlOrMeta+Enter');
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(listNotes(saved, 0)[0]).toMatchObject({
    text: 'Updated words',
    x: 100,
    y: 300,
    width: 60,
    height: 50,
  });
  const exported = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
  expect(
    Array.from(exported.lookup(PDFName.of('AP')).lookup(PDFName.of('N')).getContents()),
  ).toEqual(Array.from(stream.getContents()));
  expect(
    exported
      .lookup(PDFName.of('Popup'))
      .lookup(PDFName.of('Rect'))
      .asArray()
      .map((n) => n.asNumber()),
  ).toEqual([180, 100, 350, 280]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit note: Original words', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit note: Updated words', exact: true }),
  ).toBeVisible();
});

test('recoloring a translucent note preserves its appearance opacity through export and history', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Translucent note', hex: '#ff0000' });
  const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict.set(PDFName.of('CA'), PDFNumber.of(0.5));
  const stream = doc.context.flateStream('/GS gs 1 0 0 rg 0 0 20 20 re f', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 20, 20],
    Resources: { ExtGState: { GS: { Type: 'ExtGState', ca: 0.5, CA: 0.5 } } },
  });
  dict.set(PDFName.of('AP'), doc.context.obj({ N: doc.context.register(stream) }));
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Edit note: Translucent note', exact: true }).click();
  await page.getByLabel('Note color', { exact: true }).fill('#0000ff');
  await page.getByRole('button', { name: 'Close note', exact: true }).click();
  await settled(page);
  const checkExport = async (hex) => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await pending).path()));
    expect(listNotes(saved, 0)[0].hex).toBe(hex);
    const note = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
    expect(note.lookup(PDFName.of('CA')).asNumber()).toBe(0.5);
    const states = note
      .lookup(PDFName.of('AP'))
      .lookup(PDFName.of('N'))
      .dict.lookup(PDFName.of('Resources'))
      ?.lookup(PDFName.of('ExtGState'));
    expect(
      states?.values().some((state) => {
        const resolved = saved.context.lookup(state);
        return (
          resolved.lookup(PDFName.of('ca'))?.asNumber() === 0.5 &&
          resolved.lookup(PDFName.of('CA'))?.asNumber() === 0.5
        );
      }),
    ).toBe(true);
  };
  await checkExport('#0000ff');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await checkExport('#ff0000');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await settled(page);
  await checkExport('#0000ff');
});

test('recoloring an imported note preserves note and popup bounds through export and history', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Imported note' });
  const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict.set(PDFName.of('Rect'), doc.context.obj([100, 250, 160, 300]));
  dict.lookup(PDFName.of('Popup')).set(PDFName.of('Rect'), doc.context.obj([180, 100, 350, 280]));
  await openPdf(page, doc);
  const target = page.getByRole('button', { name: 'Edit note: Imported note', exact: true });
  const bounds = async () => {
    const [note, canvas] = await Promise.all([
      target.boundingBox(),
      page.locator('.drawing-overlay').boundingBox(),
    ]);
    return { x: note.x - canvas.x, y: note.y - canvas.y, width: note.width, height: note.height };
  };
  const before = await bounds();
  await target.click();
  await page.getByLabel('Note color', { exact: true }).fill('#0000ff');
  await page.getByRole('button', { name: 'Close note', exact: true }).click();
  await settled(page);
  const checkExport = async (hex) => {
    expect(await bounds()).toEqual(before);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await pending).path()));
    expect(listNotes(saved, 0)[0]).toMatchObject({ x: 100, y: 300, width: 60, height: 50, hex });
    const note = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
    expect(
      note
        .lookup(PDFName.of('Popup'))
        .lookup(PDFName.of('Rect'))
        .asArray()
        .map((n) => n.asNumber()),
    ).toEqual([180, 100, 350, 280]);
  };
  await checkExport('#0000ff');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await checkExport('#f2c438');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await settled(page);
  await checkExport('#0000ff');
});
