import { waitFor } from '../lib/abort.js';
import { rememberStreamProtection } from './stream-filters.js';
import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  PDFTextField,
  PDFWidgetAnnotation,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  AcroTextFlags,
  PDFName,
  PDFOperator,
  PDFNumber,
  PDFHexString,
  PDFString,
  PDFArray,
  PDFDict,
  PDFRawStream,
  PDFRef,
  NoSuchFieldError,
  PDFObjectCopier,
  PDFPage,
  PDFPageLeaf,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  setStrokingColor,
  setLineWidth,
  setLineCap,
  setLineJoin,
  setFillingColor,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  stroke,
  fillAndStroke,
  fill,
} from 'pdf-lib';
import { textStyleBits } from './paragraph-data.js';
import { textDecorationQuads } from './text-decoration.js';
import { inheritPdfVersion, savePdf } from './version.js';
import { sweepUnreferenced } from './compress.js';
import { removePageStructure } from './struct-tree.js';
import { shiftPageLabels } from './page-labels.js';
import { retargetDeletedPages, stabilizeLocalDestinations } from './destinations.js';
import { addHighlight, rectQuad } from './highlight.js';
import { checkedFontData } from './font-data.js';
import { normalizeJpegPadding } from './jpeg.js';
import {
  prepareImageOrientation,
  imageOrientationMatrix,
  IMAGE_ORIENTATION_KEY,
} from './image-orientation.js';
import { reorientNotes } from './notes.js';
import { flattenFields, redrawnFieldTexts, requireFlattenedPages } from './flatten.js';
import { numberFormat, simpleCalculation, typedNumber } from './form-format.js';
import {
  choiceAppearanceProvider,
  prepareFieldAppearance,
  preserveFieldAppearance,
  textMaxLength,
  updateFieldAppearance,
} from './form-appearance.js';
import {
  choiceKeys,
  choiceOptions,
  choiceValues,
  defaultFieldValue,
  readChoiceKeys,
  selectedChoices,
  textValue,
} from './form-values.js';
export { choiceOptions } from './form-values.js';
import {
  COPY_INDEX,
  copyPageStandIns,
  inlineNamedDests,
  pruneCopiedResources,
  relinkCopiedPages,
} from './pages.js';
import { copyPagesWithLayers } from './optional-content.js';
import {
  DAMAGED_FORM,
  boundedPageCount,
  annotationsOf,
  formFields,
  pageBox,
  pageRotation,
  passwordFields,
  repairDocument,
  repairPageParents,
  repairForm,
} from './structure.js';

export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
/** The most pixels a PNG may unpack to: an 8000 by 6000 photo, about 200 MB as it is placed. */
export const MAX_PNG_PIXELS = 50 * 1000 * 1000;
export const MAX_PAGES = 1000;
const nameEncoder = new TextEncoder();
export function safeName(value) {
  const clean = String(value || '')
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, ' ')
    .trim()
    .replace(/\.pdf$/i, '')
    .trim();
  let name = '',
    bytes = 0;
  // Leave room for export suffixes within filesystem limits, without cutting a code point.
  for (const char of clean) {
    const size = nameEncoder.encode(char).length;
    if (bytes + size > 180) break;
    name += char;
    bytes += size;
  }
  return `${name.trim() || 'Untitled'}.pdf`;
}
export function normalizeRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}
export function color(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Choose a valid color.');
  return rgb(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255));
}
/** Readers accept leading junk before the header, so look for it within the first kilobyte. */
function hasPdfHeader(bytes) {
  const head = bytes.subarray ? bytes.subarray(0, 1024) : new Uint8Array(0);
  const text = String.fromCharCode(...head);
  return text.includes('%PDF');
}
export async function validatePdf(bytes) {
  if (!bytes?.length) throw new Error('This file is empty.');
  if (bytes.length > MAX_FILE_SIZE) throw new Error('Choose a PDF smaller than 100 MB.');
  let doc, pages;
  try {
    // Validation must not change the metadata used to interpret or copy this source.
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
    // A file can parse yet lack a usable page tree; reading it must fail the same friendly way.
    pages = boundedPageCount(doc, MAX_PAGES);
    if (pages > 0 && pages <= MAX_PAGES) {
      repairPageParents(doc);
      doc.getPageCount();
    }
  } catch (error) {
    if (/encrypt/i.test(error.message)) {
      // Callers that can ask for a password unlock the file and validate again.
      const locked = new Error('This PDF is password protected.');
      locked.code = 'encrypted';
      throw locked;
    }
    if (!hasPdfHeader(bytes)) throw new Error('This file is not a PDF. Choose a PDF file.');
    throw new Error('This PDF could not be opened. It may be damaged or unsupported.');
  }
  if (!pages || pages > MAX_PAGES) throw new Error('Choose a PDF with between 1 and 1,000 pages.');
  return doc;
}

/** Password flags do not mask an existing appearance stream; normalize it before viewing. */
export async function preparePdfForEditing(bytes) {
  const doc = await validatePdf(bytes);
  let passwords = passwordFields(doc);
  if (!passwords) {
    repairForm(doc);
    passwords = passwordFields(doc);
  }
  // Keep ordinary documents byte-for-byte, including signatures and custom appearances.
  if (!passwords.length) return bytes;
  const form = doc.getForm();
  const font = form.getDefaultFont();
  for (const field of passwords) {
    // pdf-lib requires every Kids entry to be a dictionary. Readers ignore invalid entries;
    // use the same valid widgets here, without rewriting the original child array.
    const kids = field.acroField.dict.lookup(PDFName.of('Kids'));
    const widgets = (kids instanceof PDFArray ? kids.asArray() : [field.acroField.dict])
      .map((entry) => doc.context.lookup(entry))
      .filter((entry) => entry instanceof PDFDict)
      .map((dict) => PDFWidgetAnnotation.fromDict(dict));
    field.acroField.getWidgets = () => widgets;
    try {
      updateFieldAppearance(field, form, font);
    } catch {
      // A damaged widget may not support text layout. A blank appearance still lets the file
      // open safely, without falling back to an old drawing that can spell out the password.
      const blank = doc.context.register(doc.context.formXObject([], { BBox: [0, 0, 1, 1] }));
      for (const widget of widgets) widget.setAppearances(doc.context.obj({ N: blank }));
      field.markAsClean();
    }
  }
  // Do not regenerate unrelated fields or change their custom appearances while opening.
  return savePdf(doc, { updateFieldAppearances: false });
}

/** Transactions retain original bytes, commit only on success, and bound undo memory. */
export class PdfSession {
  constructor(bytes) {
    this.bytes = bytes.slice();
    this.past = [];
    this.future = [];
    this.revision = 0;
    this.savedRevision = 0;
    this.nextRevision = 1;
  }
  get dirty() {
    return this.revision !== this.savedRevision;
  }
  markSaved(revision = this.revision) {
    this.savedRevision = revision;
  }
  async change(operation, { signal, canCommit, streamProtection, saveOptions } = {}) {
    // Reconciliation must see the original Info timestamps, not pdf-lib's load time.
    const doc = await waitFor(
      () => PDFDocument.load(this.bytes, { updateMetadata: false }),
      signal,
    );
    signal?.throwIfAborted();
    repairDocument(doc);
    rememberStreamProtection(doc.context, streamProtection);
    // Operations can explicitly report that no document content changed.
    const changed = await waitFor(() => operation(doc), signal);
    signal?.throwIfAborted();
    if (changed === false) return false;
    if (!doc.getPageCount() || doc.getPageCount() > MAX_PAGES)
      throw new Error('Keep between 1 and 1,000 pages in the PDF.');
    // Load XML support only for documents that actually carry an XMP packet.
    const synchronized =
      doc.catalog.has(PDFName.of('Metadata')) &&
      (await waitFor(() => import('./details.js'), signal)).synchronizeDocumentMetadata(doc);
    signal?.throwIfAborted();
    if (!synchronized) doc.setModificationDate(new Date());
    // pdf-lib writes every object it holds, referenced or not. Without this sweep each edit left
    // the content it replaced in the file, so files grew with every change and deleted pages or
    // replaced text stayed recoverable from the saved PDF.
    sweepUnreferenced(doc.context);
    // These already encoded streams are written unchanged. Check their lower bound after
    // metadata reconciliation has retired obsolete streams, before allocating the output.
    // Iterating the context map avoids sorting all references for this size-only check.
    let streamBytes = 0;
    for (const object of doc.context.indirectObjects.values()) {
      if (!(object instanceof PDFRawStream)) continue;
      streamBytes += object.getContentsSize();
      if (streamBytes >= MAX_FILE_SIZE) {
        if (canCommit && !canCommit()) return false;
        throw new Error('This edit would exceed the 100 MB PDF limit.');
      }
    }
    // A PDF/A-1 file must be written without object streams; callers say so for such files.
    const bytes = await waitFor(() => savePdf(doc, saveOptions), signal);
    signal?.throwIfAborted();
    if (canCommit && !canCommit()) return false;
    this.adopt(bytes);
  }
  /** Make `next` the current bytes and keep the previous ones in history. */
  adopt(next) {
    if (next.length > MAX_FILE_SIZE)
      throw new Error('This edit would exceed the 100 MB PDF limit.');
    this.past.push({ bytes: this.bytes, revision: this.revision });
    while (
      this.past.length > 25 ||
      (this.past.length > 1 &&
        this.past.reduce((s, x) => s + x.bytes.length, 0) > 100 * 1024 * 1024)
    )
      this.past.shift();
    this.bytes = next;
    this.revision = this.nextRevision++;
    this.future = [];
  }
  undo() {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push({ bytes: this.bytes, revision: this.revision });
    Object.assign(this, prev);
    return true;
  }
  redo() {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push({ bytes: this.bytes, revision: this.revision });
    Object.assign(this, next);
    return true;
  }
}
function turnPage(page, delta) {
  page.setRotation(degrees((((pageRotation(page) + delta) % 360) + 360) % 360));
}
export function rotatePage(doc, index, delta = 90) {
  rotatePages(doc, [index], delta);
}
/**
 * Turn several pages by the same quarter turn. Their sticky note icons, meant to stay upright
 * whichever way a page is turned, are set right in one pass over the document for all of them.
 */
