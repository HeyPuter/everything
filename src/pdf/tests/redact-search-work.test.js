import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { findTextRects } from '../src/core/redact.js';

afterEach(() => vi.restoreAllMocks());

describe('finding text to redact', () => {
  it('folds each distinct character once, not every glyph of the page', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    const line = 'Call 555-0100 about the quarterly report';
    for (let l = 0; l < 30; l++) page.drawText(line, { x: 40, y: 750 - l * 22, size: 11, font });
    const loaded = await PDFDocument.load(await doc.save());
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const found = await findTextRects(loaded, 0, 'quarterly');
    expect(found).toHaveLength(30);
    // Folding a character normalizes it three times; the page has 30 × 36 glyphs, but only a
    // few dozen distinct characters.
    expect(normalize.mock.calls.length).toBeLessThan(300);
  });
});
