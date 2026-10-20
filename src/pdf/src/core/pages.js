import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import { inheritPdfVersion, savePdf } from './version.js';
import { MAX_PAGES, validatePdf } from './document.js';
import { flattenFields, requireFlattenedPages } from './flatten.js';
import { copyPagesWithLayers } from './optional-content.js';
import { mapPageDestinations } from './page-actions.js';

/**
 * Parse a print-style page list such as "1-3, 5" into zero-based indices for a PDF with
 * `count` pages. Descending ranges keep their order, as they do in print dialogs.
 */
export function parsePageRange(text, count) {
  const tokens = String(text ?? '')
    .split(/[,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) throw new Error('Enter the pages to include, like 1-3, 5.');
  const indices = [];
  for (const token of tokens) {
    const match = /^(\d+)(?:\s*[-–—]\s*(\d+))?$/.exec(token);
    if (!match) throw new Error('Enter the pages to include, like 1-3, 5.');
    const from = Number(match[1]),
      to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to < 1 || from > count || to > count)
      throw new Error(`Pages must be between 1 and ${count}.`);
    const step = to >= from ? 1 : -1;
    for (let page = from; page !== to + step; page += step) indices.push(page - 1);
  }
  return indices;
}

/** Describe zero-based indices the way people write them: "1-3, 5". */
export function formatPageRange(indices) {
  const parts = [];
  for (let i = 0; i < indices.length; i++) {
    let end = i;
    while (end + 1 < indices.length && indices[end + 1] === indices[end] + 1) end++;
    parts.push(end > i ? `${indices[i] + 1}-${indices[end] + 1}` : String(indices[i] + 1));
    i = end;
  }
  return parts.join(', ');
}

function requireExtractionCount(indices) {
  if (!indices?.length) throw new Error('Choose at least one page to extract.');
  if (indices.length > MAX_PAGES) throw new Error('The extracted PDF would exceed 1,000 pages.');
}

/**
 * Build a new PDF from the given pages of `bytes`, in the given order. Copying only the pages
 * leaves behind everything the source kept for other pages, so the result is as small as its
 * pages. Form fields become fixed page content, as they do when a PDF is merged in.
 */
export async function extractPages(bytes, indices) {
  requireExtractionCount(indices);
  return copyPagesFrom(await openSource(bytes), indices);
}

/**
 * Load a PDF for extraction and flatten its form once, so several extractions from the same
 * file (a split) share the parsing and flattening instead of repeating them per part.
 */
export async function openSource(bytes) {
  const source = await validatePdf(bytes);
  try {
    flattenFields(source);
  } catch {
    // The selected pages are checked before copying so remaining widgets cannot be orphaned.
  }
  return source;
}

const isString = (value) => value instanceof PDFString || value instanceof PDFHexString;
/**
 * Destination names are byte strings (ISO 32000-1, 12.3.2.3), not text strings. Compare their
 * decoded bytes so literal escapes and hex syntax match, while distinct text encodings and
 * leading slashes stay distinct. Binary strings also keep the name tree's byte ordering.
 */
const destKeyBytes = (value) =>
  value instanceof PDFName || isString(value)
    ? Array.from(value.asBytes(), (byte) => String.fromCharCode(byte)).join('')
    : null;
/** Look a named destination up in a name tree node, returning its value or undefined. */
function searchNameTree(context, node, key) {
  const pending = [node];
  const seen = new Set();
  while (pending.length) {
    const current = context.lookup(pending.pop());
    if (!(current instanceof PDFDict) || seen.has(current)) continue;
    seen.add(current);
    const limits = current === node ? null : current.lookup(PDFName.of('Limits'));
    if (limits instanceof PDFArray && limits.size() === 2) {
      const lo = destKeyBytes(context.lookup(limits.get(0))),
        hi = destKeyBytes(context.lookup(limits.get(1)));
      if (lo != null && hi != null && (key < lo || key > hi)) continue;
    }
    const names = current.lookup(PDFName.of('Names'));
    if (names instanceof PDFArray)
      for (let i = 0; i + 1 < names.size(); i += 2)
        if (destKeyBytes(context.lookup(names.get(i))) === key)
          return context.lookup(names.get(i + 1));
    const kids = current.lookup(PDFName.of('Kids'));
    // Reverse the stack entries to retain tree order, without recursion on untrusted depth.
    if (kids instanceof PDFArray)
      for (let i = kids.size() - 1; i >= 0; i--) pending.push(kids.get(i));
  }
  return undefined;
}
/**
 * Resolve a named destination in `source`, from the old catalog /Dests dictionary or the
 * /Names /Dests name tree, searched by the name's bytes so a file that keys one the way the
 * other expects still resolves.
 */
