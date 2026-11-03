import { invariant } from '../../shared/errors.js';
import { schemas } from '../../shared/schema/index.js';

const byOrder = (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byCreated = (a, b) => (a.cr ?? 0) - (b.cr ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Typed selectors for every entity type of a kind, generated from `src/shared/schema`. Results are frozen and cached
 * per store revision, so an unchanged type returns the same array and views can compare by identity.
 * `source(type)` returns the entities to select from (the facade adds private items there).
 */
export function createSelectors({ kind, source, get, subscribe }) {
  invariant(Object.hasOwn(schemas, kind), 'unknown_kind');
  const sorted = new WeakMap();
  const grouped = new WeakMap();
  const select = {};
  for (const [type, schema] of Object.entries(schemas[kind])) {
    const compare = Object.hasOwn(schema.fields, 'order') ? byOrder : byCreated;
    const all = () => {
      const items = source(type);
      if (!sorted.has(items)) sorted.set(items, Object.freeze([...items].sort(compare)));
      return sorted.get(items);
    };
    select[type] = Object.freeze({
      type,
      fields: Object.freeze(Object.keys(schema.fields)),
      ordered: compare === byOrder,
      all,
      get: (id) => get(type, id),
      count: () => source(type).length,
      where: (predicate) => all().filter(predicate),
      by: (field, value) => all().filter((entity) => entity[field] === value),
      /** `Map<value, entity[]>` for one field, cached with the type's entities, e.g. visits by `dayId`. */
      groupBy(field) {
        const items = all();
        let fields = grouped.get(items);
        if (!fields) grouped.set(items, fields = new Map());
        if (!fields.has(field)) {
          const groups = new Map();
          for (const entity of items) { const key = entity[field] ?? null; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entity); }
          for (const list of groups.values()) Object.freeze(list);
          fields.set(field, groups);
        }
        return fields.get(field);
      },
      subscribe: (listener) => subscribe(type, listener),
    });
  }
  return Object.freeze(select);
}
