/**
 * Project parameters: fields the user adds to categories of elements, such
 * as "Fire Rating" on walls and doors. Their values live in each element's
 * `params` map and show in the properties palette, schedules and filters.
 *
 *   projectParam { name, type: 'text' | 'number' | 'length' | 'bool', categories: [categoryId], group }
 */
import { categoryOf } from './catalog.js';

export const PARAM_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'length', label: 'Length' },
  { value: 'bool', label: 'Yes/No' },
];

export const PARAM_GROUPS = ['Identity Data', 'Constraints', 'Construction', 'Dimensions', 'Other'];

export function projectParams(doc) {
  return doc.all('projectParam').sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Project parameters that apply to an element (by its category). */
export function paramsForElement(doc, el) {
  const cat = categoryOf(el, doc);
  if (!cat) return [];
  return projectParams(doc).filter((p) => p.categories?.includes(cat));
}

/** Properties-palette descriptors for an element's project parameters. */
export function paramDescriptors(doc, el) {
  return paramsForElement(doc, el).map((p) => ({
    key: `param:${p.id}`,
    label: p.name,
    group: p.group || 'Identity Data',
    type: p.type === 'bool' ? 'bool' : p.type === 'length' ? 'length' : p.type === 'number' ? 'number' : 'text',
    get: (e) => e.params?.[p.id] ?? (p.type === 'bool' ? false : p.type === 'text' ? '' : null),
    set: (e, v) => ({ params: { ...(e.params || {}), [p.id]: p.type === 'number' || p.type === 'length' ? +v : v } }),
  }));
}

/** Schedule fields for the project parameters of the categories an element kind belongs to. */
export function paramFields(doc, kinds, categoryOfKind) {
  const cats = new Set(kinds.map(categoryOfKind).filter(Boolean));
  return projectParams(doc)
    .filter((p) => p.categories?.some((c) => cats.has(c) || cats.has('*')))
    .map((p) => ({
      id: `param:${p.id}`,
      label: p.name,
      get: (el) => {
        const v = el.params?.[p.id];
        if (p.type === 'bool') return v ? 'Yes' : 'No';
        return v ?? '';
      },
      type: p.type === 'length' ? 'length' : p.type === 'number' ? 'number' : 'text',
      editParam: p.type === 'text' ? p.id : null,
    }));
}
