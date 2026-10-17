/**
 * Copying and moving pages between documents and spaces.
 *
 * exportSubtree() gathers a page, everything under it, their documents and
 * the images they use. importSubtree() adds such a bundle to another space
 * with the same page ids (a move); cloneSubtree() gives every page a new id
 * and rewrites links between them (a copy).
 */
import { Y, makeDoc, local } from './ydoc.js';
import { getPage, descendants, pagesOf, PAGE_FIELDS, childrenOf } from './tree.js';
import { listBlocks, insertBlocks, blocksOf } from './page.js';
import { cloneDatabase } from './database.js';
import { keyBetween } from '../lib/order.js';
import { uid } from '../lib/ids.js';

/** Image hashes a page document uses. */
export function assetsInDoc(doc) {
  const out = new Set();
  for (const b of listBlocks(doc)) if (b.asset) out.add(b.asset);
  return out;
}

export async function exportSubtree(space, rootId) {
  const ids = descendants(space.tree, rootId);
  const pages = ids.map((id) => getPage(space.tree, id)).filter(Boolean);
  const docs = {};
  const assets = new Set();
  for (const p of pages) {
    if (p.cover?.asset) assets.add(p.cover.asset);
    for (const docId of [p.id, `${p.id}.c`]) {
      // A read that fails stops the whole move: treating it as "no document"
      // would delete a page whose copy never happened.
      const state = await space.docState(docId);
      // An empty document (no file yet) has nothing to copy.
      if (!state || state.length <= 2) continue;
      docs[docId] = state;
      if (docId === p.id) for (const a of assetsInDoc(makeDoc(state))) assets.add(a);
    }
  }
  return { rootId, pages, docs, assets: [...assets] };
}

/** A fresh tree document holding just a bundle's pages, rooted at the top. */
export function treeFromBundle(bundle) {
  const doc = new Y.Doc();
  local(doc, () => {
    for (const p of bundle.pages) {
      const m = new Y.Map();
      for (const f of PAGE_FIELDS) if (p[f] !== undefined) m.set(f, p[f]);
      if (p.id === bundle.rootId) m.set('parent', null);
      pagesOf(doc).set(p.id, m);
    }
  });
  return doc;
}

/** Copies images, retrying a few times. Returns the hashes that failed. */
export async function copyAssets(from, to, assets) {
  const failed = [];
  for (const hash of assets) {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        const blob = await from.assetBlob(hash);
        if (blob) await to.putAsset(blob);
        done = true;
      } catch {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    if (!done) failed.push(hash);
  }
  return failed;
}

/** Adds a bundle's pages to a space under a parent (or at the top). */
export async function importSubtree(from, to, bundle, parent = null, { after = null } = {}) {
  const failed = await copyAssets(from, to, bundle.assets);
  if (failed.length) throw new Error(`${failed.length} image${failed.length === 1 ? '' : 's'} could not be copied. Nothing was moved; try again.`);
  for (const [docId, state] of Object.entries(bundle.docs)) await to.putDoc(docId, state);
  const sibs = childrenOf(to.tree, parent);
  const i = after ? sibs.findIndex((p) => p.id === after) : sibs.length - 1;
  const lo = sibs[i]?.order || '';
  const hi = sibs[i + 1]?.order || '';
  // Siblings can share a key (two people adding at the same spot); go after it.
  const order = keyBetween(lo, hi > lo ? hi : '');
  local(to.tree, () => {
    for (const p of bundle.pages) {
      const m = new Y.Map();
      for (const f of PAGE_FIELDS) if (p[f] !== undefined) m.set(f, p[f]);
      if (p.id === bundle.rootId) {
        m.set('parent', parent);
        m.set('order', order);
        m.set('trashed', null);
      }
      pagesOf(to.tree).set(p.id, m);
    }
  });
}

/** Rewrites page links inside a delta with an id map. */
function remapDelta(delta, idMap) {
  return delta.map((op) => (op.attributes?.page && idMap.has(op.attributes.page) ? { ...op, attributes: { ...op.attributes, page: idMap.get(op.attributes.page) } } : op));
}

/** Copies a page document's content into an empty document, remapping ids. */
export function cloneDocContent(src, dst, idMap) {
  const blocks = listBlocks(src);
  if (blocks.length) {
    insertBlocks(
      dst,
      blocks.map(({ id, order, delta, ...rest }) => ({ ...rest, delta: remapDelta(delta, idMap), ...(rest.page ? { page: idMap.get(rest.page) || rest.page } : {}) })),
    );
  }
  cloneDatabase(src, dst, (id) => idMap.get(id) || id);
  return dst;
}

/**
 * Copies a page and everything under it inside one space, next to the
 * original. Returns the new root id.
 */
export async function cloneSubtree(space, rootId, { titleSuffix = ' (copy)', parent, by = null } = {}) {
  const ids = descendants(space.tree, rootId);
  const idMap = new Map(ids.map((id) => [id, uid()]));
  const root = getPage(space.tree, rootId);
  for (const id of ids) {
    const src = await space.doc(id);
    const dst = new Y.Doc();
    cloneDocContent(src, dst, idMap);
    if (blocksOf(dst).size || dst.getMap('db').size) await space.putDoc(idMap.get(id), Y.encodeStateAsUpdate(dst));
  }
  const targetParent = parent === undefined ? root.parent : parent;
  const sibs = childrenOf(space.tree, targetParent);
  const i = sibs.findIndex((p) => p.id === rootId);
  const lo = (i >= 0 ? sibs[i].order : sibs.at(-1)?.order) || '';
  const hi = (i >= 0 && sibs[i + 1]?.order) || '';
  const order = keyBetween(lo, hi > lo ? hi : '');
  local(space.tree, () => {
    const now = Date.now();
    for (const id of ids) {
      const p = getPage(space.tree, id);
      if (!p) continue;
      const m = new Y.Map();
      for (const f of PAGE_FIELDS) if (p[f] !== undefined) m.set(f, p[f]);
      m.set('parent', id === rootId ? targetParent : idMap.get(p.parent) || p.parent);
      if (id === rootId) {
        m.set('order', order);
        m.set('title', `${p.title || 'Untitled'}${titleSuffix}`);
      }
      m.set('created', now);
      m.set('updated', now);
      if (by) m.set('createdBy', by);
      m.set('trashed', null);
      pagesOf(space.tree).set(idMap.get(id), m);
    }
  });
  return idMap.get(rootId);
}
