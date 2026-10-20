import { PDFArray, PDFDict, PDFName, PDFNumber } from 'pdf-lib';
import { annotationsOf } from './structure.js';

const name = (value) => PDFName.of(value);

/**
 * Take a page that is being deleted out of the document's logical structure (tagged PDFs, as
 * word processors export them). Structure elements name their page with /Pg, which kept the
 * deleted page, its content, and its annotations in the saved file; screen readers following
 * the tags could also still meet content that is no longer in the document.
 *
 * Marked content and object references on the page are dropped, as are elements left with
 * nothing, and the page's entries in the parent tree. Elements spanning other pages stay.
 */
export function removePageStructure(doc, page) {
  const root = doc.catalog.lookup(name('StructTreeRoot'));
  if (!(root instanceof PDFDict)) return;
  const pageRef = page.ref;
  const PG = name('Pg'),
    K = name('K'),
    TYPE = name('Type');
  const seen = new Set();
  const removed = new Set();
  // Whether a kid stays; a structure element is pruned in place on the way.
  const keep = (kid, inherited) => {
    const value = doc.context.lookup(kid);
    if (value instanceof PDFNumber) return inherited !== pageRef;
    if (!(value instanceof PDFDict)) return true;
    const type = value.lookup(TYPE);
    if (type === name('MCR') || type === name('OBJR'))
      return (value.get(PG) ?? inherited) !== pageRef;
    if (seen.has(value)) return true;
    seen.add(value);
    const own = value.get(PG);
    const left = prune(value, own ?? inherited);
    if ((own ?? inherited) !== pageRef) return true;
    if (!left) {
      removed.add(value);
      return false;
    }
    // Its remaining content is on other pages, which those kids name themselves.
    if (own) value.delete(PG);
    return true;
  };
  // Prune a node's kids; returns how many are left.
  const prune = (node, pg) => {
    const kids = node.get(K);
    const list = node.lookup(K) instanceof PDFArray ? node.lookup(K).asArray() : kids ? [kids] : [];
    const kept = list.filter((kid) => keep(kid, pg));
    if (kept.length === list.length) return kept.length;
    if (!kept.length) node.delete(K);
    else node.set(K, doc.context.obj(kept));
    return kept.length;
  };
  prune(root, undefined);
  // The ID tree (and anything else that names an element by reference) could still reach a
  // removed element, and through its /Pg the deleted page with all its content.
  for (const element of removed) element.delete(PG);
  pruneNameTree(doc, root.lookup(name('IDTree')), (value) => removed.has(value));

  // The parent tree maps the page's and its annotations' keys to their elements.
  const keys = new Set();
  const own = page.node.lookup(name('StructParents'));
  if (own instanceof PDFNumber) keys.add(own.asNumber());
  for (const ref of annotationsOf(page)?.asArray() || []) {
    const annotation = doc.context.lookup(ref);
    const key = annotation instanceof PDFDict && annotation.lookup(name('StructParent'));
    if (key instanceof PDFNumber) keys.add(key.asNumber());
  }
  const parents = root.lookup(name('ParentTree'));
  if (!keys.size || !(parents instanceof PDFDict)) return;
  const visited = new Set();
  const pending = [parents];
  while (pending.length) {
    const node = pending.pop();
    if (!(node instanceof PDFDict) || visited.has(node)) continue;
    visited.add(node);
    const nums = node.lookup(name('Nums'));
    if (nums instanceof PDFArray) {
      const entries = nums.asArray();
      const kept = [];
      for (let i = 0; i + 1 < entries.length; i += 2) {
        const key = doc.context.lookup(entries[i]);
        if (!(key instanceof PDFNumber && keys.has(key.asNumber())))
          kept.push(entries[i], entries[i + 1]);
      }
      if (kept.length !== entries.length - (entries.length % 2) || entries.length % 2)
        node.set(name('Nums'), doc.context.obj(kept));
    }
    const kids = node.lookup(name('Kids'));
    if (kids instanceof PDFArray)
      for (const kid of kids.asArray()) pending.push(doc.context.lookup(kid));
  }
}

/** Drop the entries of a name tree whose values `drop` picks; Limits are left as they are. */
function pruneNameTree(doc, tree, drop) {
  const visited = new Set();
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!(node instanceof PDFDict) || visited.has(node)) continue;
    visited.add(node);
    const names = node.lookup(name('Names'));
    if (names instanceof PDFArray) {
      const entries = names.asArray();
      const kept = [];
      for (let i = 0; i + 1 < entries.length; i += 2)
        if (!drop(doc.context.lookup(entries[i + 1]))) kept.push(entries[i], entries[i + 1]);
      if (kept.length !== entries.length) node.set(name('Names'), doc.context.obj(kept));
    }
    const kids = node.lookup(name('Kids'));
    if (kids instanceof PDFArray)
      for (const kid of kids.asArray()) pending.push(doc.context.lookup(kid));
  }
}
