// Pure list logic shared by the packing and to-do panes (no DOM, no store).
import { isDate } from '../../../shared/dates.js';
import { isOrder, orderBetween, orderKeys } from '../../../shared/order.js';

export const NAME_MAX = 500;
export const IMPORT_MAX = 1000;
// Keys past this length are rebalanced instead of growing toward the 128-char cap.
export const ORDER_MAX = 64;
export const COLORS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);

export const normName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
export const cleanName = (value, max = NAME_MAX) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export const byOrder = (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Lists of one kind in display order: `listMeta` entries first (same-name duplicates fold into the first), then names
 * only items use, sorted, with the unnamed group last. Each group is `{key, name, meta, dupes, items}`.
 */
export function groupLists(metas, items, kind) {
  const groups = new Map();
  const named = [];
  for (const meta of [...metas].sort(byOrder)) {
    if (meta.kind !== kind) continue;
    const key = normName(meta.name);
    if (groups.has(key)) { groups.get(key).dupes.push(meta); continue; }
    const group = { key, name: cleanName(meta.name), meta, dupes: [], items: [] };
    groups.set(key, group);
    named.push(group);
  }
  const loose = [];
  for (const item of items) {
    const key = normName(item.list);
    let group = groups.get(key);
    if (!group) {
      group = { key, name: cleanName(item.list), meta: null, dupes: [], items: [] };
      groups.set(key, group);
      loose.push(group);
    }
    group.items.push(item);
  }
  loose.sort((a, b) => Number(a.key === '') - Number(b.key === '') || a.name.localeCompare(b.name));
  const all = [...named, ...loose];
  for (const group of all) group.items.sort(byOrder);
  return all;
}

/** Assignees per list key, for one kind. */
export function listAssignees(metas, kind) {
  const result = new Map();
  for (const meta of metas) if (meta.kind === kind && meta.assignees?.length) {
    const key = normName(meta.name);
    result.set(key, [...new Set([...(result.get(key) ?? []), ...meta.assignees])]);
  }
  return result;
}

/** The least used list color (1–8), lowest first on ties. */
export function nextColor(used) {
  const counts = new Map(COLORS.map((color) => [color, 0]));
  for (const color of used) if (counts.has(color)) counts.set(color, counts.get(color) + 1);
  return [...counts].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0][0];
}

/**
 * One packing item from the caller's point of view. `relevant`: it is theirs to check (in per-person mode, items
 * assigned to others are not). `done`: their check, the shared check, or, for others' items, every assignee's.
 */
export function packState(item, { uid, perPerson = false }) {
  if (item.private) return { relevant: true, done: Boolean(item.done) };
  if (!perPerson) return { relevant: true, done: Boolean(item.done) };
  const assigned = item.vis === 'people' ? item.for ?? [] : null;
  if (!assigned || assigned.includes(uid)) return { relevant: true, done: Boolean(item.doneBy?.[uid]) };
  return { relevant: false, done: assigned.length > 0 && assigned.every((who) => item.doneBy?.[who] === true) };
}

/** Private items, items assigned to the caller, items they pledged to bring, and items in lists assigned to them. */
export function inMyList(item, uid, assignees = new Map()) {
  if (item.private) return true;
  if (item.vis === 'people' && item.for?.includes(uid)) return true;
  if (item.bring?.[uid]) return true;
  return (assignees.get(normName(item.list)) ?? []).includes(uid);
}

export function matchesFilter(state, filter) {
  return filter === 'open' ? !state.done : filter === 'done' ? state.done : true;
}

export function progress(items, options) {
  let done = 0; let total = 0;
  for (const item of items) {
    const state = packState(item, options);
    if (!state.relevant) continue;
    total += 1;
    if (state.done) done += 1;
  }
  return { done, total };
}

/** Grams for an item's whole quantity (weights are per unit). */
export function itemGrams(item) {
  if (!Number.isFinite(item.grams) || item.grams <= 0) return 0;
  return item.grams * (Number.isFinite(item.qty) && item.qty > 0 ? item.qty : 1);
}

