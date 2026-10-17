/**
 * A database is a page whose document holds a schema, views and rows:
 *
 *   db.props: Y.Map<propId, Y.Map{ name, type, order, options? }>
 *     options: Y.Map<optionId, { name, color, order }>
 *   db.views: Y.Map<viewId, Y.Map{ name, type, order, sorts, filters, groupBy, dateProp, hidden, widths }>
 *   db.rows:  Y.Map<rowId, Y.Map<propId | 'order', value>>
 *
 * Anything two people may change independently has its own key, so their
 * edits merge: two new tags, a filter and a column width, two cells.
 * Documents made before props and views were Y.Maps hold plain objects
 * there; they read the same and become Y.Maps on their next change.
 *
 * Every row is also a page in the space's tree (same id, `row: true`), so
 * it has a title, an icon, its own content and shows up in search. The
 * title property reads from that page.
 */
import { Y, local } from './ydoc.js';
import { uid } from '../lib/ids.js';
import { keyBetween, compareOrder } from '../lib/order.js';
import { COLORS } from '../lib/sanitize.js';

export const PROP_TYPES = {
  title: { label: 'Title', icon: 'type' },
  text: { label: 'Text', icon: 'text' },
  number: { label: 'Number', icon: 'hash' },
  select: { label: 'Select', icon: 'circleChevronDown' },
  multi: { label: 'Multi-select', icon: 'tags' },
  status: { label: 'Status', icon: 'loader' },
  date: { label: 'Date', icon: 'calendar' },
  checkbox: { label: 'Checkbox', icon: 'squareCheck' },
  url: { label: 'URL', icon: 'link' },
  email: { label: 'Email', icon: 'atSign' },
  phone: { label: 'Phone', icon: 'phone' },
  created: { label: 'Created time', icon: 'clock' },
  edited: { label: 'Last edited time', icon: 'clock' },
};

export const VIEW_TYPES = {
  table: { label: 'Table', icon: 'table' },
  board: { label: 'Board', icon: 'kanban' },
  list: { label: 'List', icon: 'list' },
  gallery: { label: 'Gallery', icon: 'grid' },
  calendar: { label: 'Calendar', icon: 'calendar' },
};

export const TITLE = 'title';

const STATUS_OPTIONS = () => [
  { id: uid(6), name: 'Not started', color: 'gray' },
  { id: uid(6), name: 'In progress', color: 'blue' },
  { id: uid(6), name: 'Done', color: 'green' },
];

function root(doc) {
  return doc.getMap('db');
}

function sub(doc, name) {
  const r = root(doc);
  let m = r.get(name);
  if (!(m instanceof Y.Map)) {
    m = new Y.Map();
    r.set(name, m);
  }
  return m;
}

export function isDatabase(doc) {
  return root(doc).get('props') instanceof Y.Map;
}

/* ---------- prop and view entries ---------- */

function optionList(options) {
  if (Array.isArray(options)) return options;
  if (!(options instanceof Y.Map)) return undefined;
  return [...options.entries()].map(([id, o]) => ({ id, ...o })).sort(compareOrder).map(({ order, ...o }) => o);
}

/** A prop or view as a plain object, from either storage shape. */
function plainEntry(id, v) {
  if (!v) return null;
  if (!(v instanceof Y.Map)) return { id, ...v };
  const out = { id };
  for (const [k, x] of v.entries()) out[k] = k === 'options' ? optionList(x) : x;
  return out;
}

/** Brings a select's options in line with a list, touching only what changed. */
function writeOptions(m, list) {
  let opts = m.get('options');
  if (!(opts instanceof Y.Map)) {
    opts = new Y.Map();
    m.set('options', opts);
  }
  const want = (list || []).filter((o) => o?.id);
  const ids = new Set(want.map((o) => o.id));
  for (const id of [...opts.keys()]) if (!ids.has(id)) opts.delete(id);
  const old = new Map(opts.entries());
  // Existing options keep their keys unless the list reorders them.
  const kept = want.filter((o) => old.has(o.id)).map((o) => o.id);
  const reordered = kept.join() !== optionList(opts).map((o) => o.id).join();
  let prev = '';
  want.forEach((o, i) => {
    const was = old.get(o.id);
    let order = reordered ? null : was?.order;
    if (!order) {
      const next = reordered ? '' : want.slice(i + 1).map((x) => old.get(x.id)?.order).find(Boolean) || '';
      order = keyBetween(prev, next > prev ? next : '');
    }
    const value = { name: String(o.name ?? ''), color: o.color || 'gray', order };
    if (!was || was.name !== value.name || was.color !== value.color || was.order !== order) opts.set(o.id, value);
    prev = order;
  });
}

