// Quick Favorites (Q): menu items and operator buttons the user collects by right-clicking them
// (Add to Quick Favorites).
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { itemContextHooks, type MenuItem } from './menu';

interface Favorite {
  label: string;
  op: string;
  props?: Record<string, unknown>;
  icon?: string;
}

const KEY = 'p3d.quickfavorites.v1';

function load(): Favorite[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((f) => f && typeof f.op === 'string' && typeof f.label === 'string') : [];
  } catch {
    return [];
  }
}

let favorites: Favorite[] = load();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(favorites));
  } catch {
    // storage unavailable: favorites last for this session
  }
}

const same = (f: Favorite, item: MenuItem) => f.op === item.op && JSON.stringify(f.props ?? {}) === JSON.stringify(item.props ?? {});

export function quickFavorites(): readonly Favorite[] {
  return favorites;
}

export function addFavorite(item: MenuItem) {
  if (!item.op || favorites.some((f) => same(f, item))) return;
  favorites.push({ label: item.label ?? item.op, op: item.op, props: item.props ? structuredClone(item.props) : undefined, icon: item.icon });
  save();
  app.report('INFO', `Added "${item.label ?? item.op}" to Quick Favorites`);
}

export function removeFavorite(item: MenuItem) {
  favorites = favorites.filter((f) => !same(f, item));
  save();
}

export function favoritesMenu(): MenuItem[] {
  if (!favorites.length) return [{ heading: 'Right-click any menu item to add it here' }];
  return favorites.map((f) => ({ label: f.label, icon: f.icon, op: f.op, props: f.props }));
}

/** Add to / Remove from Quick Favorites for an operator call (menu items and operator buttons). */
export function favoriteMenuItem(item: MenuItem): MenuItem {
  const fav = favorites.some((f) => same(f, item));
  return fav ? { label: 'Remove from Quick Favorites', icon: 'remove', action: () => removeFavorite(item) } : { label: 'Add to Quick Favorites', icon: 'add', action: () => addFavorite(item) };
}

itemContextHooks.push((item) => (item.op ? [favoriteMenuItem(item)] : []));

addKeys('Window', [{ key: 'Q', menu: favoritesMenu, menuTitle: 'Quick Favorites' }]);