export function rotatePages(doc, indices, delta = 90) {
  const list = [...new Set(indices)];
  for (const index of list) turnPage(doc.getPage(index), delta);
  reorientNotes(doc, list);
}
/** Turn every page by the same quarter turn, as a scan that came in sideways needs. */
export function rotateAllPages(doc, delta = 90) {
  rotatePages(doc, doc.getPageIndices(), delta);
}
/** Keep widget indices aligned with Opt while skipping unreadable children during deletion. */
function deletionWidgets(field) {
  const dict = field.acroField.dict;
  const kids = dict.lookup(PDFName.of('Kids'));
  if (!(kids instanceof PDFArray))
    return { widgets: [PDFWidgetAnnotation.fromDict(dict)], damaged: kids !== undefined };
  const widgets = kids.asArray().map((entry) => {
    const child = dict.context.lookup(entry);
    return child instanceof PDFDict ? PDFWidgetAnnotation.fromDict(child) : null;
  });
  return { widgets, damaged: widgets.some((widget) => !widget) };
}
/** Clearing selection needs only the surviving, readable widgets, not damaged Kids entries. */
function clearButtonSelection(field, widgets) {
  field.acroField.dict.set(PDFName.of('V'), PDFName.of('Off'));
  for (const widget of widgets) widget.setAppearanceState(PDFName.of('Off'));
}
export function deletePage(doc, index) {
  deletePages(doc, [index]);
}
/**
 * Delete several pages (zero-based indices, in any order) in one step. Bookmarks and links to
 * them are found once for all of them, so deleting many pages of a long PDF stays quick.
 */
export function deletePages(doc, indices) {
  const list = [...new Set(indices)].sort((a, b) => b - a);
  if (!list.length) return;
  if (list.length >= doc.getPageCount()) throw new Error('Keep at least one page in the PDF.');
  // A page that does not exist stops the deletion before anything changes.
  const pages = list.map((index) => doc.getPage(index));
  retargetDeletedPages(doc, list);
  // A field tree that cannot be walked leaves its widgets alone; the pages still go. The fields
  // are read once for all the pages: a field whose last widget goes is emptied and left with
  // nothing to match on later pages.
  const fields = formFields(doc) || [];
  // Widgets that name no page are matched to the page's annotation references by identity.
  // pdf-lib's getObjectRef scans every object of the document per call, so one reverse
  // index serves every widget of a large form instead.
  let refs;
  const refOf = (object) => {
    if (!refs)
      refs = new Map(doc.context.enumerateIndirectObjects().map(([ref, value]) => [value, ref]));
    return refs.get(object);
  };
  removePageStructure(doc, pages);
  // From the last page back, so the indices still to go stay where they were.
  for (const index of list) removeOnePage(doc, index, fields, refOf);
}
function removeOnePage(doc, index, fields, refOf) {
  const page = doc.getPage(index);
  const annotations = new Set(annotationsOf(page)?.asArray() || []);
  const form = doc.getForm();
  for (const field of fields) {
    const { widgets, damaged } = deletionWidgets(field);
    if (damaged && !form.fieldIsDirty(field.ref)) preserveFieldAppearance(field, form);
    let removed = false;
    let buttonExports;
    let radioOptions;
    for (let i = widgets.length - 1; i >= 0; i--) {
      const widget = widgets[i];
      if (!widget) continue;
      if (
        widget.P() === page.ref ||
        annotations.has(widget.dict) ||
        (annotations.size > 0 && annotations.has(refOf(widget.dict)))
      ) {
        if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
          if (!removed) {
            if (field instanceof PDFRadioGroup) radioOptions = radioFieldOptions(field, widgets);
            const exports = doc.context.lookup(
              field.acroField.getInheritableAttribute(PDFName.of('Opt')),
            );
            if (exports instanceof PDFArray) {
              // Export entries correspond to widget indices, including malformed entries.
              // Own the array before changing it: other fields may share or inherit it.
              buttonExports = exports.clone();
            } else if (
              field instanceof PDFRadioGroup &&
              (exports instanceof PDFString || exports instanceof PDFHexString)
            ) {
              buttonExports = doc.context.obj([exports]);
            }
            if (buttonExports && field instanceof PDFRadioGroup) {
              // A viewer may fall back to the on-state's numeric index in Opt. Make
              // missing exports explicit before deleting widgets shifts those indices.
              widgets.forEach((widget, index) => {
                if (!widget) return;
                const value = buttonExports.lookup(index);
                if (value instanceof PDFString || value instanceof PDFHexString) return;
                const on = widget.getOnValue();
                buttonExports.set(
                  index,
                  on
                    ? PDFHexString.fromText(on.decodeText())
                    : (buttonExports.get(index) ?? doc.context.obj(null)),
                );
              });
            }
            if (buttonExports) field.acroField.dict.set(PDFName.of('Opt'), buttonExports);
          }
          buttonExports?.remove(i);
        }
        const kids = field.acroField.dict.lookup(PDFName.of('Kids'));
        if (kids instanceof PDFArray) {
          if (!removed) field.acroField.dict.set(PDFName.of('Kids'), kids.clone());
          field.acroField.removeWidget(i);
        } else field.acroField.setKids([]);
        removed = true;
      }
    }
    if (!removed) continue;
    const remainingSlots = deletionWidgets(field).widgets;
    const remaining = remainingSlots.filter(Boolean);
    if (!remaining.length) {
      field.acroField.setKids([]);
      form.removeField(field);
    } else if (field instanceof PDFCheckBox) {
      const selected = buttonFieldState(field);
      // A repeated checkbox can still represent this selection on another page.
      if (
        selected != null &&
        widgets.some((widget) => widget?.getOnValue()?.decodeText() === selected) &&
        !remaining.some((widget) => widget.getOnValue()?.decodeText() === selected)
      )
        clearButtonSelection(field, remaining);
    } else if (field instanceof PDFRadioGroup) {
      const selected = buttonFieldState(field);
      const appearanceName =
        selected != null &&
        widgets.some((widget) => widget?.getOnValue()?.decodeText() === selected);
      // Viewers also accept export names as values. Give actual appearance names priority
      // when the two overlap, and compare exports before and after deleting the widgets.
      const survives = appearanceName
        ? remaining.some((widget) => widget.getOnValue()?.decodeText() === selected)
        : radioFieldOptions(field, remainingSlots).includes(selected);
      if (
        !survives &&
        (appearanceName ||
          radioOptions.includes(selected) ||
          field.acroField.getValue() === PDFName.of('Off'))
      )
        clearButtonSelection(field, remaining);
    }
  }
  removePageBeads(doc, page);
  shiftPageLabels(doc, index, -1);
  doc.removePage(index);
  // pdf-lib leaves its page list cached after removal; a second deletion in the same
  // transaction must resolve destinations and widgets against the new page order.
  doc.pageCache.invalidate();
}
/**
 * Take a deleted page's article beads out of their threads (ISO 32000-1, 12.4.3). Each bead
 * names its page, so a thread that ran across the page kept the page, with all its content,
 * in the saved file. A thread left without beads goes as well.
 */
