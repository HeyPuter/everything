/**
 * Split a PDF into several files: one per page, every so many pages, or before chosen pages.
 * The parts are handed over as one ZIP written here (stored, not compressed: PDFs already are),
 * so no archive library is needed.
 */
import { copyPagesFrom, formatPageRange, openSource } from './pages.js';
import { PDFName } from 'pdf-lib';
import { crc32 } from '../lib/crc32.js';
export { crc32 } from '../lib/crc32.js';

export const MAX_SPLIT_FILES = 500;
/**
 * The most a split's parts may hold together. Every part carries its own copy of the fonts and
 * pictures its pages share, so a file far under the open limit can multiply many times over.
 */
export const MAX_SPLIT_BYTES = 1024 * 1024 * 1024;
/** Stored ZIP entries, sizes, and offsets are 32-bit fields. */
const MAX_ZIP_BYTES = 0xffffffff;

/** Zero-based page index groups for a split of `count` pages. */
export function splitRanges(count, { mode = 'each', every = 2, at = [] } = {}) {
  if (!(count >= 1)) throw new Error('There is nothing to split.');
  const all = Array.from({ length: count }, (_, i) => i);
  if (mode === 'each') return all.map((i) => [i]);
  if (mode === 'every') {
    const size = Number(every);
    if (!Number.isInteger(size) || size < 1) throw new Error('Split every how many pages?');
    if (size >= count) throw new Error(`Choose fewer than ${count} pages per part.`);
    const ranges = [];
    for (let i = 0; i < count; i += size) ranges.push(all.slice(i, i + size));
    return ranges;
  }
  if (mode === 'at') {
    // One-based page numbers where a new part begins; the first page always begins one.
    const points = [...new Set(at.map(Number))]
      .filter((n) => Number.isInteger(n) && n > 1 && n <= count)
      .sort((a, b) => a - b);
    if (!points.length)
      throw new Error(`Enter page numbers between 2 and ${count} where new parts begin.`);
    const ranges = [];
    let start = 0;
    for (const point of [...points, count + 1]) {
      ranges.push(all.slice(start, point - 1));
      start = point - 1;
    }
    return ranges;
  }
  throw new Error('Choose how to split the PDF.');
}

/** Parse "3, 7" into valid page numbers where new parts begin in this document. */
export function parseSplitPoints(text, count) {
  const tokens = String(text ?? '')
    .split(/[,;\s]+/)
    .filter(Boolean);
  if (!tokens.length || tokens.some((token) => !/^\d+$/.test(token)))
    throw new Error('Enter the pages where new parts begin, like 3, 7.');
  const points = tokens.map(Number);
  if (points.some((point) => !Number.isInteger(point) || point < 2 || point > count))
    throw new Error(`Enter page numbers between 2 and ${count} where new parts begin.`);
  return points;
}

/** A ZIP archive of `files` ({ name, bytes }) with entries stored uncompressed. */
export function zipStore(files, date = new Date()) {
  const parts = zipParts(files, date);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The pieces of `zipStore`'s archive in order, for a Blob to join without another full copy of
 * every file in memory.
 */
export function zipParts(files, date = new Date()) {
  const encoder = new TextEncoder();
  const dosTime =
    ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dosDate =
    (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const local = [],
    central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.bytes;
    const crc = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0x0800, true); // UTF-8 names
    header.setUint16(8, 0, true); // stored
    header.setUint16(10, dosTime, true);
    header.setUint16(12, dosDate, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true);
    local.push(new Uint8Array(header.buffer), name, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true); // made by
    entry.setUint16(6, 20, true); // needed
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
    if (offset > MAX_ZIP_BYTES) throw new Error('These files are too large to download as a ZIP.');
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize > MAX_ZIP_BYTES)
    throw new Error('These files are too large to download as a ZIP.');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return [...local, ...central, new Uint8Array(end.buffer)];
}

/** The parts of a split as named PDFs: "<base> pages 1-2.pdf", "<base> page 3.pdf", and so on. */
export async function splitPdf(
  bytes,
  ranges,
  base = 'Untitled',
  { signal, maxBytes = MAX_SPLIT_BYTES } = {},
) {
  signal?.throwIfAborted();
  if (ranges.length > MAX_SPLIT_FILES)
    throw new Error(`Split into at most ${MAX_SPLIT_FILES} files.`);
  // The source is parsed and flattened once; each part only copies its pages out of it.
  const source = await openSource(bytes);
  signal?.throwIfAborted();
  const details = source.catalog.has(PDFName.of('Metadata'))
    ? (await import('./details.js')).documentDetails(source)
    : null;
  const files = [];
  let total = 0;
  for (const indices of ranges) {
    signal?.throwIfAborted();
    const bytes = await copyPagesFrom(source, indices, details);
    total += bytes.length;
    if (total > maxBytes)
      throw new Error(
        'These parts would add up to more than 1 GB, because each one repeats the fonts and pictures its pages share. Split into fewer parts.',
      );
    files.push({
      // A part of one page says "page 5", as Extract pages names a single page.
      name: `${base} ${indices.length === 1 ? 'page' : 'pages'} ${formatPageRange(indices).replace(/, /g, ',')}.pdf`,
      bytes,
    });
  }
  signal?.throwIfAborted();
  return files;
}
