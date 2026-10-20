import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';

const name = PDFName.of;
const DEST = name('Dest'),
  S = name('S'),
  GOTO = name('GoTo'),
  D = name('D');
/**
 * Page content, appearances, metadata, and the tag tree hold no destinations, and in a long
 * document they are most of its objects. Walking them made every page edit slow down with the
 * length of the document.
 */
const INERT = new Set(
  ['Resources', 'Contents', 'AP', 'Metadata', 'Thumb', 'StructTreeRoot'].map(name),
);

/**
 * Keep navigation useful when pages are deleted: jumps to one fit the next page that stays, or
 * the previous one when no page after it stays. Surviving destinations keep their view settings.
 * Run before removal, while numeric destinations still refer to the original page order.
 * Several pages are handled in one search, so deleting many pages does not repeat it per page.
 */
export function retargetDeletedPages(doc, indices) {
  const pages = doc.getPages();
  const removed = new Set(indices);
  const replacements = new Map();
  let kept = null;
  for (let i = pages.length - 1; i >= 0; i--)
    if (!removed.has(i)) kept = pages[i];
    else if (kept) replacements.set(pages[i], kept);
  kept = null;
  for (let i = 0; i < pages.length; i++)
    if (!removed.has(i)) kept = pages[i];
    else if (kept && !replacements.has(pages[i])) replacements.set(pages[i], kept);
  if (!replacements.size) return;
  const replacementOf = new Map();
  for (const [page, replacement] of replacements) {
    replacementOf.set(page.ref, replacement);
    replacementOf.set(page.node, replacement);
  }
  const repaired = new Map();
  visitLocalDestinations(doc, (dest, replace) => {
    if (repaired.has(dest)) {
      const copy = repaired.get(dest);
      if (copy) replace(copy);
      return;
    }
    const first = dest.get(0);
    // Local integer destinations occur in legacy PDFs. Freeze their original page identity;
    // remote GoToR/GoToE destinations are never passed here and keep their page numbers.
    const page = first instanceof PDFNumber ? pages[first.asNumber()] : null;
    const target = page?.ref ?? first;
    if (page) {
      // Remote destinations use numbers and may share this array. Give local entries
      // their own array before changing its page identity or replacing the deleted target.
      const original = dest;
      dest = dest.clone(doc.context);
      const copy = doc.context.register(dest);
      repaired.set(original, copy);
      replace(copy);
    } else repaired.set(dest, null);
    const replacement = replacementOf.get(target);
    if (replacement) {
      while (dest.size()) dest.remove(dest.size() - 1);
      dest.push(replacement.ref);
      dest.push(name('Fit'));
    } else if (page) dest.set(0, page.ref);
  });
}

/** Freeze legacy page numbers before insertion or reordering changes what they mean. */
export function stabilizeLocalDestinations(doc) {
  const pages = doc.getPages();
  // Most documents have no navigation to repair. Check the standard action/destination
  // containers first so moving a plain page does not scan its fonts, images or content.
  const catalogNavigation = ['Dests', 'Names', 'Outlines', 'OpenAction', 'AA', 'AcroForm'];
  if (
    !catalogNavigation.some((key) => doc.catalog.has(name(key))) &&
    !pages.some((page) => {
      const annotations = page.node.lookup(name('Annots'));
      return (
        (annotations instanceof PDFArray && annotations.size() > 0) ||
        page.node.has(name('AA')) ||
        page.node.has(name('PresSteps'))
      );
    })
  )
    return;
  const copies = new Map();
  visitLocalDestinations(doc, (dest, replace) => {
    if (!copies.has(dest)) {
      const first = dest.get(0);
      const page = first instanceof PDFNumber ? pages[first.asNumber()] : null;
      if (page) {
        // A remote action can share the original array. Replace only local owners so its
        // required page number does not turn into a reference to this document's page.
        const copy = dest.clone(doc.context);
        copy.set(0, page.ref);
        copies.set(dest, doc.context.register(copy));
      } else copies.set(dest, null);
    }
    const copy = copies.get(dest);
    if (copy) replace(copy);
  });
}

/** Visit only local destination entries; streams are inspected without decoding their data. */
function visitLocalDestinations(doc, visit) {
  const { context, catalog } = doc;
  const repair = (container, key) => {
    const entry = container.get(key);
    const value = context.lookup(entry);
    const wrapper = value instanceof PDFDict ? value : null;
    const dest = wrapper ? wrapper.lookup(name('D')) : value;
    if (!(dest instanceof PDFArray) || !dest.size()) return;
    visit(dest, (replacement) => {
      if (wrapper) {
        const copy = wrapper.clone(context);
        copy.set(name('D'), replacement);
        replacement = entry instanceof PDFRef ? context.register(copy) : copy;
      }
      container.set(key, replacement);
    });
  };

  const open = catalog.lookup(name('OpenAction'));
  if (open instanceof PDFArray) repair(catalog, name('OpenAction'));
  const oldNames = catalog.lookup(name('Dests'));
  if (oldNames instanceof PDFDict) for (const [key] of oldNames.entries()) repair(oldNames, key);
  const names = catalog.lookup(name('Names'));
  const trees = names instanceof PDFDict ? [names.get(name('Dests'))] : [];
  const seenTrees = new Set();
  while (trees.length) {
    const tree = context.lookup(trees.pop());
    if (!(tree instanceof PDFDict) || seenTrees.has(tree)) continue;
    seenTrees.add(tree);
    const entries = tree.lookup(name('Names'));
    if (entries instanceof PDFArray) for (let i = 1; i < entries.size(); i += 2) repair(entries, i);
    const kids = tree.lookup(name('Kids'));
    if (kids instanceof PDFArray) for (const kid of kids.asArray()) trees.push(kid);
  }

  // Visit reachable containers once, without decoding streams or recursing. This includes
  // nested outlines, links, form/page additional actions, and arbitrarily chained actions.
  const pending = [catalog];
  const seen = new Set();
  while (pending.length) {
    const value = context.lookup(pending.pop());
    if (!(value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream))
      continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof PDFStream) pending.push(value.dict);
    else if (value instanceof PDFArray) for (const entry of value.asArray()) pending.push(entry);
    else {
      repair(value, DEST);
      if (value.lookup(S) === GOTO) repair(value, D);
      for (const [key, entry] of value.entries()) if (!INERT.has(key)) pending.push(entry);
    }
  }
}
