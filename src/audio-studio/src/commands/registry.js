/**
 * Command registry. Every menu item, shortcut, context-menu entry and
 * button that edits the document runs a command by id, so behavior, enabled
 * state and the shortcut label live in one place.
 *
 *   commands.register({
 *     id: 'object.group', label: 'Group', shortcut: 'Mod+G',
 *     enabled: (app) => app.editor?.selection.size > 0,
 *     run: (app, args) => { ... },
 *   })
 *
 * Shortcut syntax: modifiers joined with '+': Mod (Command on macOS, Ctrl
 * elsewhere), Ctrl, Alt (Option), Shift, then the key as KeyboardEvent.key
 * (single characters case-insensitive) or a name like ArrowUp, Delete.
 */
import { isUserError } from '../lib/errors.js';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

export class CommandRegistry {
  constructor(app) {
    this.app = app;
    this.commands = new Map();
    this.byShortcut = new Map();
    /** User remappings: id -> shortcut strings (an empty list removes the shortcut). */
    this.overrides = new Map(Object.entries(app?.prefs?.get?.('shortcuts') || {}));
    /** Observers told before and after each command runs ({ before(id, args), after(id, args) }). */
    this.watchers = new Set();
  }

  /** Watches command runs (favorite recording); returns a function that stops watching. */
  watch(w) {
    this.watchers.add(w);
    return () => this.watchers.delete(w);
  }

  register(def) {
    if (Array.isArray(def)) {
      for (const d of def) this.register(d);
      return;
    }
    this.commands.set(def.id, def);
    for (const s of this.keysFor(def.id)) this.byShortcut.set(normalizeShortcut(s), def.id);
  }

  /** Default shortcuts a command was registered with. */
  defaultKeys(id) {
    const c = this.commands.get(id);
    return c ? [].concat(c.shortcut || [], c.altShortcuts || []) : [];
  }

  /** Effective shortcuts (user remapping or defaults). */
  keysFor(id) {
    return this.overrides.has(id) ? this.overrides.get(id) : this.defaultKeys(id);
  }

  /** Command currently bound to a shortcut, or null. */
  commandFor(shortcut) {
    return this.byShortcut.get(normalizeShortcut(shortcut)) || null;
  }

  /** Replaces a command's shortcuts; a shortcut taken by another command moves here. */
  setShortcuts(id, keys) {
    for (const k of keys) {
      const other = this.commandFor(k);
      if (other && other !== id) this.overrides.set(other, this.keysFor(other).filter((x) => normalizeShortcut(x) !== normalizeShortcut(k)));
    }
    this.overrides.set(id, keys.slice());
    this.#persist();
  }

  /** Replaces every user remapping at once (shortcut sets). */
  replaceOverrides(map) {
    this.overrides = new Map(Object.entries(map || {}).map(([id, keys]) => [id, keys.slice()]));
    this.#persist();
  }

  resetShortcuts(id) {
    if (id) {
      this.overrides.delete(id);
      // Default keys that were moved to other commands come back from them.
      for (const k of this.defaultKeys(id)) {
        const n = normalizeShortcut(k);
        for (const other of this.commands.keys()) {
          if (other !== id && this.keysFor(other).some((x) => normalizeShortcut(x) === n)) this.overrides.set(other, this.keysFor(other).filter((x) => normalizeShortcut(x) !== n));
        }
      }
    } else this.overrides.clear();
    this.#persist();
  }

  /** Re-reads user shortcuts from preferences (after settings were imported or reset). */
  reloadShortcuts() {
    this.overrides = new Map(Object.entries(this.app?.prefs?.get?.('shortcuts') || {}));
    this.byShortcut.clear();
    for (const id of this.commands.keys()) for (const s of this.keysFor(id)) this.byShortcut.set(normalizeShortcut(s), id);
  }

