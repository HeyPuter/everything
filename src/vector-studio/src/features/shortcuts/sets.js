/**
 * Keyboard shortcut sets: named collections of user changes to command and
 * tool shortcuts, stored in preferences. "Default" is the built-in set and
 * has no changes. A set stores only what differs from the defaults:
 *
 *   prefs.shortcutSets = { active: 'Default' | name, sets: { [name]: { commands: { id: 'Mod+G' | '' }, tools: { id: 'P' | '' } } } }
 *
 * An empty string removes a shortcut.
 */
import { normalizeShortcut } from '../../commands/registry.js';

export const DEFAULT_SET = 'Default';

export function readSets(prefs) {
  const v = prefs.get('shortcutSets');
  const sets = v && typeof v === 'object' && v.sets && typeof v.sets === 'object' ? v.sets : {};
  const active = v?.active && (v.active === DEFAULT_SET || sets[v.active]) ? v.active : DEFAULT_SET;
  return { active, sets };
}

export function writeSets(prefs, data) {
  prefs.set('shortcutSets', { active: data.active, sets: data.sets });
}

/** The changes of the active set: { commands, tools }. */
export function activeChanges(prefs) {
  const { active, sets } = readSets(prefs);
  const s = active === DEFAULT_SET ? null : sets[active];
  return { commands: { ...(s?.commands || {}) }, tools: { ...(s?.tools || {}) } };
}

/** Remember each tool's built-in shortcut the first time we see it. */
function toolDefault(T) {
  if (!Object.prototype.hasOwnProperty.call(T, 'defaultShortcut')) T.defaultShortcut = T.shortcut;
  return T.defaultShortcut;
}

/** Apply a set of changes to the app's commands and tools. */
export function applyChanges(app, changes) {
  app.commands.setOverrides(changes.commands);
  const toolKeys = new Map();
  for (const [id, T] of app.toolClasses) {
    const def = toolDefault(T);
    T.shortcut = id in changes.tools ? changes.tools[id] : def;
    if (T.shortcut) toolKeys.set(normalizeShortcut(T.shortcut), id);
  }
  app.toolKeys = toolKeys;
  app.toolbar?.refreshTips?.();
}

/** The effective shortcut of a command or tool under a set of changes. */
export function effective(app, kind, id, changes) {
  if (kind === 'tools') {
    const T = app.toolClasses.get(id);
    return id in changes.tools ? changes.tools[id] : toolDefault(T) || '';
  }
  const c = app.commands.get(id);
  return id in changes.commands ? changes.commands[id] : c?.defaultShortcut ? [].concat(c.defaultShortcut)[0] : '';
}

/**
 * Who else uses a shortcut: [{ kind, id }]. Tool keys and command shortcuts
 * share the keyboard, so a single-key command conflicts with a tool key.
 */
export function conflictsFor(app, shortcut, changes, self) {
  if (!shortcut) return [];
  const key = normalizeShortcut(shortcut);
  const out = [];
  for (const id of app.commands.commands.keys()) {
    if (self.kind === 'commands' && self.id === id) continue;
    const c = app.commands.get(id);
    const own = id in changes.commands ? [changes.commands[id]] : [].concat(c.defaultShortcut || [], c.defaultAltShortcuts || []);
    if (own.some((s) => s && normalizeShortcut(s) === key)) out.push({ kind: 'commands', id });
  }
  for (const id of app.toolClasses.keys()) {
    if (self.kind === 'tools' && self.id === id) continue;
    const s = effective(app, 'tools', id, changes);
    if (s && normalizeShortcut(s) === key) out.push({ kind: 'tools', id });
  }
  return out;
}

/**
 * Keys the app handles itself, before tool keys and alongside commands (see
 * App's keydown handler): a tool or command given one of them would never
 * run, or would take away a basic key. Normalized shortcut -> what uses it.
 */
const RESERVED = new Map([
  ['x', 'Toggle Fill and Stroke'],
  ['shift+x', 'Swap Fill and Stroke'],
  ['d', 'Default Fill and Stroke'],
  [',', 'Color'],
  ['shift+,', 'Color'],
  ['.', 'Gradient'],
  ['shift+.', 'Gradient'],
  ['/', 'None'],
  ['tab', 'Hide Panels'],
  ['shift+tab', 'Hide Panels'],
  ['enter', 'Enter'],
  ['escape', 'Escape'],
]);

/** What a built-in key does when `shortcut` is one the app keeps for itself, else null. */
export function reservedKey(shortcut) {
  if (!shortcut) return null;
  const key = normalizeShortcut(shortcut);
  if (RESERVED.has(key)) return RESERVED.get(key);
  const parts = key.split('+');
  const last = parts[parts.length - 1];
  // Space (with any modifier) is the temporary Hand and Zoom tools.
  if (last === ' ') return 'Pan and Zoom (Space)';
  // Arrow keys nudge (with Shift and Alt too).
  if (/^arrow/.test(last) && !parts.includes('mod')) return 'Nudge';
  return null;
}

/** Shortcut text from a keydown event: 'Mod+Alt+Shift+K', or null for a lone modifier. */
export function shortcutFromEvent(ev, isMac) {
  if (['Shift', 'Alt', 'Meta', 'Control', 'CapsLock', 'Fn'].includes(ev.key)) return null;
  const code = ev.code || '';
  let key;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(ev.key)) key = ev.key;
  else {
    const map = { BracketLeft: '[', BracketRight: ']', Backslash: '\\', Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=', Space: 'Space' };
    key = map[code] || ev.key;
  }
  if (!key) return null;
  const parts = [];
  if (isMac ? ev.metaKey : ev.ctrlKey) parts.push('Mod');
  if (isMac && ev.ctrlKey) parts.push('Ctrl');
  if (ev.altKey) parts.push('Alt');
  if (ev.shiftKey) parts.push('Shift');
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}