function removePageBeads(doc, page) {
  const threads = doc.catalog.lookup(PDFName.of('Threads'));
  if (!(threads instanceof PDFArray)) return;
  const [F, N, V, P] = ['F', 'N', 'V', 'P'].map((key) => PDFName.of(key));
  for (let t = threads.size() - 1; t >= 0; t--) {
    const thread = threads.lookup(t);
    if (!(thread instanceof PDFDict)) continue;
    // The beads in reading order, once round the circle; a broken chain ends the list.
    const beads = [];
    const seen = new Set();
    for (let ref = thread.get(F); ref instanceof PDFRef && !seen.has(ref);) {
      seen.add(ref);
      const bead = doc.context.lookup(ref);
      if (!(bead instanceof PDFDict)) break;
      beads.push({ ref, bead });
      ref = bead.get(N);
    }
    const kept = beads.filter(({ bead }) => bead.get(P) !== page.ref);
    if (kept.length === beads.length) continue;
    if (!kept.length) {
      threads.remove(t);
      continue;
    }
    kept.forEach(({ bead }, i) => {
      bead.set(N, kept[(i + 1) % kept.length].ref);
      bead.set(V, kept[(i + kept.length - 1) % kept.length].ref);
    });
    thread.set(F, kept[0].ref);
  }
}
/**
 * Write what a page inherits from the page tree (size, crop, rotation, resources) onto the page
 * itself, so that it keeps them when it moves under another node of the tree.
 */
function settleInheritance(page) {
  for (const key of PDFPageLeaf.InheritableEntries) {
    const name = PDFName.of(key);
    if (page.node.get(name)) continue;
    const inherited = page.node.getInheritableAttribute(name);
    if (inherited !== undefined) page.node.set(name, inherited);
  }
}
/**
 * Give a page added to the document its own crop box and rotation when the page tree would
 * otherwise hand it ones meant for the pages that were there before.
 */
export function ownGeometry(page) {
  const { node } = page;
  const crop = PDFName.of('CropBox'),
    rotate = PDFName.of('Rotate');
  if (!node.get(crop) && node.getInheritableAttribute(crop))
    node.set(crop, node.MediaBox().clone());
  if (!node.get(rotate) && node.getInheritableAttribute(rotate) !== undefined)
    node.set(rotate, PDFNumber.of(0));
  return page;
}
export function movePage(doc, index, target) {
  if (target < 0 || target >= doc.getPageCount()) return;
  doc.getPage(index);
  stabilizeLocalDestinations(doc);
  placePage(doc, index, target);
}
function placePage(doc, index, target) {
  const page = doc.getPage(index);
  settleInheritance(page);
  doc.removePage(index);
  doc.insertPage(target, page);
}
/**
 * Put the pages in a new order: `order` lists every current page index once, in the order
 * wanted. Bookmarks and links are prepared once for the whole move, not once per page.
 */
export function reorderPages(doc, order) {
  const count = doc.getPageCount();
  if (
    order.length !== count ||
    new Set(order).size !== count ||
    order.some((i) => !Number.isInteger(i) || i < 0 || i >= count)
  )
    throw new Error('Choose a new order for every page.');
  if (order.every((page, position) => page === position)) return;
  stabilizeLocalDestinations(doc);
  // Bring each page to its place in turn; earlier places are already settled.
  const current = [...Array(count).keys()];
  order.forEach((page, target) => {
    const from = current.indexOf(page);
    if (from === target) return;
    placePage(doc, from, target);
    current.splice(target, 0, ...current.splice(from, 1));
  });
}
/** Insert an empty page after the given one with the same visible size, rotation, and unit. */
export function insertBlankPage(doc, index) {
  const source = doc.getPage(index);
  stabilizeLocalDestinations(doc);
  const box = visibleBox(source);
  const page = ownGeometry(doc.insertPage(index + 1, [box.width, box.height]));
  page.setRotation(degrees(pageRotation(source)));
  const unit = source.node.get(PDFName.of('UserUnit'));
  if (unit) page.node.set(PDFName.of('UserUnit'), unit);
  shiftPageLabels(doc, index + 1, 1);
  return page;
}
/**
 * The area a viewer shows: the crop box clipped to the media box, or the media box alone when
 * they do not overlap. Corners written in the other order are read as PDF.js reads them.
 */
const LETTER = { x: 0, y: 0, width: 612, height: 792 };
export function visibleBox(page) {
  const media = pageBox(page, 'MediaBox') || LETTER;
  const crop = pageBox(page, 'CropBox') || media;
  const left = Math.max(media.x, crop.x);
  const bottom = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  return right > left && top > bottom
    ? { x: left, y: bottom, width: right - left, height: top - bottom }
    : media;
}
/**
 * Insert pages of another PDF (`pages`: zero-based indices in the order wanted, all by
 * default) after page `after` of `doc` (-1 for the front, the last page by default).
 * `onSource` is shown the parsed source PDF. Returns the indices the new pages took.
 */
export async function insertPdfPages(
  doc,
  bytes,
  { pages, after = doc.getPageCount() - 1, onSource } = {},
) {
  const source = await validatePdf(bytes);
  onSource?.(source);
  const indices = pages ?? source.getPageIndices();
  if (!indices.length) throw new Error('Choose at least one page to insert.');
  if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= source.getPageCount()))
    throw new Error(`Pages must be between 1 and ${source.getPageCount()}.`);
  if (doc.getPageCount() + indices.length > MAX_PAGES)
    throw new Error('The merged PDF would exceed 1,000 pages.');
  // Preserve form values without colliding field names. Any widgets that cannot be flattened
  // remain on the source; reject copying those pages before they can become orphaned fields.
  const fonts = await flattenFonts(source);
  try {
    flattenFields(source, { fonts });
  } catch {
    /* The check below rejects any selected page whose widgets remain. */
  }
  requireFlattenedPages(source, indices);
  stabilizeLocalDestinations(doc);
  // Carry each inserted page's internal links to the page they land on and drop the orphan page
  // copies the copier drags in for the links' targets (see relinkCopiedPages).
  inlineNamedDests(source, indices);
  const sourcePages = source.getPages();
  sourcePages.forEach((page, index) => page.node.set(COPY_INDEX, PDFNumber.of(index)));
  const copied = await copyPagesWithLayers(doc, source, indices, (copier) =>
    copyPageStandIns(copier, source, doc),
  );
  const position = Math.min(Math.max(after + 1, 0), doc.getPageCount());
  copied.forEach((page, k) => ownGeometry(doc.insertPage(position + k, page)));
  shiftPageLabels(doc, position, copied.length);
  pruneCopiedResources(doc, copied);
  const indexToRef = new Map(indices.map((index, k) => [index, copied[k].ref]));
  relinkCopiedPages(doc, copied, indexToRef);
  inheritPdfVersion(doc, source);
  return copied.map((_, k) => position + k);
}
/** Insert an independent copy of page `index` right after it. Returns the copy's index. */
export async function duplicatePage(doc, index) {
  await duplicatePages(doc, [index]);
  return index + 1;
}
/**
 * Insert an independent copy of each page in `indices` right after it. The pages share one
 * flattened snapshot of the form and one search for links, however many there are.
 */
