/**
 * Custom shortcuts meet the menus here: the shortcut a menu item (or a ribbon tooltip, or the command palette)
 * shows is rewritten to the keys that run its command now (see core/keymap.js and lib/customize.js).
 */
import { IS_MAC } from './dom.js';
import { commandId, keymapStore } from '../lib/customize.js';
import { parseShortcut, formatChord, chordsFor } from '../core/keymap.js';

/**
 * The shortcut a menu item shows, given the custom shortcuts: its own keys unless they were taken or turned
 * off, else the first custom chord that runs it; null for none.
 */
export function effectiveShortcut(item, keymap = keymapStore.get(), mac = IS_MAC) {
  if (!item?.cmd) return item?.shortcut ?? null;
  const id = commandId(item.cmd, item.arg ?? null);
  const own = parseShortcut(item.shortcut, mac);
  if (!Object.keys(keymap).length) return item.shortcut ?? null;
  const chords = chordsFor(id, own ? [own] : [], keymap);
  if (own && chords.includes(own)) return item.shortcut;
  // Shortcut hints that are not one key press ("Delete", a gesture) are kept as written.
  if (!own && item.shortcut && !chords.length) return item.shortcut;
  return chords.length ? formatChord(chords[0], mac) : null;
}

/** Menu items (with submenus) showing the shortcuts in force. */
export function withCustomShortcuts(items, keymap = keymapStore.get(), mac = IS_MAC) {
  if (!Object.keys(keymap).length) return items;
  return items.map((item) => {
    if (!item || item.separator || item.header) return item;
    if (item.submenu) return { ...item, submenu: withCustomShortcuts(item.submenu, keymap, mac) };
    if (!item.cmd) return item;
    const shortcut = effectiveShortcut(item, keymap, mac);
    return shortcut === (item.shortcut ?? null) ? item : { ...item, shortcut: shortcut ?? undefined };
  });
}