/** `{bags: Map<bagId, {grams, count}>, none}`; items pointing at a missing bag count as unassigned. */
export function bagTotals(items, bags) {
  const totals = new Map(bags.map((bag) => [bag.id, { grams: 0, count: 0 }]));
  const none = { grams: 0, count: 0 };
  for (const item of items) {
    const entry = (item.bagId && totals.get(item.bagId)) || none;
    entry.grams += itemGrams(item);
    entry.count += 1;
  }
  return { bags: totals, none };
}

function maxOrder(items) {
  let max = null;
  for (const item of items) if (isOrder(item.order) && (max === null || item.order > max)) max = item.order;
  return max;
}
const short = (keys) => keys.every((key) => key.length <= ORDER_MAX);

/**
 * Order keys for `count` new entries after `items`. When appending would make keys too long, `moves` re-keys the
 * existing entries first (`[{item, order}]`) and the new keys follow them.
 */
export function appendOrders(items, count) {
  if (!count) return { keys: [], moves: [] };
  const keys = orderKeys(count, maxOrder(items), null);
  if (short(keys)) return { keys, moves: [] };
  const sorted = [...items].sort(byOrder);
  const all = orderKeys(sorted.length + count);
  return {
    keys: all.slice(sorted.length),
    moves: sorted.map((item, index) => ({ item, order: all[index] })).filter((move) => move.item.order !== move.order),
  };
}

/**
 * Re-keys for moving `visible[from]` to position `to` among the other visible entries. `full` is every entry of the
 * group in order (the view may hide some). Returns `[{item, order}]`: one move, or a rebalance when no key fits.
 */
export function moveOrders(full, visible, from, to) {
  const item = visible[from];
  if (!item || from === to) return [];
  const others = visible.filter((_, index) => index !== from);
  const left = others[to - 1] ?? null;
  const right = others[to] ?? null;
  try {
    const key = orderBetween(left?.order ?? null, right?.order ?? null);
    if (key.length <= ORDER_MAX) return [{ item, order: key }];
  } catch { /* equal or invalid neighbours: rebalance below */ }
  const rest = [...full].sort(byOrder).filter((entry) => entry.id !== item.id);
  const index = left ? rest.findIndex((entry) => entry.id === left.id) + 1 : right ? rest.findIndex((entry) => entry.id === right.id) : rest.length;
  rest.splice(Math.max(0, index), 0, item);
  const keys = orderKeys(rest.length);
  return rest.map((entry, position) => ({ item: entry, order: keys[position] })).filter((move) => move.item.order !== move.order);
}

const QUANTITY = /^(\d{1,4})\s*[x×]\s+(.+)$/i;
/** `3x Socks` → `{qty: 3, name: 'Socks'}`. */
export function parseQuantity(text) {
  const value = cleanName(text);
  const match = QUANTITY.exec(value);
  if (!match) return { name: value };
  const qty = Number(match[1]);
  const name = cleanName(match[2]);
  return qty > 1 && name ? { name, qty } : { name: name || value };
}

const UNITS = Object.freeze({ g: 1, gr: 1, gram: 1, grams: 1, kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, lb: 453.59237, lbs: 453.59237, oz: 28.349523125 });
/** `250`, `250 g`, `1.2kg`, `1,5 kg`, `2 lb`, `8 oz` → whole grams (a bare number is grams), or null. */
export function parseWeightText(text) {
  const match = /^(\d{1,9}(?:[.,]\d{1,6})?)\s*([a-z]*)\.?$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  const unit = match[2].toLowerCase() || 'g';
  if (!Object.hasOwn(UNITS, unit)) return null;
  const grams = Math.round(Number(match[1].replace(',', '.')) * UNITS[unit]);
  return Number.isFinite(grams) && grams <= 1_000_000_000 ? grams : null;
}

/** Splits one line on `delimiter`, honouring double quotes (`""` is a literal quote). */
export function splitLine(line, delimiter) {
  if (!delimiter) return [line.trim()];
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[index + 1] === '"') { field += '"'; index++; }
      else quoted = false;
    } else if (char === '"' && !field.trim()) { quoted = true; field = ''; }
    else if (char === delimiter) { fields.push(field.trim()); field = ''; }
    else field += char;
  }
  fields.push(field.trim());
  return fields;
}