const same = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

/** Writes fields onto an entry one key at a time (Y.Map shape), converting an old one first. */
function writeEntry(container, id, patch) {
  let m = container.get(id);
  if (!(m instanceof Y.Map)) {
    const fields = m || {};
    m = new Y.Map();
    container.set(id, m);
    patch = { ...fields, ...patch };
  }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    if (k === 'options') writeOptions(m, v);
    else if (v === undefined) m.delete(k);
    else if (!same(m.get(k), v)) m.set(k, v);
  }
  return m;
}

/** Sets up an empty database with a title property and a table view. */
export function initDatabase(doc, { props = null, view = 'table' } = {}) {
  local(doc, () => {
    const p = sub(doc, 'props');
    sub(doc, 'views');
    sub(doc, 'rows');
    if (!p.has(TITLE)) writeEntry(p, TITLE, { name: 'Name', type: 'title', order: 'a' });
    let order = 'b';
    for (const spec of props || [{ name: 'Tags', type: 'multi' }]) {
      writeEntry(p, uid(8), { ...spec, order, ...(spec.type === 'status' && !spec.options ? { options: STATUS_OPTIONS() } : {}), ...(['select', 'multi'].includes(spec.type) && !spec.options ? { options: [] } : {}) });
      order = keyBetween(order, '');
    }
    if (!listViews(doc).length) addView(doc, { type: view });
  });
}

export function listProps(doc) {
  const p = root(doc).get('props');
  if (!(p instanceof Y.Map)) return [];
  return [...p.entries()].map(([id, v]) => plainEntry(id, v)).filter(Boolean).sort(compareOrder);
}

export function getProp(doc, id) {
  return plainEntry(id, root(doc).get('props')?.get(id));
}

export function addProp(doc, { name, type = 'text', after = null } = {}) {
  const props = listProps(doc);
  const i = after ? props.findIndex((x) => x.id === after) : props.length - 1;
  const lo = props[i]?.order || '';
  const hi = props[i + 1]?.order || '';
  const id = uid(8);
  local(doc, () => {
    writeEntry(sub(doc, 'props'), id, {
      name: name || PROP_TYPES[type]?.label || 'Property',
      type,
      order: keyBetween(lo, hi > lo ? hi : ''),
      ...(type === 'status' ? { options: STATUS_OPTIONS() } : ['select', 'multi'].includes(type) ? { options: [] } : {}),
    });
  });
  return id;
}

export function updateProp(doc, id, patch) {
  const cur = getProp(doc, id);
  if (!cur) return;
  const next = { ...patch };
  if (id === TITLE) next.type = 'title';
  const type = next.type ?? cur.type;
  // Changing to a type with options keeps existing ones, or starts empty.
  if (['select', 'multi', 'status'].includes(type) && !Array.isArray(next.options ?? cur.options)) next.options = type === 'status' ? STATUS_OPTIONS() : [];
  local(doc, () => writeEntry(sub(doc, 'props'), id, next));
}

export function deleteProp(doc, id) {
  if (id === TITLE) return;
  local(doc, () => {
    sub(doc, 'props').delete(id);
    for (const row of sub(doc, 'rows').values()) if (row instanceof Y.Map && row.has(id)) row.delete(id);
  });
}

/** Adds a select option by name (or returns the existing one). */
export function ensureOption(doc, propId, name) {
  const prop = getProp(doc, propId);
  if (!prop) return null;
  const clean = String(name).trim().slice(0, 100);
  if (!clean) return null;
  const options = prop.options || [];
  const found = options.find((o) => o.name.toLowerCase() === clean.toLowerCase());
  if (found) return found.id;
  const option = { id: uid(6), name: clean, color: COLORS[options.length % COLORS.length] };
  updateProp(doc, propId, { options: [...options, option] });
  return option.id;
}

export function listViews(doc) {
  const v = root(doc).get('views');
  if (!(v instanceof Y.Map)) return [];
  return [...v.entries()].map(([id, x]) => plainEntry(id, x)).filter(Boolean).sort(compareOrder);
}

