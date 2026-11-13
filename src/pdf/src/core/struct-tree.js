import { PDFArray, PDFDict, PDFName, PDFNumber } from 'pdf-lib';
import { annotationsOf } from './structure.js';

const name = (value) => PDFName.of(value);

/**
 * Take pages that are being deleted out of the document's logical structure (tagged PDFs, as
 * word processors export them). Structure elements name their page with /Pg, which kept the
 * deleted page, its content, and its annotations in the saved file; screen readers following
 * the tags could also still meet content that is no longer in the document.
 *
 * Marked content and object references on the pages are dropped, as are elements left with
 * nothing, and the pages' entries in the parent tree. Elements spanning other pages stay.
 * All the pages go in one walk of the tree, however many there are.
 */
export function removePageStructure(doc, pages) {
  const root = doc.catalog.lookup(name('StructTreeRoot'));
  if (!(root instanceof PDFDict)) return;
  const deleted = new Set(pages.map((page) => page.ref));
  const onDeleted = (pg) => deleted.has(pg);
  const PG = name('Pg'),
    K = name('K'),
    TYPE = name('Type');
  const seen = new Set();
  const removed = new Set();
  // A node's kids, to be pruned in place; `pg` is the page they inherit.
  const frame = (node, pg) => {
    const kids = node.get(K);
    const array = node.lookup(K);
    const list = array instanceof PDFArray ? array.asArray() : kids ? [kids] : [];
    return { node, pg, list, next: 0, kept: [] };
  };
  // Tags can nest deeper than the call stack, so the tree is walked with a stack of its own:
  // each element's kids are pruned before the element itself is kept or dropped.
  const stack = [frame(root, undefined)];
  while (stack.length) {
    const current = stack.at(-1);
    if (current.next < current.list.length) {
      const kid = current.list[current.next++];
      const value = doc.context.lookup(kid);
      let stays = true;
      if (value instanceof PDFNumber) stays = !onDeleted(current.pg);
      else if (value instanceof PDFDict) {
        const type = value.lookup(TYPE);
        if (type === name('MCR') || type === name('OBJR'))
          stays = !onDeleted(value.get(PG) ?? current.pg);
        else if (!seen.has(value)) {
          seen.add(value);
          const own = value.get(PG);
          stack.push({ ...frame(value, own ?? current.pg), kid, own });
          continue;
        }
      }
      if (stays) current.kept.push(kid);
      continue;
    }
    stack.pop();
    const { node, list, kept } = current;
    if (kept.length !== list.length) {
      if (!kept.length) node.delete(K);
      else node.set(K, doc.context.obj(kept));
    }
    const parent = stack.at(-1);
    if (!parent) break;
    // An element on a deleted page goes when nothing of it is left; its remaining content is
    // on other pages, which those kids name themselves.
    if (onDeleted(current.pg)) {
      if (!kept.length) {
        removed.add(node);
        continue;
      }
      if (current.own) node.delete(PG);
    }
    parent.kept.push(current.kid);
  }
  // The ID tree (and anything else that names an element by reference) could still reach a
  // removed element, and through its /Pg the deleted page with all its content.
  for (const element of removed) element.delete(PG);
  pruneNameTree(doc, root.lookup(name('IDTree')), (value) => removed.has(value));

  // The parent tree maps the pages' and their annotations' keys to their elements.
  const keys = new Set();
  for (const page of pages) {
    const own = page.node.lookup(name('StructParents'));
    if (own instanceof PDFNumber) keys.add(own.asNumber());
    for (const ref of annotationsOf(page)?.asArray() || []) {
      const annotation = doc.context.lookup(ref);
      const key = annotation instanceof PDFDict && annotation.lookup(name('StructParent'));
      if (key instanceof PDFNumber) keys.add(key.asNumber());
    }
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
