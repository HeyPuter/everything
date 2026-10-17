/**
 * The content of one page, kept in the page's own document:
 *
 *   blocks: Y.Map<blockId, Y.Map>   one entry per block, with
 *     type, order (fractional key), indent (0..MAX_INDENT), text (Y.Text)
 *     and type-specific fields: checked, collapsed, color, bg, language,
 *     icon, asset, url, caption, width, page (child page id), table
 *     (see table.js).
 *
 * Blocks are a flat list ordered by key. Nesting is an indent level: a
 * toggle hides the blocks after it that are indented further, and list
 * numbering restarts whenever the indent or the type changes.
 *
 * This is a deliberate compromise. A tree (a parent id per block) moves a
 * block with its children in one write. Here moving a parent rewrites the
 * order of every block under it, and a block someone else adds inside that
 * group at the same moment stays behind at the old spot.
 * The flat list keeps rendering, selection and indenting simple and can
 * never form a cycle; switch to parent ids if that case starts to matter.
 */
import { Y, local } from './ydoc.js';
import { uid } from '../lib/ids.js';
import { keyBetween, compareOrder } from '../lib/order.js';
import { applyDelta, splitDelta, deltaText } from './richtext.js';
import { readTable, tableValue } from './table.js';

export const MAX_INDENT = 6;

/** Block types and what they can hold. */
export const BLOCK_TYPES = {
  paragraph: { label: 'Text', text: true },
  h1: { label: 'Heading 1', text: true },
  h2: { label: 'Heading 2', text: true },
  h3: { label: 'Heading 3', text: true },
  bulleted: { label: 'Bulleted list', text: true, list: true },
  numbered: { label: 'Numbered list', text: true, list: true },
  todo: { label: 'To-do list', text: true, list: true },
  toggle: { label: 'Toggle list', text: true, list: true },
  quote: { label: 'Quote', text: true },
  callout: { label: 'Callout', text: true },
  code: { label: 'Code', text: true, plain: true },
  divider: { label: 'Divider' },
  image: { label: 'Image' },
  bookmark: { label: 'Web bookmark' },
  page: { label: 'Page' },
  table: { label: 'Table' },
};

/** Fields that belong to one block type and are dropped when it changes. */
const TYPE_FIELDS = ['checked', 'collapsed', 'language', 'icon', 'asset', 'url', 'caption', 'width', 'page', 'table', 'name'];

export function blocksOf(doc) {
  return doc.getMap('blocks');
}

export function blockMap(doc, id) {
  const m = blocksOf(doc).get(id);
  return m instanceof Y.Map ? m : null;
}

/** Plain snapshot of a block (text as delta). */
export function getBlock(doc, id) {
  const m = blockMap(doc, id);
  if (!m) return null;
  const out = { id };
  for (const [k, v] of m.entries()) {
    if (k === 'text') out.delta = v instanceof Y.Text ? v.toDelta() : [];
    else if (k === 'table') out.table = readTable(v);
    else out[k] = v;
  }
  out.type ||= 'paragraph';
  out.indent ||= 0;
  out.delta ||= [];
  return out;
}

/** Blocks in order. */
export function listBlocks(doc) {
  const out = [];
  for (const id of blocksOf(doc).keys()) {
    const m = blockMap(doc, id);
    if (m) out.push({ id, order: m.get('order') || '' });
  }
  return out.sort(compareOrder).map((b) => getBlock(doc, b.id));
}

export function blockIds(doc) {
  const out = [];
  for (const id of blocksOf(doc).keys()) {
    const m = blockMap(doc, id);
    if (m) out.push({ id, order: m.get('order') || '' });
  }
  return out.sort(compareOrder).map((b) => b.id);
}

export function textOf(doc, id) {
  const t = blockMap(doc, id)?.get('text');
  return t instanceof Y.Text ? t : null;
}

function orderNear(doc, { before = null, after = null } = {}) {
  const ids = blockIds(doc);
  const orderOf = (bid) => blockMap(doc, bid)?.get('order') || '';
  let lo = '';
  let hi = '';
  if (after) {
    const i = ids.indexOf(after);
    lo = i >= 0 ? orderOf(after) : orderOf(ids.at(-1));
    hi = i >= 0 && ids[i + 1] ? orderOf(ids[i + 1]) : '';
  } else if (before) {
    const i = ids.indexOf(before);
    hi = i >= 0 ? orderOf(before) : '';
    lo = i > 0 ? orderOf(ids[i - 1]) : '';
  } else if (ids.length) lo = orderOf(ids.at(-1));
  if (lo && hi && lo >= hi) hi = '';
  return keyBetween(lo, hi);
}

function fillBlock(m, { type = 'paragraph', indent = 0, delta = null, text = '', ...fields }) {
  m.set('type', type);
  m.set('indent', Math.max(0, Math.min(MAX_INDENT, indent | 0)));
  const yt = new Y.Text();
  m.set('text', yt);
  if (delta && delta.length) yt.applyDelta(delta);
  else if (text) yt.insert(0, text);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && k !== 'id' && k !== 'order') m.set(k, k === 'table' ? tableValue(v) : v);
}

