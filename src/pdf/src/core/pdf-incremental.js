/**
 * Incremental updates: reading where a PDF's revisions end and appending a new revision
 * (objects, a cross-reference section and a trailer) after the exact bytes of the old one.
 *
 * Everything else in this app rewrites the whole file with pdf-lib. Digital signatures cannot
 * work that way: a signature covers the bytes of the file as they were, so signing, and any
 * change that should leave earlier signatures intact, appends to the file instead.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';
import { unpredict } from './image-redact.js';

const ascii = (text) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};
function latin1(bytes, start = 0, end = bytes.length) {
  let text = '';
  for (let i = start; i < end; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 0x8000)));
  return text;
}
const isWhite = (byte) =>
  byte === 0x20 ||
  byte === 0x0a ||
  byte === 0x0d ||
  byte === 0x09 ||
  byte === 0x0c ||
  byte === 0x00;

/** Byte offsets just past each `%%EOF` marker (and the end-of-line after it). */
export function revisionEnds(bytes) {
  const ends = [];
  for (
    let i = bytes.indexOf(0x25);
    i !== -1 && i + 5 <= bytes.length;
    i = bytes.indexOf(0x25, i + 1)
  ) {
    if (
      bytes[i + 1] !== 0x25 ||
      bytes[i + 2] !== 0x45 ||
      bytes[i + 3] !== 0x4f ||
      bytes[i + 4] !== 0x46
    )
      continue;
    let end = i + 5;
    if (bytes[end] === 0x0d) end++;
    if (bytes[end] === 0x0a) end++;
    ends.push(end);
  }
  return ends;
}

/** Whether only whitespace follows `offset`. */
export function onlyWhitespaceAfter(bytes, offset) {
  for (let i = offset; i < bytes.length; i++) if (!isWhite(bytes[i])) return false;
  return true;
}

/**
 * The last cross-reference section of a file: its offset (the `startxref` value), whether it
 * is a classic table or a stream, and the trailer's /Size. Throws when the file's final
 * `startxref` does not point at a cross-reference section.
 */
export function lastCrossReference(bytes) {
  const tailStart = Math.max(0, bytes.length - 4096);
  let tail = latin1(bytes, tailStart);
  let at = tail.lastIndexOf('startxref');
  let base = tailStart;
  if (at === -1) {
    tail = latin1(bytes);
    at = tail.lastIndexOf('startxref');
    base = 0;
  }
  if (at === -1) throw new Error('This PDF has no cross-reference section.');
  const match = /^startxref\s+(\d+)/.exec(tail.slice(at));
  if (!match) throw new Error('This PDF has a damaged cross-reference section.');
  const offset = +match[1];
  if (offset >= bytes.length) throw new Error('This PDF has a damaged cross-reference section.');
  let pos = offset;
  while (pos < bytes.length && isWhite(bytes[pos])) pos++;
  const head = latin1(bytes, pos, Math.min(bytes.length, pos + 64));
  if (head.startsWith('xref')) {
    // Classic table: the trailer dictionary follows the subsections.
    const limit = Math.min(bytes.length, base + at + 1);
    const text = latin1(bytes, pos, limit);
    const trailerAt = text.indexOf('trailer');
    if (trailerAt === -1) throw new Error('This PDF has a damaged cross-reference section.');
    const size = /\/Size\s+(\d+)/.exec(text.slice(trailerAt));
    return { offset, kind: 'table', size: size ? +size[1] : 0 };
  }
  if (/^\d+\s+\d+\s+obj/.test(head)) {
    const window = latin1(bytes, pos, Math.min(bytes.length, pos + 4096));
    const dictEnd = window.indexOf('stream');
    const dict = window.slice(0, dictEnd === -1 ? window.length : dictEnd);
    if (!/\/Type\s*\/XRef/.test(dict))
      throw new Error('This PDF has a damaged cross-reference section.');
    const size = /\/Size\s+(\d+)/.exec(dict);
    return { offset, kind: 'stream', size: size ? +size[1] : 0 };
  }
  throw new Error('This PDF has a damaged cross-reference section.');
}

