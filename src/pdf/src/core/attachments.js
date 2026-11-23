import {
  FileEmbedder,
  PDFArray,
  PDFDict,
  PDFName,
  PDFString,
  PDFHexString,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { annotationPosition, annotationsOf } from './structure.js';

const name = PDFName.of;
/** Attached files are capped like inserted pictures, so one cannot exhaust the editor. */
export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

const text = (value) =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';

/** The EmbeddedFiles name tree, or null when the document has none. */
function embeddedFiles(doc) {
  const names = doc.catalog.lookupMaybe(name('Names'), PDFDict);
  return names?.lookupMaybe(name('EmbeddedFiles'), PDFDict) || null;
}

/** Walk a name tree's leaves as [key, value, the Names array, index] in tree order. */
function* leaves(doc, node, seen = new Set()) {
  if (!(node instanceof PDFDict) || seen.has(node) || seen.size > 10000) return;
  seen.add(node);
  const entries = node.lookupMaybe(name('Names'), PDFArray);
  if (entries)
    for (let i = 0; i + 1 < entries.size(); i += 2)
      yield [text(entries.lookup(i)), entries.get(i + 1), entries, i];
  const kids = node.lookupMaybe(name('Kids'), PDFArray);
  if (kids) for (let i = 0; i < kids.size(); i++) yield* leaves(doc, kids.lookup(i), seen);
}

/** The document-level attachments: { key, name, description, size }. */
export function listAttachments(doc) {
  const tree = embeddedFiles(doc);
  if (!tree) return [];
  return [...leaves(doc, tree)].map(([key, value]) => {
    const spec = doc.context.lookup(value);
    const fileName =
      (spec instanceof PDFDict &&
        (text(spec.lookup(name('UF'))) || text(spec.lookup(name('F'))))) ||
      key;
    const stream =
      spec instanceof PDFDict && spec.lookupMaybe(name('EF'), PDFDict)?.lookup(name('F'));
    const params = stream?.dict?.lookupMaybe?.(name('Params'), PDFDict);
    const size = params?.lookup(name('Size'))?.asNumber?.();
    return {
      key,
      name: fileName,
      description: spec instanceof PDFDict ? text(spec.lookup(name('Desc'))) : '',
      size: Number.isFinite(size) ? size : null,
    };
  });
}

/** The decoded bytes of the file a file specification embeds, or null. */
function specBytes(spec) {
  const stream =
    spec instanceof PDFDict && spec.lookupMaybe(name('EF'), PDFDict)?.lookup(name('F'));
  if (!(stream instanceof PDFRawStream)) return null;
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return null;
  }
}

/** The bytes of a document-level attachment, decoded, or null when it cannot be read. */
export function attachmentBytes(doc, key) {
  const tree = embeddedFiles(doc);
  if (!tree) return null;
  for (const [entryKey, value] of leaves(doc, tree)) {
    if (entryKey !== key) continue;
    return specBytes(doc.context.lookup(value));
  }
  return null;
}

/**
 * The file a paperclip comment (FileAttachment) on page `index` holds: { name, bytes }, or null
 * when the comment is gone or its file cannot be read.
 */
export function commentFile(doc, index, id) {
  const annots = annotationsOf(doc.getPage(index));
  const position = annotationPosition(annots, id);
  const dict = position < 0 ? null : doc.context.lookup(annots.get(position));
  if (!(dict instanceof PDFDict) || dict.lookup(name('Subtype')) !== name('FileAttachment'))
    return null;
  const spec = dict.lookup(name('FS'));
  const bytes = specBytes(spec);
  if (!bytes) return null;
  const fileName = text(spec.lookup(name('UF'))) || text(spec.lookup(name('F'))) || 'attachment';
  // Only the name: a writer may put a path to the file there.
  return { name: fileName.split(/[\\/]/).pop() || 'attachment', bytes };
}

