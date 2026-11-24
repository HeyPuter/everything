import { deflateSync, unzipSync, zipSync } from 'fflate';

// OPC relationship targets are relative to the owning part, not the package's
// main document. Keep names encoded as stored in the ZIP; do not URL-decode them.
function segments(path) {
  if (typeof path !== 'string' || !path || /[\\?#\u0000]/.test(path)) throw new Error('Invalid package part path.');
  const result = path.split('/');
  if (result.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Invalid package part path.');
  return result;
}

export function relationshipPartPath(sourcePart) {
  const path = segments(sourcePart), file = path.pop();
  return [...path, '_rels', file + '.rels'].join('/');
}

export function relativePartTarget(sourcePart, targetPart) {
  const from = segments(sourcePart), to = segments(targetPart);
  from.pop();
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => '..'), ...to].join('/');
}

/**
 * The ZIP item a resolved relationship target names. Part names are percent-encoded IRIs, and
 * producers store their ZIP items either decoded or exactly as encoded; prefer the decoded item.
 */
export function partPathForUrl(parts, url) {
  const encoded = url.pathname.slice(1), decoded = decodeURIComponent(encoded);
  if (Object.hasOwn(parts, decoded)) return decoded;
  if (Object.hasOwn(parts, encoded)) return encoded;
  return packagePartName(parts, decoded) ?? packagePartName(parts, encoded) ?? decoded;
}

// Each stream's Overrides by lowercased part name, built on the first look-up: a package with thousands of pictures
// looked through every Override for every picture it read, which took seconds to open. The index is rebuilt when the
// stream's entries change in number (an entry added or removed), and a found entry is checked against its part name.
// The writers only give an entry another name when it is created or keeps the same name in other capitals.
const overrideIndexes = new WeakMap();
const lowerName = text => text.replace(/[A-Z]+/g, c => c.toLowerCase());
/** The Override element of a parsed [Content_Types].xml root declaring part `path`, compared without regard to case. */
export function contentTypeOverride(typesRoot, path) {
  const key = lowerName(`/${path}`);
  let index = overrideIndexes.get(typesRoot);
  if (!index || index.count !== typesRoot.childElementCount) {
    index = { count: typesRoot.childElementCount, byName: new Map() };
    for (const n of typesRoot.children) {
      const name = n.localName === 'Override' && n.getAttribute('PartName');
      if (name && !index.byName.has(lowerName(name))) index.byName.set(lowerName(name), n);
    }
    overrideIndexes.set(typesRoot, index);
  }
  const found = index.byName.get(key);
  if (found && found.parentNode === typesRoot && lowerName(found.getAttribute('PartName') || '') === key) return found;
  // Renamed or removed since the index was built: looked for as before.
  if (found) { overrideIndexes.delete(typesRoot); return [...typesRoot.children].find(n => n.localName === 'Override' && lowerName(n.getAttribute('PartName') || '') === key); }
  return undefined;
}

/**
 * The content type of part `path` in a parsed [Content_Types].xml root, lowercased, or ''. An Override
 * names the part; otherwise the Default for its extension applies (ECMA-376 Part 2, §10.1.2.4). Part
 * names and extensions compare without regard to ASCII case, and so do media types (RFC 6838 §4.2).
 */
export function partContentType(typesRoot, path) {
  const override = contentTypeOverride(typesRoot, path);
  if (override) return (override.getAttribute('ContentType') || '').toLowerCase();
  const file = path.slice(path.lastIndexOf('/') + 1), dot = file.lastIndexOf('.');
  if (dot < 0) return '';
  const extension = file.slice(dot + 1).toLowerCase();
  const entry = [...typesRoot.children].find(n => n.localName === 'Default' && n.getAttribute('Extension')?.toLowerCase() === extension);
  return (entry?.getAttribute('ContentType') || '').toLowerCase();
}

/**
 * The ZIP item holding part `name`, or null. Part names compare without regard to ASCII case (ECMA-376
 * Part 2, §9.1.1.1), so a relationship targeting styles.xml names the item word/Styles.xml. The exact
 * name is preferred; a name that two items match in case-insensitive comparison names neither.
 */
export function packagePartName(parts, name) {
  if (Object.hasOwn(parts, name)) return name;
  const lower = text => text.replace(/[A-Z]+/g, c => c.toLowerCase()), key = lower(name);
  const matches = Object.keys(parts).filter(item => lower(item) === key);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Whether the package holds part `name`, or another whose name equals it ignoring ASCII case. A new part's name
 * must be free in this sense: a package may not hold two equivalent part names (ECMA-376 Part 2, §9.1.1.1), so a
 * header added as word/header1.xml beside an existing word/Header1.xml made a file Word refuses, and that opens
 * here read-only.
 */
export function hasPart(parts, name) {
  if (Object.hasOwn(parts, name)) return true;
  const lower = text => text.replace(/[A-Z]+/g, c => c.toLowerCase()), key = lower(name);
  return Object.keys(parts).some(item => lower(item) === key);
}

/**
 * The largest DOCX file the editor opens, and the most its parts may expand to. A session holds up to 50 MB
 * of pictures (validateImageAssets), which are stored as they are; at 20 MB, a document saved with them could
 * not be opened again. These admit that, with the document's own XML, and still refuse archive bombs.
 */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_EXPANDED_PACKAGE_BYTES = 128 * 1024 * 1024;
/**
 * The most items a DOCX archive may hold. Each picture the editor saves is a part of its own, and a document
 * saved with a couple of thousand pictures could not be opened again at 2,000. Well past any document a
 * session builds; the archive's bytes stay bounded by MAX_EXPANDED_PACKAGE_BYTES.
 */
export const MAX_PACKAGE_ITEMS = 20000;

/**
 * The items of a ZIP archive the user chose, refusing (with `message`) one that expands past `maxBytes` or
 * holds more than `maxItems` items. fflate allocates each item at the size the archive declares before
 * inflating it, so a small file declaring gigabytes (a "zip bomb") made the tab allocate and decode them.
 * `onItem(entry)` sees each item first, as unzipSync's filter does.
 */
export function unzipBounded(bytes, { maxBytes = 50 * 1024 * 1024, maxItems = 2000, message = 'The archive expands past the editor limit.', itemsMessage = message, compressionMessage = 'The archive stores its contents with a kind of compression this editor does not read.', onItem } = {}) {
  let total = 0, count = 0;
  return unzipSync(bytes, { filter: entry => {
    total += entry.originalSize;
    if (++count > maxItems) throw new Error(itemsMessage);
    if (total > maxBytes) throw new Error(message);
    // Items are stored or deflated (ECMA-376 Part 2, Annex C); any other method (bzip2, LZMA) was refused as
    // "unknown compression type 12".
    if (entry.compression !== 0 && entry.compression !== 8) throw new Error(compressionMessage);
    onItem?.(entry);
    return true;
  } });
}

// Pictures in these formats are usually compressed already. Deflating them
// again on every save costs seconds of main-thread time in picture-heavy
// documents and saves a few bytes, so a picture whose samples do not deflate is
// stored; everything else is deflated.
const PICTURE_PARTS = /\.(?:jpe?g|jfif|png|gif|webp|wdp)$/i;
const SAMPLE = 1 << 15;
const incompressible = bytes => bytes.length > 4 * SAMPLE
  && [0, (bytes.length - SAMPLE) >> 1, bytes.length - SAMPLE].every(at => deflateSync(bytes.subarray(at, at + SAMPLE), { level: 1 }).length > SAMPLE * 0.9);

/** The package as ZIP bytes. A result past the open limit is deflated throughout, so it stays as small as possible. */
export function zipPackage(parts) {
  const stored = zipSync(Object.fromEntries(Object.entries(parts).map(([name, bytes]) => [name, PICTURE_PARTS.test(name) && incompressible(bytes) ? [bytes, { level: 0 }] : bytes])));
  return stored.length > MAX_PACKAGE_BYTES ? zipSync(parts) : stored;
}

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const utf16 = text => Uint8Array.from([...text].flatMap(c => [c.charCodeAt(0), 0]));
function contains(bytes, needle) {
  outer: for (let i = bytes.indexOf(needle[0]); i !== -1 && i <= bytes.length - needle.length; i = bytes.indexOf(needle[0], i + 1)) {
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
/**
 * Why bytes that are not a ZIP package cannot open as a document, when they say what they are, or null:
 * an empty file, a Rich Text Format document, a web page, or an OLE compound file ([MS-CFB] §2.2). Office keeps a password-protected document in one ([MS-OFFCRYPTO] §2.3.4.4, its
 * EncryptedPackage stream), as it does a Word 97–2003 document ([MS-DOC], its WordDocument stream).
 */
export function compoundFileProblem(bytes) {
  // Nor is a file of no bytes (an upload or copy that never finished), a Rich Text Format document or a web page
  // under a .docx name: each failed with "Could not read this DOCX archive: invalid zip data".
  if (!bytes.length) return 'This file is empty: it holds no document. It may not have finished uploading or copying. Open the original again.';
  const start = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^\ufeff/, '').trimStart();
  if (start.startsWith('{\\rtf')) return 'This is a Rich Text Format document (.rtf) with a .docx name. Save it as a Word Document (.docx) in the app that made it, then open it here.';
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:!doctype html|html)\b/i.test(start)) return 'This is a web page with a .docx name. Rename it to end in .html and open it here to import it, or save it as a Word Document (.docx) in the app that made it.';
  if (bytes.length < 512 || CFB_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  if (contains(bytes, utf16('EncryptedPackage'))) return 'This document is protected with a password. Open it in Word, remove the password, save it, and open it here again.';
  if (contains(bytes, utf16('WordDocument'))) return 'This is a Word 97–2003 document (.doc) with a .docx name. Save it as a Word Document (.docx) in Word, then open it here.';
  return 'This file is not a DOCX package. It may be another Office format saved with a .docx name.';
}