/** Inserts a block before or after another (or at the end). Returns its id. */
export function insertBlock(doc, spec = {}, where = {}) {
  const id = spec.id || uid();
  local(doc, () => {
    const m = new Y.Map();
    m.set('order', orderNear(doc, where));
    blocksOf(doc).set(id, m);
    fillBlock(m, spec);
  });
  return id;
}

/** Inserts several blocks in a row after a block. Returns their ids. */
export function insertBlocks(doc, specs, where = {}) {
  const ids = [];
  local(doc, () => {
    let after = where.after ?? null;
    let before = after ? null : where.before ?? null;
    for (const spec of specs) {
      const id = spec.id && !blockMap(doc, spec.id) ? spec.id : uid();
      const m = new Y.Map();
      m.set('order', orderNear(doc, after ? { after } : before ? { before } : {}));
      blocksOf(doc).set(id, m);
      fillBlock(m, spec);
      ids.push(id);
      after = id;
      before = null;
    }
  });
  return ids;
}

export function deleteBlocks(doc, ids) {
  local(doc, () => {
    for (const id of ids) blocksOf(doc).delete(id);
  });
}

export function setBlock(doc, id, patch) {
  const m = blockMap(doc, id);
  if (!m) return;
  local(doc, () => {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || k === 'text' || k === 'delta') continue;
      if (v === undefined || v === null) m.delete(k);
      else if (k === 'table') m.set(k, tableValue(v));
      else if (m.get(k) !== v) m.set(k, v);
    }
  });
}

/** Changes a block's type, dropping fields that do not apply. */
export function setType(doc, id, type, extra = {}) {
  const m = blockMap(doc, id);
  if (!m || !BLOCK_TYPES[type]) return;
  local(doc, () => {
    const old = m.get('type');
    if (old !== type) for (const f of TYPE_FIELDS) if (!(f in extra)) m.delete(f);
    m.set('type', type);
    for (const [k, v] of Object.entries(extra)) m.set(k, k === 'table' ? tableValue(v) : v);
    // Code holds plain text.
    if (BLOCK_TYPES[type].plain) {
      const t = m.get('text');
      if (t instanceof Y.Text && t.length) {
        const plain = t.toString();
        t.delete(0, t.length);
        t.insert(0, plain);
      }
    }
  });
}

export function setText(doc, id, delta) {
  const t = textOf(doc, id);
  if (!t) return;
  local(doc, () => applyDelta(t, delta));
}

/**
 * Splits a block at a caret offset (Enter). The text after the caret moves
 * to a new block below. Headings continue as text; lists continue as lists.
 * Returns the new block's id.
 */
export function splitBlock(doc, id, offset) {
  const b = getBlock(doc, id);
  if (!b) return null;
  const [, right] = splitDelta(b.delta, offset);
  const continues = ['bulleted', 'numbered', 'todo', 'toggle', 'quote'].includes(b.type);
  let newType = continues ? b.type : 'paragraph';
  let newId = null;
  local(doc, () => {
    const t = textOf(doc, id);
    const len = t.length;
    if (offset < len) t.delete(offset, len - offset);
    // An open toggle with something under it gets its new line inside.
    const childIndent = b.type === 'toggle' && !b.collapsed && offset >= len ? b.indent + 1 : b.indent;
    if (b.type === 'toggle' && childIndent > b.indent) newType = 'paragraph';
    // After a collapsed toggle the new block goes below what it hides.
    const after = b.type === 'toggle' && b.collapsed ? withChildren(doc, id).at(-1) : id;
    newId = insertBlock(doc, { type: newType, indent: childIndent, delta: right, ...(newType === 'todo' ? { checked: false } : {}) }, { after });
  });
  return newId;
}

/**
 * Merges a block into the previous text block (Backspace at the start).
 * Returns { id, offset } for the caret, or null when there is nothing to
 * merge into.
 */
export function mergeIntoPrevious(doc, id) {
  const ids = visibleIds(doc);
  const i = ids.indexOf(id);
  if (i <= 0) return null;
  const prevId = ids[i - 1];
  const prev = getBlock(doc, prevId);
  if (!prev || !BLOCK_TYPES[prev.type]?.text) return { id: prevId, offset: null, blocked: true };
  const cur = getBlock(doc, id);
  const prevText = textOf(doc, prevId);
  const offset = prevText.length;
  local(doc, () => {
    if (cur.delta.length) prevText.applyDelta([{ retain: offset }, ...cur.delta.map((op) => ({ insert: op.insert, attributes: op.attributes }))]);
    blocksOf(doc).delete(id);
  });
  return { id: prevId, offset };
}