/** The entries of a cross-reference stream, PNG predictors included. */
function streamEntries(stream) {
  const { dict } = stream;
  const numbers = (key) => {
    const value = dict.lookup(PDFName.of(key));
    return value instanceof PDFArray
      ? value.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN))
      : null;
  };
  const size = dict.lookup(PDFName.of('Size'));
  const index = numbers('Index') || [0, size instanceof PDFNumber ? size.asNumber() : 0];
  const widths = numbers('W');
  if (!widths || widths.length < 3 || !widths.every((w) => Number.isInteger(w) && w >= 0))
    throw new Error('Invalid cross-reference stream');
  let parms = dict.lookup(PDFName.of('DecodeParms'));
  if (parms instanceof PDFArray) parms = parms.asArray().find((p) => p instanceof PDFDict);
  const data = unpredict(decodePDFRawStream(stream).decode(), parms);
  const [typeWidth, secondWidth, thirdWidth] = widths;
  const field = (at, width, fallback) => {
    if (!width) return fallback;
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + data[at + i];
    return value;
  };
  const row = typeWidth + secondWidth + thirdWidth;
  const entries = new Map();
  let at = 0;
  for (let i = 0; i + 1 < index.length; i += 2)
    for (let n = 0; n < index[i + 1] && at + row <= data.length; n++, at += row) {
      const type = field(at, typeWidth, 1);
      const second = field(at + typeWidth, secondWidth, 0);
      const third = field(at + typeWidth + secondWidth, thirdWidth, 0);
      const entry =
        type === 0
          ? { free: true }
          : type === 1
            ? { offset: second, generation: third }
            : type === 2
              ? { stream: second, index: third }
              : null;
      if (entry && !entries.has(index[i] + n)) entries.set(index[i] + n, entry);
    }
  return entries;
}

/** One cross-reference section (a table and its trailer, or a stream) at `offset`. */
function readSection(bytes, offset) {
  const parser = PDFParser.forBytesWithOptions(bytes.subarray(offset));
  parser.skipWhitespaceAndComments();
  const table = parser.maybeParseCrossRefSection();
  if (table) {
    const entries = new Map();
    for (const subsection of table.subsections)
      for (const { ref, offset: at, deleted } of subsection)
        if (!entries.has(ref.objectNumber))
          entries.set(
            ref.objectNumber,
            deleted ? { free: true } : { offset: at, generation: ref.generationNumber },
          );
    parser.skipWhitespaceAndComments();
    const at = offset + parser.bytes.offset();
    if (latin1(bytes, at, at + 7) !== 'trailer') throw new Error('Missing trailer');
    const trailer = PDFObjectParser.forBytes(bytes.subarray(at + 7), parser.context).parseObject();
    if (!(trailer instanceof PDFDict)) throw new Error('Invalid trailer');
    return { entries, trailer };
  }
  parser.parseIndirectObjectHeader();
  parser.skipWhitespaceAndComments();
  const stream = parser.parseObject();
  if (
    !(stream instanceof PDFRawStream) ||
    stream.dict.lookup(PDFName.of('Type')) !== PDFName.of('XRef')
  )
    throw new Error('Not a cross-reference section');
  return { entries: streamEntries(stream), trailer: stream.dict };
}

/**
 * Where a viewer finds each object: the cross-reference sections from the final `startxref`
 * back through each one's /XRefStm and /Prev, the first section to list an object deciding.
 * Returns `{ root, entries }`, each entry `{ section, free }`, `{ section, offset, generation }`
 * or `{ section, stream, index }` (`section` is where the section listing it starts), or null
 * when the chain cannot be read: viewers then rebuild it by scanning the file.
 */
export function crossReferenceChain(bytes) {
  const entries = new Map();
  let root;
  try {
    const queue = [lastCrossReference(bytes).offset];
    const seen = new Set();
    while (queue.length) {
      const offset = queue.shift();
      if (seen.has(offset)) continue;
      seen.add(offset);
      const { entries: listed, trailer } = readSection(bytes, offset);
      root ??= trailer.get(PDFName.of('Root'));
      for (const [number, entry] of listed)
        if (!entries.has(number)) entries.set(number, { ...entry, section: offset });
      for (const key of ['XRefStm', 'Prev']) {
        const next = trailer.get(PDFName.of(key));
        if (next instanceof PDFNumber) queue.push(next.asNumber());
      }
    }
  } catch {
    return null;
  }
  return { root, entries };
}

