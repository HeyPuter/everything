import { describe, it, expect } from 'vitest';
import { buildPdfFromJpegs } from '../src/engine/pdf.js';
import { TINY_JPEG } from '../src/engine/jpeg.js';
import { createSession, addPage, removePage, serializeSession } from '../src/engine/session.js';

describe('pdf + session', () => {
  it('builds a PDF with the PDF header and EOF marker', () => {
    const pdf = buildPdfFromJpegs([
      { jpeg: TINY_JPEG, width: 1, height: 1 },
      { jpeg: TINY_JPEG, width: 1, height: 1 },
    ]);
    const text = new TextDecoder().decode(pdf.slice(0, 8));
    expect(text.startsWith('%PDF-1.')).toBe(true);
    const tail = new TextDecoder().decode(pdf.slice(-16));
    expect(tail).toContain('%%EOF');
    expect(pdf.byteLength).toBeGreaterThan(TINY_JPEG.byteLength);
  });

  it('rejects empty exports', () => {
    expect(() => buildPdfFromJpegs([])).toThrow(/no pages/);
  });

  it('tracks pages in a session', () => {
    const session = createSession();
    const rgba = new Uint8ClampedArray(4);
    const a = addPage(session, { width: 1, height: 1, rgba, filter: 'document' });
    addPage(session, { width: 2, height: 2, rgba, filter: 'grayscale' });
    expect(session.pages).toHaveLength(2);
    removePage(session, a.id);
    expect(session.pages).toHaveLength(1);
    const meta = serializeSession(session);
    expect(meta.pages[0].filter).toBe('grayscale');
    expect(meta.pages[0].rgba).toBeUndefined();
  });
});
