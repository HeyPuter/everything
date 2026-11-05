// Command registry. Menus, the action bar, the command palette and keyboard
// shortcuts all invoke commands by id, so each action is defined once.

import { Emitter } from '../core/emitter.js';
import { isMac } from '../ui/dom.js';

/**
 * @typedef {object} Command
 * @property {string} id
 * @property {string} label
 * @property {string} [menuLabel]   label with & accelerator for menus
 * @property {string} [icon]
 * @property {string|string[]} [shortcut]   'Mod+S', 'Shift+S', 'Space', 'PageUp'
 * @property {string} [context]     'sch' | 'pcb' | 'lib' | undefined for global
 * @property {() => any} run
 * @property {() => boolean} [enabled]
 * @property {() => boolean} [checked]
 * @property {() => boolean} [visible]
 * @property {string} [category]    palette grouping
 * @property {boolean} [allowInInput]  shortcut fires while typing in a field
 */

export class CommandRegistry extends Emitter {
  constructor() {
    super();
    this.map = new Map();
    this.context = null;
  }

  register(cmd) {
    const c = { ...cmd };
    const list = c.shortcut ? (Array.isArray(c.shortcut) ? c.shortcut : [c.shortcut]) : [];
    c.shortcuts = list;
    c.shortcut = list[0];
    this.map.set(c.id, c);
    return c;
  }

  registerAll(list) { for (const c of list) this.register(c); }

  get(id) { return this.map.get(id); }

  /** Commands usable in the current context (global ones plus the active editor's). */
  available() {
    return [...this.map.values()].filter((c) => (!c.context || c.context === this.context) && (!c.visible || c.visible()));
  }

  run(id, ...args) {
    const c = this.map.get(id);
    if (!c) { console.warn(`Unknown command ${id}`); return undefined; }
    if (c.context && c.context !== this.context) return undefined;
    if (c.enabled && !c.enabled()) return undefined;
    const r = c.run(...args);
    this.emit('ran', { id, command: c });
    return r;
  }

  /** Finds the command bound to a normalized key combo in the current context. */
  byShortcut(combo) {
    let global = null;
    for (const c of this.map.values()) {
      if (!c.shortcuts.includes(combo)) continue;
      if (c.context && c.context === this.context) return c;
      if (!c.context && !global) global = c;
    }
    return global;
  }
}

const KEY_NAMES = { ' ': 'Space', Esc: 'Escape', Del: 'Delete', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };

/** Normalizes a keyboard event to 'Mod+Shift+Alt+Key'. */
export function comboOf(e) {
  let key = KEY_NAMES[e.key] || e.key;
  // Option on macOS types a symbol ('∑' for Option+W, or a dead key), so
  // Alt combinations go by the physical key instead.
  const physical = /^(Key[A-Z]|Digit[0-9])$/.exec(e.code || '');
  if (e.altKey && physical && !/^[a-z0-9]$/i.test(key)) key = e.code.slice(-1);
  if (key.length === 1) key = key.toUpperCase();
  // Shifted punctuation: keep the produced character ('*', '+', '?') without Shift.
  const punct = key.length === 1 && !/[A-Z0-9]/.test(key);
  if (e.code?.startsWith('Numpad') && /^[0-9]$/.test(key)) key = `Num${key}`;
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (!isMac && e.metaKey) parts.push('Meta');
  if (e.shiftKey && !punct) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' && !['checkbox', 'radio', 'button', 'color', 'range'].includes(el.type) || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