function resolveNamedDest(source, name) {
  const key = destKeyBytes(name);
  if (key == null) return undefined;
  const { context, catalog } = source;
  const dests = context.lookup(catalog.get(PDFName.of('Dests')));
  if (dests instanceof PDFDict)
    for (const [entryKey, value] of dests.entries())
      if (destKeyBytes(entryKey) === key) return context.lookup(value);
  const names = context.lookup(catalog.get(PDFName.of('Names')));
  const tree = names instanceof PDFDict ? context.lookup(names.get(PDFName.of('Dests'))) : null;
  return tree instanceof PDFDict ? searchNameTree(context, tree, key) : undefined;
}
/** The explicit page-destination array behind a dest value ([pageRef ...] or { D: [...] }). */
function explicitDest(source, dest) {
  let value = dest instanceof PDFRef ? source.context.lookup(dest) : dest;
  if (value instanceof PDFName || isString(value)) value = resolveNamedDest(source, value);
  if (value instanceof PDFDict) value = source.context.lookup(value.get(PDFName.of('D')));
  return value instanceof PDFArray ? value : null;
}
/**
 * Turn page links and action destinations into explicit page references before copying
 * (copyPages does not carry the name tree). Mutates the source parsed for extraction.
 */
export function inlineNamedDests(source, pageIndices) {
  const sourcePages = source.getPages();
  const numeric = new Map();
  mapPageDestinations(
    source,
    pageIndices.map((index) => sourcePages[index]),
    (container, destKey) => {
      const dest = container.get(destKey);
      if (dest === undefined) return;
      const explicit = explicitDest(source, dest);
      const first = explicit?.get(0);
      const target = first instanceof PDFNumber ? sourcePages[first.asNumber()] : null;
      // A nonexistent source page must not become an unrelated page in the destination PDF.
      if (first instanceof PDFNumber && !target) return false;
      if (target) {
        // Clone so a shared remote GoToR/GoToE array keeps its page number.
        if (!numeric.has(explicit)) {
          const copy = explicit.clone(source.context);
          copy.set(0, target.ref);
          numeric.set(explicit, copy);
        }
        container.set(destKey, numeric.get(explicit));
      } else if (explicit && !(source.context.lookup(dest) instanceof PDFArray)) {
        container.set(destKey, explicit);
      }
    },
  );
}
/** Drop every indirect object nothing reachable from the trailer refers to (orphan sweep). */
function sweepOrphans(context) {
  const live = new Set();
  const pending = [
    context.trailerInfo.Root,
    context.trailerInfo.Info,
    context.trailerInfo.ID,
    context.pushGraphicsStateContentStreamRef,
    context.popGraphicsStateContentStreamRef,
  ].filter(Boolean);
  while (pending.length) {
    const value = pending.pop();
    if (value instanceof PDFRef) {
      if (live.has(value)) continue;
      live.add(value);
      const target = context.lookup(value);
      if (target) pending.push(target);
    } else if (value instanceof PDFStream) pending.push(value.dict);
    else if (value instanceof PDFDict) for (const [, v] of value.entries()) pending.push(v);
    else if (value instanceof PDFArray) for (const v of value.asArray()) pending.push(v);
  }
  for (const [ref] of context.enumerateIndirectObjects()) if (!live.has(ref)) context.delete(ref);
}
/** A key marking each source page with its index, copied into every copy the copier makes. */
export const COPY_INDEX = PDFName.of('PuterCopyPageIndex');
/**
 * Make `copier` copy a small stand-in wherever a copied object names a page of `source` (a
 * link's target, an annotation's page). Following the reference would copy that page with all
 * its content, and every page it links to in turn (a contents page reaches the whole document),
 * only for relinkCopiedPages to sweep the copies away again. A stand-in carries the page's
 * COPY_INDEX just as such a copy would, and is made only for pages actually named.
 */
export function copyPageStandIns(copier, source, target) {
  const indices = new Map(source.getPages().map((page, index) => [page.ref, index]));
  const copyReference = copier.copyPDFIndirectObject;
  copier.copyPDFIndirectObject = (ref) => {
    const index = indices.get(ref);
    if (index !== undefined && !copier.traversedObjects.has(ref))
      copier.traversedObjects.set(
        ref,
        target.context.register(target.context.obj({ [COPY_INDEX.decodeText()]: index })),
      );
    return copyReference(ref);
  };
}
/**
 * The copier shares annotation objects when the same source page is selected more than once.
 * Each page must own its annotation dictionaries (ISO 32000-1, 12.5.2), including the popup
 * and reply relationships between them. Keep subsidiary resources shared, as the standard
 * permits, so independent comments do not require copying large images or appearances.
 */
