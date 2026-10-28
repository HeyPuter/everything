import { deflateSync, zipSync } from 'fflate';

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
  return Object.hasOwn(parts, decoded) || !Object.hasOwn(parts, encoded) ? decoded : encoded;
}

/** The largest DOCX file the editor opens. */
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

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
 * Why bytes that are an OLE compound file ([MS-CFB] §2.2) rather than a ZIP package cannot open, or
 * null. Office keeps a password-protected document in one ([MS-OFFCRYPTO] §2.3.4.4, its
 * EncryptedPackage stream), as it does a Word 97–2003 document ([MS-DOC], its WordDocument stream).
 */
export function compoundFileProblem(bytes) {
  if (bytes.length < 512 || CFB_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  if (contains(bytes, utf16('EncryptedPackage'))) return 'This document is protected with a password. Open it in Word, remove the password, save it, and open it here again.';
  if (contains(bytes, utf16('WordDocument'))) return 'This is a Word 97–2003 document (.doc) with a .docx name. Save it as a Word Document (.docx) in Word, then open it here.';
  return 'This file is not a DOCX package. It may be another Office format saved with a .docx name.';
}
