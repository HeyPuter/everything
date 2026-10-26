// Place categories: the ten built-ins (client constants, never stored) plus the trip's `cat` entities. Colors are
// day-token slots 1–8 (or a token name), so swatches and markers keep their contrast in both themes.
import { t } from './i18n/index.js';
import { CATEGORY_ICONS } from '../views/settings/data/catalog.js';
import { newId } from '../shared/ids.js';

export const BUILTIN_CATEGORIES = Object.freeze([
  { id: 'hotel', icon: 'bed-double', color: 5 },
  { id: 'restaurant', icon: 'utensils', color: 3 },
  { id: 'attraction', icon: 'landmark', color: 6 },
  { id: 'shopping', icon: 'shopping-bag', color: 4 },
  { id: 'transport', icon: 'train-front', color: 8 },
  { id: 'activity', icon: 'ticket', color: 1 },
  { id: 'bar', icon: 'wine', color: 2 },
  { id: 'beach', icon: 'waves', color: 1 },
  { id: 'nature', icon: 'trees', color: 7 },
  { id: 'other', icon: 'map-pin', color: 'ink-2' },
].map((entry) => Object.freeze(entry)));
const BUILTIN = new Map(BUILTIN_CATEGORIES.map((entry) => [entry.id, entry]));
// Older and imported ids that mean a built-in.
const ALIASES = Object.freeze({ cafe: 'bar', food: 'restaurant', sights: 'attraction', museum: 'attraction', lodging: 'hotel', activities: 'activity' });
/** Icons a trip category may use (the worker checks the same list). */
export const CAT_ICONS = Object.freeze([...CATEGORY_ICONS, 'bus']);
export const CAT_COLORS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
export const CAT_NAME_MAX = 100;

/** Explore categories on the map, with the built-in category a place picked from them starts with. */
export const EXPLORE_CATEGORIES = Object.freeze({
  food: { cat: 'restaurant', icon: 'utensils' },
  cafe: { cat: 'bar', icon: 'coffee' },
  bar: { cat: 'bar', icon: 'wine' },
  lodging: { cat: 'hotel', icon: 'bed-double' },
  sights: { cat: 'attraction', icon: 'landmark' },
  museum: { cat: 'attraction', icon: 'building-2' },
  nature: { cat: 'nature', icon: 'trees' },
  activities: { cat: 'activity', icon: 'ferris-wheel' },
});

const ICONS = new Set([...CAT_ICONS, ...BUILTIN_CATEGORIES.map((entry) => entry.icon)]);
const HEX = /^#[0-9a-fA-F]{6}$/;
const TOKEN = /^[a-z][a-z0-9-]{0,30}$/;
const builtinId = (id) => (BUILTIN.has(id) ? id : Object.hasOwn(ALIASES, id) ? ALIASES[id] : null);
export const isBuiltin = (id) => BUILTIN.has(id);
const builtin = (entry) => ({ ...entry, name: t(`places.cat.${entry.id}`), builtin: true });

/** CSS value for a category color: a day token for slots 1–8, a stored hex color as is, or a token name. */
export function categoryColor(color) {
  if (Number.isInteger(color) && color >= 1 && color <= 8) return `var(--day-${color})`;
  if (typeof color === 'string' && HEX.test(color)) return color;
  if (typeof color === 'string' && TOKEN.test(color)) return `var(--${color}, var(--ink-2))`;
  return 'var(--ink-2)';
}

/** `{id, name, icon, color, builtin, missing?}` for a place's `cat`; unknown or absent ids read as "Other". */
export function categoryOf(space, id) {
  const known = id ? builtinId(id) : null;
  if (known) return builtin(BUILTIN.get(known));
  const entity = id ? space?.get?.('cat', id) : null;
  if (entity && !entity.deleted) {
    return { id: entity.id, name: entity.name, icon: ICONS.has(entity.icon) ? entity.icon : 'map-pin', color: entity.color, builtin: false };
  }
  return { ...builtin(BUILTIN.get('other')), ...(id ? { missing: true } : {}) };
}

/**
 * How the map draws a category: `{tone?, color?, icon, label}`. `tone` is a day slot or token name the map resolves;
 * `color` a stored `#rrggbb` it draws as is. Unknown custom ids draw as "Other" with no label.
 */
export function categoryStyle(id, space) {
  const category = categoryOf(space, id);
  const label = category.missing ? '' : category.name ?? '';
  const { color } = category;
  if (Number.isInteger(color) && color >= 1 && color <= 8) return { tone: color, icon: category.icon, label };
  if (typeof color === 'string' && HEX.test(color)) return { color, icon: category.icon, label };
  return { tone: typeof color === 'string' && TOKEN.test(color) ? color : 'ink-2', icon: category.icon, label };
}

/** The trip's custom categories by name. */
export function tripCategories(space) {
  return [...(space?.select?.cat?.all() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

/** Built-ins then the trip's own categories. */
export function allCategories(space) {
  return [...BUILTIN_CATEGORIES.map(builtin), ...tripCategories(space).map((entity) => categoryOf(space, entity.id))];
}

const sameName = (a, b) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * A personal category is copied into the trip before a place uses it. Reuses a trip category with the same name;
 * otherwise returns the create op to apply with the place change.
 */
export function adoptPersonalCategory(space, personal, { makeId = newId } = {}) {
  const existing = tripCategories(space).find((entity) => sameName(entity.name, personal.name));
  if (existing) return { id: existing.id, ops: [] };
  const id = makeId();
  const fields = { name: personal.name.trim().slice(0, CAT_NAME_MAX), color: CAT_COLORS.includes(personal.color) ? personal.color : 2, icon: CAT_ICONS.includes(personal.icon) ? personal.icon : 'map-pin' };
  return { id, ops: [space.ops.create('cat', fields, { id })] };
}

// OSM key/value → built-in category, for places picked from search.
const OSM_RULES = [
  [/^tourism\.(hotel|hostel|guest_house|motel|apartment|camp_site|chalet|alpine_hut)$/, 'hotel'],
  [/^amenity\.(restaurant|fast_food|food_court)$/, 'restaurant'],
  [/^amenity\.(cafe|bar|pub|biergarten|ice_cream)$/, 'bar'],
  [/^shop\./, 'shopping'],
  [/^amenity\.marketplace$/, 'shopping'],
  [/^(railway|public_transport|aeroway)\./, 'transport'],
  [/^amenity\.(bus_station|ferry_terminal|car_rental|bicycle_rental|taxi)$/, 'transport'],
  [/^natural\.beach$/, 'beach'],
  [/^leisure\.beach_resort$/, 'beach'],
  [/^(natural|boundary)\./, 'nature'],
  [/^leisure\.(park|nature_reserve|garden)$/, 'nature'],
  [/^(tourism\.(attraction|museum|gallery|viewpoint|artwork)|historic\.)/, 'attraction'],
  [/^amenity\.(place_of_worship|townhall)$/, 'attraction'],
  [/^(tourism\.(theme_park|zoo|aquarium)|leisure\.|amenity\.(theatre|cinema|arts_centre|nightclub))/, 'activity'],
];
export function guessCategory(kind) {
  if (!kind?.key || !kind?.value) return null;
  const tag = `${kind.key}.${kind.value}`;
  return OSM_RULES.find(([pattern]) => pattern.test(tag))?.[1] ?? null;
}
