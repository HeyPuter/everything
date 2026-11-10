import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote, listNotes } from '../../src/core/notes.js';
import { addLink, listLinks } from '../../src/core/links.js';
import { addHighlight, listHighlights } from '../../src/core/highlight.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
const actions = {
  note: {
    add: (doc) => addNote(doc, 0, { x: 100, y: 200, text: 'Original' }),
    value: (doc, i) => listNotes(doc, i)[0].text,
    before: 'Original',
    after: 'Changed',
    edit: async (page) => {
      await page.getByRole('button', { name: 'Edit note: Original', exact: true }).click();
      const text = page.getByLabel('Note text', { exact: true });
      await text.fill('Changed');
      await text.press('ControlOrMeta+Enter');
    },
  },
  link: {
    add: (doc) =>
      addLink(doc, 0, {
        rect: { x: 30, y: 100, width: 100, height: 30 },
        url: 'https://example.com/old',
      }),
    value: (doc, i) => listLinks(doc, i)[0].url,
    before: 'https://example.com/old',
    after: 'https://example.com/new',
    edit: async (page) => {
      await page.getByRole('button', { name: 'Link to example.com/old', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit link' });
      await dialog
        .getByRole('textbox', { name: 'Web address to link to' })
        .fill('https://example.com/new');
      await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    },
  },
  highlight: {
    add: (doc) =>
      addHighlight(doc, 0, { quads: [[30, 130, 130, 130, 30, 100, 130, 100]], text: 'Original' }),
    value: (doc, i) => listHighlights(doc, i)[0].hex,
    before: '#f2c438',
    after: '#1144cc',
    edit: async (page) => {
      await page.getByRole('button', { name: 'Edit highlight: Original', exact: true }).click();
      await page.getByLabel('Highlight color', { exact: true }).fill('#1144cc');
    },
  },
};
for (const [kind, action] of Object.entries(actions))
  for (const index of [0, 1])
    test(`editing shared ${kind} on page ${index + 1} stays local through export and history`, async ({
      page,
    }) => {
      await page.route('https://js.puter.com/**', (route) => route.abort());
      const doc = await PDFDocument.create();
      doc.addPage([300, 300]);
      doc.addPage([300, 300]);
      action.add(doc);
      doc.getPage(1).node.set(PDFName.of('Annots'), doc.getPage(0).node.Annots().clone());
      await page.goto('/#library');
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: /^Open a PDF/ }).click();
      await (
        await chooser
      ).setFiles({
        name: 'shared.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await doc.save()),
      });
      await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
      if (index) {
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
      }
      await settled(page);
      await action.edit(page);
      await settled(page);
      if (kind === 'highlight') {
        await expect(
          page.getByRole('group', { name: 'Edit highlight', exact: true }),
        ).toBeVisible();
        await expect(page.getByLabel('Highlight color', { exact: true })).toHaveValue(action.after);
        await expect(page.getByLabel('Highlight color', { exact: true })).toBeFocused();
      }
      const check = async (edited) => {
        const pending = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download', exact: true }).click();
        const saved = await PDFDocument.load(await readFile(await (await pending).path()));
        expect(action.value(saved, index)).toBe(edited ? action.after : action.before);
        expect(action.value(saved, 1 - index)).toBe(action.before);
      };
      await check(true);
      await page
        .getByRole('button', { name: index ? 'Previous page' : 'Next page', exact: true })
        .click();
      await expect(page.locator('.page-caption')).toHaveText(`Page ${2 - index} of 2`);
      await settled(page);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await settled(page);
      await check(false);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await settled(page);
      await check(true);
    });

for (const target of ['unrelated highlight', 'reply highlight', 'reply note'])
  test(`switching from an unfinished shared note edit to a ${target} keeps the clicked annotation selected`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    actions.note.add(doc);
    if (target === 'reply note') addNote(doc, 0, { x: 150, y: 100, text: 'Reply' });
    else actions.highlight.add(doc);
    const annots = doc.getPage(0).node.Annots();
    if (target.startsWith('reply'))
      doc.context.lookup(annots.get(2)).set(PDFName.of('IRT'), annots.get(0));
    // A plain reply note lives in its note's thread; one grouped with it stays on the page.
    if (target === 'reply note')
      doc.context.lookup(annots.get(2)).set(PDFName.of('RT'), PDFName.of('Group'));
    doc.getPage(1).node.set(PDFName.of('Annots'), annots.clone());
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'shared.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
    await page.getByRole('button', { name: 'Edit note: Original', exact: true }).click();
    await page.getByLabel('Note text', { exact: true }).fill('Changed');
    if (target === 'reply note') {
      await page.getByRole('button', { name: 'Edit note: Reply', exact: true }).click();
      const text = page.getByLabel('Note text', { exact: true });
      await expect(text).toHaveValue('Reply');
      await text.fill('Changed reply');
      await text.press('ControlOrMeta+Enter');
    } else {
      await page.getByRole('button', { name: 'Edit highlight: Original', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Edit highlight', exact: true })).toBeVisible();
      await page.getByLabel('Highlight color', { exact: true }).fill('#1144cc');
    }
    await settled(page);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await pending).path()));
    expect([0, 1].map((i) => actions.note.value(saved, i))).toEqual(['Changed', 'Original']);
    if (target === 'reply note')
      expect([0, 1].map((i) => listNotes(saved, i)[1].text)).toEqual(['Changed reply', 'Reply']);
    else
      expect([0, 1].map((i) => actions.highlight.value(saved, i))).toEqual(['#1144cc', '#f2c438']);
  });
