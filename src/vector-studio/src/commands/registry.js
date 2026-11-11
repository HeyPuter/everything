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
    /** User shortcut overrides: id -> shortcut string ('' removes the shortcut). */
    this.overrides = new Map();
  }

  register(def) {
    if (Array.isArray(def)) {
      for (const d of def) this.register(d);
      return;
    }
    if (!('defaultShortcut' in def)) {
      def.defaultShortcut = def.shortcut;
      def.defaultAltShortcuts = def.altShortcuts;
    }
    if (this.overrides.has(def.id)) {
      def.shortcut = this.overrides.get(def.id) || undefined;
      def.altShortcuts = undefined;
    }
    this.commands.set(def.id, def);
    this.conditional = null;
    for (const s of [].concat(def.shortcut || [], def.altShortcuts || [])) {
      this.byShortcut.set(normalizeShortcut(s), def.id);
    }
  }

  /**
   * Replace the user's shortcut overrides (id -> shortcut, '' for none) and
   * rebuild the key map. Commands without an override get their defaults.
   */
  setOverrides(overrides) {
    this.overrides = new Map(Object.entries(overrides || {}));
    this.byShortcut = new Map();
    this.conditional = null;
    for (const def of this.commands.values()) {
      if (this.overrides.has(def.id)) {
        def.shortcut = this.overrides.get(def.id) || undefined;
        def.altShortcuts = undefined;
      } else {
        def.shortcut = def.defaultShortcut;
        def.altShortcuts = def.defaultAltShortcuts;
      }
    }
    for (const def of this.commands.values()) {
      for (const s of [].concat(def.shortcut || [], def.altShortcuts || [])) this.byShortcut.set(normalizeShortcut(s), def.id);
    }
  }

  get(id) {
    return this.commands.get(id);
  }

  isEnabled(id, args) {
    const c = this.commands.get(id);
    if (!c) return false;
    try {
      return c.enabled ? Boolean(c.enabled(this.app, args)) : true;
    } catch {
      return false;
    }
  }

  isChecked(id, args) {
    const c = this.commands.get(id);
    return Boolean(c?.checked?.(this.app, args));
  }

  label(id) {
    const c = this.commands.get(id);
    if (!c) return id;
    return typeof c.label === 'function' ? c.label(this.app) : c.label;
  }

  async run(id, args) {
    const c = this.commands.get(id);
    if (!c) {
      console.warn(`Unknown command ${id}`);
      return undefined;
    }
    if (!this.isEnabled(id, args)) return undefined;
    try {
      return await c.run(this.app, args);
    } catch (err) {
      // Validation messages (UserError) are expected: a notification is enough.
      if (!isUserError(err)) console.error(err);
      this.app.notify?.(err?.message || 'Something went wrong.', { error: true });
      return undefined;
    }
  }

  /**
   * Command id for a keyboard event, or null. Where two commands share keys
   * (Shift+Mod+K is both Color Settings and All Caps), one with
   * a `shortcutWhen(app)` that holds right now wins (All Caps with text
   * selected); otherwise the one without a condition does.
   */
  match(ev) {
    const key = eventShortcut(ev);
    const id = this.byShortcut.get(key) || null;
    if (!this.conditional) {
      // Commands with a shortcut condition, by key (rebuilt after register/setOverrides).
      this.conditional = new Map();
      for (const c of this.commands.values()) {
        if (!c.shortcutWhen) continue;
        for (const s of [].concat(c.shortcut || [], c.altShortcuts || [])) {
          const k = normalizeShortcut(s);
          this.conditional.set(k, [...(this.conditional.get(k) || []), c]);
        }
      }
    }
    const shared = this.conditional.get(key);
    if (!shared) return id;
    const now = shared.find((c) => {
      try {
        return c.shortcutWhen(this.app);
      } catch {
        return false;
      }
    });
    if (now) return now.id;
    if (id && !this.commands.get(id)?.shortcutWhen) return id;
    for (const c of this.commands.values()) {
      if (!c.shortcutWhen && [].concat(c.shortcut || [], c.altShortcuts || []).some((s) => normalizeShortcut(s) === key)) return c.id;
    }
    return null;
  }

  shortcutLabel(id) {
    const c = this.commands.get(id);
    return c?.shortcut ? formatShortcut([].concat(c.shortcut)[0]) : '';
  }
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
