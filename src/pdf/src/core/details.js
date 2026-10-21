import { PDFHexString, PDFName } from 'pdf-lib';
import { extraInfo, installXmp, readXmp, updatedXmp } from './xmp.js';

const GETTERS = {
  title: 'Title',
  author: 'Author',
  subject: 'Subject',
  keywords: 'Keywords',
  creator: 'Creator',
  producer: 'Producer',
  created: 'CreationDate',
  modified: 'ModificationDate',
};
function metadata(doc, packet) {
  const read = (getter) => {
    try {
      return getter();
    } catch {
      return undefined;
    }
  };
  const info = Object.fromEntries(
    Object.entries(GETTERS).map(([key, getter]) => [key, read(() => doc[`get${getter}`]())]),
  );
  const xmp = packet?.values || {};
  // ISO 32000-1 14.3.2 and XMP Part 3 2.2.2: newer Info overrides XMP;
  // otherwise XMP is authoritative. Missing properties can come from either store.
  const newerInfo = info.modified && xmp.metadataDate && info.modified > xmp.metadataDate;
  return Object.fromEntries(
    Object.keys(GETTERS).map((key) => [
      key,
      newerInfo ? (info[key] ?? xmp[key]) : (xmp[key] ?? info[key]),
    ]),
  );
}
/** Reconciled document metadata as plain values, plus what the file itself tells. */
export function documentDetails(doc, bytes) {
  const values = metadata(doc, readXmp(doc));
  return {
    ...Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value ?? (key === 'created' || key === 'modified' ? null : ''),
      ]),
    ),
    pages: doc.getPageCount(),
    size: bytes?.length ?? 0,
  };
}
const EDITABLE = ['title', 'author', 'subject', 'keywords'];
// Info strings can hold characters XML cannot (a title ending in a NUL is common). A value
// carried over unchanged drops them, so it does not block writing the XMP beside it.
const xmlSafe = (values) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? value
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
            .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
        : value,
    ]),
  );
const now = () => new Date(Math.floor(Date.now() / 1000) * 1000);
function writeMetadata(doc, packet, next, strict = true) {
  let modified;
  try {
    modified = doc.getModificationDate();
  } catch {
    /* No valid Info timestamp. */
  }
  const extras = extraInfo(
    doc,
    packet,
    modified && packet?.values.metadataDate && modified > packet.values.metadataDate,
  );
  let bytes;
  try {
    bytes = updatedXmp(packet, { ...next, metadataDate: next.modified }, extras);
  } catch (error) {
    if (strict) throw error;
    return false;
  }
  // Reconcile all mapped fields before advancing the timestamps: an untouched stale
  // counterpart must not become authoritative just because another field was edited.
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    // pdf-lib's setKeywords joins a list; preserve the exact free-form keyword string.
    if (key === 'keywords')
      doc.getInfoDict().set(PDFName.of('Keywords'), PDFHexString.fromText(value));
    else doc[`set${GETTERS[key]}`](value);
  }
  for (const { key, native } of extras) doc.getInfoDict().set(key, native);
  installXmp(doc, packet, bytes);
  return true;
}
/** Content edits must not let a newer ModDate revive outdated Info fields. */
export function synchronizeDocumentMetadata(doc) {
  const packet = readXmp(doc);
  // A damaged packet must not prevent unrelated page/content edits.
  if (!packet || packet.error) return false;
  return writeMetadata(doc, packet, { ...xmlSafe(metadata(doc, packet)), modified: now() }, false);
}
/**
 * Write the editable details. Returns false when nothing changed so the edit leaves no
 * history entry; values are trimmed and capped so a stray paste cannot bloat the file.
 */
export function setDocumentDetails(doc, values) {
  const packet = readXmp(doc),
    current = metadata(doc, packet),
    updates = {};
  for (const key of EDITABLE) {
    if (values[key] === undefined) continue;
    const value = String(values[key]).trim();
    if (value.length > 1000) throw new Error('Keep each detail under 1,000 characters.');
    if (value === (current[key] ?? '')) continue;
    updates[key] = value;
  }
  if (!Object.keys(updates).length) return false;
  writeMetadata(doc, packet, {
    ...xmlSafe(current),
    ...updates,
    modified: now(),
  });
}