/** Blocks not hidden inside a collapsed toggle. */
export function visibleIds(doc) {
  const out = [];
  let hideBelow = Infinity;
  for (const b of listBlocks(doc)) {
    if (b.indent > hideBelow) continue;
    hideBelow = Infinity;
    out.push(b.id);
    if (b.type === 'toggle' && b.collapsed) hideBelow = b.indent;
  }
  return out;
}

/** The block and everything nested under it (deeper indent right after it). */
export function withChildren(doc, id) {
  const list = listBlocks(doc);
  const i = list.findIndex((b) => b.id === id);
  if (i < 0) return [];
  const out = [id];
  for (let j = i + 1; j < list.length && list[j].indent > list[i].indent; j++) out.push(list[j].id);
  return out;
}

/** Indents or outdents blocks (with what is nested under them). */
export function indentBlocks(doc, ids, delta) {
  const list = listBlocks(doc);
  const shift = new Map();
  for (const id of ids) {
    if (shift.has(id)) continue;
    const b = list.find((x) => x.id === id);
    if (!b) continue;
    // Children move by what the block actually moved, so their nesting holds.
    const applied = Math.max(0, Math.min(MAX_INDENT, b.indent + delta)) - b.indent;
    for (const c of withChildren(doc, id)) if (!shift.has(c)) shift.set(c, applied);
  }
  local(doc, () => {
    for (const b of list) {
      if (!shift.has(b.id)) continue;
      const next = Math.max(0, Math.min(MAX_INDENT, b.indent + shift.get(b.id)));
      if (next !== b.indent) blockMap(doc, b.id).set('indent', next);
    }
  });
}

/** Whether a block can be indented (it needs a block above at its level). */
export function canIndent(doc, id) {
  const list = listBlocks(doc);
  const i = list.findIndex((b) => b.id === id);
  if (i <= 0) return false;
  return list[i - 1].indent >= list[i].indent && list[i].indent < MAX_INDENT;
}

/**
 * Moves blocks (each with its nested blocks) to just before or after
 * another block. Their relative order is kept.
 */
export function moveBlocks(doc, ids, { before = null, after = null, indent = null } = {}) {
  const list = listBlocks(doc);
  const moving = new Set();
  for (const id of ids) for (const c of withChildren(doc, id)) moving.add(c);
  if ((before && moving.has(before)) || (after && moving.has(after))) return false;
  const group = list.filter((b) => moving.has(b.id));
  if (!group.length) return false;
  // Moving after a block puts the group after that block's own children.
  if (after) {
    const kids = withChildren(doc, after).filter((k) => !moving.has(k));
    after = kids.at(-1);
  }
  const rest = list.filter((b) => !moving.has(b.id));
  let lo = '';
  let hi = '';
  if (after) {
    const i = rest.findIndex((b) => b.id === after);
    lo = rest[i]?.order || '';
    hi = rest[i + 1]?.order || '';
  } else if (before) {
    const i = rest.findIndex((b) => b.id === before);
    hi = rest[i]?.order || '';
    lo = rest[i - 1]?.order || '';
  } else lo = rest.at(-1)?.order || '';
  const shift = indent === null ? 0 : indent - group[0].indent;
  local(doc, () => {
    for (const b of group) {
      const key = keyBetween(lo, hi && hi > lo ? hi : '');
      const m = blockMap(doc, b.id);
      m.set('order', key);
      if (shift) m.set('indent', Math.max(0, Math.min(MAX_INDENT, b.indent + shift)));
      lo = key;
    }
  });
  return true;
}

/** Duplicates blocks (with nested blocks) right after the last of them. */
export function duplicateBlocks(doc, ids) {
  const list = listBlocks(doc);
  const set = new Set();
  for (const id of ids) for (const c of withChildren(doc, id)) set.add(c);
  const group = list.filter((b) => set.has(b.id));
  if (!group.length) return [];
  return insertBlocks(doc, group.map(({ id, order, ...rest }) => ({ ...rest, delta: rest.delta, page: rest.type === 'page' ? undefined : rest.page, type: rest.type === 'page' ? 'paragraph' : rest.type })), { after: group.at(-1).id });
}

/** Number shown for a numbered list item. */
export function listNumber(list, index) {
  const b = list[index];
  let n = 1;
  for (let i = index - 1; i >= 0; i--) {
    const p = list[i];
    if (p.indent > b.indent) continue;
    if (p.indent < b.indent || p.type !== 'numbered') break;
    n++;
  }
  return n;
}

/** Plain text of the whole page, for search and previews. */
export function pageText(doc, { limit = Infinity } = {}) {
  let out = '';
  for (const b of listBlocks(doc)) {
    const t = deltaText(b.delta);
    if (t) out += (out ? '\n' : '') + t;
    if (b.caption) out += `\n${b.caption}`;
    if (b.type === 'table' && b.table) for (const r of b.table.rows) out += `\n${r.join(' ')}`;
    if (out.length > limit) break;
  }
  return out;
}

/** Ensures a page has at least one block to type in. */
export function ensureBlock(doc) {
  if (blockIds(doc).length) return null;
  return insertBlock(doc, { type: 'paragraph' });
}
