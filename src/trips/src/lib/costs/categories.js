import { isOrder } from '../../shared/order.js';

/** The built-in cost categories in their default order; `icon` names resolve in the costs view. */
export const COST_CATEGORIES = Object.freeze([
  { id: 'accommodation', icon: 'bed-double' },
  { id: 'food', icon: 'utensils' },
  { id: 'groceries', icon: 'shopping-basket' },
  { id: 'transport', icon: 'bus' },
  { id: 'flights', icon: 'plane' },
  { id: 'activities', icon: 'ticket' },
  { id: 'sightseeing', icon: 'landmark' },
  { id: 'shopping', icon: 'shopping-bag' },
  { id: 'fees', icon: 'receipt' },
  { id: 'health', icon: 'heart-pulse' },
  { id: 'tips', icon: 'hand-coins' },
  { id: 'fuel', icon: 'fuel' },
  { id: 'parking', icon: 'square-parking' },
  { id: 'other', icon: 'circle-ellipsis' },
].map(Object.freeze));
export const CATEGORY_IDS = Object.freeze(COST_CATEGORIES.map((category) => category.id));
export const isBuiltinCategory = (id) => CATEGORY_IDS.includes(id);

/**
 * Category ids in display order: those with a `costCat` order first (the lowest key wins when two members ordered
 * the same category at once), then the remaining built-ins in their default order.
 */
export function orderedCategories(costCats = []) {
  const best = new Map();
  for (const entry of costCats) {
    if (!isBuiltinCategory(entry?.cat) || !isOrder(entry.order)) continue;
    const current = best.get(entry.cat);
    if (!current || entry.order < current.order || (entry.order === current.order && entry.id < current.id)) best.set(entry.cat, entry);
  }
  const ordered = [...best.values()].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1)).map((entry) => entry.cat);
  return [...ordered, ...CATEGORY_IDS.filter((id) => !best.has(id))];
}
