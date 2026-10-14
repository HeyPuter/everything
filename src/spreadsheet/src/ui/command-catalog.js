/**
 * Every command a person can put on the Quick Access Toolbar, on a ribbon tab of their own, or under a
 * shortcut of their own: the menus' items, the command palette's actions and the ribbon's buttons, each once,
 * by command id (lib/customize.js), with its name, icon, where it lives and its built-in shortcut.
 */
import { IS_MAC } from './dom.js';
import { menubarMenus } from './menubar.js';
import { paletteCommands } from './palette.js';
import { commandId } from '../lib/customize.js';
import { parseShortcut } from '../core/keymap.js';

export { effectiveShortcut, withCustomShortcuts } from './custom-shortcuts.js';

/** Flags that bring every menu item out, whatever is selected now (a note, a formula, a table). */
const EVERYTHING = { hasFormula: true, hasTable: true, hasNote: true, hasLink: true, canUndo: true, canRedo: true, editing: false, away: false, grouped: false, chartSheet: false };

const tidyLabel = (label) => String(label || '').replace(/…$/, '').trim();

/**
 * The catalog: [{ id, cmd, arg, label, icon, where, shortcut }] sorted by name. `ribbonEl` is the ribbon's
 * element: its buttons carry the command they run (`_command`), the Home tab's as well as the others'.
 */
export function commandCatalog(flags = {}, ribbonEl = null) {
  const out = new Map();
  const add = (entry) => {
    if (!entry.cmd || typeof entry.cmd !== 'string' || entry.arg instanceof Event) return;
    const arg = entry.arg && typeof entry.arg === 'object' && entry.arg.nodeType ? null : entry.arg ?? null;
    const id = commandId(entry.cmd, arg);
    const known = out.get(id);
    if (known) {
      // The palette's and the ribbon's names stand on their own; a menu item's leans on its menu ("Bold" under Text).
      if ((entry.rank || 0) > known.rank) { known.label = tidyLabel(entry.label); known.rank = entry.rank; }
      known.icon ||= entry.icon || null;
      known.shortcut ||= entry.shortcut || null;
      // A place already named in full (Format ▸ Wrapping) is not named again by its first part (Format).
      if (entry.where && !known.places.some((p) => p === entry.where || p.startsWith(`${entry.where} ▸`))) {
        known.places = known.places.filter((p) => !entry.where.startsWith(`${p} ▸`));
        known.places.push(entry.where);
      }
      return;
    }
    out.set(id, { id, cmd: entry.cmd, arg, label: tidyLabel(entry.label), rank: entry.rank || 0, icon: entry.icon || null, shortcut: entry.shortcut || null, places: entry.where ? [entry.where] : [] });
  };
  const f = { ...flags, ...EVERYTHING, fns: {} };
  for (const menu of menubarMenus(f)) {
    const walk = (items, path) => {
      for (const item of items) {
        if (item.submenu) walk(item.submenu, [...path, tidyLabel(item.label)]);
        else if (item.cmd && item.label) {
          // A submenu of choices (Paste special's Add, Zoom's Zoom in) is named with what it chooses among.
          const label = path.length > 1 && item.label.length < 14 && !/\s/.test(item.label.trim()) ? `${path.at(-1)}: ${item.label}` : item.label;
          add({ cmd: item.cmd, arg: item.arg, label, icon: item.icon, shortcut: item.shortcut, where: path.join(' ▸ ') });
        }
      }
    };
    walk(menu.items, [menu.label]);
  }
  for (const item of paletteCommands(f)) if (item && item.cmd) add({ ...item, where: item.section, rank: 2 });
  if (ribbonEl) {
    for (const button of ribbonEl.querySelectorAll('.tb-btn')) {
      const c = button._command;
      if (!c?.cmd) continue;
      const panel = button.closest('.ribbon-panel');
      const tabId = panel?.getAttribute('aria-labelledby');
      const tab = tabId ? [...ribbonEl.querySelectorAll('.ribbon-tab')].find((t) => t.id === tabId)?.dataset.builtinName || null : null;
      const group = button.closest('.ribbon-group')?.getAttribute('aria-label');
      // Buttons the person put on a tab of their own are not a place the command lives.
      if (button.closest('[data-custom-group]')) continue;
      add({ cmd: c.cmd, arg: c.arg, label: c.label, icon: c.glyph, where: tab ? `${tab}${group ? ` ▸ ${group}` : ''} (ribbon)` : 'Ribbon', rank: 1 });
    }
  }
  return [...out.values()].map(({ places, rank, ...entry }) => ({ ...entry, where: places.join(' · ') }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** Find commands by name, place or shortcut; every word of the query must match. */
export function searchCatalog(catalog, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return catalog;
  return catalog.filter((entry) => {
    const text = `${entry.label} ${entry.where} ${entry.shortcut || ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The built-in shortcuts: { chord: [command ids] } and { id: [chords] }. */
export function builtinShortcuts(catalog, mac = IS_MAC) {
  const byChord = {};
  const byId = {};
  for (const entry of catalog) {
    const chord = parseShortcut(entry.shortcut, mac);
    if (!chord) continue;
    (byChord[chord] ||= []).push(entry.id);
    (byId[entry.id] ||= []).push(chord);
  }
  return { byChord, byId };
}
