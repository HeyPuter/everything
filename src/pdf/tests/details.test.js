import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { documentDetails, setDocumentDetails } from '../src/core/details.js';
import { rotateAllPages, PdfSession } from '../src/core/document.js';

describe('document details', () => {
  it('reads what the file says and writes the editable fields with a fresh modification date', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    doc.setTitle('Draft');
    doc.setKeywords(['one', 'two']);
    const bytes = await doc.save();
    const before = documentDetails(await PDFDocument.load(bytes), bytes);
    expect(before).toMatchObject({ title: 'Draft', author: '', keywords: 'one two', pages: 2 });
    expect(before.size).toBe(bytes.length);
    expect(before.producer).toContain('pdf-lib');
    const session = new PdfSession(bytes);
    await session.change((d) =>
      setDocumentDetails(d, { title: ' Final ', author: 'Ada', keywords: 'a, b; c' }),
    );
    const after = await PDFDocument.load(session.bytes);
    expect(documentDetails(after)).toMatchObject({
      title: 'Final',
      author: 'Ada',
      keywords: 'a, b; c',
    });
    expect(after.getModificationDate().getTime()).toBeGreaterThan(Date.now() - 60000);
    // Unchanged values are no edit at all, keywords included.
    expect(setDocumentDetails(after, { title: 'Final', author: 'Ada', keywords: 'a, b; c' })).toBe(
      false,
    );
    expect(() => setDocumentDetails(after, { subject: 'x'.repeat(1001) })).toThrow('1,000');
  });
  it('takes details pasted with line breaks as control characters', async () => {
    // PowerPoint puts soft line breaks on the clipboard as U+000B; with XMP beside the Info
    // dictionary, saving such a title failed: "metadata could not be updated safely".
    const doc = await PDFDocument.create();
    doc.addPage();
    const { setTitle } = await import('../src/core/accessibility.js');
    setTitle(doc, 'Draft');
    const session = new PdfSession(await doc.save());
    await session.change((d) =>
      setDocumentDetails(d, { title: 'Quarterly\u000bresults', subject: 'Page\u000cbreak' }),
    );
    expect(documentDetails(await PDFDocument.load(session.bytes))).toMatchObject({
      title: 'Quarterly\nresults',
      subject: 'Page\nbreak',
    });
  });

  it('rotates every page by the same turn', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage().setRotation({ type: 'degrees', angle: 90 });
    rotateAllPages(doc, -90);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([270, 0]);
  });
});