export async function duplicatePages(doc, indices) {
  const list = [...new Set(indices)].sort((a, b) => b - a);
  if (!list.length) return;
  if (doc.getPageCount() + list.length > MAX_PAGES)
    throw new Error('Keep between 1 and 1,000 pages in the PDF.');
  for (const index of list) doc.getPage(index);
  stabilizeLocalDestinations(doc);
  // Copy a page that has a form field through a flattened copy of the document. Copying such a
  // page directly leaves the copy's widgets owned by no field (pdf-lib does not carry the form
  // when copying pages), so the field showed its value on the original page only and could not
  // be filled or removed afterwards. Its fields become fixed content on the copy, as they do
  // when a page is inserted from another PDF or extracted. Pages with no form copy as they are.
  let source = doc;
  if (formFields(doc)?.length) {
    source = await PDFDocument.load(await savePdf(doc));
    const fonts = await flattenFonts(source);
    try {
      flattenFields(source, { fonts });
    } catch {
      /* The check below rejects a page whose widgets remain. */
    }
  }
  requireFlattenedPages(source, list);
  // An internal link on the copied page should point at the existing page it targets, not at a
  // hidden copy the copier would otherwise drag in (see relinkCopiedPages). The links resolve
  // against the pages already in the document.
  inlineNamedDests(source, list);
  const sourcePages = source.getPages();
  sourcePages.forEach((page, i) => page.node.set(COPY_INDEX, PDFNumber.of(i)));
  const existing = doc.getPages().map((page) => page.ref);
  try {
    const layerKey = PDFName.of('OCProperties');
    const groupKey = PDFName.of('OCGs');
    const layers = source.catalog.lookup(layerKey);
    const groups = layers instanceof PDFDict && layers.lookup(groupKey);
    await source.flush();
    const copies = [];
    // From the last page back, so the pages still to copy keep their places.
    for (const index of list) {
      // Each copy gets a copier of its own, so copies share nothing with each other.
      const copier = PDFObjectCopier.for(source.context, doc.context);
      copyPageStandIns(copier, source, doc, sourcePages);
      if (groups instanceof PDFArray) {
        const originals = doc.catalog.lookup(layerKey).lookup(groupKey);
        // A duplicate belongs to the same layers as its original. Seed the copier's identity
        // map so nested OCMDs, appearances and resources all reuse those groups. A flattened
        // snapshot retains the catalog's group ordering even when its field objects change.
        for (let i = 0; i < groups.size(); i++) {
          const group = groups.get(i),
            original = originals.get(i);
          const dict = source.context.lookup(group),
            originalDict = doc.context.lookup(original);
          if (!(dict instanceof PDFDict) || !(originalDict instanceof PDFDict)) continue;
          copier.traversedObjects.set(group, original);
          copier.traversedObjects.set(dict, originalDict);
        }
      }
      const node = copier.copy(sourcePages[index].node);
      const copy = PDFPage.of(node, doc.context.register(node), doc);
      ownGeometry(doc.insertPage(index + 1, copy));
      shiftPageLabels(doc, index + 1, 1);
      copies.push(copy);
    }
    relinkCopiedPages(doc, copies, new Map(existing.map((ref, i) => [i, ref])));
  } finally {
    if (source === doc) sourcePages.forEach((page) => page.node.delete(COPY_INDEX));
  }
}
/** Append every page of another PDF. */
export async function mergePdf(doc, bytes) {
  await insertPdfPages(doc, bytes);
}
/** The Noto Sans faces new and restyled text can use. */
export const TEXT_FONTS = {
  regular: 'NotoSans-Regular.ttf',
  bold: 'NotoSans-Bold.ttf',
  italic: 'NotoSans-Italic.ttf',
  boldItalic: 'NotoSans-BoldItalic.ttf',
};
export const hasKoreanText = (text) => /\p{Script=Hangul}/u.test(text);
/** Pick a bundled face before loading it; no external font service is needed. */
export function textFontFile(variant = 'regular', text = '') {
  if (!TEXT_FONTS[variant]) throw new Error('Choose a supported text style.');
  if (!hasKoreanText(text)) return TEXT_FONTS[variant];
  if (variant.toLowerCase().includes('italic'))
    throw new Error('Korean text supports regular and bold styles. Turn off italic to apply.');
  return variant === 'bold' ? 'NotoSansKR-Bold.ttf' : 'NotoSansKR-Regular.ttf';
}
export const textVariant = (bold, italic) =>
  bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular';