/** Tab when any line has one, otherwise whichever of `;` and `,` splits more, or none. */
export function detectDelimiter(lines) {
  if (lines.some((line) => line.includes('\t'))) return '\t';
  const sample = lines.slice(0, 50);
  const count = (delimiter) => sample.reduce((sum, line) => sum + splitLine(line, delimiter).length - 1, 0);
  const semicolons = count(';');
  const commas = count(',');
  if (!semicolons && !commas) return null;
  return semicolons >= commas ? ';' : ',';
}

const CHECKED = /^(?:1|true|yes|y|x|done|checked|packed|✓|✔)$/i;
const HEADER_LIST = new Set(['list', 'category', 'categories']);
const HEADER_NAME = new Set(['name', 'item', 'items']);

/**
 * Paste or CSV/TXT text, one item per line: `List, Name, Weight, Bag, checked` (comma, semicolon or tab). A line with
 * one field is just a name. Returns `{rows: [{list, name, qty?, grams?, bag?, done?}], skipped, truncated}`.
 */
export function parseImport(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
  const delimiter = detectDelimiter(lines);
  const rows = [];
  let skipped = 0;
  let truncated = false;
  lines.forEach((line, index) => {
    const fields = splitLine(line, delimiter);
    if (index === 0 && fields.length > 1 && HEADER_LIST.has(normName(fields[0])) && HEADER_NAME.has(normName(fields[1]))) return;
    const [list, nameField, weight, bag, checked] = fields.length === 1 ? ['', fields[0]] : fields;
    const { name, qty } = parseQuantity(nameField);
    if (!name) { skipped += 1; return; }
    if (rows.length >= IMPORT_MAX) { truncated = true; return; }
    const row = { list: cleanName(list), name };
    if (qty) row.qty = qty;
    const grams = weight ? parseWeightText(weight) : null;
    if (grams) row.grams = grams;
    if (cleanName(bag)) row.bag = cleanName(bag);
    if (checked && CHECKED.test(checked.trim())) row.done = true;
    rows.push(row);
  });
  return { rows, skipped, truncated };
}

/** Rows for every item of a validated template (see views/settings/data/templates.js). */
export function rowsFromTemplate(template) {
  return template.lists.flatMap((list) => list.items.map((item) => ({ list: cleanName(list.name), ...item })));
}

/**
 * What an import creates: missing lists (`listMeta` fields) and bags (with ids), then item fields appended to their
 * lists. Lists and bags match existing ones by name, ignoring case and spacing. `moves` (`[{type, item, order}]`) re-keys
 * existing entries whose keys had grown too long. Pack items keep weight, bag and checks; to-dos keep priority.
 */
export function planImport(rows, { kind, metas = [], items = [], bags = [], makeId, createBags = true, withBags = true }) {
  const groups = new Map(groupLists(metas, items, kind).map((group) => [group.key, group]));
  const lists = [];
  const newBags = [];
  const bagIds = new Map(bags.map((bag) => [normName(bag.name), bag.id]));
  const usedColors = metas.filter((meta) => meta.kind === kind).map((meta) => meta.color);
  const bagColors = bags.map((bag) => bag.color);
  const perList = new Map();
  for (const row of rows) {
    const key = normName(row.list);
    if (!groups.has(key)) {
      groups.set(key, { key, name: cleanName(row.list), meta: null, dupes: [], items: [] });
      if (key) {
        const color = nextColor(usedColors);
        usedColors.push(color);
        lists.push({ kind, name: cleanName(row.list), color });
      }
    }
    let bagId;
    if (kind === 'pack' && withBags && row.bag) {
      const bagKey = normName(row.bag);
      if (!bagIds.has(bagKey) && createBags) {
        const color = nextColor(bagColors);
        bagColors.push(color);
        const bag = { id: makeId(), name: cleanName(row.bag), color };
        newBags.push(bag);
        bagIds.set(bagKey, bag.id);
      }
      bagId = bagIds.get(bagKey);
    }
    if (!perList.has(key)) perList.set(key, []);
    perList.get(key).push({ row, bagId });
  }
  const metaKeys = appendOrders(metas.filter((meta) => meta.kind === kind), lists.length);
  lists.forEach((list, index) => { list.order = metaKeys.keys[index]; });
  const result = [];
  const moves = metaKeys.moves.map((move) => ({ ...move, type: 'listMeta' }));
  for (const [key, entries] of perList) {
    const group = groups.get(key);
    const orders = appendOrders(group.items, entries.length);
    moves.push(...orders.moves.map((move) => ({ ...move, type: kind })));
    entries.forEach(({ row, bagId }, index) => {
      const fields = { name: cleanName(row.name), order: orders.keys[index] };
      if (group.name) fields.list = group.name;
      if (kind === 'pack') {
        if (row.qty > 1) fields.qty = row.qty;
        if (row.grams > 0) fields.grams = row.grams;
        if (bagId) fields.bagId = bagId;
        if (row.done) fields.done = true;
      } else if ([1, 2, 3].includes(row.prio)) fields.prio = row.prio;
      result.push(fields);
    });
  }
  const bagKeys = appendOrders(bags, newBags.length);
  newBags.forEach((bag, index) => { bag.order = bagKeys.keys[index]; });
  return { lists, bags: newBags, items: result, moves: [...moves, ...bagKeys.moves.map((move) => ({ ...move, type: 'bag' }))] };
}

