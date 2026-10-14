/**
 * The person's own arrangement of the editor's commands, kept with their other preferences (lib/user-prefs.js):
 * the Quick Access Toolbar's commands and where it sits, the ribbon's tabs and groups (core/ribbon-layout.js),
 * and custom keyboard shortcuts (core/keymap.js). Each has a listener list, so an open editor follows a
 * change at once.
 *
 * A command is named by its id: the editor command, with its argument as JSON after a colon when it takes
 * one ("bold", "fmt:\"percent\"", "insertRows:\"above\"").
 */
import { loadPref, savePref, syncPref } from './user-prefs.js';
import { normalizeLayout } from '../core/ribbon-layout.js';
import { normalizeKeymap } from '../core/keymap.js';

/** The id of an editor command with its argument. */
export function commandId(cmd, arg = null) {
  if (arg === null || arg === undefined) return String(cmd);
  return `${cmd}:${JSON.stringify(arg)}`;
}

/** { cmd, arg } from a command id. */
export function parseCommandId(id) {
  const text = String(id || '');
  const at = text.indexOf(':');
  if (at < 0) return { cmd: text, arg: null };
  try { return { cmd: text.slice(0, at), arg: JSON.parse(text.slice(at + 1)) }; } catch { return { cmd: text, arg: null }; }
}

function store(pref, normalize, fallback) {
  let current = null;
  const listeners = new Set();
  const get = () => (current ??= normalize(loadPref(pref, fallback)));
  const tell = () => { for (const fn of [...listeners]) { try { fn(current); } catch (e) { console.error(e); } } };
  return {
    get,
    set(next) {
      current = normalize(next);
      savePref(pref, current);
      tell();
      return current;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async sync() {
      const value = await syncPref(pref, fallback);
      const before = JSON.stringify(get());
      current = normalize(value);
      if (JSON.stringify(current) !== before) tell();
      return current;
    },
    reload() { current = null; get(); tell(); },
  };
}

/* ---------- Quick Access Toolbar ---------- */

export const DEFAULT_QUICK_ACCESS = Object.freeze({ items: ['save', 'undo', 'redo'], below: false, labels: false });

export function normalizeQuickAccess(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(src.items) ? [...new Set(src.items.filter((id) => typeof id === 'string' && id && id.length <= 400))].slice(0, 40) : [...DEFAULT_QUICK_ACCESS.items];
  return { items, below: src.below === true, labels: src.labels === true };
}

export const quickAccessStore = store('quick-access', normalizeQuickAccess, null);

/** Add a command to the Quick Access Toolbar (at the end); false when it is there already. */
export function addToQuickAccess(id) {
  const qat = quickAccessStore.get();
  if (qat.items.includes(id)) return false;
  quickAccessStore.set({ ...qat, items: [...qat.items, id] });
  return true;
}

export function removeFromQuickAccess(id) {
  const qat = quickAccessStore.get();
  quickAccessStore.set({ ...qat, items: qat.items.filter((x) => x !== id) });
}

/* ---------- Ribbon ---------- */

export const ribbonLayoutStore = store('ribbon-layout', normalizeLayout, null);

/* ---------- Keyboard ---------- */

export const keymapStore = store('keyboard', normalizeKeymap, null);

/** Bring in every customization the account keeps (another device may have changed them). */
export function syncCustomizations() {
  return Promise.all([quickAccessStore.sync(), ribbonLayoutStore.sync(), keymapStore.sync()]).catch(() => {});
}