const fontBytes = new Map();
// One subset per face per document: every edit in the same transaction shares it instead of
// embedding a fresh copy of the font program per changed line or field.
const embeddedFonts = new WeakMap();
export function embedFont(doc, variant = 'regular', text = '') {
  const file = textFontFile(variant, text);
  let fonts = embeddedFonts.get(doc);
  if (!fonts) embeddedFonts.set(doc, (fonts = new Map()));
  let font = fonts.get(file);
  if (!font) {
    font = (async () => {
      if (!fontBytes.has(file))
        fontBytes.set(
          file,
          fetch(`${import.meta.env.BASE_URL}fonts/${file}`)
            .then((r) => {
              if (!r.ok) throw new Error('Could not load the text font. Please retry.');
              return r.arrayBuffer();
            })
            .then((bytes) => checkedFontData(bytes, 'text'))
            .catch((e) => {
              fontBytes.delete(file);
              throw e;
            }),
        );
      // Observe both requests immediately: a font download can fail before the parser
      // arrives, and the failed bytes promise removes itself from the retry cache.
      const request = fontBytes.get(file);
      const [bytes, { default: fontkit }] = await Promise.all([
        request,
        import('@pdf-lib/fontkit'),
      ]);
      doc.registerFontkit(fontkit);
      let embedded;
      try {
        embedded = await doc.embedFont(bytes, { subset: true });
      } catch (error) {
        // A complete download can still contain an invalid font table. Do not evict
        // a newer request if another document has already started its own retry.
        if (fontBytes.get(file) === request) fontBytes.delete(file);
        throw new Error('Could not load the text font. Please retry.', { cause: error });
      }
      // pdf-lib uses these public methods for page text and form appearances alike.
      // Normalize both so measuring and encoding cannot choose different glyphs.
      const encode = embedded.encodeText.bind(embedded);
      const measure = embedded.widthOfTextAtSize.bind(embedded);
      embedded.encodeText = (text) => encode(assertSupportedText(embedded, text));
      embedded.widthOfTextAtSize = (text, size) =>
        measure(assertSupportedText(embedded, text), size);
      return embedded;
    })().catch((error) => {
      fonts.delete(file);
      throw error;
    });
    fonts.set(file, font);
  }
  return font;
}
export async function addText(
  doc,
  index,
  {
    text,
    x,
    y,
    size = 16,
    hex = '#111111',
    rotation = 0,
    variant = 'regular',
    underline = false,
    strikethrough = false,
  },
) {
  if (!text.trim()) throw new Error('Enter some text.');
  const font = await embedFont(doc, variant, text);
  assertSupportedText(font, text);
  const page = doc.getPage(index);
  const lines = text.split(/\r\n?|\n/);
  const widths = lines.map((line) => font.widthOfTextAtSize(line, size));
  const angle = (rotation * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  if (underline || strikethrough) {
    const width = Math.max(1, ...widths),
      leading = size * 1.35;
    const items = lines.flatMap((_, i) => (i ? [-1, 1] : [1]));
    page.pushOperators(
      pushGraphicsState(),
      PDFOperator.of('BDC', [
        PDFName.of('PuterParagraph'),
        doc.context.obj({
          V: 1,
          Frame: [0, 0, width * c, width * s, -leading * s, leading * c],
          Items: items,
          Style: textStyleBits({ underline, strikethrough, line: true }),
        }),
      ]),
    );
  }
  page.drawText(text, {
    x,
    y,
    size,
    font,
    color: color(hex),
    rotate: degrees(rotation),
    lineHeight: size * 1.35,
  });
  if (underline || strikethrough) {
    page.pushOperators(
      PDFOperator.of('BMC', [PDFName.of('PuterTextDecoration')]),
      pushGraphicsState(),
      setFillingColor(color(hex)),
    );
    for (const [i, width] of widths.entries()) {
      if (!width) continue;
      const origin = [x + i * size * 1.35 * s, y - i * size * 1.35 * c];
      for (const quad of textDecorationQuads(
        origin,
        [width * c, width * s],
        [-size * s, size * c],
        { underline, strikethrough },
      ))
        page.pushOperators(
          moveTo(...quad[0]),
          ...quad.slice(1).map((p) => lineTo(...p)),
          closePath(),
          fill(),
        );
    }
    page.pushOperators(
      popGraphicsState(),
      PDFOperator.of('EMC'),
      PDFOperator.of('EMC'),
      popGraphicsState(),
    );
  }
}
/**
 * The bundled faces flattening needs for fields it draws anew whose text the standard font
 * cannot write, such as Polish, Cyrillic, or Korean values in a form that leaves its drawing to
 * the viewer. Pass them to flattenDocument.
 */
export function flattenFonts(doc) {
  return textFonts(doc, redrawnFieldTexts(doc));
}
/** The bundled faces for those of `texts` the standard font cannot write. */
export async function textFonts(doc, texts) {
  if (!texts.length) return [];
  const standard = doc.getForm().getDefaultFont();
  const fonts = new Set();
  for (const text of texts)
    try {
      standard.encodeText(text.replace(/[\r\n]/g, ''));
    } catch {
      fonts.add(await embedFont(doc, 'regular', text));
    }
  return [...fonts];
}
const characterSets = new WeakMap();
/** Return the supported canonical spelling, composing accents where the face permits it. */
export function assertSupportedText(font, text) {
  let supported = characterSets.get(font);
  if (!supported) characterSets.set(font, (supported = new Set(font.getCharacterSet())));
  const has = (char) => char === '\n' || supported.has(char.codePointAt(0));
  return [...text.normalize('NFC')]
    .map((char) => {
      if (has(char)) return char;
      // Some composed characters lack a glyph although all their canonical components exist.
      const decomposed = char.normalize('NFD');
      if ([...decomposed].every(has)) return decomposed;
      throw new Error('This font does not support one or more characters in this text.');
    })
    .join('');
}
/**
 * The triangle at the tip of an arrow from `from` to `to` drawn with a stroke `width`, in the
 * coordinate space of the points. The shaft ends at `base` so the head has a clean tip.
 */
export function arrowHead(from, to, width, minimum = 8) {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / length,
    uy = (to.y - from.y) / length;
  const size = Math.min(length, Math.max(minimum, width * 5)),
    half = size * 0.45;
  const base = { x: to.x - ux * size, y: to.y - uy * size };
  return {
    tip: to,
    base,
    left: { x: base.x - uy * half, y: base.y + ux * half },
    right: { x: base.x + uy * half, y: base.y - ux * half },
  };
}
export function drawMark(doc, index, mark) {
  if (mark.type === 'highlight')
    return addHighlight(doc, index, {
      quads: [rectQuad(mark.rect)],
      hex: mark.hex,
      kind: mark.kind || 'highlight',
      author: mark.author,
    });
  const page = doc.getPage(index);
  if (mark.type === 'ink') {
    if (mark.points.length < 2) return false;
    page.pushOperators(
      pushGraphicsState(),
      setStrokingColor(color(mark.hex)),
      setLineWidth(mark.width),
      setLineCap(1),
      setLineJoin(1),
      moveTo(mark.points[0].x, mark.points[0].y),
    );
    // Batch the operators, not the stroke: a long gesture must stay one connected
    // editable path without exceeding the engine's function-argument limit.
    for (let start = 1; start < mark.points.length; start += 512)
      page.pushOperators(...mark.points.slice(start, start + 512).map((p) => lineTo(p.x, p.y)));
    page.pushOperators(stroke(), popGraphicsState());
  } else if (mark.shape === 'ellipse') {
    // Four Bézier arcs in one plain path: pdf-lib's own ellipse nests a state block inside
    // the path, which keeps the path editor from picking it up afterwards.
    const r = mark.rect,
      cx = r.x + r.width / 2,
      cy = r.y + r.height / 2,
      rx = r.width / 2,
      ry = r.height / 2,
      k = 0.5522847498;
    page.pushOperators(
      pushGraphicsState(),
      setStrokingColor(color(mark.hex)),
      setLineWidth(mark.width),
      setLineJoin(1),
      moveTo(cx + rx, cy),
      appendBezierCurve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
      appendBezierCurve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
      appendBezierCurve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
      appendBezierCurve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
      closePath(),
      stroke(),
      popGraphicsState(),
    );
  } else if (mark.shape === 'line') {
    page.pushOperators(
      pushGraphicsState(),
      setStrokingColor(color(mark.hex)),
      setLineWidth(mark.width),
      setLineCap(1),
      setLineJoin(1),
      moveTo(mark.from.x, mark.from.y),
      lineTo(mark.to.x, mark.to.y),
      stroke(),
      popGraphicsState(),
    );
  } else if (mark.shape === 'check' || mark.shape === 'cross') {
    // Fit the mark in the displayed box, keeping its orientation consistent with
    // the drawing preview even when the PDF page is rotated.
    const r = mark.rect,
      rotation = pageRotation(page),
      at = (fx, fy) => {
        const [x, y] =
          rotation === 90
            ? [1 - fy, fx]
            : rotation === 180
              ? [1 - fx, 1 - fy]
              : rotation === 270
                ? [fy, 1 - fx]
                : [fx, fy];
        return [r.x + r.width * x, r.y + r.height * y];
      };
    const strokes =
      mark.shape === 'check'
        ? [moveTo(...at(0.12, 0.52)), lineTo(...at(0.4, 0.18)), lineTo(...at(0.9, 0.86))]
        : [
            moveTo(...at(0.15, 0.85)),
            lineTo(...at(0.85, 0.15)),
            moveTo(...at(0.15, 0.15)),
            lineTo(...at(0.85, 0.85)),
          ];
    page.pushOperators(
      pushGraphicsState(),
      setStrokingColor(color(mark.hex)),
      setLineWidth(mark.width),
      setLineCap(1),
      setLineJoin(1),
      ...strokes,
      stroke(),
      popGraphicsState(),
    );
  } else if (mark.shape === 'arrow') {
    // One path, so the arrow is one editable object: the open shaft is only stroked, the
    // closed head is filled and stroked.
    const head = arrowHead(mark.from, mark.to, mark.width),
      paint = color(mark.hex);
    page.pushOperators(
      pushGraphicsState(),
      setStrokingColor(paint),
      setFillingColor(paint),
      setLineWidth(mark.width),
      setLineCap(1),
      setLineJoin(1),
      moveTo(mark.from.x, mark.from.y),
      lineTo(head.base.x, head.base.y),
      moveTo(head.tip.x, head.tip.y),
      lineTo(head.left.x, head.left.y),
      lineTo(head.right.x, head.right.y),
      closePath(),
      fillAndStroke(),
      popGraphicsState(),
    );
  } else {
    page.drawRectangle({
      ...mark.rect,
      borderColor: color(mark.hex),
      borderWidth: mark.width,
    });
  }
}
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
export const isPng = (bytes) => PNG_SIGNATURE.every((n, i) => bytes[i] === n);
export const isJpeg = (bytes) => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
/** Decode a PNG or JPEG into the document, translating parser failures into user-facing errors. */
export async function embedImage(doc, bytes) {
  if (bytes?.length > MAX_IMAGE_SIZE) throw new Error('Choose an image smaller than 20 MB.');
  const invalid = () => new Error('Choose a valid PNG or JPEG image.');
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw invalid();
  // A PNG is unpacked in full to be placed, and a small file can hold an enormous picture of
  // one color; its header says the size before any of it is unpacked.
  if (isPng(bytes) && bytes.length >= 24) {
    const header = new DataView(bytes.buffer, bytes.byteOffset + 16, 8);
    if (header.getUint32(0) * header.getUint32(4) > MAX_PNG_PIXELS)
      throw new Error('Choose a PNG picture of at most 50 megapixels.');
  }
  let image;
  try {
    if (isPng(bytes)) image = await doc.embedPng(bytes);
    else if (isJpeg(bytes)) image = await doc.embedJpg(normalizeJpegPadding(bytes));
    else throw invalid();
  } catch {
    throw invalid();
  }
  if (![image.width, image.height].every((n) => Number.isFinite(n) && n > 0)) throw invalid();
  return image;
}
/** Embed unchanged pixels and carry the EXIF rotation separately from the image decoder. */
export async function embedOrientedImage(doc, bytes) {
  if (bytes?.length > MAX_IMAGE_SIZE) throw new Error('Choose an image smaller than 20 MB.');
  const prepared = prepareImageOrientation(bytes);
  const image = await embedImage(doc, prepared.bytes);
  if (prepared.orientation !== 1) {
    // Keep intrinsic photo orientation distinct from rotations made later in the editor.
    await image.embed();
    doc.context
      .lookup(image.ref)
      .dict.set(PDFName.of(IMAGE_ORIENTATION_KEY), PDFNumber.of(prepared.orientation));
  }
  const sideways = prepared.orientation >= 5;
  return {
    image,
    orientation: prepared.orientation,
    width: sideways ? image.height : image.width,
    height: sideways ? image.width : image.height,
  };
}

/** Draw an upright image in a placed box, optionally turned with its PDF page. */
export function drawOrientedImage(page, embedded, { x, y, width, height, rotation = 0 }) {
  if (embedded.orientation === 1) {
    page.drawImage(embedded.image, { x, y, width, height, rotate: degrees(rotation) });
    return;
  }
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(radians)),
    sin = Math.round(Math.sin(radians));
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(width * cos, width * sin, -height * sin, height * cos, x, y),
    concatTransformationMatrix(...imageOrientationMatrix(embedded.orientation)),
  );
  page.drawImage(embedded.image, { x: 0, y: 0, width: 1, height: 1 });
  page.pushOperators(popGraphicsState());
}