export function getView(doc, id) {
  return plainEntry(id, root(doc).get('views')?.get(id));
}

export function addView(doc, { type = 'table', name = null } = {}) {
  const views = listViews(doc);
  const id = uid(8);
  const groupBy = type === 'board' ? listProps(doc).find((p) => p.type === 'status' || p.type === 'select')?.id || null : null;
  const dateProp = type === 'calendar' ? listProps(doc).find((p) => p.type === 'date')?.id || null : null;
  local(doc, () => {
    writeEntry(sub(doc, 'views'), id, {
      name: name || VIEW_TYPES[type]?.label || 'View',
      type,
      order: keyBetween(views.at(-1)?.order || '', ''),
      sorts: [],
      filters: [],
      groupBy,
      dateProp,
      hidden: [],
      widths: {},
    });
  });
  return id;
}

export function updateView(doc, id, patch) {
  if (!getView(doc, id)) return;
  local(doc, () => writeEntry(sub(doc, 'views'), id, patch));
}

export function deleteView(doc, id) {
  if (listViews(doc).length <= 1) return false;
  local(doc, () => sub(doc, 'views').delete(id));
  return true;
}

/** Copies a database's schema, views and rows into another document. */
export function cloneDatabase(src, dst, rowId = (id) => id) {
  if (!isDatabase(src)) return;
  local(dst, () => {
    const props = sub(dst, 'props');
    const views = sub(dst, 'views');
    const rows = sub(dst, 'rows');
    for (const { id, ...p } of listProps(src)) writeEntry(props, id, p);
    for (const { id, ...v } of listViews(src)) writeEntry(views, id, v);
    for (const r of listRows(src)) {
      const m = new Y.Map();
      m.set('order', r.order);
      for (const [k, v] of Object.entries(r.values)) m.set(k, v);
      rows.set(rowId(r.id), m);
    }
  });
}

/* ---------- rows ---------- */

export function listRows(doc) {
  const r = root(doc).get('rows');
  if (!(r instanceof Y.Map)) return [];
  const out = [];
  for (const [id, m] of r.entries()) {
    if (!(m instanceof Y.Map)) continue;
    const row = { id, order: m.get('order') || '', values: {} };
    for (const [k, v] of m.entries()) if (k !== 'order') row.values[k] = v;
    out.push(row);
  }
  return out.sort(compareOrder);
}

export function hasRow(doc, id) {
  return root(doc).get('rows')?.get(id) instanceof Y.Map;
}

/** Adds a row (the caller adds its page to the tree). Returns its id. */
export function addRow(doc, { id = uid(), values = {}, after = null, before = null } = {}) {
  const rows = listRows(doc);
  let lo = rows.at(-1)?.order || '';
  let hi = '';
  if (after || before) {
    const i = rows.findIndex((r) => r.id === (after || before));
    if (i >= 0) {
      lo = after ? rows[i].order : rows[i - 1]?.order || '';
      hi = after ? rows[i + 1]?.order || '' : rows[i].order;
    }
  }
  local(doc, () => {
    const m = new Y.Map();
    m.set('order', keyBetween(lo, hi > lo ? hi : ''));
    for (const [k, v] of Object.entries(values)) if (k !== TITLE && v !== undefined) m.set(k, v);
    sub(doc, 'rows').set(id, m);
  });
  return id;
}

export function setValue(doc, rowId, propId, value) {
  const m = root(doc).get('rows')?.get(rowId);
  if (!(m instanceof Y.Map) || propId === TITLE || propId === 'order') return;
  local(doc, () => {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) m.delete(propId);
    else m.set(propId, value);
  });
}

export function deleteRows(doc, ids) {
  local(doc, () => {
    for (const id of ids) sub(doc, 'rows').delete(id);
  });
}

/** Moves a row before or after another in manual order. */
export function moveRow(doc, id, { before = null, after = null } = {}) {
  const rows = listRows(doc).filter((r) => r.id !== id);
  const m = root(doc).get('rows')?.get(id);
  if (!(m instanceof Y.Map)) return;
  let lo = '';
  let hi = '';
  if (after) {
    const i = rows.findIndex((r) => r.id === after);
    lo = rows[i]?.order || '';
    hi = rows[i + 1]?.order || '';
  } else if (before) {
    const i = rows.findIndex((r) => r.id === before);
    hi = rows[i]?.order || '';
    lo = rows[i - 1]?.order || '';
  } else lo = rows.at(-1)?.order || '';
  local(doc, () => m.set('order', keyBetween(lo, hi > lo ? hi : '')));
}