/** The highest object number declared anywhere in the file (`N G obj`). */
export function highestObjectNumber(bytes) {
  let highest = 0;
  const text = latin1(bytes);
  const pattern = /(\d{1,10})\s+\d{1,5}\s+obj\b/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) highest = Math.max(highest, +m[1]);
  return highest;
}

/** Serialize a pdf-lib object (dictionary, array, stream...) to bytes. */
export function objectBytes(object) {
  const out = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(out, 0);
  return out;
}

function idArray(id) {
  return `[${id.map((part) => PDFHexString.of(Array.from(part, (b) => b.toString(16).padStart(2, '0')).join('')).toString()).join(' ')}]`;
}
const refText = (ref) =>
  ref instanceof PDFRef ? `${ref.objectNumber} ${ref.generationNumber} R` : null;

function subsections(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const groups = [];
  for (const n of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.start + last.count === n) last.count++;
    else groups.push({ start: n, count: 1 });
  }
  return groups;
}

/**
 * Append a revision to `original`. `objects` is a list of `{ ref, body }` with `body` the
 * serialized object (without `obj`/`endobj`). `trailer` carries `root`, `info` (PDFRefs) and
 * `id` (two byte arrays). Returns the new bytes and each object's absolute offset.
 */
export function appendRevision(original, objects, { xref, trailer, size }) {
  const parts = [original];
  let length = original.length;
  const push = (chunk) => {
    parts.push(chunk);
    length += chunk.length;
  };
  if (original[original.length - 1] !== 0x0a && original[original.length - 1] !== 0x0d)
    push(ascii('\n'));
  const offsets = new Map();
  const generations = new Map();
  for (const { ref, body } of [...objects].sort(
    (a, b) => a.ref.objectNumber - b.ref.objectNumber,
  )) {
    offsets.set(ref.objectNumber, length);
    generations.set(ref.objectNumber, ref.generationNumber);
    push(ascii(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    push(body);
    push(ascii('\nendobj\n'));
  }
  const trailerEntries = [
    trailer.root ? `/Root ${refText(trailer.root)}` : '',
    trailer.info ? `/Info ${refText(trailer.info)}` : '',
    trailer.id ? `/ID ${idArray(trailer.id)}` : '',
    `/Prev ${xref.offset}`,
  ].filter(Boolean);
  const xrefOffset = length;
  if (xref.kind === 'stream') {
    const selfNumber = size;
    offsets.set(selfNumber, xrefOffset);
    generations.set(selfNumber, 0);
    const newSize = selfNumber + 1;
    const groups = subsections(offsets.keys());
    const maxOffset = xrefOffset;
    let width = 1;
    while (maxOffset >= 2 ** (8 * width)) width++;
    const rowLength = 1 + width + 2;
    const rows = new Uint8Array(offsets.size * rowLength);
    let row = 0;
    for (const { start, count } of groups)
      for (let n = start; n < start + count; n++, row++) {
        const at = row * rowLength;
        rows[at] = 1;
        let value = offsets.get(n);
        for (let i = width; i >= 1; i--) {
          rows[at + i] = value % 256;
          value = Math.floor(value / 256);
        }
        const generation = generations.get(n);
        rows[at + width + 1] = generation >> 8;
        rows[at + width + 2] = generation & 0xff;
      }
    const index = groups.map((g) => `${g.start} ${g.count}`).join(' ');
    push(
      ascii(
        `${selfNumber} 0 obj\n<< /Type /XRef /Size ${newSize} /W [1 ${width} 2] /Index [${index}] ${trailerEntries.join(' ')} /Length ${rows.length} >>\nstream\n`,
      ),
    );
    push(rows);
    push(ascii(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
  } else {
    let table = 'xref\n';
    for (const { start, count } of subsections(offsets.keys())) {
      table += `${start} ${count}\n`;
      for (let n = start; n < start + count; n++)
        table += `${String(offsets.get(n)).padStart(10, '0')} ${String(generations.get(n)).padStart(5, '0')} n\r\n`;
    }
    table += `trailer\n<< /Size ${size} ${trailerEntries.join(' ')} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    push(ascii(table));
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return { bytes: out, offsets };
}

export { ascii, latin1 };