function separatePageAnnotations(doc, pages) {
  const { context } = doc;
  const seenArrays = new Set();
  const seenAnnotations = new Set();
  for (const page of pages) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    const entries = annots.asArray().map((ref) => context.lookup(ref));
    const shared = entries.some((entry) => seenAnnotations.has(entry));
    if (seenArrays.has(annots) || shared) {
      const own = annots.clone(context);
      page.node.set(PDFName.of('Annots'), own);
      if (shared) {
        const copies = new Map();
        for (const entry of entries)
          if (entry instanceof PDFDict && !copies.has(entry))
            copies.set(entry, context.register(entry.clone(context)));
        for (let i = 0; i < entries.length; i++)
          if (copies.has(entries[i])) own.set(i, copies.get(entries[i]));
        for (const ref of copies.values()) {
          const copy = context.lookup(ref);
          for (const key of ['Popup', 'Parent', 'IRT']) {
            const name = PDFName.of(key);
            const related = copies.get(context.lookup(copy.get(name)));
            if (related) copy.set(name, related);
          }
        }
      }
    }
    seenArrays.add(annots);
    for (const entry of entries) if (entry instanceof PDFDict) seenAnnotations.add(entry);
  }
}
/**
 * After pages are copied into `doc`, remap their destinations to the pages in the page tree,
 * drop jumps whose target page was not copied, set each annotation's page, and remove the
 * orphan page copies pdf-lib's copier dragged in. The copier makes a fresh copy of a linked
 * page for each place that references it, so a link points at an orphan copy that is not in the
 * page tree; `indexToRef` maps a source page index (read from the COPY_INDEX marker the copies
 * carry) to the page that actually joined the tree.
 */
export function relinkCopiedPages(doc, pages, indexToRef) {
  separatePageAnnotations(doc, pages);
  const targetIndex = (ref) => {
    const node = doc.context.lookup(ref);
    const marker = node instanceof PDFDict ? node.get(COPY_INDEX) : null;
    return marker instanceof PDFNumber ? marker.asNumber() : null;
  };
  const remap = (dest) => {
    // Resolvable source names were already inlined. A remaining name must not bind to
    // an unrelated destination in the receiving document's catalog.
    if (dest instanceof PDFName || dest instanceof PDFString || dest instanceof PDFHexString)
      return false;
    if (!(dest instanceof PDFArray) || dest.size() === 0) return true;
    const first = dest.get(0);
    if (!(first instanceof PDFRef)) return true;
    const index = targetIndex(first);
    const to = index == null ? undefined : indexToRef.get(index);
    if (to) {
      dest.set(0, to);
      return true;
    }
    return false;
  };
  for (const page of pages) {
    // The copy's structure tree stays behind, and these keys would name unrelated elements
    // of this document's tree (alternate text read out for the wrong content). The copied
    // page reads as untagged instead.
    page.node.delete(PDFName.of('StructParents'));
    // Article threads (ISO 32000-1, 12.4.3) stay behind too. The copy's beads would run on
    // to pages that were not copied, keeping the copier's stand-ins for them in the file.
    page.node.delete(PDFName.of('B'));
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (const ref of annots.asArray()) {
      const annot = doc.context.lookup(ref);
      if (!(annot instanceof PDFDict)) continue;
      if (annot.has(PDFName.of('P'))) annot.set(PDFName.of('P'), page.ref);
      annot.delete(PDFName.of('StructParent'));
    }
  }
  mapPageDestinations(doc, pages, (container, key) => remap(container.lookup(key)));
  // The marker was only needed to match copies to pages; the copied pages keep none of it.
  for (const page of pages) page.node.delete(COPY_INDEX);
  sweepOrphans(doc.context);
}

/**
 * A new PDF holding the given pages of an opened source, in the given order.
 * A split can pass a details snapshot so its XMP packet is read only once for all parts.
 */
export async function copyPagesFrom(source, indices, details) {
  requireExtractionCount(indices);
  const count = source.getPageCount();
  if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= count))
    throw new Error(`Pages must be between 1 and ${count}.`);
  requireFlattenedPages(source, indices);
  const out = await PDFDocument.create();
  if (details === undefined && source.catalog.has(PDFName.of('Metadata')))
    details = (await import('./details.js')).documentDetails(source);
  // Carry the source's authoritative descriptive fields. The new document has its own
  // creation facts; keywords remain one exact string, and malformed Info values are skipped.
  for (const key of ['Title', 'Author', 'Subject', 'Keywords']) {
    let value;
    try {
      value = details ? details[key.toLowerCase()] : source[`get${key}`]();
    } catch {
      continue;
    }
    if (value) out.getInfoDict().set(PDFName.of(key), PDFHexString.fromText(String(value)));
  }
  // Make named destinations explicit before copying, then fix up the copied links and drop the
  // orphan page copies the copier pulls in for their targets. Each source page is marked with
  // its index so a copied link's target can be matched to the page that joined the tree.
  inlineNamedDests(source, indices);
  const sourcePages = source.getPages();
  sourcePages.forEach((page, index) => page.node.set(COPY_INDEX, PDFNumber.of(index)));
  try {
    const pages = await copyPagesWithLayers(out, source, indices, (copier) =>
      copyPageStandIns(copier, source, out),
    );
    pages.forEach((page) => out.addPage(page));
    const indexToRef = new Map(indices.map((index, position) => [index, pages[position].ref]));
    relinkCopiedPages(out, pages, indexToRef);
  } finally {
    sourcePages.forEach((page) => page.node.delete(COPY_INDEX));
  }
  inheritPdfVersion(out, source);
  return savePdf(out);
}
