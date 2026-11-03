import { invariant } from '../../../shared/errors.js';
import { isId, newId } from '../../../shared/ids.js';

/**
 * Personal packing and to-do templates: `me:tpl:<id>` holds the template, `me:tpls` an index of summaries
 * (one path per template, so listing needs no `kv.list`). Trip lists apply them by appending items.
 */
export const TEMPLATE_KINDS = Object.freeze(['pack', 'todo']);
export const TEMPLATE_LIMITS = Object.freeze({ name: 100, lists: 50, listName: 100, items: 500, itemName: 200, fileBytes: 256 * 1024 });
export const TEMPLATE_FILE = 'trips-template';
const INDEX = 'me:tpls';
const key = (id) => { invariant(isId(id), 'invalid_id'); return `me:tpl:${id}`; };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function item(raw) {
  const value = typeof raw === 'string' ? { name: raw } : raw;
  invariant(plain(value), 'invalid_template');
  const name = text(value.name, TEMPLATE_LIMITS.itemName);
  invariant(name, 'invalid_template');
  const result = { name };
  if (Number.isInteger(value.qty) && value.qty > 1 && value.qty <= 999) result.qty = value.qty;
  if (Number.isInteger(value.grams) && value.grams >= 0 && value.grams <= 1_000_000) result.grams = value.grams;
  if ([1, 2, 3].includes(value.prio)) result.prio = value.prio;
  return result;
}

/** Normalized `{kind, name, lists}`; throws `invalid_template` (or a more specific code) when unusable. */
export function validateTemplate(input) {
  invariant(plain(input) && TEMPLATE_KINDS.includes(input.kind), 'invalid_template');
  const name = text(input.name, TEMPLATE_LIMITS.name);
  invariant(name, 'template_name_required');
  invariant(Array.isArray(input.lists) && input.lists.length > 0, 'invalid_template');
  invariant(input.lists.length <= TEMPLATE_LIMITS.lists, 'template_too_large');
  let count = 0;
  const lists = input.lists.map((list) => {
    invariant(plain(list) && Array.isArray(list.items), 'invalid_template');
    const listName = text(list.name, TEMPLATE_LIMITS.listName);
    invariant(listName, 'list_name_required');
    count += list.items.length;
    invariant(count <= TEMPLATE_LIMITS.items, 'template_too_large');
    return { name: listName, items: list.items.map(item) };
  });
  return { kind: input.kind, name, lists };
}
export const itemCount = (template) => template.lists.reduce((sum, list) => sum + list.items.length, 0);

const QUANTITY = /^(\d{1,3})\s*[x×]\s+(.+)$/i;
/** One item per line; `3x Socks` sets a quantity. Weight and priority carry over from `previous` items of the same name. */
export function parseItems(source, previous = []) {
  const spare = [...previous];
  return String(source ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = QUANTITY.exec(line);
    const qty = match ? Number(match[1]) : 1;
    const name = text(match ? match[2] : line, TEMPLATE_LIMITS.itemName);
    const index = spare.findIndex((entry) => entry.name === name);
    const [kept] = index === -1 ? [{}] : spare.splice(index, 1);
    return item({ ...kept, name, qty: qty > 1 ? qty : undefined });
  }).filter((entry) => entry.name);
}
export function itemsText(items) {
  return items.map((entry) => (entry.qty > 1 ? `${entry.qty}x ${entry.name}` : entry.name)).join('\n');
}

export function templateFileName(name) {
  const base = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'template';
  return `${base}.${TEMPLATE_FILE}.json`;
}
export function templateFile(template) {
  const clean = validateTemplate(template);
  return new Blob([JSON.stringify({ format: TEMPLATE_FILE, version: 1, template: clean }, null, 2)], { type: 'application/json' });
}
/** Parses a shared template file; throws `invalid_template_file` for anything else. */
export function parseTemplateFile(source) {
  invariant(typeof source === 'string' && new Blob([source]).size <= TEMPLATE_LIMITS.fileBytes, 'template_file_too_large');
  let data;
  try { data = JSON.parse(source); } catch { invariant(false, 'invalid_template_file'); }
  invariant(plain(data) && data.format === TEMPLATE_FILE && data.version === 1, 'invalid_template_file');
  try { return validateTemplate(data.template); } catch { invariant(false, 'invalid_template_file'); }
}

const summary = (template, upd) => ({ kind: template.kind, name: template.name, items: itemCount(template), upd });
function indexEntries(value) {
  if (!plain(value)) return [];
  return Object.entries(value).flatMap(([id, entry]) => (isId(id) && plain(entry) && TEMPLATE_KINDS.includes(entry.kind) && typeof entry.name === 'string'
    ? [{ id, kind: entry.kind, name: entry.name.slice(0, TEMPLATE_LIMITS.name), items: Number.isSafeInteger(entry.items) ? entry.items : 0, upd: Number.isSafeInteger(entry.upd) ? entry.upd : 0 }]
    : []));
}

/** `personal` is the store from `createPersonalStore`; `puter.kv` handles index path writes and deletes. */
export function createTemplateStore({ personal, puter, makeId = newId, now = Date.now }) {
  const session = puter.authToken;
  // Direct KV calls bypass the personal store, so they check the session themselves.
  const kv = (method, ...args) => { invariant(puter.authToken === session, 'account_changed', 401); return puter.kv[method](...args); };
  async function writeIndex(id, value) {
    await kv('update', INDEX, { [id]: value });
    await personal.refresh(INDEX);
  }
  const store = {
    /** Summaries sorted by name: `[{id, kind, name, items, upd}]`. */
    async list({ fresh = false } = {}) {
      return indexEntries(await personal.get(INDEX, { fresh })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
    async get(id) {
      const value = await personal.get(key(id), { fresh: true });
      if (value == null) return null;
      return { id, ...validateTemplate(value) };
    },
    async create(template) {
      const clean = validateTemplate(template);
      const id = makeId(); const upd = now();
      await personal.set(key(id), { ...clean, upd });
      // Without its index entry the template is unreachable, so it is deleted again.
      try { await kv('update', INDEX, { [id]: summary(clean, upd) }); }
      catch (error) { await kv('del', key(id)).catch(() => {}); throw error; }
      await personal.refresh(INDEX);
      return id;
    },
    async save(id, template) {
      const clean = validateTemplate(template); const upd = now();
      await personal.set(key(id), { ...clean, upd });
      await writeIndex(id, summary(clean, upd));
    },
    async rename(id, name) {
      const current = await store.get(id);
      invariant(current, 'gone', 404);
      await store.save(id, { ...current, name });
    },
    async remove(id) {
      const itemKey = key(id);
      // Template first: a failure after it leaves an index entry that `forget` clears, never an unreachable template.
      await kv('del', itemKey);
      await kv('remove', INDEX, id);
      await personal.refresh(INDEX);
      await personal.refresh(itemKey).catch(() => {});
    },
    /** Drops an index entry whose template no longer exists (deleted on another device). */
    async forget(id) { key(id); await kv('remove', INDEX, id); await personal.refresh(INDEX); },
    subscribe(listener) { return personal.subscribe(INDEX, () => listener()); },
  };
  return store;
}
