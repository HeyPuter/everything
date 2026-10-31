// Place categories ↔ GPX `<sym>` names. Built-ins export as common GPS symbol names; trip categories as their name.

export const CATEGORY_SYMBOLS = Object.freeze({
  hotel: 'Lodging', restaurant: 'Restaurant', attraction: 'Scenic Area', shopping: 'Shopping Center',
  transport: 'Ground Transportation', activity: 'Amusement Park', bar: 'Bar', beach: 'Beach', nature: 'Park', other: 'Flag, Blue',
});

const ALIASES = Object.freeze({
  lodging: 'hotel', hotel: 'hotel', motel: 'hotel', hostel: 'hotel', campground: 'hotel', 'rv park': 'hotel',
  restaurant: 'restaurant', 'fast food': 'restaurant', pizza: 'restaurant', 'restaurant, chinese': 'restaurant', cafe: 'bar',
  'scenic area': 'attraction', museum: 'attraction', 'civil': 'attraction', church: 'attraction', castle: 'attraction', monument: 'attraction', 'flag, red': 'attraction',
  'shopping center': 'shopping', shopping: 'shopping', 'department store': 'shopping', 'convenience store': 'shopping', 'shopping cart': 'shopping',
  'ground transportation': 'transport', airport: 'transport', 'train station': 'transport', 'bus station': 'transport', 'car rental': 'transport', 'gas station': 'transport', 'parking area': 'transport',
  'amusement park': 'activity', stadium: 'activity', 'movie theater': 'activity', 'live theater': 'activity', zoo: 'activity', 'golf course': 'activity', 'ski resort': 'activity',
  bar: 'bar', 'drinking water': 'bar', winery: 'bar',
  beach: 'beach', 'swimming area': 'beach', marina: 'beach',
  park: 'nature', forest: 'nature', summit: 'nature', 'trail head': 'nature', 'picnic area': 'nature', lake: 'nature', 'scenic viewpoint': 'nature',
  'flag, blue': 'other', waypoint: 'other', 'flag, green': 'other', pin: 'other',
});

const key = (value) => (typeof value === 'string' ? value.trim().toLocaleLowerCase() : '');

/**
 * Category id for an imported feature from its `category`, `sym` and `type` strings. `builtins` maps lowercase built-in
 * ids and display names to ids; `cats` are the trip's category entities. Returns undefined when nothing matches.
 */
export function categoryFor(candidates, { builtins = new Map(), cats = [] } = {}) {
  const tripCats = new Map(cats.map((cat) => [key(cat.name), cat.id]));
  for (const value of candidates) {
    const name = key(value);
    if (!name) continue;
    if (builtins.has(name)) return builtins.get(name);
    if (tripCats.has(name)) return tripCats.get(name);
    if (Object.hasOwn(ALIASES, name)) return ALIASES[name];
  }
  return undefined;
}

/** `<sym>` for a place's category: the built-in's symbol name, or the trip category's name. */
export function symbolFor(cat, catName) {
  if (cat && Object.hasOwn(CATEGORY_SYMBOLS, cat)) return CATEGORY_SYMBOLS[cat];
  return catName || undefined;
}

const GARMIN = Object.freeze({ red: 6, darkred: 6, green: 7, darkgreen: 7, blue: 1, darkblue: 5, magenta: 4, darkmagenta: 8, cyan: 2, darkcyan: 2, yellow: 3, darkyellow: 3 });

/** A stored track color: `#rrggbb` as given, a Garmin color name as a day slot, else undefined. */
export function trackColor(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^#?[0-9a-f]{6}$/i.test(text)) return `#${text.replace('#', '').toLowerCase()}`;
  return GARMIN[text.toLowerCase()];
}
