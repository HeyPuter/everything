// Command registry. Menus, shortcuts, toolbar buttons and the command search
// all go through commands, so a feature registers once and appears everywhere.
//
//   commands.register({
//     id: 'edit.undo', label: 'Undo', keys: ['Mod+Z'], scope: 'global',
//     run: (app, ...args) => {}, enabled: (app) => true, checked: (app) => bool,
//   })
//
// Keys use 'Mod' for Cmd on macOS and Ctrl elsewhere, plus Ctrl, Alt, Shift
// and key names as in KeyboardEvent.key ('A', 'F5', 'Space', 'ArrowLeft',
// 'Delete', '+'). `scope` is 'global' or a panel id ('playlist', 'pianoRoll',
// 'rack', 'mixer', 'browser'): scoped shortcuts win while that panel is active.

import { IS_MAC } from '../lib/util.js';

export class Commands {
  constructor(app) {
    this.app = app;
    this.map = new Map();
  }

  register(...defs) {
    for (const d of defs.flat()) this.map.set(d.id, { scope: 'global', keys: [], ...d });
  }

  get(id) {
    return this.map.get(id) || null;
  }

  has(id) {
    return this.map.has(id);
  }

  all() {
    return [...this.map.values()];
  }

  label(id) {
    const c = this.get(id);
    if (!c) return id;
    return typeof c.label === 'function' ? c.label(this.app) : c.label;
  }

  enabled(id) {
    const c = this.get(id);
    if (!c) return false;
    try {
      return c.enabled ? Boolean(c.enabled(this.app)) : true;
    } catch {
      return false;
    }
  }

  checked(id) {
    const c = this.get(id);
    return c?.checked ? Boolean(c.checked(this.app)) : undefined;
  }

  run(id, ...args) {
    const c = this.get(id);
    if (!c || !this.enabled(id)) return undefined;
    try {
      const r = c.run(this.app, ...args);
      if (r && typeof r.catch === 'function') r.catch((err) => this.app.reportError?.(err));
      return r;
    } catch (err) {
      this.app.reportError?.(err);
      return undefined;
    }
  }

  /** First shortcut of a command for display ("Ctrl+S", or "⌘S" on macOS). */
  keysLabel(id) {
    const k = this.get(id)?.keys?.[0];
    return k ? formatKeys(k) : '';
  }

  /** A menu item for a command (see ui/menu.js). */
  menuItem(id, extra = {}) {
    const c = this.get(id);
    if (!c) return null;
    const checked = this.checked(id);
    return {
      type: checked === undefined ? 'cmd' : 'check',
      label: this.label(id),
      keys: this.keysLabel(id),
      checked,
      enabled: this.enabled(id),
      run: () => this.run(id),
      ...extra,
    };
  }

  /** The command bound to a key combo, preferring the active panel's scope. */
  lookup(combo, scope) {
    let fallback = null;
    for (const c of this.map.values()) {
      if (!c.keys?.includes(combo)) continue;
      if (c.scope === scope) return c;
      if (c.scope === 'global' && !fallback) fallback = c;
    }
    return fallback;
  }
}

const KEY_ALIASES = { ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Del: 'Delete', Add: '+', Subtract: '-' };

/** The combo string for a keyboard event, e.g. 'Mod+Shift+S', 'F5', 'Space', 'Alt+F8'. */
export function eventCombo(e) {
  let key = KEY_ALIASES[e.key] || e.key;
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(key)) return '';
  // Letters by their physical key so Alt/Option combos don't produce symbols.
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code) && (e.altKey || e.shiftKey)) key = e.code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  if (e.code?.startsWith('Numpad') && (key === '+' || key === '-')) key = `Num${key}`;
  const parts = [];
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  if (IS_MAC && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && (key.length > 1 || /[A-Z0-9]/.test(key))) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

const MAC_SYMBOLS = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const NAMES = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', 'Num+': 'Num +', 'Num-': 'Num -', Escape: 'Esc', Delete: 'Del' };

export function formatKeys(combo) {
  // The key is the last part; it may itself end in '+' ('+', 'Mod++', 'Num+').
  const m = /^(.*?)\+?([^+]*\+|[^+]+)$/.exec(combo);
  const parts = m && m[1] ? m[1].split('+').filter(Boolean) : [];
  const key = m ? m[2] : combo;
  const label = NAMES[key] || key;
  if (IS_MAC) return parts.map((p) => MAC_SYMBOLS[p] || p).join('') + label;
  return [...parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)), label].join('+');
}

/** Whether keyboard focus is in a text field (shortcuts stay out of its way). */
export function isTyping(target) {
  const t = target;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA') return true;
  if (t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'range', 'color'].includes(t.type);
  return false;
}
