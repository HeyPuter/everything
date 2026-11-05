import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  crc32,
  parseSplitPoints,
  splitPdf,
  splitRanges,
  zipParts,
  zipStore,
} from '../src/core/split.js';

/** Read a stored ZIP back: names, sizes, CRCs, and the bytes, from the central directory. */
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const entries = view.getUint16(end + 8, true);
  let at = view.getUint32(end + 16, true);
  const files = [];
  for (let i = 0; i < entries; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true),
      size = view.getUint32(at + 20, true),
      nameLength = view.getUint16(at + 28, true),
      offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const localName = view.getUint16(offset + 26, true);
    const data = bytes.subarray(offset + 30 + localName, offset + 30 + localName + size);
    files.push({ name, size, crc, data });
    at += 46 + nameLength;
  }
  return files;
}

describe('splitting a PDF', () => {
  it('plans parts by page, by group size, or at chosen pages', () => {
    expect(splitRanges(3)).toEqual([[0], [1], [2]]);
    expect(splitRanges(5, { mode: 'every', every: 2 })).toEqual([[0, 1], [2, 3], [4]]);
    expect(splitRanges(5, { mode: 'at', at: [3, 5, 5, 99, 1] })).toEqual([[0, 1], [2, 3], [4]]);
    expect(() => splitRanges(5, { mode: 'every', every: 5 })).toThrow('fewer than 5');
    expect(() => splitRanges(5, { mode: 'every', every: 0 })).toThrow('how many');
    expect(() => splitRanges(5, { mode: 'at', at: [1] })).toThrow('between 2 and 5');
    expect(() => splitRanges(0)).toThrow('nothing to split');
    expect(() => splitRanges(4, { mode: 'halves' })).toThrow('how to split');
    expect(parseSplitPoints('3, 7 9;2', 9)).toEqual([3, 7, 9, 2]);
    expect(() => parseSplitPoints('3-5', 9)).toThrow('like 3, 7');
    expect(() => parseSplitPoints('', 9)).toThrow('like 3, 7');
  });
  it('writes a stored ZIP that a reader can walk, with the standard CRC', () => {
    expect(crc32(new TextEncoder().encode('hello')).toString(16)).toBe('3610a686');
    expect(crc32(new Uint8Array())).toBe(0);
    const files = [
      { name: 'a.txt', bytes: new TextEncoder().encode('hello') },
      { name: 'ünïcode pages 1-2.pdf', bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]) },
    ];
    const zip = zipStore(files, new Date(2026, 8, 14, 12, 30, 10));
    const read = unzip(zip);
    expect(read.map((f) => f.name)).toEqual(['a.txt', 'ünïcode pages 1-2.pdf']);
    expect(read[0].crc.toString(16)).toBe('3610a686');
    expect(Array.from(read[1].data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(read[1].crc).toBe(crc32(files[1].bytes));
    expect(zip.length).toBe(
      files.reduce(
        (n, f) => n + 30 + 46 + 2 * new TextEncoder().encode(f.name).length + f.bytes.length,
        22,
      ),
    );
  });
  it('parses the source once however many parts it becomes', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 12; i++) doc.addPage([200, 200]);
    doc.getForm().createTextField('Name').addToPage(doc.getPage(0), { x: 20, y: 100 });
    doc.setTitle('Twelve');
    const bytes = await doc.save();
    const load = vi.spyOn(PDFDocument, 'load');
    try {
      const parts = await splitPdf(bytes, splitRanges(12), 'Twelve');
      expect(parts).toHaveLength(12);
      expect(load).toHaveBeenCalledTimes(1);
      const first = await PDFDocument.load(parts[0].bytes),
        last = await PDFDocument.load(parts[11].bytes);
      expect([first.getPageCount(), last.getPageCount()]).toEqual([1, 1]);
      expect(first.getTitle()).toBe('Twelve');
      expect(last.getTitle()).toBe('Twelve');
      // The form was flattened into the first page before the parts were copied.
      expect(first.getForm().getFields()).toEqual([]);
      expect(first.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'))).toBeDefined();
    } finally {
      load.mockRestore();
    }
  });
  it('extracts each part as a PDF named after its pages', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 5; i++) doc.addPage([100 + i, 100]);
    const bytes = await doc.save();
    const parts = await splitPdf(bytes, splitRanges(5, { mode: 'every', every: 2 }), 'Report');
    expect(parts.map((p) => p.name)).toEqual([
      'Report pages 1-2.pdf',
      'Report pages 3-4.pdf',
      'Report page 5.pdf',
    ]);
    const widths = await Promise.all(
      parts.map(async (p) =>
        (await PDFDocument.load(p.bytes)).getPages().map((page) => page.getWidth()),
      ),
    );
    expect(widths).toEqual([[100, 101], [102, 103], [104]]);
    const zipped = unzip(zipStore(parts));
    expect(zipped).toHaveLength(3);
    expect((await PDFDocument.load(zipped[2].data)).getPageCount()).toBe(1);
    await expect(
      splitPdf(
        bytes,
        Array.from({ length: 501 }, () => [0]),
      ),
    ).rejects.toThrow('500');
  });
});

it('stops a cancelled split after its current part instead of copying the remaining pages', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([300, 400]);
  const bytes = await doc.save();
  const controller = new AbortController();
  const original = PDFDocument.prototype.save;
  const save = vi.spyOn(PDFDocument.prototype, 'save').mockImplementation(async function (...args) {
    const part = await original.apply(this, args);
    controller.abort();
    return part;
  });
  try {
    await expect(
      splitPdf(bytes, splitRanges(3), 'Report', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(save).toHaveBeenCalledTimes(1);
  } finally {
    save.mockRestore();
  }
});

for (const text of ['3, 99', '3, 0', '3, 1', '3, 999999999999999999999999'])
  it(`rejects the entire split-point entry when a page is outside the document: ${text}`, () => {
    expect(() => parseSplitPoints(text, 5)).toThrow('between 2 and 5');
  });

it('stops a split whose parts would repeat shared pictures past the output limit', async () => {
  const doc = await PDFDocument.create();
  // Incompressible pixels that every page draws, as a shared letterhead would be.
  const pixels = Uint8Array.from(
    { length: 300 * 1024 },
    (_, i) => (Math.imul(i, 2654435761) >>> 13) & 255,
  );
  const image = doc.context.register(
    doc.context.stream(pixels, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 320,
      Height: 320,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    }),
  );
  for (let i = 0; i < 6; i++) {
    const page = doc.addPage([200, 200]);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im: image } }));
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream('q 200 0 0 200 0 0 cm /Im Do Q')),
    );
  }
  const bytes = await doc.save();
  expect(bytes.length).toBeLessThan(1024 * 1024);
  await expect(
    splitPdf(bytes, splitRanges(6), 'Letters', { maxBytes: 1024 * 1024 }),
  ).rejects.toThrow('more than 1 GB');
  expect(
    await splitPdf(bytes, splitRanges(6, { mode: 'every', every: 3 }), 'Letters', {
      maxBytes: 1024 * 1024,
    }),
  ).toHaveLength(2);
});

it('hands over the same archive in pieces as in one array', () => {
  const files = [
    { name: 'a.pdf', bytes: Uint8Array.from([1, 2, 3]) },
    { name: 'b.pdf', bytes: Uint8Array.from([4, 5]) },
  ];
  const date = new Date(2026, 8, 14, 12, 30, 10);
  const joined = Buffer.concat(zipParts(files, date));
  expect(joined.equals(Buffer.from(zipStore(files, date)))).toBe(true);
});