export async function addImage(doc, index, bytes) {
  const image = await embedOrientedImage(doc, bytes);
  const page = doc.getPage(index);
  const box = visibleBox(page);
  const rotation = pageRotation(page);
  const sideways = rotation === 90 || rotation === 270;
  const scale = Math.min(
    ((sideways ? box.height : box.width) * 0.6) / image.width,
    ((sideways ? box.width : box.height) * 0.5) / image.height,
  );
  const size = { width: image.width * scale, height: image.height * scale };
  const [cos, sin] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ][rotation / 90];
  drawOrientedImage(page, image, {
    x: box.x + box.width / 2 - (size.width * cos - size.height * sin) / 2,
    y: box.y + box.height / 2 - (size.width * sin + size.height * cos) / 2,
    ...size,
    rotation,
  });
}
/** A new PDF of one empty page, A4 unless another paper size ([width, height]) is given. */
export async function blankPdf(size = [595.28, 841.89]) {
  const doc = await PDFDocument.create();
  doc.addPage(Array.isArray(size) ? size : [595.28, 841.89]);
  return doc.save();
}
export async function samplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(0.04, 0.39, 0.94);
  const ink = rgb(0.1, 0.12, 0.15);
  const gray = rgb(0.38, 0.4, 0.44);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('PDF EDITOR / GETTING STARTED', {
    x: 54,
    y: 775,
    size: 10,
    font: bold,
    color: blue,
  });
  page.drawText('Make it your own.', { x: 54, y: 710, size: 34, font: bold, color: ink });
  page.drawText('A little less paperwork. A little more possibility.', {
    x: 54,
    y: 678,
    size: 13,
    font,
    color: gray,
  });
  page.drawLine({
    start: { x: 54, y: 647 },
    end: { x: 541, y: 647 },
    color: rgb(0.83, 0.84, 0.86),
    thickness: 1,
  });
  const sections = [
    [
      '01',
      'Mark what matters',
      'Choose Highlight and drag across this sentence.\nAdd a note with Text, or sketch an idea with Draw.',
    ],
    [
      '02',
      'Get your pages in order',
      'Rotate a page, move it, or bring another PDF into the file.\nUndo is always there while you work.',
    ],
    [
      '03',
      'Take your work with you',
      'Download a PDF to your device, or save a copy to Puter.\nYour files stay in your own cloud.',
    ],
  ];
  sections.forEach(([n, title, body], i) => {
    const y = 602 - i * 116;
    page.drawText(n, { x: 54, y, size: 11, font: bold, color: blue });
    page.drawText(title, { x: 90, y, size: 17, font: bold, color: ink });
    page.drawText(body, { x: 90, y: y - 28, size: 11, font, color: gray, lineHeight: 19 });
  });
  page.drawRectangle({ x: 54, y: 124, width: 487, height: 100, color: rgb(0.96, 0.96, 0.95) });
  page.drawText('TRY A FILLABLE FORM', { x: 72, y: 199, size: 9, font: bold, color: gray });
  page.drawText('Your name', { x: 72, y: 172, size: 11, font, color: ink });
  doc
    .getForm()
    .createTextField('Your name')
    .addToPage(page, {
      x: 170,
      y: 155,
      width: 250,
      height: 28,
      borderWidth: 1,
      borderColor: rgb(0.7, 0.7, 0.7),
    });
  page.drawText('Click the field to type, or choose Fill forms.', {
    x: 72,
    y: 137,
    size: 9,
    font,
    color: gray,
  });
  page.drawText('A space for your documents.', { x: 54, y: 52, size: 10, font, color: gray });
  page.drawText('1', { x: 532, y: 52, size: 10, font, color: gray });
  return doc.save();
}
function fieldValue(field) {
  if (field instanceof PDFTextField) return textValue(field);
  const acro = field.acroField;
  if (field instanceof PDFRadioGroup) {
    const selected = buttonFieldValue(field);
    const value = selected?.decodeText?.();
    if (value == null || value === 'Off') return undefined;
    const index = acro
      .getWidgets()
      .findIndex(
        selected instanceof PDFName
          ? (widget) => widget.getOnValue() === selected
          : (widget) => widget.getOnValue()?.decodeText() === value,
      );
    return index >= 0 ? (radioExportValue(radioExports(field), index) ?? value) : value;
  }
  if (acro.V() !== undefined) {
    if (field instanceof PDFCheckBox) return field.isChecked();
    return field.getSelected();
  }
  const value = defaultFieldValue(field);
  if (field instanceof PDFCheckBox)
    return typeof value === 'string' && value === acro.getOnValue()?.decodeText();
  return Array.isArray(value) ? value : value == null ? [] : [value];
}
function radioExports(field) {
  const acro = field.acroField;
  return acro.dict.context.lookup(acro.getInheritableAttribute(PDFName.of('Opt')));
}
function radioExportValue(opt, index) {
  const exported = opt instanceof PDFArray ? opt.lookup(index) : index === 0 ? opt : undefined;
  return exported instanceof PDFString || exported instanceof PDFHexString
    ? exported.decodeText()
    : undefined;
}
/** Keep each radio's export paired with its widget, even when appearances or exports are missing. */
function radioWidgetOptions(field) {
  const opt = radioExports(field);
  return field.acroField.getWidgets().map((widget, index) => {
    const on = widget.getOnValue();
    const value = radioExportValue(opt, index) ?? on?.decodeText();
    return { on, value };
  });
}
const RADIOS_IN_UNISON = 1 << 25;
/** Separates a shared export value from the appearance state that tells its buttons apart. */
const CHOICE_STATE = '\uE000';
const pdfjsId = (ref) =>
  ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`;
/**
 * Radio buttons that share an export value but switch on one at a time (no RadiosInUnison,
 * each with its own appearance state). Viewers report such a choice by its export value
 * alone, so each of these buttons gets a choice naming its state too, which fillFields
 * accepts. Returns, by field name: each widget's choice by PDF.js annotation id, and the
 * choice that is on.
 */
export function radioButtonChoices(doc) {
  const result = new Map();
  for (const field of formFields(doc) || []) {
    if (!(field instanceof PDFRadioGroup) || field.acroField.getFlags() & RADIOS_IN_UNISON)
      continue;
    // A group whose widgets cannot be read keeps being chosen by export value.
    try {
      const options = radioWidgetOptions(field);
      const states = new Map();
      for (const { on, value } of options)
        if (on) states.set(value, new Set(states.get(value)).add(on));
      if (![...states.values()].some((set) => set.size > 1)) continue;
      const choiceOf = ({ on, value }) =>
        states.get(value).size > 1 ? `${value}${CHOICE_STATE}${on.decodeText()}` : value;
      const acro = field.acroField;
      const kids = acro.dict.lookup(PDFName.of('Kids'));
      const refs = kids instanceof PDFArray ? kids.asArray() : [];
      const choices = new Map();
      acro.getWidgets().forEach((widget, index) => {
        if (!options[index].on) return;
        const ref = refs.find((kid) => acro.dict.context.lookup(kid) === widget.dict) ?? field.ref;
        if (ref instanceof PDFRef) choices.set(pdfjsId(ref), choiceOf(options[index]));
      });
      const state = buttonFieldValue(field);
      const selected = options.find(({ on }) => on && on === state);
      result.set(formFieldName(field), { choices, selected: selected ? choiceOf(selected) : null });
    } catch {
      continue;
    }
  }
  return result;
}
function radioFieldOptions(field, widgets = field.acroField.getWidgets()) {
  const opt = radioExports(field);
  return widgets
    .map((widget, index) =>
      widget ? (radioExportValue(opt, index) ?? widget.getOnValue()?.decodeText()) : undefined,
    )
    .filter((value) => value != null);
}
/** Localize inherited options only when an edit needs pdf-lib's radio mutation methods. */
function ownRadioOptions(field) {
  const acro = field.acroField;
  const key = PDFName.of('Opt');
  if (acro.dict.has(key)) return;
  const inherited = acro.dict.context.lookup(acro.getInheritableAttribute(key));
  if (inherited instanceof PDFArray) acro.dict.set(key, inherited.clone());
  else if (inherited instanceof PDFString || inherited instanceof PDFHexString)
    acro.dict.set(key, inherited);
}
/** Each widget's appearance name and its corresponding (possibly inherited) export value. */
function checkBoxOptions(field) {
  const acro = field.acroField;
  const exports = acro.dict.context.lookup(acro.getInheritableAttribute(PDFName.of('Opt')));
  return acro.getWidgets().map((widget, index) => {
    const state = widget.getOnValue()?.decodeText?.() ?? null;
    // Keep the widget index even when an Opt entry is missing or malformed.
    const exported = exports instanceof PDFArray ? exports.lookup(index) : undefined;
    const value =
      exported instanceof PDFString || exported instanceof PDFHexString
        ? exported.decodeText()
        : state;
    return { state, value };
  });
}
const isCheckBoxGroup = (options) =>
  new Set(options.map(({ state }) => state).filter((state) => state !== null)).size > 1;
/** Match the default selection shown by viewers when no current value is present. */
function buttonFieldValue(field) {
  const acro = field.acroField;
  return acro.V() === undefined
    ? acro.dict.context.lookup(acro.getInheritableAttribute(PDFName.of('DV')))
    : acro.getValue();
}
function buttonFieldState(field) {
  return buttonFieldValue(field)?.decodeText?.();
}
/** The export value a checkbox group has on, as a list of at most one. */
function checkBoxSelection(field, options) {
  const state = buttonFieldState(field);
  return state != null && state !== 'Off'
    ? [options.find((option) => option.state === state)?.value ?? state]
    : [];
}
/** Resolve exports that a viewer cannot distinguish from the reserved unselected state. */
export function formButtonSelections(doc, names) {
  const selections = new Map();
  for (const field of formFields(doc) || []) {
    if (!(field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) continue;
    const name = formFieldName(field);
    if (!names.has(name) || selections.has(name)) continue;
    if (field instanceof PDFCheckBox)
      selections.set(name, checkBoxSelection(field, checkBoxOptions(field)));
    else {
      const value = fieldValue(field);
      selections.set(name, value == null ? [] : [value]);
    }
  }
  return selections;
}
/** Field tooltips (TU) by name. PDF.js reads a tooltip from a widget, not from its field. */
export function formFieldTooltips(doc) {
  const tooltips = new Map();
  for (const field of formFields(doc) || []) {
    const name = formFieldName(field);
    const tooltip = fieldTooltip(field);
    if (!tooltips.has(name) && tooltip) tooltips.set(name, tooltip);
  }
  return tooltips;
}
function fieldTooltip(field) {
  const tooltip = field.acroField.dict.lookup(PDFName.of('TU'));
  return tooltip instanceof PDFString || tooltip instanceof PDFHexString
    ? tooltip.decodeText().trim()
    : '';
}
/**
 * The selections of lists whose options share export values, by field name, as keys
 * (choiceKeys): PDF.js reports the values, while /I tells which of those options is chosen.
 */
export function sharedChoiceSelections(doc) {
  const result = new Map();
  for (const field of formFields(doc) || []) {
    if (!(field instanceof PDFDropdown || field instanceof PDFOptionList)) continue;
    // A list whose options cannot be read keeps being chosen by export value.
    try {
      const options = choiceOptions(field);
      if (new Set(options.map(({ value }) => value)).size === options.length) continue;
      result.set(
        formFieldName(field),
        selectedChoices(field, options).map(({ key }) => key),
      );
    } catch {
      continue;
    }
  }
  return result;
}
/** A list's options keyed for selection (choiceKeys), and typed values that are not options. */
function choiceSelections(field) {
  const options = choiceOptions(field);
  const keys = choiceKeys(options);
  const choices = options.map(({ label }, index) => ({ value: keys[index], label }));
  for (const { key, index } of selectedChoices(field, options))
    if (index < 0 && !choices.some((option) => option.value === key))
      choices.push({ value: key, label: key });
  return choices;
}
/** Match viewer names: an unnamed ancestor contributes no part, while an empty name does. */
function formFieldName(field) {
  const parts = [];
  let dict = field.acroField.dict;
  while (dict instanceof PDFDict) {
    const name = dict.lookup(PDFName.of('T'));
    if (name instanceof PDFString || name instanceof PDFHexString) parts.push(name.decodeText());
    dict = dict.lookup(PDFName.of('Parent'));
  }
  return parts.reverse().join('.');
}
export function listFields(doc) {
  const fields = formFields(doc);
  if (!fields) throw new Error(DAMAGED_FORM);
  return fields.map((field) => {
    const tooltip = fieldTooltip(field);
    const base = {
      name: formFieldName(field),
      readOnly: field.isReadOnly(),
      ...(field.isRequired() ? { required: true } : {}),
      ...(tooltip ? { tooltip } : {}),
    };
    if (field instanceof PDFTextField) {
      const flags = field.acroField.getFlags();
      return {
        ...base,
        type: 'text',
        value: fieldValue(field),
        maxLength: textMaxLength(field)?.asNumber(),
        multiline: !!(flags & AcroTextFlags.Multiline),
        password: !!(flags & AcroTextFlags.Password),
        spellcheck: !(flags & (AcroTextFlags.DoNotSpellCheck | AcroTextFlags.Password)),
      };
    }
    if (field instanceof PDFCheckBox) {
      // A checkbox group offers its widgets' export values as one choice.
      const options = checkBoxOptions(field);
      if (isCheckBoxGroup(options))
        return {
          ...base,
          type: 'select',
          options: [
            ...new Set(options.filter(({ state }) => state !== null).map(({ value }) => value)),
          ],
          value: checkBoxSelection(field, options),
          multiple: false,
        };
      return { ...base, type: 'checkbox', value: fieldValue(field) };
    }
    if (
      field instanceof PDFDropdown ||
      field instanceof PDFOptionList ||
      field instanceof PDFRadioGroup
    ) {
      const choices = field instanceof PDFRadioGroup ? undefined : choiceSelections(field);
      const multiple =
        (field instanceof PDFOptionList || field instanceof PDFDropdown) && field.isMultiselect();
      return {
        ...base,
        type: 'select',
        options:
          field instanceof PDFRadioGroup
            ? // Buttons that share an export value are one choice.
              [...new Set(radioFieldOptions(field))]
            : choices.map((option) => option.value),
        choices,
        value:
          field instanceof PDFRadioGroup
            ? fieldValue(field)
            : selectedChoices(field).map(({ key }) => key),
        multiple,
        editableChoice: field instanceof PDFDropdown && !multiple && field.isEditable(),
        spellcheck: field instanceof PDFDropdown && field.isSpellChecked(),
      };
    }
    return { ...base, type: 'unsupported' };
  });
}
/** A field's value as a calculation reads it: its text, choice, or export value. */
function calculationInput(field) {
  if (field instanceof PDFTextField) return textValue(field);
  if (field instanceof PDFDropdown || field instanceof PDFOptionList)
    return choiceValues(field)[0] ?? '';
  if (field instanceof PDFRadioGroup) return fieldValue(field) ?? '';
  if (field instanceof PDFCheckBox)
    return checkBoxSelection(field, checkBoxOptions(field))[0] ?? '';
  return '';
}
const CALCULATIONS = {
  SUM: (numbers) => numbers.reduce((a, b) => a + b, 0),
  PRD: (numbers) => numbers.reduce((a, b) => a * b, 1),
  AVG: (numbers) => numbers.reduce((a, b) => a + b, 0) / numbers.length,
  MIN: (numbers) => Math.min(...numbers),
  MAX: (numbers) => Math.max(...numbers),
};
/**
 * Work out the form's own simple calculations (sums, products, averages, minimums, and
 * maximums of other fields) in its calculation order, as Acrobat does after a value changes.
 * Returns the fields whose values changed.
 */
function recalculate(doc, fields) {
  const order = doc.getForm().acroForm.dict.lookup(PDFName.of('CO'));
  if (!(order instanceof PDFArray)) return [];
  const names = new Map(fields.map((field) => [field, formFieldName(field)]));
  const changed = [];
  for (const entry of order.asArray()) {
    const target = doc.context.lookup(entry);
    const field = fields.find((f) => f.ref === entry || f.acroField.dict === target);
    if (!(field instanceof PDFTextField)) continue;
    try {
      const calculation = simpleCalculation(field);
      if (!calculation) continue;
      const sources = fields.filter((other) =>
        calculation.names.some(
          (name) =>
            other !== field &&
            (names.get(other) === name || names.get(other).startsWith(`${name}.`)),
        ),
      );
      if (!sources.length) continue;
      // A value that is not a number counts as zero, as in Acrobat.
      const numbers = sources.map((source) => typedNumber(calculationInput(source)) ?? 0);
      const value = String(CALCULATIONS[calculation.operation](numbers));
      if (textValue(field) === value) continue;
      prepareFieldAppearance(field, doc.getForm());
      field.setText(value);
      changed.push(field);
    } catch {
      // A calculation that cannot be worked out leaves its field as it is.
    }
  }
  return changed;
}
export async function fillFields(doc, values) {
  const fields = formFields(doc);
  if (!fields) throw new Error(DAMAGED_FORM);
  const form = doc.getForm();
  const byName = new Map();
  for (const field of fields) {
    const name = formFieldName(field);
    if (!byName.has(name)) byName.set(name, field);
  }
  let changed = false;
  const changedText = new Map();
  const changedChoices = [];
  const changedFields = [];
  for (const [name, value] of Object.entries(values)) {
    const field = byName.get(name);
    if (!field) throw new NoSuchFieldError(name);
    if (field.isReadOnly()) continue;
    const checkBoxes = field instanceof PDFCheckBox ? checkBoxOptions(field) : null;
    if (field instanceof PDFTextField) {
      if (fieldValue(field) === value) continue;
      // A number or percent field takes a number, as its keystroke check in Acrobat allows.
      if (String(value).trim() && numberFormat(field) && typedNumber(value) === null)
        throw new Error(`Enter a number in ${fieldTooltip(field) || name}, such as 1234.5.`);
      prepareFieldAppearance(field, form);
      field.setText(value);
      // An explicit empty value overrides inherited/default values; deleting /V does not.
      if (value === '') field.acroField.setValue(PDFHexString.fromText(''));
      // A rich-text field also carries its value as RV, which viewers show in preference; a
      // stale one would keep the old words. The plain value is now the whole value.
      field.acroField.dict.delete(PDFName.of('RV'));
      changedText.set(field, value);
    } else if (checkBoxes && isCheckBoxGroup(checkBoxes)) {
      // pdf-lib's check() only knows the first widget's on state. Translate the chosen
      // export value back to its appearance name for /V and each widget's /AS.
      const next = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      if (next.length > 1) throw new Error('This form field accepts one selection.');
      const option =
        next.length && checkBoxes.find(({ state, value }) => state !== null && value === next[0]);
      if (next.length && !option) throw new Error('Choose one of the available form options.');
      const previous = checkBoxSelection(field, checkBoxes);
      if (previous.length === next.length && previous[0] === next[0]) continue;
      const wanted = option ? option.state : null;
      field.acroField.dict.set(PDFName.of('V'), PDFName.of(wanted ?? 'Off'));
      field.acroField
        .getWidgets()
        .forEach((widget, i) =>
          widget.setAppearanceState(
            PDFName.of(wanted !== null && checkBoxes[i].state === wanted ? wanted : 'Off'),
          ),
        );
    } else if (field instanceof PDFCheckBox) {
      const checked = Array.isArray(value) ? value.length > 0 : !!value;
      if (fieldValue(field) === checked) continue;
      checked ? field.check() : field.uncheck();
    } else if (
      field instanceof PDFDropdown ||
      field instanceof PDFOptionList ||
      field instanceof PDFRadioGroup
    ) {
      const selected =
        field instanceof PDFRadioGroup
          ? fieldValue(field)
          : selectedChoices(field).map(({ key }) => key);
      const previous = Array.isArray(selected) ? selected : selected == null ? [] : [selected];
      const next = Array.isArray(value) ? value : value ? [value] : [];
      if (previous.length === next.length && previous.every((option) => next.includes(option)))
        continue;
      if (field instanceof PDFRadioGroup) {
        if (next.length) {
          const options = radioWidgetOptions(field);
          // A button sharing its export value with others is chosen by its state as well.
          const [wanted, state] = String(next[0]).split(CHOICE_STATE);
          const option = options.findLast(
            (option) =>
              option.on &&
              option.value === wanted &&
              (state === undefined || option.on.decodeText() === state),
          );
          if (!option) {
            if (options.some((option) => option.value === wanted))
              throw new Error('This option is unavailable in this PDF. Choose another option.');
            throw new Error('Choose one of the available form options.');
          }
          ownRadioOptions(field);
          field.acroField.setValue(option.on);
          // Buttons in unison that share the export value switch on together, whatever their states.
          if (field.acroField.getFlags() & RADIOS_IN_UNISON)
            field.acroField.getWidgets().forEach((widget, index) => {
              const { on, value } = options[index];
              if (on && value === wanted) widget.setAppearanceState(on);
            });
          field.markAsDirty();
        } else field.clear();
      } else {
        const options = choiceOptions(field);
        // Options sharing an export value are chosen by position (choiceKeys).
        const chosen = readChoiceKeys(next, options);
        const custom = chosen.filter(({ index }) => index < 0);
        if (custom.length && (!(field instanceof PDFDropdown) || !field.isEditable()))
          throw new Error('Choose one of the available form options.');
        if (next.length > 1 && !field.isMultiselect())
          throw new Error('This form field accepts one selection.');
        // pdf-lib's select()/index helpers compare display labels, but PDF /V contains exports.
        const values = chosen.map(({ value }) => PDFHexString.fromText(value));
        const dict = field.acroField.dict;
        if (!values.length) dict.set(PDFName.of('V'), doc.context.obj([]));
        else dict.set(PDFName.of('V'), values.length === 1 ? values[0] : doc.context.obj(values));
        const indices = chosen.map(({ index }) => index);
        // /I is needed for several selections, and to tell apart options that share a value.
        const shared = chosen.some(
          ({ value }) => options.filter((option) => option.value === value).length > 1,
        );
        if ((indices.length > 1 || shared) && indices.every((index) => index >= 0))
          dict.set(PDFName.of('I'), doc.context.obj(indices.sort((a, b) => a - b)));
        else dict.delete(PDFName.of('I'));
        // The previous list scroll position may hide the newly chosen option.
        // Regeneration will keep the new selection visible and record its top row.
        if (field instanceof PDFOptionList && next.length) dict.delete(PDFName.of('TI'));
        field.markAsDirty();
        const labels =
          field instanceof PDFOptionList
            ? options.map((option) => option.label)
            : chosen.map(({ value, index }) => options[index]?.label ?? value);
        changedText.set(field, labels.join('\n'));
        changedChoices.push({ field, labels, options });
      }
    } else continue;
    if (field instanceof PDFDropdown || field instanceof PDFOptionList)
      prepareFieldAppearance(field, form);
    changed = true;
    changedFields.push(field);
  }
  if (!changed) return false;
  for (const field of recalculate(doc, fields)) {
    if (changedFields.includes(field)) continue;
    changedFields.push(field);
    changedText.set(field, textValue(field));
  }
  // Each field is drawn with the bundled face its own text needs, such as the Korean one.
  const fonts = new Map();
  for (const field of changedFields) {
    const text = changedText.get(field) ?? '';
    const font = await embedFont(doc, 'regular', text);
    assertSupportedText(font, text);
    fonts.set(field, font);
  }
  for (const { field, labels, options } of changedChoices) {
    const provider = choiceAppearanceProvider(field, options, labels);
    updateFieldAppearance(field, form, fonts.get(field), provider);
  }
  for (const field of changedFields)
    if (field.needsAppearancesUpdate()) updateFieldAppearance(field, form, fonts.get(field));
}