/** Attach a file to the document, as a desktop editor's Attachments panel does. */
export async function addAttachment(doc, { name: fileName, bytes, mimeType, description = '' }) {
  if (!fileName) throw new Error('Choose a file to attach.');
  if (bytes.length > MAX_ATTACHMENT_SIZE) throw new Error('Attach files of up to 20 MB.');
  const taken = new Set(listAttachments(doc).map((entry) => entry.key));
  // pdf-lib keys attachments by name; a second file of the same name gets a numbered key.
  let key = fileName;
  for (let n = 2; taken.has(key); n++) key = fileName.replace(/(\.[^.]*)?$/, ` (${n})$1`);
  const options = {
    mimeType: mimeType || 'application/octet-stream',
    description,
    creationDate: new Date(),
    modificationDate: new Date(),
  };
  const ref = await embedFile(doc, bytes, key, options);
  const kids = embeddedFiles(doc)?.lookupMaybe(name('Kids'), PDFArray);
  if (kids) attachUnderKids(doc, kids, ref, key);
  else {
    // As pdf-lib's attach files it, in the root's own Names array.
    const within = (dict, key, made) => {
      const found = dict.lookupMaybe(name(key), made.constructor);
      if (found) return found;
      dict.set(name(key), made);
      return made;
    };
    const names = within(doc.catalog, 'Names', doc.context.obj({}));
    const entries = within(
      within(names, 'EmbeddedFiles', doc.context.obj({})),
      'Names',
      doc.context.obj([]),
    );
    entries.push(PDFHexString.fromText(key));
    entries.push(ref);
    listAsAssociated(doc, ref);
  }
  return key;
}

/**
 * The file's stream and file specification, now. pdf-lib writes the specification's file name
 * (F) as a literal string as it is given: a name with a parenthesis that is not closed, as in
 * "smile :).txt", ended the string early and left the saved PDF unreadable there, the file
 * gone from it. F keeps the name's printable ASCII, escaped; UF holds the full name.
 */
async function embedFile(doc, bytes, key, options) {
  const ref = await FileEmbedder.for(bytes, key, options).embedIntoContext(doc.context);
  const spec = doc.context.lookup(ref, PDFDict);
  const plain = key.replace(/[^\x20-\x7E]/g, '_').replace(/[\\()]/g, '\\$&');
  spec.set(name('F'), PDFString.of(plain));
  return ref;
}
/** List the file among the document's associated files (PDF/A-3), as pdf-lib does. */
function listAsAssociated(doc, ref) {
  let associated = doc.catalog.lookup(name('AF'));
  if (!associated) {
    associated = doc.context.obj([]);
    doc.catalog.set(name('AF'), associated);
  }
  if (associated instanceof PDFArray) associated.push(ref);
}

const keyBytes = (value) =>
  value instanceof PDFString || value instanceof PDFHexString
    ? String.fromCharCode(...value.asBytes())
    : null;
/**
 * pdf-lib files a new attachment in the root's own Names array. A root that branches into Kids,
 * as longer lists are written, must not hold entries itself: readers follow only its Kids, so
 * the file never appeared. Give it a leaf of its own among the Kids, in key order.
 */
function attachUnderKids(doc, kids, ref, key) {
  const entry = PDFHexString.fromText(key);
  const leaf = doc.context.obj({ Names: [entry, ref], Limits: [entry, entry] });
  const sortKey = keyBytes(entry);
  let at = kids.size();
  for (let i = 0; i < kids.size(); i++) {
    const kid = kids.lookup(i);
    const limits = kid instanceof PDFDict ? kid.lookupMaybe(name('Limits'), PDFArray) : null;
    const low = limits ? keyBytes(limits.lookup(0)) : null;
    if (low != null && low > sortKey) {
      at = i;
      break;
    }
  }
  kids.insert(at, doc.context.register(leaf));
  listAsAssociated(doc, ref);
}

/** Remove a document-level attachment by its name tree key. False when it was not found. */
export function removeAttachment(doc, key) {
  const tree = embeddedFiles(doc);
  if (!tree) return false;
  for (const [entryKey, value, entries, index] of leaves(doc, tree)) {
    if (entryKey !== key) continue;
    // The leaf's Limits still bound the remaining keys, so they stay valid as they are.
    entries.remove(index + 1);
    entries.remove(index);
    // Attaching also lists the file among the document's associated files (see pdf-lib's
    // attach). Left there, the removed file's contents stayed in the saved PDF.
    const spec = doc.context.lookup(value);
    const associated = doc.catalog.lookup(name('AF'));
    if (associated instanceof PDFArray) {
      for (let i = associated.size() - 1; i >= 0; i--)
        if (associated.get(i) === value || (spec && doc.context.lookup(associated.get(i)) === spec))
          associated.remove(i);
      if (!associated.size()) doc.catalog.delete(name('AF'));
    }
    return true;
  }
  return false;
}