  #persist() {
    this.byShortcut.clear();
    for (const id of this.commands.keys()) for (const s of this.keysFor(id)) this.byShortcut.set(normalizeShortcut(s), id);
    this.app?.prefs?.set?.('shortcuts', Object.fromEntries(this.overrides));
  }

  /**
   * The effective definition: a document kind may override a shared command
   * (e.g. Cut in the multitrack editor) through documentKinds[kind].commands[id].
   */
  get(id) {
    const base = this.commands.get(id);
    const kind = this.app.active && this.app.documentKinds?.get(this.app.active.kind);
    const over = kind?.commands?.[id];
    if (!over) return base;
    return { ...(base || { id, label: id }), ...over };
  }

  isEnabled(id, args) {
    const c = this.get(id);
    if (!c) return false;
    try {
      return c.enabled ? Boolean(c.enabled(this.app, args)) : true;
    } catch {
      return false;
    }
  }

  isChecked(id, args) {
    const c = this.get(id);
    return Boolean(c?.checked?.(this.app, args));
  }

  label(id) {
    const c = this.get(id);
    if (!c) return id;
    return typeof c.label === 'function' ? c.label(this.app) : c.label;
  }

  async run(id, args) {
    const c = this.get(id);
    if (!c) {
      console.warn(`Unknown command ${id}`);
      return undefined;
    }
    if (!this.isEnabled(id, args)) return undefined;
    try {
      for (const w of this.watchers) w.before?.(id, args);
      const result = await c.run(this.app, args);
      for (const w of this.watchers) w.after?.(id, args);
      if (c.repeatable) this.app.lastCommand = { id, args };
      return result;
    } catch (err) {
      // Validation messages (UserError) are expected: a notification is enough.
      if (!isUserError(err)) console.error(err);
      this.app.notify?.(err?.message || 'Something went wrong.', { error: true });
      return undefined;
    }
  }

  /** Command id for a keyboard event, or null. */
  match(ev) {
    return this.byShortcut.get(eventShortcut(ev)) || null;
  }

  /** Menu label: the first key the browser lets the page have. */
  shortcutLabel(id) {
    const key = this.keysFor(id).find((k) => !browserReserved(k));
    return key ? formatShortcut(key) : '';
  }
}

// Keys a browser tab never receives (new/close tab or window, quit, tab
// switching; on macOS also minimize, hide and window cycling).
const RESERVED = new Set(['mod+n', 'mod+shift+n', 'mod+t', 'mod+shift+t', 'mod+w', 'mod+shift+w', 'mod+q', 'f11']);
const RESERVED_MAC = new Set(['ctrl+tab', 'ctrl+shift+tab', 'mod+m', 'mod+h', 'mod+alt+h', 'mod+`', 'mod+shift+`']);
const RESERVED_OTHER = new Set(['mod+tab', 'mod+shift+tab', 'mod+pageup', 'mod+pagedown', 'mod+shift+q', 'alt+f4']);

/** Whether the browser keeps this shortcut for itself, so a page cannot use it. */
export function browserReserved(shortcut, mac = IS_MAC) {
  const k = normalizeShortcut(shortcut);
  return RESERVED.has(k) || (mac ? RESERVED_MAC.has(k) : RESERVED_OTHER.has(k));
}

const KEY_ALIASES = { esc: 'escape', del: 'delete', space: ' ', plus: '+', return: 'enter' };

export function normalizeShortcut(s) {
  const parts = s.split(/\+(?!$)/).map((p) => p.trim());
  const key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  let k = key.toLowerCase();
  k = KEY_ALIASES[k] || k;
  const mod = mods.has('mod') || (IS_MAC ? mods.has('cmd') || mods.has('meta') : mods.has('ctrl'));
  const ctrl = IS_MAC ? mods.has('ctrl') : false;
  return [mod ? 'mod' : '', ctrl ? 'ctrl' : '', mods.has('alt') ? 'alt' : '', mods.has('shift') ? 'shift' : '', k].filter(Boolean).join('+');
}

/** Key name from a KeyboardEvent that ignores what Shift/Alt do to the character. */
export function eventKey(ev) {
  const code = ev.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const map = {
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Slash: '/',
    Period: '.',
    Comma: ',',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    NumpadAdd: '+',
    NumpadSubtract: '-',
    Space: ' ',
  };
  if (map[code]) return map[code];
  return (ev.key || '').toLowerCase();
}

export function eventShortcut(ev) {
  const mod = IS_MAC ? ev.metaKey : ev.ctrlKey;
  const ctrl = IS_MAC ? ev.ctrlKey : false;
  return [mod ? 'mod' : '', ctrl ? 'ctrl' : '', ev.altKey ? 'alt' : '', ev.shiftKey ? 'shift' : '', eventKey(ev)].filter(Boolean).join('+');
}

/** Human label: "⇧⌘G" on macOS, "Shift+Ctrl+G" elsewhere. */
export function formatShortcut(s) {
  if (!s) return '';
  const parts = s.split(/\+(?!$)/);
  const key = parts.pop();
  const mods = parts.map((p) => p.toLowerCase());
  const names = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', delete: 'Del', backspace: '⌫', escape: 'Esc', enter: '↵', ' ': 'Space', tab: 'Tab' };
  const k = names[key.toLowerCase()] || (key.length === 1 ? key.toUpperCase() : key);
  if (IS_MAC) {
    const sym = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘', cmd: '⌘' };
    const order = ['ctrl', 'alt', 'shift', 'mod', 'cmd'];
    return order.filter((m) => mods.includes(m)).map((m) => sym[m]).join('') + k;
  }
  const label = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', mod: 'Ctrl', cmd: 'Ctrl' };
  return [...new Set(mods.map((m) => label[m]))].concat(k).join('+');
}
