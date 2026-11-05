import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfSession, rotatePage } from '../src/core/document.js';
import { loadPdfDocument, savePdf } from '../src/core/version.js';

// pdf-lib waits for a timer every few dozen objects. Browsers hold back each nested timer by
// at least 4 ms, so on a long PDF those waits, not the work, made every edit slow.
async function longPdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++)
    doc.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 50, y: 700, size: 14, font });
  return doc.save();
}
function countTimers() {
  const real = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
    return real(fn, ms, ...args);
  });
  return () => spy.mock.calls.length;
}

describe('reading and writing a long PDF', () => {
  afterEach(() => vi.restoreAllMocks());

  it('waits on few timers to read and write 500 pages', async () => {
    const bytes = await longPdf(500);
    const timers = countTimers();
    const doc = await loadPdfDocument(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(500);
    const reading = timers();
    const saved = await savePdf(doc);
    const writing = timers() - reading;
    // About 1,000 objects: pdf-lib's own pace waits about 10 times to read and 40 to write.
    expect(reading).toBeLessThanOrEqual(1);
    expect(writing).toBeLessThanOrEqual(2);
    expect((await PDFDocument.load(saved)).getPageCount()).toBe(500);
  });

  it('commits an edit to a 500-page PDF with few timer waits', async () => {
    const session = new PdfSession(await longPdf(500));
    const timers = countTimers();
    await session.change((doc) => rotatePage(doc, 3));
    expect(timers()).toBeLessThanOrEqual(4);
    const doc = await PDFDocument.load(session.bytes);
    expect(doc.getPage(3).getRotation().angle).toBe(90);
    expect(doc.getPageCount()).toBe(500);
  });
});
