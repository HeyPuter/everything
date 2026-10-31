import { invariant } from '../../../shared/errors.js';
import { isId, newId } from '../../../shared/ids.js';

/** Personal categories (`me:cats`) and tags (`me:tags`). A trip copies a personal category before using it. */
export const CATEGORY_ICONS = Object.freeze([
  'map-pin', 'utensils', 'coffee', 'wine', 'bed-double', 'landmark', 'mountain', 'trees',
  'waves', 'camera', 'ticket', 'shopping-bag', 'music', 'baby', 'dumbbell', 'church',
]);
export const CATEGORY_COLORS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
export const CATALOG_LIMITS = Object.freeze({ categories: 100, tags: 200, name: 100 });
const CATEGORY_FIELDS = ['id', 'name', 'color', 'icon'];
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CATALOG_LIMITS.name) : '');

export function validateCategory(input) {
  invariant(plain(input), 'invalid_category');
  const name = text(input.name);
  invariant(name, 'category_name_required');
  invariant(isId(input.id), 'invalid_category');
  invariant(CATEGORY_COLORS.includes(input.color), 'invalid_category');
  invariant(CATEGORY_ICONS.includes(input.icon), 'invalid_category');
  return { id: input.id, name, color: input.color, icon: input.icon };
}
/** The categories this build can show; writes keep the other entries as they are. */
export function readCategories(value) {
  return (Array.isArray(value) ? value : []).flatMap((entry) => { try { return [validateCategory(entry)]; } catch { return []; } }).slice(0, CATALOG_LIMITS.categories);
}
export const tagName = text;
export function readTags(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map(text).filter((name) => name && !seen.has(name.toLocaleLowerCase()) && seen.add(name.toLocaleLowerCase())).slice(0, CATALOG_LIMITS.tags);
}
const hasTag = (tags, name, except) => tags.some((tag) => tag !== except && tag.toLocaleLowerCase() === name.toLocaleLowerCase());
const isTag = (entry, name) => typeof entry === 'string' && text(entry) === name;
// Fields a newer build added to a category survive an edit here.
const merge = (raw, category) => ({ ...Object.fromEntries(Object.entries(plain(raw) ? raw : {}).filter(([field]) => !CATEGORY_FIELDS.includes(field))), ...category });

/**
 * Writes run one at a time (across this browser's tabs when Web Locks exist) and each re-reads the account value
 * first. Two devices writing at the same moment can still lose one change. A stored value that is not a list
 * (from a newer build) is never overwritten: writes fail with `catalog_unreadable`.
 */
export function createCatalogStore({ personal, makeId = newId, locks = globalThis.navigator?.locks }) {
  let queue = Promise.resolve();
  function update(key, read, change) {
    const task = async () => {
      const current = await personal.refresh(key);
      invariant(current == null || Array.isArray(current), 'catalog_unreadable', 409);
      const next = change(current ?? []);
      await personal.set(key, next);
      return read(next);
    };
    const run = queue.then(() => (locks?.request ? locks.request(`trips-personal:${key}`, task) : task()));
    queue = run.catch(() => {});
    return run;
  }
  return {
    async categories() { return readCategories(await personal.get('me:cats')); },
    async tags() { return readTags(await personal.get('me:tags')); },
    async saveCategory(input) {
      const category = validateCategory({ ...input, id: input.id ?? makeId() });
      return update('me:cats', readCategories, (list) => {
        const index = list.findIndex((entry) => plain(entry) && entry.id === category.id);
        invariant(index !== -1 || list.length < CATALOG_LIMITS.categories, 'too_many_categories');
        return index === -1 ? [...list, category] : list.map((entry, i) => (i === index ? merge(entry, category) : entry));
      });
    },
    async removeCategory(id) { return update('me:cats', readCategories, (list) => list.filter((entry) => !(plain(entry) && entry.id === id))); },
    async addTag(input) {
      const name = text(input);
      invariant(name, 'tag_name_required');
      return update('me:tags', readTags, (list) => {
        const tags = readTags(list);
        invariant(!hasTag(tags, name), 'tag_exists');
        invariant(tags.length < CATALOG_LIMITS.tags, 'too_many_tags');
        return [...list, name];
      });
    },
    async renameTag(from, input) {
      const name = text(input);
      invariant(name, 'tag_name_required');
      return update('me:tags', readTags, (list) => {
        invariant(!hasTag(readTags(list), name, from), 'tag_exists');
        return list.map((entry) => (isTag(entry, from) ? name : entry));
      });
    },
    async removeTag(name) { return update('me:tags', readTags, (list) => list.filter((entry) => !isTag(entry, name))); },
    subscribe(listener) {
      const offs = ['me:cats', 'me:tags'].map((key) => personal.subscribe(key, () => listener()));
      return () => offs.forEach((off) => off());
    },
  };
}
