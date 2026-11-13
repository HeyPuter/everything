import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfSession } from '../src/core/document.js';
import { quadOverlapsRect } from '../src/core/content-filter.js';
import { addRedactionMarks, applyRedactions, findTextRects } from '../src/core/redact.js';

vi.mock('../src/core/content-filter.js', async (original) => {
  const module = await original();
  return { ...module, quadOverlapsRect: vi.fn(module.quadOverlapsRect) };
});

describe('applying many marks', () => {
  it('tests each glyph exactly only against the areas near it', async () => {
    // Find text and redact marks every match on a page: a common word gives hundreds of areas.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    for (let line = 0; line < 50; line++)
      page.drawText('the cat and the dog met the fox by the barn', {
        x: 36,
        y: 760 - line * 14,
        size: 10,
        font,
      });
    const bytes = await doc.save();
    const matches = await findTextRects(await PDFDocument.load(bytes), 0, 'the');
    expect(matches).toHaveLength(200);
    const session = new PdfSession(bytes);
    let report;
    quadOverlapsRect.mockClear();
    await session.change(async (edit) => {
      addRedactionMarks(
        edit,
        0,
        matches.flatMap((match) => match.rects),
      );
      report = await applyRedactions(edit);
    });
    expect(report.text).toBe(600);
    // Testing each of the 2,050 glyphs against the areas in turn took some 370,000 exact tests.
    expect(quadOverlapsRect.mock.calls.length).toBeLessThan(2050 * 3);
    const task = pdfjs.getDocument({ data: session.bytes.slice(), verbosity: 0 });
    try {
      const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
        .map((item) => item.str)
        .join(' ');
      expect(text).not.toMatch(/the/);
      expect(text.match(/barn/g)).toHaveLength(50);
    } finally {
      await task.destroy();
    }
  });
});