/** A template `{kind, name, lists}` from list groups (validate it with `validateTemplate` before saving). */
export function templateFromGroups(groups, { kind, name, fallbackList }) {
  return {
    kind,
    name,
    lists: groups.filter((group) => group.items.length).map((group) => ({
      name: group.name || fallbackList,
      items: group.items.map((item) => {
        const entry = { name: cleanName(item.name, 200) };
        if (Number.isInteger(item.qty) && item.qty > 1 && item.qty <= 999) entry.qty = item.qty;
        if (Number.isFinite(item.grams) && item.grams > 0) entry.grams = Math.min(1_000_000, Math.round(item.grams));
        if ([1, 2, 3].includes(item.prio)) entry.prio = item.prio;
        return entry;
      }),
    })),
  };
}

export { localDate as localToday } from '../../../shared/dates.js';

export function todoFlags(todo, today) {
  const open = !todo.done && isDate(todo.due);
  return { overdue: open && todo.due < today, dueToday: open && todo.due === today };
}

/** Assigned to the caller, or unassigned in a list assigned to them. */
export function isMineTodo(todo, uid, assignees = new Map()) {
  if (todo.who) return todo.who === uid;
  return (assignees.get(normName(todo.list)) ?? []).includes(uid);
}

export function matchesTodoFilter(todo, filter, { uid, today, assignees }) {
  if (filter === 'mine') return isMineTodo(todo, uid, assignees);
  if (filter === 'overdue') return todoFlags(todo, today).overdue;
  if (filter === 'done') return Boolean(todo.done);
  return true;
}

const prioRank = (todo) => ([1, 2, 3].includes(todo.prio) ? todo.prio : 4);
/** `manual` (order), `prio` (P1 first, then order) or `due` (soonest first, undated last, then priority). */
export function sortTodos(todos, mode = 'manual') {
  const list = [...todos];
  if (mode === 'prio') return list.sort((a, b) => prioRank(a) - prioRank(b) || byOrder(a, b));
  if (mode === 'due') {
    return list.sort((a, b) => {
      const da = isDate(a.due) ? a.due : '9999-99-99';
      const db = isDate(b.due) ? b.due : '9999-99-99';
      return (da < db ? -1 : da > db ? 1 : 0) || prioRank(a) - prioRank(b) || byOrder(a, b);
    });
  }
  return list.sort(byOrder);
}

/** Open to-dos due today or earlier that are the caller's, or nobody's (no assignee and no list assignees). */
export function dueReminders(todos, { uid, today, assignees = new Map() }) {
  return todos.filter((todo) => {
    if (todo.done || !isDate(todo.due) || todo.due > today) return false;
    if (todo.who) return todo.who === uid;
    const listed = assignees.get(normName(todo.list)) ?? [];
    return listed.length === 0 || listed.includes(uid);
  });
}