/* ---------- querying ---------- */

/** The value of a property for a row, with title/created/edited from its page. */
export function cellValue(row, prop, page) {
  if (prop.type === 'title') return page?.title || '';
  if (prop.type === 'created') return page?.created || null;
  if (prop.type === 'edited') return page?.updated || null;
  return row.values[prop.id] ?? null;
}

export function optionOf(prop, id) {
  return (prop.options || []).find((o) => o.id === id) || null;
}

/** Text used to compare and search a value. */
export function valueText(prop, value) {
  if (value === null || value === undefined) return '';
  switch (prop.type) {
    case 'select':
    case 'status':
      return optionOf(prop, value)?.name || '';
    case 'multi':
      return (Array.isArray(value) ? value : []).map((v) => optionOf(prop, v)?.name || '').join(', ');
    case 'checkbox':
      return value ? 'Yes' : 'No';
    case 'created':
    case 'edited':
      return new Date(value).toISOString();
    default:
      return String(value);
  }
}

function isEmpty(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
}

export const FILTER_OPS = {
  text: ['contains', 'not_contains', 'is', 'is_not', 'starts', 'empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'empty', 'not_empty'],
  select: ['is', 'is_not', 'empty', 'not_empty'],
  multi: ['has', 'has_not', 'empty', 'not_empty'],
  date: ['is', 'before', 'after', 'empty', 'not_empty'],
  checkbox: ['checked', 'unchecked'],
};

export const FILTER_LABELS = {
  contains: 'contains', not_contains: 'does not contain', is: 'is', is_not: 'is not', starts: 'starts with',
  empty: 'is empty', not_empty: 'is not empty', eq: '=', neq: '≠', gt: '>', lt: '<', gte: '≥', lte: '≤',
  has: 'contains', has_not: 'does not contain', before: 'is before', after: 'is after', checked: 'is checked', unchecked: 'is not checked',
};

export function filterKind(type) {
  if (['title', 'text', 'url', 'email', 'phone'].includes(type)) return 'text';
  if (type === 'status') return 'select';
  if (['created', 'edited'].includes(type)) return 'date';
  return FILTER_OPS[type] ? type : 'text';
}

/** Whether a row passes one filter. */
export function passes(filter, prop, value) {
  const { op, value: want } = filter;
  if (op === 'empty') return isEmpty(value);
  if (op === 'not_empty') return !isEmpty(value);
  const kind = filterKind(prop.type);
  if (kind === 'text') {
    const a = valueText(prop, value).toLowerCase();
    const b = String(want ?? '').toLowerCase();
    if (op === 'contains') return a.includes(b);
    if (op === 'not_contains') return !a.includes(b);
    if (op === 'is') return a === b;
    if (op === 'is_not') return a !== b;
    if (op === 'starts') return a.startsWith(b);
  }
  if (kind === 'number') {
    if (want === '' || want === null || want === undefined) return true;
    const a = Number(value);
    const b = Number(want);
    if (isEmpty(value)) return op === 'neq';
    return { eq: a === b, neq: a !== b, gt: a > b, lt: a < b, gte: a >= b, lte: a <= b }[op] ?? true;
  }
  if (kind === 'select') {
    if (!want) return true;
    return op === 'is' ? value === want : value !== want;
  }
  if (kind === 'multi') {
    if (!want) return true;
    const has = Array.isArray(value) && value.includes(want);
    return op === 'has' ? has : !has;
  }
  if (kind === 'date') {
    if (!want) return true;
    if (isEmpty(value)) return false;
    const day = typeof value === 'number' ? new Date(value).toISOString().slice(0, 10) : String(value).slice(0, 10);
    if (op === 'is') return day === want;
    if (op === 'before') return day < want;
    if (op === 'after') return day > want;
  }
  if (kind === 'checkbox') return op === 'checked' ? !!value : !value;
  return true;
}

function compareValues(prop, a, b) {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  // Empty values sort last in either direction.
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (prop.type === 'number' || prop.type === 'created' || prop.type === 'edited') return Number(a) - Number(b);
  if (prop.type === 'checkbox') return (a ? 1 : 0) - (b ? 1 : 0);
  if (prop.type === 'select' || prop.type === 'status') {
    const opts = prop.options || [];
    return opts.findIndex((o) => o.id === a) - opts.findIndex((o) => o.id === b);
  }
  return valueText(prop, a).localeCompare(valueText(prop, b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Rows a view shows, filtered and sorted. pageOf(id) gives the row's page
 * (for the title and timestamps); search narrows by any visible text.
 */
export function queryRows(doc, view, pageOf, { search = '' } = {}) {
  const props = listProps(doc);
  const byId = new Map(props.map((p) => [p.id, p]));
  // A row shows once its page exists (it can arrive a moment later) and is not in the trash.
  let rows = listRows(doc).map((r) => ({ ...r, page: pageOf(r.id) })).filter((r) => r.page && !r.page.trashed);
  for (const f of view?.filters || []) {
    const prop = byId.get(f.prop);
    if (prop) rows = rows.filter((r) => passes(f, prop, cellValue(r, prop, r.page)));
  }
  const q = search.trim().toLowerCase();
  if (q) rows = rows.filter((r) => props.some((p) => valueText(p, cellValue(r, p, r.page)).toLowerCase().includes(q)));
  const sorts = (view?.sorts || []).filter((s) => byId.has(s.prop));
  if (sorts.length) {
    rows = rows
      .map((r, i) => ({ r, i }))
      .sort((x, y) => {
        for (const s of sorts) {
          const prop = byId.get(s.prop);
          const va = cellValue(x.r, prop, x.r.page);
          const vb = cellValue(y.r, prop, y.r.page);
          const ea = isEmpty(va);
          const eb = isEmpty(vb);
          if (ea || eb) {
            if (ea !== eb) return ea ? 1 : -1;
            continue;
          }
          const c = compareValues(prop, va, vb);
          if (c) return s.dir === 'desc' ? -c : c;
        }
        return x.i - y.i;
      })
      .map((x) => x.r);
  }
  return rows;
}

/** Board columns: one per option (plus "No value"), with their rows. */
export function groupRows(rows, prop) {
  if (!prop) return [{ id: null, name: 'All', color: 'gray', rows }];
  if (prop.type === 'checkbox') {
    return [
      { id: true, name: 'Checked', color: 'green', rows: rows.filter((r) => !!r.values[prop.id]) },
      { id: false, name: 'Unchecked', color: 'gray', rows: rows.filter((r) => !r.values[prop.id]) },
    ];
  }
  const groups = (prop.options || []).map((o) => ({ id: o.id, name: o.name, color: o.color, rows: [] }));
  const none = { id: null, name: `No ${prop.name}`, color: 'gray', rows: [] };
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const r of rows) {
    const v = r.values[prop.id];
    const keys = prop.type === 'multi' ? (Array.isArray(v) && v.length ? v : [null]) : [v ?? null];
    for (const k of keys) (byId.get(k) || none).rows.push(r);
  }
  return [none, ...groups];
}

/** Values a new row gets so it matches a view's filters and board column. */
export function defaultsFor(doc, view, group = undefined) {
  const values = {};
  const byId = new Map(listProps(doc).map((p) => [p.id, p]));
  for (const f of view?.filters || []) {
    const prop = byId.get(f.prop);
    if (!prop || prop.type === 'title') continue;
    if (f.op === 'is' && f.value && ['select', 'status'].includes(prop.type)) values[prop.id] = f.value;
    if (f.op === 'has' && f.value) values[prop.id] = [f.value];
    if (f.op === 'checked') values[prop.id] = true;
  }
  if (view?.groupBy && group !== undefined && group !== null) {
    const prop = byId.get(view.groupBy);
    if (prop?.type === 'multi') values[prop.id] = [group];
    else if (prop) values[prop.id] = group;
  }
  return values;
}

/** Format a number or date value for display. */
export function formatValue(prop, value) {
  if (value === null || value === undefined || value === '') return '';
  if (prop.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : '';
  }
  if (prop.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(value))) return '';
    const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  if (prop.type === 'created' || prop.type === 'edited') return new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return valueText(prop, value);
}
