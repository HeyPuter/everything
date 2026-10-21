import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote } from '../../src/core/notes.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// Exporting comments, like downloading the PDF, takes in the note still being written.
for (const [label, format] of [
  ['Export comments (XFDF)', 'XFDF'],
  ['Comment summary', 'summary'],
])
  test(`the comment ${format} includes a note still being edited`, async ({ page }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]);
    addNote(doc, 0, { x: 100, y: 300, text: 'Before' });
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'drafts.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await settled(page);
    await page.getByRole('button', { name: 'Edit note: Before' }).click();
    await page.getByLabel('Note text').fill('After');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page
      .getByRole('complementary', { name: 'Tools' })
      .getByRole('button', { name: label })
      .click();
    const text = await readFile(await (await pending).path(), 'utf8');
    expect(text).toContain('After');
    expect(text).not.toContain('Before');
  });
